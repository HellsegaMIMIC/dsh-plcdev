import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

const ID=/^[a-z][a-z0-9-]{0,63}$/,SID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const TASK=/^task-[0-9a-f]{32}$/,HASH=/^[0-9a-f]{64}$/,REQUEST=/^[A-Za-z0-9_-]{1,100}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const text=m=>(m?.content||[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
const normalized=v=>path.resolve(v).replaceAll('\\','/').toLowerCase();
class EditorError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
const fail=(status,code,message)=>{throw new EditorError(status,code,message);};
function fields(v,required,optional=[]){if(!object(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))fail(400,'invalid_request','编辑器请求字段无效。');}
function sessionIdentity(inspection,id){if(inspection?.meta?.id!==id||inspection.meta.origin==='subagent'||!Array.isArray(inspection.events))fail(409,'session_mismatch','关联主会话身份无法核对。');return inspection;}
function selectedModel(inspection,host){
  const session=host.sessions?.get?.(inspection.meta.id)||host.agents?.get?.(inspection.meta.id)?.session;
  let selected;
  try{const state=session&&host.sessionProjections?.stateOf(session,'modelSelection');selected=state?.pending||state?.next||state?.lastUsed;}catch{}
  if(!selected)for(const e of inspection.events){if(e.type==='model/selection')selected=e.data;else if(e.type==='request/header')selected=e.data?.header?.config;}
  if(typeof selected?.provider!=='string'||typeof selected?.model!=='string')return null;
  return {provider:selected.provider,model:selected.model,...(typeof selected.reasoningEffort==='string'?{reasoningEffort:selected.reasoningEffort}:{})};
}
export function editorMessages(events){
  const rows=[];let turn=0;
  for(const e of events){
    if(e.type==='turn/start')turn=e.data.turn;
    const m=e.type==='user/message'?e.data:e.type==='assistant/message'?e.data?.message:null;
    if(!m||e.type==='user/message'&&m.source?.kind!=='user')continue;
    const value=text(m);if(!value)continue;
    rows.push({id:m.id||'event-'+e.seq,role:e.type==='user/message'?'user':'assistant',text:value.slice(0,16000),turn:e.data?.turn??turn,...(value.length>16000?{truncated:true}:{})});
  }
  return rows.slice(-100);
}
function taskSummary(task,sourceSessionId){return {taskId:task.taskId,projectId:task.projectId,status:task.status,request:String(task.request||'').slice(0,4000),
  summary:String(typeof task.candidate?.summary==='string'?task.candidate.summary:task.candidate?.summary?.after||'').slice(0,2000),
  candidateDigest:task.candidate?.candidateDigest||null,changedFiles:(task.candidate?.changedFiles||task.candidate?.changes?.map(c=>c.path)||[]).filter(v=>typeof v==='string').slice(0,100).map(v=>v.slice(0,512)),
  ...(task.retention?{retention:{keptProjectId:task.retention.keptProjectId||task.retention.projectId,revision:task.retention.revision}}:{}),
  ...(task.compilation?{compilation:{status:task.compilation.status}}:{}),sourceSessionId};}

/** A second view onto the *same* ordinary DSH session. Never an API-key proxy or
 * a second local editor agent loop. Tokens grant only one project/session pair. */
export function createEditorBridge({controllerFile,bridge,conversations,getHost,getOrigin,getToolNotice=()=>null,now=Date.now}){
  const file=path.join(path.dirname(controllerFile),'dsh-editor.sqlite'),grants=new Map(),opening=new Map(),linking=new Map(),sending=new Map(),streams=new Map();
  let navigation=null,disposed=false;
  function dbRun(fn){mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);try{
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS editor_sessions(source_session TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,phase TEXT NOT NULL,PRIMARY KEY(source_session,project_id));
      CREATE TABLE IF NOT EXISTS editor_requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,rpc_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id));
      CREATE TABLE IF NOT EXISTS editor_launches(launch_id TEXT PRIMARY KEY,source_session TEXT NOT NULL,payload TEXT NOT NULL);`);
    const columns=new Set(db.prepare('PRAGMA table_info(editor_requests)').all().map(row=>row.name));
    if(!columns.has('project_id'))db.exec('ALTER TABLE editor_requests ADD COLUMN project_id TEXT');
    if(!columns.has('binding_version'))db.exec('ALTER TABLE editor_requests ADD COLUMN binding_version INTEGER');
    return fn(db);
  }finally{db.close();}}
  function host(){const h=getHost();if(disposed||!h?.sessionQuery?.readSession||!h?.sessionController?.prompt||!h?.sessionPersistence?.open||!h?.sessions?.flush)fail(503,'host_unavailable','DSH 会话服务未连接，请重新打开 DSH 后从工程入口连接。');return h;}
  function checkBinding(g){const b=conversations.snapshot(g.sessionId);if(b.projectId!==g.projectId||b.version!==g.bindingVersion)fail(409,'binding_changed','DSH 会话已切换工程，请从当前工程重新打开编辑器。');return b;}
  async function inspect(id,h=host()){const read=await h.sessionQuery.readSession(id);return sessionIdentity({meta:read.session,events:read.events},id);}
  async function ensureWorkspace(id,title,h,observed){
    const value=observed||await inspect(id,h),cwd=value.meta.cwd;
    if(typeof cwd!=='string'||!path.isAbsolute(cwd)||typeof h.workspaceRegistry?.create!=='function')fail(503,'workspace_unavailable','关联会话的工作区尚未就绪，未打开不可输入的会话。');
    const workspace=await h.workspaceRegistry.create(cwd,title);
    await workspace.attachSession(id);
    if(!workspace.sessionIds.includes(id))fail(503,'workspace_unavailable','会话尚未登记到工程工作区，请重新进入。');
    return workspace.id;
  }
  async function listTasks(id,projectId){const binding=conversations.snapshot(id),result=await bridge.handle('GET','/api/plcdev/task-state?project='+encodeURIComponent(projectId));
    if(result.status!==200||result.body.projectId!==projectId||!Array.isArray(result.body.tasks))fail(503,'tasks_unavailable','工程修改进度暂不可读取。');
    return {binding,revision:result.body.projectRevision,tasks:result.body.tasks.filter(t=>binding.taskRefs.some(r=>r.taskId===t.taskId&&r.projectId===projectId))};}
  async function ownedTask(input){
    if(!SID.test(input.conversationId||'')||!ID.test(input.projectId||''))fail(400,'invalid_identity','请选择关联的工程会话。');
    const b=conversations.snapshot(input.conversationId);
    if(!b.taskRefs.some(r=>r.projectId===input.projectId&&r.taskId===input.taskId))fail(403,'task_not_in_conversation','此修改不属于当前会话。');
    const listing=await listTasks(input.conversationId,input.projectId),task=listing.tasks.find(t=>t.taskId===input.taskId);
    if(!task||task.candidate?.candidateDigest!==input.candidateDigest)fail(409,'candidate_changed','候选身份已变化，请重新读取。');
    return task;
  }
  async function linkedSession(sourceId,prepared,source,h){
    const key=sourceId+':'+prepared.projectId;if(linking.has(key))return linking.get(key);
    const pending=createLinkedSession(sourceId,prepared,source,h);linking.set(key,pending);
    try{return await pending;}finally{if(linking.get(key)===pending)linking.delete(key);}
  }
  async function createLinkedSession(sourceId,prepared,source,h){
    if(prepared.mode==='preview'||prepared.projectId===conversations.snapshot(sourceId).projectId)return sourceId;
    let row=dbRun(db=>{db.prepare('INSERT OR IGNORE INTO editor_sessions VALUES(?,?,?,?)').run(sourceId,prepared.projectId,randomUUID(),'creating');return db.prepare('SELECT * FROM editor_sessions WHERE source_session=? AND project_id=?').get(sourceId,prepared.projectId);});
    if(row.phase==='ready'){
      const observed=await inspect(row.session_id,h);if(conversations.snapshot(row.session_id).projectId!==prepared.projectId)fail(409,'linked_session_changed','修改副本的关联会话已切换工程，请使用该工程的现有会话重新打开。');
      await ensureWorkspace(row.session_id,prepared.projectName,h,observed);return row.session_id;
    }
    let exists=false;
    try{await inspect(row.session_id,h);exists=true;}catch(error){if(!['session/not-found','SESSION_QUERY_SESSION_NOT_FOUND'].includes(error?.code)&&!/not found|不存在/.test(error?.message||''))throw error;}
    let agentPreset;for(const e of source.events)if(e.type==='agent-preset/selected')agentPreset=e.data?.agentPreset;
    if(!exists){
      if(typeof h.workspaceRegistry?.create!=='function')fail(503,'workspace_unavailable','DSH 工作区服务尚未就绪，未创建不可输入的会话。');
      const workspace=await h.workspaceRegistry.create(path.dirname(prepared.nativeProjectPath),prepared.projectName);
      const created=await h.sessionController.create({sessionId:row.session_id,workspaceId:workspace.id,...(typeof agentPreset==='string'?{agentPreset}:{})});if(created?.sessionId!==row.session_id)fail(409,'session_creation_unknown','副本会话创建身份无法确认，未发送需求。');
    }
    await ensureWorkspace(row.session_id,prepared.projectName,h);
    const current=conversations.snapshot(row.session_id);
    if(current.projectId!==null&&current.projectId!==prepared.projectId)fail(409,'binding_changed','目标会话已关联其他工程，未重新绑定。');
    const model=selectedModel(source,h);if(!model)fail(409,'model_unavailable','来源会话尚未选择模型，请在 DSH 选择后重新打开。');
    await h.sessionController.selectModel({sessionId:row.session_id,...model});
    // Permissions are session-scoped in 0.2.2. Inherit through the host's
    // canonical setter (including Auto admission), never copy login state or
    // silently fall back to the user's possibly broader future-session default.
    const permission=h.get?.('permissionPresets');
    if(permission){
      const resolved=await h.sessionController.resolveAgent(sourceId);if(resolved.error)throw resolved.error;
      const target=h.sessions.get?.(row.session_id)||h.agents.get(row.session_id)?.session;
      const selected=permission.current(resolved.agent.session);
      if(selected==='custom'){
        const a=permission.permissionState(resolved.agent.session),b=permission.permissionState(target);
        if(a.sandbox!==b.sandbox||a.approval!==b.approval)fail(409,'custom_permissions','来源使用自定义权限；请在 DSH 为副本选择同等权限后继续。');
      }else permission.set(target,selected);
    }else if(source.events.some(e=>['permission/preset','sandbox/mode','approval/policy'].includes(e.type)))fail(503,'permission_service_unavailable','来源会话的权限服务暂不可用，未使用其他默认权限。');
    if(current.projectId===null){const bound=await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:row.session_id,projectId:prepared.projectId,expectedVersion:current.version});if(bound.status!==200)fail(bound.status,'binding_failed',bound.body.error||'副本会话未能关联。');}
    if(typeof h.sessionController.rename==='function')await h.sessionController.rename({sessionId:row.session_id,title:(prepared.projectName||'修改工程')+' · 继续修改'});
    const live=h.sessions.get?.(row.session_id)||h.agents.get(row.session_id)?.session;
    if(!live||await h.sessions.flush(live)!==true)fail(503,'session_creation_unknown','副本会话尚未确认保存，请核对后重试打开。');
    dbRun(db=>db.prepare("UPDATE editor_sessions SET phase='ready' WHERE source_session=? AND project_id=? AND session_id=?").run(sourceId,prepared.projectId,row.session_id));
    return row.session_id;
  }
  function resultReferences(g){return g.resultReferences||((g.sourceTaskId||g.taskId)?[{taskId:g.sourceTaskId||g.taskId,candidateDigest:g.candidateDigest}]:[]);}
  function resultReference(g,taskId){
    const reference=resultReferences(g).find(ref=>ref.taskId===taskId&&HASH.test(ref.candidateDigest||''));
    if(!reference)fail(403,'task_not_in_launch','此修改未关联到该编辑器窗口。');return reference;
  }
  function registerResult(g,input){
    if(!input.taskId)return;
    const refs=resultReferences(g),previous=refs.find(ref=>ref.taskId===input.taskId);
    if(previous&&previous.candidateDigest!==input.candidateDigest)fail(409,'candidate_changed','此窗口的修改引用已变化，请重新核对。');
    g.resultReferences=previous?refs:[...refs,{taskId:input.taskId,candidateDigest:input.candidateDigest}];
  }
  function publicLaunch(g,reference=g.sourceTaskId?{taskId:g.sourceTaskId,candidateDigest:g.candidateDigest}:null){return {ok:true,launchId:g.launchId,projectId:g.projectId,targetProjectId:g.projectId,sourceProjectId:g.sourceProjectId,
    sessionId:g.sessionId,conversationId:g.sessionId,sourceConversationId:g.sourceSessionId,projectName:g.projectName,nativeProjectPath:g.nativeProjectPath,
    ...(reference?{taskId:reference.taskId,candidateDigest:reference.candidateDigest}:{}),revision:g.revision,mode:g.mode,state:g.editor.state,editor:{...g.editor},...(g.openError?{error:g.openError}:{})};}
  function saveLaunch(g){const value={...publicLaunch(g),resultReferences:resultReferences(g)};dbRun(db=>db.prepare('INSERT INTO editor_launches VALUES(?,?,?) ON CONFLICT(launch_id) DO UPDATE SET payload=excluded.payload').run(g.launchId,g.sourceSessionId,JSON.stringify(value)));}
  async function open(input,sessionOnly=false){
    fields(input,['conversationId','projectId','target'],['taskId','candidateDigest']);
    if(!SID.test(input.conversationId||'')||!ID.test(input.projectId||'')||!['candidate','retained','project'].includes(input.target))fail(400,'invalid_request','编辑器目标无效。');
    let owned;
    if(input.target==='project'){if(input.taskId!==undefined||input.candidateDigest!==undefined||conversations.snapshot(input.conversationId).projectId!==input.projectId)fail(409,'binding_changed','请从该工程关联会话打开。');}
    else{if(!TASK.test(input.taskId||'')||!HASH.test(input.candidateDigest||''))fail(400,'invalid_request','候选身份无效。');owned=await ownedTask(input);}
    const key=sha(JSON.stringify({input,sessionOnly}));if(opening.has(key))return opening.get(key);
    const operation=(async()=>{
      const h=host(),source=await inspect(input.conversationId,h);
      const kept=owned?.retention?.keptProjectId;
      if(sessionOnly&&ID.test(kept||'')){
        const row=dbRun(db=>db.prepare("SELECT * FROM editor_sessions WHERE source_session=? AND project_id=? AND phase='ready'").get(input.conversationId,kept));
        if(row){
          const observed=await inspect(row.session_id,h);if(conversations.snapshot(row.session_id).projectId!==kept)fail(409,'linked_session_changed','修改副本的关联会话已切换工程，请使用副本当前会话。');
          const current=await bridge.handle('GET','/api/plcdev/status?project='+encodeURIComponent(kept));
          if(current.status!==200||current.body.project?.id!==kept)fail(409,'project_unavailable','修改副本目前不可读取，未定位其他工程。');
          const workspaceId=await ensureWorkspace(row.session_id,current.body.project.name,h,observed);
          return {status:200,body:{ok:true,sourceProjectId:input.projectId,sourceConversationId:input.conversationId,taskId:input.taskId,candidateDigest:input.candidateDigest,targetProjectId:kept,projectId:kept,sessionId:row.session_id,workspaceId}};
        }
      }
      // Session navigation follows the retained project's *current* saved
      // state. Opening a historical result still uses pinned retention checks.
      const prepared=await bridge.editorPrepare(sessionOnly&&ID.test(kept||'')?{projectId:kept,target:'project'}:{projectId:input.projectId,target:input.target,...(input.taskId?{taskId:input.taskId,candidateDigest:input.candidateDigest}:{})});
      const sessionId=await linkedSession(input.conversationId,prepared,source,h),binding=conversations.snapshot(sessionId);
      // A preview belongs to its source conversation, but never exposes sending.
      if(binding.projectId!==prepared.projectId)fail(409,'binding_changed','目标工程与会话不一致，未打开编辑器。');
      if(sessionOnly){const workspaceId=await ensureWorkspace(sessionId,prepared.projectName,h);return {status:200,body:{ok:true,sourceProjectId:input.projectId,sourceConversationId:input.conversationId,taskId:input.taskId,candidateDigest:input.candidateDigest,targetProjectId:prepared.projectId,projectId:prepared.projectId,sessionId,workspaceId}};}
      const existing=[...grants.values()].find(g=>g.mode==='project'&&prepared.mode==='project'&&g.projectId===prepared.projectId&&g.sessionId===sessionId&&g.sourceSessionId===input.conversationId&&g.sourceProjectId===input.projectId&&g.bindingVersion===binding.version&&g.expiresAt>now()&&g.editor.state==='loaded'&&!['unverified','stale'].includes(editorObservation(g.editor).state)&&
        // Only the same original project/session can span result rounds. A
        // legacy retained copy remains pinned to its original result identity.
        (g.projectId===input.projectId&&sessionId===input.conversationId||g.sourceTaskId===input.taskId&&g.candidateDigest===input.candidateDigest));
      if(existing){
        registerResult(existing,input);saveLaunch(existing);
        return {status:200,body:{...publicLaunch(existing,input.taskId?resultReference(existing,input.taskId):null),reused:true,
          editor:{...existing.editor,observation:editorObservation(existing.editor,prepared.revision===existing.revision),sync:syncState(existing,prepared.revision)}}};
      }
      const origin=getOrigin();if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))fail(503,'origin_unavailable','DSH 本机地址尚未就绪。');
      const token=randomBytes(32).toString('hex'),expiresAt=now()+24*60*60*1000;
      const g={...prepared,sessionId,sourceSessionId:input.conversationId,sourceProjectId:input.projectId,sourceTaskId:input.taskId,
        candidateDigest:input.candidateDigest,bindingVersion:binding.version,expiresAt,tokenHash:sha(token),editor:{state:'requested',nativeProjectPath:prepared.nativeProjectPath},createdAt:now()};
      registerResult(g,input);grants.set(g.tokenHash,g);saveLaunch(g);
      const connection={schemaVersion:1,baseUrl:origin+'/api/plcdev/editor-bridge',token,projectId:g.projectId,sessionId,revision:g.revision,
        nativeProjectPath:g.nativeProjectPath,launchId:g.launchId,mode:g.mode,canSend:g.mode==='project',projectName:g.projectName,expiresAt};
      try{const opened=await bridge.editorOpen({launchId:g.launchId,connection});if(opened.state==='failed'){g.openError='工程已准备，编辑器未能启动；可重新打开已有成果。';if(g.editor.state!=='loaded')g.editor.state='failed';saveLaunch(g);}}
      catch{g.openError='已保存工程，编辑器启动尚未确认；可重新打开已有成果。';if(g.editor.state!=='loaded')g.editor.state='failed';saveLaunch(g);}
      return {status:200,body:publicLaunch(g)};
    })();opening.set(key,operation);try{return await operation;}finally{opening.delete(key);}
  }
  function authenticate(req){
    if(disposed||typeof req.headers?.authorization!=='string'||!/^Bearer [0-9a-f]{64}$/.test(req.headers.authorization))return null;
    const value=sha(req.headers.authorization.slice(7)),g=grants.get(value);
    if(!g||g.expiresAt<now()||!timingSafeEqual(Buffer.from(value),Buffer.from(g.tokenHash)))return null;
    return g;
  }
  async function durable(id,h=host()){
    const live=h.sessions.get?.(id)||h.agents.get(id)?.session;
    if(live&&await h.sessions.flush(live)!==true)fail(503,'message_unknown','DSH 未确认保存消息，保留原请求编号核对。');
    const handle=await h.sessionPersistence.open(id,'read');try{if(handle.header.id!==id||live&&live.header.createdAt!==handle.header.createdAt)fail(409,'session_changed','会话身份已变化。');return (await handle.read(0)).events;}finally{await handle.close();}
  }
  function proof(events,row){
    const found=new Map();let conflict=false;
    const check=m=>{if(m?.source?.kind==='user'&&m.source.rpcId===row.rpc_id){if(text(m)!==row.text||typeof m.id!=='string')conflict=true;else found.set(m.id,m);}};
    for(const e of events){if(e.type==='user/message')check(e.data);if(e.type==='agent/inbox/spliced')for(const m of e.data.inserted||[])check(m);}
    if(conflict||found.size>1)fail(409,'message_identity_conflict','同一发送编号出现不一致消息，已停止重试。');
    return found.keys().next().value||null;
  }
  async function receipt(row,h){let id;try{id=proof(await durable(row.session_id,h),row);}catch(error){if(error?.code==='message_identity_conflict')throw error;}
    if(!id){dbRun(db=>db.prepare("UPDATE editor_requests SET state='unknown' WHERE session_id=? AND request_id=?").run(row.session_id,row.request_id));return {ok:false,state:'unknown',requestId:row.request_id,message:'消息投递结果仍待核对，没有自动重发。'};}
    dbRun(db=>db.prepare("UPDATE editor_requests SET state='accepted',message_id=? WHERE session_id=? AND request_id=?").run(id,row.session_id,row.request_id));return {ok:true,accepted:true,state:'accepted',requestId:row.request_id,messageId:id};}
  function editorObservation(editor,revisionMatches=true){
    const value=editor?.observation;
    if(!value)return {state:'unverified',loaded:null,dirty:null,nativeProjectPath:null,revisionMatches};
    return {...value,state:now()-Date.parse(value.observedAt)>6000?'stale':value.state,revisionMatches};
  }
  function observeEditor(g,input){
    fields(input,['launchId','loaded','dirty','nativeProjectPath']);
    if(input.launchId!==g.launchId||![null,true,false].includes(input.loaded)||![null,true,false].includes(input.dirty)||
      !(input.nativeProjectPath===null||typeof input.nativeProjectPath==='string'&&input.nativeProjectPath.length<=4096&&!/[\u0000-\u001f]/.test(input.nativeProjectPath)))
      fail(400,'invalid_observation','编辑器观察与连接身份不一致。');
    const matches=input.nativeProjectPath!==null&&normalized(input.nativeProjectPath)===normalized(g.nativeProjectPath);
    const observedState=input.loaded===null||input.dirty===null||input.nativeProjectPath===null?'unknown':!matches?'mismatch':!input.loaded?'not_loaded':input.dirty?'dirty':'clean';
    g.editor.observation={state:observedState,loaded:input.loaded,dirty:input.dirty,nativeProjectPath:input.nativeProjectPath,observedAt:new Date(now()).toISOString()};
    saveLaunch(g);
  }
  function syncState(g,revision){
    if(g.mode!=='project')return undefined;
    if(g.syncBlockedReason)return {state:'blocked',revision,reason:g.syncBlockedReason};
    if(g.syncPending)return {state:'pending',revision:g.syncPending.revision,reason:'正在更新已打开的工程。'};
    if(revision===g.revision)return {state:'current',revision};
    const observation=editorObservation(g.editor);
    if(g.editor.state!=='loaded'||observation.state!=='clean')return {state:'blocked',revision,reason:observation.state==='dirty'?'有未保存调整，等待处理后同步。':'等待确认当前编辑器内容。'};
    return {state:'available',revision,reason:'已保留新版本，等待窗口同步。'};
  }
  async function prepareSync(g,input){
    fields(input,['launchId','expectedRevision','nativeProjectPath']);
    if(g.mode!=='project'||input.launchId!==g.launchId||input.expectedRevision!==g.revision||typeof input.nativeProjectPath!=='string'||normalized(input.nativeProjectPath)!==normalized(g.nativeProjectPath))fail(409,'sync_identity','同步请求与当前工程不一致。');
    checkBinding(g);
    if(g.syncPreparing)return g.syncPreparing;
    if(g.syncPending)return g.syncPending;
    if(g.editor.state!=='loaded'||editorObservation(g.editor).state!=='clean')fail(409,'sync_blocked','请先处理未保存调整，再同步。');
    const operation=(async()=>{
      try{await bridge.editorVerifyPrepared({launchId:g.nativePreparedLaunch||g.launchId,projectId:g.projectId,revision:g.revision,nativeProjectPath:g.nativeProjectPath});}
      catch{g.syncBlockedReason='OpenPLC 当前文件与载入版本不一致或暂无法核对。请核对本地保存的改动后再切换工程。';fail(409,'sync_source_changed',g.syncBlockedReason);}
      checkBinding(g);delete g.syncBlockedReason;
      const prepared=await bridge.editorPrepare({projectId:g.projectId,target:'project'});checkBinding(g);
      if(prepared.projectId!==g.projectId||prepared.mode!=='project'||!HASH.test(prepared.revision||'')||typeof prepared.nativeProjectPath!=='string')fail(409,'sync_identity','同步目标归属无法核对。');
      if(prepared.revision===g.revision)fail(409,'sync_current','工程已是当前版本。');
      if(editorObservation(g.editor).state!=='clean')fail(409,'sync_blocked','编辑器状态已变化，暂缓同步。');
      g.syncPreparedLaunch=prepared.launchId;
      g.syncPending={ok:true,state:'prepared',syncId:randomUUID(),projectId:g.projectId,sessionId:g.sessionId,launchId:g.launchId,
        fromRevision:g.revision,fromNativeProjectPath:g.nativeProjectPath,revision:prepared.revision,nativeProjectPath:prepared.nativeProjectPath};
      return g.syncPending;
    })();g.syncPreparing=operation;try{return await operation;}finally{delete g.syncPreparing;}
  }
  async function completeSync(g,input){
    fields(input,['syncId','launchId','expectedRevision','revision','nativeProjectPath','loaded','dirty']);
    checkBinding(g);
    const fingerprint=sha(JSON.stringify(['syncId','launchId','expectedRevision','revision','nativeProjectPath','loaded','dirty'].map(k=>input[k])));
    if(g.syncCompleted?.fingerprint===fingerprint)return publicLaunch(g);
    const pending=g.syncPending;
    if(g.mode!=='project'||!pending||input.syncId!==pending.syncId||input.launchId!==g.launchId||input.expectedRevision!==pending.fromRevision||input.revision!==pending.revision||input.nativeProjectPath!==pending.nativeProjectPath||input.loaded!==true||input.dirty!==false)fail(409,'sync_identity','同步回执与已准备的工程不一致。');
    if(g.syncCompleting)return g.syncCompleting;
    const operation=(async()=>{
      const beforeObservation=g.editor.observation;
      await bridge.editorVerifyPrepared({launchId:g.syncPreparedLaunch,projectId:g.projectId,revision:pending.revision,nativeProjectPath:pending.nativeProjectPath});
      checkBinding(g);
      if(g.syncPending!==pending||g.revision!==pending.fromRevision)fail(409,'sync_changed','同步连接已变化。');
      const newerObservation=g.editor.observation!==beforeObservation?g.editor.observation:null;
      const history=[...(g.editor.synchronizedFrom||[]),{revision:g.revision,nativeProjectPath:g.nativeProjectPath}].slice(-64);
      g.revision=pending.revision;g.nativeProjectPath=pending.nativeProjectPath;
      g.nativePreparedLaunch=g.syncPreparedLaunch;
      g.editor={state:'loaded',nativeProjectPath:g.nativeProjectPath,confirmedAt:new Date(now()).toISOString(),synchronizedFrom:history,
        observation:{state:'clean',loaded:true,dirty:false,nativeProjectPath:g.nativeProjectPath,observedAt:new Date(now()).toISOString()}};
      if(newerObservation){
        const value=newerObservation;
        g.editor.observation={...value,state:value.loaded===null||value.dirty===null||value.nativeProjectPath===null?'unknown':normalized(value.nativeProjectPath)!==normalized(g.nativeProjectPath)?'mismatch':!value.loaded?'not_loaded':value.dirty?'dirty':'clean'};
      }
      g.syncCompleted={fingerprint};delete g.syncPending;delete g.syncPreparedLaunch;delete g.openError;saveLaunch(g);
      return publicLaunch(g);
    })();g.syncCompleting=operation;try{return await operation;}finally{delete g.syncCompleting;}
  }
  async function previewState(g,listing){
    if(g.mode!=='preview')return null;
      const origin=g.sourceSessionId===g.sessionId&&g.sourceProjectId===g.projectId?listing:await listTasks(g.sourceSessionId,g.sourceProjectId);
      const original=origin.tasks.find(t=>t.taskId===g.sourceTaskId&&t.candidate?.candidateDigest===g.candidateDigest);
      const status=original?.status||'unverified';
      const retained=['kept','compiled','compile_failed','compiling'].includes(status);
      const historical=retained||['discarded','superseded','unverified'].includes(status);
      const preview={taskId:g.sourceTaskId,status,historical,...(retained&&original?.retention?.keptProjectId?{retainedProjectId:original.retention.keptProjectId}:{})};
      const blockedReason=status==='discarded'?'这份候选已撤销。当前窗口仍是撤销前的历史预览，未切回原工程。请回 DSH 打开当前工程。'
        :status==='superseded'?'这份候选已有后续修改，当前窗口是历史预览。请回 DSH 查看最新结果。'
        :retained?'修改已保留，当前窗口仍是保留前的历史预览。请回 DSH 从结果卡打开已保留的工程。'
        :status==='unverified'?'当前预览的修改记录待核对。请回 DSH 查看对应结果。'
        :'当前为候选预览。请在 DSH 审阅并保留，再打开已保留的工程继续修改。';
      return {preview,blockedReason,revisionMatches:!!original&&!historical};
  }
  async function state(g){
    const h=host(),binding=checkBinding(g),observed=await inspect(g.sessionId,h),listing=await listTasks(g.sessionId,g.projectId);
    checkBinding(g);const details=await previewState(g,listing),preview=details?.preview;
    let blockedReason=details?.blockedReason||null;
    const observation=editorObservation(g.editor,details?details.revisionMatches:listing.revision===g.revision);
    if(g.mode==='preview'){/* A preview is always read-only, including after keep or discard. */}
    else if(g.editor.state!=='loaded')blockedReason='编辑器尚未确认打开关联工程。';
    else if(listing.revision!==g.revision)blockedReason=g.syncBlockedReason||(observation.dirty?'有未保存调整，处理后再核对 DSH 的新版本。':'正在同步 DSH 已保留的新版本。');
    else if(observation.state==='dirty')blockedReason='OpenPLC 有未保存调整，请先保存，再核对工程版本。';
    else if(['unknown','stale','not_loaded','mismatch'].includes(observation.state))blockedReason='尚未确认 OpenPLC 当前加载的工程内容，请核对编辑器后刷新。';
    else if(binding.pendingRequests.length||binding.submissionConflicts.length||binding.submissionInFlight.length)blockedReason='工程有待核对的修改请求，请先在 DSH 核对。';
    const unsettled=dbRun(db=>db.prepare("SELECT * FROM editor_requests WHERE session_id=? AND state IN ('sending','unknown')").all(g.sessionId));
    for(const row of unsettled){const result=await receipt(row,h);if(result.state==='unknown'&&!blockedReason)blockedReason='上一条编辑器消息尚未确认投递，请保留原请求并核对后继续。';}
    const active=h.agents.get(g.sessionId),running=active?.status==='running';
    const model=selectedModel(observed,h);if(!blockedReason&&!model)blockedReason='请在 DSH 会话选择可用模型。';
    if(!blockedReason&&running)blockedReason='DSH 正在处理当前会话，请等待完成或停止本次请求。';
    const messages=editorMessages(observed.events),stream=streams.get(g.sessionId);
    if(stream?.text)messages.push({id:'stream-'+stream.attemptId,role:'assistant',text:stream.text.slice(0,16000),turn:stream.turn,streaming:true});
    let tasks=[...listing.tasks].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,30).map(t=>taskSummary(t,g.sessionId));
    if(g.sourceTaskId&&g.sourceSessionId!==g.sessionId){const origin=await listTasks(g.sourceSessionId,g.sourceProjectId);const original=origin.tasks.find(t=>t.taskId===g.sourceTaskId&&t.retention?.keptProjectId===g.projectId);if(original)tasks=[{...taskSummary(original,g.sourceSessionId),origin:true},...tasks];}
    const recent=dbRun(db=>db.prepare('SELECT request_id,state,message_id FROM editor_requests WHERE session_id=? ORDER BY created_at DESC LIMIT 10').all(g.sessionId));
    const result={ok:true,schemaVersion:1,project:{id:g.projectId,name:g.projectName,revision:listing.revision},conversation:{id:g.sessionId,title:g.projectName+' · DSH 会话',model,status:running?'running':'idle'},
      ...(g.sourceSessionId!==g.sessionId?{sourceConversation:{id:g.sourceSessionId,projectId:g.sourceProjectId,taskId:g.sourceTaskId,label:'此修改副本来自原 DSH 会话；当前为副本的接续会话。'}}:{}),
      messages,tasks,canSend:!blockedReason,blockedReason,editor:{...g.editor,observation,...(preview?{preview}:{}),...(g.mode==='project'?{sync:syncState(g,listing.revision)}:{})},connection:{projectId:g.projectId,sessionId:g.sessionId,revision:g.revision,launchId:g.launchId},
      revisionContext:binding.revisionContext?{state:binding.revisionContext.state,parent:binding.revisionContext.parent,workflow:binding.revisionContext.workflow}:null,
      modelCapability:getToolNotice(g.sessionId),requests:recent.map(r=>({requestId:r.request_id,state:r.state,messageId:r.message_id})),canCancel:running&&ownsActiveTurn(g,h),
      truncated:messages.some(m=>m.truncated)||listing.tasks.length>30||observed.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='user'||e.type==='assistant/message').length>100};
    // The editor transport caps responses at 2 MiB. Preserve recent messages
    // and results inside a smaller budget; durable receipt proof reads the full
    // original log independently and is never truncated.
    while(Buffer.byteLength(JSON.stringify(result),'utf8')>1500000){result.truncated=true;if(result.messages.length>1)result.messages.shift();else if(result.tasks.length)result.tasks.pop();else{result.messages[0].text=result.messages[0].text.slice(-4000);break;}}
    return result;
  }
  function ownsActiveTurn(g,h){
    const agent=h.agents.get(g.sessionId);if(!agent||agent.status!=='running')return false;
    const events=agent.session.snapshotEvents(),last=[...events].reverse().find(e=>e.type==='user/message');
    return !!last&&dbRun(db=>!!db.prepare('SELECT 1 FROM editor_requests WHERE session_id=? AND rpc_id=?').get(g.sessionId,last.data?.source?.rpcId));
  }
  async function submit(g,input){
    fields(input,['requestId','text']);if(!REQUEST.test(input.requestId||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000)fail(400,'invalid_message','需求须为 1–4000 字，且具有有效发送编号。');
    checkBinding(g);const h=host(),content=input.text.trim(),fingerprint=sha(JSON.stringify({projectId:g.projectId,revision:g.revision,text:content})),key=g.sessionId+':'+input.requestId;
    let row=dbRun(db=>db.prepare('SELECT * FROM editor_requests WHERE session_id=? AND request_id=?').get(g.sessionId,input.requestId));
    if(row){if(row.fingerprint!==fingerprint)fail(409,'request_changed','同一发送编号不能更换内容。');return receipt(row,h);}
    if(sending.has(g.sessionId))fail(409,'sending','已有消息正在发送，请等待回执。');
    const lock={key};sending.set(g.sessionId,lock);
    try{
      const current=await state(g);if(!current.canSend)fail(409,'send_unavailable',current.blockedReason);
      const live=await h.sessionController.resolveAgent(g.sessionId);if(live.error)throw live.error;
      checkBinding(g);if(live.agent?.status!=='idle')fail(409,'session_busy','DSH 会话正在处理其他请求，请等待完成。');
      // Carry the pending candidate across editor-origin follow-ups through the
      // same durable revision intent used by the DSH "continue" button.
      const binding=conversations.snapshot(g.sessionId);
      if(!binding.revisionContext||binding.revisionContext.state==='submitted'){
        const list=await listTasks(g.sessionId,g.projectId),pending=list.tasks.filter(t=>t.status==='awaiting_review'&&!t.supersededBy&&t.candidate?.revisionSupported===true);
        if(pending.length>1)fail(409,'revision_ambiguous','当前有多个待审修改，请在 DSH 选择要继续的版本。');
        if(pending.length===1){const task=pending[0],armed=await conversations.handle('POST','/api/plcdev/conversations/revision',{conversationId:g.sessionId,projectId:g.projectId,taskId:task.taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:list.revision,expectedVersion:binding.version,intentId:'editor-'+sha(key).slice(0,48)});if(armed.status!==200)fail(armed.status,'revision_unavailable',armed.body.error||'待审修改无法继续。');}
      }
      const sendingBinding=checkBinding(g);
      // The native editor is another view of this session. Keep its engineering
      // identity before sending; an uncertain host reply must not permit opt-out.
      conversations.lockParticipation?.(g.sessionId,{projectId:g.projectId,version:sendingBinding.version});
      const rpcId='plcdev-openplc-'+sha(key),created=new Date(now()).toISOString();
      dbRun(db=>db.prepare('INSERT INTO editor_requests(session_id,request_id,fingerprint,rpc_id,text,state,message_id,created_at,project_id,binding_version) VALUES(?,?,?,?,?,?,NULL,?,?,?)').run(g.sessionId,input.requestId,fingerprint,rpcId,content,'sending',created,g.projectId,sendingBinding.version));
      row=dbRun(db=>db.prepare('SELECT * FROM editor_requests WHERE session_id=? AND request_id=?').get(g.sessionId,input.requestId));
      try{await h.sessionController.prompt({sessionId:g.sessionId,requestId:rpcId,mode:'queue',content:[{type:'text',text:content}],clientTimeZone:'Asia/Shanghai'},new AbortController().signal);}
      catch{dbRun(db=>db.prepare("UPDATE editor_requests SET state='unknown' WHERE session_id=? AND request_id=?").run(g.sessionId,input.requestId));return receipt(row,h);}
      return receipt(row,h);
    }finally{if(sending.get(g.sessionId)===lock)sending.delete(g.sessionId);}
  }
  async function reveal(g,input){
    fields(input,[],['taskId']);let sessionId=g.sessionId,projectId=g.projectId;
    if(input.taskId!==undefined){if(!TASK.test(input.taskId))fail(400,'invalid_task','任务身份无效。');
      const own=conversations.snapshot(sessionId).taskRefs.some(r=>r.taskId===input.taskId&&r.projectId===projectId);
      if(!own){if(input.taskId!==g.sourceTaskId||!conversations.snapshot(g.sourceSessionId).taskRefs.some(r=>r.taskId===input.taskId&&r.projectId===g.sourceProjectId))fail(403,'task_not_in_conversation','任务不属于关联会话。');sessionId=g.sourceSessionId;projectId=g.sourceProjectId;}
    }
    const target={sessionId,projectId,...(input.taskId?{taskId:input.taskId}:{})};
    if(navigation&&JSON.stringify(navigation.target)!==JSON.stringify(target))fail(409,'navigation_busy','DSH 正在定位上一项成果，请稍后再试。');
    navigation??={navigationId:randomUUID(),target,consumer:null,expires:0};
    return {ok:true,state:'requested',navigationId:navigation.navigationId,...target};
  }
  async function native(method,route,input,g){try{
    if(!g||g.expiresAt<now()||disposed)fail(401,'connection_expired','DSH 连接已失效，请从 DSH 工程重新打开。');
    if(method==='GET'&&route==='/state')return {status:200,body:await state(g)};
    if(method!=='POST')fail(404,'not_found','未知编辑器接口。');
    if(route==='/state'){checkBinding(g);observeEditor(g,input);return {status:200,body:await state(g)};}
    if(route==='/sync/prepare')return {status:200,body:await prepareSync(g,input)};
    if(route==='/sync/complete')return {status:200,body:await completeSync(g,input)};
    if(route==='/submit')return {status:200,body:await submit(g,input)};
    if(route==='/loaded'){
      fields(input,['launchId','nativeProjectPath','dirty']);if(input.launchId!==g.launchId||typeof input.nativeProjectPath!=='string'||normalized(input.nativeProjectPath)!==normalized(g.nativeProjectPath)||input.dirty!==false)fail(409,'editor_mismatch','编辑器未加载约定工程或仍有未保存修改。');
      checkBinding(g);if(g.mode==='project'&&(await listTasks(g.sessionId,g.projectId)).revision!==g.revision)fail(409,'revision_changed','工程保存版本已变化，请从 DSH 当前工程重新打开。');
      checkBinding(g);g.editor={...g.editor,state:'loaded',nativeProjectPath:g.nativeProjectPath,confirmedAt:new Date(now()).toISOString()};delete g.openError;saveLaunch(g);return {status:200,body:publicLaunch(g)};
    }
    if(route==='/cancel'){
      fields(input,['requestId']);if(!REQUEST.test(input.requestId||''))fail(400,'invalid_request','停止请求编号无效。');checkBinding(g);const h=host();
      if(!ownsActiveTurn(g,h))fail(409,'turn_not_owned','当前运行请求不是从此编辑器会话发送的，未停止其他操作。');
      const result=h.sessionController.cancel({sessionId:g.sessionId});return {status:200,body:{ok:true,...result}};
    }
    if(route==='/reveal')return {status:200,body:await reveal(g,input)};
    fail(404,'not_found','未知编辑器接口。');
  }catch(error){const result=errorResult(error);if(route==='/submit')result.body.state=error instanceof EditorError&&error.status<500?'rejected':'unknown';return result;}}
  function errorResult(e){return {status:e instanceof EditorError?e.status:503,body:{ok:false,code:e instanceof EditorError?e.code:'editor_unavailable',error:e instanceof EditorError?e.message:'DSH 工程连接暂不可用，请保留原请求编号并核对。'}};}
  async function handle(method,rawPath,input){try{
    const url=new URL(rawPath,'http://127.0.0.1');if(url.hash)fail(400,'invalid_request','地址无效。');
    if(method==='POST'&&url.pathname==='/api/plcdev/conversations/editor-open'&&!url.search)return await open(input);
    if(method==='POST'&&url.pathname==='/api/plcdev/conversations/result-resource-status'&&!url.search){
      fields(input,['conversationId','projectId','taskId','candidateDigest','tool','target','launchId']);
      if(input.tool!=='oip'||!['candidate','retained'].includes(input.target)||!/^editor-[0-9a-f]{32}$/.test(input.launchId||''))fail(400,'invalid_target','结果工具状态请求无效。');
      await ownedTask(input);const {conversationId,...request}=input;
      return {status:200,body:await bridge.resultResourceStatus(request)};
    }
    if(method==='POST'&&url.pathname==='/api/plcdev/conversations/result-resource-open'&&!url.search){
      fields(input,['conversationId','projectId','taskId','candidateDigest','tool','target']);
      if(!['fuxa','oip'].includes(input.tool)||!['candidate','retained'].includes(input.target))fail(400,'invalid_target','结果工具目标无效。');
      await ownedTask(input);const {conversationId,...request}=input;
      return {status:200,body:await bridge.resultResourceOpen(request)};
    }
    if(method==='POST'&&url.pathname==='/api/plcdev/conversations/editor-session'&&!url.search){if(input?.target!=='retained')fail(400,'invalid_target','此入口只用于接续已保留工程。');return await open(input,true);}
    if(method==='GET'&&url.pathname==='/api/plcdev/conversations/editor-status'){
      if(!['conversationId,launchId','conversationId,launchId,taskId'].includes([...url.searchParams.keys()].sort().join(',')))fail(400,'invalid_request','打开回执请求无效。');
      const id=url.searchParams.get('conversationId'),launchId=url.searchParams.get('launchId'),taskId=url.searchParams.get('taskId');
      if(taskId!==null&&!TASK.test(taskId))fail(400,'invalid_request','修改引用无效。');
      const row=dbRun(db=>db.prepare('SELECT * FROM editor_launches WHERE launch_id=?').get(launchId));
      if(!row)fail(404,'launch_not_found','未找到此打开请求。');const value=JSON.parse(row.payload);
      if(row.source_session!==id&&value.sessionId!==id)fail(403,'launch_not_owned','打开回执不属于此会话。');
      const reference=taskId?resultReference(value,taskId):value.mode==='preview'&&value.taskId?resultReference(value,value.taskId):null;
      const grant=[...grants.values()].find(g=>g.launchId===launchId&&g.expiresAt>=now());
      if(!grant){const {resultReferences:_,taskId:__,candidateDigest:___,...display}=value;return {status:200,body:{...display,...(reference||{}),state:'disconnected',editor:{...value.editor,state:'disconnected'}}};}
      const listing=await listTasks(value.sessionId,value.targetProjectId||value.projectId),details=await previewState(grant,listing);
      checkBinding(grant);const current=publicLaunch(grant,reference);
      return {status:200,body:{...current,editor:{...current.editor,observation:editorObservation(current.editor,details?details.revisionMatches:listing.revision===current.revision),...(details?{preview:details.preview}:{}),...(grant.mode==='project'?{sync:syncState(grant,listing.revision)}:{})}}};
    }
    if(method==='GET'&&url.pathname==='/api/plcdev/conversations/preview'){
      const names=['conversationId','projectId','taskId','candidateDigest'];if([...url.searchParams.keys()].sort().join(',')!==names.sort().join(','))fail(400,'invalid_request','预览请求无效。');
      const v=Object.fromEntries(url.searchParams);await ownedTask(v);const {conversationId,...request}=v;return {status:200,body:await bridge.candidatePreview(request)};
    }
    if(url.pathname==='/api/plcdev/conversations/editor-navigation'){
      if(method==='GET'){
        const consumer=url.searchParams.get('consumerId');if([...url.searchParams.keys()].join(',')!=='consumerId'||!REQUEST.test(consumer||''))fail(400,'invalid_request','导航消费者无效。');
        if(!navigation||navigation.expires>now()&&navigation.consumer!==consumer)return {status:200,body:{ok:true,navigation:null}};
        navigation.consumer=consumer;navigation.expires=now()+10000;return {status:200,body:{ok:true,navigation:{navigationId:navigation.navigationId,...navigation.target}}};
      }
      if(method==='POST'&&!url.search){fields(input,['navigationId','consumerId']);if(!navigation||input.navigationId!==navigation.navigationId||input.consumerId!==navigation.consumer||navigation.expires<now())fail(409,'navigation_changed','导航请求已变化。');navigation=null;return {status:200,body:{ok:true}};}
    }
    fail(404,'not_found','未知编辑器会话接口。');
  }catch(error){return errorResult(error);}}
  function stream(payload){const id=payload?.agent?.session?.id,frame=payload?.frame;if(!id||![...grants.values()].some(g=>g.sessionId===id))return;
    if(frame?.type==='start')streams.set(id,{attemptId:frame.attemptId,turn:frame.turn,text:''});
    else if(frame?.type==='chunk'){const current=streams.get(id);if(current?.attemptId===frame.attemptId&&frame.chunk?.type==='text-delta'&&typeof frame.chunk.text==='string')current.text=(current.text+frame.chunk.text).slice(0,16000);}
    else if(frame?.type==='end'&&streams.get(id)?.attemptId===frame.attemptId)streams.delete(id);
  }
  // The queued host input is fenced independently of the browser/editor grant.
  // Historical rows remain intact but missing metadata cannot authorize a new
  // turn against whichever project happens to be selected now.
  function promptBinding(sessionId,rpcId){
    if(!SID.test(sessionId??'')||!/^plcdev-openplc-[0-9a-f]{64}$/.test(rpcId??''))return null;
    const rows=dbRun(db=>db.prepare('SELECT project_id,binding_version,text FROM editor_requests WHERE session_id=? AND rpc_id=? LIMIT 2').all(sessionId,rpcId));
    const row=rows.length===1?rows[0]:null;
    if(!row||!ID.test(row.project_id??'')||!Number.isSafeInteger(row.binding_version)||row.binding_version<0)return null;
    return {projectId:row.project_id,version:row.binding_version,text:row.text};
  }
  return {handle,native,authenticate,stream,promptBinding,dispose(){disposed=true;grants.clear();streams.clear();navigation=null;},_state:state};
}
