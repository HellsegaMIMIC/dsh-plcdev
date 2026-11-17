"""Pinned, isolated OIP editor observation and guarded native folder handoff.

Only this copy receives the bridge. Native project consent, sandbox and ASAR
integrity remain enabled. No arbitrary renderer evaluation or script endpoint.
"""
from __future__ import annotations
import hashlib
import json
import shutil
import threading
from pathlib import Path

from plcdev_environment import tool_path
from oip_project_bootstrap import (read_asar, asar_entry, write_asar,
    update_integrity_resource, header_hash, integrity_resource)

VERSION = '2026.11.9'
CACHE = Path('F:/PLCdev-build-temp/20261117/oip-editor-runtime')
ASSETS = {'commands-Dw495zma.js':'268b14e3ad7cea24e571cea2cbd920e0278cf09d7ba76099e12279dd17ad435f',
          'sceneFile-igN4MfU8.js':'647181cec17020a2541067d0d1dcc7b4b3e066191d3f1064a9fa603954b8b771',
          'scene-rDPG7kE9.js':'941bbc42767f0aab9e539acec91dbe8ca7b4b53678be191d1dba84f69b18f49a',
          'projectArchive-D8o6KVDK.js':'2db36e357568a028f37e68fbd188b276ac05d6cc9d674fea84b1c02ef21e0699'}
PACKED = {'main.cjs':'1c773063dd0a2bb9de38afc21f1e3bb08372d875b506c8e795e21642f03373eb',
          'preload.cjs':'b9d4d40f260ac057df05a354fdb10508bd4330c57c2e3bc11fd8ba362e0fd6ca'}
LOCK = threading.Lock()
SHARED = Path(__file__).resolve().parents[1] / 'software'

MAIN = r'''
  const plcdevPreview = (() => {
    const module = {exports:{}};
    /* PLCDEV_PREVIEW_CLIENT */
    return module.exports.previewClient(process.env.PLCDEV_NATIVE_PREVIEW);
  })();
  ipcMain.handle('plcdev:preview', async (event, action, revision, folder) => {
    try {
      const profile=app.commandLine.getSwitchValue('user-data-dir');
      // Packaged OIP serves its bundled editor through its own registered
      // scheme, not file://. Keep this narrower than upstream guardIpc's
      // origin check: only the fixed editor page may use preview capabilities.
      const page=new URL(event.senderFrame?.url),expected=new URL(APP_URL);
      if(!app.isPackaged || !profile || !/^[a-f0-9]{64}$/.test(process.env.PLCDEV_OIP_EDITOR_NONCE||'') ||
         realpathSync(profile)!==realpathSync(app.getPath('userData')) ||
         realpathSync(profile)!==realpathSync(process.env.PLCDEV_OIP_PROFILE||'') ||
         event.senderFrame!==event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender) ||
         page.protocol!==expected.protocol || page.host!==expected.host || page.pathname!==expected.pathname ||
         page.username || page.password || page.port)
        throw Error('Invalid preview owner');
      if(process.env.PLCDEV_NATIVE_PREVIEW){
        if(!folder)return {active:true,state:'unknown',label:'等待预览载入',canOpenCurrent:false};
        if(BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()).length!==1 ||
           realpathSync(folder)!==realpathSync(process.env.PLCDEV_OIP_PREVIEW_FOLDER||''))
          return {active:true,state:'unknown',label:'已离开本轮预览 · 请回 DSH 核对',canOpenCurrent:false};
      }
      return await plcdevPreview(action,revision);
    } catch { return {active:true,state:'unknown',label:'预览状态无法核对',canOpenCurrent:false}; }
  });
  // Only an explicitly isolated PLCdev profile can disclose its private bridge nonce.
  ipcMain.on('plcdev:editorIdentity', (event) => {
    try {
      const profile = app.commandLine.getSwitchValue('user-data-dir');
      const nonce = process.env.PLCDEV_OIP_EDITOR_NONCE || '';
      if (!profile || !/^[0-9a-f]{64}$/.test(nonce) ||
          realpathSync(profile) !== realpathSync(app.getPath('userData')) ||
          realpathSync(profile) !== realpathSync(process.env.PLCDEV_OIP_PROFILE || '')) { event.returnValue=null; return; }
      event.returnValue = { nonce, pendingConfirmation: !!globalThis.plcdevOpenConfirmation,
        windowCount: BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length,
        windowId: event.sender.id };
    } catch { event.returnValue=null; }
  });
'''
PRELOAD = r'''
contextBridge.exposeInMainWorld('plcdevEditorIdentity', {
  read: () => ipcRenderer.sendSync('plcdev:editorIdentity'),
  preview: (action, revision, folder) => ipcRenderer.invoke('plcdev:preview',action,revision,folder)
});
'''

