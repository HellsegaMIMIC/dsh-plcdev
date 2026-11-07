"""Read-only, conservative process snapshot; no project/session mutations.

Only known OpenPLC/Electron executable names are covered. Absence of matches
does not prove no renamed editor or unobserved unsaved state exists, and a
snapshot is not a lock. No-match or failure remains unknown (fail closed).
"""
from __future__ import annotations
import ctypes, os, re, time
from ctypes import wintypes

class ObservationError(RuntimeError): pass

class ProcessEntry(ctypes.Structure):
    _fields_=[('dwSize',wintypes.DWORD),('cntUsage',wintypes.DWORD),('th32ProcessID',wintypes.DWORD),
              ('th32DefaultHeapID',ctypes.c_size_t),('th32ModuleID',wintypes.DWORD),('cntThreads',wintypes.DWORD),
              ('th32ParentProcessID',wintypes.DWORD),('pcPriClassBase',wintypes.LONG),('dwFlags',wintypes.DWORD),('szExeFile',wintypes.WCHAR*260)]

def windows_process_names():
    if os.name!='nt':raise ObservationError('仅 Windows 支持此观察器')
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CreateToolhelp32Snapshot.argtypes=[wintypes.DWORD,wintypes.DWORD];api.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
    for name in ('Process32FirstW','Process32NextW'):
        fn=getattr(api,name);fn.argtypes=[wintypes.HANDLE,ctypes.POINTER(ProcessEntry)];fn.restype=wintypes.BOOL
    api.CloseHandle.argtypes=[wintypes.HANDLE];api.CloseHandle.restype=wintypes.BOOL
    handle=api.CreateToolhelp32Snapshot(2,0)
    if handle in (None,0,ctypes.c_void_p(-1).value):raise ObservationError('无法获取进程快照')
    try:
        entry=ProcessEntry();entry.dwSize=ctypes.sizeof(entry);ctypes.set_last_error(0)
        if not api.Process32FirstW(handle,ctypes.byref(entry)):raise ObservationError('无法读取进程快照')
        result=[]
        while True:
            name=entry.szExeFile
            if not name or len(name)>=260:raise ObservationError('进程名称不完整')
            result.append(name)
            if len(result)>131072:raise ObservationError('进程快照超过安全范围')
            ctypes.set_last_error(0)
            if not api.Process32NextW(handle,ctypes.byref(entry)):
                if ctypes.get_last_error()!=18:raise ObservationError('进程快照不完整')
                return result
    finally:api.CloseHandle(handle)

def suspicious_editor_name(name):
    if not isinstance(name,str) or not name or '\x00' in name or '/' in name or '\\' in name or len(name)>=260:
        raise ObservationError('进程名称无效')
    normal=re.sub(r'[^a-z0-9]','',name.casefold())
    if not normal:raise ObservationError('进程名称无法判定')
    return 'openplc' in normal or 'electron' in normal

def observe_editor_states(project, *, process_names=None):
    """Observe all known editor process names; callable override is test-only."""
    try:
        names=(process_names or windows_process_names)()
        if not isinstance(names,(list,tuple)) or not names:raise ObservationError('进程快照为空')
        # Validate every name even if an earlier one was already suspicious.
        matching=[suspicious_editor_name(name) for name in names]
        if any(matching):state={'verified':True,'editState':'busy','reason':'存在 OpenPLC 或 Electron 进程；其工程及未保存状态无法确认。'}
        else:state={'verified':False,'editState':'unknown','reason':'完整快照未见已知 OpenPLC/Electron 进程，但不能排除改名的编辑器或中途启动；仍不能确认未保存状态。','knownProcessesPresent':False}
    except (OSError,ObservationError,AttributeError,ValueError,TypeError,OverflowError):
        state={'verified':False,'editState':'unknown','reason':'未能完整核验进程；不能确认未保存状态。'}
    state['observedAt']=time.time()
    return {'openplc':state}
