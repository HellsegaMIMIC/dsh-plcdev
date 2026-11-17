"""Project-owned OpenPLC launches and readable candidate evidence.

No model credentials or Runtime operations. The DSH host grants a narrow
conversation capability; only the native main process receives its descriptor.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import uuid
from urllib.parse import urlsplit

from workbench_agent_adapters import _snapshot
from workbench_start_stop import source_files
from workbench_project_config import plain, relative, read_json
from workbench_projects import read_user_project, SOURCE_ENTRIES
from workbench_hmi_preview import hmi_preview, MAX_FILE as MAX_HMI_FILE

ID = re.compile(r'user-[0-9a-f]{32}\Z')
TASK = re.compile(r'task-[0-9a-f]{32}\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
LAUNCH = re.compile(r'editor-[0-9a-f]{32}\Z')


def checked_identity(body):
    if (not isinstance(body, dict) or not ID.fullmatch(str(body.get('projectId', '')))
            or not TASK.fullmatch(str(body.get('taskId', '')))
            or not DIGEST.fullmatch(str(body.get('candidateDigest', '')))):
        raise ValueError('修改结果的工程、任务或摘要无效。')


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write(path, value):
    plain(path, path.parent)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def candidate_preview(source, candidate):
    """Read hash-confirmed sources/canvases, never dump device/credential JSON."""
    root = Path(candidate['candidateManifest']).parent
    before_root = Path(source['projectRoot'])
    files = []
    budget = 2 * 1024 * 1024
    hmi_budget = 4 * 1024 * 1024
    response_budget = 3 * 1024 * 1024
    truncated = False
    changes = candidate.get('changes', [])
    if not isinstance(changes, list) or len(changes) > 10000:
        raise ValueError('候选文件差异无效。')
    for change in changes[:128]:
        name = change['path']
        after_path, before_path = relative(root, name), relative(before_root, name)
        row = {'path': name, 'kind': 'metadata', 'beforeText': None, 'afterText': None,
               'beforeSha256': change.get('beforeSha256'), 'afterSha256': change.get('afterSha256')}
        is_hmi = after_path.suffix.lower() == '.fuxap'
        if not is_hmi and (after_path.suffix.lower() not in ('.st', '.ld') or '/pous/' not in '/' + name):
            row['unavailableReason'] = '此类资源请通过原生预览查看；不展开设备或连接配置。'
            files.append(row)
            continue
        row['kind'] = 'hmi' if is_hmi else after_path.suffix[1:].lower()
        if is_hmi:
            row.update(beforeHmi=None, afterHmi=None)
        for side, path in (('before', before_path), ('after', after_path)):
            expected = change.get(side + 'Sha256')
            if expected is None:
                if not is_hmi:
                    row[side + 'Text'] = ''
                continue
            if is_hmi:
                if not path.is_file():
                    if side == 'after':
                        raise ValueError('候选文件已变化，未显示过期差异。')
                    row['beforeUnavailable'] = True
                    continue
                size = path.stat().st_size
                if size > MAX_HMI_FILE or size > hmi_budget:
                    row[side + 'Unavailable'] = True
                    row['truncated'] = truncated = True
                    row['unavailableReason'] = 'HMI 文件超出静态预览范围，请在 FUXA 查看。'
                    continue
                with path.open('rb') as stream:
                    content = stream.read(MAX_HMI_FILE + 1)
                if len(content) > MAX_HMI_FILE or hashlib.sha256(content).hexdigest() != expected:
                    if side == 'after':
                        raise ValueError('候选文件已变化，未显示过期差异。')
                    row['beforeUnavailable'] = True
                    continue
                hmi_budget -= len(content)
                try:
                    row[side + 'Hmi'] = hmi_preview(content.decode('utf-8-sig'))
                except (ValueError, UnicodeError, RecursionError):
                    row[side + 'Unavailable'] = True
                    row['unavailableReason'] = '该 HMI 文件无法静态预览，请在 FUXA 查看。'
                # Check again after parsing so a changed file cannot masquerade
                # as the currently prepared candidate during this read.
                try:
                    with path.open('rb') as stream:
                        current = stream.read(MAX_HMI_FILE + 1)
                    matches = len(current) <= MAX_HMI_FILE and hashlib.sha256(current).hexdigest() == expected
                except OSError:
                    matches = False
                if not matches:
                    if side == 'after':
                        raise ValueError('读取期间文件发生变化，请刷新。')
                    row[side + 'Hmi'] = None
                    row['beforeUnavailable'] = True
                continue
            if not path.is_file() or _sha(path) != expected:
                if side == 'after':
                    raise ValueError('候选文件已变化，未显示过期差异。')
                row['beforeUnavailable'] = True
                continue
            size = path.stat().st_size
            if size > 512 * 1024 or size > budget:
                row['truncated'] = truncated = True
                continue
            content = path.read_text(encoding='utf-8-sig')
            if _sha(path) != expected:
                raise ValueError('读取期间文件发生变化，请刷新。')
            budget -= size
            row[side + 'Text'] = content
            if row['kind'] == 'ld':
                try:
                    start = content.index('{')
                    graph, _ = json.JSONDecoder().raw_decode(content[start:])
                    if isinstance(graph, dict) and isinstance(graph.get('rungs'), list):
                        row[side] = graph
                        row[side + 'Declarations'] = content[:start].strip()
                except (ValueError, TypeError):
                    row[side + 'ParseError'] = True
        # LD carries both readable source and its graph. Count the encoded
        # response, too, so quoting/duplicate representations cannot overflow
        # the host bridge's 4 MiB response limit.
        encoded_size = len(json.dumps(row, ensure_ascii=False).encode('utf-8'))
        if encoded_size > response_budget:
            for field in ('beforeText', 'afterText', 'before', 'after',
                          'beforeDeclarations', 'afterDeclarations', 'beforeHmi', 'afterHmi'):
                row.pop(field, None)
            row['truncated'] = truncated = True
            row['beforeText'] = row['afterText'] = None
            if is_hmi:
                row.update(beforeHmi=None, afterHmi=None, beforeUnavailable=True, afterUnavailable=True,
                           unavailableReason='画面超出静态预览范围，请在 FUXA 查看。')
            encoded_size = len(json.dumps(row, ensure_ascii=False).encode('utf-8'))
        response_budget -= encoded_size
        files.append(row)
    return {'ok': True, 'projectId': candidate['projectId'], 'taskId': candidate['taskId'],
            'candidateDigest': candidate['candidateDigest'], 'files': files,
            'truncated': truncated or len(changes) > 128}


class EditorLinks:
    def __init__(self, home, resolve_project, task_call, executable, *, launch=None, environ=None, resource_opener=None,
                 preview_resolver=None, preview_task_call=None):
        self.home = Path(home).absolute()
        self.resolve_project = resolve_project
        self.task_call = task_call
        self.executable = Path(executable)
        self.launch = launch or subprocess.Popen
        self.environ = environ or os.environ.copy
        self.lock = threading.RLock()
        self.resource_opener = resource_opener
        self.resource_observer = None
        self.preview_service = None
        self.preview_resolver = preview_resolver
        self.preview_task_call = preview_task_call
        self.preview_actions_lock = threading.Lock()
        self.preview_actions = {}

    def _preview_context(self, launch_id):
        record = read_json(self._folder(launch_id) / 'resource.json')
        if record.get('launchId') != launch_id or record.get('preview') is not True:
            raise ValueError('不是已登记的独立预览。')
        checked_identity(record)
        task = (self.preview_task_call or self.task_call)('/v1/tasks/' + record['taskId']).get('task', {})
        if (task.get('projectId') != record['projectId'] or task.get('taskId') != record['taskId']
                or task.get('candidate', {}).get('candidateDigest') != record['candidateDigest']):
            raise ValueError('预览的任务身份已变化。')
        project = (self.preview_resolver or self.resolve_project)(record['projectId'])
        if (project.get('id') != record['projectId'] or
                Path(project['manifestPath']).resolve() != Path(record['sourceManifest']).resolve()):
            raise ValueError('工程登记位置已改变。')
        project = read_user_project(project['manifestPath'])
        if project['id'] != record['projectId']: raise ValueError('工程身份已改变。')
        return record, task, project

    def preview_status(self, launch_id):
        # Atomic launch records plus fresh task/registry checks are enough for
        # this read. Never queue a status poll behind native opening or manager
        # reconfiguration (both can wait for a user's window confirmation).
        record, task, project = self._preview_context(launch_id)
        statuses = {'awaiting_review': ('pending', '待保留预览'),
                    'kept': ('kept', '已保留 · 历史预览'),
                    'compiled': ('kept', '已保留 · 历史预览'),
                    'compile_failed': ('kept', '已保留 · 历史预览'),
                    'discarded': ('discarded', '已撤销 · 历史预览'),
                    'superseded': ('superseded', '已被后续修改替代 · 历史预览')}
        state, label = statuses.get(task.get('status'), ('unknown', '预览状态无法核对'))
        resource = 'hmi' if record['tool'] == 'fuxa' else 'scene'
        revision = _snapshot(project)['projectRevision']
        return {'active': True, 'state': state, 'label': label,
                'currentRevision': revision,
                'canOpenCurrent': state != 'unknown' and bool(project.get(resource))}

    def open_preview_current(self, launch_id, revision):
        # Open the registered project's *current* saved resource. Do not reuse
        # or retarget the preview manager, its profile, files or native window.
        self._folder(launch_id)
        with self.preview_actions_lock:
            action_lock = self.preview_actions.setdefault(launch_id, threading.Lock())
        if not action_lock.acquire(blocking=False):
            raise ValueError('此预览正在打开当前工程，请等待窗口确认；未重复打开。')
        try:
            status = self.preview_status(launch_id)
            if not status['canOpenCurrent'] or status['currentRevision'] != revision:
                raise ValueError('当前工程版本已变化，请刷新状态后重试。')
            record, task, project = self._preview_context(launch_id)
            before = _snapshot(project)
            if before['projectRevision'] != revision: raise ValueError('工程版本已变化。')
            opened = self.resource_opener(project, record['tool'], False)
            if _snapshot(read_user_project(project['manifestPath'])) != before:
                raise ValueError('打开期间工程已变化，请核对当前窗口。')
            sync = opened.get('toolSync', {}).get('oip', {}) if isinstance(opened, dict) else {}
            pending = sync.get('state') not in (None, 'synced')
            status = self.preview_status(launch_id)
            # FUXA's saved project and listener are verified, but launching a
            # browser does not acknowledge that its tab has finished loading.
            browser_open = record['tool'] == 'fuxa'
            return {**status, 'opened': not pending and not browser_open,
                    'message': ('请在 OIP 确认打开工程' if sync.get('state') == 'pending_confirmation' else
                        '当前工程尚未确认打开 · 请回 DSH 核对') if pending else
                        ('正在打开当前工程 · 此预览窗口保留' if browser_open else '已打开当前工程 · 此预览窗口保留')}
        finally:
            action_lock.release()

    def open_resource(self, body):
        """Open this exact result, never fall back to the source HMI/scene.

        Candidate tools get a disposable private identity so their editable
        profiles cannot overwrite either the sealed candidate or saved project.
        Retained results use the real project's current published resources.
        """
        checked_identity(body)
        if (set(body) != {'projectId', 'taskId', 'candidateDigest', 'target', 'tool'}
                or body['tool'] not in ('fuxa', 'oip') or body['target'] not in ('candidate', 'retained')):
            raise ValueError('结果工具打开请求无效。')
        if self.resource_opener is None:
            raise ValueError('结果工具打开服务尚未就绪。')
        with self.lock:
            prepared = self.prepare({k: body[k] for k in ('projectId', 'taskId', 'candidateDigest', 'target')})
            folder = self._folder(prepared['launchId'])
            record = read_json(folder / 'launch.json')
            manifest = Path(record['manifestPath'])
            project = read_user_project(manifest)
            if _snapshot(project)['projectRevision'] != prepared['revision']:
                raise ValueError('打开前修改内容已变化。')
            resource = 'hmi' if body['tool'] == 'fuxa' else 'scene'
            if not project.get(resource):
                raise ValueError('这份结果不包含对应的工具工程。')
            preview = prepared['mode'] == 'preview'
            if preview:
                raw = read_json(manifest)
                raw['id'] = 'user-' + prepared['launchId'].removeprefix('editor-')
                raw['name'] += ' · 待保留预览'
                _write(manifest, raw)
                project = read_user_project(manifest)
            opening_snapshot = _snapshot(project)
            resource_record = {**body, 'launchId': prepared['launchId'], 'manifestPath': str(manifest),
                               'preview': preview, 'observationRevision': opening_snapshot['projectRevision'],
                               'sourceManifest': self.resolve_project(body['projectId'])['manifestPath']}
            _write(folder / 'resource.json', resource_record)
            if preview:
                from workbench_preview_status import PreviewStatusService
                if self.preview_service is None:
                    self.preview_service = PreviewStatusService(self.preview_status, self.open_preview_current)
                self.preview_service.register(prepared['launchId'])
                # Only the opaque launch identity enters public manager state.
                # The native-process capability stays in the service registry.
                project['_nativePreview'] = prepared['launchId']
            opened = self.resource_opener(project, body['tool'], preview)
            if _snapshot(read_user_project(manifest)) != opening_snapshot:
                raise ValueError('工具窗口已打开，但工程内容在打开期间发生变化，请重新核对后打开。')
            sync = opened.get('toolSync', {}) if isinstance(opened, dict) else {}
            oip = sync.get('oip', {}) if isinstance(sync, dict) else {}
            pending = body['tool']=='oip' and isinstance(oip, dict) and oip.get('state') not in (None, 'synced')
            return {'ok': True, **body, 'targetProjectId': prepared['projectId'],
                    'launchId': prepared['launchId'], 'observationRevision': opening_snapshot['projectRevision'],
                    'revision': prepared['revision'], 'mode': prepared['mode'],
                    **({'toolSync': sync} if sync else {}),
                    'state': oip.get('state') if pending else 'opened',
                    'message': oip.get('message', '等待 OIP 确认载入场景。') if pending else
                        ('已打开待保留预览；在此窗口的手工编辑不会写回候选。' if preview else '已打开本工程已保留的修改。')}

    def resource_status(self, body):
        """Observe only this exact opened resource; never create a preview or launch."""
        checked_identity(body)
        if (set(body) != {'projectId','taskId','candidateDigest','target','tool','launchId'}
                or body['tool'] != 'oip' or body['target'] not in ('candidate','retained')):
            raise ValueError('工具状态查询无效。')
        record = read_json(self._folder(body['launchId']) / 'resource.json')
        if any(record.get(key) != value for key,value in body.items()):
            raise ValueError('工具状态回执不属于本次打开。')
        task = (self.preview_task_call or self.task_call)('/v1/tasks/' + body['taskId']).get('task', {})
        if task.get('projectId') != body['projectId'] or task.get('candidate',{}).get('candidateDigest') != body['candidateDigest']:
            raise ValueError('工具状态所属候选已变化。')
        project = read_user_project(record['manifestPath'])
        if _snapshot(project)['projectRevision'] != record['observationRevision']:
            raise ValueError('该次打开的工程版本已变化。')
        observed = self.resource_observer(project,body['tool'],record['preview']) if self.resource_observer else {}
        return {'ok': True, **body, 'observationRevision': record['observationRevision'],
                'toolSync': observed.get('toolSync', {'oip': {'state':'unknown','message':'打开回执尚未核对。'}})}

    def _folder(self, launch_id):
        if not LAUNCH.fullmatch(str(launch_id)):
            raise ValueError('编辑器打开请求无效。')
        folder = self.home / launch_id
        plain(folder, self.home)
        return folder

    @staticmethod
    def _public(record):
        return {key: record[key] for key in ('ok', 'launchId', 'sourceProjectId', 'projectId',
                    'taskId', 'candidateDigest', 'nativeProjectPath', 'revision', 'mode',
                    'projectName', 'state') if key in record}

    def prepare(self, body):
        direct = isinstance(body, dict) and body.get('target') == 'project'
        if direct:
            if set(body) != {'projectId', 'target'} or not ID.fullmatch(str(body.get('projectId', ''))):
                raise ValueError('工程打开请求无效。')
        else:
            checked_identity(body)
        if not direct and (set(body) != {'projectId', 'taskId', 'candidateDigest', 'target'} or body['target'] not in ('candidate', 'retained')):
            raise ValueError('编辑器目标无效。')
        source = self.resolve_project(body['projectId'])
        if not direct:
            response = self.task_call('/v1/tasks/' + body['taskId'])
            task = response.get('task', {})
            if (task.get('projectId') != source['id'] or task.get('taskId') != body['taskId']
                    or task.get('candidate', {}).get('candidateDigest') != body['candidateDigest']):
                raise ValueError('修改结果不属于当前工程。')
        launch_id = 'editor-' + uuid.uuid4().hex
        folder = self._folder(launch_id)
        self.home.mkdir(parents=True, exist_ok=True)
        plain(self.home, self.home)
        folder.mkdir()
        if direct:
            target, mode = source, 'project'
            snapshot = _snapshot(target)
        elif body['target'] == 'retained':
            retained = task.get('retention') or {}
            if task.get('status') not in ('kept', 'compiled', 'compile_failed') or not ID.fullmatch(str(retained.get('keptProjectId', ''))):
                raise ValueError('修改副本尚未确认保存，未打开其他工程。')
            target = self.resolve_project(retained['keptProjectId'])
            if Path(target['manifestPath']).resolve() != Path(retained.get('manifestPath', '')).resolve():
                raise ValueError('修改副本登记位置已变化。')
            mode = 'project'
            snapshot = _snapshot(target)
            if snapshot['projectRevision'] != retained.get('revision'):
                raise ValueError('修改副本在保留后已变化，请从该副本工程继续，未使用旧结果打开。')
        else:
            result = self.task_call('/v1/tasks/' + body['taskId'] + '/candidate',
                                    {key: body[key] for key in ('projectId', 'candidateDigest')})
            if any(result.get(key) != body[key] for key in ('projectId', 'taskId', 'candidateDigest')):
                raise ValueError('原生候选身份未确认。')
            candidate_root = Path(result['plcPath']).parent
            # Service returns the manifest alongside its checked native path.
            manifest = Path(result['candidateManifest'])
            candidate = read_user_project(manifest)
            snapshot = _snapshot(candidate)
            if snapshot['projectRevision'] != body['candidateDigest'] or candidate['id'] != source['id']:
                raise ValueError('候选版本已变化。')
            preview = folder / 'preview'
            preview.mkdir()
            candidate_root = Path(candidate['projectRoot'])
            for name, digest in snapshot['files'].items():
                original, copied = relative(candidate_root, name), relative(preview, name)
                if _sha(original) != digest:
                    raise ValueError('候选预览准备期间文件已变化。')
                copied.parent.mkdir(parents=True, exist_ok=True)
                copied.write_bytes(original.read_bytes())
                if _sha(copied) != digest:
                    raise ValueError('预览文件摘要不匹配。')
            target = read_user_project(preview / 'project.plcdev')
            if _snapshot(target) != snapshot:
                raise ValueError('预览工程不完整。')
            mode = 'preview'
        native = Path(target['plc']).resolve()
        native_relative = native.parent.relative_to(Path(target['projectRoot']).resolve()).as_posix()
        prefix = '' if native_relative == '.' else native_relative + '/'
        native_files = {name[len(prefix):]: digest for name, digest in snapshot['files'].items()
                        if name.startswith(prefix) and name[len(prefix):].split('/')[0] in SOURCE_ENTRIES}
        if {p.relative_to(native.parent).as_posix(): _sha(p) for p in source_files(native.parent)} != native_files:
            raise ValueError('准备期间 PLC 文件已变化。')
        record = {'ok': True, 'launchId': launch_id, 'sourceProjectId': source['id'],
                  'projectId': target['id'],
                  **({key: body[key] for key in ('taskId', 'candidateDigest')} if not direct else {}),
                  'nativeProjectPath': str(native),
                  'manifestPath': target['manifestPath'], 'revision': snapshot['projectRevision'],
                  'nativeFiles': native_files,
                  'mode': mode, 'projectName': target['name'], 'state': 'prepared',
                  'preparedAt': time.time()}
        _write(folder / 'launch.json', record)
        return self._public(record)

    def verify_prepared(self, body):
        """Confirm the exact staged PLC source, even if another tool advanced head.

        This is not a launch or a user-supplied path reader. The opaque prepared
        launch fixes the target and its complete compiler-input hash set.
        """
        if not isinstance(body, dict) or set(body) != {'launchId', 'projectId', 'revision', 'nativeProjectPath'}:
            raise ValueError('同步回执字段无效。')
        record = read_json(self._folder(body['launchId']) / 'launch.json')
        if (any(record.get(k) != body[k] for k in body) or record.get('mode') != 'project'
                or not record.get('nativeFiles')):
            raise ValueError('同步目标已变化或过期，请重新核对。')
        # Resolve the registered identity again without updating tool managers;
        # this read must remain available while another native tool is opening.
        project = (self.preview_resolver or self.resolve_project)(body['projectId'])
        if project['id'] != body['projectId'] or Path(project['manifestPath']).resolve() != Path(record['manifestPath']).resolve():
            raise ValueError('工程登记位置已变化。')
        root = Path(record['nativeProjectPath']).parent
        plain(root, Path(record['manifestPath']).parent)
        actual = {}
        for p in source_files(root):
            plain(p, root)
            actual[p.relative_to(root).as_posix()] = _sha(p)
        if actual != record['nativeFiles']:
            raise ValueError('同步期间 PLC 文件已变化，未确认加载。')
        return self._public(record)

    def open(self, body):
        if not isinstance(body, dict) or set(body) != {'launchId', 'connection'}:
            raise ValueError('编辑器连接请求无效。')
        with self.lock:
            folder = self._folder(body['launchId'])
            record = read_json(folder / 'launch.json')
            connection = body['connection']
            if not isinstance(connection, dict) or len(json.dumps(connection)) > 8192:
                raise ValueError('编辑器连接格式无效。')
            required = {'schemaVersion', 'baseUrl', 'token', 'projectId', 'sessionId', 'revision', 'nativeProjectPath', 'launchId'}
            if not required.issubset(connection) or set(connection) - required - {'mode', 'canSend', 'projectName', 'expiresAt'}:
                raise ValueError('编辑器连接字段无效。')
            url = urlsplit(str(connection.get('baseUrl', '')))
            if (connection['schemaVersion'] != 1 or url.scheme != 'http' or url.hostname != '127.0.0.1'
                    or not url.port or url.path != '/api/plcdev/editor-bridge' or url.query or url.fragment or url.username
                    or not re.fullmatch(r'[A-Za-z0-9_-]{32,512}', str(connection['token']))
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}', str(connection['sessionId']))
                    or ('canSend' in connection and type(connection['canSend']) is not bool)):
                raise ValueError('编辑器只接受受控本机会话连接。')
            if any(connection.get(k) != record[k] for k in ('launchId', 'projectId', 'revision', 'nativeProjectPath')):
                raise ValueError('编辑器连接与目标工程不匹配。')
            if connection.get('mode', record['mode']) != record['mode'] or (record['mode'] == 'preview' and connection.get('canSend') is not False):
                raise ValueError('候选预览不能获得修改会话权限。')
            fingerprint = hashlib.sha256(json.dumps(connection, sort_keys=True).encode()).hexdigest()
            if record['state'] != 'prepared':
                if record.get('connectionDigest') != fingerprint:
                    raise ValueError('同一打开请求的连接已变化，未重复启动。')
                return self._public(record)
            if time.time() - record['preparedAt'] > 180:
                raise ValueError('打开准备已过期，请重新点击打开。')
            project = read_user_project(record['manifestPath'])
            if project['id'] != record['projectId'] or _snapshot(project)['projectRevision'] != record['revision']:
                raise ValueError('打开前工程版本已变化，请重新核对。')
            if not self.executable.is_file():
                raise ValueError('未找到 OpenPLC 编辑器。')
            descriptor = folder / 'connection.json'
            _write(descriptor, connection)
            profile = self.home.parent / 'editor-profiles' / 'dsh' / (record['launchId'] if record['mode'] == 'preview' else record['projectId'])
            profile.mkdir(parents=True, exist_ok=True)
            plain(profile, self.home.parent)
            env = dict(self.environ())
            env.update(OPENPLC_ZH_USER_DATA=str(profile), OPENPLC_ZH_TRIAL='1')
            record.update(state='requested', connectionDigest=fingerprint)
            # Persist before spawn: a timeout or crash cannot cause an implicit second open.
            _write(folder / 'launch.json', record)
            try:
                with (folder / 'editor.log').open('ab') as log:
                    process = self.launch([str(self.executable), '--user-data-dir=' + str(profile),
                                           '--plcdev-project', str(Path(record['nativeProjectPath']).parent),
                                           '--plcdev-dsh-connection', str(descriptor)],
                                          cwd=self.executable.parent, env=env, stdout=log, stderr=subprocess.STDOUT,
                                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), shell=False)
                record['pid'] = process.pid
            except OSError:
                record['state'] = 'failed'
            _write(folder / 'launch.json', record)
            return self._public(record)
