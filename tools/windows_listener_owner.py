"""Read-only Windows TCP listener ownership without PowerShell or WMI."""
import ctypes,os,socket,struct
from ctypes import wintypes


def parse_listeners(data,port):
    if len(data)<4:raise ValueError('Invalid TCP listener table')
    count=struct.unpack_from('<I',data)[0]
    if count>(len(data)-4)//24:raise ValueError('Truncated TCP listener table')
    loopback=struct.unpack('<I',socket.inet_aton('127.0.0.1'))[0]
    result=set()
    for index in range(count):
        state,local,address_port,remote,remote_port,pid=struct.unpack_from('<6I',data,4+index*24)
        if state==2 and local==loopback and socket.ntohs(address_port&65535)==port:result.add(pid)
    return result


def listener_pids(port):
    if os.name!='nt':raise OSError('Windows process inspection is required')
    if type(port) is not int or not 1024<=port<=65535:raise ValueError('Invalid local TCP port')
    api=ctypes.WinDLL('iphlpapi',use_last_error=True)
    api.GetExtendedTcpTable.argtypes=[ctypes.c_void_p,ctypes.POINTER(wintypes.DWORD),wintypes.BOOL,wintypes.ULONG,ctypes.c_int,wintypes.ULONG]
    api.GetExtendedTcpTable.restype=wintypes.DWORD
    size=wintypes.DWORD(0)
    code=api.GetExtendedTcpTable(None,ctypes.byref(size),False,2,3,0) # AF_INET / OWNER_PID_LISTENER
    if code not in (0,122):raise OSError('TCP listener inspection failed')
    for _ in range(3):
        if not 4<=size.value<=32*1024*1024:raise OSError('Invalid TCP listener table size')
        buffer=ctypes.create_string_buffer(size.value)
        code=api.GetExtendedTcpTable(buffer,ctypes.byref(size),False,2,3,0)
        if code==0:return parse_listeners(buffer.raw[:size.value],port)
        if code!=122:break
    raise OSError('TCP listener inspection did not complete')


def process_parents():
    if os.name!='nt':raise OSError('Windows process inspection is required')
    class ProcessEntry(ctypes.Structure):
        _fields_=[('dwSize',wintypes.DWORD),('cntUsage',wintypes.DWORD),('th32ProcessID',wintypes.DWORD),
                  ('th32DefaultHeapID',ctypes.c_size_t),('th32ModuleID',wintypes.DWORD),('cntThreads',wintypes.DWORD),
                  ('th32ParentProcessID',wintypes.DWORD),('pcPriClassBase',wintypes.LONG),('dwFlags',wintypes.DWORD),('szExeFile',wintypes.WCHAR*260)]
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CreateToolhelp32Snapshot.argtypes=[wintypes.DWORD,wintypes.DWORD];api.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
    for name in ('Process32FirstW','Process32NextW'):
        function=getattr(api,name);function.argtypes=[wintypes.HANDLE,ctypes.POINTER(ProcessEntry)];function.restype=wintypes.BOOL
    api.CloseHandle.argtypes=[wintypes.HANDLE];api.CloseHandle.restype=wintypes.BOOL
    handle=api.CreateToolhelp32Snapshot(2,0) # TH32CS_SNAPPROCESS
    if handle==ctypes.c_void_p(-1).value or not handle:raise OSError('Process snapshot failed')
    try:
        entry=ProcessEntry();entry.dwSize=ctypes.sizeof(entry)
        if not api.Process32FirstW(handle,ctypes.byref(entry)):raise OSError('Process snapshot unavailable')
        parents={}
        while True:
            parents[int(entry.th32ProcessID)]=int(entry.th32ParentProcessID)
            if not api.Process32NextW(handle,ctypes.byref(entry)):
                if ctypes.get_last_error()!=18:raise OSError('Process snapshot incomplete')
                return parents
    finally:api.CloseHandle(handle)


def all_descend_from(listeners,parents,root_pid):
    if not listeners or root_pid not in parents:return False
    for pid in listeners:
        seen=set()
        while pid!=root_pid:
            if not pid or pid in seen or len(seen)>=64 or pid not in parents:return False
            seen.add(pid);pid=parents[pid]
    return True


def listener_descends_from(port,root_pid):
    if type(root_pid) is not int or root_pid<=0:raise ValueError('Invalid tool process identity')
    listeners=listener_pids(port)
    return all_descend_from(listeners,process_parents(),root_pid) if listeners else False