# Observe and freeze are synchronous in the renderer event loop. The eventual
# folder switch still goes through native open_project and its main-process
# trust prompt. Native autosave is never used as an observation operation.
RENDERER = r'''
import {p as plcdevArchiveFiles} from './projectArchive-D8o6KVDK.js';
const plcdevBridges = new WeakMap();
let plcdevPreviewStore = null;
function plcdevStable(v) {
  if (Array.isArray(v)) return v.map(plcdevStable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,plcdevStable(v[k])]));
  return v;
}
function plcdevFolder(v) { return String(v||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase(); }
function plcdevInspect(store, session, bridge) {
  const s=store.getState();
  const identity=globalThis.plcdevEditorIdentity?.read();
  const project=store.outgoingProject();
  const files=project?plcdevArchiveFiles(project).map(f=>({path:f.path,
    contents:typeof f.contents==='string'?f.contents:Array.from(f.contents)})):[];
  const normalized=files.map(f=>{let v=f.contents; if(typeof v==='string'&&f.path.endsWith('.json')){try{v=JSON.parse(v)}catch{}}return [f.path,v]}).sort((a,b)=>a[0].localeCompare(b[0]));
  const serialized=JSON.stringify(plcdevStable(normalized));
  if(bridge.serialized!==serialized){bridge.serialized=serialized;bridge.observationKey=crypto.randomUUID()}
  const contentKey=bridge.observationKey;
  const pending=session.pending();
  return {folderPath:s.folderPath||null,running:s.running===true,
    persistPending:store.persistPending===true,folderConflict:!!s.folderConflict,
    folderError:s.folderError||null,folderPaused:!!s.pausedFolder,
    reviewPending:pending.length>0,readOnly:s.readOnly===true,
    packageEditing:!!s.editingDefinition,contentKey,files,
    editingInput:!!document.activeElement?.matches?.('textarea,input:not([type=button]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'),
    dirty:bridge.baseline===null||bridge.baseline!==serialized,
    pendingConfirmation:identity?.pendingConfirmation===true,
    windowCount:identity?.windowCount,windowId:identity?.windowId,
    multipleWindows:identity?.windowCount!==1};
}
function plcdevBlock(s, bridge) {
  if(s.multipleWindows)return 'OIP 打开了多个窗口；请保留本工程窗口后重试同步。';
  if(s.running)return 'OIP 正在运行，请先在工具中结束运行。';
  if(s.persistPending)return 'OIP 尚有正在保存的修改。';
  if(s.folderConflict||s.folderError||s.folderPaused)return 'OIP 文件同步异常，请先在工具中处理。';
  if(s.reviewPending)return 'OIP 中还有未处理的 AI 修改。';
  if(s.packageEditing)return 'OIP 正在编辑部件定义。';
  if(s.editingInput)return 'OIP 中仍有正在编辑的输入框。';
  if(s.readOnly&&!bridge.armed)return 'OIP 当前为只读或协作状态。';
  if(s.dirty)return 'OIP 中已有本地修改，已保留原窗口。';
  return null;
}
function plcdevEditorCall(store,session,args) {
  const identity=globalThis.plcdevEditorIdentity?.read();
  if(!identity||args?.nonce!==identity.nonce)throw new Error('PLCdev editor ownership mismatch');
  let bridge=plcdevBridges.get(store);
  if(!bridge){bridge={baseline:null,armed:null};plcdevBridges.set(store,bridge)}
  const action=args.action||'observe';
  if(action==='release') {
    if(bridge.armed){store.setReadOnly(bridge.armed.readOnly);bridge.cancelledTarget=bridge.armed.target;bridge.armed=null}
  }
  let state=plcdevInspect(store,session,bridge);
  if(action==='accept') {
    if(state.contentKey!==args.contentKey||plcdevFolder(state.folderPath)!==plcdevFolder(args.expectedFolder)||
       state.running||state.persistPending||state.folderConflict||state.folderError||state.folderPaused||state.reviewPending||state.readOnly||state.multipleWindows)
      throw new Error('OIP loaded state changed before acknowledgement');
    bridge.baseline=bridge.serialized;state.dirty=false;
  } else if(action==='arm') {
    if(bridge.armed)throw new Error('OIP is already waiting for a project handoff');
    const reason=plcdevBlock(state,bridge);
    if(reason)throw new Error(reason);
    if(state.contentKey!==args.contentKey||plcdevFolder(state.folderPath)!==plcdevFolder(args.expectedFolder)||typeof args.target!=='string')
      throw new Error('OIP state changed before project handoff');
    bridge.armed={target:args.target,folder:state.folderPath,key:state.contentKey,readOnly:state.readOnly,session};
    bridge.cancelledTarget=null;
    store.setReadOnly(true);
  } else if(!['observe','release'].includes(action))throw new Error('Unknown PLCdev editor operation');
  if(args.compact===true){delete state.files;delete state.contentKey}
  return {...state,armed:!!bridge.armed};
}
function plcdevBeforeOpen(store,root) {
  if(globalThis.plcdevEditorIdentity?.read()?.windowCount!==1)throw new Error('OIP 打开了多个窗口，工程切换已阻止。');
  const bridge=plcdevBridges.get(store);
  if(bridge?.cancelledTarget&&plcdevFolder(root)===plcdevFolder(bridge.cancelledTarget))throw new Error('OIP handoff was cancelled; original editor preserved');
  if(!bridge?.armed)return;
  const s=plcdevInspect(store,bridge.armed.session,bridge);
  const reason=plcdevBlock(s,bridge);
  if(reason||plcdevFolder(root)!==plcdevFolder(bridge.armed.target)||s.contentKey!==bridge.armed.key||
     plcdevFolder(s.folderPath)!==plcdevFolder(bridge.armed.folder))throw new Error(reason||'OIP handoff changed');
}
const plcdevDefinition={name:'plcdev_editor_state',description:'Private owned editor state; requires PLCdev nonce.',inputSchema:{type:'object',properties:{nonce:{type:'string'},action:{type:'string'},target:{type:'string'},expectedFolder:{type:'string'},contentKey:{type:'string'},compact:{type:'boolean'}},required:['nonce'],additionalProperties:false}};
'''

