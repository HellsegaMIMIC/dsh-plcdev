"""Portable workbench project definitions; runtime observations never live here."""
from pathlib import Path, PureWindowsPath
import json, re, os, shutil, subprocess, threading, uuid
from factoryio_runtime import ROOT
from plcdev_environment import tool_path
from plcdev_runtime_owner import FileLease
from workbench_project_config import integration_definition, configure_project, interface_definition, configure_interface_project

REGISTRY = ROOT / 'software/workbench/projects.json'
PATH_FIELDS = ('plc', 'hmi', 'scene', 'hmiExecutable', 'hmiBuild')

def load_projects(path=REGISTRY):
    raw = json.loads(Path(path).read_text(encoding='utf-8'))
    if raw.get('schemaVersion') != 1 or not isinstance(raw.get('projects'), list):
        raise ValueError('工程清单格式无效')
    entries = {}; kinds = set()
    for original in raw['projects']:
        item = dict(original)
        project_id = item.get('id')
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', project_id) or project_id in entries:
            raise ValueError('工程标识无效或重复')
        if item.get('kind') not in ('batch', 'start-stop') or not item.get('name') or not item.get('plc'):
            raise ValueError('工程缺少类型、名称或 PLC 文件')
        if item['kind'] in kinds:
            raise ValueError('当前版本每种运行器只支持一个登记工程')
        kinds.add(item['kind'])
        if item.get('target') != '本机隔离 Runtime' or item.get('defaultMode') != ('factoryio' if item['kind']=='batch' else 'local'):
            raise ValueError('工程运行目标或默认模式不受支持')
        if item['id'] != ('batch-conveyor' if item['kind']=='batch' else 'start-stop'):
            raise ValueError('当前版本仅支持已验收的两个工程运行器')
        for key in PATH_FIELDS:
            value = item.get(key)
            if value is None:
                item[key] = None
                continue
            if not isinstance(value, str) or Path(value).is_absolute():
                raise ValueError('工程文件须使用项目相对路径')
            resolved = (ROOT / value).resolve()
            if not resolved.is_relative_to(ROOT.resolve()):
                raise ValueError('工程路径超出 PLCdev 目录')
            item[key] = str(resolved)
        if Path(item['plc']).name != 'project.json':
            raise ValueError('PLC 工程入口必须指向 project.json')
        if item['kind'] == 'batch' and not all(item.get(k) for k in ('hmi', 'hmiExecutable', 'hmiBuild', 'scene')):
            raise ValueError('批次工程关联文件不完整')
        entries[project_id] = item
    default = raw.get('defaultProjectId')
    if not entries and default is None:
        return None, entries
    if default not in entries:
        raise ValueError('默认工程不存在')
    return default, entries

DEFAULT_PROJECT_ID, PROJECTS = load_projects()


# A portable project owns definitions, never a running process or local tool path.
USER_INDEX = Path(os.environ.get('PLCDEV_PROJECT_INDEX',str(ROOT / 'outputs/workbench/user-projects.json'))).resolve()
EDITOR = tool_path('editor')
SOURCE_ENTRIES = ('project.json', 'library.json', 'pous', 'datatypes', 'devices', 'servers')
SIMULATORS = ('none', 'oip', 'factoryio')
IGNORED_IMPORT_NAMES = {'.git', '.env', '.tools', 'build', 'outputs', 'node_modules', '__pycache__',
                        'credentials.json', 'secrets.json', 'token.json', 'private-key.pem'}


def _json(path):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        raise ValueError('无法读取工程文件：' + str(path)) from exc
    if not isinstance(value, dict):
        raise ValueError('工程文件必须是 JSON 对象：' + str(path))
    return value


