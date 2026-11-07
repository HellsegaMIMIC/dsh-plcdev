"""P2 analysis workflow in TaskService's existing ledger; never an executor.

Only the authenticated DSH host supplies actor identities. The host derives them
from exact live native Team membership, never from model tool arguments.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import time
import threading
import uuid

from workbench_agent_adapters import _manifest_project, _snapshot, _files
from workbench_project_config import plain
from workbench_projects import ProjectCatalog

ROLES = ('plc', 'hmi')
WORKFLOW = 'team-analysis-v1'


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode('utf-8')).hexdigest()


def project_contexts(project_id, revision):
    """Capture bounded professional projections between two identical source hashes."""
    project = _manifest_project(ProjectCatalog().projects.get(project_id))
    before = _snapshot(project)
    if before['projectRevision'] != revision:
        raise ValueError('工程保存版本已变化。')
    root, paths = _files(project)
    bindings = json.loads(Path(project['bindingsPath']).read_text(encoding='utf-8'))
    shared = {'projectId': project_id, 'projectRevision': revision, 'bindings': bindings,
              'basis': 'saved_revision; bounded source projection, no unsaved editor buffers'}
    plc_root = Path(project['plc']).parent
    programs = []
    for path in paths:
        if not path.is_relative_to(plc_root) or path.suffix not in ('.st', '.ld'):
            continue
        text = path.read_text(encoding='utf-8')
        item = {'file': path.relative_to(root).as_posix(), 'sha256': before['files'][path.relative_to(root).as_posix()]}
        if path.suffix == '.st':
            item['source'] = text
        else:
            declarations, sep, tail = text.partition('\n{')
            item['declarations'] = declarations
            if sep:
                ld, end = json.JSONDecoder().raw_decode('{' + tail)
                if ('{' + tail)[end:].strip() != 'END_PROGRAM':
                    raise ValueError('不支持的 LD 尾部。')
                item['rungs'] = [{'comment': r.get('comment'), 'nodes': [
                    {'type': n.get('type'), 'data': {k: n.get('data', {}).get(k) for k in ('variable', 'variant', 'executionOrder', 'connectedVariables')}} for n in r.get('nodes', [])
                    if n.get('type') != 'powerRail']} for r in ld.get('rungs', [])]
        programs.append(item)
    hmi = json.loads(Path(project['hmi']).read_text(encoding='utf-8'))
    # Omit SVG geometry, endpoint configuration and executable script bodies.
    views = [{'name': view.get('name'), 'items': [
        {k: item.get(k) for k in ('id', 'type', 'name', 'property')}
        for item in view.get('items', {}).values()]} for view in hmi.get('hmi', {}).get('views', [])]
    contexts = {'plc': {**shared, 'interface': 'openplc-analysis-v1', 'programs': programs},
                'hmi': {**shared, 'interface': 'fuxa-analysis-v1', 'views': views,
                        'omitted': ['SVG layout', 'script bodies', 'server/device endpoint configuration']}}
    if any(len(encoded(value)) > 24000 for value in contexts.values()):
        raise ValueError('专业资源摘要超过限制，未截断后冒充完整上下文。')
    if _snapshot(project) != before:
        raise ValueError('读取期间源版本变化；未登记混合版本。')
    return contexts


class TeamWorkflow:
    def __init__(self, store, home, *, context_reader=project_contexts, error_type=None):
        from agent_task_service import _connect, AgentServiceError
        self.store, self.home, self.read_contexts = store, Path(home), context_reader
        self.artifact_lock = threading.RLock()
        # The serving module may be __main__ (the actual bootstrap path).
        # Raise exactly the error class caught by that HTTP handler, not a
        # second class created by importing agent_task_service again.
        self.connect, self.Error = lambda: _connect(store.path), error_type or AgentServiceError
        with closing(self.connect()) as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS team_runs (
                    root_session TEXT PRIMARY KEY, root_created INTEGER NOT NULL,
                    task_id TEXT UNIQUE NOT NULL REFERENCES tasks(task_id), fingerprint TEXT NOT NULL,
                    binding_version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS team_slots (
                    task_id TEXT NOT NULL REFERENCES tasks(task_id), role TEXT NOT NULL,
                    name TEXT NOT NULL, instruction TEXT NOT NULL, context TEXT NOT NULL,
                    native_task TEXT, session_id TEXT UNIQUE, session_created INTEGER,
                    read_digest TEXT, report TEXT, report_digest TEXT, notice TEXT,
                    PRIMARY KEY(task_id,role)
                );
                CREATE TABLE IF NOT EXISTS team_effects (
                    task_id TEXT NOT NULL REFERENCES tasks(task_id), effect_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, result TEXT,
                    PRIMARY KEY(task_id,effect_id)
                );
            ''')

    def fail(self, message):
        raise self.Error('conflict', message)

    def fields(self, value, keys):
        if not isinstance(value, dict) or set(value) != set(keys):
            self.fail('团队请求字段无效。')

    def actor(self, value):
        self.fields(value, ('sessionId', 'createdAt', 'rootSessionId', 'rootCreatedAt', 'role', 'name', 'teamId'))
        for key in ('sessionId', 'rootSessionId', 'teamId'):
            if not isinstance(value[key], str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value[key]):
                self.fail('原生会话身份无效。')
        if any(type(value[key]) is not int or value[key] < 1 for key in ('createdAt', 'rootCreatedAt')):
            self.fail('原生会话创建标识无效。')
        if value['teamId'] != value['rootSessionId'] or value['role'] not in ('lead', *ROLES, 'oip'):
            self.fail('原生团队身份或角色无效。')
        if (value['role'] == 'lead') != (value['sessionId'] == value['rootSessionId']):
            self.fail('父子会话角色不匹配。')
        if value['role'] == 'lead' and value['createdAt'] != value['rootCreatedAt']:
            self.fail('父会话创建标识不匹配。')
        return value

    def access(self, db, actor, *, member=True):
        run = db.execute('SELECT * FROM team_runs WHERE root_session=?', (actor['rootSessionId'],)).fetchone()
        if not run or run['root_created'] != actor['rootCreatedAt']:
            self.fail('原团队任务不存在或会话已替换。')
        slot = None
        if actor['role'] != 'lead':
            slot = db.execute('SELECT * FROM team_slots WHERE task_id=? AND role=?', (run['task_id'], actor['role'])).fetchone()
            if not slot or slot['name'] != actor['name']:
                self.fail('成员不属于批准的专业分工。')
            if member and (slot['session_id'] != actor['sessionId'] or slot['session_created'] != actor['createdAt']):
                self.fail('实际子会话与工程角色登记不一致。')
        return run, slot

    def public(self, db, run):
        rows = db.execute('SELECT * FROM team_slots WHERE task_id=? ORDER BY role', (run['task_id'],)).fetchall()
        value = {'rootSessionId': run['root_session'], 'rootCreatedAt': run['root_created'],
                 'teamId': run['root_session'], 'bindingVersion': run['binding_version'],
                 'members': [{'role': r['role'], 'name': r['name'], 'instruction': r['instruction'],
                              'sessionId': r['session_id'], 'createdAt': r['session_created'],
                              'nativeTaskId': r['native_task'], 'contextDigest': r['read_digest'],
                              'reportDigest': r['report_digest'], 'notice': r['notice'],
                              'report': json.loads(r['report']) if r['report'] else None,
                              'artifact': 'team-analysis/' + run['task_id'] + '/' + r['role'] + '.json' if r['report'] else None}
                             for r in rows],
                 'validation': {'compilation': 'not_tested', 'runtime': 'not_tested', 'sourceModified': False}}
        return value

    def refresh(self, db, run):
        value = self.public(db, run)
        previous = db.execute('SELECT payload FROM task_results WHERE task_id=?', (run['task_id'],)).fetchone()
        result = json.loads(previous['payload']) if previous else {}
        result['teamAnalysis'] = value
        db.execute('INSERT INTO task_results VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload',
                   (run['task_id'], encoded(result)))

    def create(self, actor, body, *, workflow=WORKFLOW, roles=ROLES, context_reader=None):
        if actor['role'] != 'lead': self.fail('只有真实 Lead 可建立工程分工。')
        self.fields(body, ('projectId', 'expectedRevision', 'request', 'clientRequestId', 'bindingVersion', 'assignments'))
        probe = {k: body[k] for k in ('projectId', 'expectedRevision', 'request', 'clientRequestId')}
        probe.update(executionScope='generate_only', sourceBasis='saved_revision')
        self.store._fields(probe)
        self.fields(body['assignments'], roles)
        if type(body['bindingVersion']) is not int or body['bindingVersion'] < 1:
            self.fail('工程绑定版本无效。')
        for value in body['assignments'].values():
            if not isinstance(value, str) or not 1 <= len(value.strip()) <= 1500:
                self.fail('专业分工内容无效。')
        fingerprint = digest(body if workflow == WORKFLOW else {'workflow': workflow, **body})
        with closing(self.connect()) as db:
            old = db.execute('SELECT * FROM team_runs WHERE root_session=?', (actor['rootSessionId'],)).fetchone()
            if old:
                if old['root_created'] != actor['rootCreatedAt'] or old['fingerprint'] != fingerprint:
                    self.fail('此原生团队已固定到原工程任务；改绑后请另建团队，不能改写或重投旧任务。')
                return self.snapshot(actor, {})
        contexts = (context_reader or self.read_contexts)(body['projectId'], body['expectedRevision'])
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM team_runs WHERE root_session=?', (actor['rootSessionId'],)).fetchone()
            if old:
                if old['root_created'] != actor['rootCreatedAt'] or old['fingerprint'] != fingerprint:
                    self.fail('并发任务与原团队固定输入冲突。')
                db.commit()
                return self.snapshot(actor, {})
            task_id, now = 'task-' + uuid.uuid4().hex, time.time()
            db.execute('INSERT INTO tasks (task_id,project_id,client_request_id,request,revision,execution_scope,workflow_version,status,reason,created,updated,source_basis,workflow) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (task_id, body['projectId'], body['clientRequestId'], body['request'], body['expectedRevision'],
                        'generate_only', 'm2-joint-candidate-v1', 'team_waiting', '等待原生专业成员；未生成候选、编译或运行。', now, now, 'saved_revision', workflow))
            db.execute('INSERT INTO team_runs VALUES (?,?,?,?,?)', (actor['rootSessionId'], actor['rootCreatedAt'], task_id, fingerprint, body['bindingVersion']))
            for role in roles:
                db.execute('INSERT INTO team_slots (task_id,role,name,instruction,context) VALUES (?,?,?,?,?)',
                           (task_id, role, role + '-' + task_id[-10:], body['assignments'][role], encoded(contexts[role])))
            run, _ = self.access(db, actor)
            self.refresh(db, run)
            self.store._event(db, task_id, 'team_created', {'rootSessionId': actor['rootSessionId'], 'roles': list(roles)})
            db.commit()
        return self.snapshot(actor, {})

    def materialize(self, task):
        with self.artifact_lock:
            self._materialize(task)

    def _materialize(self, task):
        for member in task['teamAnalysis']['members']:
            if not member['report']: continue
            folder = self.home / ('team-generation' if task.get('workflow') == 'team-generation-v1' else 'team-analysis') / task['taskId']
            folder.mkdir(parents=True, exist_ok=True)
            plain(folder, self.home)
            path = folder / (member['role'] + '.json')
            plain(path, self.home)
            payload = encoded({'projectId': task['projectId'], 'projectRevision': task['projectRevision'],
                               'taskId': task['taskId'], **member}) + '\n'
            # The receipt in SQLite is authoritative. Missing artifacts can be
            # reconstructed after a crash; never overwrite a differing artifact.
            immutable = json.loads(payload)
            immutable.pop('notice', None)
            payload = encoded(immutable) + '\n'
            if path.exists():
                if path.read_text(encoding='utf-8') != payload:
                    self.fail('专业产物文件与持久回执不符，未覆盖。')
            else:
                temp = folder / (member['role'] + '.tmp')
                plain(temp, self.home)
                with temp.open('w', encoding='utf-8', newline='\n') as stream: stream.write(payload)
                temp.replace(path)

    def snapshot(self, actor, body):
        self.fields(body, ())
        with closing(self.connect()) as db:
            run = db.execute('SELECT * FROM team_runs WHERE root_session=?', (actor['rootSessionId'],)).fetchone()
            if not run and actor['role'] == 'lead': return {'ok': True, 'task': None}
            run, _ = self.access(db, actor)
            task_id = run['task_id']
        task = self.store.get(task_id)
        self.materialize(task)
        return {'ok': True, 'task': task}

    def handle(self, operation, body):
        self.fields(body, ('actor', 'input'))
        actor, args = self.actor(body['actor']), body['input']
        if operation == 'create': return self.create(actor, args)
        if operation == 'snapshot': return self.snapshot(actor, args)
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            run, slot = self.access(db, actor, member=operation != 'member')
            task = self.store._task(db.execute('SELECT * FROM tasks WHERE task_id=?', (run['task_id'],)).fetchone())
            if operation == 'native-task':
                self.fields(args, ('role', 'nativeTaskId'))
                if actor['role'] != 'lead' or args['role'] not in (*ROLES, 'oip') or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args['nativeTaskId']):
                    self.fail('原生任务登记无效。')
                row = db.execute('SELECT native_task FROM team_slots WHERE task_id=? AND role=?', (run['task_id'], args['role'])).fetchone()
                if not row: self.fail('当前任务没有该专业角色。')
                if row['native_task'] not in (None, args['nativeTaskId']): self.fail('原生任务编号已固定。')
                db.execute('UPDATE team_slots SET native_task=? WHERE task_id=? AND role=?', (args['nativeTaskId'], run['task_id'], args['role']))
            elif operation == 'member':
                self.fields(args, ())
                if not slot or not slot['native_task']: self.fail('专业成员尚未分配原生任务。')
                if slot['session_id'] is not None and (slot['session_id'] != actor['sessionId'] or slot['session_created'] != actor['createdAt']):
                    self.fail('角色已绑定另一个子会话。')
                db.execute('UPDATE team_slots SET session_id=?,session_created=? WHERE task_id=? AND role=?',
                           (actor['sessionId'], actor['createdAt'], run['task_id'], actor['role']))
            elif operation == 'context':
                self.fields(args, ('taskId', 'projectId', 'projectRevision'))
                if not slot or any(args[k] != task[k] for k in args): self.fail('专业读取请求跨角色、工程或源版本。')
                value = json.loads(slot['context'])
                context_digest = digest(value)
                db.execute('UPDATE team_slots SET read_digest=? WHERE task_id=? AND role=?', (context_digest, run['task_id'], actor['role']))
                self.store._event(db, run['task_id'], 'professional_read', {'role': actor['role'], 'sessionId': actor['sessionId'], 'interface': value['interface'], 'contextDigest': context_digest})
                db.commit()
                return {'ok': True, 'contextDigest': context_digest, 'context': value}
            elif operation == 'report':
                self.fields(args, ('taskId', 'projectId', 'projectRevision', 'contextDigest', 'report'))
                if not slot or any(args[k] != task[k] for k in ('taskId', 'projectId', 'projectRevision')) or not slot['read_digest'] or args['contextDigest'] != slot['read_digest']:
                    self.fail('报告缺少当前专业读取证据，或工程／版本不符。')
                report = args['report']
                self.fields(report, ('summary', 'findings', 'unverified'))
                if not isinstance(report['summary'], str) or not 1 <= len(report['summary']) <= 2000:
                    self.fail('专业结论无效。')
                for key in ('findings', 'unverified'):
                    if not isinstance(report[key], list) or not 1 <= len(report[key]) <= 12 or any(not isinstance(v, str) or not 1 <= len(v) <= 1000 for v in report[key]):
                        self.fail('报告须包含有界发现及未验证项。')
                report_digest = digest(report)
                if slot['report_digest'] and slot['report_digest'] != report_digest: self.fail('此角色报告已受理，不能用另一份结果覆盖。')
                if not slot['report_digest']:
                    db.execute('UPDATE team_slots SET report=?,report_digest=? WHERE task_id=? AND role=?', (encoded(report), report_digest, run['task_id'], actor['role']))
                    self.store._event(db, run['task_id'], 'professional_report', {'role': actor['role'], 'sessionId': actor['sessionId'], 'reportDigest': report_digest})
                count = db.execute('SELECT COUNT(*) FROM team_slots WHERE task_id=? AND report IS NOT NULL', (run['task_id'],)).fetchone()[0]
                db.execute('UPDATE tasks SET status=?,reason=?,updated=? WHERE task_id=?',
                           ('analysis_ready' if count == 2 else 'team_waiting', '专业分析已收回；候选生成、编译和运行未测。' if count == 2 else '已收回一名成员分析，等待另一成员。', time.time(), run['task_id']))
            elif operation in ('effect-start', 'effect-finish'):
                self.fields(args, ('effectId', 'payload') if operation == 'effect-start' else ('effectId', 'payload', 'result'))
                if not isinstance(args['effectId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args['effectId']): self.fail('效果请求身份无效。')
                fingerprint = digest({'actor': actor, 'payload': args['payload']})
                old = db.execute('SELECT * FROM team_effects WHERE task_id=? AND effect_id=?', (run['task_id'], args['effectId'])).fetchone()
                if old and old['fingerprint'] != fingerprint: self.fail('原效果请求输入已变化。')
                if operation == 'effect-start':
                    if not old: db.execute('INSERT INTO team_effects VALUES (?,?,?,NULL)', (run['task_id'], args['effectId'], fingerprint))
                    db.commit()
                    return {'ok': True, 'send': old is None, 'state': 'confirmed' if old and old['result'] else 'unknown', 'result': json.loads(old['result']) if old and old['result'] else None}
                if not old: self.fail('缺少已登记的效果意图。')
                if old['result'] and old['result'] != encoded(args['result']): self.fail('不能改写已有回执。')
                db.execute('UPDATE team_effects SET result=? WHERE task_id=? AND effect_id=?', (encoded(args['result']), run['task_id'], args['effectId']))
                if slot and args['effectId'] == 'report-notice-' + actor['role']:
                    db.execute('UPDATE team_slots SET notice=? WHERE task_id=? AND role=?', ('accepted', run['task_id'], actor['role']))
            else:
                self.fail('未知团队工程操作。')
            self.refresh(db, run)
            db.commit()
        return self.snapshot(actor, {})
