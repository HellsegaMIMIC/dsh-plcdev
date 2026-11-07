"""Conservative Factory I/O scene entry; no scene switching or process termination.

Official launch contract: Factory IO.exe "load:<absolute .factoryio path>".
Omitting `run` is intentional. A launch request never proves scene identity or
Edit mode: Run Mode Only scenes must still be checked in Factory I/O itself.
"""
from __future__ import annotations
import ast, ctypes, os, threading, time
from pathlib import Path

_PROCESS_CACHE = {}
_PROCESS_LOCK = threading.Lock()


def _processes(executable):
    """Read image identity with Win32, without shell, command lines, or credentials."""
    if os.name != 'nt':
        raise OSError('当前平台不支持 Factory I/O 进程核对')
    from ctypes import wintypes as w
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    class Entry(ctypes.Structure):
        _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ProcessID', w.DWORD),
            ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', w.DWORD), ('cntThreads', w.DWORD),
            ('th32ParentProcessID', w.DWORD), ('pcPriClassBase', w.LONG), ('dwFlags', w.DWORD),
            ('szExeFile', w.WCHAR * 260)]
    api.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]; api.CreateToolhelp32Snapshot.restype = w.HANDLE
    api.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]; api.Process32FirstW.restype = w.BOOL
    api.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]; api.Process32NextW.restype = w.BOOL
    api.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; api.OpenProcess.restype = w.HANDLE
    api.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
    api.QueryFullProcessImageNameW.restype = w.BOOL
    api.GetProcessTimes.argtypes = [w.HANDLE, *([ctypes.POINTER(w.FILETIME)] * 4)]; api.GetProcessTimes.restype = w.BOOL
    api.CloseHandle.argtypes = [w.HANDLE]; api.CloseHandle.restype = w.BOOL
    handle = api.CreateToolhelp32Snapshot(2, 0)
    if not handle or handle == ctypes.c_void_p(-1).value:
        raise OSError('无法核对 Factory I/O 进程')
    result = []; entry = Entry(); entry.dwSize = ctypes.sizeof(Entry)
    expected = os.path.normcase(str(Path(executable).resolve()))
    try:
        more = api.Process32FirstW(handle, ctypes.byref(entry))
        if not more: raise OSError('无法枚举 Factory I/O 进程')
        while more:
            if entry.szExeFile.casefold() == Path(executable).name.casefold():
                item = {'pid': int(entry.th32ProcessID), 'identityKnown': False, 'matchesExecutable': False}
                process = api.OpenProcess(0x1000, False, entry.th32ProcessID)
                if process:
                    try:
                        size = w.DWORD(32768); image = ctypes.create_unicode_buffer(size.value)
                        stamps = [w.FILETIME() for _ in range(4)]
                        if api.QueryFullProcessImageNameW(process, 0, image, ctypes.byref(size)) and api.GetProcessTimes(process, *[ctypes.byref(t) for t in stamps]):
                            item.update(identityKnown=True, matchesExecutable=os.path.normcase(image.value) == expected,
                                createdAtTicks=(stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime)
                    finally: api.CloseHandle(process)
                result.append(item)
            more = api.Process32NextW(handle, ctypes.byref(entry))
        if ctypes.get_last_error() not in (0, 18):
            raise OSError('Factory I/O 进程枚举未完成')
        return result
    finally: api.CloseHandle(handle)


def process_probe(executable, *, cached=True):
    key = str(Path(executable).resolve()); now = time.monotonic()
    with _PROCESS_LOCK:
        old = _PROCESS_CACHE.get(key)
        if cached and old and now - old[0] < 2:
            return {**old[1], 'processes': [dict(p) for p in old[1]['processes']]}
        try: value = {'known': True, 'processes': _processes(executable), 'reason': None}
        except (OSError, ValueError): value = {'known': False, 'processes': [], 'reason': '无法核对 Factory I/O 进程；不会启动可能重复的实例'}
        _PROCESS_CACHE[key] = (now, value)
        return {**value, 'processes': [dict(p) for p in value['processes']]}


def config_paths(executable, *, documents=None):
    supplied_documents = documents is not None
    documents = Path(documents) if supplied_documents else Path.home() / 'Documents'
    if os.name == 'nt' and not supplied_documents:
        from ctypes import wintypes as w
        api = ctypes.WinDLL('shell32', use_last_error=True)
        api.SHGetFolderPathW.argtypes = [w.HWND, ctypes.c_int, w.HANDLE, w.DWORD, w.LPWSTR]
        api.SHGetFolderPathW.restype = ctypes.c_long
        path = ctypes.create_unicode_buffer(32768)
        if api.SHGetFolderPathW(None, 5, None, 0, path) != 0:
            raise OSError('无法核对 Documents 配置目录')
        documents = Path(path.value)
    folders = [Path(executable).parent, Path(os.environ.get('PROGRAMDATA', 'C:/ProgramData')) / 'Real Games/Factory IO', documents / 'Factory IO']
    local = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'Real Games/Factory IO/config.cfg'
    return [local, *[folder / name for folder in folders for name in ('auto.cfg', 'config.cfg')]]


def _attribute(node):
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute):
        parent = _attribute(node.value)
        return parent + '.' + node.attr if parent else None
    return None


def _passive_configuration_call(statement):
    """Factory I/O saves these documented key-binding/window layout commands.

    Matching the exact signature keeps nested calls from executing at startup;
    argument values are never evaluated or returned to the workbench UI.
    """
    if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
        return False
    call=statement.value
    signatures={'input.bind_key':(str,str),'console.set_window':(int,int,int,int)}
    signature=signatures.get(_attribute(call.func))
    if signature is None or call.keywords or len(call.args)!=len(signature):
        return False
    try: values=[ast.literal_eval(argument) for argument in call.args]
    except (ValueError,TypeError,RecursionError): return False
    return all(type(value) is expected for value,expected in zip(values,signature))


