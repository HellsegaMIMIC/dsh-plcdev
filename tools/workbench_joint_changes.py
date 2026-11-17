"""Persist joint candidates as saved project versions or legacy independent copies.

Same-project saves publish only the manifest; original native resource bytes
remain intact. Legacy independent copies retain their earlier semantics. No
operation starts a Runtime. Receipts describe effects, not live runtime state.
"""
from __future__ import annotations

from contextlib import contextmanager, ExitStack
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
from workbench_agent_adapters import _digest, _file_hash, _files, _manifest_project, _snapshot, _candidate_project_lease
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


def _compile_diagnostic(payload, log_path, returncode):
    """Expose bounded IEC diagnostics, not the compiler's machine inventory."""
    error = payload.get('error')
    fallback = error.get('message') if isinstance(error, dict) else error
    try:
        # The log is created by this compile invocation, never a model path.
        with Path(log_path).open('rb') as stream:
            stream.seek(0, 2); stream.seek(max(0, stream.tell() - 32768))
            text = stream.read().decode('utf-8', errors='replace')
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        lines = text.splitlines()
        first = next((i for i, line in enumerate(lines) if re.search(r'(?i)\berror\s*:', line)), None)
        if first is not None:
            detail = '\n'.join(line for line in lines[first:first + 20] if not re.fullmatch(r'-{5,}', line))
            if detail.strip(): return detail[:2000]
    except OSError:
        pass
    return str(fallback or ('OpenPLC 编译未确认成功，进程返回码：' + str(returncode) + '。'))[:600]


