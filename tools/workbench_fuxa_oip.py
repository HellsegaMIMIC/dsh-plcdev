"""Project-owned FUXA/OIP tools and the reusable batch-mailbox-v1 Runtime protocol.

Selection is read-only. Every mutation is bound to a project, configuration and
session; the existing standalone demonstration profiles are never reused.
"""
from __future__ import annotations
import argparse,hashlib,json,os,secrets,socket,subprocess,sys,threading,time,webbrowser
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from factoryio_runtime import ROOT,store,sha
from plcdev_environment import tool_path
from plcdev_runtime_owner import FileLease,owner
from workbench_start_stop import LocalProjectManager,source_hashes,read,env,EDITOR,FALLBACK_EDITOR,NO_WINDOW
from launch_fuxa_oip import identity,same_process,OwnedJob,OIP_EXE,open_port
from fuxa_oip_session import prepare as prepare_session
from oip_batch_mcp import call as oip_call,require_open_project,project_path

HOME=ROOT/'outputs/workbench/integrations'
FUXA_PACKAGE=tool_path('fuxaPackage')


def fingerprint(project):
    """Page content is editable live; addresses, definitions and scene are pinned."""
    from workbench_project_config import validate_bindings,validate_oip
    manifest=read(Path(project['manifestPath']))
    if not isinstance(manifest,dict) or manifest.get('id')!=project['id']:raise ValueError('工程唯一标识已改变，请重新打开')
    bindings=read(Path(project['bindingsPath']))
    validate_bindings(bindings)
    scene=validate_oip(Path(project['scene']))
    content={'projectId':project['id'],'application':manifest.get('application'),'target':manifest.get('target'),'hmi':manifest.get('hmi'),'simulation':manifest.get('simulation'),'bindings':bindings,
             'sceneFiles':{path.relative_to(scene['root']).as_posix():sha(path) for path in scene['files']}}
    return hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()


def local_paths(project):
    import re
    if not re.fullmatch(r'user-[0-9a-f]{32}',project.get('id','')):raise ValueError('工程 UUID 无效')
    home=HOME/project['id']
    return {'home':home,'fuxa':home/'fuxa','oip':home/'oip','session':home/'current-session.json'}


def allocate(project):
    """Persistent machine-local ports/profile ownership; no running process touched."""
    paths=local_paths(project);HOME.mkdir(parents=True,exist_ok=True)
    with FileLease(HOME/'profiles.lock',timeout=3):
        paths['home'].mkdir(parents=True,exist_ok=True)
        identity_path=paths['home']/'owner.json'
        expected={'version':1,'projectId':project['id'],'manifestPath':str(Path(project['manifestPath']).resolve())}
        previous=read(identity_path)
        relocating = bool(previous and previous != expected)
        if relocating:
            old_manifest = previous.get('manifestPath') if isinstance(previous, dict) else None
            if (not isinstance(previous, dict) or set(previous) != set(expected)
                    or previous.get('version') != 1 or previous.get('projectId') != project['id']
                    or not isinstance(old_manifest, str) or not Path(old_manifest).is_absolute()
                    or Path(old_manifest).suffix.lower() != '.plcdev' or Path(old_manifest).exists()):
                raise ValueError('相同 UUID 已属于另一工程目录；请复制为新工程，未复用其画面或会话')
            # A real move keeps identity. Never transfer a live tool/session or
            # accept a second existing copy merely because its UUID matches.
            if owner() is not None:
                raise ValueError('Runtime 仍有活动归属；结束后再迁移工程工具')
            for receipt in paths['home'].glob('*.started.json'):
                started = read(receipt)
                if not isinstance(started, dict) or not isinstance(started.get('child'), dict):
                    raise ValueError('工程工具退出记录不完整，未迁移归属')
                if same_process(started['child']):
                    raise ValueError('原工程工具仍在运行，未迁移归属')
        registry_path=HOME/'ports.json';registry=read(registry_path,{})
        if not isinstance(registry,dict):raise ValueError('本机工程端口索引损坏，未分配新端口')
        claimed=set()
        for entry in registry.values():
            if not isinstance(entry,dict) or set(entry)!={'fuxa','mcp','modbus'} or any(type(value) is not int or not 1024<=value<=65535 or value in claimed for value in entry.values()) or len(set(entry.values()))!=3:raise ValueError('本机工程端口索引冲突或损坏，未复用任何端口')
            claimed.update(entry.values())
        ports=registry.get(project['id'])
        if relocating and ports and any(open_port(value) for value in ports.values()):
            raise ValueError('原工程工具端口仍占用，未迁移归属')
        if ports is None:
            reserved={value for item in registry.values() for value in item.values()}
            for base in range(19010,29000,3):
                proposed={'fuxa':base,'mcp':base+1,'modbus':base+2}
                if not reserved.intersection(proposed.values()) and not any(open_port(value) for value in proposed.values()):ports=proposed;break
            else:raise RuntimeError('没有可分配的本机工程端口')
            registry[project['id']]=ports;store(registry_path,registry)
        if set(ports)!={'fuxa','mcp','modbus'} or len(set(ports.values()))!=3 or any(type(v) is not int or not 1024<=v<=65535 for v in ports.values()):raise ValueError('本机工程端口配置无效')
        store(identity_path,expected)
    return paths,ports


