"""Versioned, portable FUXA/OIP definitions. No process, credential or device I/O."""
from pathlib import Path, PureWindowsPath
from urllib.parse import urlsplit
import hashlib, json, os, re, shutil, subprocess, uuid
from project_interface import PROTOCOL as INTERFACE_PROTOCOL, validate_interface
from project_model_binding import validate_model_binding, model_binding_hash
import xml.etree.ElementTree as ET

PROTOCOL = 'batch-mailbox-v1'
ROLES = {
    'sensorClear': ('BOOL', '%IX0.0', 'SensorClear'),
    'sceneRunning': ('BOOL', '%IX0.1', 'SceneRunning'),
    'permit': ('BOOL', '%IX0.2', 'Permit'),
    'commandSeq': ('INT', '%IW0', 'CommandSeq'),
    'commandKind': ('INT', '%IW1', 'CommandKind'),
    'commandValue': ('INT', '%IW2', 'CommandValue'),
    'entryConveyor': ('BOOL', '%QX0.0', 'EntryConveyor'),
    'conveyor': ('BOOL', '%QX0.1', 'Conveyor'),
    'ackSeq': ('INT', '%QW0', 'AckSeq'), 'ackCode': ('INT', '%QW1', 'AckCode'),
    'count': ('INT', '%QW2', 'Count'), 'target': ('INT', '%QW3', 'Target'),
    'state': ('INT', '%QW4', 'State'), 'remainingMs': ('INT', '%QW5', 'RemainingMs'),
    'flags': ('INT', '%QW6', 'Flags'), 'batchId': ('INT', '%QW7', 'BatchId'),
}
TAGS = {'count', 'target', 'countDisplay', 'targetDisplay', 'phase', 'quality', 'remainingDisplay',
        'communication', 'runtime', 'commandResult', 'targetDraft', 'recoveryDraft'}
DRAFTS = {'targetDraft', 'recoveryDraft'}
ACTIONS = {'target', 'start', 'stop', 'fault', 'clearFault', 'reset', 'newBatch', 'recover'}
DEVICE = 'd_plcdev_batch'
MAX_BYTES, MAX_FILES = 100 * 1024 * 1024, 10000


def read_json(path, limit=16 * 1024 * 1024):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError('配置文件不存在或超出大小限制：' + str(path))
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError, UnicodeError) as exc:
        raise ValueError('配置不是有效 UTF-8 JSON：' + str(path)) from exc
    if not isinstance(value, dict):
        raise ValueError('配置须为 JSON 对象：' + str(path))
    return value


def fields(value, allowed, required=None, label='配置'):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required or ()) - set(value):
        raise ValueError(label + '包含未知字段或缺少必需字段')
    return value


def plain(path, root):
    path, root = Path(path), Path(root)
    if not path.is_relative_to(root):
        raise ValueError('导入文件超出源目录')
    for part in [path, *path.parents]:
        if part.exists() or part.is_symlink():
            stat = part.lstat()
            if part.is_symlink() or getattr(stat, 'st_file_attributes', 0) & 0x400:
                raise ValueError('不支持链接／重解析点：' + str(part))
        if part == root:
            break


def relative(root, value):
    root = Path(root).resolve()
    if (not isinstance(value, str) or not value or ':' in value or '\x00' in value
            or PureWindowsPath(value).drive or value.startswith(('/', '\\'))):
        raise ValueError('组件须使用工程内相对路径')
    pieces = value.replace('\\', '/').split('/')
    if any(p in ('', '.', '..') or p.endswith(('.', ' ')) for p in pieces):
        raise ValueError('组件路径不能包含跳转或空目录段')
    path = root.joinpath(*pieces)
    plain(path, root)
    if not path.resolve().is_relative_to(root):
        raise ValueError('组件路径超出工程目录')
    return path


def _absolute_source(value):
    if not isinstance(value, (str, Path)) or not Path(value).is_absolute():
        raise ValueError('导入源须为绝对路径')
    path = Path(os.path.abspath(value))
    plain(path, path)
    return path.resolve()


