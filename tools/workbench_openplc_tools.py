"""Transport for OpenPLC's shared editor tools, never a second editor engine.

The trusted worker receives only UTF-8 native project files and structured tool
calls. It returns a complete file map; only the private candidate caller writes
those results. Verification replays the same worker in memory. No model, editor
window, Runtime, device, or shell command is exposed to model input.
"""
from __future__ import annotations

from collections import OrderedDict
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import threading
import uuid

from factoryio_runtime import ROOT
from workbench_agent_adapters import AdapterError
from workbench_project_config import plain
from workbench_start_stop import source_files

REPO = ROOT / 'software/openplc-editor-zh'
BUILD_SCRIPT = REPO / 'scripts/build-agent-tools.cjs'
SOURCE_MANIFEST = REPO / 'scripts/agent-tools-sources.json'
BUILD_ROOT = ROOT / 'outputs/workbench/openplc-shared-tools'
MAX_FILES = 512
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_REPLY_BYTES = 20 * 1024 * 1024
_LOCK = threading.RLock()
_CACHE: OrderedDict[str, dict] = OrderedDict()
_ROOT_ABSOLUTE = Path(os.path.abspath(ROOT))


def _source_path(path):
    # Lexical canonicalization intentionally keeps dependency junctions in the
    # path. Reading through that path notices a changed junction target; calling
    # realpath on every one of >1,000 files is unnecessary and slow on Windows.
    result = Path(os.path.abspath(path))
    if not result.is_relative_to(_ROOT_ABSOLUTE):
        _fail('OpenPLC 编辑工具依赖超出工作区。', 'not_ready')
    return result


def _source_key(path):
    return _source_path(path).relative_to(_ROOT_ABSOLUTE).as_posix()


def _fail(message, code='invalid_request'):
    raise AdapterError(code, message)


def validate_calls(calls):
    """Check the envelope only; OpenPLC owns every tool's editing semantics."""
    if not isinstance(calls, list) or not 1 <= len(calls) <= 64:
        _fail('OpenPLC 编辑需要 1–64 项工具调用。')
    for call in calls:
        if (not isinstance(call, dict) or set(call) != {'name', 'input'}
                or not isinstance(call['name'], str) or not re.fullmatch('[a-z][a-z0-9_]{0,79}', call['name'])
                or not isinstance(call['input'], dict)):
            _fail('OpenPLC 工具调用须包含 name 与 input 对象。')
    try:
        if len(json.dumps(calls, ensure_ascii=False, allow_nan=False).encode()) > 512 * 1024:
            _fail('OpenPLC 工具调用超过 512 KiB。')
    except (ValueError, TypeError):
        _fail('OpenPLC 工具参数须为有限 JSON 数据。')
    return calls


def _engine_sources():
    # The reviewed dependency list is generated explicitly during development,
    # never by a user request. Thus a cold cache has exactly the same identity
    # as a warm one, and imported library/compiler changes are also covered.
    paths = [SOURCE_MANIFEST, BUILD_SCRIPT, REPO / 'package.json', REPO / 'package-lock.json']
    if SOURCE_MANIFEST.is_file():
        raw = json.loads(SOURCE_MANIFEST.read_text(encoding='utf-8'))
        names = raw.get('sources') if isinstance(raw, dict) and raw.get('contractVersion') == 1 else None
        if not isinstance(names, list) or not names or len(names) > 5000:
            _fail('OpenPLC 编辑工具依赖清单无效。', 'not_ready')
        for name in names:
            if not isinstance(name, str): _fail('OpenPLC 编辑工具依赖路径无效。', 'not_ready')
            path = _source_path(REPO / name)
            paths.append(path)
    dependency_roots = (REPO / 'node_modules', ROOT / '.tools/dsh-host/node_modules')
    resolved_roots = [(path, path.resolve()) for path in dependency_roots]
    result = {}
    for path in sorted(set(paths)):
        actual = path
        # Resolve the package installation root once, rather than traversing
        # the same Windows directory junction for every dependency file. Its
        # target is re-read on each call, so moving the installation is noticed.
        for logical, resolved in resolved_roots:
            if path.is_relative_to(logical):
                actual = resolved / path.relative_to(logical)
                break
        try: digest = hashlib.sha256(actual.read_bytes()).hexdigest()
        except (FileNotFoundError, IsADirectoryError): digest = 'missing'
        result[_source_key(path)] = digest
    return result


def _identity(sources):
    digest = hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'contractVersion': 1, 'sourceSha256': digest}


def source_identity():
    """Fast local source identity; does not build or launch a worker."""
    return _identity(_engine_sources())