def device_mapping(bindings,ports,scene=None):
    value={'schemaVersion':1,'provider':'oip','modbus':{'host':'127.0.0.1','port':ports['modbus'],'unitId':1},'mcp':{'host':'127.0.0.1','port':ports['mcp'],'path':'/mcp'},**json.loads(json.dumps(bindings['oip']))}
    if scene is not None:value['scene']['path']=str(Path(scene).resolve().parent)
    return value


def fuxa_environment(project,config_hash,paths,ports):
    return {'PLCDEV_FUXA_PROJECT_FILE':str(Path(project['hmi']).resolve()),'PLCDEV_FUXA_PROJECT_ID':project['id'],
            'PLCDEV_FUXA_CONFIG_HASH':config_hash,'PLCDEV_FUXA_SESSION_FILE':str(paths['session'])}


def listener_owned(port,child_identity):
    """Check the listener's process ancestry, not merely its banner/project name."""
    from windows_listener_owner import listener_descends_from
    try:
        if not child_identity or not same_process(child_identity):return False
        verified=listener_descends_from(port,child_identity['pid'])
        return verified and same_process(child_identity)
    except (OSError,ValueError,RuntimeError):
        raise ValueError('暂时无法确认本工程工具的端口归属，请稍后重试') from None


class FuxaOipManager(LocalProjectManager):
    run_prefix='workbench-fuxa-oip'

    def __init__(self,instance,project_config,*,oip_setup=None):
        if project_config.get('kind')!='user' or project_config.get('defaultMode')!='fuxa-oip':raise ValueError('需要已配置 FUXA/OIP 的用户工程')
        super().__init__(instance,project_config)
        self.mode='fuxa-oip';self.config_hash=fingerprint(self.project)
        self.paths=local_paths(self.project)
        # A new controller may inspect the same UUID, but cannot inherit a stale
        # session pointer and acquire control of its predecessor's Runtime.
        self.paths['session']=self.paths['home']/('current-session-'+hashlib.sha256(str(instance).encode()).hexdigest()[:16]+'.json')
        self.ports=None;self.allocation_lock=threading.Lock();self.tools={};self.tool_workers={};self.tool_errors={};self.oip_setup=oip_setup
        self.bindings=read(Path(self.project['bindingsPath']))
        self.message='打开本工程画面与场景，编译准备后分别显式运行；工程切换不会结束会话。'

    def allocated(self):
        with self.allocation_lock:
            if self.ports is None:
                session_path=self.paths['session'];self.paths,self.ports=allocate(self.project);self.paths['session']=session_path
        return self.paths,self.ports

    def tools_open(self):
        with self.lock:items=list(self.tools.values())
        return any(item['process'].poll() is None for item in items)

    def tools_starting(self):
        with self.lock:workers=list(self.tool_workers.items())
        return [kind for kind,worker in workers if worker.is_alive()]

    def dependencies(self):
        values=super().dependencies()
        values.extend({'id':key,'label':label,'path':str(path),'available':path.exists()} for key,label,path in (
            ('fuxa','FUXA 本机编辑器',FUXA_PACKAGE/'main.js'),('oip','Open Industry Project',OIP_EXE),
            ('hmi-project','本工程原生画面',Path(self.project['hmi'])),('scene','本工程 OIP 场景',Path(self.project['scene']))))
        return values

    def current_configuration(self):
        try:return fingerprint(self.project)==self.config_hash
        except (OSError,ValueError,KeyError):return False

    def snapshot(self):
        observed=read(self.directory/'state.json',{}) if self.directory else {}
        result=super().snapshot();active=result['session']['active'];fresh=result['observerFresh'];state=result['state']
        if fresh and (observed.get('projectId')!=self.project['id'] or observed.get('configFingerprint')!=self.config_hash):
            fresh=False;result['observerFresh']=False
        changed=not self.current_configuration();result['projectChanged']=result['projectChanged'] or changed
        if not fresh:
            state.update(runtimeState='UNKNOWN',telemetryFresh=False,hmiConnected=False,sceneRunning=None,countKnown=False,values={},variables=[])
            state['communication']={**state.get('communication',{}),'connected':False,'remoteOutputsKnownZero':False}
            if active:
                result['components']['runtime'].update(state='unknown',label='本工程执行状态未知')
                result['links']['load'].update(state='unknown',label='会话身份或装载状态待确认')
        opened=self.tools_open();starting=self.tools_starting();busy=bool(self.worker and self.worker.is_alive()) or self.phase=='stopping'
        locked=opened or active or busy or bool(starting)
        result.update(mode=self.mode,toolsOpen=opened,toolsStarting=starting,toolErrors=dict(self.tool_errors),configurationLocked=locked,configFingerprint=self.config_hash)
        result['session'].update(mode=self.mode,configFingerprint=self.config_hash,runtimeState=state['runtimeState'])
        result['hmiOpen']=bool(self.tools.get('fuxa') and self.tools['fuxa']['process'].poll() is None)
        deps={item['id']:item for item in result['dependencies']};caps=result['capabilities']
        caps.update(canPrepare=not active and not busy and not changed and not result['runtimeOwner'] and all(d['available'] for d in result['dependencies']),
                    canRun=active and fresh and self.phase=='ready' and state['runtimeState']=='STOPPED' and not result['projectChanged'],
                    canStop=active and self.phase=='ready' and state['runtimeState']!='STOPPED',canEnd=(active or opened) and not busy and not starting,
                    canShowHmi=deps['fuxa']['available'] and 'fuxa' not in starting,canOpenHmi=deps['fuxa']['available'] and 'fuxa' not in starting,canReconnectHmi=False,canConfigureProject=not locked)
        caps['tools'].update(fuxa=deps['fuxa']['available'] and 'fuxa' not in starting,eez=deps['fuxa']['available'] and 'fuxa' not in starting,oip=deps['oip']['available'] and 'oip' not in starting,factory=deps['oip']['available'] and 'oip' not in starting)
        if starting:caps['reasons']['canEnd']='正在打开本工程工具，请等待启动收束；仍可停止本工程 PLC。'
        if locked:caps['reasons']['canConfigureProject']='本工程工具或运行会话已打开；先显式结束，确保画面和场景保存。'
        if changed:caps['reasons']['canPrepare']='工程通信配置或场景已改变，请关闭本工程工具并重新打开工程。'
        if active:caps['reasons']['canPrepare']='本工程已有运行会话；重新编译前请显式结束。'
        if not caps['canRun']:caps['reasons']['canRun']='需要本工程有效 STOP 会话且程序、配置未改变'
        if not caps['canStop']:caps['reasons']['canStop']='当前没有需停止的本工程 Runtime'
        for key,tool,label,file in [('eez','fuxa','FUXA 编辑器',self.project['hmi']),('hmi','fuxa','FUXA 运行画面',self.project['hmi']),('factory','oip','OIP 场景',self.project['scene'])]:
            item=self.tools.get(tool);alive=bool(item and item['process'].poll() is None)
            result['components'][key]={'available':deps[tool]['available'],'state':'process-alive' if alive else 'available' if deps[tool]['available'] else 'unavailable','label':'本工程入口已启动' if alive else label+' · 尚未打开','path':deps[tool]['path'],'projectFile':file,'projectId':self.project['id'],'windowVerified':False,'projectOpenVerified':bool(item and item.get('verified') and alive)}
            if tool in starting:result['components'][key].update(state='starting',label='正在打开本工程 '+label)
            elif self.tool_errors.get(tool):result['components'][key].update(state='launch-failed',label=self.tool_errors[tool])
        runtime=state['runtimeState'];comm=state.get('communication',{});channel=fresh and state.get('hmiConnected') is True
        factory=result['components']['factory'];oip_item=self.tools.get('oip')
        scene_verified=bool(oip_item and oip_item.get('verified') and oip_item['process'].poll() is None and not changed)
        if active:
            try:scene_verified=scene_verified and fresh and comm.get('projectIdentityFresh') is True and project_path(comm.get('projectPath'))==project_path(str(Path(self.project['scene']).parent))
            except ValueError:scene_verified=False
        factory.update(sceneIdentityVerified=bool(scene_verified),sceneIdentityVerifiedAt=state.get('observedAt') if scene_verified and active else oip_item.get('verifiedAt') if scene_verified and oip_item else None)
        hmi_verified=bool(result['hmiOpen'] and self.tools['fuxa'].get('verified'))
        links=result['links'];links['generate']={'source':'eez','target':'hmi','state':'current' if hmi_verified else 'unknown' if result['hmiOpen'] else 'unloaded','label':'原生画面 · 编辑与运行共用本工程文件' if hmi_verified else '等待本工程画面身份确认' if result['hmiOpen'] else '画面尚未打开','details':{'projectFile':self.project['hmi'],'provider':'fuxa'}}
        links['variables']={'source':'hmi','target':'runtime','state':'connected' if channel else 'unknown' if active and not fresh else 'disconnected' if active else 'inactive','label':'变量实时' if channel and state['telemetryFresh'] else '通道在线 · 历史值' if channel else '等待本工程画面心跳' if active else '无活动会话','observedAt':state.get('observedAt') if fresh else None,'channelConnected':bool(channel),'dataFresh':bool(channel and state['telemetryFresh']),'dataQuality':'live' if channel and state['telemetryFresh'] else 'historical' if channel and runtime=='STOPPED' else 'unknown','details':{'protocol':'本机 HTTP / PLC 邮箱','sessionId':result['sessionId'],'projectId':self.project['id']}}
        links['io']={'source':'runtime','target':'factory','state':'connected' if fresh and comm.get('connected') else 'unknown' if active and not fresh else 'disconnected' if active else 'inactive','label':'通信在线 · 待人工恢复' if fresh and comm.get('connected') and state.get('requiresManualRecovery') else 'OIP 通信在线' if fresh and comm.get('connected') else '等待 OIP 通信' if active else '无活动会话','observedAt':state.get('observedAt') if fresh else None,'sceneRunning':state.get('sceneRunning') if fresh else None,'requiresManualRecovery':state.get('requiresManualRecovery') if fresh else None,'details':{'protocol':'Modbus TCP','endpoint':'127.0.0.1:'+str(self.ports['modbus']) if self.ports else None,'sceneFile':self.project['scene'],'projectId':self.project['id']}}
        return result

    def start(self,mode='fuxa-oip'):
        if mode!='fuxa-oip':raise ValueError('工程已配置 FUXA/OIP，不能改用其他会话协议')
        with self.lock:
            if self.worker and self.worker.is_alive():raise ValueError('本工程正在准备')
            if self.child and self.child.poll() is None:
                if self.current_configuration() and source_hashes(self.project_directory)==self.identity:self.event('已复用本工程会话');return
                raise ValueError('工程已修改，请先显式结束当前会话')
            if owner():raise ValueError('共享 Runtime 已被其他会话占用；未停止任何工程')
            if not self.current_configuration():raise ValueError('工程配置已改变，请重新打开工程')
            missing=[d['label'] for d in self.dependencies() if not d['available']]
            if missing:raise ValueError('缺少依赖：'+'、'.join(missing))
            self.allocated();self.identity=source_hashes(self.project_directory);self.phase='building';self.failure=None;self.child=None;self.manifest=None;self.sequence=0
            self.directory=ROOT/'outputs/editor-runtime'/(self.run_prefix+'-'+self.project['id'][5:13]+'-'+time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3))
            self.worker=threading.Thread(target=self.build,daemon=True);self.worker.start();self.event('正在编译本工程并核验变量绑定…')

    def build(self):
        try:
            directory=self.directory;directory.mkdir(parents=True)
            store(directory/'project-source-identity.json',{'projectId':self.project['id'],'configFingerprint':self.config_hash,'files':self.identity})
            compiled=self.copy_source(directory);editor=EDITOR if EDITOR.exists() else FALLBACK_EDITOR
            with (directory/'workbench-compile.log').open('wb') as log,(directory/'compile-result.json').open('wb') as answer:
                compiled_result=subprocess.run([str(editor),'--cli','compile',str(compiled),'--target','OpenPLC Runtime v4','--user-data',str(directory/'compiler-profile'),'--json'],cwd=ROOT,env=env(),stdout=answer,stderr=log,creationflags=NO_WINDOW,timeout=180)
            result=read(directory/'compile-result.json',{})
            if compiled_result.returncode or result.get('ok') is not True or result.get('uploaded') is not False:raise RuntimeError('工程编译未确认成功，见 workbench-compile.log')
            if not self.current_configuration() or source_hashes(self.project_directory)!=self.identity:raise RuntimeError('编译期间工程改变，请重新准备')
            mapping=directory/'device.json';store(mapping,device_mapping(self.bindings,self.ports,self.project['scene']));run=directory/'session'
            prepare_session(SimpleNamespace(run_directory=run,project_directory=compiled,device_config=mapping,project_id=self.project['id'],project_name=self.project['name'],compile=False,bindings=self.bindings,config_hash=self.config_hash,manifest_path=self.project['manifestPath']))
            manifest=read(run/'session.json');manifest['originalProjectDirectory']=str(self.project_directory);store(run/'session.json',manifest)
            if not self.current_configuration() or source_hashes(self.project_directory)!=self.identity:raise RuntimeError('准备期间工程改变，请重新准备')
            self.directory=run;self.manifest=manifest
            with (run/'workbench-runtime.log').open('wb') as log:
                self.child=subprocess.Popen([sys.executable,'-B','-X','utf8',str(ROOT/'tools/fuxa_oip_session.py'),'run','--run-directory',str(run),'--parent-pid',str(os.getpid())],cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                if self.child.poll() is not None:raise RuntimeError('本工程 Runtime 未启动，请查看会话日志')
                state=read(run/'state.json',{})
                if state.get('ready') and state.get('sessionId')==manifest['sessionId'] and state.get('configFingerprint')==self.config_hash and state.get('runtimeState')=='STOPPED':break
                time.sleep(.1)
            else:raise RuntimeError('本工程 Runtime 准备超时')
            store(self.paths['session'],manifest);self.phase='ready';self.event('本工程已准备，PLC 保持 STOP；场景与批次均须另行显式启动。')
        except Exception as exc:
            if self.child and self.child.poll() is None:(self.directory/'stop.request').write_text('project preparation failed\n',encoding='utf-8')
            self.phase='fault';self.failure=str(exc);self.event(str(exc))

    def request(self,action,**fields):
        if action not in ('start','stop'):raise ValueError('该适配不提供变量强制写入')
        if self.phase!='ready' or not self.child or self.child.poll() is not None:raise ValueError('本工程没有活动 Runtime')
        self.sequence+=1
        body={'kind':9 if action=='start' else 10,'value':0,'program':self.manifest['programHash'],'sequence':self.sequence,'expires':time.time()+4.5}
        headers={'Content-Type':'application/json','X-PLCdev-Session':self.manifest['sessionId'],'X-PLCdev-Client':'workbench','X-PLCdev-Project':self.project['id'],'X-PLCdev-Config':self.config_hash}
        try:
            with urlopen(Request('http://127.0.0.1:'+str(self.manifest['batchHttpPort'])+'/management',data=json.dumps(body).encode(),headers=headers),timeout=6) as response:result=json.load(response)
        except HTTPError as exc:raise ValueError(json.load(exc).get('error','Runtime 拒绝命令')) from None
        if not result.get('ok'):raise ValueError(result.get('error','Runtime 未确认命令'))
        return result

    def fuxa_context(self):
        with urlopen('http://127.0.0.1:'+str(self.ports['fuxa'])+'/plcdev/context',timeout=2) as response:value=json.load(response)
        if value.get('projectId')!=self.project['id'] or value.get('configHash')!=self.config_hash:raise ValueError('FUXA 工程身份不匹配，未复用其他画面')
        return value

    def spawn_tool(self,kind):
        self.allocated();old=self.tools.get(kind)
        if old and old['process'].poll() is None:return old
        port=self.ports['fuxa' if kind=='fuxa' else 'mcp']
        if open_port(port):raise ValueError('本工程端口被其他进程占用，未接管或结束该进程')
        if not self.current_configuration():raise ValueError('工程配置已改变，请关闭工具后重新打开工程')
        ticket=secrets.token_hex(12);plan_path=self.paths['home']/(kind+'-'+ticket+'.json')
        plan={'version':1,'kind':kind,'ticket':ticket,'projectId':self.project['id'],'parent':identity(os.getpid()),'home':str(self.paths['home']),'port':port}
        if kind=='fuxa':
            plan.update(argv=[sys.executable,'-B','-X','utf8',str(ROOT/'tools/run_fuxa.py'),'--profile',str(self.paths['fuxa']),'--session-file',str(self.paths['session']),'--port',str(port)],environment=fuxa_environment(self.project,self.config_hash,self.paths,self.ports))
        else:
            setup=self.oip_setup
            if setup is None:
                from oip_project_bootstrap import ensure
                setup=ensure
            exe=setup(profile=self.paths['oip'],ports=self.ports,scene=Path(self.project['scene']))
            plan.update(argv=[str(exe),'--user-data-dir='+str(self.paths['oip']),str(Path(self.project['scene']).parent)],environment={'OIP_MCP_PORT':str(port),'OIP_PLCDEV_BOOTSTRAP':str(self.paths['oip']/'plcdev-bootstrap.json')})
        store(plan_path,plan)
        with (self.paths['home']/(kind+'.log')).open('ab') as log:
            child=subprocess.Popen([sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'_tool','--plan',str(plan_path)],cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        item={'process':child,'plan':plan_path,'stop':plan_path.with_suffix('.stop'),'verified':False};self.tools[kind]=item
        return item

    def open_fuxa(self,view='editor'):
        item=self.spawn_tool('fuxa');deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            if item['process'].poll() is not None:raise RuntimeError('本工程 FUXA 未启动，请查看日志')
            try:
                context=self.fuxa_context()
                if context.get('projectFileStatus',{}).get('state')=='ready':
                    self.verify_tool_listener('fuxa');item['verified']=True;break
            except (OSError,ValueError):pass
            time.sleep(.15)
        else:raise RuntimeError('FUXA 尚未确认本工程画面，请检查日志；未打开其他工程')
        url='http://127.0.0.1:'+str(self.ports['fuxa'])+'/'+view
        webbrowser.open(url);self.event('已打开本工程 FUXA '+('运行画面' if view=='home' else '编辑器')+'；未发送 PLC 或场景启动命令')
        return url

    def open_oip(self):
        item=self.spawn_tool('oip');deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if item['process'].poll() is not None:raise RuntimeError('本工程 OIP 未启动')
            try:
                scene=oip_call('get_scene',port=self.ports['mcp'],timeout=.8)
                if scene.get('project')!=self.bindings['oip']['scene']['project']:raise ValueError('OIP 场景身份不同，未切换或复用其他工程')
                require_open_project(oip_call('list_projects',port=self.ports['mcp'],timeout=.8),str(Path(self.project['scene']).parent))
                self.verify_tool_listener('oip')
                item['verified']=True;item['verifiedAt']=time.time();break
            except (OSError,ValueError,RuntimeError):pass
            time.sleep(.15)
        else:raise RuntimeError('OIP 尚未确认本工程目录与场景。若窗口有“打开工程”确认框，请先确认并等待场景加载，再重试；本工程窗口已保留，未启动场景或 PLC。')
        self.event('已打开本工程 OIP，独立通信端口 '+str(self.ports['modbus'])+'；场景运行须显式操作。')

    def verify_tool_listener(self,kind):
        item=self.tools[kind]
        if item.get('listenerVerified'):return
        started=read(item['plan'].with_suffix('.started.json'),{})
        if started.get('projectId')!=self.project['id'] or not listener_owned(self.ports['fuxa' if kind=='fuxa' else 'mcp'],started.get('child')):
            raise ValueError('通信端口不属于本工程工具进程，未使用另一实例')
        item['listenerVerified']=True

    def flush_tools(self):
        item=self.tools.get('fuxa')
        if item and item['process'].poll() is None:
            context=self.fuxa_context()
            request=Request('http://127.0.0.1:'+str(self.ports['fuxa'])+'/plcdev/project/flush',data=b'{}',headers={'Content-Type':'application/json','X-PLCdev-Hmi':context['capability']})
            with urlopen(request,timeout=12) as response:flushed=json.load(response)
            if not flushed.get('ok'):raise ValueError('FUXA 画面尚未确认保存，保留工具供处理')
            if flushed.get('preservedConflict'):self.event('外部工程画面未覆盖；本窗口画面已另存到 '+str(flushed['preservedConflict']))
        item=self.tools.get('oip')
        if item and item['process'].poll() is None:
            scene=oip_call('get_scene',port=self.ports['mcp'],timeout=2)
            if scene.get('project')!=self.bindings['oip']['scene']['project']:raise ValueError('OIP 已打开其他场景，保留窗口，请先处理工程身份')
            require_open_project(oip_call('list_projects',port=self.ports['mcp'],timeout=2),str(Path(self.project['scene']).parent))
            synced=oip_call('sync_folder',port=self.ports['mcp'],timeout=3)
            if synced.get('conflict') or synced.get('folderError'):raise ValueError('OIP 文件保存有冲突，保留窗口供处理')

    def end(self):
        if self.worker and self.worker.is_alive():raise ValueError('正在准备会话，请完成后结束')
        if self.tools_starting():raise ValueError('正在打开本工程工具，请等待启动完成再结束；仍可停止 PLC')
        self.flush_tools()
        super().end()
        if self.paths['session'].exists():self.paths['session'].unlink()
        item=self.tools.get('oip')
        if item and item['process'].poll() is None:oip_call('stop',port=self.ports['mcp'],timeout=3)
        for item in self.tools.values():
            if item['process'].poll() is None:
                item['stop'].write_text('owner ended project tools\n',encoding='utf-8')
                try:item['process'].wait(8)
                except subprocess.TimeoutExpired:raise ValueError('本工程工具尚未退出，保留配置锁，请检查日志') from None
        self.phase='ended';self.event('本工程画面与场景已保存，所属工具和运行会话已结束。')

    def queue_tool(self,kind,view='editor'):
        with self.lock:
            previous=self.tool_workers.get(kind)
            if previous and previous.is_alive():self.event('该工程工具正在打开，未重复启动');return
            self.tool_errors.pop(kind,None)
            def work():
                try:
                    if kind=='fuxa':self.open_fuxa(view)
                    else:self.open_oip()
                except Exception as exc:
                    with self.lock:self.tool_errors[kind]=str(exc)
                    self.event('本工程 '+kind+' 打开失败：'+str(exc))
            worker=threading.Thread(target=work,daemon=True);self.tool_workers[kind]=worker
            worker.start();self.event('正在后台打开本工程 '+kind+'；PLC 停止操作仍可使用。')

    def tool(self,name):
        if name in ('fuxa','eez'):return self.queue_tool('fuxa','editor')
        if name in ('oip','factory'):return self.queue_tool('oip')
        if name=='scene-folder':os.startfile(Path(self.project['scene']).parent);return
        return super().tool(name)

    def action(self,body):
        if body.get('action') in ('open-hmi','show-hmi'):
            with self.action_lock:
                if body.get('projectId')!=self.project['id'] or body.get('sessionId')!=(self.manifest or {}).get('sessionId'):raise ValueError('工程或会话已更换，请刷新')
                if type(body.get('expires')) not in (int,float) or not time.time()<=body['expires']<=time.time()+15:raise ValueError('请求已过期')
                self.queue_tool('fuxa','home');return {'ok':True}
        return super().action(body)


def managed_tool(path):
    path=Path(path).resolve();plan=read(path)
    if not path.is_relative_to(HOME.resolve()) or not isinstance(plan,dict) or plan.get('kind') not in ('fuxa','oip'):raise ValueError('Invalid managed tool plan')
    if Path(plan['home']).resolve()!=path.parent or not same_process(plan['parent']):raise ValueError('Tool owner no longer exists')
    job=OwnedJob();environment=env();environment.update(plan['environment'])
    child=subprocess.Popen(plan['argv'],cwd=ROOT,env=environment,creationflags=NO_WINDOW)
    store(path.with_suffix('.started.json'),{'projectId':plan['projectId'],'ticket':plan['ticket'],'child':identity(child.pid)})
    try:
        while child.poll() is None and not path.with_suffix('.stop').exists() and same_process(plan['parent']):time.sleep(.2)
    finally:
        # Job closure ends only this wrapper's descendants, never another profile.
        store(path.with_suffix('.result.json'),{'projectId':plan['projectId'],'ticket':plan['ticket'],'endedAt':time.time(),'childExitCode':child.poll(),'ownerAlive':same_process(plan['parent'])})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('verb',choices=['_tool']);parser.add_argument('--plan',type=Path,required=True)
    args=parser.parse_args();managed_tool(args.plan)