def _name(value, folder=False):
    if not isinstance(value, str) or not value.strip() or len(value) > 80 or any(ord(c) < 32 for c in value):
        raise ValueError('工程名称须为 1–80 个可见字符')
    value = value.strip()
    if folder and (re.search(r'[<>:"/\\|?*]', value) or value in ('.', '..') or value.endswith(('.', ' '))
                   or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', value, re.I)):
        raise ValueError('工程名称不能用作文件夹；请去除路径字符或 Windows 保留名称')
    return value


def _absolute(value):
    if not isinstance(value, (str, Path)) or not str(value).strip() or not Path(value).is_absolute():
        raise ValueError('请选择绝对路径')
    return Path(value).resolve()


def _relative(root, value):
    if not isinstance(value, str) or not value or PureWindowsPath(value).drive or value.startswith(('/', '\\')):
        raise ValueError('工程组件须使用工程内的相对路径')
    path = (root / value.replace('\\', '/')).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('工程组件路径超出工程目录')
    return path


def _native_project(path):
    raw = _json(path)
    if not isinstance(raw.get('meta'), dict) or raw['meta'].get('type') != 'plc-project' or not isinstance(raw.get('data'), dict):
        raise ValueError('请选择完整的 OpenPLC PLC 工程，不能使用库工程或其他软件的 project.json')
    return raw


def read_user_project(manifest_path):
    path = _absolute(manifest_path)
    if path.suffix.lower() != '.plcdev':
        raise ValueError('请选择 .plcdev 工程文件')
    raw = _json(path)
    project_id = raw.get('id')
    if type(raw.get('schemaVersion')) is not int or raw['schemaVersion'] not in (1, 2, 3) or not isinstance(project_id, str) or not re.fullmatch(r'user-[0-9a-f]{32}', project_id):
        raise ValueError('用户工程版本或唯一标识无效')
    name = _name(raw.get('name'))
    app, target, simulation = raw.get('application'), raw.get('target'), raw.get('simulation')
    if not isinstance(app, dict) or app.get('provider') != 'openplc':
        raise ValueError('工程需要一个 OpenPLC 应用')
    if target != {'provider': 'openplc-runtime', 'mode': 'local'}:
        raise ValueError('当前用户工程仅支持本机隔离 Runtime')
    if raw['schemaVersion'] == 1:
        if not isinstance(simulation, dict) or simulation.get('provider') not in SIMULATORS or simulation.get('project') is not None:
            raise ValueError('仿真组件格式无效；版本 1 只记录候选工具，未接入场景')
    elif raw['schemaVersion'] == 2 and set(raw) - {'schemaVersion', 'id', 'name', 'application', 'target', 'simulation', 'hmi', 'bindings', 'configurationRevision'}:
        raise ValueError('工程配置包含未知字段；运行状态、安装位置和凭据须留在本机环境中')
    if raw['schemaVersion'] == 3:
        interface_config = interface_definition(raw, path.parent)
    plc = _relative(path.parent, app.get('path'))
    if plc.name != 'project.json':
        raise ValueError('OpenPLC 应用入口须指向 project.json')
    _native_project(plc)
    project = dict(id=project_id, name=name, kind='user', description='用户工程 · 本机隔离 Runtime',
                target='本机隔离 Runtime', defaultMode='local', plc=str(plc), hmi=None, scene=None,
                hmiExecutable=None, hmiBuild=None, manifestPath=str(path), projectRoot=str(path.parent),
                application=dict(app), targetDefinition=dict(target), simulation=dict(simulation),
                links=[dict(id='load', source='plc', target='runtime', role='program')], configuration=None)
    if raw['schemaVersion'] == 2:
        definition = integration_definition(raw, path.parent)
        project.update(definition)
        project.update(defaultMode='fuxa-oip', description='用户工程 · FUXA／OIP 批次通信',
                       hmiDefinition=dict(raw['hmi']), bindingsDefinition=dict(raw['bindings']),
                       links=[dict(id='load', source='plc', target='runtime', role='program'),
                              dict(id='hmi-runtime', source='hmi', target='runtime', role='communication'),
                              dict(id='runtime-scene', source='runtime', target='factory', role='communication')])
    if raw['schemaVersion'] == 3:
        project.update(interface_config)
        project.update(defaultMode='fuxa-local' if project['hmi'] else 'local', description='用户工程 · 声明变量与操作 · 本机隔离 Runtime',
                       hmiDefinition=dict(raw['hmi']) if raw.get('hmi') else None,
                       interfaceReference=dict(raw['interface']))
        if project['hmi']:
            project['links'].append(dict(id='hmi-runtime', source='hmi', target='runtime', role='communication'))
        if project.get('scene'):
            project['links'].append(dict(id='runtime-scene', source='runtime', target='factory', role='communication'))
    return project


class ProjectCatalog:
    """Local recent-project index plus portable per-project manifests.

    Missing/invalid registrations stay in the index and are exposed in
    ``unavailable``. A malformed index blocks mutation rather than being reset.
    """
    def __init__(self, registry_path=REGISTRY, index_path=None, editor_path=None):
        self.registry_path = Path(registry_path)
        self.index_path = Path(USER_INDEX if index_path is None else index_path)
        self.editor_path = Path(editor_path) if editor_path is not None else EDITOR
        self.lock = threading.RLock()
        self.projects = {}
        self.unavailable = []
        self.refresh()

    def _entries(self):
        if not self.index_path.exists():
            return []
        raw = _json(self.index_path)
        entries = raw.get('projects')
        if raw.get('schemaVersion') != 1 or not isinstance(entries, list):
            raise ValueError('本机工程索引已损坏；请保留原文件并修复，未覆盖索引')
        ids = set()
        for item in entries:
            if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                    or not re.fullmatch(r'user-[0-9a-f]{32}', item['id']) or item['id'] in ids
                    or not isinstance(item.get('manifestPath'), str) or not Path(item['manifestPath']).is_absolute()):
                raise ValueError('本机工程索引无效或包含重复标识；未覆盖索引')
            ids.add(item['id'])
        return entries

    def _write_entries(self, entries):
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.index_path.with_name(self.index_path.name + '.' + uuid.uuid4().hex + '.tmp')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(dict(schemaVersion=1, projects=entries), stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, self.index_path)

    def refresh(self):
        with self.lock:
            default, projects = load_projects(self.registry_path)
            unavailable = []
            for item in self._entries():
                try:
                    project = read_user_project(item['manifestPath'])
                    if project['id'] != item['id']:
                        raise ValueError('工程标识与登记时不同，请重新打开正确工程')
                    projects[project['id']] = project
                except (OSError, ValueError) as exc:
                    unavailable.append(dict(item, error=str(exc)))
            self.default, self.projects, self.unavailable = default, projects, unavailable
            return self.projects

    def _register(self, project, entries):
        previous = next((item for item in entries if item['id'] == project['id']), None)
        if previous and _absolute(previous['manifestPath']) != Path(project['manifestPath']):
            if Path(previous['manifestPath']).exists():
                raise ValueError('相同工程标识已在其他位置登记；独立副本请用“导入 OpenPLC 副本”生成新标识')
        updated = [item for item in entries if item['id'] != project['id']]
        updated.append(dict(id=project['id'], manifestPath=project['manifestPath']))
        self._write_entries(updated)
        self.projects[project['id']] = project
        self.unavailable = [item for item in self.unavailable if item['id'] != project['id']]
        return project

    def open(self, manifest_path):
        with self.lock, FileLease(self.index_path.with_suffix('.lock'), timeout=3):
            entries = self._entries()
            return self._register(read_user_project(manifest_path), entries)

    def configure(self, manifest_or_id, config):
        """Import portable integration assets. The workbench protects active sessions."""
        with self.lock, FileLease(self.index_path.with_suffix('.lock'), timeout=3):
            entries = self._entries()
            registered = next((entry for entry in entries if entry['id'] == manifest_or_id), None)
            manifest = registered['manifestPath'] if registered else manifest_or_id
            project = read_user_project(manifest)
            previous = next((entry for entry in entries if entry['id'] == project['id']), None)
            if previous and _absolute(previous['manifestPath']) != Path(project['manifestPath']) and Path(previous['manifestPath']).exists():
                raise ValueError('相同工程标识已在其他位置登记；不能配置未登记的副本')
            configure_project(project['manifestPath'], config)
            return self._register(read_user_project(project['manifestPath']), entries)

    def configure_interface(self, manifest_or_id, definition, hmi_source=None):
        """Save project declarations; the workbench controller protects active owners."""
        with self.lock, FileLease(self.index_path.with_suffix('.lock'), timeout=3):
            entries = self._entries()
            registered = next((entry for entry in entries if entry['id'] == manifest_or_id), None)
            manifest = registered['manifestPath'] if registered else manifest_or_id
            project = read_user_project(manifest)
            previous = next((entry for entry in entries if entry['id'] == project['id']), None)
            if previous and _absolute(previous['manifestPath']) != Path(project['manifestPath']) and Path(previous['manifestPath']).exists():
                raise ValueError('相同工程标识已在其他位置登记；不能配置未登记的副本')
            configure_interface_project(project['manifestPath'], definition, hmi_source)
            return self._register(read_user_project(project['manifestPath']), entries)

    @staticmethod
    def inspect(manifest_path):
        """Validate without changing the recent list or any live manager."""
        return read_user_project(manifest_path)

    def _create_native(self, root, language):
        if not self.editor_path.is_file():
            raise ValueError('缺少支持 CLI 新建工程的 OpenPLC 编辑器：' + str(self.editor_path))
        profile = self.index_path.parent / 'create-profiles' / uuid.uuid4().hex
        profile.mkdir(parents=True, exist_ok=False)
        environment = {key: value for key, value in os.environ.items()
                       if not key.upper().startswith(('OPENPLC_', 'PYTHON', 'MSYSTEM'))
                       and key.upper() not in ('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS')}
        try:
            result = subprocess.run([str(self.editor_path), '--cli', 'create', 'plc', '--path', str(root),
                                     '--language', language, '--user-data', str(profile), '--json'],
                                    cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=90)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError('OpenPLC 新建未完成；已生成的文件保留在 ' + str(root) + '，请检查编辑器 CLI') from exc
        try:
            reply = json.loads(result.stdout.decode('utf-8-sig'))
        except (ValueError, UnicodeError):
            reply = {}
        if result.returncode or not isinstance(reply, dict) or reply.get('ok') is not True:
            raise RuntimeError('OpenPLC 新建失败；已生成的文件保留在 ' + str(root) + '，请检查编辑器 CLI')
        _native_project(root / 'plc/project.json')

    @staticmethod
    def _native_sources(source):
        source = _absolute(source)
        if source.is_file():
            if source.name != 'project.json':
                raise ValueError('导入入口须为 OpenPLC 工程目录或 project.json')
            source = source.parent
        _native_project(source / 'project.json')
        files = []
        for name in SOURCE_ENTRIES:
            entry = source / name
            if not entry.exists():
                continue
            candidates = [entry] + (list(entry.rglob('*')) if entry.is_dir() else [])
            for path in candidates:
                if any(part.lower() in IGNORED_IMPORT_NAMES or part.startswith('.') for part in path.relative_to(source).parts):
                    continue
                attributes = getattr(path.lstat(), 'st_file_attributes', 0)
                if path.is_symlink() or attributes & 0x400 or not path.resolve().is_relative_to(source):
                    raise ValueError('导入工程包含链接或外部文件，须先整理为独立源工程：' + str(path))
                if path.is_file():
                    files.append(path)
        if sum(path.stat().st_size for path in files) > 100 * 1024 * 1024 or len(files) > 10000:
            raise ValueError('工程源文件超出导入范围（最多 100 MiB／10000 文件）')
        return source, files

    @staticmethod
    def _copy_native(source, files, destination):
        destination.mkdir(parents=True, exist_ok=False)
        for path in files:
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)

    def create(self, name, parent, language='ld', simulation='none', source=None):
        name = _name(name, folder=True)
        if language not in ('ld', 'st') or simulation not in SIMULATORS:
            raise ValueError('请选择 LD／ST 及支持的仿真候选')
        parent = _absolute(parent)
        if parent.exists() and not parent.is_dir():
            raise ValueError('工程保存位置必须是文件夹')
        root = (parent / name).resolve()
        if root.parent != parent:
            raise ValueError('工程目录超出所选保存位置')
        with self.lock, FileLease(self.index_path.with_suffix('.lock'), timeout=3):
            entries = self._entries()  # refuse a broken index before touching the user's folder
            if root.exists():
                raise ValueError('工程文件夹已存在；为避免覆盖，请使用新的工程名称')
            if source is not None:
                source_root, source_files = self._native_sources(source)
                if root.is_relative_to(source_root):
                    raise ValueError('导入副本不能保存在源工程内部')
            elif not self.editor_path.is_file():
                raise ValueError('缺少支持 CLI 新建工程的 OpenPLC 编辑器：' + str(self.editor_path))
            parent.mkdir(parents=True, exist_ok=True)
            root.mkdir(exist_ok=False)
            if source is not None:
                self._copy_native(source_root, source_files, root / 'plc')
            else:
                self._create_native(root, language)
            manifest = root / 'project.plcdev'
            raw = dict(schemaVersion=1, id='user-' + uuid.uuid4().hex, name=name,
                       application=dict(provider='openplc', path='plc/project.json'),
                       target=dict(provider='openplc-runtime', mode='local'),
                       simulation=dict(provider=simulation, project=None))
            with manifest.open('x', encoding='utf-8') as stream:
                json.dump(raw, stream, ensure_ascii=False, indent=2); stream.write('\n')
            return self._register(read_user_project(manifest), entries)
