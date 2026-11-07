"""PLCdev workbench: project-scoped views and commands, explicit session ownership."""
from __future__ import annotations
import argparse, json, os, secrets, socket, subprocess, sys, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib import request, parse, error

from factoryio_runtime import ROOT, RUNTIME, MSYS, store, sha
from plcdev_environment import tool_path
from plcdev_runtime_owner import FileLease, owner, LOCK as RUNTIME_LOCK
from workbench_factoryio import preflight as factory_preflight, show_existing as show_factory_window
from workbench_projects import DEFAULT_PROJECT_ID, PROJECTS, ProjectCatalog

HOME = Path(os.environ.get('PLCDEV_WORKBENCH_HOME',str(ROOT/'outputs/workbench'))).resolve()
DESCRIPTOR = HOME/'controller.json'
SOURCE = ROOT/'software/hmi-batch'
PAGE = ROOT/'software/workbench/index.html'
EDITOR = tool_path('editor')
FALLBACK_EDITOR = EDITOR
EEZ = ROOT/'outputs/eez-studio-zh/EEZ-Studio-ZH-r4-20261026/EEZ Studio.exe'
FACTORY = Path(r'D:\Program Files\FactoryIO\Factory IO.exe')
PROJECT_ID = 'batch-conveyor'
BATCH_PROJECT = PROJECTS.get(PROJECT_ID)
HMI = Path(BATCH_PROJECT['hmiExecutable']) if BATCH_PROJECT else None
PROJECT = Path(BATCH_PROJECT['plc']).parent if BATCH_PROJECT else None
SCENE = Path(BATCH_PROJECT['scene']) if BATCH_PROJECT else None
HMI_PROJECT = Path(BATCH_PROJECT['hmi']) if BATCH_PROJECT else None
HMI_BUILD = Path(BATCH_PROJECT['hmiBuild']) if BATCH_PROJECT else None
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

def env():
    return {k:v for k,v in os.environ.items() if not k.upper().startswith(('OPENPLC_', 'PYTHON', 'MSYSTEM')) and k.upper() not in ('ELECTRON_RUN_AS_NODE','NODE_OPTIONS')}

def read(path, fallback=None):
    try: return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError): return fallback

def restore_hmi_window(pid):
    """Display this controller's existing native HMI without spawning another host."""
    import ctypes
    from ctypes import wintypes
    if os.name!='nt':raise ValueError('当前平台不支持还原 HMI 窗口')
    api=ctypes.WinDLL('user32',use_last_error=True)
    callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    api.EnumWindows.argtypes=[callback_type,wintypes.LPARAM];api.EnumWindows.restype=wintypes.BOOL
    api.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)];api.GetWindowThreadProcessId.restype=wintypes.DWORD
    api.GetClassNameW.argtypes=[wintypes.HWND,wintypes.LPWSTR,ctypes.c_int];api.GetClassNameW.restype=ctypes.c_int
    api.ShowWindowAsync.argtypes=[wintypes.HWND,ctypes.c_int];api.ShowWindowAsync.restype=wintypes.BOOL
    api.SetForegroundWindow.argtypes=[wintypes.HWND];api.SetForegroundWindow.restype=wintypes.BOOL
    windows=[]
    @callback_type
    def match(window,_):
        process=wintypes.DWORD();api.GetWindowThreadProcessId(window,ctypes.byref(process))
        if process.value==pid:
            name=ctypes.create_unicode_buffer(128);api.GetClassNameW(window,name,len(name))
            if name.value=='PLCdev.BatchHMI':windows.append(window);return False
        return True
    api.EnumWindows(match,0)
    if not windows:raise ValueError('HMI 进程存在，但窗口尚未就绪；请稍后再试。未创建重复进程。')
    if not api.ShowWindowAsync(windows[0],9):raise ValueError('HMI 窗口还原请求失败；未创建重复进程。')
    return bool(api.SetForegroundWindow(windows[0]))

def sources():
    return {p.relative_to(PROJECT).as_posix():sha(p) for name in ('project.json','library.json','pous','datatypes','devices')
        for p in ([PROJECT/name] if (PROJECT/name).is_file() else sorted((PROJECT/name).rglob('*'))) if p.is_file()}

def controller_call(descriptor, path, body=None):
    headers={'Authorization':'Bearer '+descriptor['token']}
    if body is not None: headers['Content-Type']='application/json'
    req=request.Request(descriptor['base']+path, data=None if body is None else json.dumps(body).encode(),headers=headers)
    try:
        with request.urlopen(req,timeout=12) as response: return json.load(response)
    except error.HTTPError as exc: raise RuntimeError(json.load(exc).get('error',str(exc))) from None