def default_bindings(scene_name='PLCdev Continuous Batch External'):
    return {'schemaVersion': 1, 'protocol': PROTOCOL,
            'plc': {role: {'path': 'INSTANCE0.' + name, 'type': kind, 'location': loc}
                    for role, (kind, loc, name) in ROLES.items()},
            'oip': {'inputs': {'sensorOccupied': {'address': 0, 'activeHigh': True}},
                    'outputs': {'entryConveyor': {'address': 1}, 'conveyor': {'address': 0}},
                    'scene': {'project': scene_name}}}


def validate_bindings(value, scene_name=None):
    fields(value, {'schemaVersion', 'protocol', 'plc', 'oip'}, {'schemaVersion', 'protocol', 'plc', 'oip'}, '绑定表')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['protocol'] != PROTOCOL:
        raise ValueError('仅支持 batch-mailbox-v1 绑定协议版本 1')
    fields(value['plc'], ROLES, ROLES, 'PLC 角色')
    paths, occupied = set(), set()
    for role, (kind, default_location, _) in ROLES.items():
        item = fields(value['plc'][role], {'path', 'type', 'location'}, {'path', 'type', 'location'}, role)
        variable = item['path']
        if not isinstance(variable, str) or len(variable) > 200 or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+', variable, re.ASCII):
            raise ValueError(role + '需要完整的 PLC 实例变量路径')
        if variable.upper() in paths:
            raise ValueError('PLC 变量路径冲突：' + variable)
        paths.add(variable.upper())
        if item['type'] != kind:
            raise ValueError(role + '的 PLC 类型必须为 ' + kind)
        location = item['location']
        pattern = r'%([IQ])X(0|[1-9]\d*)\.([0-7])' if kind == 'BOOL' else r'%([IQ])W(0|[1-9]\d*)'
        match = re.fullmatch(pattern, location) if isinstance(location, str) else None
        if not match or match[1] != default_location[1] or int(match[2]) > 65535:
            raise ValueError(role + '的地址／方向不匹配（BOOL 用 IX/QX，INT 用 IW/QW）')
        # IEC X is byte.bit, W is a separate typed location space in OpenPLC.
        address = (match[1], 'X' if kind == 'BOOL' else 'W', int(match[2]), int(match[3]) if kind == 'BOOL' else 0)
        if address in occupied:
            raise ValueError('PLC 地址冲突：' + location)
        occupied.add(address)
    oip = fields(value['oip'], {'inputs', 'outputs', 'scene'}, {'inputs', 'outputs', 'scene'}, 'OIP')
    fields(oip['inputs'], {'sensorOccupied'}, {'sensorOccupied'}, 'OIP 输入')
    fields(oip['outputs'], {'entryConveyor', 'conveyor'}, {'entryConveyor', 'conveyor'}, 'OIP 输出')
    for name, item in [('sensorOccupied', oip['inputs']['sensorOccupied']), *oip['outputs'].items()]:
        expected = {'address', 'activeHigh'} if name == 'sensorOccupied' else {'address'}
        fields(item, expected, expected, name)
        if type(item['address']) is not int or not 0 <= item['address'] <= 65535:
            raise ValueError(name + '的 OIP 地址须为 0–65535 整数')
    if type(oip['inputs']['sensorOccupied']['activeHigh']) is not bool:
        raise ValueError('光电极性须为布尔值')
    if abs(oip['outputs']['entryConveyor']['address'] - oip['outputs']['conveyor']['address']) != 1:
        raise ValueError('OIP 两路输出须相邻且不同，以便重连时原子清零')
    fields(oip['scene'], {'project'}, {'project'}, '场景身份')
    name = oip['scene']['project']
    if not isinstance(name, str) or not name.strip() or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError('OIP 场景身份无效')
    if scene_name is not None and name != scene_name:
        raise ValueError('绑定的 OIP 场景名与导入工程不一致')
    return json.loads(json.dumps(value, allow_nan=False))


def _events(value, script_ids):
    if not isinstance(value, list):
        raise ValueError('HMI 事件须为数组')
    for event in value:
        fields(event, {'type', 'action', 'actparam', 'actoptions'}, {'type', 'action', 'actparam'}, 'HMI 事件')
        if event['type'] != 'click' or event['action'] != 'onRunScript' or event['actparam'] not in script_ids:
            raise ValueError('HMI 只允许调用已审核的批次按钮操作')
        if event.get('actoptions', {'params': []}) != {'params': []}:
            raise ValueError('批次按钮不能携带额外脚本参数')