def _replace(text, before, after):
    if text.count(before) != 1:
        raise ValueError('OIP reviewed bridge anchor changed: '+before[:70])
    return text.replace(before, after)

def patches(source):
    source=Path(source)
    header,data=read_asar(source/'resources/app.asar')
    if json.loads(asar_entry(header,data,'package.json'))['version']!=VERSION:
        raise ValueError('OIP version requires bridge review')
    packed={name:asar_entry(header,data,name) for name in PACKED}
    assets={name:(source/'resources/dist/assets'/name).read_bytes() for name in ASSETS}
    for name,raw in {**packed,**assets}.items():
        if hashlib.sha256(raw).hexdigest()!=({**PACKED,**ASSETS})[name]:
            raise ValueError('OIP upstream source changed: '+name)
    main=packed['main.cjs'].decode('utf8')
    shared_client=(SHARED/'native-preview-client.cjs').read_text(encoding='utf-8')
    shared_banner=(SHARED/'native-preview-banner.js').read_text(encoding='utf-8')
    main=_replace(main,"  ipcMain.handle('parts:pickFolder',",MAIN.replace('/* PLCDEV_PREVIEW_CLIENT */',shared_client)+"  ipcMain.handle('parts:pickFolder',")
    main=_replace(main,'  updater = setupUpdater({','  updater = process.env.PLCDEV_OIP_EDITOR_NONCE ? null : setupUpdater({')
    main=_replace(main,'    askToOpen: askAgentOpen,\n  }),\n})', "    askToOpen: askAgentOpen,\n  }).map(tool => ({...tool, run: async (...args) => {\n    if (process.env.PLCDEV_OIP_EDITOR_NONCE && BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length !== 1)\n      return {ok:false,error:'OIP 打开了多个窗口，工程操作已阻止；请保留本工程窗口后重试。'}\n    return tool.run(...args)\n  }})),\n})")
    main=_replace(main,"  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))\n  return response === 0", "  globalThis.plcdevOpenConfirmation = true\n  try {\n    const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))\n    return response === 0\n  } finally { globalThis.plcdevOpenConfirmation = false }")
    preload=packed['preload.cjs'].decode('utf8')
    preload=_replace(preload,"const { contextBridge, ipcRenderer, webUtils } = require('electron')", "const { contextBridge, ipcRenderer, webUtils } = require('electron')\n"+PRELOAD)
    commands=assets['commands-Dw495zma.js'].decode('utf8')
    commands=_replace(commands,'te({store:e,controller:t,shell:s,session:ne},i,a).then', "(i==='plcdev_editor_state'?Promise.resolve().then(()=>({ok:true,value:plcdevEditorCall(e,ne,a)})):globalThis.plcdevEditorIdentity?.read()?.windowCount!==1?Promise.resolve({ok:false,error:'OIP 打开了多个窗口，工具操作已阻止'}):plcdevBridges.get(e)?.armed?Promise.resolve({ok:false,error:'OIP 正在等待工程切换确认'}):te({store:e,controller:t,shell:s,session:ne},i,a)).then")
    commands=_replace(commands,'r.serve(ee())','(plcdevPreviewStore=e,r.serve(globalThis.plcdevEditorIdentity?.read()?[...ee(),plcdevDefinition]:ee()))')
    commands=_replace(commands,'{let t=await De(e,n.root);','{plcdevBeforeOpen(e,n.root);let t=await De(e,n.root);')
    banner=shared_banner+"\ninstallPlcdevPreviewBanner((action,revision)=>globalThis.plcdevEditorIdentity.preview(action,revision,plcdevPreviewStore?.getState()?.folderPath));\n"
    return header,data,{'main.cjs':main.encode(),'preload.cjs':preload.encode()},(RENDERER+banner+commands).encode()