def _environment():
    return {key: value for key, value in os.environ.items()
            if not any(secret in key.upper() for secret in ('API_KEY', 'PASSWORD', 'SECRET', 'TOKEN'))
            and key.upper() not in ('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')}


def _metadata_valid(metadata, bundle, sources):
    if (not isinstance(metadata, dict) or metadata.get('contractVersion') != 1
            or metadata.get('engine') != 'openplc-shared-editor-tools-v1'
            or not isinstance(metadata.get('sources'), dict) or not metadata['sources']
            or metadata.get('bundleSha256') != hashlib.sha256(bundle.read_bytes()).hexdigest()):
        return False
    for name, expected in metadata['sources'].items():
        if not isinstance(name, str): return False
        try: key = _source_key(name)
        except AdapterError: return False
        if sources.get(key) != expected: return False
    return True


def _bundle(identity, sources):
    node = shutil.which('node')
    if not node or not BUILD_SCRIPT.is_file() or not SOURCE_MANIFEST.is_file():
        _fail('OpenPLC 共享编辑工具或构建依赖不可用；没有使用另一套编辑实现。', 'not_ready')
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    plain(BUILD_ROOT, ROOT)
    target = BUILD_ROOT / (identity['sourceSha256'] + '.cjs')
    metadata = Path(str(target) + '.meta.json')
    with _LOCK:
        if target.is_file() and metadata.is_file():
            plain(target, BUILD_ROOT); plain(metadata, BUILD_ROOT)
            cached = json.loads(metadata.read_text(encoding='utf-8'))
            if _metadata_valid(cached, target, sources):
                return node, target
        staged = BUILD_ROOT / ('building-' + uuid.uuid4().hex + '.cjs')
        try:
            result = subprocess.run([node, str(BUILD_SCRIPT), str(staged)], cwd=REPO,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False,
                env=_environment(), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            staged_metadata = Path(str(staged) + '.meta.json')
            if result.returncode or not staged.is_file() or not staged_metadata.is_file():
                _fail('OpenPLC 共享编辑工具构建未完成；候选未发布。', 'not_ready')
            if source_identity() != identity:
                _fail('OpenPLC 编辑器源码在构建期间变化，请重试。', 'conflict')
            metadata_value = json.loads(staged_metadata.read_text(encoding='utf-8'))
            if not _metadata_valid(metadata_value, staged, sources):
                _fail('OpenPLC 编辑工具构建依赖未列入共享清单或摘要不符，请更新工具包。', 'not_ready')
            os.replace(staged, target)
            os.replace(staged_metadata, metadata)
            return node, target
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            if isinstance(exc, AdapterError): raise
            _fail('OpenPLC 共享编辑工具构建未完成：' + type(exc).__name__, 'not_ready')


def _path(name):
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or any(ord(c) < 32 for c in name) or name.startswith('/')
            or any(part in ('', '.', '..') or part.endswith((' ', '.')) for part in name.split('/'))):
        _fail('OpenPLC 返回了无效的工程内文件路径。')
    path = PurePosixPath(name)
    if path.is_absolute(): _fail('OpenPLC 文件必须位于工程内。')
    return path


def _files(project):
    root = Path(project['plc']).parent.resolve()
    files, total = {}, 0
    for path in source_files(root):
        relative = path.relative_to(root).as_posix()
        if relative not in ('project.json', 'library.json') and not relative.startswith(('pous/', 'datatypes/')):
            continue
        _path(relative); plain(path, root)
        raw = path.read_bytes(); total += len(raw)
        if len(raw) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
            _fail('OpenPLC 保存工程超过共享编辑工具的文件大小限制。', 'not_ready')
        try: files[relative] = raw.decode('utf-8')
        except UnicodeError: _fail('OpenPLC 编辑工具只读取 UTF-8 原生工程文件。', 'not_ready')
    if 'project.json' not in files: _fail('OpenPLC 原生工程清单不存在。', 'not_ready')
    return root, files


def _allowed_change(name, before):
    _path(name)
    if name == 'project.json': return True
    if name.startswith('datatypes/'):
        # Datatype tools are not part of this release. Preserve their bytes.
        return False
    return bool(re.fullmatch(r'pous/(?:programs|functions|function-blocks)/[A-Za-z_][A-Za-z_0-9]{0,63}\.(?:st|ld)', name))


