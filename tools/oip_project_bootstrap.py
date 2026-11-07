"""Build an isolated OIP copy with a narrow, trusted project bootstrap.

The original install and user profile are never written. The managed copy keeps
the upstream sandbox, IPC origin checks, and endpoint-consent implementation.
Only a project-owned profile can receive one loopback Modbus server definition.
This module does not start OIP, run a scene, or send PLC commands.
"""
from __future__ import annotations

from pathlib import Path
import hashlib
import ctypes
import json
import os
import re
import shutil
import struct
import uuid
from plcdev_environment import tool_path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = tool_path('oipExecutable').parent
# On this Windows host an unmodified OIP copy also fails before initialization
# under .tools, while the same files/profile work here. Keep the known-good
# deployment path; the underlying path restriction has not been established.
CACHE = ROOT / 'outputs/workbench/oip-runtime'
PATCH_VERSION = 6
UPSTREAM_VERSION = '2026.10.29'
EXPECTED = {
    'main.cjs': '77b4968452c94327624270d7d02a0ea5f49354b147d7b562d8a135591b75246d',
    'preload.cjs': '522e2e86b21325b821d5a06c303689493700cce3471bf6a714a2728b07c36694',
}
MAIN_ANCHOR = "  ipcMain.handle('parts:pickFolder',"
PRELOAD_ANCHOR = "const { contextBridge, ipcRenderer, webUtils } = require('electron')"
MAIN_PATCH = r"""
  // PLCdev managed project: fixed loopback configuration, through upstream trust checks.
  ipcMain.on('plcdev:bootstrap', (event) => {
    if (!process.env.OIP_PLCDEV_BOOTSTRAP) { event.returnValue = null; return }
    try {
      const path = require('node:path')
      const profile = realpathSync(app.getPath('userData'))
      const argumentProfile = app.commandLine.getSwitchValue('user-data-dir')
      if (!argumentProfile || realpathSync(argumentProfile) !== profile) throw new Error('profile')
      const file = realpathSync(process.env.OIP_PLCDEV_BOOTSTRAP)
      if (file !== realpathSync(join(profile, 'plcdev-bootstrap.json'))) throw new Error('file')
      const bytes = readFileSync(file)
      if (bytes.length > 8192) throw new Error('size')
      const cfg = JSON.parse(bytes.toString('utf8'))
      if (cfg.schemaVersion !== 1 || cfg.network !== false || cfg.host !== '127.0.0.1' ||
          cfg.controller?.mode !== 'serve' || cfg.controller?.enabled !== true ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(cfg.controller?.name || '') ||
          !Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535 ||
          realpathSync(cfg.profile) !== profile) throw new Error('configuration')
      const owner = JSON.parse(readFileSync(join(dirname(profile), 'owner.json'), 'utf8'))
      if (owner.version !== 1 || owner.projectId !== cfg.projectId ||
          !/^user-[0-9a-f]{32}$/.test(owner.projectId) ||
          basename(dirname(profile)) !== owner.projectId ||
          realpathSync(owner.manifestPath) !== realpathSync(cfg.manifestPath)) throw new Error('owner')
      if (JSON.parse(readFileSync(owner.manifestPath, 'utf8')).id !== owner.projectId) throw new Error('manifest')
      const relative = path.relative(dirname(realpathSync(owner.manifestPath)), realpathSync(cfg.scene))
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('scene')
      event.returnValue = { schemaVersion: 1, externalPlc: {
        enabled: true, mode: 'serve', port: cfg.port, network: false,
        plcHost: '127.0.0.1', uaServer: false, uaServerNetwork: false,
        // A one-controller OIP project uses the main connection, not a named override.
        controllers: []
      } }
    } catch {
      console.warn('[PLCdev] invalid managed-project bootstrap; original connection settings retained')
      event.returnValue = null
    }
  })
"""
PRELOAD_PATCH = r"""
// Applied once before the app reads its preferences. No renderer API or script execution is added.
try {
  const bootstrap = ipcRenderer.sendSync('plcdev:bootstrap')
  const controller = bootstrap?.externalPlc
  if (bootstrap?.schemaVersion === 1 && Array.isArray(controller?.controllers) &&
      controller.controllers.length === 0 && controller.enabled === true &&
      controller.mode === 'serve' && controller.network === false &&
      controller.plcHost === '127.0.0.1' && Number.isInteger(controller.port) &&
      controller.port >= 1024 && controller.port <= 65535) {
    localStorage.setItem('oip-web/external-plc', JSON.stringify(controller))
  }
} catch {
  console.warn('[PLCdev] managed-project bootstrap was not applied')
}
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_asar(path):
    """Read Chromium Pickle header; packed data offsets are relative to its end."""
    raw = Path(path).read_bytes()
    if len(raw) < 16:
        raise ValueError('Truncated ASAR')
    payload, size, header_payload, text_size = struct.unpack('<IIII', raw[:16])
    if payload != 4 or size != header_payload + 4 or not 0 < text_size <= size - 8 or 8 + size > len(raw):
        raise ValueError('Unsupported ASAR header')
    return json.loads(raw[16:16 + text_size]), raw[8 + size:]


def asar_entry(header, data, name):
    entry = header['files'][name]
    if entry.get('unpacked') or entry.get('link'):
        raise ValueError('Patch target must be a packed file')
    start, size = int(entry['offset']), entry['size']
    value = data[start:start + size]
    if len(value) != size:
        raise ValueError('Truncated patch target')
    return value


def patched_sources(header, data):
    output = {}
    for name, expected in EXPECTED.items():
        original = asar_entry(header, data, name)
        if digest(original) != expected:
            raise ValueError('OIP upstream ' + name + ' changed; review the new version before patching')
        source = original.decode('utf-8')
        anchor = MAIN_ANCHOR if name == 'main.cjs' else PRELOAD_ANCHOR
        if source.count(anchor) != 1:
            raise ValueError('OIP patch anchor is ambiguous')
        replacement = MAIN_PATCH + anchor if name == 'main.cjs' else anchor + '\n' + PRELOAD_PATCH
        patched = source.replace(anchor, replacement)
        if name == 'main.cjs':
            updater = '  updater = setupUpdater({'
            if patched.count(updater) != 1:
                raise ValueError('OIP updater patch anchor is ambiguous')
            # A managed local derivative must not install the vendor's updater
            # over either its pinned copy or the user's original installation.
            patched = patched.replace(updater, "  updater = process.env.OIP_PLCDEV_BOOTSTRAP ? null : setupUpdater({")
        output[name] = patched.encode('utf-8')
    return output


def write_asar(path, header, data, replacements):
    # Append changed files while preserving every unrelated packed offset and unpacked entry.
    header = json.loads(json.dumps(header))
    chunks = [data]
    offset = len(data)
    for name, value in replacements.items():
        block_size = 4 * 1024 * 1024
        entry = header['files'][name]
        entry.update(size=len(value), offset=str(offset), integrity={
            'algorithm': 'SHA256', 'hash': digest(value), 'blockSize': block_size,
            'blocks': [digest(value[i:i + block_size]) for i in range(0, len(value), block_size)],
        })
        chunks.append(value)
        offset += len(value)
    encoded = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    body = struct.pack('<I', len(encoded)) + encoded
    body += b'\0' * (-len(body) % 4)
    pickle_header = struct.pack('<I', len(body)) + body
    temporary = Path(path).with_name(Path(path).name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(struct.pack('<II', 4, len(pickle_header)))
        stream.write(pickle_header)
        for chunk in chunks:
            stream.write(chunk)
    os.replace(temporary, path)


def header_hash(path):
    raw = Path(path).read_bytes()
    length = struct.unpack('<I', raw[12:16])[0]
    return digest(raw[16:16 + length])


def integrity_resource(executable):
    """Read Electron's existing PE resource without loading executable code."""
    if os.name != 'nt':
        raise RuntimeError('Managed OIP packaging currently requires Windows')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_ulong]
    kernel.LoadLibraryExW.restype = ctypes.c_void_p
    kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
    kernel.FindResourceExW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ushort]
    kernel.FindResourceExW.restype = ctypes.c_void_p
    kernel.LoadResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.LoadResource.restype = ctypes.c_void_p
    kernel.SizeofResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.SizeofResource.restype = ctypes.c_ulong
    kernel.LockResource.argtypes = [ctypes.c_void_p]
    kernel.LockResource.restype = ctypes.c_void_p
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_wchar_p,
                                      ctypes.c_wchar_p, ctypes.c_ushort, ctypes.c_void_p)
    kernel.EnumResourceLanguagesW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, callback_type, ctypes.c_void_p]
    module = kernel.LoadLibraryExW(str(executable), None, 0x2 | 0x20)
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        languages = []
        callback = callback_type(lambda _m, _t, _n, language, _p: (languages.append(language), 1)[1])
        if not kernel.EnumResourceLanguagesW(module, 'INTEGRITY', 'ELECTRONASAR', callback, None) or len(languages) != 1:
            raise ValueError('Expected one Electron ASAR integrity resource')
        resource = kernel.FindResourceExW(module, 'INTEGRITY', 'ELECTRONASAR', languages[0])
        size = kernel.SizeofResource(module, resource)
        address = kernel.LockResource(kernel.LoadResource(module, resource))
        if not address or not 0 < size < 65536:
            raise ValueError('Invalid Electron integrity resource')
        return languages[0], json.loads(ctypes.string_at(address, size))
    finally:
        kernel.FreeLibrary(module)


