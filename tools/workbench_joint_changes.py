"""Persist joint candidates as new projects, discard, and compile exact copies.

No operation writes the source engineering project or starts a Runtime. Retained
projects have a new identity. Their versioned baseline/candidate resource folders
allow a guarded undo to publish one manifest rather than partially overwrite
several native formats. Receipts describe effects, not live runtime state.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

from factoryio_runtime import ROOT
from plcdev_runtime_owner import FileLease
from workbench_agent_adapters import _digest, _file_hash, _files, _manifest_project, _snapshot
from workbench_project_config import plain, read_json
from workbench_projects import read_user_project
from workbench_start_stop import EDITOR, FALLBACK_EDITOR, env, source_files, source_hashes


class JointChangeError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise JointChangeError('invalid_request', '操作编号无效。')
    return value


def _revision(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
        raise JointChangeError('invalid_request', '需要明确的工程或候选摘要。')
    return value


def _bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def _atomic(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(_bytes(value)); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def _native_compile(project_dir, directory):
    """The editor's actual compile-only pipeline. Never calls prepare/run/upload."""
    editor = EDITOR if EDITOR.exists() else FALLBACK_EDITOR
    if not editor.exists():
        raise JointChangeError('not_ready', 'OpenPLC 编译入口未准备。')
    command = [str(editor), '--cli', 'compile', str(project_dir), '--target',
               'OpenPLC Runtime v4', '--user-data', str(directory / 'compiler-profile'), '--json']
    environment = {k: v for k, v in env().items()
                   if not any(word in k.upper() for word in ('API_KEY', 'PASSWORD', 'SECRET', 'TOKEN'))}
    invocation = {'command': command, 'cwd': str(ROOT), 'startedAt': time.time(),
                  'scope': 'compile-only', 'uploaded': False, 'runtimeStarted': False}
    _atomic(directory / 'compile-invocation.json', invocation)
    started = time.monotonic()
    output_path, log_path = directory / 'compile-result.json', directory / 'compile.log'

    def record(returncode, failure_kind, valid_receipt, exception=None):
        details = {'finishedAt': time.time(), 'elapsedSeconds': time.monotonic() - started,
                   'returncode': returncode,
                   'exitCodeHex': None if returncode is None else f'0x{returncode & 0xffffffff:08X}',
                   'stdoutBytes': output_path.stat().st_size if output_path.exists() else 0,
                   'stderrBytes': log_path.stat().st_size if log_path.exists() else 0,
                   'validCliReceipt': valid_receipt, 'failureKind': failure_kind}
        if exception is not None:
            details['exceptionType'] = type(exception).__name__
        _atomic(directory / 'compile-invocation.json', {**invocation, **details})
        return details

    try:
        with output_path.open('wb') as output, log_path.open('wb') as log:
            result = subprocess.run(command, cwd=ROOT, env=environment, stdout=output, stderr=log,
                                    timeout=240, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        record(None, 'host_launch_error' if isinstance(exc, OSError) else 'host_timeout', False, exc)
        raise  # Preserve the caller's existing failure receipt; never relaunch or elevate here.
    try:
        payload = read_json(output_path)
    except (ValueError, OSError):
        payload = {}
    valid_receipt = type(payload.get('ok')) is bool
    if valid_receipt:
        failure_kind = None if result.returncode == 0 and payload['ok'] else 'cli_reported_failure'
    else:
        # A native Windows exception without a CLI receipt is not a PLC source
        # diagnostic. It also does not prove which native startup check failed.
        native_exception = os.name == 'nt' and (result.returncode & 0xffffffff) >= 0x80000000
        failure_kind = 'native_host_failure' if native_exception else 'invalid_cli_receipt'
        code = f'0x{result.returncode & 0xffffffff:08X}'
        detail = ('OpenPLC 宿主进程异常退出（' + code + '），CLI 未返回有效回执；未确认进入 PLC 编译阶段。'
                  if native_exception else 'OpenPLC CLI 未返回有效回执；未确认编译结果，进程返回码：' + str(result.returncode) + '。')
        payload = {'ok': False, 'error': detail}
    diagnostics = record(result.returncode, failure_kind, valid_receipt)
    return {'returncode': result.returncode, 'payload': payload, 'diagnostics': diagnostics}


class JointChanges:
    def __init__(self, home, observer=None, compiler=None):
        self.home = Path(home).absolute()
        self.observer = observer
        self.compiler = compiler or _native_compile

    def _path(self, *parts):
        path = self.home.joinpath(*parts)
        plain(path, self.home)
        return path

    @contextmanager
    def _lease(self, project_id, effect_id):
        if not re.fullmatch(r'user-[0-9a-f]{32}', project_id or ''):
            raise JointChangeError('invalid_request', '工程身份无效。')
        self.home.mkdir(parents=True, exist_ok=True); plain(self.home, self.home)
        folder = self._path('locks'); folder.mkdir(exist_ok=True)
        # Project serialization is independent of Runtime ownership. The effect
        # lease also protects the shared receipt namespace across projects.
        leases = [FileLease(self._path('locks', project_id + '.lock')),
                  FileLease(self._path('locks', 'effect-' + _id(effect_id) + '.lock'))]
        acquired = []
        try:
            try:
                for lease in leases:
                    lease.__enter__(); acquired.append(lease)
            except RuntimeError:
                raise JointChangeError('conflict', '本工程或操作编号已有保留、撤销或编译操作。') from None
            yield
        finally:
            for lease in reversed(acquired):
                lease.__exit__(None, None, None)

    def _receipt_path(self, effect_id):
        folder = self._path('effects'); folder.mkdir(exist_ok=True)
        return self._path('effects', _id(effect_id) + '.json')

    def _request(self, source, candidate, kind, effect_id, **extra):
        if not isinstance(candidate, dict) or candidate.get('projectId') != source['id']:
            raise JointChangeError('conflict', '候选不属于当前源工程。')
        return {'kind': kind, 'effectId': _id(effect_id), 'projectId': source['id'],
                'taskId': _id(candidate.get('taskId')), 'candidateDigest': _revision(candidate.get('candidateDigest')),
                **extra}

    def _existing(self, request):
        path = self._receipt_path(request['effectId'])
        if not path.exists():
            return None
        record = read_json(path)
        if record.get('request') != request:
            raise JointChangeError('conflict', '操作编号已用于不同输入，未重复执行。')
        if record.get('state') == 'confirmed':
            return {**record['result'], 'replayed': True}
        # The only published mutation is a complete, atomically replaced manifest.
        plan = record.get('plannedResult')
        if plan and record.get('kind') in ('keep', 'undo'):
            try:
                actual = _snapshot(read_user_project(plan['manifestPath']))
                if actual['projectId'] == plan['keptProjectId'] and actual['projectRevision'] == plan['revision']:
                    self._confirm(request, plan, record)
                    return {**plan, 'replayed': True, 'reconciled': True}
            except (OSError, ValueError):
                pass
        if plan and record.get('kind') == 'discard':
            lifecycle = self._lifecycle_path(request)
            if lifecycle.exists() and read_json(lifecycle) == {'status': 'discarded', 'effectId': request['effectId']}:
                self._confirm(request, plan, record)
                return {**plan, 'replayed': True, 'reconciled': True}
        raise JointChangeError('unknown_outcome', '上次操作结果未确认；保留现场，未重复复制或编译。')

    def _prepare(self, request, **details):
        record = {'schemaVersion': 1, 'kind': request['kind'], 'state': 'prepared',
                  'request': request, 'createdAt': time.time(), **details}
        _atomic(self._receipt_path(request['effectId']), record)
        return record

    def _confirm(self, request, result, record=None):
        record = record or read_json(self._receipt_path(request['effectId']))
        _atomic(self._receipt_path(request['effectId']), {**record, 'state': 'confirmed',
                'confirmedAt': time.time(), 'result': result})
        return result

    def _candidate(self, source, candidate, digest):
        _revision(digest)
        if candidate['candidateDigest'] != digest:
            raise JointChangeError('conflict', '审阅候选摘要已改变。')
        manifest = Path(candidate.get('candidateManifest', '')).absolute()
        result = read_user_project(manifest)
        if result['id'] != source['id'] or _snapshot(result)['projectRevision'] != digest:
            raise JointChangeError('conflict', '原生候选文件已改变，请重新生成并审阅。')
        return result

    def _lifecycle_path(self, request):
        folder = self._path('candidates'); folder.mkdir(exist_ok=True)
        return self._path('candidates', _digest({k: request[k] for k in ('projectId', 'taskId', 'candidateDigest')}) + '.json')

    def _require_available(self, request):
        path = self._lifecycle_path(request)
        if path.exists():
            record = read_json(path)
            raise JointChangeError('conflict', '此候选已处理：' + record.get('status', 'unknown') + '。')
        # A crash between writing the effect and its lifecycle summary must not
        # let a different effect ID retain the same candidate a second time.
        for effect in self._path('effects').glob('*.json'):
            plain(effect, self.home)
            record = read_json(effect); previous = record.get('request', {})
            if previous.get('kind') in ('keep', 'discard') and all(previous.get(k) == request[k]
                    for k in ('projectId', 'taskId', 'candidateDigest')):
                raise JointChangeError('conflict', '此候选已有保留或撤销记录；请核对原操作。')

    @staticmethod
    def _view_manifest(project, project_id, name, prefix):
        raw = read_json(project['manifestPath'])
        if raw.get('schemaVersion') != 2:
            raise JointChangeError('not_ready', '此批联合保留仅支持已关联 FUXA／OIP 的批次工程。')
        raw.update(id=project_id, name=name)
        for section, field in (('application', 'path'), ('hmi', 'project'), ('simulation', 'project'), ('bindings', 'path')):
            raw[section][field] = prefix + '/' + raw[section][field].replace('\\', '/')
        return raw

    @staticmethod
    def _planned_snapshot(project, manifest, prefix):
        root = Path(project['projectRoot'])
        previous = _snapshot(project)
        original_manifest = Path(project['manifestPath']).relative_to(root).as_posix()
        files = {prefix + '/' + relative: digest for relative, digest in previous['files'].items() if relative != original_manifest}
        files['project.plcdev'] = hashlib.sha256(_bytes(manifest)).hexdigest()
        return {'projectId': manifest['id'], 'files': files,
                'projectRevision': _digest({'projectId': manifest['id'], 'files': files})}

    @staticmethod
    def _copy(project, destination, expected):
        root, paths = _files(project)
        destination.mkdir(parents=True, exist_ok=False)
        for source in paths:
            relative = source.relative_to(root); target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if _file_hash(target) != expected['files'][relative.as_posix()]:
                raise JointChangeError('conflict', '复制时源文件变化，未发布新工程。')
        if _snapshot(project) != expected:
            raise JointChangeError('conflict', '复制时工程版本变化，未发布新工程。')

    def keep(self, source_project, candidate, *, effect_id, expected_revision, candidate_digest):
        source = _manifest_project(source_project)
        request = self._request(source, candidate, 'keep', effect_id,
                                expectedRevision=_revision(expected_revision))
        if candidate_digest != request['candidateDigest']:
            raise JointChangeError('conflict', '候选摘要不一致。')
        with self._lease(source['id'], effect_id):
            old = self._existing(request)
            if old:
                return old
            self._require_available(request)
            if candidate.get('baselineRevision') != expected_revision:
                raise JointChangeError('conflict', '审阅基线与请求不一致。')
            source_snapshot = _snapshot(source)
            if source_snapshot['projectRevision'] != expected_revision:
                raise JointChangeError('conflict', '源工程已改变，未保留旧候选。')
            proposed = self._candidate(source, candidate, candidate_digest)
            candidate_snapshot = _snapshot(proposed)
            parent = self._path('retained'); parent.mkdir(exist_ok=True)
            target = self._path('retained', effect_id)
            for other in (Path(source['projectRoot']).resolve(), Path(proposed['projectRoot']).resolve()):
                if target.resolve().is_relative_to(other) or other.is_relative_to(target.resolve()):
                    raise JointChangeError('invalid_request', '新工程目录不得覆盖源工程或候选目录。')
            if target.exists():
                raise JointChangeError('conflict', '新工程目录已存在，未覆盖。')
            new_id = 'user-' + uuid.uuid4().hex
            name = source['name'][:65] + ' · AI副本'
            retained_manifest = self._view_manifest(proposed, new_id, name, 'versions/kept')
            baseline_manifest = self._view_manifest(source, new_id, name, 'versions/baseline')
            retained = self._planned_snapshot(proposed, retained_manifest, 'versions/kept')
            baseline = self._planned_snapshot(source, baseline_manifest, 'versions/baseline')
            result = {**request, 'status': 'kept', 'keptProjectId': new_id,
                      'manifestPath': str(target / 'project.plcdev'), 'revision': retained['projectRevision'],
                      'files': retained['files'], 'completionScope': 'retained-new-project',
                      'authoritativeSourceModified': False}
            record = self._prepare(request, plannedResult=result, baselineManifest=baseline_manifest,
                                   baselineSnapshot=baseline)
            target.mkdir(); self._copy(source, target / 'versions/baseline', source_snapshot)
            self._copy(proposed, target / 'versions/kept', candidate_snapshot)
            if _snapshot(source) != source_snapshot or _snapshot(proposed) != candidate_snapshot:
                raise JointChangeError('conflict', '发布前工程或候选发生变化，未发布。')
            _atomic(target / 'project.plcdev', retained_manifest)
            if _snapshot(read_user_project(target / 'project.plcdev')) != retained:
                raise JointChangeError('unknown_outcome', '保留后摘要核对失败，请保留现场。')
            _atomic(self._lifecycle_path(request), {'status': 'kept', 'effectId': effect_id})
            return self._confirm(request, result, record)

    def discard(self, source_project, candidate, *, effect_id, candidate_digest):
        source = _manifest_project(source_project)
        request = self._request(source, candidate, 'discard', effect_id)
        if candidate_digest != request['candidateDigest']:
            raise JointChangeError('conflict', '候选摘要不一致。')
        with self._lease(source['id'], effect_id):
            old = self._existing(request)
            if old:
                return old
            self._require_available(request)
            result = {**request, 'status': 'discarded', 'completionScope': 'candidate-withdrawn',
                      'authoritativeSourceModified': False, 'evidenceRetained': True}
            record = self._prepare(request, plannedResult=result)
            _atomic(self._lifecycle_path(request), {'status': 'discarded', 'effectId': effect_id})
            return self._confirm(request, result, record)

    def _kept(self, source, candidate, keep_effect_id):
        receipt = read_json(self._receipt_path(keep_effect_id))
        if receipt.get('state') != 'confirmed' or receipt.get('kind') != 'keep':
            raise JointChangeError('not_ready', '尚无确认保留的新工程。')
        result = receipt['result']
        if any(result.get(k) != candidate.get(k) for k in ('taskId', 'candidateDigest')) or result['projectId'] != source['id']:
            raise JointChangeError('conflict', '保留记录不属于该工程候选。')
        target = self._path('retained', _id(keep_effect_id), 'project.plcdev')
        if Path(result['manifestPath']).resolve() != target.resolve():
            raise JointChangeError('conflict', '保留工程路径已改变。')
        project = read_user_project(target)
        if project['id'] != result['keptProjectId']:
            raise JointChangeError('conflict', '保留工程身份已改变。')
        return receipt, project

    def undo_kept(self, source_project, candidate, *, effect_id, keep_effect_id, expected_revision):
        source = _manifest_project(source_project)
        request = self._request(source, candidate, 'undo', effect_id,
                                keepEffectId=_id(keep_effect_id), expectedRevision=_revision(expected_revision))
        with self._lease(source['id'], effect_id):
            old = self._existing(request)
            if old:
                return old
            kept, project = self._kept(source, candidate, keep_effect_id)
            state = self.observer(project) if self.observer else {}
            if not isinstance(state, dict) or any(state.get(k) is not True for k in ('verified', 'editorsClosed', 'runtimeInactive')):
                raise JointChangeError('not_ready', '无法确认副本编辑器已关闭且无运行实例，未恢复。')
            before = _snapshot(project)
            if before['projectRevision'] != expected_revision or expected_revision != kept['result']['revision']:
                raise JointChangeError('conflict', '保留后工程已修改，未覆盖新内容。')
            baseline = kept['baselineSnapshot']; manifest = kept['baselineManifest']
            root = Path(project['projectRoot'])
            for relative, digest in baseline['files'].items():
                if relative == 'project.plcdev':
                    continue
                path = root / relative; plain(path, root)
                if not path.is_file() or _file_hash(path) != digest:
                    raise JointChangeError('conflict', '基线备份已改变，未恢复。')
            result = {**request, 'status': 'restored', 'keptProjectId': project['id'],
                      'manifestPath': project['manifestPath'], 'revision': baseline['projectRevision'],
                      'files': baseline['files'], 'completionScope': 'retained-copy-restored',
                      'authoritativeSourceModified': False}
            record = self._prepare(request, plannedResult=result)
            _atomic(Path(project['manifestPath']), manifest)
            if _snapshot(read_user_project(project['manifestPath'])) != baseline:
                raise JointChangeError('unknown_outcome', '恢复后摘要未确认，请保留现场。')
            return self._confirm(request, result, record)

    def compile_kept(self, source_project, candidate, *, effect_id, keep_effect_id, expected_revision):
        source = _manifest_project(source_project)
        request = self._request(source, candidate, 'compile', effect_id,
                                keepEffectId=_id(keep_effect_id), expectedRevision=_revision(expected_revision))
        with self._lease(source['id'], effect_id):
            old = self._existing(request)
            if old:
                return old
            _, project = self._kept(source, candidate, keep_effect_id)
            before = _snapshot(project)
            if before['projectRevision'] != expected_revision:
                raise JointChangeError('conflict', '编译版本已改变，请刷新保留版本。')
            parent = self._path('compiles'); parent.mkdir(exist_ok=True)
            directory = self._path('compiles', effect_id)
            if directory.exists():
                raise JointChangeError('conflict', '编译输出目录已存在，未覆盖。')
            record = self._prepare(request)
            directory.mkdir(); compile_project = directory / 'project'; compile_project.mkdir()
            plc = Path(project['plc']).parent; hashes = source_hashes(plc)
            for file in source_files(plc):
                relative = file.relative_to(plc); destination = compile_project / relative
                destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(file, destination)
            if source_hashes(compile_project) != hashes or _snapshot(project) != before:
                raise JointChangeError('conflict', '编译副本与保存版本不一致。')
            error = None; response = {}
            try:
                response = self.compiler(compile_project, directory)
                payload = response.get('payload', {})
                success = response.get('returncode') == 0 and payload.get('ok') is True and payload.get('uploaded') is False
                if not success:
                    error = str(payload.get('error') or ('OpenPLC 编译未确认成功，进程返回码：' + str(response.get('returncode')) + '。'))[:600]
            except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                payload = {}; success = False; error = type(exc).__name__ + ': 编译未完成，见日志。'
            if _snapshot(project) != before or source_hashes(compile_project) != hashes:
                raise JointChangeError('conflict', '编译期间源版本变化，未发布编译成功。')
            artifacts = {}
            build = compile_project / 'build'
            if build.exists():
                for file in sorted(build.rglob('*')):
                    plain(file, compile_project)
                    if file.is_file():
                        artifacts[file.relative_to(compile_project).as_posix()] = _file_hash(file)
            if success and not artifacts:
                success = False; error = '编译器未产生可核对的构建产物。'
            result = {**request, 'status': 'compiled' if success else 'compile_failed',
                      'keptProjectId': project['id'], 'manifestPath': project['manifestPath'],
                      'sourceRevision': expected_revision, 'artifactHash': _digest(artifacts) if artifacts else None,
                      'artifacts': artifacts, 'logPath': str(directory / 'compile.log'),
                      'resultPath': str(directory / 'compile-result.json'), 'diagnostic': error,
                      'compilerExitCode': response.get('returncode'),
                      'invocationPath': str(directory / 'compile-invocation.json') if (directory / 'compile-invocation.json').exists() else None,
                      'completionScope': 'compile-only', 'uploaded': False, 'runtimeStarted': False}
            return self._confirm(request, result, record)
