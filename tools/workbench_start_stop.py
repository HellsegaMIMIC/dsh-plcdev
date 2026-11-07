"""Shared local Runtime lifecycle, with a bounded latch example specialization."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time
from factoryio_runtime import ROOT, RUNTIME, MSYS, sha, store
from plcdev_runtime_owner import owner
from plcdev_environment import tool_path
from workbench_projects import IGNORED_IMPORT_NAMES, SOURCE_ENTRIES

SOURCE = ROOT/'software/workbench/projects/start-stop'
PROJECT = SOURCE/'project'
EDITOR = tool_path('editor')
FALLBACK_EDITOR = EDITOR
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
SOURCE_PATHS = SOURCE_ENTRIES


def read(path, fallback=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return fallback


def env():
    return {k:v for k,v in os.environ.items() if not k.upper().startswith(('OPENPLC_', 'PYTHON', 'MSYSTEM'))
            and k.upper() not in ('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS')}


def source_files(project):
    """Only the compiler's source inputs; never build products or machine state."""
    project = Path(project).resolve()
    for folder in SOURCE_PATHS:
        source = project/folder
        for path in ([source] if source.is_file() else sorted(source.rglob('*'))):
            if any(part.lower() in IGNORED_IMPORT_NAMES or part.startswith('.')
                   for part in path.relative_to(project).parts):
                continue
            if path.is_file():
                if path.is_symlink() or not path.resolve().is_relative_to(project):
                    raise ValueError('工程源码包含目录外引用：'+path.name)
                yield path


def source_hashes(project):
    project = Path(project).resolve()
    return {p.relative_to(project).as_posix():sha(p) for p in source_files(project)}