def _safe_visual_data(value, script_ids):
    if isinstance(value, list):
        for item in value:
            _safe_visual_data(item, script_ids)
    elif isinstance(value, dict):
        for key, item in value.items():
            low = key.lower()
            if low in {'password', 'apikey', 'encryptedapikey', 'token', 'authorization', 'cookie', 'headers', 'code', 'script', 'expression', 'javascript'} and item:
                raise ValueError('HMI 包含未审核脚本、表达式或凭据字段')
            if key == 'events':
                _events(item, script_ids)
            elif key in {'variableId', 'variableId2'} and item and item not in {'plcdev_' + t for t in TAGS}:
                raise ValueError('HMI 变量不在批次白名单内：' + str(item))
            elif key in {'variableSrc', 'source'} and item and item != DEVICE:
                raise ValueError('HMI 不能引用其他通信设备')
            elif key in {'href', 'url', 'link', 'address'} and item:
                raise ValueError('HMI 页面包含外部链接／地址')
            _safe_visual_data(item, script_ids)


def _svg(svg):
    if not isinstance(svg, str) or len(svg) > 8 * 1024 * 1024 or '<!DOCTYPE' in svg.upper() or '<!ENTITY' in svg.upper():
        raise ValueError('HMI SVG 无效或包含外部实体')
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise ValueError('HMI SVG 不是有效 XML') from exc
    allowed = {'svg', 'g', 'title', 'desc', 'text', 'tspan', 'rect', 'path', 'line', 'polyline', 'polygon',
               'circle', 'ellipse', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
               'use', 'image', 'foreignObject', 'button', 'input', 'div', 'span', 'br'}
    ids = set()
    for node in root.iter():
        tag = node.tag.rsplit('}', 1)[-1]
        # FUXA's native SVG serializer emits HTML nodeName (INPUT/BUTTON).
        # Normalize only the already-allowed HTML names; SVG and attributes
        # still pass the same whitelist, event and external-resource checks.
        if tag.lower() in {'button', 'input', 'div', 'span', 'br'}:
            tag = tag.lower()
        if tag not in allowed:
            raise ValueError('HMI SVG 包含不支持的可执行元素：' + tag)
        ident = node.get('id')
        if ident:
            if ident in ids:
                raise ValueError('HMI SVG 元素 ID 重复')
            ids.add(ident)
        for key, value in node.attrib.items():
            attr = key.rsplit('}', 1)[-1].lower()
            if attr.startswith('on') or attr in {'src', 'srcdoc', 'formaction'}:
                raise ValueError('HMI SVG 包含事件代码或外部内容')
            if attr == 'href' and not (value.startswith('#') or (tag == 'image' and re.fullmatch(r'data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+', value))):
                raise ValueError('HMI SVG 不允许外部资源引用')
            # Paint servers may refer to local gradients, never external URLs.
            for reference in re.findall(r'url\s*\(\s*([^)]*)\)', value, re.I):
                if not reference.strip().strip("\"'").startswith('#'):
                    raise ValueError('HMI SVG 属性不能加载外部资源')
            if attr == 'style' and re.search(r'@import|expression\s*\(|javascript\s*:|behavior\s*:', value, re.I):
                raise ValueError('HMI 样式不能加载外部资源或代码')
    return ids