def update_integrity_resource(executable, archive):
    """Refresh the normal Electron packager checksum; integrity enforcement stays on."""
    language, entries = integrity_resource(executable)
    matches = [item for item in entries if item.get('file', '').replace('\\', '/') == 'resources/app.asar']
    if len(matches) != 1 or matches[0].get('alg') != 'SHA256':
        raise ValueError('Unexpected Electron integrity resource format')
    matches[0]['value'] = header_hash(archive)
    encoded = json.dumps(entries, separators=(',', ':')).encode('utf-8')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.BeginUpdateResourceW.argtypes = [ctypes.c_wchar_p, ctypes.c_int]
    kernel.BeginUpdateResourceW.restype = ctypes.c_void_p
    kernel.UpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
                                     ctypes.c_ushort, ctypes.c_void_p, ctypes.c_ulong]
    kernel.EndUpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    handle = kernel.BeginUpdateResourceW(str(executable), False)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        buffer = ctypes.create_string_buffer(encoded)
        if not kernel.UpdateResourceW(handle, 'INTEGRITY', 'ELECTRONASAR', language, buffer, len(encoded)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.EndUpdateResourceW(handle, False):
            raise ctypes.WinError(ctypes.get_last_error())
        handle = None
    finally:
        if handle:
            kernel.EndUpdateResourceW(handle, True)
    if integrity_resource(executable)[1] != entries:
        raise ValueError('Updated Electron integrity resource did not verify')


def read_json(path):
    if Path(path).stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Unexpectedly large project configuration')
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def bootstrap_config(*, profile, ports, scene):
    profile, scene = Path(profile), Path(scene)
    if not profile.is_absolute() or not scene.is_absolute():
        raise ValueError('Managed profile and scene must use absolute paths')
    profile, scene = profile.resolve(), scene.resolve()
    expected_profiles = (ROOT / 'outputs/workbench/integrations').resolve()
    if profile.name != 'oip' or profile.parent.parent != expected_profiles or not re.fullmatch(r'user-[0-9a-f]{32}', profile.parent.name):
        raise ValueError('OIP bootstrap only accepts a workbench-owned project profile')
    owner = read_json(profile.parent / 'owner.json')
    if owner.get('version') != 1 or owner.get('projectId') != profile.parent.name:
        raise ValueError('OIP profile ownership does not match its project')
    manifest = Path(owner.get('manifestPath', ''))
    if not manifest.is_absolute() or manifest.suffix != '.plcdev' or not manifest.is_file():
        raise ValueError('Owned project manifest is missing')
    manifest = manifest.resolve()
    if read_json(manifest).get('id') != owner['projectId']:
        raise ValueError('Owned manifest identity does not match the profile')
    if not scene.is_relative_to(manifest.parent) or scene.name != 'project.json':
        raise ValueError('OIP scene must be inside the owned user project')
    project = read_json(scene)
    scene_relative = project.get('scene')
    if not isinstance(scene_relative, str) or Path(scene_relative).is_absolute():
        raise ValueError('OIP scene reference must be project-relative')
    document = (scene.parent / scene_relative).resolve()
    if not document.is_relative_to(scene.parent):
        raise ValueError('OIP scene reference escapes the project')
    controllers = read_json(document).get('plcs')
    if not isinstance(controllers, list) or len(controllers) != 1:
        raise ValueError('One external PLC controller is required')
    controller = controllers[0]
    name = controller.get('name', '')
    if controller.get('protocol') != 'serve' or controller.get('runsOn') != 'plc' or controller.get('connect') is not True or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', name):
        raise ValueError('Only an explicitly connected Modbus serve controller is supported')
    if not isinstance(ports, dict) or set(ports) != {'fuxa', 'mcp', 'modbus'} or any(type(p) is not int or not 1024 <= p <= 65535 for p in ports.values()) or len(set(ports.values())) != 3:
        raise ValueError('Three distinct non-privileged local ports are required')
    return dict(schemaVersion=1, projectId=owner['projectId'], manifestPath=str(manifest),
                profile=str(profile), scene=str(scene), host='127.0.0.1', port=ports['modbus'],
                network=False, controller={'name': name, 'enabled': True, 'mode': 'serve'})


def install():
    archive = SOURCE / 'resources/app.asar'
    header, data = read_asar(archive)
    version = json.loads(asar_entry(header, data, 'package.json'))['version']
    if version != UPSTREAM_VERSION:
        raise ValueError('OIP installation version changed; review required')
    replacements = patched_sources(header, data)
    patch_hash = digest(str(PATCH_VERSION).encode('ascii') + b''.join(replacements.values()))
    destination = CACHE / (version.replace('.', '') + '-' + patch_hash[:12])
    record_path = destination / 'plcdev-patch.json'
    if destination.exists():
        if not record_path.is_file():
            raise ValueError('An incomplete managed OIP copy exists; preserve it for review')
        record = read_json(record_path)
        installed_header, installed_data = read_asar(destination / 'resources/app.asar')
        if record.get('patchHash') != patch_hash or any(asar_entry(installed_header, installed_data, name) != content for name, content in replacements.items()):
            raise ValueError('Managed OIP copy differs from the reproducible patch')
        entries = integrity_resource(destination / 'Open Industry Project.exe')[1]
        if not any(item.get('file', '').replace('\\', '/') == 'resources/app.asar' and item.get('value') == header_hash(destination / 'resources/app.asar') for item in entries):
            raise ValueError('Managed OIP executable and ASAR integrity do not match')
        return destination / 'Open Industry Project.exe'
    CACHE.mkdir(parents=True, exist_ok=True)
    sources = list(SOURCE.rglob('*'))
    if any(p.is_symlink() for p in sources):
        raise ValueError('Unexpected link in OIP installation')
    required = sum(p.stat().st_size for p in sources if p.is_file())
    if shutil.disk_usage(CACHE).free < required + 160 * 1024 * 1024:
        raise ValueError('Insufficient space for the isolated OIP copy')
    # Never merge or replace a managed installation; a partial copy stays inspectable.
    shutil.copytree(SOURCE, destination, ignore=shutil.ignore_patterns('Uninstall *.exe'))
    write_asar(destination / 'resources/app.asar', header, data, replacements)
    update_integrity_resource(destination / 'Open Industry Project.exe', destination / 'resources/app.asar')
    record_path.write_text(json.dumps({
        'patchVersion': PATCH_VERSION, 'upstreamVersion': version, 'source': str(SOURCE),
        'upstream': EXPECTED, 'patched': {key: digest(value) for key, value in replacements.items()},
        'patchHash': patch_hash, 'scope': 'owned profile loopback bootstrap; no auto Play',
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    return destination / 'Open Industry Project.exe'


def ensure(*, profile: Path, ports: dict, scene: Path) -> Path:
    """Return managed executable; caller supplies user-data-dir and bootstrap environment."""
    configuration = bootstrap_config(profile=profile, ports=ports, scene=scene)
    executable = install()
    profile = Path(configuration['profile'])
    profile.mkdir(parents=True, exist_ok=True)
    target = profile / 'plcdev-bootstrap.json'
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(configuration, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, target)
    return executable
