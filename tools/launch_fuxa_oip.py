"""Local owned launcher for the FUXA/OpenPLC/OIP example. Never auto-RUNs PLC or scene."""
from __future__ import annotations
from pathlib import Path
import argparse, ctypes, hashlib, json, os, shutil, socket, subprocess, sys, time, uuid, webbrowser
from urllib.request import Request, urlopen
from factoryio_runtime import ROOT, store
from plcdev_environment import tool_path
from plcdev_runtime_owner import FileLease, owner
from fuxa_oip_session import prepare, validate_device
from oip_batch_mcp import call as call_oip

HOME=ROOT/'outputs/fuxa-oip/launcher'
ACTIVE=HOME/'active.json'
OIP_RECORD=ROOT/'outputs/oip-batch/launch.json'
PROFILE=ROOT/'outputs/fuxa/profile'
PROJECT=ROOT/'software/fuxa-oip/plc/project'
DEVICE=ROOT/'software/oip-batch/io-mapping.json'
SCENE=ROOT/'software/oip-batch/ContinuousBatch'
EDITOR=tool_path('editor')
OIP_EXE=tool_path('oipExecutable')
NO_WINDOW=getattr(subprocess,'CREATE_NO_WINDOW',0)


def read(path,fallback=None):
    try:return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError,ValueError):return fallback


def identity(pid):
    """PID + creation time + image path prevents stopping a recycled PID."""
    if os.name!='nt':raise RuntimeError('This desktop launcher currently supports Windows only')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    kernel.QueryFullProcessImageNameW.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_ulong)]
    kernel.GetProcessTimes.argtypes=[ctypes.c_void_p]+[ctypes.c_void_p]*4
    kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
    handle=kernel.OpenProcess(0x1000,False,int(pid))
    if not handle:
        if ctypes.get_last_error() in (87,1168):return None
        raise OSError('Unable to verify the recorded process identity')
    try:
        code=ctypes.c_ulong()
        if not kernel.GetExitCodeProcess(handle,ctypes.byref(code)):raise ctypes.WinError(ctypes.get_last_error())
        if code.value!=259:return None
        size=ctypes.c_ulong(32768);image=ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle,0,image,ctypes.byref(size)):raise ctypes.WinError(ctypes.get_last_error())
        times=[ctypes.c_ulonglong() for _ in range(4)]
        if not kernel.GetProcessTimes(handle,*[ctypes.byref(value) for value in times]):raise ctypes.WinError(ctypes.get_last_error())
        return {'pid':int(pid),'executable':str(Path(image.value).resolve()),'createdFileTime':times[0].value}
    finally:kernel.CloseHandle(handle)


def same_process(record):
    return bool(record and identity(record['pid'])==record)


def open_port(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.2):return True
    except OSError:return False


def stop_marker(record):return HOME/(record['ticket']+'.stop')


def command_line_args(command):
    shell=ctypes.WinDLL('shell32',use_last_error=True);kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    shell.CommandLineToArgvW.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype=ctypes.POINTER(ctypes.c_wchar_p);kernel.LocalFree.argtypes=[ctypes.c_void_p]
    count=ctypes.c_int();argv=shell.CommandLineToArgvW(command,ctypes.byref(count))
    if not argv:raise ctypes.WinError(ctypes.get_last_error())
    try:return [argv[index] for index in range(count.value)]
    finally:kernel.LocalFree(argv)


def has_profile(argv,expected):
    for index,arg in enumerate(argv):
        value=arg[len('--user-data-dir='):] if arg.startswith('--user-data-dir=') else argv[index+1] if arg=='--user-data-dir' and index+1<len(argv) else None
        if value and Path(value).resolve()==Path(expected).resolve():return True
    return False