def input_adapter():
    spec = importlib.util.spec_from_file_location('workbench_latch_inputs', SOURCE/'monitor_inputs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LocalProjectManager:
    """Project-independent compile/run/watch/stop; no device plugins or input writes."""
    supports_inputs = False
    run_prefix = 'workbench-user'

    def __init__(self, instance, project_config):
        self.instance = instance
        self.project = dict(project_config)
        self.project_directory = Path(self.project['plc']).parent.resolve()
        self.lock = threading.RLock()
        self.action_lock = threading.Lock()
        self.worker = self.child = self.directory = self.manifest = self.identity = None
        self.phase = 'idle'
        self.mode = 'local'
        self.failure = None
        self.message = '打开工程编写程序，然后编译并准备本机 Runtime。'
        self.events = []
        self.sequence = 0
        self.tool_launches = {}

    def event(self, message):
        with self.lock:
            self.message = message
            self.events.append(dict(at=time.time(), message=message, projectId=self.project['id']))
            self.events = self.events[-60:]

    def dependencies(self):
        return [dict(id=key, label=label, path=str(path), available=path.exists()) for key,label,path in (
            ('editor','OpenPLC 编辑器',EDITOR), ('runtime','OpenPLC Runtime',RUNTIME/'CMakeLists.txt'),
            ('msys','本机编译环境',MSYS/'usr/bin/bash.exe'),
            ('project','OpenPLC 工程',self.project_directory/'project.json'))]

    def variables(self, raw, live, historical):
        quality = 'live' if live else 'historical' if historical else 'unknown'
        return [dict(path=item['path'], type=item.get('type',''),
                     value=item.get('value') if live or historical else None,
                     fresh=bool(live), quality=quality)
                for item in raw.get('variables',[]) if isinstance(item,dict) and isinstance(item.get('path'),str)]

    def snapshot(self):
        with self.lock:
            alive = bool(self.child and self.child.poll() is None)
            if self.child and not alive and self.phase not in ('idle','ended','fault'):
                result = read(self.directory/'run-result.json',{})
                self.phase = 'ended' if result.get('result')=='passed' else 'fault'
                self.failure = result.get('error')
                self.event('本工程会话已结束。' if self.phase=='ended' else self.failure or '会话异常结束，请查看日志。')
            raw = read(self.directory/'state.json',{}) if self.directory else {}
            sid = (self.manifest or {}).get('sessionId')
            observed = raw.get('observedAt')
            fresh = bool(alive and self.manifest and raw.get('sessionId')==sid
                         and raw.get('programHash')==self.manifest.get('programHash')
                         and type(observed) in (int,float) and -1<=time.time()-observed<2)
            runtime = raw.get('runtimeState','UNKNOWN') if fresh else 'UNKNOWN'
            live = fresh and raw.get('telemetryFresh') is True and runtime=='RUNNING'
            historical = fresh and runtime=='STOPPED'
            quality = 'live' if live else 'historical' if historical else 'unknown'
            state = dict(raw, projectId=self.project['id'], runtimeState=runtime, telemetryFresh=bool(live),
                         dataQuality=quality, variables=self.variables(raw,live,historical),
                         values=raw.get('values',{}) if live or historical else {},
                         localInputPaths=(self.manifest or {}).get('localInputPaths',[]) if self.supports_inputs else [])
            source_error = None
            try:
                changed = self.identity is not None and source_hashes(self.project_directory)!=self.identity
            except (OSError,ValueError) as exc:
                changed = True
                source_error = str(exc)
            deps = self.dependencies()
            missing = [d['label'] for d in deps if not d['available']]
            busy = bool(self.worker and self.worker.is_alive()) or self.phase=='stopping'
            current = owner()
            external = bool(current and current.get('sessionId')!=sid)
            ready = self.phase=='ready' and alive and not busy
            caps = dict(canPrepare=not busy and not missing and not source_error and not external
                        and (not alive or (fresh and runtime=='STOPPED' and changed)),
                        canRun=ready and fresh and runtime=='STOPPED' and not changed,
                        canStop=ready and runtime!='STOPPED', canEnd=alive and not busy,
                        canInput=self.supports_inputs and ready and live and not changed,
                        canShowHmi=False, canReconnectHmi=False,
                        tools=dict(plc=deps[0]['available'],eez=False,factory=False,logs=True,**{'scene-folder':False}),reasons={})
            if external:
                caps['reasons']['canPrepare']='其他工程或入口占用 Runtime；切换不会停止它。'
            elif missing:
                caps['reasons']['canPrepare']='缺少依赖：'+'、'.join(missing)
            elif source_error:
                caps['reasons']['canPrepare']=source_error
            elif busy:
                caps['reasons']['canPrepare']='正在准备或结束本工程会话'
            elif alive:
                caps['reasons']['canPrepare']='当前工程已有会话；修改程序后先停止再重新编译'
            if not caps['canInput']:
                caps['reasons']['canInput']='先运行本工程 PLC 并等待实时变量；仅允许两个本机输入脉冲' if self.supports_inputs else '用户工程提供只读变量监视'
            if not caps['canRun']:
                caps['reasons']['canRun']='源工程已修改，请重新编译' if changed else '需要准备完成且 PLC 为 STOP'
            if not caps['canStop']:
                caps['reasons']['canStop']='需要本工程活动会话；PLC 已停止时无需重复停止'
            depmap={d['id']:d for d in deps}
            launched=self.tool_launches.get('plc')
            components={'plc':dict(available=depmap['editor']['available'],state='available' if depmap['editor']['available'] else 'unavailable',label='入口可用 · 窗口未确认',path=depmap['editor']['path'],projectFile=str(self.project_directory/'project.json'),windowVerified=False,projectOpenVerified=False),
                        'runtime':dict(available=depmap['runtime']['available'],state='preparing' if self.phase=='building' else 'running' if runtime=='RUNNING' else 'stopped' if runtime=='STOPPED' else 'unknown' if alive else self.phase,label='PLC 运行中' if runtime=='RUNNING' else 'PLC 已停止' if runtime=='STOPPED' else '编译并准备中' if self.phase=='building' else '尚未准备' if not alive else '执行状态未知',path=depmap['runtime']['path'])}
            if launched:
                components['plc'].update(state='process-alive' if launched.poll() is None else 'launch-requested',label='已请求打开 · 工程待窗口确认')
            load='preparing' if self.phase=='building' else 'stale' if alive and changed else 'current' if fresh else 'unknown' if alive else 'unloaded'
            links={'load':dict(source='plc',target='runtime',state=load,label={'preparing':'编译与装载中','stale':'源码已改变','current':'已装载当前程序','unknown':'装载状态待确认','unloaded':'尚未装载'}[load],details=dict(projectFile=str(self.project_directory/'project.json'),programHash=(self.manifest or {}).get('programHash'),sessionId=sid))}
            if self.supports_inputs:
                links['variables']=dict(source='inputs',target='runtime',state='connected' if live or historical else 'unknown' if alive else 'inactive',label='变量实时' if live else '历史值' if historical else '无活动会话' if not alive else '运行中变量未刷新' if fresh and runtime=='RUNNING' else '变量未知',dataQuality=quality,dataFresh=bool(live),details=dict(protocol='本机 Runtime 监视接口',sessionId=sid))
            return dict(service='plcdev-workbench',schemaVersion=3,instance=self.instance,phase=self.phase,message=self.message,error=self.failure,
                        mode='local',runDirectory=str(self.directory) if self.directory else None,sessionId=sid,state=state,observerFresh=fresh,
                        hmiOpen=False,runtimeOwner=current,projectChanged=changed,dependencies=deps,events=list(self.events),
                        project=dict(self.project,opened=True),result=read(self.directory/'run-result.json') if self.directory else None,
                        session=dict(id=sid,projectId=self.project['id'],projectName=self.project['name'],active=alive,phase=self.phase,mode='local',target='本机隔离 Runtime',runtimeState=runtime,programHash=(self.manifest or {}).get('programHash'),runDirectory=str(self.directory) if self.directory else None),
                        components=components,links=links,capabilities=caps)

    def start(self, mode='local'):
        if mode!='local':
            raise ValueError('当前运行目标仅使用本机无设备插件模式')
        replace_session=False
        with self.lock:
            if self.worker and self.worker.is_alive():
                raise ValueError('正在准备本工程会话')
            if self.child and self.child.poll() is None:
                if source_hashes(self.project_directory)==self.identity:
                    self.event('已复用本工程会话。')
                    return
                if self.snapshot()['state']['runtimeState']!='STOPPED':
                    raise ValueError('请先停止本工程 Runtime 再重新编译')
                replace_session=True
        if replace_session:
            self.end()
        with self.lock:
            if owner():
                raise ValueError('已有 Runtime 会话；请在所属工程显式结束，切换不会停止它')
            missing=[d['label'] for d in self.dependencies() if not d['available']]
            if missing:
                raise ValueError('缺少依赖：'+'、'.join(missing))
            self.identity=source_hashes(self.project_directory)
            self.phase='building'
            self.failure=None
            self.child=None
            self.manifest=None
            self.sequence=0
            self.directory=ROOT/'outputs/editor-runtime'/(self.run_prefix+'-'+time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3))
            self.worker=threading.Thread(target=self.build,daemon=True)
            self.event('正在编译「'+self.project['name']+'」并准备隔离 Runtime…')
            self.worker.start()

    def copy_source(self, directory):
        target=directory/'project'
        target.mkdir()
        for relative,digest in self.identity.items():
            source=self.project_directory/relative
            destination=target/relative
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,destination)
            if sha(destination)!=digest:
                raise RuntimeError('复制期间工程修改，请重新准备')
        if source_hashes(target)!=self.identity or source_hashes(self.project_directory)!=self.identity:
            raise RuntimeError('复制期间工程修改，请重新准备')
        return target

    def configure_inputs(self, run, manifest, compiled_project):
        # prepare() knows legacy teaching examples. Generic projects never inherit them.
        manifest['localInputPaths']=[]

    def build(self):
        try:
            directory=self.directory
            directory.mkdir(parents=True)
            store(directory/'project-source-identity.json',dict(projectId=self.project['id'],projectDirectory=str(self.project_directory),files=self.identity))
            compiled_project=self.copy_source(directory)
            editor=EDITOR if EDITOR.exists() else FALLBACK_EDITOR
            with (directory/'workbench-compile.log').open('wb') as log, (directory/'compile-result.json').open('wb') as answer:
                result=subprocess.run([str(editor),'--cli','compile',str(compiled_project),'--target','OpenPLC Runtime v4','--user-data',str(directory/'compiler-profile'),'--json'],cwd=ROOT,env=env(),stdout=answer,stderr=log,creationflags=NO_WINDOW,timeout=180)
            compile_result=read(directory/'compile-result.json',{})
            if result.returncode or compile_result.get('ok') is not True or compile_result.get('uploaded') is not False:
                raise RuntimeError('工程编译未确认成功或非仅编译模式，见 workbench-compile.log')
            if source_hashes(self.project_directory)!=self.identity:
                raise RuntimeError('编译期间工程修改，请重新准备')
            run=directory/'session'
            with (directory/'runtime-prepare.log').open('wb') as log:
                result=subprocess.run([sys.executable,str(ROOT/'tools/editor_runtime_session.py'),'prepare','--project-directory',str(compiled_project),'--mode','local','--run-directory',str(run),'--duration','3600'],cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW,timeout=300)
            if result.returncode:
                raise RuntimeError('隔离 Runtime 构建失败，见 runtime-prepare.log')
            manifest=read(run/'session.json')
            self.configure_inputs(run,manifest,compiled_project)
            manifest.update(projectId=self.project['id'],projectName=self.project['name'],originalProjectDirectory=str(self.project_directory))
            if source_hashes(self.project_directory)!=self.identity:
                raise RuntimeError('准备期间工程修改，请重新准备')
            store(run/'session.json',manifest)
            with self.lock:
                self.directory=run
                self.manifest=manifest
                with (run/'workbench-runtime.log').open('wb') as log:
                    self.child=subprocess.Popen([sys.executable,str(ROOT/'tools/editor_runtime_session.py'),'run','--run-directory',str(run),'--parent-pid',str(os.getpid())],cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                if self.child.poll() is not None:
                    raise RuntimeError('隔离 Runtime 未启动，请查看会话日志')
                if read(run/'state.json',{}).get('ready'):
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('隔离 Runtime 准备超时')
            with self.lock:
                self.phase='ready'
                self.event('本工程已准备，PLC 保持 STOP；点击运行后可监视变量。')
        except Exception as exc:
            with self.lock:
                if self.child and self.child.poll() is None:
                    (self.directory/'stop.request').write_text('preparation failed\n')
                self.phase='fault'
                self.failure=str(exc)
                self.event(str(exc))

    def request(self, action, **fields):
        if self.phase!='ready' or not self.child or self.child.poll() is not None:
            raise ValueError('本工程没有可用运行会话')
        if action=='set-input' and not self.supports_inputs:
            raise ValueError('用户工程仅允许只读变量监视')
        self.sequence+=1
        body=dict(action=action,sequence=self.sequence,sessionId=self.manifest['sessionId'],expectedProgramHash=self.manifest['programHash'],expiresAt=time.time()+4.5,**fields)
        path=self.directory/'requests'/f'{self.sequence:012d}.json'
        store(path,body)
        ack=self.directory/'acks'/path.name
        deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            result=read(ack)
            if result:
                if not result.get('ok'):
                    raise ValueError(result.get('error','Runtime 拒绝操作'))
                return result
            if self.child.poll() is not None:
                raise RuntimeError('所属会话已退出')
            time.sleep(.04)
        raise RuntimeError('Runtime 未及时确认；请查看会话状态')

    def pulse(self, name):
        raise ValueError('用户工程仅允许只读变量监视')

    def end(self):
        if self.worker and self.worker.is_alive():
            raise ValueError('正在准备，请完成后结束')
        if not self.child or self.child.poll() is not None:
            return
        with self.lock:
            self.phase='stopping'
            self.event('正在结束本工程会话…')
        (self.directory/'stop.request').write_text('workbench end local session\n')
        try:
            self.child.wait(22)
        except subprocess.TimeoutExpired:
            raise ValueError('会话清理超时，保留占用，未启动其他工程') from None
        result=read(self.directory/'run-result.json',{})
        if self.child.returncode or result.get('result')!='passed' or not result.get('ownedProcessesExited'):
            with self.lock:
                self.phase='fault'
                self.failure=result.get('error','未确认正常清理')
            raise ValueError(self.failure)
        with self.lock:
            self.phase='ended'
            self.event('本工程 Runtime 与监视进程已退出，资源已释放。')

    def tool(self, name):
        if name=='logs':
            os.startfile(self.directory or ROOT/'outputs/workbench')
            return
        if name!='plc':
            raise ValueError('本工程未配置该组件')
        if not EDITOR.exists():
            raise ValueError('需要支持工程入口的 workbench-r3 编辑器')
        profile=ROOT/'outputs/workbench/editor-profiles'/self.project['id']
        profile.mkdir(parents=True,exist_ok=True)
        launch_env=env()
        launch_env['OPENPLC_ZH_USER_DATA']=str(profile)
        child=subprocess.Popen([str(EDITOR),'--user-data-dir='+str(profile),'--plcdev-project',str(self.project_directory)],cwd=EDITOR.parent,env=launch_env,creationflags=NO_WINDOW,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        with self.lock:
            self.tool_launches['plc']=child
            self.event('已请求打开「'+self.project['name']+'」的 OpenPLC 工程。')

    def action(self, body):
        with self.action_lock:
            if body.get('projectId')!=self.project['id']:
                raise ValueError('请求工程不匹配')
            if 'sessionId' not in body or body['sessionId']!=(self.manifest or {}).get('sessionId'):
                raise ValueError('会话已更换，旧操作已拒绝')
            expiry=body.get('expires',0)
            if type(expiry) not in (int,float) or not time.time()<=expiry<=time.time()+15:
                raise ValueError('请求已过期')
            name=body.get('action')
            if name=='start':
                self.start(body.get('mode','local'))
            elif name=='runtime-start':
                if not self.snapshot()['capabilities']['canRun']:
                    raise ValueError('本工程尚不能运行，请检查准备状态或源码变化')
                self.request('start')
                self.event('本工程 PLC 已运行，变量监视中。')
            elif name=='runtime-stop':
                self.request('stop')
                self.event('本工程 PLC 已停止。')
            elif name=='input':
                self.pulse(body.get('input'))
            elif name=='end':
                self.end()
            elif name=='tool':
                self.tool(body.get('tool'))
            else:
                raise ValueError('本工程不支持该操作')
        return dict(ok=True)


class StartStopManager(LocalProjectManager):
    """Legacy example keeps its two explicitly validated local input pulses."""
    supports_inputs = True
    run_prefix = 'workbench-start-stop'

    def __init__(self, instance, project_config=None):
        super().__init__(instance,project_config or dict(id='start-stop',kind='start-stop',name='启停自锁',description='启动脉冲自锁，停止优先',plc=str(PROJECT/'project.json'),hmi=None,scene=None,target='本机隔离 Runtime',defaultMode='local'))

    def variables(self, raw, live, historical):
        values=raw.get('values',{})
        return {name:values.get('INSTANCE0.'+name.upper()) if live or historical else None for name in ('Start','Stop','Motor')}

    def configure_inputs(self, run, manifest, compiled_project):
        leaves=read(run/'runtime/core/generated/debug-map.json')['leaves']
        program=(run/'runtime/core/generated/program.st').read_text(encoding='utf-8-sig')
        adapter=input_adapter()
        allowed=adapter.counter_input_paths(compiled_project,'local',program,leaves)
        if allowed!=list(adapter.LOCAL_INPUT_PATHS):
            raise RuntimeError('编译程序不符合启停自锁的本机输入约束')
        shutil.copyfile(SOURCE/'monitor_inputs.py',run/'editor_runtime_inputs.py')
        manifest['localInputPaths']=allowed
        manifest['preparedHashes']['editor_runtime_inputs.py']=sha(run/'editor_runtime_inputs.py')
        manifest['patches'].append(dict(file='editor_runtime_inputs.py',scope='private latch session only',source=str(SOURCE/'monitor_inputs.py'),sha256=sha(run/'editor_runtime_inputs.py')))

    def pulse(self, name):
        if name not in ('start','stop'):
            raise ValueError('只允许启动和停止输入脉冲')
        if not self.snapshot()['capabilities']['canInput']:
            raise ValueError('输入脉冲需要本工程 RUN 和实时变量')
        path='INSTANCE0.'+name.upper()
        try:
            self.request('set-input',inputPath=path,value=True)
            time.sleep(.2)
        finally:
            try:
                self.request('set-input',inputPath=path,value=False)
            except Exception:
                try:
                    self.request('stop')
                finally:
                    self.event('输入释放未确认，已请求停止本工程 Runtime；请查看状态。')
                raise
        self.event(('启动' if name=='start' else '停止')+'输入脉冲已发送并释放。')