def _no_credentials(value):
    if isinstance(value, list):
        for item in value:
            _no_credentials(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            normalized = key.lower().replace('_', '').replace('-', '')
            if item and normalized in {'apikey', 'encryptedapikey', 'token', 'accesstoken', 'refreshtoken',
                                       'password', 'credential', 'credentials', 'cookie', 'authorization', 'privatekey', 'secret'}:
                raise ValueError('原生 HMI 中不能保存凭据字段')
            _no_credentials(item)


def validate_fuxa(path):
    """Accept native editable visuals, but only the reviewed local batch I/O contract."""
    path = _absolute_source(path)
    if path.suffix.lower() != '.fuxap':
        raise ValueError('请选择 FUXA 原生 .fuxap 工程')
    raw = read_json(path)
    _no_credentials(raw)
    if raw.get('version') != '1.01' or not isinstance(raw.get('hmi'), dict):
        raise ValueError('FUXA 原生工程版本／画面无效')
    if set(raw.get('devices', {})) != {DEVICE}:
        raise ValueError('FUXA 只支持一个本地批次适配设备')
    dev = raw['devices'][DEVICE]
    if dev.get('id') != DEVICE or dev.get('type') != 'WebAPI' or dev.get('enabled') is not True:
        raise ValueError('FUXA 批次设备类型无效')
    prop = fields(dev.get('property'), {'getTags', 'postTags'}, {'getTags', 'postTags'}, 'FUXA 通信')
    endpoint = prop['getTags']
    if endpoint != '/plcdev/tags':
        url = urlsplit(endpoint) if isinstance(endpoint, str) else None
        if not url or url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost'} or url.path != '/plcdev/tags' or url.query or url.fragment or url.username or url.password:
            raise ValueError('FUXA 通信地址只允许本机 /plcdev/tags')
    if prop['postTags'] is not True:
        raise ValueError('FUXA 本地编辑值回写配置无效')
    tags = dev.get('tags')
    if not isinstance(tags, dict) or not tags or set(tags) - {'plcdev_' + t for t in TAGS}:
        raise ValueError('FUXA 设备变量不在批次白名单内')
    for ident, tag in tags.items():
        name = ident[len('plcdev_'):]
        if not isinstance(tag, dict) or tag.get('id') != ident or tag.get('name') != name or tag.get('address') != ident:
            raise ValueError('FUXA 标签身份与语义不一致')
        if tag.get('type') != ('number' if name in DRAFTS else 'string') or tag.get('access') != ('readwrite' if name in DRAFTS else 'read'):
            raise ValueError('FUXA 标签类型／读写方向无效')
        if tag.get('daq', {}).get('enabled'):
            raise ValueError('当前工程导入不包含外部数据采集')
    scripts = raw.get('scripts', [])
    if not isinstance(scripts, list):
        raise ValueError('FUXA 脚本列表无效')
    script_ids = set()
    for script in scripts:
        action = str(script.get('id', ''))[len('s_plcdev_'):] if isinstance(script, dict) else ''
        if (action not in ACTIONS or script.get('id') != 's_plcdev_' + action or script['id'] in script_ids
                or script.get('mode') != 'CLIENT' or script.get('parameters') != []
                or script.get('code') != 'return await window.PLCdevHmi.command(' + json.dumps(action) + ');'):
            raise ValueError('FUXA 包含未审核脚本；只接受固定批次操作代理')
        script_ids.add(script['id'])
    server = raw.get('server', {})
    if server.get('type') != 'FuxaServer' or server.get('tags') or server.get('property'):
        raise ValueError('FUXA 不能包含额外服务器通信绑定')
    if raw.get('clientAccess', {}).get('scriptSystemFunctions') or any(raw.get(k) for k in ('plugin', 'recipes', 'alarms', 'notifications', 'reports')):
        raise ValueError('FUXA 不允许导入附加执行服务')
    views = raw['hmi'].get('views')
    if not isinstance(views, list) or not 1 <= len(views) <= 32:
        raise ValueError('FUXA 需要 1–32 个原生画面')
    for view in views:
        if view.get('type') != 'svg':
            raise ValueError('当前导入支持原生 SVG 画面')
        ids = _svg(view.get('svgcontent'))
        items = view.get('items', {})
        if not isinstance(items, dict):
            raise ValueError('FUXA 控件表无效')
        for ident, item in items.items():
            if not isinstance(item, dict) or item.get('id') != ident or ident not in ids:
                raise ValueError('FUXA 控件未对应到原生 SVG 元素')
            pro = item.get('property', {})
            var = pro.get('variableId')
            if var and var not in tags:
                raise ValueError('FUXA 控件绑定的标签未声明')
            if item.get('type') == 'svg-ext-html_input' and var not in {'plcdev_' + t for t in DRAFTS}:
                raise ValueError('FUXA 输入框只能编辑两种本地草稿值')
        _safe_visual_data({k:v for k,v in view.items() if k != 'svgcontent'}, script_ids)
        for ident, var in view.get('variables', {}).items():
            if ident not in tags or var.get('id') != ident or var.get('source') != DEVICE:
                raise ValueError('FUXA 画面变量绑定无效')
    _safe_visual_data(raw['hmi'].get('layout', {}), script_ids)
    # Normalize only the role endpoint; preserve normal native layout/metadata.
    raw['devices'][DEVICE]['property']['getTags'] = '/plcdev/tags'
    return raw


def validate_oip(source):
    source = _absolute_source(source)
    entry = source / 'project.json' if source.is_dir() else source
    if entry.name != 'project.json':
        raise ValueError('OIP 导入入口须为工程目录或 project.json')
    root = entry.parent
    project = read_json(entry)
    if project.get('version') != 7 or not isinstance(project.get('name'), str) or not project['name'].strip():
        raise ValueError('OIP 原生工程版本／名称无效')
    files = {entry}
    scene_path = relative(root, project.get('scene'))
    scene = read_json(scene_path);files.add(scene_path)
    if scene.get('version') != 4 or not isinstance(scene.get('parts'), list):
        raise ValueError('OIP 场景格式无效')
    plcs = scene.get('plcs')
    if not isinstance(plcs, list) or len(plcs) != 1 or plcs[0].get('runsOn') != 'plc' or plcs[0].get('protocol') != 'serve' or plcs[0].get('connect') is not True:
        raise ValueError('OIP 当前只支持一个外部 PLC 的 Modbus serve 场景')
    for key in ('program', 'tests'):
        paths = project.get(key, [])
        if not isinstance(paths, list):
            raise ValueError('OIP 原生引用须为数组')
        for value in paths:
            file = relative(root, value)
            if (key == 'program' and file.suffix.lower() not in {'.st', '.ld'}) or (key == 'tests' and file.suffix.lower() != '.json'):
                raise ValueError('OIP 程序／测试引用类型不受支持')
            if not file.is_file():
                raise ValueError('OIP 引用文件不存在：' + str(file))
            files.add(file)
    packages = project.get('packages', [])
    if not isinstance(packages, list):
        raise ValueError('OIP 部件包列表无效')
    for value in packages:
        folder = relative(root, value)
        if not folder.is_dir() or not (folder / 'manifest.json').is_file():
            raise ValueError('OIP 部件包不完整')
        for file in folder.rglob('*'):
            plain(file, root)
            if file.is_file():
                if file.suffix.lower() in {'.exe', '.dll', '.bat', '.cmd', '.ps1', '.py'} or file.name.lower() in {'.env', 'credentials.json', 'secrets.json', 'token.json'}:
                    raise ValueError('OIP 部件包包含不应随工程导入的文件')
                files.add(file)
    for file in files:
        plain(file, root)
    if len(files) > MAX_FILES or sum(f.stat().st_size for f in files) > MAX_BYTES:
        raise ValueError('OIP 工程超过 100 MiB／10000 个文件')
    return {'root': root, 'entry': entry, 'name': project['name'], 'project': project, 'scene': scene, 'files': sorted(files)}


def integration_definition(manifest, root):
    """Resolve schema-2 references and validate the actual project-owned files."""
    root = Path(root).resolve()
    fields(manifest.get('application'), {'provider', 'path'}, {'provider', 'path'}, 'PLC 应用')
    hmi = fields(manifest.get('hmi'), {'provider', 'project'}, {'provider', 'project'}, 'HMI 引用')
    sim = fields(manifest.get('simulation'), {'provider', 'project'}, {'provider', 'project'}, '场景引用')
    binding = fields(manifest.get('bindings'), {'provider', 'path'}, {'provider', 'path'}, '绑定引用')
    if hmi['provider'] != 'fuxa' or sim['provider'] != 'oip' or binding['provider'] != PROTOCOL:
        raise ValueError('当前配置支持 FUXA + OIP + batch-mailbox-v1')
    hmi_file, scene_file, bind_file = relative(root, hmi['project']), relative(root, sim['project']), relative(root, binding['path'])
    validate_fuxa(hmi_file); scene = validate_oip(scene_file)
    bindings = validate_bindings(read_json(bind_file), scene['name'])
    revision = manifest.get('configurationRevision')
    if not isinstance(revision, str) or not re.fullmatch('[0-9a-f]{16}', revision):
        raise ValueError('工程配置版本无效')
    return {'hmi': str(hmi_file), 'scene': str(scene_file), 'bindingsPath': str(bind_file),
            'configuration': {'hmiFile': hmi['project'], 'sceneFile': sim['project'], 'bindings': bindings,
                              'revision': revision, 'editable': True}}


def configure_project(manifest_path, config):
    """Copy/import into a new revision, then atomically publish only the manifest.

    Unreferenced files from a failed copy stay available for diagnosis. Existing
    revisions and the user's import sources are never overwritten or deleted.
    Caller serializes catalog mutations and protects active runtime ownership.
    """
    path = Path(manifest_path).resolve();root = path.parent
    raw = read_json(path)
    fields(config, {'hmiSource', 'oipSource', 'bindings', 'bindingsSource'}, label='工程配置请求')
    if ('bindings' in config) == ('bindingsSource' in config):
        raise ValueError('请提供绑定对象或绑定 JSON 路径，二选一')
    current = integration_definition(raw, root) if raw.get('schemaVersion') == 2 else {}
    hmi_source = config.get('hmiSource') or current.get('hmi')
    oip_source = config.get('oipSource') or current.get('scene')
    if not hmi_source or not oip_source:
        raise ValueError('首次配置需要 FUXA 画面和 OIP 场景导入源')
    hmi = validate_fuxa(hmi_source);scene = validate_oip(oip_source)
    bindings = validate_bindings(config['bindings'] if 'bindings' in config else read_json(_absolute_source(config['bindingsSource'])), scene['name'])
    parent = relative(root, 'integration')
    revision = uuid.uuid4().hex[:16];destination = relative(root, 'integration/' + revision)
    expected = {f: hashlib.sha256(f.read_bytes()).hexdigest() for f in scene['files']}
    parent.mkdir(exist_ok=True);destination.mkdir(exist_ok=False)
    hmi_path = destination / 'hmi/main.fuxap';hmi_path.parent.mkdir()
    hmi_path.write_text(json.dumps(hmi, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    scene_root = destination / 'simulation/oip';scene_root.mkdir(parents=True)
    for file in scene['files']:
        target = scene_root / file.relative_to(scene['root']);target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected[file]:
            raise ValueError('导入过程中源场景发生修改，未发布新配置')
    binding_path = destination / 'bindings.json'
    binding_path.write_text(json.dumps(bindings, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    updated = {**{k: raw[k] for k in ('id', 'name', 'target')},
               'application': {'provider': 'openplc', 'path': raw['application']['path']},
               'schemaVersion': 2, 'configurationRevision': revision,
               'hmi': {'provider': 'fuxa', 'project': hmi_path.relative_to(root).as_posix()},
               'simulation': {'provider': 'oip', 'project': (scene_root / 'project.json').relative_to(root).as_posix()},
               'bindings': {'provider': PROTOCOL, 'path': binding_path.relative_to(root).as_posix()}}
    integration_definition(updated, root)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(updated, stream, ensure_ascii=False, indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary, path)
    return updated



def _interface_cli(command, contract, project=None, output=None):
    """Run only the reviewed local FUXA data converter; no app or AI request."""
    node = shutil.which('node')
    if not node:
        raise ValueError('工程 FUXA 接口需要本机 Node.js')
    script = Path(__file__).resolve().parents[1] / 'software/fuxa-integration/project-interface.cjs'
    argv = [node, str(script), command, '--contract', str(contract)]
    if project is not None:
        argv += ['--project', str(project)]
    if output is not None:
        argv += ['--output', str(output), '--base', 'http://127.0.0.1:18810/']
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() not in ('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')}
    try:
        completed = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=30)
        answer = json.loads(completed.stdout.decode('utf-8-sig'))
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise ValueError('FUXA 工程接口转换／验证未完成') from exc
    if completed.returncode or not isinstance(answer, dict) or answer.get('ok') is not True:
        error = answer.get('error', '验证失败') if isinstance(answer, dict) else '验证结果格式无效'
        raise ValueError('FUXA 画面不符合当前工程接口声明：' + str(error)[:300])


def validate_interface_fuxa(path, contract_path):
    path = _absolute_source(path)
    if path.suffix.lower() != '.fuxap':
        raise ValueError('请选择 FUXA 原生 .fuxap 工程')
    raw = read_json(path)
    _no_credentials(raw)
    _interface_cli('validate-project', contract_path, project=path)
    for view in raw['hmi']['views']:
        _svg(view.get('svgcontent'))
    raw['devices']['d_plcdev_project']['property']['getTags'] = '/plcdev/tags'
    return raw


def interface_definition(manifest, root):
    """Resolve schema 3 without borrowing any batch roles or runtime observations."""
    root = Path(root).resolve()
    fields(manifest, {'schemaVersion', 'id', 'name', 'application', 'target', 'simulation', 'hmi',
                      'interface', 'configurationRevision'},
           {'schemaVersion', 'id', 'name', 'application', 'target', 'simulation', 'interface', 'configurationRevision'},
           '声明工程')
    application = fields(manifest.get('application'), {'provider', 'path'}, {'provider', 'path'}, 'PLC 应用')
    app = manifest['application']
    if app['provider'] != 'openplc':
        raise ValueError('声明工程需要 OpenPLC 应用')
    relative(root, app['path'])
    if manifest['target'] != {'provider': 'openplc-runtime', 'mode': 'local'}:
        raise ValueError('project-interface-v1 只支持本机隔离 Runtime')
    reference = fields(manifest['interface'], {'provider', 'path'}, {'provider', 'path'}, '接口引用')
    reference = manifest['interface']
    if reference['provider'] != INTERFACE_PROTOCOL:
        raise ValueError('工程接口协议无效')
    contract_file = relative(root, reference['path'])
    definition = validate_interface(read_json(contract_file))
    revision = manifest.get('configurationRevision')
    if not isinstance(revision, str) or not re.fullmatch('[0-9a-f]{16}', revision):
        raise ValueError('工程配置版本无效')
    hmi_file, hmi_reference = None, None
    if manifest.get('hmi') is not None:
        hmi_reference = fields(manifest['hmi'], {'provider', 'project'}, {'provider', 'project'}, 'HMI 引用')
        hmi_reference = manifest['hmi']
        if hmi_reference['provider'] != 'fuxa':
            raise ValueError('工程接口当前支持 FUXA 原生画面')
        hmi_file = relative(root, hmi_reference['project'])
        validate_interface_fuxa(hmi_file, contract_file)
    simulation = model_simulation_definition(manifest['simulation'], root, definition)
    return {**simulation, 'hmi': str(hmi_file) if hmi_file else None,
            'interfacePath': str(contract_file), 'interfaceDefinition': definition,
            'configuration': {'hmiFile': hmi_reference['project'] if hmi_reference else None,
                              'interfaceFile': reference['path'], 'revision': revision, 'editable': True,
                              'modelBindingHash': simulation.get('modelBindingHash'),
                              'sceneFile': manifest['simulation'].get('project')}}


def configure_interface_project(manifest_path, definition, hmi_source=None):
    """Publish a validated, project-owned interface + HMI revision atomically.

    An omitted HMI generates a fresh declared-variable screen; earlier revisions
    remain untouched. No changes are made to the PLC source, current runtime,
    native import source or existing batch schema-2 configuration.
    """
    path = Path(manifest_path).resolve();root = path.parent
    raw = read_json(path)
    if type(raw.get('schemaVersion')) is not int or raw['schemaVersion'] not in (1, 3):
        raise ValueError('批次 schema-2 工程保留原绑定；请在普通本机工程配置声明接口')
    if raw.get('target') != {'provider': 'openplc-runtime', 'mode': 'local'}:
        raise ValueError('工程声明需要本机隔离 Runtime 目标')
    contract = validate_interface(definition)
    simulation = raw.get('simulation', {'provider':'none', 'project':None})
    if raw['schemaVersion'] == 1:
        simulation = {'provider':'none', 'project':None}
    model_simulation_definition(simulation, root, contract)
    if hmi_source is not None:
        source = _absolute_source(hmi_source)
        if source.suffix.lower() != '.fuxap':
            raise ValueError('请选择 FUXA 原生 .fuxap 工程')
        screen = read_json(source);_no_credentials(screen)
    else:
        screen = None
    revision = uuid.uuid4().hex[:16]
    destination = relative(root, 'integration/' + revision)
    destination.parent.mkdir(exist_ok=True);destination.mkdir(exist_ok=False)
    contract_file = destination / 'interface.json'
    contract_file.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    hmi_file = destination / 'hmi/main.fuxap';hmi_file.parent.mkdir()
    if screen is None:
        _interface_cli('reference', contract_file, output=hmi_file)
    else:
        # Validate the exact snapshot being copied, never a changing import source.
        hmi_file.write_text(json.dumps(screen, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    screen = validate_interface_fuxa(hmi_file, contract_file)
    hmi_file.write_text(json.dumps(screen, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    updated = {**{key: raw[key] for key in ('id', 'name', 'target')}, 'schemaVersion': 3,
               'application': {'provider': 'openplc', 'path': raw['application']['path']},
               'configurationRevision': revision,
               'interface': {'provider': INTERFACE_PROTOCOL, 'path': contract_file.relative_to(root).as_posix()},
               'hmi': {'provider': 'fuxa', 'project': hmi_file.relative_to(root).as_posix()},
               'simulation': simulation}
    interface_definition(updated, root)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(updated, stream, ensure_ascii=False, indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary, path)
    return updated


def model_simulation_definition(simulation, root, interface):
    """Resolve schema-3 model resources. Configuration is not a running link."""
    root = Path(root).resolve()
    if simulation == {'provider':'none', 'project':None}:
        return {'scene':None}
    fields(simulation, {'provider','project','bindings'}, {'provider','project','bindings'}, '模型场景引用')
    if simulation['provider'] not in ('local-model','oip'):
        raise ValueError('声明工程仿真只支持 none／local-model／oip')
    model_file = relative(root, simulation['bindings'])
    definition = validate_model_binding(read_json(model_file), interface)
    scene_file = None
    if simulation['provider'] == 'local-model':
        if simulation['project'] is not None:
            raise ValueError('数值模型不使用伪场景路径')
    else:
        scene_file = relative(root, simulation['project'])
        validate_oip(scene_file)
    return {'scene':str(scene_file) if scene_file else None,
            'modelBindingsPath':str(model_file), 'modelDefinition':definition,
            'modelBindingHash':model_binding_hash(definition)}


def configure_model_project(manifest_path, definition, oip_source=None):
    """Import an independent model binding/optional native scene revision.

    Caller must hold its normal project configuration lock. This does not create
    a Runtime adapter, approve executable code or claim an OIP link is connected.
    Source assets and earlier revisions remain unchanged on errors.
    """
    path=Path(manifest_path).resolve();root=path.parent;raw=read_json(path)
    if type(raw.get('schemaVersion')) is not int or raw['schemaVersion']!=3:
        raise ValueError('请先为普通工程保存 schema-3 公开接口')
    current=interface_definition(raw,root)
    binding=validate_model_binding(definition,current['interfaceDefinition'])
    scene=validate_oip(oip_source) if oip_source is not None else None
    expected={f:hashlib.sha256(f.read_bytes()).hexdigest() for f in scene['files']} if scene else {}
    revision=uuid.uuid4().hex[:16];destination=relative(root,'integration/'+revision)
    destination.parent.mkdir(exist_ok=True);destination.mkdir(exist_ok=False)
    binding_file=destination/'model-bindings.json'
    binding_file.write_text(json.dumps(binding,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    simulation={'provider':'local-model','project':None,'bindings':binding_file.relative_to(root).as_posix()}
    if scene:
        scene_root=destination/'simulation/oip';scene_root.mkdir(parents=True)
        for file in scene['files']:
            target=scene_root/file.relative_to(scene['root']);target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(file,target)
            if hashlib.sha256(target.read_bytes()).hexdigest()!=expected[file]:
                raise ValueError('导入过程中源场景改变，未发布模型配置')
        simulation.update(provider='oip',project=(scene_root/'project.json').relative_to(root).as_posix())
    updated={**raw,'configurationRevision':revision,'simulation':simulation}
    interface_definition(updated,root)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with temporary.open('x',encoding='utf-8') as stream:
        json.dump(updated,stream,ensure_ascii=False,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    return updated