def _checked_files(before, after):
    if not isinstance(after, dict) or len(after) > MAX_FILES:
        _fail('OpenPLC 共享工具返回的文件集合无效。')
    total = 0
    for name, content in after.items():
        _path(name)
        if not isinstance(content, str): _fail('OpenPLC 文件内容须为 UTF-8 文本。')
        size = len(content.encode('utf-8')); total += size
        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            _fail('OpenPLC 编辑结果超过文件大小限制。')
    if 'project.json' not in after: _fail('OpenPLC 编辑结果缺少原生工程清单。')
    for name in set(before) | set(after):
        if before.get(name) != after.get(name) and not _allowed_change(name, before):
            _fail('OpenPLC 编辑超出允许的 POU／变量范围：' + name)
    try:
        old = json.loads(before['project.json'].lstrip('\ufeff'))
        new = json.loads(after['project.json'].lstrip('\ufeff'))
    except (ValueError, TypeError): _fail('OpenPLC 编辑结果不是原生工程清单。')
    if not isinstance(new, dict) or new.get('meta') != old.get('meta'):
        _fail('OpenPLC 编辑不能改变工程身份。')
    # Hardware, task scheduling and resource instances are not exposed by the
    # shared POU/variable tools. Global variables are their only config field.
    def invariant(value):
        result = copy.deepcopy(value)
        data = result.get('data', {})
        # Native serializer derives debug-variable names from the final POUs.
        # They are still checked against an exact shared-engine replay; they do
        # not authorize hardware or task configuration changes.
        for key in ('pous', 'debugVariables'): data.pop(key, None)
        resource = data.get('configuration', {}).get('resource', {})
        resource.pop('globalVariables', None)
        return result
    if invariant(new) != invariant(old):
        _fail('OpenPLC 编辑不能改变设备、任务配置或其他未开放的工程属性。')
    return after


def _invoke(files, calls=None):
    sources = _engine_sources(); identity = _identity(sources)
    operation = 'inspect' if calls is None else 'apply'
    request = {'contractVersion': 1, 'operation': operation, 'files': files}
    if calls is not None: request['calls'] = validate_calls(calls)
    body = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    node, bundle = _bundle(identity, sources)
    bundle_digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    key = hashlib.sha256(identity['sourceSha256'].encode() + bundle_digest.encode() + body).hexdigest()
    with _LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return copy.deepcopy(_CACHE[key])
    try:
        result = subprocess.run([node, str(bundle)], input=body, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=45, check=False, env=_environment(),
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if len(result.stdout) > MAX_REPLY_BYTES: _fail('OpenPLC 共享编辑结果超过限制。')
        response = json.loads(result.stdout.decode('utf-8'))
        if not isinstance(response, dict): raise ValueError('invalid receipt')
        if result.returncode or response.get('ok') is not True:
            message = response.get('error')
            _fail('OpenPLC 编辑工具拒绝此项修改：' + (message[:600] if isinstance(message, str) else '执行结果未确认。'))
        if response.get('contractVersion') != 1 or response.get('engine') != 'openplc-shared-editor-tools-v1':
            _fail('OpenPLC 共享编辑工具版本不匹配。', 'not_ready')
        if not isinstance(response.get('tools'), list) or not isinstance(response.get('project'), dict):
            _fail('OpenPLC 工具目录或工程上下文无效。', 'not_ready')
        if calls is not None: _checked_files(files, response.get('files'))
        if source_identity() != identity:
            _fail('OpenPLC 编辑工具源码在执行期间变化，请重新读取工程。', 'conflict')
        with _LOCK:
            _CACHE[key] = copy.deepcopy(response)
            while len(_CACHE) > 32: _CACHE.popitem(last=False)
        return response
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired) as exc:
        if isinstance(exc, AdapterError): raise
        _fail('OpenPLC 共享编辑工具未能完成：' + type(exc).__name__, 'not_ready')


def inspect_tools(project):
    _, files = _files(project)
    result = _invoke(files)
    return {'contractVersion': 1, 'tools': result['tools'], 'project': result['project']}


def replay_tools(project, calls):
    """Return only expected changed bytes, relative to PLCdev project root."""
    plc_root, before = _files(project)
    after = _invoke(before, calls)['files']
    prefix = plc_root.relative_to(Path(project['projectRoot']).resolve())
    return {(prefix / name).as_posix(): after[name].encode('utf-8') if name in after else None
            for name in set(before) | set(after) if before.get(name) != after.get(name)}


def apply_tools(project, calls):
    root = Path(project['projectRoot']).resolve()
    changes = replay_tools(project, calls)
    for name, content in changes.items():
        path = root / name; plain(path, root)
        if content is None:
            if path.is_file(): path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True); plain(path, root)
            path.write_bytes(content)
    return changes


def component(calls):
    return {'tool': 'openplc', 'summary': 'OpenPLC 共享编辑：' + '、'.join(call['name'] for call in calls)}
