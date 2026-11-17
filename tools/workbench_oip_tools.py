"""OIP's native editor tools, executed only in an isolated candidate host.

No scene-editing algorithm is implemented here. OIP owns parameter validation,
IDs, placement, snapping and save serialization. A signed local receipt binds
the nondeterministic native result, so later review/keep never replays edits.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import uuid

from factoryio_runtime import ROOT
from workbench_agent_adapters import AdapterError
from workbench_project_config import plain, validate_oip

CATALOG = Path(__file__).with_name('oip_native_catalog.json')
HOST = Path(__file__).with_name('oip_native_candidate_host.py')
RUNS = Path('F:/PLCdev-build-temp/20261116/oip-native/runs')
RECEIPTS = ROOT / 'outputs/workbench/oip-native-receipts'
CONTRACT_VERSION = 1
MUTATIONS = frozenset(('add_part', 'update_part', 'delete_parts', 'duplicate_parts', 'snap_part'))
READS = frozenset(('get_scene', 'get_part', 'list_catalog', 'get_package', 'get_io_list', 'list_controllers', 'get_problems', 'check_part'))
ALLOWED = MUTATIONS | READS
CREATION_TOOL = {'name': 'new_project', 'inputSchema': {'type': 'object', 'properties': {
    'name': {'type': 'string', 'description': "the project's name; the folder is named after it"}},
    'required': ['name'], 'additionalProperties': False}}


def _fail(message, code='invalid_request'):
    raise AdapterError(code, message)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _digest(value):
    return hashlib.sha256(_json(value)).hexdigest()


def _catalog():
    return json.loads(CATALOG.read_text(encoding='utf-8'))


def identity():
    catalog = _catalog()
    return {'contractVersion': CONTRACT_VERSION, 'nativeVersion': catalog['nativeVersion'],
            'catalogDigest': _digest(catalog)}


def _reference(value, index):
    if not isinstance(value, dict) or '$result' not in value:
        return False
    if (set(value) != {'$result', 'path'} or type(value['$result']) is not int
            or not 0 <= value['$result'] < index or not isinstance(value['path'], str)
            or not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}', value['path'])):
        _fail('OIP 结果引用须指向前面的调用和明确字段。')
    return True


def _schema(value, schema, path, index, refs=False):
    if refs and _reference(value, index):
        return
    kind = schema.get('type')
    valid = {'object': lambda: isinstance(value, dict), 'array': lambda: isinstance(value, list),
             'string': lambda: isinstance(value, str) and '\0' not in value,
             'number': lambda: type(value) in (int, float) and math.isfinite(value),
             'integer': lambda: type(value) is int, 'boolean': lambda: type(value) is bool}
    if kind in valid and not valid[kind]():
        _fail('OIP 参数类型无效：' + path)
    if kind == 'object':
        props = schema.get('properties', {})
        if set(schema.get('required', [])) - set(value):
            _fail('OIP 参数缺少字段：' + path)
        if schema.get('additionalProperties') is False and set(value) - set(props):
            _fail('OIP 参数包含未开放字段：' + path)
        for key, child in value.items():
            if key in props:
                _schema(child, props[key], path + '.' + key, index, key in ('id', 'onto', 'parent', 'ids'))
    elif kind == 'array':
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', 1024):
            _fail('OIP 数组长度无效：' + path)
        for child in value:
            _schema(child, schema.get('items', {}), path, index, refs)


def _references(value, index, permitted=False):
    if isinstance(value, dict):
        if '$result' in value:
            if not permitted or not _reference(value, index):
                _fail('OIP 前序结果引用只能用于部件 ID。')
        else:
            for child in value.values():
                _references(child, index)
    elif isinstance(value, list):
        for child in value:
            _references(child, index, permitted)


def validate_calls(calls, *, allow_empty=False):
    """Bounded native schemas; no commands, code, runtime or model endpoints."""
    minimum = 0 if allow_empty else 1
    if not isinstance(calls, list) or not minimum <= len(calls) <= 64:
        _fail('OIP 工具调用数量须为 ' + str(minimum) + '–64 项。')
    try:
        if len(_json(calls)) > 512 * 1024:
            _fail('OIP 工具调用超过 512 KiB。')
    except (ValueError, TypeError, RecursionError):
        _fail('OIP 参数须为有限 JSON 数据。')
    schemas = {tool['name']: tool['inputSchema'] for tool in _catalog()['tools']}
    for index, call in enumerate(calls):
        if (not isinstance(call, dict) or set(call) != {'name', 'input'}
                or not isinstance(call.get('name'), str) or call['name'] not in ALLOWED
                or not isinstance(call.get('input'), dict)):
            _fail('OIP 仅开放部件编辑、参数绑定和检查；调用须含 name 与 input。')
        schema = schemas[call['name']]
        if call['name'] == 'check_part':
            schema = {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False}
        _schema(call['input'], schema, call['name'], index)
        for key, value in call['input'].items():
            _references(value, index, key in ('id', 'onto', 'parent', 'ids'))
        if call['name'] == 'update_part' and set(call['input']) == {'id'}:
            _fail('OIP 修改部件至少需要一个更改字段。')
    return copy.deepcopy(calls)


def validate_name(name):
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 80
            or any(ord(c) < 32 or ord(c) == 127 or c in '<>' for c in name)):
        _fail('OIP 场景名称须为 1–80 个字符，不能包含控制字符或尖括号。')
    return name.strip()


def _require_no_scene(project):
    if project.get('scene'):
        _fail('本工程已有 OIP 场景，请继续修改当前场景。', 'conflict')
    def empty_intent(value):
        return value is None or (isinstance(value, dict) and set(value) == {'provider', 'project'}
            and value['provider'] in ('none', 'oip') and value['project'] is None)
    if not empty_intent(project.get('simulation')):
        _fail('本工程已有仿真配置，不能用新场景覆盖。', 'conflict')
    # The parsed descriptor may be stale or omit optional metadata. Verify the
    # authoritative candidate manifest too; never replace an unseen model.
    if project.get('manifestPath'):
        try:
            manifest = json.loads(Path(project['manifestPath']).read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            _fail('工程声明无法核对，尚未创建场景。', 'conflict')
        if not isinstance(manifest, dict) or not empty_intent(manifest.get('simulation')):
            _fail('工程声明已有场景或仿真配置，未覆盖。', 'conflict')


def resolve_input(value, results):
    if isinstance(value, dict):
        if '$result' in value:
            result = results[value['$result']]
            for key in value['path'].split('.'):
                try:
                    result = result[int(key)] if isinstance(result, list) else result[key]
                except (KeyError, TypeError, IndexError, ValueError):
                    _fail('OIP 前序调用没有返回所引用的字段。')
            if not isinstance(result, str) or not result or len(result) > 512:
                _fail('OIP 部件引用必须解析为明确的 ID。')
            return result
        return {k: resolve_input(v, results) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_input(v, results) for v in value]
    return value


def _scene(project):
    if not project.get('scene'):
        _fail('请先为工程配置 OIP 场景。', 'not_ready')
    root = Path(project['projectRoot']).resolve()
    try:
        loaded = validate_oip(project['scene'], editing=True)
        plain(loaded['root'], root)
    except (ValueError, OSError) as exc:
        _fail(str(exc), 'not_ready')
    return root, loaded


def _snapshot(project):
    root, loaded = _scene(project)
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in loaded['files']}


def _inspect_catalog(loaded=None):
    """Planning metadata is disk-only; inspecting cannot open an editor/model."""
    catalog = _catalog()
    packages = []
    for item in catalog.get('packages', []):
        params = item.get('params', {})
        packages.append({'id': item['id'], 'name': item.get('name', item['id']),
                         'paramSchema': params, 'tagParams': {k: v for k, v in params.items() if v.get('type') == 'tag'}})
    # Project-local definitions may differ from the installed catalogue. Do not
    # infer executable behavior's parameters: the native get_package is final.
    for folder in loaded['project'].get('packages', []) if loaded else []:
        manifest = json.loads((loaded['root'] / folder / 'manifest.json').read_text(encoding='utf-8-sig'))
        if not any(p['id'] == manifest.get('id') for p in packages):
            packages.append({'id': manifest.get('id'), 'name': manifest.get('name'), 'paramSchema': {}, 'tagParams': {}, 'requiresNativeInspection': True})
    tools = []
    for item in catalog['tools']:
        if item['name'] not in ALLOWED:
            continue
        tool = copy.deepcopy(item)
        if item['name'] == 'check_part':
            tool['inputSchema'] = {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False}
            tool['description'] = 'Check an existing native part definition using OIP schema and deterministic bake; no source code is accepted.'
        tools.append(tool)
    return {**identity(), 'tools': tools, 'packages': packages,
            'parts': [{k: v for k, v in p.items() if k in ('id', 'name', 'type', 'package', 'packageId', 'position', 'rotationY', 'parent', 'params')} for p in loaded['scene']['parts']] if loaded else [],
            'limits': {'runtime': False, 'programEditing': False,
                       'executionPreflight': 'Requires the reviewed installed OIP 2026.11.9 package; exact native hashes are checked before launch. Metadata inspection does not assert executable availability.',
                       'parameterCatalog': 'Pinned native definitions; changed or custom parameter schemas require review before parameter editing.',
                       'externalPlcMapping': 'checked separately; native wiring checks inspect OIP internal program',
                       'resultReference': {'$result': 'zero-based previous call index', 'path': 'id or dotted result field; ID inputs only'}}}


def inspect_tools(project):
    """Planning metadata is disk-only; inspecting cannot open an editor/model."""
    _, loaded = _scene(project)
    return _inspect_catalog(loaded)


def inspect_creation(project):
    """Describe native scene creation without creating files or a renderer."""
    _require_no_scene(project)
    return {**_inspect_catalog(), 'canCreate': True, 'initialState': 'native-empty-project',
            'nativeDefaults': 'The native empty project includes its locked Building background; no application parts, PLC program or controller are created by PLCdev.',
            'creation': {'kind': 'oip-create-scene', 'nameMaxLength': 80,
                         'callsMinItems': 0, 'callsMaxItems': 64, 'nativeTool': copy.deepcopy(CREATION_TOOL)}}


def _atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(_json(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _key(create=False):
    path = RECEIPTS / '.receipt-key'
    if create:
        RECEIPTS.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(secrets.token_bytes(32)); stream.flush(); os.fsync(stream.fileno())
    try:
        plain(path, RECEIPTS)
        value = path.read_bytes()
    except OSError:
        _fail('OIP 执行凭据不可用；请重新生成候选。', 'conflict')
    if len(value) != 32:
        _fail('OIP 执行凭据无效。', 'conflict')
    return value


def _seal(payload):
    signature = hmac.new(_key(create=True), _json(payload), hashlib.sha256).hexdigest()
    _atomic(RECEIPTS / (payload['id'] + '.json'), {'payload': payload, 'signature': signature})
    return {'id': payload['id'], 'digest': _digest(payload), 'signature': signature, **identity()}


def verify_receipt(base, candidate, calls, receipt, *, creation_name=None):
    """Authenticate native execution and exact bytes. Never replay an edit."""
    creating = creation_name is not None
    if creating:
        creation_name = validate_name(creation_name)
        _require_no_scene(base)
    calls = validate_calls(calls, allow_empty=creating)
    if not isinstance(receipt, dict) or not re.fullmatch('[0-9a-f]{32}', str(receipt.get('id', ''))):
        _fail('OIP 原生执行回执无效。', 'conflict')
    path = RECEIPTS / (receipt['id'] + '.json')
    try:
        plain(path, RECEIPTS)
        record = json.loads(path.read_text(encoding='utf-8'))
        payload, signature = record['payload'], record['signature']
        trusted = hmac.new(_key(), _json(payload), hashlib.sha256).hexdigest()
        valid = (isinstance(signature, str) and hmac.compare_digest(trusted, signature)
                 and signature == receipt.get('signature') and _digest(payload) == receipt.get('digest')
                 and payload['phase'] == 'complete' and payload['id'] == receipt['id']
                 and payload['calls'] == calls and payload['identity'] == identity()
                 and payload.get('operation', 'edit') == ('create' if creating else 'edit')
                 and payload['before'] == ({} if creating else _snapshot(base)) and payload['after'] == _snapshot(candidate)
                 and payload['candidateRoot'] == str(Path(candidate['projectRoot']).resolve()))
        if creating:
            candidate_root, candidate_scene = _scene(candidate)
            valid = (valid and payload['creation']['name'] == creation_name
                     and payload['creation']['scenePath'] == candidate_scene['entry'].relative_to(candidate_root).as_posix()
                     and candidate_scene['project']['name'] == creation_name)
    except (OSError, ValueError, KeyError, TypeError):
        valid = False
    if not valid:
        _fail('OIP 候选与原生执行回执不一致；未重放工具或覆盖工程。', 'conflict')
    result = {'component': payload['component'], 'files': {name: payload['after'].get(name) for name in sorted(set(payload['before']) | set(payload['after']))}}
    if creating:
        result['scenePath'] = payload['creation']['scenePath']
    return result


def apply_tools(project, calls):
    """Execute on a separate scene copy, then publish only validated OIP files."""
    return _execute_candidate(project, calls)


def create_scene(project, name, calls):
    """Create through native new_project. Only the caller updates the manifest."""
    _require_no_scene(project)
    return _execute_candidate(project, calls, creation_name=validate_name(name))


def _execute_candidate(project, calls, *, creation_name=None):
    creating = creation_name is not None
    calls = validate_calls(calls, allow_empty=creating)
    if creating:
        _require_no_scene(project)
        root, loaded, before = Path(project['projectRoot']).resolve(), None, {}
    else:
        root, loaded = _scene(project)
        before = _snapshot(project)
    ticket = uuid.uuid4().hex
    run = RUNS / ticket
    plain(run, RUNS)
    run.mkdir(parents=True, exist_ok=False)
    staged = run / 'project'
    if not creating:
        staged.mkdir()
        for path in loaded['files']:
            target = staged / path.relative_to(loaded['root'])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    request = {'contractVersion': CONTRACT_VERSION, 'identity': identity(), 'calls': calls,
               'project': None if creating else str(staged),
               'sourceFiles': {} if creating else {p.relative_to(loaded['root']).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in loaded['files']}}
    destination = root / 'integration' / ticket / 'simulation/oip' if creating else loaded['root']
    if creating:
        plain(destination, root)
        if destination.exists():
            _fail('OIP 新场景目标目录已存在，未覆盖。', 'conflict')
        request.update(operation='create', name=creation_name)
    _atomic(run / 'request.json', request)
    journal = {'id': ticket, 'phase': 'prepared', 'identity': identity(), 'calls': calls, 'before': before,
               'candidateRoot': str(root), 'runDirectory': str(run)}
    if creating:
        journal.update(operation='create', creation={'name': creation_name,
            'scenePath': (destination / 'project.json').relative_to(root).as_posix()})
    _atomic(RECEIPTS / (ticket + '.pending.json'), journal)
    try:
        with (run / 'host.log').open('wb') as log:
            outcome = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(HOST), str(run / 'request.json')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=300)
        result = json.loads((run / 'result.json').read_text(encoding='utf-8'))
        if outcome.returncode != 0 or result.get('ok') is not True:
            _fail(result.get('error') or 'OIP 原生执行未完成；隔离现场已保留。', 'not_ready')
        if result.get('identity') != identity():
            _fail('OIP 执行器版本已变化。', 'conflict')
        if creating:
            staged = Path(result.get('project') or '').resolve()
            plain(staged, run / 'projects')
            if staged == run / 'projects':
                _fail('OIP 新场景未返回独立项目目录。', 'conflict')
        output = validate_oip(staged, editing=True)
        relative_after = {p.relative_to(staged).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in output['files']}
        if result.get('files') != relative_after or (not creating and _snapshot(project) != before):
            _fail('OIP 源或输出在执行期间发生变化；候选未覆盖。', 'conflict')
        if creating:
            _require_no_scene(project)
            if output['project']['name'] != creation_name or destination.exists():
                _fail('OIP 新场景名称或候选目标已改变。', 'conflict')
        # Export only native project references. AGENTS.md/profile/logs never
        # become part of a PLCdev project. Native process has already exited.
        previous = set() if creating else {p.relative_to(loaded['root']).as_posix() for p in loaded['files']}
        for name in previous - set(relative_after):
            (destination / name).unlink()
        for path in output['files']:
            target = destination / path.relative_to(staged)
            plain(target, root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        published = {**project, 'scene': str(destination / 'project.json')} if creating else project
        journal.update(phase='complete', after=_snapshot(published), component=result['component'])
        receipt = _seal(journal)
        return {'component': result['component'], 'receipt': receipt,
                **({'scene': str(destination / 'project.json')} if creating else {})}
    except BaseException as exc:
        journal.update(phase='unknown', error=str(exc)[:2000])
        _atomic(RECEIPTS / (ticket + '.pending.json'), journal)
        if isinstance(exc, AdapterError):
            raise
        _fail('OIP 原生执行未完成，隔离现场已保留：' + str(exc)[:500], 'not_ready')