def ensure():
    HOME.mkdir(parents=True,exist_ok=True)
    # Serialize simultaneous desktop/editor launches; stale descriptors are never trusted alone.
    with FileLease(HOME/'startup.lock',timeout=18):
        old=read(DESCRIPTOR)
        if old:
            health=None
            try:health=controller_call(old,'/api/status')
            except (OSError,ValueError,RuntimeError):pass
            if health and health.get('service')=='plcdev-workbench' and health.get('instance')==old['instance']:
                if health.get('schemaVersion')!=3 or not health.get('projectCatalog',{}).get('canConfigureInterface') or health.get('agentTaskInputVersion')!='saved-revision-v1':
                    raise RuntimeError('旧版工作台后台仍在运行；请先在原入口结束会话，再重启工作台后台。未停止任何工程。')
                return old
        with (HOME/'controller.log').open('ab') as log:
            child=subprocess.Popen([sys.executable,str(Path(__file__)),'serve'],cwd=ROOT,env=env(),
                stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        end=time.monotonic()+15
        while time.monotonic()<end:
            if child.poll() is not None:raise RuntimeError('工作台后台未启动，请查看 outputs/workbench/controller.log')
            value=read(DESCRIPTOR)
            if value and (not old or value.get('instance')!=old.get('instance')):
                try:
                    if controller_call(value,'/api/status').get('instance')==value['instance']:return value
                except (OSError,ValueError,RuntimeError):pass
            time.sleep(.1)
        raise RuntimeError('工作台后台启动超时')

class Manager:
    def __init__(self, instance, project_config=None):
        if BATCH_PROJECT is None:raise ValueError('此分发未包含内置批次工程；请打开自己的用户工程')
        self.project=dict(project_config or BATCH_PROJECT)
        if self.project['id']!=PROJECT_ID or self.project['kind']!='batch':raise ValueError('批次运行器不能装载其他工程')
        if any(self.project.get(key)!=BATCH_PROJECT.get(key) for key in ('plc','hmi','scene','hmiExecutable','hmiBuild')):
            raise ValueError('批次工程关联与已加载清单不一致，请重启工作台读取新清单')
        self.instance=instance;self.lock=threading.RLock();self.action_lock=threading.Lock()
        self.phase='idle';self.message='选择案例，检查环境后启动。';self.failure=None
        self.directory=None;self.manifest=None;self.child=None;self.hmi=None;self.worker=None
        self.events=[];self.clients={};self.bridge_sequence=0;self.identity=None;self.mode='factoryio'
        self.shutting_down=False
        self.tool_launches={};self.hash_cache={};self.hmi_started_at=0.

    def cached_hash(self, path):
        """Hash changed local artifacts without rereading an unchanged EXE on every poll."""
        path=Path(path)
        try:
            stat=path.stat();signature=(stat.st_size,stat.st_mtime_ns)
            old=self.hash_cache.get(str(path))
            if old and old[0]==signature:return old[1]
            value=sha(path);self.hash_cache[str(path)]=(signature,value);return value
        except OSError:return None

    def factory_entry(self, current_owner=None, *, cached=True):
        occupied = bool(current_owner or (self.child and self.child.poll() is None)
            or (self.worker and self.worker.is_alive()) or self.phase in ('building','stopping'))
        reason = '已有 Runtime 会话或正在准备；请先在所属工程显式结束，再打开场景。' if occupied else None
        launched = self.tool_launches.get('factory')
        if not reason and launched and time.time()-launched['at'] < 10 and launched['process'].poll() in (None,0):
            reason = '场景启动请求正在处理；请稍候核对 Factory I/O 窗口，未发送重复请求。'
        return factory_preflight(FACTORY,self.project.get('scene'),occupied_reason=reason,cached=cached)

    def factory_tool(self, name):
        entry = self.factory_entry(owner(),cached=False)
        if name=='factory-window':
            if not entry['canShowFactory']:raise ValueError(entry['reasons']['canShowFactory'])
            focused = show_factory_window(FACTORY,entry['processes'][0])
            self.event('已显示现有 Factory I/O 窗口；未切换场景或改变运行状态。' if focused else '已请求显示现有 Factory I/O 窗口；系统未允许前置，请从任务栏查看。未切换场景。')
            return
        if not entry['canOpenFactoryScene']:raise ValueError(entry['reasons']['canOpenFactoryScene'])
        # The Workspace action lock covers other providers' preparation. This
        # short lease additionally prevents an external entry from racing spawn.
        with FileLease(RUNTIME_LOCK):
            entry = self.factory_entry(cached=False)
            if not entry['canOpenFactoryScene']:raise ValueError(entry['reasons']['canOpenFactoryScene'])
            with (HOME/('tool-factory-'+self.project['id']+'.log')).open('ab') as log:
                process=subprocess.Popen(entry['argv'],cwd=FACTORY.parent,env=env(),stdout=log,
                    stderr=subprocess.STDOUT,creationflags=NO_WINDOW,shell=False)
            with self.lock:self.tool_launches['factory']={'process':process,'at':time.time(),'scene':entry['sceneTarget']}
        self.event('已请求 Factory I/O 载入当前工程场景；未发送 Run。请在窗口核对场景名与编辑模式。')

    def topology(self, state, fresh, alive, changed, current_owner, dependencies):
        now=time.time();observed=state.get('observedAt') if fresh else None
        runtime=state.get('runtimeState','UNKNOWN') if fresh else 'UNKNOWN'
        busy=bool(self.worker and self.worker.is_alive()) or self.phase in ('building','stopping')
        deps={d['id']:d for d in dependencies};hmi_alive=bool(self.hmi and self.hmi.poll() is None)
        target='本机隔离 Runtime';session_id=(self.manifest or {}).get('sessionId')
        components={}
        for key,dep,tool,asset in [('plc','editor','plc',PROJECT/'project.json'),('eez','eez','hmi',HMI_PROJECT),('factory','factory','factory',SCENE)]:
            available=deps[dep]['available'];launched=self.tool_launches.get(tool)
            status='available' if available else 'unavailable';label='入口可用 · 窗口未确认' if available else '工具未安装'
            if launched:
                code=launched['process'].poll()
                status='process-alive' if code is None else 'launch-requested' if code==0 else 'launch-failed'
                label='启动进程存在 · 窗口未确认' if code is None else '已请求打开 · 窗口未确认' if code==0 else '启动进程异常退出'
            components[key]={'available':available,'state':status,'label':label,'path':deps[dep]['path'],
                'projectFile':str(asset),'observedAt':now if launched else None,'requestedAt':launched['at'] if launched else None,
                'windowVerified':False,'projectOpenVerified':False}
        factory_entry=self.factory_entry(current_owner)
        factory_launch=self.tool_launches.get('factory')
        launch_state='not-requested'
        if factory_launch:
            code=factory_launch['process'].poll()
            launch_state='process-exited' if (code not in (None,0) or (factory_entry['processRunning'] is False and now-factory_launch['at']>=10)) else 'requested'
        components['factory'].update({key:factory_entry[key] for key in ('sceneTarget','processRunning','sceneIdentityVerified','runModeVerified')})
        components['factory'].update(sceneLaunchState=launch_state,requestedScene=factory_launch.get('scene') if factory_launch else None)
        if factory_entry['processRunning']:
            components['factory'].update(state='process-alive',label='进程存在 · 当前场景未确认')
        runtime_state='preparing' if self.phase=='building' else 'running' if runtime=='RUNNING' else 'stopped' if runtime=='STOPPED' else 'unknown' if alive else self.phase if self.phase in ('ended','fault') else 'idle'
        runtime_label={'preparing':'编译并准备中','running':'PLC 运行中','stopped':'PLC 已停止','unknown':'执行状态未知','ended':'会话已结束','fault':'需要处理','idle':'尚未准备'}[runtime_state]
        components['runtime']={'available':deps['runtime']['available'],'state':runtime_state,'label':runtime_label,'path':deps['runtime']['path'],'observedAt':observed}
        components['hmi']={'available':deps['hmi']['available'],'state':'process-alive' if hmi_alive else 'closed' if deps['hmi']['available'] else 'unavailable',
            'label':'所属 HMI 进程运行' if hmi_alive else 'HMI 未打开' if deps['hmi']['available'] else '画面产物缺失','path':str(HMI),'projectFile':str(HMI_PROJECT),'observedAt':now,'windowVerified':False}
        load_state='preparing' if self.phase=='building' else 'stale' if alive and changed else 'current' if alive and fresh else 'unknown' if alive else 'unloaded'
        build=read(HMI_BUILD,{}) or {};source_hash=self.cached_hash(HMI_PROJECT);exe_hash=self.cached_hash(HMI)
        if not source_hash or not exe_hash:generate_state='missing'
        elif not build.get('passed') or not build.get('projectSha256') or not build.get('executableSha256'):generate_state='unknown'
        elif source_hash!=build['projectSha256'] or exe_hash!=build['executableSha256']:generate_state='stale'
        else:generate_state='current'
        # A restarted host cannot inherit the previous window's still-valid heartbeat.
        waiting_hmi=hmi_alive and now-self.hmi_started_at<1.6
        channel=fresh and hmi_alive and not waiting_hmi and bool(state.get('hmiConnected'))
        telemetry=channel and bool(state.get('telemetryFresh'))
        variable_state='inactive' if not alive else 'unknown' if not fresh or waiting_hmi else 'connected' if channel else 'disconnected'
        comm=state.get('communication') or {};io_state='inactive' if not alive else 'unknown' if not fresh else 'connected' if comm.get('connected') else 'disconnected'
        links={
            'load':{'source':'plc','target':'runtime','state':load_state,'label':{'preparing':'编译与装载中','stale':'源码已改变','current':'已装载当前程序','unknown':'装载状态待确认','unloaded':'尚未装载'}[load_state],
                'observedAt':observed,'details':{'projectFile':str(PROJECT/'project.json'),'programHash':(self.manifest or {}).get('programHash'),'sourceChanged':changed,'sessionId':session_id}},
            'generate':{'source':'eez','target':'hmi','state':generate_state,'label':{'missing':'画面产物缺失','unknown':'构建身份未确认','stale':'画面待重新构建','current':'画面产物与源码一致'}[generate_state],
                'observedAt':now,'details':{'projectFile':str(HMI_PROJECT),'buildRecord':str(HMI_BUILD),'sourceHash':source_hash,'recordedSourceHash':build.get('projectSha256'),'executableHash':exe_hash}},
            'variables':{'source':'hmi','target':'runtime','state':variable_state,'label':{'inactive':'无活动会话','unknown':'等待新 HMI 心跳' if waiting_hmi else '通道状态未知','connected':'变量实时' if telemetry else '通道在线 · 历史值','disconnected':'HMI 通道断开'}[variable_state],
                'observedAt':observed,'channelConnected':channel,'dataFresh':telemetry,'dataQuality':'live' if telemetry else 'historical' if channel and runtime=='STOPPED' else 'unknown',
                'details':{'protocol':'本机 HTTP / PLC 邮箱','endpoint':'http://127.0.0.1:'+str(self.manifest['batchHttpPort']) if alive and self.manifest else None,'sessionId':session_id,'runtimeState':runtime}},
            'io':{'source':'runtime','target':'factory','state':io_state,'label':{'inactive':'无活动会话','unknown':'驱动状态未知','connected':'已连接 · 待人工恢复' if state.get('requiresManualRecovery') else '驱动已连接','disconnected':'驱动断开 · 自动重试'}[io_state],
                'observedAt':observed,'sceneRunning':state.get('sceneRunning') if fresh else None,'requiresManualRecovery':bool(state.get('requiresManualRecovery')) if fresh else None,
                'details':{'protocol':'Modbus TCP','endpoint':'127.0.0.1:'+('1502' if self.mode=='factoryio' else '1503'),'mode':self.mode,
                    'peer':'Factory I/O' if self.mode=='factoryio' else '回环模拟设备（非 Factory I/O）','sceneFile':str(SCENE),'sceneIdentityVerified':False,'retryPolicy':'断线自动重试，恢复后人工核对数量；不重放旧操作'}}}
        essential={'editor','runtime','msys','hmi','scene'}
        if self.mode=='factoryio':essential.add('factory')
        missing=[d['label'] for d in dependencies if d['id'] in essential and not d['available']]
        external_owner=current_owner and (not session_id or current_owner.get('sessionId')!=session_id)
        ready=self.phase=='ready' and alive and not busy
        capabilities={'canPrepare':not busy and not missing and not external_owner and (not alive or (fresh and runtime=='STOPPED' and changed)),
            'canRun':ready and fresh and channel and runtime=='STOPPED' and not changed,
            'canStop':ready and fresh and channel and runtime=='RUNNING',
            'canEnd':alive and not busy,'canShowHmi':ready and deps['hmi']['available'],'canReconnectHmi':ready and deps['hmi']['available'],
            'tools':{'plc':deps['editor']['available'],'eez':deps['eez']['available'],'factory':deps['factory']['available'],'logs':True,'scene-folder':SCENE.parent.exists()},'reasons':{}}
        capabilities.update({key:factory_entry[key] for key in ('canOpenFactoryScene','canShowFactory')})
        capabilities['reasons'].update({key:value for key,value in factory_entry['reasons'].items() if value})
        capabilities['tools']['factory-window']=factory_entry['canShowFactory']
        if busy:capabilities['reasons']['canPrepare']='正在准备或结束会话'
        elif missing:capabilities['reasons']['canPrepare']='缺少依赖：'+'、'.join(missing)
        elif external_owner:capabilities['reasons']['canPrepare']='另一个入口占用 Runtime'
        elif alive and not capabilities['canPrepare']:capabilities['reasons']['canPrepare']='已有活动会话；源码改变时先停止 PLC 再重新编译'
        if not capabilities['canRun']:capabilities['reasons']['canRun']='源码已改变，请停止后重新编译' if changed else '先准备会话、打开 HMI 并确认通道，PLC 应为 STOP'
        if not capabilities['canStop']:capabilities['reasons']['canStop']='需要已确认的运行状态和 HMI 心跳；HMI 失联时可重开 HMI 或结束会话'
        if not capabilities['canEnd']:capabilities['reasons']['canEnd']='等待准备完成' if busy else '没有活动会话'
        return {'components':components,'links':links,'capabilities':capabilities,
            'session':{'id':session_id,'active':alive,'phase':self.phase,'mode':self.mode,'target':target,'runtimeState':runtime,
                'programHash':(self.manifest or {}).get('programHash'),'runDirectory':str(self.directory) if self.directory else None}}

    def event(self, text):
        with self.lock:
            self.message=text;self.events.append({'at':time.time(),'message':text});self.events=self.events[-60:]
            store(HOME/'events.json',self.events)

    def dependencies(self):
        editor=EDITOR
        return [{'id':key,'label':label,'path':str(path),'available':path.exists()} for key,label,path in (
            ('editor','OpenPLC 中文编辑器',editor),('eez','EEZ Studio 中文版',EEZ),
            ('factory','Factory I/O',FACTORY),('runtime','OpenPLC Runtime',RUNTIME/'CMakeLists.txt'),
            ('msys','本机编译环境',MSYS/'usr/bin/bash.exe'),('hmi','LVGL 运行画面',HMI),
            ('scene','连续过箱场景',SCENE))]

    def snapshot(self):
        with self.lock:
            if self.child and self.child.poll() is not None and self.phase not in ('idle','ended','fault'):
                result=read(self.directory/'run-result.json',{})
                self.phase='ended' if result.get('result')=='passed' else 'fault'
                self.failure=result.get('error')
                if self.hmi and self.hmi.poll() is None:self.hmi.terminate()
                self.event('会话正常结束，所属进程已退出。' if self.phase=='ended' else self.failure or '会话异常结束，请查看日志。')
            if self.hmi and self.hmi.poll() is not None and self.child and self.child.poll() is None and self.phase=='ready':
                self.hmi=None
                self.event('HMI 已关闭；运行会话保留。通道失联由适配层撤销过程许可，可重开 HMI 或显式结束会话。')
            state=read(self.directory/'state.json',{}) if self.directory else {}
            alive=self.child is not None and self.child.poll() is None
            age=time.time()-state.get('observedAt',0)
            identity_matches=bool(self.manifest and state.get('sessionId')==self.manifest['sessionId'] and state.get('programHash')==self.manifest['programHash'])
            fresh=alive and identity_matches and -1<=age<2
            if state and not fresh:
                state.update(telemetryFresh=False,hmiConnected=False,sceneRunning=None,countKnown=False,runtimeState='UNKNOWN',ready=False)
                state['communication']={**state.get('communication',{}),'connected':False,'remoteOutputsKnownZero':False}
            current=owner()
            changed=self.identity is not None and sources()!=self.identity;dependencies=self.dependencies()
            topology=self.topology(state,fresh,alive,changed,current,dependencies)
            return {'service':'plcdev-workbench','schemaVersion':2,'instance':self.instance,'phase':self.phase,'message':self.message,'error':self.failure,
                'mode':self.mode,'runDirectory':str(self.directory) if self.directory else None,
                'sessionId':self.manifest['sessionId'] if self.manifest else None,'state':state,'observerFresh':fresh,
                'hmiOpen':self.hmi is not None and self.hmi.poll() is None,'runtimeOwner':current,
                'projectChanged':changed,'dependencies':dependencies,'events':list(self.events),
                'project':{**self.project,'opened':True},
                'result':read(self.directory/'run-result.json') if self.directory else None,**topology}

    def start(self, mode='factoryio'):
        if mode not in ('factoryio','mock'):raise ValueError('未知案例模式')
        with self.lock:
            if self.worker and self.worker.is_alive():
                if self.mode!=mode:raise ValueError('先结束当前模式的会话')
                self.event('已复用当前案例会话，没有启动第二套 Runtime。');return
            if self.child and self.child.poll() is None:
                if self.mode!=mode:raise ValueError('先结束当前模式的会话')
                if sources()==self.identity:
                    self.event('已复用当前案例会话，没有启动第二套 Runtime。');return
                state=read(self.directory/'state.json',{})
                if (not self.manifest or state.get('sessionId')!=self.manifest['sessionId']
                    or state.get('programHash')!=self.manifest['programHash']
                    or not -1<=time.time()-state.get('observedAt',0)<2):
                    raise ValueError('当前会话状态已过期，无法确认 STOP；请恢复状态或显式结束会话。')
                if state.get('runtimeState')!='STOPPED':raise ValueError('PLC 工程已修改，请先停止 Runtime 再重新编译。')
                self.end()
            if owner():raise ValueError('另一入口已有 Runtime 会话，请先结束；占用详情见全局状态。')
            essential={'editor','runtime','msys','hmi','scene'}|({'factory'} if mode=='factoryio' else set())
            missing=[d['label'] for d in self.dependencies() if d['id'] in essential and not d['available']]
            if missing:raise ValueError('缺少依赖：'+'、'.join(missing))
            self.mode=mode;self.phase='building';self.failure=None;self.identity=sources()
            self.child=None;self.hmi=None;self.manifest=None
            self.directory=ROOT/'outputs/editor-runtime'/('workbench-'+mode+'-'+time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3))
            self.worker=threading.Thread(target=self.build,daemon=True);self.worker.start()
            self.event('正在编译 PLC 工程并准备隔离会话…')

    def build(self):
        from hmi_batch_session import prepare
        try:
            directory=self.directory;directory.mkdir(parents=True)
            store(directory/'project-source-identity.json',self.identity)
            editor=EDITOR if EDITOR.exists() else FALLBACK_EDITOR
            with (directory/'workbench-compile.log').open('wb') as log:
                result=subprocess.run([str(editor),'--cli','compile',str(PROJECT),'--target','OpenPLC Runtime v4',
                    '--user-data',str(directory/'compiler-profile'),'--json'],stdout=log,stderr=subprocess.STDOUT,
                    cwd=ROOT,env=env(),creationflags=NO_WINDOW,timeout=180)
            if result.returncode:raise RuntimeError('PLC 编译失败，见 workbench-compile.log')
            if sources()!=self.identity:raise RuntimeError('编译期间源工程改变，请重新启动案例。')
            # prepare requires a fresh child; keep compiler evidence one level above.
            run=directory/'session';manifest=prepare(SimpleNamespace(run_directory=run,mode=self.mode,project_directory=PROJECT))
            manifest['projectId']=self.project['id'];manifest['projectName']=self.project['name']
            store(run/'session.json',manifest)
            if sources()!=self.identity:raise RuntimeError('准备期间源工程改变，请重新启动案例。')
            with self.lock:
                self.directory=run;self.manifest=manifest
                with (run/'workbench-runtime.log').open('wb') as log:
                    self.child=subprocess.Popen([sys.executable,str(ROOT/'tools/hmi_batch_session.py'),'run','--run-directory',str(run),
                        '--parent-pid',str(os.getpid())],cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            end=time.monotonic()+30
            while time.monotonic()<end:
                if self.child.poll() is not None:raise RuntimeError('Runtime 未启动；可能已被其他入口占用，请查看会话日志。')
                if read(run/'state.json',{}).get('ready'):break
                time.sleep(.1)
            else:raise RuntimeError('Runtime 准备超时')
            with self.lock:
                self.phase='ready';self.open_hmi()
                self.event('案例已就绪。Runtime 保持停止；先运行 Factory I/O 场景，再点击运行 Runtime。')
        except Exception as exc:
            with self.lock:
                if self.child and self.child.poll() is None:(self.directory/'stop.request').write_text('preparation failed\n')
                self.phase='fault';self.failure=str(exc);self.event(str(exc))

    def open_hmi(self):
        with self.lock:
            if self.phase!='ready' or not self.child or self.child.poll() is not None:raise ValueError('请先启动案例')
            if self.hmi and self.hmi.poll() is None:
                foreground=restore_hmi_window(self.hmi.pid)
                self.event('已显示当前会话的 HMI 窗口。' if foreground else '已请求还原 HMI 窗口；若未置前，请从任务栏切换。')
                return
            with (self.directory/'hmi.log').open('ab') as log:
                self.hmi=subprocess.Popen([str(HMI),str(self.manifest['batchHttpPort']),self.manifest['sessionId'],self.manifest['programHash']],
                    cwd=HMI.parent,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            self.hmi_started_at=time.time()
            self.event('已启动当前会话的 HMI，正在等待窗口与通信心跳。')

    def reopen_hmi(self):
        with self.lock:
            if self.phase!='ready' or not self.child or self.child.poll() is not None:raise ValueError('没有可用会话')
            if self.hmi and self.hmi.poll() is None:
                self.hmi.terminate()
                try:self.hmi.wait(5)
                except subprocess.TimeoutExpired:raise ValueError('所属 HMI 尚未退出，未启动第二个窗口') from None
            self.hmi=None;self.open_hmi()
            self.event('已重新打开本会话 HMI，等待新心跳；Runtime 与请求序号保留，旧命令不重放。')

    def bridge(self, kind):
        if self.phase!='ready' or not self.child or self.child.poll() is not None:raise ValueError('没有可用会话')
        if kind==9 and sources()!=self.identity:raise ValueError('PLC 源工程已修改；请结束会话，重新编译启动。')
        self.bridge_sequence+=1
        fields={'kind':kind,'value':0,'sequence':self.bridge_sequence,'expires':time.time()+4.5,'program':self.manifest['programHash']}
        req=request.Request('http://127.0.0.1:'+str(self.manifest['batchHttpPort'])+'/command',data=parse.urlencode(fields).encode(),
            headers={'X-PLCdev-Session':self.manifest['sessionId'],'X-PLCdev-Client':'workbench'})
        try:
            with request.urlopen(req,timeout=6) as response:result=json.load(response)
        except error.HTTPError as exc:raise ValueError(json.load(exc).get('error','PLC 拒绝命令')) from None
        self.event('Runtime 已运行；批次仍需在 HMI 启动。' if kind==9 else 'Runtime 已停止；计数保留为本会话历史值。')
        return result

    def end(self):
        if self.worker and self.worker.is_alive():raise ValueError('正在准备会话，请等待完成后结束')
        if not self.child or self.child.poll() is not None:return
        self.phase='stopping';self.event('正在停止并清理本会话 Runtime…')
        (self.directory/'stop.request').write_text('workbench end session\n')
        try:self.child.wait(22)
        except subprocess.TimeoutExpired:raise ValueError('所属会话清理超时，保留占用，禁止重复启动') from None
        if self.hmi and self.hmi.poll() is None:self.hmi.terminate();self.hmi.wait(5)
        result=read(self.directory/'run-result.json',{})
        if self.child.returncode or result.get('result')!='passed' or not result.get('ownedProcessesExited'):
            self.phase='fault';self.failure=result.get('error','未确认正常清理');raise ValueError(self.failure)
        self.phase='ended';self.event('会话已结束，所属 Runtime 与监视进程正常退出。Factory I/O 场景请另行停止。')

    def tool(self, name):
        if name=='logs':
            path=self.directory or HOME;os.startfile(path);return
        if name=='scene-folder':os.startfile(SCENE.parent);return
        if name in ('factory','factory-window'):return self.factory_tool(name)
        if name=='plc':
            exe=EDITOR
            profile=HOME/'editor-profiles'/self.project['id']
            args=['--user-data-dir='+str(profile),'--plcdev-project',str(Path(self.project['plc']).parent)]
        elif name in ('hmi','eez'):name='hmi';exe=EEZ;args=[str(HMI_PROJECT)]
        else:raise ValueError('未知工具')
        if not exe.exists():raise ValueError('工具不存在，请检查依赖路径')
        tool_env=env()
        if name=='plc':tool_env.update(OPENPLC_ZH_USER_DATA=str(profile),OPENPLC_ZH_TRIAL='1')
        with (HOME/('tool-'+name+'-'+self.project['id']+'.log')).open('ab') as log:
            process=subprocess.Popen([str(exe),*args],cwd=exe.parent,env=tool_env,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        with self.lock:self.tool_launches[name]={'process':process,'at':time.time()}
        self.event('已请求打开'+{'plc':'PLC 工程','hmi':'HMI 工程','factory':'Factory I/O'}[name])

    def action(self, body):
        with self.action_lock:
            if not time.time()<=body.get('expires',0)<=time.time()+15:raise ValueError('排队请求已过期，未执行')
            name=body.get('action')
            # Session-dependent requests cannot act on a replacement session.
            if 'sessionId' not in body or body.get('sessionId')!=(self.manifest or {}).get('sessionId'):
                raise ValueError('会话已更换；旧操作已拒绝，请刷新状态。')
            if name=='start':self.start(body.get('mode','factoryio'))
            elif name=='runtime-start':self.bridge(9)
            elif name=='runtime-stop':self.bridge(10)
            elif name=='end':self.end()
            elif name=='show-hmi':self.open_hmi()
            elif name=='reopen-hmi':self.reopen_hmi()
            elif name=='tool':self.tool(body.get('tool'))
            else:raise ValueError('未知操作')
        return {'ok':True}


class Workspace:
    """Selection is a query, never a mutation of a process or global active project."""
    def __init__(self, instance, managers=None, projects=None, catalog=None):
        self.instance=instance;self.lock=threading.RLock();self.action_lock=threading.Lock();self.catalog_lock=threading.Lock();self.clients={};self.configuring=set()
        self.catalog=catalog if catalog is not None else (ProjectCatalog() if projects is None and managers is None else None)
        self.projects=dict(self.catalog.projects if self.catalog is not None else projects if projects is not None else PROJECTS)
        self.default=DEFAULT_PROJECT_ID if DEFAULT_PROJECT_ID in self.projects else next(iter(self.projects),None)
        if managers is None:
            self.managers={key:self.make_manager(item) for key,item in self.projects.items()}
        else:self.managers=managers
        self._catalog_stamp=None;self._catalog_refresh_error=None

    def _sync_new_projects(self):
        """Notice registrations from the task service without retargeting live owners."""
        index=getattr(self.catalog,'index_path',None)
        if not isinstance(index,(str,os.PathLike)) or not self.catalog_lock.acquire(blocking=False):return
        try:
            try:
                stat=Path(index).stat();stamp=(stat.st_mtime_ns,stat.st_size)
            except FileNotFoundError:stamp=None
            except OSError as exc:
                self._catalog_refresh_error=str(exc);return
            if stamp==self._catalog_stamp:return
            try:
                projects=self.catalog.refresh()
                with self.lock:
                    for key,project in projects.items():
                        # A disk refresh is not permission to replace an existing
                        # definition, dispose a manager, or end its Runtime.
                        if key in self.projects or key in self.managers:continue
                        manager=self.make_manager(project)
                        self.projects[key]=project;self.managers[key]=manager
                self._catalog_refresh_error=None
            except (OSError,ValueError) as exc:
                self._catalog_refresh_error=str(exc)
            finally:
                # Capture the stamp read BEFORE refresh: an intervening atomic
                # index replacement is picked up by the next state request.
                self._catalog_stamp=stamp
        finally:self.catalog_lock.release()

    def make_manager(self, project):
        if project['kind']=='batch':return Manager(self.instance,project)
        if project['kind']=='start-stop':
            from workbench_start_stop import StartStopManager
            return StartStopManager(self.instance,project)
        if project['kind']=='user' and project.get('defaultMode')=='fuxa-oip':
            from workbench_fuxa_oip import FuxaOipManager
            return FuxaOipManager(self.instance,project)
        if project['kind']=='user' and project.get('modelBindingsPath'):
            from workbench_model import ModelLocalManager
            return ModelLocalManager(self.instance,project)
        if project['kind']=='user' and project.get('defaultMode')=='fuxa-local':
            from workbench_interface import FuxaLocalManager
            return FuxaLocalManager(self.instance,project)
        if project['kind']=='user':
            from workbench_user_project import UserProjectManager
            return UserProjectManager(self.instance,project)
        raise ValueError('不支持的工程运行目标')

    def resolve(self, project_id):
        if not isinstance(project_id,str) or project_id not in self.managers:
            raise ValueError('工程不存在；请选择工程后重试')
        return self.managers[project_id]

    @staticmethod
    def occupied(snapshot):
        return bool(snapshot.get('session',{}).get('active') or snapshot.get('phase') in ('building','stopping'))

    @classmethod
    def definition_locked(cls,snapshot):
        return cls.occupied(snapshot) or bool(snapshot.get('configurationLocked') or snapshot.get('toolsOpen'))

    def snapshots(self):
        with self.lock:managers=list(self.managers.items())
        return {key:manager.snapshot() for key,manager in managers}

    def snapshot(self, project_id=None):
        self._sync_new_projects()
        project_id=self.default if project_id is None else project_id
        self.resolve(project_id)
        states=self.snapshots();selected=states[project_id]
        selected['schemaVersion']=3
        selected['agentTaskInputVersion']='saved-revision-v1'
        selected['project']={**self.projects[project_id],**selected.get('project',{}),'id':project_id,'opened':True}
        with self.lock:projects=list(self.projects.values())
        selected['projects']=[{k:item.get(k) for k in ('id','name','description','kind','defaultMode','manifestPath')} for item in projects]
        selected['projectCatalog']=dict(canCreate=self.catalog is not None,canOpen=self.catalog is not None,
            defaultParent=str(Path.home()/'Documents'/'PLCdev Projects'),
            refreshError=self._catalog_refresh_error,
            unavailable=list(getattr(self.catalog,'unavailable',[])) if self.catalog is not None else [])
        from workbench_project_config import default_bindings
        selected['projectCatalog'].update(canConfigure=self.catalog is not None,canConfigureInterface=self.catalog is not None,bindingDefaults=default_bindings(),
            integrationSources=dict(hmiSource=str(ROOT/'software/fuxa-oip/hmi/batch-ai.fuxap') if (ROOT/'software/fuxa-oip/hmi/batch-ai.fuxap').is_file() else '',oipSource=str(ROOT/'software/oip-batch/ContinuousBatch/project.json') if (ROOT/'software/oip-batch/ContinuousBatch/project.json').is_file() else ''))
        configuration_busy=project_id in self.configuring
        locked=self.definition_locked(selected) or configuration_busy
        selected['capabilities']['canConfigureProject']=self.catalog is not None and self.projects[project_id]['kind']=='user' and not locked
        selected['capabilities']['canConfigureInterface']=self.catalog is not None and self.projects[project_id]['kind']=='user' and self.projects[project_id].get('defaultMode')!='fuxa-oip' and not locked
        if locked:selected['capabilities'].setdefault('reasons',{})['canConfigureProject']='本工程工具或运行会话已打开，或配置正在保存；请完成后再修改。'
        if locked:selected['capabilities'].setdefault('reasons',{})['canConfigureInterface']='本工程工具或运行会话已打开，或配置正在保存；请完成后再修改。'
        if configuration_busy:
            selected['capabilities']['canPrepare']=False
            selected['capabilities'].setdefault('reasons',{})['canPrepare']='工程配置正在保存，请稍候。'
        selected['session']={**selected.get('session',{}),'projectId':project_id,'projectName':self.projects[project_id]['name']}
        selected['otherSessions']=[{**state.get('session',{}),'projectId':key,'projectName':self.projects[key]['name'],
            'phase':state.get('phase'),'active':bool(state.get('session',{}).get('active'))}
            for key,state in states.items() if key!=project_id and self.occupied(state)]
        selected['capabilities'].setdefault('canInput',False)
        selected['capabilities'].setdefault('canOpenFactoryScene',False)
        selected['capabilities'].setdefault('canShowFactory',False)
        if any(self.occupied(state) for state in states.values()) and self.projects[project_id].get('defaultMode')!='fuxa-oip' and self.projects[project_id].get('scene'):
            selected['capabilities']['canOpenFactoryScene']=False
            selected['capabilities'].setdefault('reasons',{})['canOpenFactoryScene']='已有 Runtime 会话或正在准备；切换工程不会停止它，请先在所属工程显式结束，再打开场景。'

        if selected['otherSessions']:
            names='、'.join(item['projectName'] for item in selected['otherSessions'])
            selected['capabilities']['canPrepare']=False
            selected['capabilities'].setdefault('reasons',{})['canPrepare']='共享 Runtime 被「'+names+'」占用；切换不会停止它，请回到所属工程显式结束会话。'
        return selected

    def event(self, text):
        # Controller diagnostics remain visible without choosing another project's session.
        with self.lock:managers=list(self.managers.values())
        for manager in managers:manager.event(text)

    def project_action(self, body):
        if self.catalog is None:raise ValueError('当前工作台未启用用户工程目录')
        # Creating files must not hold the Runtime action lock: another project
        # can still stop its PLC while the editor creates a new source tree.
        with self.catalog_lock:
            expiry=body.get('expires',0)
            if type(expiry) not in (int,float) or not time.time()<=expiry<=time.time()+15:
                raise ValueError('工程操作请求已过期，未执行')
            current=self.resolve(body.get('projectId')).snapshot()
            if 'sessionId' not in body or body.get('sessionId')!=current.get('session',{}).get('id'):
                raise ValueError('当前工程会话已更换，请刷新后重新操作')
            if body['action'] in ('project-configure','project-interface-configure'):
                key=body['projectId']
                with self.action_lock:
                    current=self.resolve(key).snapshot()
                    if body.get('sessionId')!=current.get('session',{}).get('id') or self.definition_locked(current):
                        raise ValueError('本工程工具或运行会话仍在使用，请先显式结束后再修改配置。')
                    if self.projects[key]['kind']!='user':raise ValueError('请将样例导入为用户工程后再配置画面与场景。')
                    revision=(self.projects[key].get('configuration') or {}).get('revision')
                    if 'configurationRevision' not in body or body['configurationRevision']!=revision:
                        raise ValueError('工程配置已改变，请刷新后重试。')
                    self.configuring.add(key)
                try:
                    if body['action']=='project-interface-configure':
                        if self.projects[key].get('defaultMode')=='fuxa-oip':raise ValueError('已有批次协议工程保留原绑定；请新建本机工程声明接口。')
                        project=self.catalog.configure_interface(key,body.get('definition'),hmi_source=body.get('hmiSource') or None)
                    else:
                        values={field:body[field] for field in ('hmiSource','oipSource','bindings','bindingsSource') if field in body}
                        project=self.catalog.configure(key,values)
                    return self.register_project(project)
                finally:
                    with self.action_lock:self.configuring.discard(key)
            if body['action']=='project-create':
                project=self.catalog.create(body.get('name'),body.get('parent'),body.get('language','ld'),
                    body.get('simulation','none'),source=body.get('source'))
            else:
                # Opening another project is a view/file operation. Only a
                # change to the SAME active project's definition is refused.
                with self.action_lock:
                    candidate=self.catalog.inspect(body.get('manifestPath'))
                    key=candidate['id'];previous=self.managers.get(key)
                    if previous is not None and self.definition_locked(previous.snapshot()) and self.projects[key]!=candidate:
                        raise ValueError('该工程仍有活动会话，请结束后再更换工程定义或位置。')
                    project=self.catalog.open(body.get('manifestPath'))
                    return self.register_project(project)
            return self.register_project(project)

    def register_project(self, project):
        key=project['id']
        with self.lock:
            previous=self.managers.get(key)
            if previous is not None and self.definition_locked(previous.snapshot()):
                if self.projects[key]!=project:raise ValueError('工程正在运行，不能更换其定义')
            else:self.managers[key]=self.make_manager(project)
            self.projects[key]=project
        return dict(ok=True,projectId=key,project=project)

    def action(self, body):
        if body.get('action') in ('project-create','project-open','project-configure','project-interface-configure'):
            return self.project_action(body)
        with self.action_lock:
            expiry=body.get('expires',0)
            if type(expiry) not in (int,float) or not time.time()<=expiry<=time.time()+15:
                raise ValueError('排队请求已过期，未执行')
            project_id=body.get('projectId');manager=self.resolve(project_id)
            if project_id in self.configuring:raise ValueError('工程配置正在保存，请稍候再操作该工程。')
            current=manager.snapshot();session_id=current.get('session',{}).get('id')
            if 'sessionId' not in body or body.get('sessionId')!=session_id:
                raise ValueError('工程会话不匹配或已更换；旧操作已拒绝，请刷新状态。')
            if body.get('action')=='tool' and body.get('tool')=='factory' and self.projects[project_id].get('defaultMode')!='fuxa-oip':
                if not self.projects[project_id].get('scene'):raise ValueError('当前工程没有 Factory I/O 场景')
                with self.lock:managers=list(self.managers.items())
                for key,other in managers:
                    if self.occupied(other.snapshot()):
                        raise ValueError('「'+self.projects[key]['name']+'」已有 Runtime 会话或正在准备；请先显式结束，再打开场景。未停止任何会话。')
            if body.get('action')=='start':
                with self.lock:managers=list(self.managers.items())
                for key,other in managers:
                    if key!=project_id and self.occupied(other.snapshot()):
                        raise ValueError('「'+self.projects[key]['name']+'」已有运行会话；请回到所属工程显式结束。切换工程不会停止它。')
                command={**body,'mode':body.get('mode',self.projects[project_id]['defaultMode'])}
            else:command=body
            return manager.action(command)



class AgentGatewayError(RuntimeError):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


def agent_tasks(manager, project_id, body=None, *, connect=None, call=None):
    """Proxy the independent task service without exposing its local capability.

    The workbench remains the source of selectable project identities. A failed
    transport can have an unknown outcome, so callers must retain the same
    clientRequestId when retrying instead of creating another task.
    """
    try:
        manager.resolve(project_id)
    except ValueError:
        if body is not None:
            # The original create may already have reached the independent
            # service before this project disappeared from the local catalog.
            raise AgentGatewayError('当前工程无法核对；请保留原请求编号，确认已有任务后重试。', 503) from None
        raise
    try:
        if connect is None or call is None:
            from agent_task_service import ensure, service_call
            connect = ensure
            call = service_call
        descriptor = connect()
        encoded = parse.quote(project_id, safe='')
        if body is None:
            inspection = call(descriptor, '/v1/projects/'+encoded+'/inspect')
            listing = call(descriptor, '/v1/tasks?projectId='+encoded)
            revision = inspection.get('projectRevision')
            if inspection.get('projectId') != project_id or not isinstance(revision, str) or not revision or not isinstance(listing.get('tasks'), list):
                raise AgentGatewayError('任务服务未确认工程身份或版本，已停用创建。', 503)
            if any(not isinstance(task, dict) or task.get('projectId') != project_id for task in listing['tasks']):
                raise AgentGatewayError('任务服务返回了其他工程的任务，已拒绝显示。', 503)
            return {'ok':True, 'projectId':project_id, 'projectRevision':revision,
                    'tasks':listing['tasks'], 'capabilities':inspection.get('capabilities', {})}
        required={'projectId','request','expectedRevision','executionScope','clientRequestId'}
        if not required.issubset(body) or set(body)-required-{'sourceBasis','workflow'} or body.get('sourceBasis','editor_current') not in ('editor_current','saved_revision') or body.get('projectId') != project_id or body.get('executionScope') != 'proposal':
            raise AgentGatewayError('无效的候选任务请求。', 400)
        payload = dict(body);payload['executionScope'] = 'generate_only'
        result = call(descriptor, '/v1/tasks', payload)
        task = result.get('task')
        if not isinstance(task,dict) or task.get('projectId') != project_id or not task.get('taskId'):
            raise AgentGatewayError('未能确认任务身份；请用同一请求编号核对后重试。', 503)
        return result
    except AgentGatewayError:
        raise
    except Exception as exc:
        code = getattr(exc, 'code', None)
        message = getattr(exc, 'message', None)
        if isinstance(message,str) and code in ('invalid_request','conflict','not_ready','version_mismatch','busy','expired','cancelled'):
            raise AgentGatewayError(message, 409) from None
        # Never echo a descriptor, capability, HTTP headers, or an arbitrary
        # process exception into a browser-visible response.
        raise AgentGatewayError('任务服务暂不可用或结果尚未确认；请保留请求并重试。', 503) from None


def agent_review_candidate(manager, body):
    """Forward an explicit review action to the sole persistent task service."""
    import re
    required={'projectId','taskId','candidateDigest','expectedRevision','action','clientRequestId'}
    if not isinstance(body,dict) or set(body)!=required or not isinstance(body.get('taskId'),str) or not re.fullmatch(r'task-[0-9a-f]{32}',body['taskId']):
        raise AgentGatewayError('审阅请求身份无效。',400)
    try:
        manager.resolve(body['projectId'])
        from agent_task_service import ensure, service_call
        result=service_call(ensure(),'/v1/tasks/'+body['taskId']+'/review',body)
        task=result.get('task')
        if any(result.get(k)!=body[k] for k in ('projectId','taskId','candidateDigest')) or not isinstance(task,dict) or any(task.get(k)!=body[k] for k in ('projectId','taskId')):
            raise AgentGatewayError('审阅结果归属未确认，请保留原请求编号。',503)
        return result
    except AgentGatewayError:raise
    except Exception as exc:
        code=getattr(exc,'code',None)
        if code in ('invalid_request','conflict','not_ready','busy'):
            raise AgentGatewayError(getattr(exc,'message','操作未被接受。'),409) from None
        raise AgentGatewayError('审阅结果待核对，请保留原请求编号。',503) from None


def agent_open_candidate(manager, body, *, connect=None, call=None, candidate_root=None, launch=None):
    """Open only a service-confirmed, task-owned native candidate in its own profile."""
    import re
    from workbench_project_config import plain
    if not isinstance(body,dict) or set(body)!={'projectId','taskId','candidateDigest'}:
        raise AgentGatewayError('候选打开请求无效。',400)
    project_id,task_id,digest=(body[k] for k in ('projectId','taskId','candidateDigest'))
    if not isinstance(project_id,str) or not isinstance(task_id,str) or not re.fullmatch(r'task-[0-9a-f]{32}',task_id) or not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest):
        raise AgentGatewayError('候选工程身份无效。',400)
    try:manager.resolve(project_id)
    except ValueError:raise AgentGatewayError('工程不存在，未打开候选。',409) from None
    try:
        if connect is None or call is None:
            from agent_task_service import ensure, service_call
            connect,call=ensure,service_call
        result=call(connect(),'/v1/tasks/'+task_id+'/candidate',{'projectId':project_id,'candidateDigest':digest})
        if any(result.get(k)!=v for k,v in (('projectId',project_id),('taskId',task_id),('candidateDigest',digest))):
            raise AgentGatewayError('候选身份不匹配，未打开。',409)
        root=Path(candidate_root or Path(os.environ.get('PLCDEV_AGENT_HOME',str(ROOT/'outputs/workbench/agent-service')))/'candidates').resolve()/task_id
        raw=result.get('plcPath')
        if not isinstance(raw,str) or not Path(raw).is_absolute():raise AgentGatewayError('候选路径无效。',409)
        path=Path(raw);plain(path,root)
        if path.name!='project.json' or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise AgentGatewayError('候选路径不属于本任务，未打开。',409)
        if launch is None:
            exe=EDITOR if EDITOR.is_file() else FALLBACK_EDITOR
            if not exe.is_file():raise AgentGatewayError('未找到 OpenPLC 编辑器。',409)
            profile=HOME/'editor-profiles'/'agent-candidates'/task_id
            tool_env=env();tool_env.update(OPENPLC_ZH_USER_DATA=str(profile),OPENPLC_ZH_TRIAL='1')
            logpath=HOME/('agent-candidate-'+task_id+'.log')
            logpath.parent.mkdir(parents=True,exist_ok=True)
            with logpath.open('ab') as log:
                subprocess.Popen([str(exe),'--user-data-dir='+str(profile),'--plcdev-project',str(path.parent)],
                    cwd=exe.parent,env=tool_env,stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        else:launch(path)
        return {'ok':True,'projectId':project_id,'taskId':task_id,'candidateDigest':digest,'message':'已请求打开本任务的候选工程。'}
    except AgentGatewayError:raise
    except Exception as exc:
        code=getattr(exc,'code',None);message=getattr(exc,'message',None)
        if code in ('conflict','invalid_request','not_ready','not_found') and isinstance(message,str):
            raise AgentGatewayError(message,409) from None
        raise AgentGatewayError('候选打开结果未确认；请先检查编辑器窗口再重试。',503) from None

def serve():
    HOME.mkdir(parents=True,exist_ok=True)
    with FileLease(HOME/'controller.lock'):
        token=secrets.token_urlsafe(32);instance=secrets.token_hex(16);manager=Workspace(instance)
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,code,body,content='application/json; charset=utf-8'):
                raw=body if isinstance(body,bytes) else json.dumps(body,ensure_ascii=False).encode()
                self.send_response(code);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(raw)))
                self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
                self.end_headers()
                try:self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            def valid(self):
                origin=self.headers.get('Origin')
                return self.headers.get('Host')==base[7:] and origin in (None,base) and self.headers.get('Authorization')=='Bearer '+token
            def do_GET(self):
                if self.headers.get('Host')!=base[7:]:self.reply(403,{});return
                assets={'/':(PAGE,'text/html; charset=utf-8'),'/app.js':(PAGE.with_name('app.js'),'text/javascript; charset=utf-8'),'/style.css':(PAGE.with_name('style.css'),'text/css; charset=utf-8'),
                    '/topology.css':(PAGE.with_name('topology.css'),'text/css; charset=utf-8'),'/panel-layout.css':(PAGE.with_name('panel-layout.css'),'text/css; charset=utf-8'),'/panel-layout.js':(PAGE.with_name('panel-layout.js'),'text/javascript; charset=utf-8'),
                    '/assets/openplc-logo.png':(PAGE.parent/'assets/openplc-logo.png','image/png'),'/assets/eez-studio-logo.png':(PAGE.parent/'assets/eez-studio-logo.png','image/png')}
                asset_path=parse.urlsplit(self.path).path
                if asset_path in assets:
                    p,mime=assets[asset_path]
                    if not p.is_file():self.reply(404,{});return
                    self.reply(200,p.read_bytes(),mime);return
                if not self.valid():self.reply(403,{});return
                if asset_path=='/api/agent/model/status':
                    from workbench_agent_model import status
                    self.reply(200,status())
                elif asset_path=='/api/agent/tasks':
                    try:
                        query=parse.parse_qs(parse.urlsplit(self.path).query,keep_blank_values=True)
                        if set(query)!={'project'} or len(query['project'])!=1:raise AgentGatewayError('工程查询无效。',400)
                        self.reply(200,agent_tasks(manager,query['project'][0]))
                    except AgentGatewayError as exc:self.reply(exc.status,{'ok':False,'error':str(exc)})
                    except ValueError as exc:self.reply(409,{'ok':False,'error':str(exc)})
                elif asset_path=='/api/status':
                    try:
                        query=parse.parse_qs(parse.urlsplit(self.path).query,keep_blank_values=True)
                        if set(query)-{'project'} or len(query.get('project',[]))>1:raise ValueError('工程查询无效')
                        self.reply(200,manager.snapshot(query.get('project',[None])[0]))
                    except (ValueError,KeyError) as exc:self.reply(409,{'error':str(exc)})
                else:self.reply(404,{})
            def do_POST(self):
                if not self.valid():self.reply(403,{});return
                try:
                    if self.headers.get('Content-Type')!='application/json':raise ValueError('无效请求')
                    length=int(self.headers.get('Content-Length','0'))
                    if self.path.startswith('/api/agent/team/'):
                        if self.headers.get('Origin') is not None or not 0<length<=131072:
                            raise AgentGatewayError('团队入口仅接受本机服务端请求。',403)
                        operation=self.path.removeprefix('/api/agent/team/')
                        if operation not in ('create','create-generation','snapshot','native-task','member','context','report','generate','assemble','effect-start','effect-finish','model'):
                            raise AgentGatewayError('未知团队接口。',404)
                        body=json.loads(self.rfile.read(length))
                        try:
                            if operation=='model':
                                from workbench_team_model import complete as team_complete
                                result=team_complete(body)
                            else:
                                from agent_task_service import ensure,service_call
                                result=service_call(ensure(),'/v1/team/'+operation,body)
                            self.reply(200,result)
                        except Exception as exc:
                            self.reply(409,{'ok':False,'error':getattr(exc,'message','团队操作未确认，请按原请求编号核对。')})
                        return
                    if self.path=='/api/agent/model':
                        if self.headers.get('Origin') is not None or not 0<length<=131072:
                            raise AgentGatewayError('模型入口仅接受本机服务端请求。',403)
                        from workbench_agent_model import complete, ModelBrokerError
                        try:self.reply(200,complete(json.loads(self.rfile.read(length))))
                        except ModelBrokerError as exc:self.reply(409,{'ok':False,'error':str(exc)})
                        except Exception:self.reply(409,{'ok':False,'error':'model-configuration-unavailable'})
                        return
                    if self.path in ('/api/agent/tasks','/api/agent/tasks/open','/api/agent/tasks/review'):
                        if not 0<length<=16384:raise AgentGatewayError('请求过长。',400)
                        body=json.loads(self.rfile.read(length))
                        if not isinstance(body,dict):raise AgentGatewayError('无效请求。',400)
                        result=agent_tasks(manager,body.get('projectId'),body) if self.path=='/api/agent/tasks' else agent_review_candidate(manager,body) if self.path=='/api/agent/tasks/review' else agent_open_candidate(manager,body)
                        self.reply(200,result)
                        return
                    if self.path!='/api/action':raise ValueError('无效请求')
                    if not 0<length<=131072:raise ValueError('请求过长')
                    body=json.loads(self.rfile.read(length))
                    if not isinstance(body,dict):raise ValueError('无效请求')
                    expiry=body.get('expires',0);seq=body.get('sequence');client=body.get('client')
                    if type(expiry) not in (int,float) or not time.time()<=expiry<=time.time()+15:raise ValueError('请求已过期，未执行')
                    if not isinstance(client,str) or not 1<=len(client)<=64 or type(seq)!=int:raise ValueError('无效客户端')
                    with manager.lock:
                        if seq<=manager.clients.get(client,0):raise ValueError('重复请求，未执行')
                        if len(manager.clients)>1024 and client not in manager.clients:raise ValueError('客户端数已达上限')
                        manager.clients[client]=seq
                    self.reply(200,manager.action(body))
                except AgentGatewayError as exc:self.reply(exc.status,{'ok':False,'error':str(exc)})
                except (OSError,ValueError,RuntimeError,KeyError,TimeoutError) as exc:self.reply(409,{'ok':False,'error':str(exc)})
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
        base='http://127.0.0.1:'+str(server.server_port)
        store(DESCRIPTOR,{'base':base,'token':token,'instance':instance,'pid':os.getpid(),'root':str(ROOT)})
        # Lifecycle checks run even after every browser/editor window closes.
        def supervise():
            while True:
                try:manager.snapshot()
                except Exception as exc:manager.event('状态检查失败：'+str(exc))
                time.sleep(.5)
        threading.Thread(target=supervise,daemon=True).start()
        server.serve_forever()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('verb',choices=['serve','ensure','open','start','status'])
    p.add_argument('--mode',choices=['factoryio','mock','local','fuxa-oip','fuxa-local']);p.add_argument('--project',default=DEFAULT_PROJECT_ID);args=p.parse_args()
    if args.verb=='serve':serve();return
    descriptor=ensure()
    if args.project is None:
        args.project=controller_call(descriptor,'/api/status')['project']['id']
    status_path='/api/status?project='+parse.quote(args.project)
    if args.verb=='status':result=controller_call(descriptor,status_path)
    else:
        if args.verb=='start':
            status=controller_call(descriptor,status_path)
            controller_call(descriptor,'/api/action',{'action':'start','projectId':args.project,'sessionId':status['session']['id'],
                'mode':args.mode or status['project']['defaultMode'],'client':'launcher-'+secrets.token_hex(8),'sequence':1,'expires':time.time()+12})
        url=descriptor['base']+'/?project='+parse.quote(args.project)+'#'+descriptor['token']
        result={'ok':True,'url':url,'instance':descriptor['instance']}
        if args.verb in ('open','start'):
            import webbrowser
            webbrowser.open(url)
    # The ensure URL contains only a local ephemeral capability; callers must not log it.
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