def check_configuration(paths):
    """Inspect startup commands as data. Never execute them or expose config text."""
    for path in paths:
        path = Path(path)
        try:
            if not path.exists(): continue
            if path.stat().st_size > 262144:
                return '启动配置过大，无法确认自动运行设置：' + str(path)
            tree = ast.parse(path.read_text(encoding='utf-8-sig'))
        except (OSError, UnicodeError, SyntaxError):
            return '无法核对启动配置；请在 Factory I/O 中检查后再试：' + str(path)
        for statement in tree.body:
            # Saved key bindings/layout and ordinary literal settings do not
            # start a scene. Unknown scripts and computed calls remain explicit.
            if _passive_configuration_call(statement): continue
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
                return '启动配置含未经核对的执行命令；不会改写配置：' + str(path)
            name = _attribute(statement.targets[0])
            if not name or '.' not in name:
                return '启动配置含未经核对的命令：' + str(path)
            try: value = ast.literal_eval(statement.value)
            except (ValueError, TypeError, RecursionError):
                return '启动配置含动态表达式，无法确认不会自动运行：' + str(path)
            if name == 'scene.start_in_run_mode' and value is not False:
                return '启动配置启用了或无法确认自动 Run；请先在 Factory I/O 中关闭：' + str(path)
            if name.startswith('scene.load') or name in ('scene.run', 'scene.running', 'scene.run_mode', 'scene.mode'):
                return '启动配置可能载入其他场景或改变运行状态：' + str(path)
    return None


def preflight(executable, scene, *, occupied_reason=None, cached=True, paths=None, probe=None):
    executable = Path(executable).resolve(); scene = Path(scene).resolve() if scene else None
    process = process_probe(executable, cached=cached) if probe is None else probe
    processes = process.get('processes', [])
    focusable = [p for p in processes if p.get('identityKnown') and p.get('matchesExecutable')]
    can_show = process.get('known', False) and len(processes) == 1 and len(focusable) == 1
    reason = occupied_reason
    if not reason and not executable.is_file(): reason = 'Factory I/O 程序不存在，请检查安装路径'
    if not reason and (not scene or scene.suffix.lower() != '.factoryio' or not scene.is_file()): reason = '工程场景文件缺失或格式不正确'
    if not reason and not process.get('known'): reason = process.get('reason') or 'Factory I/O 进程状态未知'
    if not reason and processes: reason = 'Factory I/O 已打开；请先保存并自行关闭，再打开当前工程场景。可以只显示现有窗口。'
    if not reason:
        try: reason = check_configuration(config_paths(executable) if paths is None else paths)
        except (OSError, ValueError): reason = '无法核对 Factory I/O 启动配置；未打开场景'
    show_reason = None if can_show else ('尚未打开 Factory I/O' if process.get('known') and not processes else '既有 Factory I/O 进程身份不明确；请自行切换到窗口')
    return {'canOpenFactoryScene': reason is None, 'canShowFactory': bool(can_show),
        'reasons': {'canOpenFactoryScene': reason, 'canShowFactory': show_reason},
        'sceneTarget': str(scene) if scene else None, 'processRunning': bool(processes) if process.get('known') else None,
        'processes': processes, 'argv': [str(executable), 'load:' + str(scene)] if scene else None,
        'sceneIdentityVerified': False, 'runModeVerified': False}


def show_existing(executable, expected):
    """Restore one verified existing process, never load, run, or stop its scene."""
    current = process_probe(executable, cached=False)
    matches = [p for p in current['processes'] if p.get('identityKnown') and p.get('matchesExecutable')
        and p.get('pid') == expected.get('pid') and p.get('createdAtTicks') == expected.get('createdAtTicks')]
    if not current['known'] or len(current['processes']) != 1 or len(matches) != 1:
        raise ValueError('Factory I/O 实例已改变；未操作窗口，请刷新后重试')
    from ctypes import wintypes as w
    api = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    api.EnumWindows.argtypes = [callback_type, w.LPARAM]; api.EnumWindows.restype = w.BOOL
    api.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]; api.GetWindowThreadProcessId.restype = w.DWORD
    api.IsWindowVisible.argtypes = [w.HWND]; api.IsWindowVisible.restype = w.BOOL
    api.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]; api.GetClassNameW.restype = ctypes.c_int
    api.ShowWindowAsync.argtypes = [w.HWND, ctypes.c_int]; api.ShowWindowAsync.restype = w.BOOL
    api.SetForegroundWindow.argtypes = [w.HWND]; api.SetForegroundWindow.restype = w.BOOL
    windows = []
    @callback_type
    def match(window, _):
        pid = w.DWORD(); api.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if pid.value == expected['pid'] and api.IsWindowVisible(window):
            name = ctypes.create_unicode_buffer(128); api.GetClassNameW(window, name, len(name))
            windows.append((name.value == 'UnityWndClass', window))
        return True
    api.EnumWindows(match, 0)
    if not windows: raise ValueError('Factory I/O 进程存在，但可显示窗口尚未就绪；未启动重复实例')
    window = sorted(windows, key=lambda item: item[0], reverse=True)[0][1]
    if not api.ShowWindowAsync(window, 9): raise ValueError('Factory I/O 窗口显示请求失败；未启动重复实例')
    return bool(api.SetForegroundWindow(window))