def ensure_runtime():
    """Prepare the pinned F-drive package; never launch, run or alter an installation."""
    with LOCK:
        source=tool_path('oipExecutable').parent
        header,data,packed,commands=patches(source)
        digest=hashlib.sha256(b''.join(packed.values())+commands).hexdigest()
        folder=CACHE/(VERSION+'-'+digest[:12]);exe=folder/'Open Industry Project.exe'
        record=folder/'plcdev-editor-patch.json'
        if folder.exists():
            if not record.is_file() or json.loads(record.read_text(encoding='utf8')).get('digest')!=digest:
                raise ValueError('Incomplete OIP copy preserved for inspection')
            h,d=read_asar(folder/'resources/app.asar')
            if any(asar_entry(h,d,n)!=v for n,v in packed.items()) or (folder/'resources/dist/assets/commands-Dw495zma.js').read_bytes()!=commands:
                raise ValueError('Managed OIP bridge changed')
            if not any(e.get('value')==header_hash(folder/'resources/app.asar') for e in integrity_resource(exe)[1]):
                raise ValueError('Managed OIP ASAR integrity mismatch')
            return exe
        CACHE.mkdir(parents=True,exist_ok=True)
        if any(p.is_symlink() for p in source.rglob('*')):raise ValueError('Linked OIP installation is not supported')
        shutil.copytree(source,folder,ignore=shutil.ignore_patterns('Uninstall *.exe'))
        write_asar(folder/'resources/app.asar',header,data,packed)
        (folder/'resources/dist/assets/commands-Dw495zma.js').write_bytes(commands)
        update_integrity_resource(exe,folder/'resources/app.asar')
        record.write_text(json.dumps({'version':VERSION,'digest':digest,'source':str(source),'upstream':PACKED,'assets':ASSETS},indent=2),encoding='utf8')
        return exe
