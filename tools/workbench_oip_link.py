"""Project-owned OIP editor windows, separate from the PLC/scene Runtime."""
from __future__ import annotations
import hashlib
import copy
import json
import math
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from factoryio_runtime import ROOT,store
from launch_fuxa_oip import identity,open_port
from oip_batch_mcp import call as native_call,require_open_project
from workbench_start_stop import env,NO_WINDOW

PROFILES=Path('F:/PLCdev-build-temp/20261116/oip-editor-sessions')

# OIP 2026.11.9 scene-rDPG7kE9.js Se() rounds integer-step parameters
# before export. The reviewed native belt speedUnitParams declares speedFpm
# step=1, min=-600, max=600. Only this inactive alternate-unit field is admitted
# here, and only for the exact shipped behavior; all observed content is still
# compared in full. This is not a general custom-part normalizer.
_METRIC_BELT_BEHAVIOR = ('4684a251ce88e4739cfe2e9f17dd58200ae0f000a306641939d963d154a37ef8', 73416)

def _same(a,b):
    return bool(a and b and Path(a).resolve()==Path(b).resolve())

def state(value='not_open',message='OIP 尚未打开。',revision=None):
    return dict(state=value,message=message,revision=revision)

def canonical_content(path,contents):
    if path.endswith('.json'):
        return json.loads(contents) if isinstance(contents,str) else json.loads(bytes(contents))
    return contents.replace('\r\n','\n') if isinstance(contents,str) else bytes(contents)


def expected_native_scene(scene,root):
    """Normalize one proven native load representation; never alter observed data."""
    if not isinstance(scene,dict) or scene.get('version')!=4 or not isinstance(scene.get('parts'),list):return scene
    relevant=[part for part in scene['parts'] if isinstance(part,dict) and part.get('type')=='part'
              and part.get('packageId')=='oip.belt-conveyor' and isinstance(part.get('params'),dict)
              and part['params'].get('fpmUnits') is False]
    if not relevant:return scene
    behavior=Path(root)/'parts/oip.belt-conveyor/behavior.js'
    try:
        if behavior.stat().st_size!=_METRIC_BELT_BEHAVIOR[1] or hashlib.sha256(behavior.read_bytes()).hexdigest()!=_METRIC_BELT_BEHAVIOR[0]:return scene
    except OSError:return scene
    result=copy.deepcopy(scene)
    for part in result['parts']:
        if (not isinstance(part,dict) or part.get('type')!='part' or part.get('packageId')!='oip.belt-conveyor'
                or not isinstance(part.get('params'),dict) or part['params'].get('fpmUnits') is not False):continue
        value=part['params'].get('speedFpm')
        if type(value) in (int,float) and math.isfinite(value) and -600<=value<=600:
            # Python round uses ties-to-even; native JS Math.round uses +infinity.
            integer=math.floor(value)
            part['params']['speedFpm']=integer+int(value-integer>=0.5)
    return result


def loaded_content_matches(relative,expected,actual,root):
    expected=canonical_content(relative,expected);actual=canonical_content(relative,actual)
    return expected==actual or relative=='scene.json' and expected_native_scene(expected,root)==actual

def verify_loaded_files(folder,observed,source=None):
    """Compare the native archive serialization with the target, without saving."""
    files=observed.get('files')
    if not isinstance(files,list) or not files:raise ValueError('OIP 未返回可核对的工程内容。')
    root=Path(folder).resolve()
    from workbench_project_config import validate_oip
    expected_root=Path(source or folder).resolve()
    expected={Path(p).relative_to(expected_root).as_posix() for p in validate_oip(expected_root/'project.json',editing=True)['files']}
    seen=set()
    for entry in files:
        relative=entry.get('path','');p=(root/relative).resolve()
        if not isinstance(relative,str) or relative.replace('\\','/')!=relative or '..' in relative.split('/') or relative.casefold() in seen:
            raise ValueError('OIP 返回重复或非规范资源路径。')
        seen.add(relative.casefold())
        # OIP generates its agent guide on export; it is not scene content and
        # can differ between native versions without changing the project.
        if relative=='AGENTS.md':continue
        if not relative or Path(relative).is_absolute() or not p.is_relative_to(root) or not p.is_file():
            raise ValueError('OIP 载入内容与目标工程文件不一致：'+str(relative))
        content=entry.get('contents')
        disk=p.read_text(encoding='utf-8-sig') if isinstance(content,str) else list(p.read_bytes())
        if not loaded_content_matches(relative,disk,content,root):
            raise ValueError('OIP 载入内容与目标版本不一致：'+relative)
        if source is not None:
            original=(Path(source)/relative).resolve()
            if not original.is_relative_to(Path(source).resolve()) or not original.is_file():
                raise ValueError('OIP 导出资源没有对应的源工程文件：'+relative)
            source_content=original.read_text(encoding='utf-8-sig') if isinstance(content,str) else list(original.read_bytes())
            if not loaded_content_matches(relative,source_content,content,source):
                raise ValueError('OIP 工作快照与已保存版本内容不一致：'+relative)
    if not any(x.get('path')=='project.json' for x in files):raise ValueError('OIP 工程身份文件尚未载入。')
    actual={x['path'] for x in files if x['path']!='AGENTS.md'}
    expected.discard('AGENTS.md')
    if actual!=expected:raise ValueError('OIP 载入资源集合不完整或包含另一版本资源。')