def _compiled_interface_check(project, compile_project):
    """Validate declared signals against this exact compile, without a Runtime."""
    from project_interface import bind_interface, interface_hash, validate_interface
    from project_interface_inputs import assert_local_project
    definition=validate_interface(read_json(project['interfacePath']))
    generated=compile_project/'build/OpenPLC Runtime v4/src'
    symbols=generated/'debug-map.json';program=generated/'program.st'
    plain(symbols,compile_project);plain(program,compile_project)
    if not symbols.is_file() or not program.is_file():
        raise ValueError('缺少本次编译的变量映射或程序文本，不能确认工程接口。')
    assert_local_project(compile_project,'local',program.read_text(encoding='utf-8-sig'))
    bound=bind_interface(definition,read_json(symbols)['leaves'])
    return {'id':'project-interface','label':'工程接口与编译变量核对','status':'passed',
            'variableCount':len(bound),'interfaceHash':interface_hash(definition),
            'debugMapSha256':_file_hash(symbols),'programSha256':_file_hash(program)}


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
                    if plan.get('completionScope') == 'saved-project-version':
                        baseline = read_user_project(plan['previousManifestPath'])
                        snapshot = _snapshot(baseline)
                        root = Path(plan['manifestPath']).parent
                        if (snapshot['projectRevision'] != plan['previousRevision'] or
                                any(_file_hash(root / name) != digest for name, digest in snapshot['files'].items()
                                    if root / name != Path(plan['manifestPath']))):
                            raise JointChangeError('unknown_outcome', '保存前快照无法核对；保留现场。')
                        if _snapshot(read_user_project(plan['savedManifestPath'])) != actual:
                            raise JointChangeError('unknown_outcome', '保存后快照无法核对；保留现场。')
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
        if result.get('completionScope') == 'saved-project-version':
            manifest = Path(result['manifestPath'])
            marker = Path(result['versionDirectory']) / 'publication.json'
            plain(marker, manifest.parent)
            _atomic(marker, {'schemaVersion': 1, 'state': 'confirmed', 'request': request,
                             'result': result, 'confirmedAt': time.time()})
            _atomic(self._lifecycle_path(request), {'status': 'kept', 'effectId': request['effectId']})
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
        schema = raw.get('schemaVersion')
        if schema not in (1, 2, 3):
            raise JointChangeError('not_ready', '此批保留仅支持用户 PLC、批次或工程接口项目。')
        raw.update(id=project_id, name=name)
        references = [('application', 'path')]
        if schema == 2:
            references += [('hmi', 'project'), ('simulation', 'project'), ('bindings', 'path')]
        elif schema == 1 and raw.get('simulation',{}).get('project') is not None:
            references.append(('simulation','project'))
        elif schema == 3:
            references += [('interface', 'path')]
            if raw.get('hmi') is not None:
                references.append(('hmi', 'project'))
            if raw['simulation'].get('project') is not None:
                references.append(('simulation', 'project'))
            if raw['simulation'].get('bindings') is not None:
                references.append(('simulation', 'bindings'))
        for section, field in references:
            raw[section][field] = prefix + '/' + raw[section][field].replace('\\', '/')
        return raw

    @staticmethod
    def _planned_snapshot(project, manifest, prefix, manifest_name='project.plcdev'):
        root = Path(project['projectRoot'])
        previous = _snapshot(project)
        original_manifest = Path(project['manifestPath']).relative_to(root).as_posix()
        files = {prefix + '/' + relative: digest for relative, digest in previous['files'].items() if relative != original_manifest}
        files[manifest_name] = hashlib.sha256(_bytes(manifest)).hexdigest()
        return {'projectId': manifest['id'], 'files': files,
                'projectRevision': _digest({'projectId': manifest['id'], 'files': files})}

    @staticmethod
    def _copy(project, destination, expected):
        root, paths = _files(project)
        destination.mkdir(parents=True, exist_ok=False)
        for source in paths:
            relative = source.relative_to(root); target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open('rb') as src, target.open('xb') as dst:
                shutil.copyfileobj(src, dst); dst.flush(); os.fsync(dst.fileno())
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

    @staticmethod
    def _version_relative(name):
        # A new version has one active content prefix, even after many saves.
        # Candidate generators preserve relative resource locations; flatten
        # only our own reserved prefix, never arbitrary user folder names.
        return re.sub(r'^\.plcdev/versions/v[0-9]{6}-[0-9a-f]{12}/content/', '', name.replace('\\', '/'))

    def _copy_version(self, project, destination, expected):
        """Copy referenced bytes into an independent canonical version tree."""
        root, paths = _files(project)
        destination.mkdir(parents=True, exist_ok=False)
        seen = set()
        for original in paths:
            name = original.relative_to(root).as_posix()
            if original == Path(project['manifestPath']):
                continue
            relative = self._version_relative(name)
            if relative in seen:
                raise JointChangeError('conflict', '版本资源路径冲突，未发布。')
            seen.add(relative)
            target = destination / relative
            plain(target, destination)
            target.parent.mkdir(parents=True, exist_ok=True)
            with original.open('rb') as src, target.open('xb') as dst:
                shutil.copyfileobj(src, dst); dst.flush(); os.fsync(dst.fileno())
            if _file_hash(target) != expected['files'][name]:
                raise JointChangeError('conflict', '复制时文件变化，未发布。')
        raw = read_json(project['manifestPath'])
        references = [('application', 'path')]
        if raw['schemaVersion'] == 2:
            references += [('hmi', 'project'), ('simulation', 'project'), ('bindings', 'path')]
        elif raw['schemaVersion']==1 and raw.get('simulation',{}).get('project') is not None:
            references.append(('simulation','project'))
        elif raw['schemaVersion'] == 3:
            references += [('interface', 'path')]
            if raw.get('hmi') is not None: references += [('hmi', 'project')]
            if raw['simulation'].get('project') is not None: references += [('simulation', 'project')]
            if raw['simulation'].get('bindings') is not None: references += [('simulation', 'bindings')]
        for section, field in references:
            raw[section][field] = self._version_relative(raw[section][field])
        _atomic(destination / 'project.plcdev', raw)
        if _snapshot(project) != expected:
            raise JointChangeError('conflict', '复制时工程版本变化，未发布。')
        return read_user_project(destination / 'project.plcdev')

    def keep_in_project(self, source_project, candidate, *, effect_id, expected_revision, candidate_digest):
        """Publish one same-UUID version by one atomic manifest replacement.

        Existing native resources are never overwritten, deleted or auto-saved.
        The shared Runtime lease spans publication; native tools must reload the
        new resource location and acknowledge it separately. An unsaved editor
        can keep its old resource/draft without losing bytes during publication.
        """
        source = _manifest_project(source_project)
        request = self._request(source, candidate, 'keep', effect_id,
                                expectedRevision=_revision(expected_revision))
        if candidate_digest != request['candidateDigest']:
            raise JointChangeError('conflict', '候选摘要不一致。')
        with self._lease(source['id'], effect_id):
            old = self._existing(request)
            if old: return old
            self._require_available(request)
            if candidate.get('baselineRevision') != expected_revision:
                raise JointChangeError('conflict', '审阅基线与请求不一致。')
            root = Path(source['projectRoot'])
            home = root / '.plcdev'
            plain(home, root); home.mkdir(exist_ok=True)
            from plcdev_runtime_owner import LOCK
            with ExitStack() as leases:
                try:
                    leases.enter_context(FileLease(home / 'publication.lock'))
                    leases.enter_context(FileLease(LOCK))
                    leases.enter_context(_candidate_project_lease(self.home.parent / 'candidates', source['id']))
                except RuntimeError as exc:
                    raise JointChangeError('not_ready', '工程或 Runtime 正被占用，未发布保存版本。') from exc
                # Publication errors must retain their unknown/conflict meaning;
                # only lease acquisition can prove that publication did not run.
                return self._publish_project_version(source, candidate, request, expected_revision, candidate_digest)

    def _publish_project_version(self, source, candidate, request, expected_revision, candidate_digest):
        root = Path(source['projectRoot']); manifest = Path(source['manifestPath'])
        for effect in self._path('effects').glob('*.json'):
            plain(effect, self.home)
            previous = read_json(effect)
            if (previous.get('completionScope') == 'saved-project-version'
                    and previous.get('request', {}).get('projectId') == source['id']
                    and previous.get('state') != 'confirmed'):
                raise JointChangeError('unknown_outcome', '本工程有未确认的保存操作，请先核对原记录。')
        versions = root / '.plcdev/versions'
        plain(versions, root); versions.mkdir(exist_ok=True)
        version = 2
        for directory in versions.iterdir():
            plain(directory, root)
            match = re.fullmatch(r'v([0-9]{6})-[0-9a-f]{12}', directory.name)
            if not match or not directory.is_dir():
                raise JointChangeError('conflict', '工程版本目录含未知记录；未覆盖。')
            version = max(version, int(match.group(1)) + 1)
            marker = directory / 'publication.json'
            if not marker.is_file() or read_json(marker).get('state') != 'confirmed':
                raise JointChangeError('unknown_outcome', '本工程有未确认的保存操作，请先核对原记录。')
        before = _snapshot(source)
        if before['projectRevision'] != expected_revision:
            raise JointChangeError('conflict', '工程保存内容已改变，未保留旧候选。')
        proposed = self._candidate(source, candidate, candidate_digest)
        proposed_snapshot = _snapshot(proposed)
        from workbench_fuxa_resources import require_snapshot_resources
        try:
            require_snapshot_resources(source, before)
            require_snapshot_resources(proposed, proposed_snapshot)
        except ValueError as exc:
            raise JointChangeError('not_ready', str(exc)) from None
        folder = versions / ('v%06d-' % version + hashlib.sha256(request['effectId'].encode()).hexdigest()[:12])
        plain(folder, root)
        # Persist the operation intent before writing any version resource.
        record = self._prepare(request, versionDirectory=str(folder), completionScope='saved-project-version')
        folder.mkdir()
        _atomic(folder / 'publication.json', {'schemaVersion': 1, 'state': 'prepared', 'request': request})
        self._copy(source, folder / 'before', before)
        staged = self._copy_version(proposed, folder / 'content', proposed_snapshot)
        prefix = (folder / 'content').relative_to(root).as_posix()
        published_manifest = self._view_manifest(staged, source['id'], source['name'], prefix)
        published_snapshot = self._planned_snapshot(staged, published_manifest, prefix, manifest.name)
        # A portable immutable after-snapshot supports old result cards after
        # later saves. Its relative paths/digest exactly match the published root.
        after = folder / 'after'
        after.mkdir()
        self._copy(staged, after / prefix, _snapshot(staged))
        _atomic(after / manifest.name, published_manifest)
        if _snapshot(read_user_project(after / manifest.name)) != published_snapshot:
            raise JointChangeError('conflict', '新版本快照不完整，未发布。')
        result = {**request, 'status': 'kept', 'keptProjectId': source['id'],
                  'manifestPath': str(manifest), 'revision': published_snapshot['projectRevision'],
                  'files': published_snapshot['files'], 'completionScope': 'saved-project-version',
                  'authoritativeSourceModified': True, 'activeResourceFilesOverwritten': False,
                  'version': version, 'previousRevision': expected_revision,
                  'previousManifestPath': str(folder / 'before' / manifest.name),
                  'savedManifestPath': str(after / manifest.name), 'versionDirectory': str(folder),
                  'editorSynchronization': 'pending', 'runtimeStarted': False}
        record = {**record, 'plannedResult': result}
        _atomic(self._receipt_path(request['effectId']), record)
        _atomic(folder / 'publication.json', {'schemaVersion': 1, 'state': 'prepared', 'request': request,
                                             'plannedResult': result})
        if _snapshot(source) != before or _snapshot(proposed) != proposed_snapshot:
            raise JointChangeError('conflict', '发布前工程或候选已改变，未发布。')
        plain(manifest, root)
        _atomic(manifest, published_manifest)
        if _snapshot(read_user_project(manifest)) != published_snapshot:
            raise JointChangeError('unknown_outcome', '保存后的工程摘要未确认，请保留现场。')
        # An independently editing tool may still be holding the previous
        # resource path. Never overwrite it; a concurrent saved edit is surfaced.
        if any(_file_hash(root / name) != digest for name, digest in before['files'].items()
               if root / name != manifest):
            raise JointChangeError('unknown_outcome', '保存时旧工具内容同时变化；新版本已发布，但同步结果待核对。')
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
        same_project = result.get('completionScope') == 'saved-project-version'
        target = Path(source['manifestPath']) if same_project else self._path('retained', _id(keep_effect_id), 'project.plcdev')
        if same_project and (result.get('keptProjectId') != source['id'] or result.get('authoritativeSourceModified') is not True):
            raise JointChangeError('conflict', '同工程保存记录的身份无效。')
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
            if kept['result'].get('completionScope') == 'saved-project-version':
                raise JointChangeError('not_ready', '已保存版本不能作为待审候选撤销；请基于当前工程继续修改。')
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
                    error = _compile_diagnostic(payload, directory / 'compile.log', response.get('returncode'))
            except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                payload = {}; success = False; error = type(exc).__name__ + ': 编译未完成，见日志。'
            checks=[{'id':'plc-compile','label':'PLC 原生编译','status':'passed' if success else 'failed'}]
            if project.get('interfacePath'):
                if success:
                    try:checks.append(_compiled_interface_check(project,compile_project))
                    except (OSError,ValueError,KeyError,TypeError) as exc:
                        success=False
                        error='工程接口验证未通过：'+(str(exc) if isinstance(exc,ValueError) else '无法读取本次编译的变量映射与程序。')[:500]
                        checks.append({'id':'project-interface','label':'工程接口与编译变量核对','status':'failed','diagnostic':error})
                else:
                    checks.append({'id':'project-interface','label':'工程接口与编译变量核对','status':'not_run','reason':'PLC 编译未通过。'})
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
                checks[0]['status']='failed'
            result = {**request, 'status': 'compiled' if success else 'compile_failed',
                      'keptProjectId': project['id'], 'manifestPath': project['manifestPath'],
                      'sourceRevision': expected_revision, 'artifactHash': _digest(artifacts) if artifacts else None,
                      'artifacts': artifacts, 'logPath': str(directory / 'compile.log'),
                      'resultPath': str(directory / 'compile-result.json'), 'diagnostic': error,
                      'checks': checks,
                      'compilerExitCode': response.get('returncode'),
                      'invocationPath': str(directory / 'compile-invocation.json') if (directory / 'compile-invocation.json').exists() else None,
                      'completionScope': 'compile-only', 'uploaded': False, 'runtimeStarted': False}
            return self._confirm(request, result, record)
