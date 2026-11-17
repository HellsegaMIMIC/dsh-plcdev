"""Bounded, read-only modification times for registered saved engineering sources."""
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
import json
import os
import stat
import threading
import time

SOURCE_ENTRIES = ('project.json', 'library.json', 'pous', 'datatypes', 'devices', 'servers')
IGNORED = {'build', 'outputs', 'node_modules', '__pycache__'}
MAX_ENTRIES = 4096
MAX_PROJECT_JSON = 1024 * 1024


def saved_project_modified_at(project, *, limit=MAX_ENTRIES):
    """Return UTC ISO time or None, never an index/open/session timestamp.

    Inspect source metadata only: the manifest, supported PLC source entries,
    HMI, interface declaration, and OIP's explicit source/package references.
    Missing required sources, inaccessible entries, links or a scan limit make
    the result unknown rather than presenting a partial maximum as complete.
    """
    latest = 0
    visited = 0
    enumerated = 0
    seen = set()

    def inspect(path, root, optional=False):
        nonlocal latest, visited, enumerated
        path, root = Path(path), Path(root)
        if not path.is_absolute() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('source path outside declared root')
        # Check each component before reading descendants or JSON references.
        chain = [path]
        while chain[-1] != root and chain[-1].parent != chain[-1]:
            chain.append(chain[-1].parent)
        for component in reversed(chain):
            try:
                info = component.lstat()
            except FileNotFoundError:
                if optional and component == path:
                    return
                raise
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('linked source entry')
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        visited += 1
        if visited > limit:
            raise ValueError('source metadata limit')
        info = path.stat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError('unsupported source entry')
        if info.st_mtime_ns <= 0:
            raise ValueError('unknown source time')
        latest = max(latest, info.st_mtime_ns)
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(path) as entries:
                for entry in entries:
                    enumerated += 1
                    if enumerated > limit:
                        raise ValueError('source metadata limit')
                    if entry.name.startswith('.') or entry.name.lower() in IGNORED:
                        continue
                    inspect(Path(entry.path), root)

    def relative(root, value):
        if (not isinstance(value, str) or not value or PureWindowsPath(value).drive
                or value.startswith(('/', '\\'))):
            raise ValueError('invalid relative source')
        path = root / value.replace('\\', '/')
        if not path.resolve().is_relative_to(root.resolve()) or path.resolve() == root.resolve():
            raise ValueError('source reference outside root')
        return path

    try:
        plc_value = project.get('plc')
        if not isinstance(plc_value, str) or not Path(plc_value).is_absolute():
            return None
        plc = Path(plc_value)
        inspect(plc, plc.parent)
        for name in SOURCE_ENTRIES:
            if name != plc.name:
                inspect(plc.parent / name, plc.parent, optional=True)
        manifest = project.get('manifestPath')
        if manifest:
            inspect(Path(manifest), Path(manifest).parent)
        if project.get('hmi'):
            hmi = Path(project['hmi'])
            inspect(hmi, hmi.parent)
        if project.get('bindingsPath'):
            bindings = Path(project['bindingsPath'])
            inspect(bindings, bindings.parent)
        configuration = project.get('configuration') or {}
        if not isinstance(configuration, dict):
            return None
        interface = configuration.get('interfaceFile')
        if interface:
            if not manifest:
                return None
            root = Path(manifest).parent
            inspect(relative(root, interface), root)
        if project.get('scene'):
            scene = Path(project['scene'])
            inspect(scene, scene.parent)
            if scene.name == 'project.json':
                if scene.stat().st_size > MAX_PROJECT_JSON:
                    return None
                raw = json.loads(scene.read_text(encoding='utf-8-sig'))
                if not isinstance(raw, dict):
                    return None
                references = [raw.get('scene')]
                for key in ('program', 'tests', 'packages'):
                    values = raw.get(key, [])
                    if not isinstance(values, list) or len(values) > limit:
                        return None
                    references.extend(values)
                for value in references:
                    inspect(relative(scene.parent, value), scene.parent)
        return datetime.fromtimestamp(latest / 1_000_000_000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z') if latest else None
    except (OSError, ValueError, TypeError, OverflowError, RuntimeError):
        return None


class ProjectModificationCache:
    """Avoid repeating bounded source stats on fast status polling; no disk writes."""
    def __init__(self, ttl=5):
        self.ttl = ttl
        self.entries = {}
        self.lock = threading.Lock()

    def get(self, project):
        key = json.dumps({name: project.get(name) for name in
                          ('id', 'plc', 'hmi', 'scene', 'manifestPath', 'bindingsPath', 'configuration')}, sort_keys=True)
        now = time.monotonic()
        with self.lock:
            cached = self.entries.get(key)
            if cached and now - cached[0] < self.ttl:
                return cached[1]
            value = saved_project_modified_at(project)
            self.entries = {k: v for k, v in self.entries.items() if now - v[0] < self.ttl}
            self.entries[key] = (now, value)
            return value