def blocker(observed):
    checks=(('multipleWindows','OIP 打开了多个窗口；请保留本工程窗口后重试同步。'),
            ('running','OIP 正在运行；已保留原窗口。'),
            ('persistPending','OIP 中还有正在保存的修改。'),
            ('folderConflict','OIP 文件冲突待处理。'),('folderError','OIP 文件同步异常待处理。'),
            ('folderPaused','OIP 文件同步已暂停。'),('reviewPending','OIP 中还有未处理的 AI 修改。'),
            ('packageEditing','OIP 正在编辑部件定义。'),('editingInput','OIP 中仍有正在编辑的输入框。'),
            ('dirty','OIP 中已有本地修改；已保留原窗口。'))
    for key,message in checks:
        if observed.get(key):return message
    if observed.get('readOnly') and not observed.get('armed'):return 'OIP 处于只读或协作状态。'
    return None

class OipEditorMixin:
    """Uses manager ownership and tool workers; never invokes run/stop/sync_folder."""
    def _oip_set(self,value,message,revision=None):
        self._oip_sync=state(value,message,revision)
        return dict(self._oip_sync)

    def _oip_revision(self):
        from workbench_agent_adapters import _snapshot
        return _snapshot(self.project)['projectRevision']

    def _oip_stage(self,revision,base):
        from workbench_project_config import validate_oip
        scene=Path(self.project['scene']).resolve()
        source=scene.parent
        checked=validate_oip(scene,editing=True)
        folder=Path(base)/'projects'/('version-'+revision[:16]+'-'+secrets.token_hex(4))
        folder.mkdir(parents=True,exist_ok=False)
        for path in checked['files']:
            path=Path(path);target=folder/path.relative_to(source)
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)
        if self._oip_revision()!=revision:raise ValueError('工程在打开期间发生变化，请重新打开。')
        return folder

    def _oip_native(self,item,name,arguments=None,*,timeout=4):
        # The MCP listener must belong to this owned wrapper's child, even if a
        # stale port later points at another local application.
        from workbench_fuxa_oip import listener_owned
        from workbench_start_stop import read
        started=read(item['plan'].with_suffix('.started.json'),{})
        if item['process'].poll() is not None or started.get('projectId')!=self.project['id'] or not listener_owned(item['port'],started.get('child')):
            raise ValueError('OIP 通信端口不属于本工程窗口。')
        return native_call(name,arguments,port=item['port'],timeout=timeout)

    def _oip_call(self,item,action='observe',**arguments):
        result=self._oip_native(item,'plcdev_editor_state',dict(nonce=item['nonce'],action=action,**arguments))
        if not isinstance(result,dict):raise ValueError('OIP 状态应答无效。')
        flags=('running','persistPending','folderConflict','folderPaused','reviewPending','readOnly',
               'packageEditing','editingInput','dirty','pendingConfirmation','armed','multipleWindows')
        if any(type(result.get(key)) is not bool for key in flags) or not isinstance(result.get('contentKey'),str) or not isinstance(result.get('files'),list):
            raise ValueError('OIP 状态字段不完整，未推断为可同步。')
        return result

    def _oip_poll(self,item,*,accept=False):
        with item.setdefault('_sync_lock',threading.RLock()):
            if item.get('_owner',self) is not self or self.tools.get('oip') is not item:
                return dict(getattr(self,'_oip_sync',state()))
            return self._oip_poll_owned(item,accept=accept)

    def _oip_poll_owned(self,item,*,accept=False):
        if item['process'].poll() is not None:
            item['verified']=False
            return self._oip_set('not_open','OIP 窗口已关闭。')
        try:
            if not getattr(self,'current_configuration',lambda:True)() or self._oip_revision()!=item['revision']:
                item['verified']=False
                return self._oip_set('blocked','工程文件已改变，OIP 仍保留先前版本；请重新载入当前工程。',item.get('revision'))
            observed=self._oip_call(item)
            if observed.get('multipleWindows'):
                item['verified']=False
                return self._oip_set('blocked','OIP 打开了多个窗口；请保留本工程窗口后重试同步。',item.get('revision'))
            if observed.get('pendingConfirmation'):
                return self._oip_set('pending_confirmation','请在 OIP 窗口确认打开工程；确认前尚未同步。')
            if not _same(observed.get('folderPath'),item['folder']):
                pending=item.get('handoff')
                if pending and _same(observed.get('folderPath'),pending['fields']['folder']):
                    # A cancelled native prompt must not leave the handle
                    # pointing forever at a version that never loaded.
                    self._oip_call(item,'release')
                    previous=pending['previous']
                    with previous.lock,self.lock:
                        if self.tools.get('oip') is item:del self.tools['oip']
                        previous.tools['oip']=item;item.update(pending['fields']);item['_owner']=previous;item.pop('handoff',None)
                        previous._oip_set('unknown','OIP 保留原版本，正在重新核对。',item['revision'])
                    return self._oip_set('blocked','OIP 未切换版本，原窗口已保留；可重新打开新版本。')
                return self._oip_set('unknown','OIP 正在打开目标版本；如出现弹窗，请在工具中确认。')
            if accept and not item.get('accepted'):
                verify_loaded_files(item['folder'],observed,item.get('sourceFolder'))
                observed=self._oip_call(item,'accept',contentKey=observed['contentKey'],expectedFolder=str(item['folder']))
                item['accepted']=True
                item.pop('handoff',None)
            reason=blocker(observed)
            if reason:
                item['verified']=False
                return self._oip_set('blocked',reason,item.get('revision'))
            if not item.get('accepted'):
                return self._oip_set('unknown','OIP 工程内容仍在核对。')
            require_open_project(self._oip_native(item,'list_projects'),item['folder'])
            item['verified']=True
            return self._oip_set('synced','OIP 已载入对应版本。',item['revision'])
        except Exception as exc:
            item['verified']=False
            return self._oip_set('unknown','OIP 尚未确认同步：'+str(exc))

    def open_oip(self):
        if not self.project.get('scene'):raise ValueError('本工程尚未关联 OIP 场景。')
        if not getattr(self,'current_configuration',lambda:True)():
            item=self.tools.get('oip')
            if item:item['verified']=False
            return self._oip_set('blocked','工程声明已改变，未把旧 OIP 窗口标记为当前版本；请重新载入工程。')
        worker=self.tool_workers.get('oip')
        if worker and worker.is_alive() and worker is not threading.current_thread():
            return dict(getattr(self,'_oip_sync',state('unknown','OIP 正在同步对应版本。')))
        old=self.tools.get('oip')
        if old and old['process'].poll() is None:
            return self._oip_poll(old,accept=True)
        if not self.current_configuration():raise ValueError('工程声明已改变，请重新打开工程。')
        from oip_editor_bridge import ensure_runtime
        executable=ensure_runtime()
        revision=self._oip_revision()
        self.allocated()
        port=self.ports['mcp']
        if open_port(port):raise ValueError('OIP 端口已被占用；未接管其他窗口。')
        ticket=secrets.token_hex(12);base=PROFILES/ticket
        profile=base/'profile';profile.mkdir(parents=True,exist_ok=False)
        folder=self._oip_stage(revision,base);nonce=secrets.token_hex(32)
        plan_path=self.paths['home']/('oip-editor-'+ticket+'.json')
        from workbench_preview_status import preview_environment
        plan={'version':1,'kind':'oip','ticket':ticket,'projectId':self.project['id'],
              'parent':identity(os.getpid()),'home':str(self.paths['home']),'port':port,
              'argv':[str(executable),'--user-data-dir='+str(profile)],
              'environment':{'OIP_MCP_PORT':str(port),'OIP_PROJECTS_DIR':str(base/'projects'),
                'PLCDEV_OIP_EDITOR_NONCE':nonce,'PLCDEV_OIP_PROFILE':str(profile),
                'PLCDEV_OIP_PREVIEW_FOLDER':str(folder),**preview_environment(self.project)}}
        store(plan_path,plan)
        with (self.paths['home']/'oip-editor.log').open('ab') as log:
            child=subprocess.Popen([sys.executable,'-B','-X','utf8',str(ROOT/'tools/workbench_fuxa_oip.py'),'_tool','--plan',str(plan_path)],
                cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        item={'process':child,'plan':plan_path,'stop':plan_path.with_suffix('.stop'),'port':port,'nonce':nonce,
              'base':base,'folder':folder,'sourceFolder':Path(self.project['scene']).parent,
              'revision':revision,'verified':False,'accepted':False,'editorBridge':True,
              '_owner':self,'_sync_lock':threading.RLock()}
        self.tools['oip']=item
        self._oip_set('unknown','OIP 正在打开对应版本；如出现弹窗，请在工具中确认。')
        deadline=time.monotonic()+18
        requested=False
        while time.monotonic()<deadline and child.poll() is None:
            if not requested:
                try:
                    listing=self._oip_native(item,'list_projects',timeout=2)
                    if not any(_same(x.get('path'),folder) for x in listing.get('projects',[])):
                        raise ValueError('OIP 私有工程列表未包含目标场景。')
                    requested=True
                    self._oip_native(item,'open_project',{'project':str(folder)},timeout=12)
                except Exception as exc:
                    self._oip_set('unknown','OIP 正在打开：'+str(exc))
                    if not requested:time.sleep(.3);continue
            result=self._oip_poll(item,accept=True)
            if result['state'] in ('synced','blocked','pending_confirmation'):return result
            time.sleep(.3)
        return dict(self._oip_sync)

    def adopt_oip(self,previous):
        """Start a guarded handoff only for this project's existing editor."""
        prior_worker=getattr(previous,'tool_workers',{}).get('oip')
        if prior_worker and prior_worker.is_alive() and prior_worker is not threading.current_thread():
            self._oip_set('unknown','上一次 OIP 版本交接尚未结束，正在按顺序同步。')
            def after_prior():
                prior_worker.join(45)
                if prior_worker.is_alive():
                    self._oip_set('blocked','上一次 OIP 版本交接仍在等待；原窗口已保留，可打开当前版本。')
                    return
                self.adopt_oip(previous)
                if 'oip' not in self.tools and 'oip' not in getattr(previous,'tools',{}) and self.tool_workers.get('oip') is threading.current_thread():
                    previous_state=getattr(previous,'_oip_sync',{})
                    if previous_state.get('state') in ('blocked','unknown','pending_confirmation'):
                        self._oip_set('blocked','上一次 OIP 版本没有完成同步；原窗口已保留，可打开当前版本。')
                    else:self._oip_set('not_open','OIP 尚未打开。')
            worker=threading.Thread(target=after_prior,daemon=True)
            self.tool_workers['oip']=worker;worker.start();return
        item=getattr(previous,'tools',{}).get('oip')
        if not item or item['process'].poll() is not None:return
        if not item.get('editorBridge'):
            self._oip_set('blocked','旧 OIP 窗口不能安全核对草稿；保留窗口，可打开新版本。');return
        if previous.project['id']!=self.project['id'] or not _same(previous.project['manifestPath'],self.project['manifestPath']):
            self._oip_set('blocked','OIP 工程归属不一致，未切换原窗口。');return
        self._oip_set('unknown','工程已保留，正在核对 OIP 窗口。')
        def handoff_locked():
            armed=False
            old_fields={key:item.get(key) for key in ('folder','revision','accepted','verified','sourceFolder')}
            try:
                observed=previous._oip_call(item)
                if not _same(observed.get('folderPath'),item['folder']):raise ValueError('OIP 已打开其他工程，保留原窗口。')
                reason=blocker(observed)
                if reason:raise ValueError(reason)
                revision=self._oip_revision();folder=self._oip_stage(revision,item['base'])
                previous._oip_call(item,'arm',target=str(folder),expectedFolder=str(item['folder']),contentKey=observed['contentKey']);armed=True
                # Move only the verified owned handle, never another user's window.
                with previous.lock,self.lock:
                    if previous.tools.get('oip') is not item:raise ValueError('OIP 窗口归属已改变。')
                    del previous.tools['oip'];self.tools['oip']=item;item['_owner']=self
                    previous._oip_set('not_open','OIP 窗口已移交新保存版本。')
                    item.update(folder=folder,sourceFolder=Path(self.project['scene']).parent,
                                revision=revision,accepted=False,verified=False)
                    item['handoff']={'previous':previous,'fields':old_fields}
                self._oip_set('unknown','OIP 正在切换版本；如出现弹窗，请在工具中确认。')
                self._oip_native(item,'open_project',{'project':str(folder)},timeout=30)
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    result=self._oip_poll(item,accept=True)
                    if result['state'] in ('synced','blocked','pending_confirmation'):return
                    time.sleep(.3)
            except Exception as exc:
                self._oip_set('blocked' if not armed else 'unknown',str(exc)+'；原窗口和修改均已保留。')
                # Cancellation/failure unlocks the original editor. Never save,
                # discard, stop or kill it merely to complete synchronization.
                if armed:
                    try:
                        observed=self._oip_call(item)
                        if observed.get('pendingConfirmation'):
                            self._oip_set('pending_confirmation','请在 OIP 窗口确认切换；原窗口仍受保护。');return
                        if _same(observed.get('folderPath'),old_fields['folder']):
                            self._oip_call(item,'release')
                            with previous.lock,self.lock:
                                if self.tools.get('oip') is item:del self.tools['oip']
                                previous.tools['oip']=item;item.update(old_fields);item['_owner']=previous;item.pop('handoff',None)
                                previous._oip_set('unknown','OIP 保留原版本，正在重新核对。',item['revision'])
                            self._oip_set('blocked','OIP 未切换版本，原窗口和本地修改已保留；可重新打开新版本。')
                    except Exception:pass
        def handoff():
            with item.setdefault('_sync_lock',threading.RLock()):
                if item.get('_owner',previous) is not previous or previous.tools.get('oip') is not item:
                    self._oip_set('blocked','OIP 窗口归属已改变，未重复切换。');return
                handoff_locked()
        worker=threading.Thread(target=handoff,daemon=True)
        self.tool_workers['oip']=worker;worker.start()

    def oip_sync(self,refresh=True):
        item=self.tools.get('oip')
        if not item:return dict(getattr(self,'_oip_sync',state()))
        if item['process'].poll() is not None:return self._oip_set('not_open','OIP 窗口已关闭。')
        running=self.tool_workers.get('oip')
        last=getattr(self,'_oip_observed_at',0)
        poller=getattr(self,'_oip_poller',None)
        if refresh and (not running or not running.is_alive()) and (not poller or not poller.is_alive()) and time.monotonic()-last>2:
            self._oip_observed_at=time.monotonic()
            self._oip_poller=threading.Thread(target=lambda:self._oip_poll(item,accept=True),daemon=True);self._oip_poller.start()
        return dict(getattr(self,'_oip_sync',state('unknown','OIP 状态正在核对。')))

    def oip_snapshot(self,result):
        from plcdev_environment import tool_path
        scene=self.project.get('scene');available=bool(scene and tool_path('oipExecutable').is_file())
        if result.get('projectChanged'):
            item=self.tools.get('oip')
            if item:item['verified']=False
            sync=self._oip_set('blocked','工程文件已改变，OIP 尚未载入当前内容。')
        else:sync=self.oip_sync()
        result['oipSync']=sync
        item=self.tools.get('oip');alive=bool(item and item['process'].poll() is None)
        starting=bool(self.tool_workers.get('oip') and self.tool_workers['oip'].is_alive())
        result['toolsOpen']=result.get('toolsOpen',False) or alive
        result['configurationLocked']=result.get('configurationLocked',False) or alive or starting
        caps=result['capabilities'];caps.setdefault('tools',{});caps.setdefault('reasons',{})
        caps['tools'].update(oip=available and not starting,factory=available and not starting)
        caps['canConfigureOip']=self.project.get('kind')=='user' and self.project.get('defaultMode')!='fuxa-oip' and not result.get('configurationLocked',False) and self.project.get('simulation',{}).get('provider')!='local-model'
        if not caps['canConfigureOip']:
            caps['reasons']['canConfigureOip']=(
                '当前数值模型已占用仿真配置，不能直接替换为 OIP 场景。' if self.project.get('simulation',{}).get('provider')=='local-model' else
                '先结束本工程工具和运行会话，再更换场景。')
        if self.project.get('simulation',{}).get('provider')=='oip':
            caps['reasons']['oipRuntime']='OIP 场景编辑可用；通用 OIP 与 PLC 联动运行尚未接通。'
        if scene:
            result['components']['factory']={'available':available,'state':'process-alive' if alive else 'available' if available else 'unavailable',
                'label':sync['message'],'path':str(tool_path('oipExecutable')),'projectFile':scene,
                'projectId':self.project['id'],'projectOpenVerified':sync['state']=='synced','windowVerified':False}
            result['components']['oip']=dict(result['components']['factory'])
        return result

    def assert_oip_idle_for_close(self):
        item=self.tools.get('oip')
        if item and item.get('editorBridge') and item['process'].poll() is None:
            reason=blocker(self._oip_call(item))
            if reason:raise ValueError(reason+' 请在 OIP 中处理或自行关闭窗口后重试。')