class OwnedJob:
    """All NEW children inherit this job; reused OIP processes never join it."""
    def __init__(self):
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        class Basic(ctypes.Structure):
            _fields_=[('ProcessTime',ctypes.c_longlong),('JobTime',ctypes.c_longlong),('Flags',ctypes.c_ulong),
                      ('MinWorking',ctypes.c_size_t),('MaxWorking',ctypes.c_size_t),('ActiveLimit',ctypes.c_ulong),
                      ('Affinity',ctypes.c_size_t),('Priority',ctypes.c_ulong),('Scheduling',ctypes.c_ulong)]
        class IO(ctypes.Structure):_fields_=[(name,ctypes.c_ulonglong) for name in ['ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes']]
        class Extended(ctypes.Structure):
            _fields_=[('Basic',Basic),('IO',IO),('ProcessMemory',ctypes.c_size_t),('JobMemory',ctypes.c_size_t),('PeakProcess',ctypes.c_size_t),('PeakJob',ctypes.c_size_t)]
        kernel.CreateJobObjectW.restype=ctypes.c_void_p;kernel.GetCurrentProcess.restype=ctypes.c_void_p
        kernel.SetInformationJobObject.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p,ctypes.c_ulong]
        kernel.AssignProcessToJobObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
        self.handle=kernel.CreateJobObjectW(None,None)
        info=Extended();info.Basic.Flags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not kernel.SetInformationJobObject(self.handle,9,ctypes.byref(info),ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(self.handle,kernel.GetCurrentProcess()):raise ctypes.WinError(ctypes.get_last_error())
        # Keep this handle until supervisor process exit, after durable cleanup state.


def ai_arguments(enabled=False,helper_json=None):
    if helper_json is not None and not enabled:raise ValueError('AI helper requires explicit --enable-approved-ai; default is disabled')
    if not enabled:return []
    if helper_json is None:return ['--enable-approved-ai']
    try:helper=json.loads(helper_json)
    except (TypeError,ValueError):raise ValueError('--ai-helper-argv must be a nonempty JSON array of argument strings') from None
    if not isinstance(helper,list) or not helper or any(not isinstance(item,str) or not item or '\0' in item for item in helper):
        raise ValueError('--ai-helper-argv must be a nonempty JSON array of argument strings')
    return ['--enable-approved-ai','--ai-helper-argv',json.dumps(helper,ensure_ascii=False)]


def launch_plan(run,port=18810,ai_args=None):
    if type(port) is not int or not 1024<=port<=65535:raise ValueError('Invalid FUXA loopback port')
    run=Path(run).resolve();family=(ROOT/'outputs/editor-runtime').resolve()
    if not run.is_relative_to(family) or not run.name.startswith('fuxa-oip-'):raise ValueError('An independent FUXA/OIP session directory is required')
    return {'runtime':[sys.executable,'-B','-X','utf8',str(ROOT/'tools/fuxa_oip_session.py'),'run','--run-directory',str(run),'--parent-pid',str(os.getpid())],
            'fuxa':[sys.executable,'-B','-X','utf8',str(ROOT/'tools/run_fuxa.py'),'--profile',str(PROFILE),'--session-file',str(run/'session.json'),'--port',str(port),*(ai_args or [])],
            'home':'http://127.0.0.1:'+str(port)+'/home','editor':'http://127.0.0.1:'+str(port)+'/editor'}


def expected_epoch(manifest):
    encoded=json.dumps([manifest['sessionId'],manifest['programHash'],manifest['batchHttpPort']],separators=(',',':')).encode()
    return hashlib.sha256(encoded).hexdigest()[:24]


def ai_preference(initial=False):
    """Report the saved user preference, not provider/network availability."""
    path=PROFILE/'plcdev/ai-settings.json'
    try:preference=json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:return bool(initial)
    except (OSError,ValueError):return False
    if not isinstance(preference,dict) or type(preference.get('version')) is not int or preference['version']!=1 or type(preference.get('enabled')) is not bool:return False
    return preference['enabled']


def summary(record):
    if not record:return {'active':False,'phase':'not-started'}
    alive=same_process(record.get('supervisor'))
    state=read(Path(record['runDirectory'])/'state.json',{})
    fresh=0<=time.time()-state.get('observedAt',0)<2
    return {'active':alive,'phase':record.get('phase'),'runDirectory':record['runDirectory'],
            'runtimeState':state.get('runtimeState','UNKNOWN') if fresh and alive else 'UNKNOWN',
            'home':record['home'],'editor':record['editor'],'aiEnabled':ai_preference(record.get('aiEnabled',False)),
            'note':record.get('note',''),'log':record.get('log'),'error':record.get('error')}


def ensure_oip(record,log):
    declaration=read(OIP_RECORD,{})
    profile=Path(declaration.get('profile',ROOT/'outputs/oip-batch/profile')).resolve()
    if profile!=(ROOT/'outputs/oip-batch/profile').resolve():raise ValueError('OIP launcher profile differs from the reviewed isolated profile')
    mapping=validate_device(read(DEVICE))
    if mapping['modbus']['port']!=5020 or mapping['mcp']['port']!=15190:raise ValueError('Daily launch requires direct OIP ports 5020 / 15190, without a fault proxy')
    if open_port(15190):
        known=identity(declaration.get('pid',0)) if declaration.get('pid') else None
        if not known or Path(known['executable'])!=OIP_EXE.resolve():raise RuntimeError('MCP 15190 is already occupied; no existing application was modified')
        # This one recorded OIP PID may be reused, but never terminated. Verify its profile.
        script=f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId = {known['pid']}'\n$owners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 15190 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)\n[pscustomobject]@{{command=$p.CommandLine;owners=$owners}} | ConvertTo-Json -Compress"
        observed=json.loads(subprocess.check_output(['powershell','-NoProfile','-NonInteractive','-Command',script],text=True,creationflags=NO_WINDOW))
        if known['pid'] not in observed['owners'] or not has_profile(command_line_args(observed['command']),profile):raise RuntimeError('Existing OIP endpoint and isolated profile could not be confirmed')
        scene=call_oip('get_scene',port=15190,timeout=2)
        if scene.get('project')!=mapping['scene']['project']:raise RuntimeError('Existing OIP has another project open; select the batch project explicitly before launching')
        if scene.get('running') is not False:raise RuntimeError('Existing OIP scene is running or unknown; stop it explicitly before launching this combination')
        record['oip']={'process':known,'owned':False,'profile':str(profile)}
        return
    if declaration.get('pid') and identity(declaration['pid']):raise RuntimeError('Recorded OIP instance is alive but MCP is unavailable; no duplicate instance was started')
    if not OIP_EXE.is_file():raise FileNotFoundError('OIP installation not found: '+str(OIP_EXE))
    env=dict(os.environ,OIP_MCP_PORT='15190')
    child=subprocess.Popen([str(OIP_EXE),'--user-data-dir='+str(profile),str(SCENE)],env=env,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
    record['oip']={'process':identity(child.pid),'owned':True,'profile':str(profile)}
    store(OIP_RECORD,{'profile':str(profile),'pid':child.pid,'started':time.time(),'mcpPort':15190,'modbusPort':5020})
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        if stop_marker(record).exists():raise RuntimeError('Launch was cancelled before the OIP project became ready')
        if child.poll() is not None:raise RuntimeError('The isolated OIP process exited during startup')
        try:
            scene=call_oip('get_scene',port=15190,timeout=1)
            if scene.get('project')==mapping['scene']['project'] and scene.get('running') is False:return
        except (OSError,RuntimeError,ValueError):pass
        time.sleep(.25)
    raise RuntimeError('OIP did not confirm the expected stopped project; inspect any native Open-project prompt')


def start(args):
    if os.name!='nt':raise RuntimeError('This launcher is currently Windows-only')
    ai_args=ai_arguments(args.enable_approved_ai,args.ai_helper_argv)
    HOME.mkdir(parents=True,exist_ok=True)
    with FileLease(HOME/'launch.lock'):
        previous=read(ACTIVE)
        if previous and same_process(previous.get('supervisor')):
            if previous.get('phase')=='ready' and not args.no_browser:webbrowser.open(previous['home'])
            return {**summary(previous),'reused':True}
        if owner():raise RuntimeError('Another PLCdev Runtime owns the shared target. End it from its own entry; nothing was stopped.')
        if open_port(args.port):raise RuntimeError('FUXA port is already occupied. Existing processes were left intact.')
        for key in ('runtime','fuxa'):
            if previous and same_process(previous.get(key)):raise RuntimeError('A previously managed child still exists; inspect the old launch log before creating a new combination')
        ticket=uuid.uuid4().hex
        run=ROOT/'outputs/editor-runtime'/('fuxa-oip-'+time.strftime('%Y%m%d-%H%M%S')+'-'+ticket[:6])
        plan=launch_plan(run,args.port,ai_args);log_path=HOME/(ticket+'.log')
        record={'version':1,'ticket':ticket,'phase':'starting','runDirectory':str(run),'port':args.port,
                'home':plan['home'],'editor':plan['editor'],'log':str(log_path),'aiEnabled':bool(ai_args),'aiArguments':ai_args,
                'noBrowser':args.no_browser,'createdAt':time.time(),'note':'PLC and OIP remain stopped until explicit user actions'}
        with log_path.open('ab') as log:
            child=subprocess.Popen([sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'_serve','--ticket',ticket],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        record['supervisor']=identity(child.pid);store(ACTIVE,record)
        return {**summary(record),'reused':False}


def serve(ticket):
    record=None
    for _ in range(100):
        candidate=read(ACTIVE)
        if candidate and candidate.get('ticket')==ticket and candidate.get('supervisor',{}).get('pid')==os.getpid():record=candidate;break
        time.sleep(.05)
    if not record:raise RuntimeError('A matching pending launcher ticket is required')
    job=OwnedJob();children={};run=Path(record['runDirectory']);ended_normally=False
    try:
        record['phase']='preparing';store(ACTIVE,record)
        with open(record['log'],'ab',buffering=0) as log:
            ensure_oip(record,log);store(ACTIVE,record)
            if stop_marker(record).exists():ended_normally=True;return
            prepare(argparse.Namespace(run_directory=run,project_directory=PROJECT,device_config=DEVICE,
                project_id='fuxa-oip-batch',project_name='FUXA / OIP 批次计数',compile=True,editor=EDITOR))
            if stop_marker(record).exists():ended_normally=True;return
            plan=launch_plan(run,record['port'],record['aiArguments'])
            children['runtime']=subprocess.Popen(plan['runtime'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            record['runtime']=identity(children['runtime'].pid);store(ACTIVE,record)
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                if children['runtime'].poll() is not None:raise RuntimeError('Owned Runtime exited while preparing')
                state=read(run/'state.json',{})
                if state.get('ready') and state.get('runtimeState')=='STOPPED':break
                time.sleep(.1)
            else:raise RuntimeError('Runtime did not confirm ready / STOPPED')
            manifest=read(run/'session.json')
            children['fuxa']=subprocess.Popen(plan['fuxa'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            record['fuxa']=identity(children['fuxa'].pid);store(ACTIVE,record)
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                if children['fuxa'].poll() is not None:raise RuntimeError('Owned FUXA exited during startup')
                try:
                    with urlopen('http://127.0.0.1:'+str(record['port'])+'/plcdev/context',timeout=1) as response:context=json.load(response)
                    if context.get('ok') and context.get('epoch')==expected_epoch(manifest):break
                except (OSError,ValueError):pass
                time.sleep(.2)
            else:raise RuntimeError('FUXA did not confirm this session identity')
            record['phase']='ready';record['readyAt']=time.time();store(ACTIVE,record)
            if not record['noBrowser']:webbrowser.open(record['home'])
            while not stop_marker(record).exists():
                if children['runtime'].poll() is not None or children['fuxa'].poll() is not None:
                    raise RuntimeError('An owned Runtime/FUXA process exited; this combination is ending')
                time.sleep(.25)
            ended_normally=True
    except Exception as exc:
        if stop_marker(record).exists():ended_normally=True
        else:record['error']=str(exc)
    finally:
        record['phase']='stopping';store(ACTIVE,record)
        runtime=children.get('runtime')
        if runtime and runtime.poll() is None:
            (run/'stop.request').write_text('owned combination ended\n',encoding='utf-8')
            try:runtime.wait(timeout=22)
            except subprocess.TimeoutExpired:record['error']='Owned Runtime did not finish graceful cleanup; the owned process job will close'
        if runtime:record['runtimeExitCode']=runtime.poll()
        # Only children created in this supervisor's Windows Job are closed at exit.
        # An existing OIP instance, any other Runtime, and unrelated applications remain untouched.
        record['phase']='ended' if ended_normally and not record.get('error') else 'failed'
        record['endedAt']=time.time();store(ACTIVE,record)
    return record


def owned_record():
    record=read(ACTIVE)
    if not record or not same_process(record.get('supervisor')):raise RuntimeError('No live combination owned by this launcher')
    return record


def stop():
    record=owned_record();run=Path(record['runDirectory'])
    stop_marker(record).write_text('user ended owned combination\n',encoding='utf-8')
    deadline=time.monotonic()+28
    while time.monotonic()<deadline:
        current=read(ACTIVE,record)
        if current.get('ticket')!=record['ticket']:raise RuntimeError('Launcher identity changed; no other session was touched')
        if not same_process(record['supervisor']):return summary(current)
        time.sleep(.1)
    raise RuntimeError('Owned launcher is still cleaning up; no unrelated process was terminated')


def management(kind):
    record=owned_record()
    if record.get('phase')!='ready':raise RuntimeError('The combination is not ready')
    run=Path(record['runDirectory']);manifest=read(run/'session.json')
    with FileLease(HOME/'management.lock'):
        counter=read(run/'launcher-sequence.json',{'sequence':0})['sequence']+1
        store(run/'launcher-sequence.json',{'sequence':counter})
        body={'kind':kind,'value':0,'program':manifest['programHash'],'sequence':counter,'expires':time.time()+4.5}
        request=Request('http://127.0.0.1:'+str(manifest['batchHttpPort'])+'/management',data=json.dumps(body).encode(),
                        headers={'Content-Type':'application/json','X-PLCdev-Session':manifest['sessionId'],'X-PLCdev-Client':'launcher'})
        with urlopen(request,timeout=6) as response:return json.load(response)


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='action',required=True)
    begin=sub.add_parser('start');begin.add_argument('--port',type=int,default=18810);begin.add_argument('--no-browser',action='store_true')
    begin.add_argument('--enable-approved-ai',action='store_true');begin.add_argument('--ai-helper-argv')
    for action in ('status','stop','plc-run','plc-stop'):sub.add_parser(action)
    internal=sub.add_parser('_serve');internal.add_argument('--ticket',required=True)
    args=parser.parse_args()
    try:
        if args.action=='start':result=start(args)
        elif args.action=='status':result=summary(read(ACTIVE))
        elif args.action=='stop':result=stop()
        elif args.action=='_serve':result=serve(args.ticket)
        else:result=management(9 if args.action=='plc-run' else 10)
        if args.action!='_serve':print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc)},ensure_ascii=False),file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
