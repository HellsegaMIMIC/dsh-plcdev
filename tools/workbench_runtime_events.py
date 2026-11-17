"""Bounded project event ledger; observes existing services, never starts tools.

The first adapter set consumes structured status/check receipts. Raw process
stdout and browser consoles are deliberately not advertised as collected.
Times in the public contract are Unix seconds, matching Runtime observations.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from urllib import parse, request

ID = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
DIGEST = re.compile(r'^[0-9a-f]{64}$')
MAX_EVENTS = 300
MAX_FILE = 2 * 1024 * 1024
SOURCES = {'compiler': 'OpenPLC 编译', 'runtime': 'PLC Runtime', 'fuxa': 'FUXA', 'oip': 'OIP 检查', 'plcdev': 'PLCdev'}
_lock = threading.RLock()
_stores = {}


def text(value, limit=1600):
    """Display selected diagnostic text, not arbitrary task/model payloads."""
    value = value if isinstance(value, str) else ''
    value = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', value)
    value = re.sub(r'(?i)\b(authorization|cookie|password|passwd|secret|api[-_]?key|access[-_]?token|token)[\"\x27]?\s*[:=]\s*[^\r\n,;]+', r'\1=[redacted]', value)
    value = re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [redacted]', value)
    value = re.sub(r'\bsk-[A-Za-z0-9_-]{12,}', '[redacted]', value)
    value = re.sub(r'(https?://)[^/@\s:]+:[^/@\s]+@', r'\1[redacted]@', value)
    value = value.replace(str(Path.home()), '[user-home]')
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value)[:limit]


def stamp(value, fallback):
    return float(value) if type(value) in (int, float) and math.isfinite(value) and 0 < value <= fallback + 60 else fallback


def digest(value):
    return value if isinstance(value, str) and DIGEST.fullmatch(value) else None


def identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value) else None


def signature(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def variables(snapshot):
    values = []
    state = snapshot.get('state') if isinstance(snapshot.get('state'), dict) else {}
    rows = state.get('variables') if isinstance(state.get('variables'), list) else []
    for row in rows[:12]:
        if not isinstance(row, dict) or not isinstance(row.get('path'), str): continue
        value = row.get('value')
        values.append({'name': text(row['path'], 160),
                       'value': text(str(value), 120) if isinstance(value, (str, int, float, bool)) else '—',
                       'quality': text(str(row.get('quality') or state.get('dataQuality') or 'unknown'), 80)})
    return values


def existing_task_records(project_id):
    """Read an already-running task service with bounded local-only requests."""
    from agent_task_service import DESCRIPTOR, CONTRACT_VERSION, _validated_base, _NoRedirect
    with Path(DESCRIPTOR).open('rb') as stream:
        encoded = stream.read(16385)
    if len(encoded) > 16384: raise ValueError('任务服务描述无法核对。')
    desc = json.loads(encoded.decode('utf-8-sig'))
    base = _validated_base(desc)
    opener = request.build_opener(request.ProxyHandler({}), _NoRedirect())

    def get(endpoint):
        req = request.Request(base + endpoint, headers={'Authorization': 'Bearer ' + desc['token']})
        with opener.open(req, timeout=1) as response:
            if response.status != 200 or not response.headers.get('Content-Type', '').startswith('application/json'):
                raise ValueError('任务服务响应无法核对。')
            raw = response.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE: raise ValueError('任务记录超过读取上限。')
        return json.loads(raw)

    health = get('/v1/health')
    if health.get('instance') != desc.get('instance') or health.get('contractVersion') != CONTRACT_VERSION:
        raise ValueError('任务服务身份无法核对。')
    result = get('/v1/tasks?projectId=' + parse.quote(project_id, safe=''))
    rows = result.get('tasks')
    if not isinstance(rows, list) or len(rows) > 200 or any(not isinstance(row, dict) or row.get('projectId') != project_id for row in rows):
        raise ValueError('任务记录工程归属无法核对。')
    return rows


class RuntimeEventStore:
    def __init__(self, home, *, clock=time.time, task_reader=existing_task_records):
        self.home = Path(home).resolve()
        self.clock = clock
        self.task_reader = task_reader
        self.lock = threading.RLock()
        self.cache = {}
        self.task_cache = {}

    def _load(self, project_id):
        if project_id in self.cache: return self.cache[project_id]
        path = self.home / (project_id + '.json')
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(self.home): raise ValueError('事件记录位置无法核对。')
            with path.open('rb') as stream: raw = stream.read(MAX_FILE + 1)
            if len(raw) > MAX_FILE: raise ValueError('事件记录超过读取上限。')
            data = json.loads(raw)
            if (not isinstance(data, dict) or data.get('schemaVersion') != 1 or data.get('projectId') != project_id
                    or not isinstance(data.get('events'), list) or len(data['events']) > MAX_EVENTS
                    or not isinstance(data.get('seen'), dict) or len(data['seen']) > 2400
                    or not isinstance(data.get('conditions'), dict)
                    or not isinstance(data.get('transitions', {}), dict)
                    or any(not isinstance(e, dict) or e.get('projectId') != project_id
                           or e.get('source') not in SOURCES or e.get('severity') not in ('error', 'warning', 'info')
                           or e.get('status') not in ('active', 'resolved', 'recorded')
                           or not identifier(e.get('id')) or not all(type(e.get(k)) in (int, float) and math.isfinite(e[k]) and e[k] > 0 for k in ('firstAt', 'lastAt'))
                           or type(e.get('count')) is not int or e['count'] < 1
                           or any(not isinstance(e.get(k), str) for k in ('phase', 'summary', 'detail', 'raw'))
                           for e in data['events'])):
                raise ValueError('事件记录格式无法核对，未覆盖旧记录。')
        except FileNotFoundError:
            data = {'schemaVersion': 1, 'projectId': project_id, 'events': [], 'seen': {}, 'conditions': {}, 'transitions': {}}
        data.setdefault('transitions', {})
        self.cache[project_id] = data
        return data

    def _save(self, data):
        self.home.mkdir(parents=True, exist_ok=True)
        path = self.home / (data['projectId'] + '.json')
        if path.is_symlink() or not path.resolve().is_relative_to(self.home): raise ValueError('事件记录位置无法核对。')
        data['events'] = sorted(data['events'], key=lambda e: (e['lastAt'], e['id']))[-MAX_EVENTS:]
        ids = {e['id'] for e in data['events']}
        data['conditions'] = {k: v for k, v in data['conditions'].items() if v in ids}
        data['seen'] = dict(list(data['seen'].items())[-2400:])
        data['transitions'] = dict(list(data['transitions'].items())[-600:])
        raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
        while len(raw) > MAX_FILE and data['events']:
            oldest = data['events'].pop(0)['id']
            data['conditions'] = {k: v for k, v in data['conditions'].items() if v != oldest}
            raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
        if len(raw) > MAX_FILE: raise ValueError('事件记录超过保存上限。')
        temporary = path.with_suffix('.json.tmp')
        if temporary.is_symlink(): raise ValueError('事件临时记录位置无法核对。')
        with temporary.open('wb') as stream: stream.write(raw)
        os.replace(temporary, path)

    def collect(self, project_id, snapshot, *, tasks=None, task_error=None):
        if not isinstance(project_id, str) or not ID.fullmatch(project_id): raise ValueError('工程查询无效。')
        if not isinstance(snapshot, dict) or snapshot.get('project', {}).get('id') != project_id:
            raise ValueError('运行状态工程归属无法核对。')
        now = self.clock()
        with self.lock:
            data = self._load(project_id)
            before = signature(data)
            if tasks is None and task_error is None:
                cached = self.task_cache.get(project_id)
                if not cached or now - cached[0] >= 10:
                    try: cached = (now, self.task_reader(project_id), None)
                    except Exception: cached = (now, [], '调整记录暂不可读取；未启动或重启任务服务。')
                    self.task_cache[project_id] = cached
                _, tasks, task_error = cached
            tasks = [] if tasks is None else tasks
            if not isinstance(tasks, list) or len(tasks) > 200 or any(not isinstance(row, dict) or row.get('projectId') != project_id for row in tasks):
                raise ValueError('检查记录工程归属无法核对。')
            session = snapshot.get('session') or {}
            sid = identifier(session.get('id'))
            program = digest(session.get('programHash'))
            revision = digest(snapshot.get('projectRevision'))
            context = {'projectRevision': revision, 'programHash': program, 'sessionId': sid}

            def event(source, severity, phase, summary, detail='', raw='', **extra):
                return {'source': source, 'severity': severity, 'phase': phase, 'summary': text(summary, 240),
                        'detail': text(detail), 'raw': text(raw, 2400), **context, 'variables': [], **extra}

            def append(key, item, at=None, *, merge=False):
                at = stamp(at, now)
                marker = signature([key, item, at])
                if marker in data['seen']: return
                data['seen'][marker] = True
                group = signature([key, item.get('sessionId'), item.get('projectRevision')])
                previous = next((e for e in reversed(data['events']) if e.get('_group') == group and merge and e['status'] == item.get('status', 'recorded')), None)
                if previous:
                    previous['count'] += 1; previous['lastAt'] = max(previous['lastAt'], at)
                    return previous
                record = {**item, 'id': 'evt-' + marker[:32], 'projectId': project_id, 'firstAt': at, 'lastAt': at,
                          'count': 1, 'status': item.get('status', 'recorded'), '_group': group}
                data['events'].append(record)
                return record

            def condition(key, active, item=None, *, recovered=False, retired=False, at=None):
                old_id = data['conditions'].get(key)
                previous = next((e for e in data['events'] if e['id'] == old_id), None)
                if active:
                    if previous and previous['status'] == 'active': return
                    record = append(key + ':' + str(now), {**item, 'status': 'active'}, at)
                    if record:
                        record['_condition'] = key
                        data['conditions'][key] = record['id']
                elif recovered and previous and previous['status'] == 'active':
                    previous.update(status='resolved', resolvedAt=now)
                    data['conditions'].pop(key, None)
                elif retired and previous:
                    # A discarded proposal is historical, not a repaired tool.
                    previous['status'] = 'recorded'
                    return previous

            def transition(key, value, item):
                if data['transitions'].get(key) == value: return
                data['transitions'][key] = value
                append(key + ':' + str(now), item, now)

            self._snapshot_events(snapshot, now, event, append, condition, transition, variables(snapshot))
            for task in sorted(tasks, key=lambda t: stamp(t.get('createdAt'), now))[-200:]:
                if any(type(task.get(k)) not in (int, float) or not math.isfinite(task[k]) or not 0 < task[k] <= now + 60 for k in ('createdAt','updatedAt')):
                    continue
                self._task_events(task, now, event, append, condition)
            if signature(data) != before: self._save(data)
            mode = snapshot.get('mode') or snapshot.get('project', {}).get('defaultMode')
            sources = [
                {'id': 'compiler', 'state': 'unavailable' if task_error else 'partial', 'label': SOURCES['compiler'],
                 'reason': task_error or '已接入保留版本编译回执与运行准备消息；未采集完整编译控制台。'},
                {'id': 'runtime', 'state': 'partial', 'label': SOURCES['runtime'], 'reason': '已接入实例、采样有效性和异常状态；未采集完整进程输出。'},
                {'id': 'fuxa', 'state': 'partial' if mode in ('fuxa-local', 'fuxa-oip') else 'unavailable', 'label': SOURCES['fuxa'],
                 'reason': '已接入启动与现有 HMI 通信状态；未采集所有设备驱动或浏览器日志。' if mode in ('fuxa-local', 'fuxa-oip') else '当前工程未提供 FUXA 状态。'},
                {'id': 'oip', 'state': 'unavailable' if task_error else 'partial', 'label': SOURCES['oip'],
                 'reason': task_error or '仅原生检查回执和启动错误；OIP 仿真运行日志未接入。'},
                {'id': 'plcdev', 'state': 'partial', 'label': SOURCES['plcdev'], 'reason': '已接入本工程操作消息、依赖及任务异常。'}]
            return {'ok': True, 'schemaVersion': 1, 'projectId': project_id, 'observedAt': now,
                    'currentSessionId': sid, 'projectRevision': revision,
                    'events': [{k: v for k, v in e.items() if not k.startswith('_')} for e in data['events']], 'sources': sources}

    @staticmethod
    def _snapshot_events(s, now, event, append, condition, transition, samples):
        session, state, links = s.get('session') or {}, s.get('state') or {}, s.get('links') or {}
        sid = identifier(session.get('id'))
        fresh = s.get('observerFresh') is True and type(state.get('observedAt')) in (int, float) and 0 <= now - state['observedAt'] < 2
        prefix = 'runtime:' + (sid or 'unprepared')
        active = session.get('active') is True
        condition(prefix + ':lost', active and not fresh,
                  event('runtime', 'error', '通信', '无法确认 PLC 实例与变量状态', '观察数据失效；最后采样不能作为当前运行状态。', variables=samples, origin='runtime/state'),
                  recovered=active and fresh)
        fault = s.get('phase') == 'fault' or bool(s.get('error'))
        condition(prefix + ':fault', fault,
                  event('runtime', 'error', '运行', '运行准备或实例发生异常', s.get('error') or s.get('message') or '请核对所属运行实例。', s.get('error') or '', variables=samples, origin='runtime/status'),
                  recovered=s.get('phase') == 'ready' and fresh and not fault)
        if active and fresh:
            current = state.get('runtimeState')
            if current in ('RUNNING', 'STOPPED'):
                # Observation timestamps change every sample; use lifecycle
                # state transitions, not a new event for each variable poll.
                transition(prefix + ':state', current, event('runtime', 'info', '运行', 'PLC 正在运行' if current == 'RUNNING' else 'PLC 已停止', origin='runtime/state'))
        deps = s.get('dependencies') if isinstance(s.get('dependencies'), list) else []
        missing = [text(d.get('label') or d.get('id'), 120) for d in deps if isinstance(d, dict) and d.get('id') in ('runtime', 'msys') and d.get('available') is False]
        condition('environment:missing', bool(missing), event('plcdev', 'warning', '检查', 'PLC 运行依赖未齐备', '缺少：' + '、'.join(missing), sessionId=None, programHash=None, origin='environment'),
                  recovered=all(any(isinstance(d, dict) and d.get('id') == key and d.get('available') is True for d in deps) for key in ('runtime', 'msys')))
        mode = s.get('mode') or s.get('project', {}).get('defaultMode')
        if mode in ('fuxa-local', 'fuxa-oip'):
            channel = links.get('variables') or {}
            connected = channel.get('state') == 'connected' and channel.get('channelConnected') is True
            disconnected = active and fresh and s.get('hmiOpen') is True and channel.get('state') == 'disconnected'
            condition('fuxa:' + (sid or 'unprepared') + ':communication', disconnected,
                      event('fuxa', 'warning', '通信', 'FUXA 画面通信中断', '画面数据可能过期；PLC 执行状态独立核对。', channel.get('label') or '', variables=samples, origin='fuxa/communication'),
                      recovered=active and fresh and connected)
            condition('fuxa:' + (sid or 'unprepared') + ':data',
                      active and fresh and connected and state.get('runtimeState') == 'RUNNING' and channel.get('dataFresh') is False,
                      event('fuxa', 'warning', '变量', 'FUXA 变量数据未更新', '通道在线，但当前值尚未确认更新。', variables=samples, origin='fuxa/data'),
                      recovered=active and fresh and connected and channel.get('dataFresh') is True)
        errors = s.get('toolErrors') if isinstance(s.get('toolErrors'), dict) else {}
        components = s.get('components') or {}
        for tool, key in [('fuxa', 'hmi'), ('oip', 'factory')]:
            error = errors.get(tool)
            component = components.get(key) or {}
            condition(tool + ':launch', bool(error), event(tool, 'error', '启动', SOURCES[tool].replace(' 检查', '') + ' 启动失败', error or '', error or '',
                      sessionId=None, programHash=None, origin=tool + '/launch'),
                      recovered=not error and component.get('state') == 'process-alive' and component.get('projectOpenVerified') is True)
        for row in s.get('events', [])[-60:]:
            if not isinstance(row, dict) or row.get('projectId', s['project']['id']) != s['project']['id'] or not isinstance(row.get('message'), str): continue
            at = stamp(row.get('at'), now)
            # Legacy messages have no owner identity. Keep them project-level,
            # never attach them to whichever Runtime happens to be current.
            source = 'compiler' if row.get('phase') == 'building' else 'plcdev'
            item = event(source, 'info', '编译' if source == 'compiler' else '操作', row['message'],
                         sessionId=identifier(row.get('sessionId')), programHash=digest(row.get('programHash')), projectRevision=None,
                         origin='controller/events')
            if type(row.get('at')) in (int, float) and math.isfinite(row['at']) and 0 < row['at'] <= now + 60:
                append('controller:' + row['message'], item, at, merge=True)

    @staticmethod
    def _task_events(task, now, event, append, condition):
        task_id = identifier(task.get('taskId'))
        if not task_id: return
        changed = stamp(task.get('updatedAt'), now)
        revision = digest(task.get('projectRevision'))
        common = {'sessionId': None, 'programHash': None, 'projectRevision': revision, 'taskId': task_id}
        compile_result = task.get('compilation')
        if isinstance(compile_result, dict) and compile_result.get('status') in ('compiled', 'compile_failed'):
            success = compile_result['status'] == 'compiled'
            rev = digest(compile_result.get('sourceRevision')) or revision
            key = 'compile:' + task_id + ':' + (rev or 'unknown')
            item = event('compiler', 'info' if success else 'error', '编译', 'PLC 编译通过' if success else 'PLC 编译未通过',
                         '仅编译完成，未改变运行实例。' if success else compile_result.get('diagnostic') or '请查看编译诊断。',
                         compile_result.get('diagnostic') or '', **{**common, 'projectRevision': rev}, origin='task/compilation')
            if success:
                condition(key, False, recovered=True)
                append(key + ':passed', item, changed)
            else: condition(key, True, item, at=changed)
        candidate = task.get('candidate') if isinstance(task.get('candidate'), dict) else {}
        # These native checks inspect the candidate, not its unedited baseline.
        check_context = {**common, 'projectRevision': digest(candidate.get('candidateDigest'))}
        components = candidate.get('components') if isinstance(candidate.get('components'), list) else []
        for component in components[:8]:
            if not isinstance(component, dict): continue
            source = {'plc': 'compiler', 'openplc': 'compiler', 'hmi': 'fuxa', 'fuxa': 'fuxa', 'oip': 'oip'}.get(component.get('tool'), 'plcdev')
            checks = component.get('checks') if isinstance(component.get('checks'), list) else []
            for index, check in enumerate(checks[:30]):
                if not isinstance(check, dict) or check.get('status') not in ('failed', 'warning', 'passed'): continue
                severity = {'failed': 'error', 'warning': 'warning', 'passed': 'info'}[check['status']]
                key = 'check:' + task_id + ':' + source + ':' + text(check.get('id') or str(index), 120)
                label = text(check.get('label') or '工具检查', 120)
                detail = check.get('summary') or check.get('diagnostic') or ''
                item = event(source, severity, '候选检查', label + ('通过' if severity == 'info' else '未通过' if severity == 'error' else '有提醒'),
                             detail, detail, **check_context, origin='task/native-check')
                if severity == 'info':
                    condition(key, False, recovered=True)
                    append(key + ':passed', item, stamp(task.get('createdAt'), now))
                elif task.get('status') in ('discarded', 'superseded') or task.get('supersededBy'):
                    previous = condition(key, False, retired=True)
                    if previous is None: append(key + ':historic', item, stamp(task.get('createdAt'), now))
                else: condition(key, True, item, at=changed)
        failed = task.get('status') in ('failed', 'unknown_outcome', 'blocked', 'conflict')
        condition('task:' + task_id, failed, event('plcdev', 'error', '任务', '工程任务需要核对', task.get('reason') or '请查看调整记录中的任务结果。', **common, origin='task/status'),
                  recovered=task.get('status') in ('kept', 'compiled'), retired=task.get('status') in ('discarded', 'superseded'), at=changed)


def runtime_events(manager, project_id, *, home=None):
    """Controller read endpoint. Project IDs resolve through its own catalog."""
    if not isinstance(project_id, str) or not ID.fullmatch(project_id): raise ValueError('工程查询无效。')
    manager.resolve(project_id)
    if home is None:
        from plcdev_workbench import HOME
        home = HOME / 'runtime-events'
    key = str(Path(home).resolve())
    with _lock:
        store = _stores.setdefault(key, RuntimeEventStore(home))
    return store.collect(project_id, manager.snapshot(project_id))
