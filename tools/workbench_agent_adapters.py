"""Read-only engineering snapshots and isolated, bounded native candidates.

This layer may launch the bounded OpenPLC candidate worker, but never sends model
requests, controls Runtime, modifies source projects, or regards a disk snapshot
as proof of an editor's unsaved state.
The optional state observer is a trusted in-process service adapter, never an API
argument provided by the browser. Current-editor proposals require that observer.
Explicit saved-revision proposals instead use a verified disk copy, excluding all
unsaved buffers without claiming they are clean. No apply/undo semantics exist.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import uuid

from factoryio_runtime import ROOT
from plcdev_runtime_owner import FileLease
from workbench_projects import read_user_project, SOURCE_ENTRIES
from workbench_project_config import plain, validate_oip, validate_fuxa, validate_interface_fuxa, read_json
from workbench_start_stop import source_files
from project_interface import ai_context

STATE_ROOT = ROOT / 'outputs/workbench/agent-candidates'
TOOLS = ('openplc', 'fuxa', 'oip')
MAX_FILES, MAX_BYTES = 10000, 100 * 1024 * 1024


class AdapterError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@contextmanager
def _candidate_project_lease(state_root, project_id):
    """Serialize this service's candidate work; this is not an editor lock.

    The lock is scoped to the configured candidate root, so isolated services
    retain isolated state. It coordinates cooperating adapter processes only;
    it cannot establish an independently launched editor's dirty state.
    """
    if not isinstance(project_id, str) or not re.fullmatch(r'user-[0-9a-f]{32}', project_id):
        raise AdapterError('invalid_request', '工程身份无效。')
    root = Path(state_root)
    root.mkdir(parents=True, exist_ok=True)
    plain(root, root)
    folder = root / '.project-locks'
    plain(folder, root)
    folder.mkdir(exist_ok=True)
    plain(folder, root)
    path = folder / (project_id + '.lock')
    plain(path, root)
    lease = FileLease(path)
    try:
        lease.__enter__()
    except RuntimeError:
        raise AdapterError('conflict', '此工程已有候选任务正在生成；请稍后重试。') from None
    try:
        yield
    finally:
        lease.__exit__(None, None, None)


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def _file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def _manifest_project(project):
    if not isinstance(project, dict) or project.get('kind') != 'user' or not project.get('manifestPath'):
        raise AdapterError('not_ready', '请先选择已登记的用户工程；当前不对旧案例直接生成候选。')
    actual = read_user_project(project['manifestPath'])
    if actual['id'] != project.get('id') or Path(actual['manifestPath']).resolve() != Path(project['manifestPath']).resolve():
        raise AdapterError('conflict', '工程身份或位置已改变；请重新打开工程。')
    return actual


def _files(project):
    root = Path(project['projectRoot']).resolve()
    manifest = Path(project['manifestPath'])
    result = {manifest}
    plc = Path(project['plc']).parent
    # source_files is deliberately restricted to compiler inputs, but a
    # directory junction may otherwise be skipped by rglob without warning.
    for entry in SOURCE_ENTRIES:
        top = plc / entry
        if top.exists() or top.is_symlink():
            plain(top, root)
        if top.is_dir():
            for folder, names, _ in os.walk(top, followlinks=False):
                plain(Path(folder), root)
                for name in names:
                    plain(Path(folder) / name, root)
    for path in source_files(plc):
        plain(path, root)
        result.add(path)
    for key in ('hmi', 'bindingsPath', 'interfacePath', 'modelBindingsPath'):
        if project.get(key):
            path = Path(project[key]); plain(path, root); result.add(path)
    if project.get('scene'):
        result.update(validate_oip(project['scene'])['files'])
    ordered = sorted(result, key=lambda p: p.relative_to(root).as_posix())
    for path in ordered:
        plain(path, root)
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise AdapterError('conflict', '受管理工程文件不存在或超出工程目录。')
    if len(ordered) > MAX_FILES or sum(p.stat().st_size for p in ordered) > MAX_BYTES:
        raise AdapterError('not_ready', '工程源文件超过候选限制。')
    return root, ordered


def _snapshot(project):
    root, paths = _files(project)
    files = {path.relative_to(root).as_posix(): _file_hash(path) for path in paths}
    return {'projectId': project['id'], 'files': files,
            'projectRevision': _digest({'projectId': project['id'], 'files': files})}


def _safe_state(observer, project):
    # Only a trusted local observer can establish identity/dirty state. Unknown is
    # intentionally distinct from closed, including when no observation exists.
    state = observer(project) if observer else None
    if not isinstance(state, dict): state = {}
    result = {}
    for tool in TOOLS:
        observed = state.get(tool) if isinstance(state.get(tool), dict) else {}
        status = observed.get('editState', 'unknown')
        if status not in ('unknown', 'closed', 'clean', 'unsaved', 'pending', 'busy'):
            status = 'unknown'
        result[tool] = {'editState': status, 'verified': observed.get('verified') is True}
        if not result[tool]['verified']: result[tool]['editState'] = 'unknown'
    return result


def _openplc_cli_rename(destination, task_id, project_id, baseline, digest, state_root):
    """Invoke the OpenPLC executable with its own isolated CLI worker code."""
    repo = ROOT / 'software/openplc-editor-zh'
    source = repo / 'src/cli/commands/agent-candidate.ts'
    worker = repo / 'src/cli/commands/agent-candidate-worker.cjs'
    typescript = repo / 'node_modules/typescript'
    executable = ROOT / 'outputs/openplc-editor-zh/OpenPLC-Editor-ZH-workbench-r3-20261028/OpenPLC Editor.exe'
    node = shutil.which('node')
    if not node or not all(x.exists() for x in (source,worker,typescript,executable)):
        raise AdapterError('not_ready', 'OpenPLC 候选 CLI 或构建依赖不可用；未使用其他方式修改。')
    compiled = destination / 'openplc-candidate-command.cjs'
    transpile = "const t=require(process.argv[1]),f=require('fs');f.writeFileSync(process.argv[3],t.transpileModule(f.readFileSync(process.argv[2],'utf8'),{compilerOptions:{module:t.ModuleKind.CommonJS,target:t.ScriptTarget.ES2020}}).outputText)"
    try:
        build = subprocess.run([node,'-e',transpile,str(typescript),str(source),str(compiled)],capture_output=True,timeout=25,check=False)
        if build.returncode: raise ValueError('transpile failed')
        token = secrets.token_hex(32)
        request = {'contractVersion':1,'capability':token,'taskId':task_id,'projectId':project_id,
                   'candidateId':destination.name,'baselineRevision':baseline,'candidateDigest':digest}
        env = {k:v for k,v in os.environ.items() if not any(x in k.upper() for x in ('API_KEY','PASSWORD','SECRET','TOKEN'))
               and k.upper() not in ('NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE')}
        env.update(ELECTRON_RUN_AS_NODE='1',PLCDEV_AGENT_CANDIDATE_ROOT=str(state_root),PLCDEV_AGENT_CAPABILITY=token)
        run = subprocess.run([str(executable),str(worker),str(compiled)],input=json.dumps(request,ensure_ascii=False).encode('utf-8'),
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30,check=False,
                             creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        result = json.loads(run.stdout.decode('utf-8'))
        if run.returncode or not result.get('ok') or result.get('result',{}).get('projectId') != project_id:
            raise ValueError('candidate CLI rejected')
        return result['result']
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        raise AdapterError('not_ready', 'OpenPLC 独立候选进程未能完成；未使用 Python 回退，候选未发布。') from exc


class AgentAdapters:
    def __init__(self, state_root=STATE_ROOT, observer=None):
        self.state_root = Path(state_root).absolute()
        self.observer = observer

    def inspect_project(self, project):
        project = _manifest_project(project)
        snapshot = _snapshot(project)
        manifest = read_json(project['manifestPath'])
        protocol = ('batch-mailbox-v1' if manifest['schemaVersion'] == 2 else
                    'project-interface-v1' if manifest['schemaVersion'] == 3 else None)
        details = None
        model_context = None
        states = _safe_state(self.observer, project)
        candidate_tools = {tool: states[tool]['editState'] in ('closed', 'clean') and
                           (tool == 'openplc' or bool(project.get('hmi' if tool == 'fuxa' else 'scene')))
                           for tool in TOOLS}
        if protocol == 'batch-mailbox-v1':
            config = project['configuration']['bindings']
            details = {'plcRoles': config['plc'], 'oip': config['oip']}
        elif protocol == 'project-interface-v1':
            # Full declaration is for local engineering inspection only. A model
            # may receive only the separately filtered aiContext, never this value.
            details = project['interfaceDefinition']
            model_context = ai_context(details)
        saved_count_candidate = protocol == 'batch-mailbox-v1' and str(
            details['plcRoles'].get('count', {}).get('path', '')).lower().endswith('.count')
        return {'status': 'ok', 'projectId': project['id'], 'name': project['name'],
                'projectRevision': snapshot['projectRevision'], 'files': snapshot['files'],
                'source': 'saved-files-only', 'schemaVersion': manifest['schemaVersion'],
                'protocol': protocol, 'interface': details, 'aiContext': model_context,
                'tools': {'openplc': {'available': True},
                          'fuxa': {'available': bool(project.get('hmi'))},
                          'oip': {'available': bool(project.get('scene'))}},
                'editorStates': states,
                'runtime': {'state': 'unknown', 'reason': '未通过权威执行服务核验实时会话'},
                'capabilities': {'inspect': True, 'deterministicCandidateImplemented': True,
                                 'deterministicCandidate': any(candidate_tools.values()),
                                 'savedRevisionCandidate': saved_count_candidate,
                                 'candidateToolsReady': candidate_tools, 'modelGeneration': False, 'apply': False, 'runtimeControl': False}}

    def propose_candidate(self, project, *, task_id, expected_revision, operation, source_basis='editor_current'):
        if source_basis not in ('editor_current', 'saved_revision'):
            raise AdapterError('invalid_request', '候选来源必须是编辑器当前状态或已保存版本。')
        project = _manifest_project(project)
        source_root = Path(project['projectRoot']).resolve()
        candidate_root = self.state_root.resolve()
        if candidate_root.is_relative_to(source_root) or source_root.is_relative_to(candidate_root):
            raise AdapterError('invalid_request', '任务目录不得与用户工程互相包含。')
        # Hold the lease for the full second inspection, source snapshot,
        # copy, native worker, conflict recheck and candidate receipt. It is
        # deliberately not presented as protection against external editors.
        with _candidate_project_lease(self.state_root, project['id']):
            return self._propose_candidate_locked(project, task_id=task_id,
                                                   expected_revision=expected_revision, operation=operation,
                                                   source_basis=source_basis)

    def _propose_candidate_locked(self, project, *, task_id, expected_revision, operation, source_basis):
        if not isinstance(task_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', task_id):
            raise AdapterError('invalid_request', '任务身份无效。')
        if not isinstance(expected_revision, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_revision):
            raise AdapterError('invalid_request', '需要已核对的工程版本摘要。')
        if not isinstance(operation, dict) or set(operation) - {'tool','kind','value','partId','viewId'}:
            raise AdapterError('invalid_request', '不支持的候选操作。')
        tool, kind, value = operation.get('tool'), operation.get('kind'), operation.get('value')
        if tool not in TOOLS or not isinstance(value, str) or not value.strip() or len(value) > 80 or any(ord(c) < 32 or c in '<>' for c in value):
            raise AdapterError('invalid_request', '候选目标或名称无效。')
        allowed = {('openplc','project-name'), ('openplc','batch-count-rename'), ('fuxa','view-name'), ('oip','part-name')}
        if (tool, kind) not in allowed:
            raise AdapterError('not_ready', '该工具的此类候选尚未接入。')
        if tool in ('fuxa', 'oip'):
            ident = operation.get('viewId' if tool == 'fuxa' else 'partId')
            if not isinstance(ident, str) or not ident or len(ident) > 120 or any(ord(c) < 32 for c in ident):
                raise AdapterError('invalid_request', '请指定有效的原生控件或场景部件身份。')
        states = _safe_state(self.observer, project)
        if source_basis == 'editor_current' and states[tool]['editState'] not in ('closed', 'clean'):
            raise AdapterError('not_ready', '无法确认该工具无未保存内容或待处理预览；未生成候选。')
        before = _snapshot(project)
        if before['projectRevision'] != expected_revision:
            raise AdapterError('conflict', '工程源已变化；请重新读取基线。')
        root, files = _files(project)
        if self.state_root.resolve().is_relative_to(root) or root.is_relative_to(self.state_root.resolve()):
            raise AdapterError('invalid_request', '任务目录不得与用户工程互相包含。')
        self.state_root.mkdir(parents=True, exist_ok=True)
        # A pre-existing task folder must not redirect candidate writes into a
        # user project through a symlink or Windows junction.
        plain(self.state_root, self.state_root)
        task_folder = self.state_root / task_id
        plain(task_folder, self.state_root)
        task_folder.mkdir(exist_ok=True)
        plain(task_folder, self.state_root)
        destination = task_folder / ('candidate-' + uuid.uuid4().hex)
        destination.mkdir(exist_ok=False)
        candidate_root = destination / 'project'; candidate_root.mkdir()
        for source in files:
            relative = source.relative_to(root)
            target = candidate_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if _file_hash(target) != before['files'][relative.as_posix()]:
                raise AdapterError('conflict', '复制过程中工程源已变化；未发布候选。')
        if _snapshot(project)['projectRevision'] != expected_revision:
            raise AdapterError('conflict', '复制过程中工程源已变化；未发布候选。')
        manifest_relative = Path(project['manifestPath']).relative_to(root)
        candidate = read_user_project(candidate_root / manifest_relative)
        # Never generate from a mixed or incomplete copy. This proves only the
        # chosen saved revision, not an editor buffer or an external edit lock.
        copied = _snapshot(candidate)
        if copied != before:
            raise AdapterError('conflict', '候选副本与已保存版本不一致；未开始修改。')
        changed_paths = None
        if tool == 'openplc' and kind == 'batch-count-rename':
            if value.strip() != 'BatchCount': raise AdapterError('not_ready','此候选仅支持 Count 改为 BatchCount。')
            role = candidate.get('configuration',{}).get('bindings',{}).get('plc',{}).get('count',{})
            if not str(role.get('path','')).lower().endswith('.count'): raise AdapterError('not_ready','批次 count 角色不是 Count。')
            initial = _snapshot(candidate)['projectRevision']
            staged = {'status':'staged','projectId':project['id'],'taskId':task_id,'baselineRevision':expected_revision,
                      'candidateDigest':initial,'authoritativeSourceModified':False,'applySupported':False}
            (destination/'candidate.json').write_text(json.dumps(staged,ensure_ascii=False),encoding='utf-8')
            result_cli = _openplc_cli_rename(destination, task_id, project['id'], expected_revision, initial, self.state_root)
            changed_paths = [candidate_root / relative for relative in result_cli['changedPaths']]
            path = next((p for p in changed_paths if p.suffix.lower()=='.ld'),None)
            if path is None or len(changed_paths)!=3: raise AdapterError('failed','OpenPLC 返回的候选文件范围无效。')
            old = 'Count'
        elif tool == 'openplc':
            path = Path(candidate['plc']); payload = read_json(path)
            old = payload['meta']['name'];payload['meta']['name'] = value.strip()
        elif tool == 'fuxa':
            if not candidate.get('hmi'): raise AdapterError('not_ready', '当前工程没有 FUXA 画面。')
            path = Path(candidate['hmi']);payload = read_json(path)
            views = payload.get('hmi', {}).get('views', [])
            matches = [x for x in views if isinstance(x, dict) and x.get('id') == operation.get('viewId')]
            if len(matches) != 1: raise AdapterError('invalid_request', '请指定本工程唯一的 FUXA viewId。')
            old = matches[0]['name'];matches[0]['name'] = value.strip()
        else:
            if not candidate.get('scene'): raise AdapterError('not_ready', '当前工程没有 OIP 场景。')
            scene = validate_oip(candidate['scene']);path = scene['root'] / scene['project']['scene'];payload = read_json(path)
            matches = [x for x in payload['parts'] if isinstance(x, dict) and x.get('id') == operation.get('partId')]
            if len(matches) != 1: raise AdapterError('invalid_request', '请指定本工程唯一的 OIP partId。')
            old = matches[0].get('name');matches[0]['name'] = value.strip()
        if changed_paths is None:
            with path.open('w', encoding='utf-8', newline='\n') as stream:
                json.dump(payload, stream, ensure_ascii=False, indent=2);stream.write('\n')
            changed_paths = [path]
        # Re-parse all supported native assets; this is structural validation,
        # not proof the editor opened, a PLC compiled, or the scene ran.
        candidate = read_user_project(candidate_root / manifest_relative)
        if candidate.get('hmi'):
            if read_json(candidate['manifestPath'])['schemaVersion'] == 2: validate_fuxa(candidate['hmi'])
            elif candidate.get('interfacePath'): validate_interface_fuxa(candidate['hmi'], candidate['interfacePath'])
        after = _snapshot(candidate)
        if kind == 'batch-count-rename' and after['projectRevision'] != result_cli['candidateDigest']:
            raise AdapterError('conflict', 'OpenPLC 候选摘要不一致；未发布。')
        if _snapshot(project)['projectRevision'] != expected_revision:
            raise AdapterError('conflict', '生成期间工程源已变化；未发布候选。')
        if source_basis == 'editor_current' and _safe_state(self.observer, project)[tool]['editState'] not in ('closed', 'clean'):
            raise AdapterError('conflict', '生成期间工具编辑状态已变化；未发布候选。')
        differences = [key for key in sorted(set(before['files']) | set(after['files']))
                       if before['files'].get(key) != after['files'].get(key)]
        if differences != sorted(p.relative_to(candidate_root).as_posix() for p in changed_paths):
            raise AdapterError('failed', '候选修改范围不符合请求；未发布候选。')
        result = {'status':'ok', 'projectId':project['id'], 'taskId':task_id,
                  'source':'saved-files-only' if source_basis == 'saved_revision' else 'deterministic-native-edit',
                  'sourceBasis':source_basis, 'generation':'deterministic-native-edit',
                  'unsavedEditsIncluded':False, 'tool':tool, 'operation':kind,
                  'baselineRevision':expected_revision, 'candidateDigest':after['projectRevision'],
                  'nativeArtifact':str(path), 'candidateManifest':str(candidate_root / manifest_relative),
                  'changedFiles':differences, 'summary':{'before':old, 'after':value.strip()},
                  'editorState':states[tool], 'validation':'native-structure-only',
                  'authoritativeSourceModified':False, 'modelCalled':False, 'applySupported':False}
        receipt = destination / 'candidate.json'
        with receipt.open('w' if kind == 'batch-count-rename' else 'x', encoding='utf-8', newline='\n') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2);stream.write('\n')
        return result


def inspect_project(project, *, observer=None):
    return AgentAdapters(observer=observer).inspect_project(project)


def propose_candidate(project, *, task_id, expected_revision, operation, observer=None, source_basis='editor_current'):
    return AgentAdapters(observer=observer).propose_candidate(project, task_id=task_id,
                expected_revision=expected_revision, operation=operation, source_basis=source_basis)
