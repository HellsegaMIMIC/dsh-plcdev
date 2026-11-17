import {bindRequest,validateBinding,validConversationId} from './conversation-client.mjs';
import {bindingBlockedReason} from './conversation-context.mjs';
import {validateSnapshot,validateTasks} from './model.mjs';
import {validateProjectInspection} from './project-inspection.mjs';
import {workspaceLocation} from './workspace-navigation.mjs';
import {matchesHmiPlan} from '../hmi-intent.mjs';

const projectIdValid=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
function absolutePath(value){
  if(typeof value!=='string'||!value||value.length>4096||value!==value.trim()||/[\x00-\x1f]/.test(value))return null;
  const normalized=value.replaceAll('\\','/').replace(/\/+$/,'');
  const windows=/^[A-Za-z]:\//.test(normalized)||normalized.startsWith('//');
  if(!/^[A-Za-z]:\//.test(normalized)&&!normalized.startsWith('/'))return null;
  if(normalized.startsWith('//')&&!/^\/\/[^/?\.][^/]*\/[^/]+(?:\/|$)/.test(normalized))return null;
  if(normalized.split('/').some(part=>part==='.'||part==='..'))return null;
  return {normalized,key:windows?normalized.toLowerCase():normalized};
}
// The caller supplies only a project id. Working directories must come from
// the exact registered user project, corroborated by its catalog manifest.
export function projectSessionDirectory(snapshot,projectId){
  const project=snapshot?.project,entries=snapshot?.projects?.filter(row=>row?.id===projectId)||[];
  const unavailable='此工程没有可核对的用户工程目录。请先打开用户工程，或在 DSH 选择工作区后再关联工程；未创建会话。';
  if(project?.id!==projectId||project.kind!=='user'||entries.length!==1)throw Error(unavailable);
  const root=absolutePath(project.projectRoot),manifest=absolutePath(project.manifestPath),registered=absolutePath(entries[0].manifestPath);
  if(!root||!manifest||!registered||!manifest.normalized.toLowerCase().endsWith('.plcdev'))throw Error(unavailable);
  const parent=absolutePath(manifest.normalized.slice(0,manifest.normalized.lastIndexOf('/')));
  if(!parent||root.key!==parent.key||manifest.key!==registered.key)throw Error('工程目录与登记清单不一致，请重新打开并核对工程；未创建会话。');
  return project.projectRoot;
}
export function signalReference(value){
  if(!projectIdValid(value?.projectId)||typeof value.signalKey!=='string'||!value.signalKey||value.signalKey.length>256||/[\r\n\0]/.test(value.signalKey)||!/^[a-f0-9]{64}$/.test(value.savedRevision||''))return null;
  return {projectId:value.projectId,signalKey:value.signalKey,savedRevision:value.savedRevision};
}
export async function readSignalReference(api,value){
  const reference=signalReference(value);if(!reference)throw Error('信号引用身份无效，请从工程重新选择。');
  const data=validateProjectInspection(await api('project-inspection?project='+encodeURIComponent(reference.projectId)),reference.projectId);
  if(data.projectRevision!==reference.savedRevision)throw Error('工程保存版本已变化，请回工程重新选择此信号。');
  const matches=data.signals.filter(row=>row?.id===reference.signalKey);
  if(matches.length!==1)throw Error('原信号已不存在或身份不唯一，请回工程重新选择。');
  return {reference,signal:matches[0],inspection:data};
}

// Local view bookmarks never alter the session's engineering binding or draft.
export function createConversationViews({storage=()=>window.localStorage}={}){
  const key='plcdev.dsh.conversation-views.v1',listeners=new Set();let state={origins:{},references:{},notices:{}};
  try{
    const saved=JSON.parse(storage().getItem(key)||'null');
    if(saved?.schemaVersion===1){
      for(const [id,value] of Object.entries(saved.origins||{}).slice(-50)){const origin=workspaceLocation(value);if(validConversationId(id)&&origin)state.origins[id]=origin;}
      for(const [id,value] of Object.entries(saved.references||{}).slice(-50)){const reference=signalReference(value);if(validConversationId(id)&&reference)state.references[id]={...reference,label:typeof value.label==='string'?value.label.slice(0,200):reference.signalKey};}
      for(const [id,value] of Object.entries(saved.notices||{}).slice(-50))if(validConversationId(id)&&typeof value==='string')state.notices[id]=value.slice(0,1000);
    }
  }catch{}
  function publish(){state={origins:Object.fromEntries(Object.entries(state.origins).slice(-50)),references:Object.fromEntries(Object.entries(state.references).slice(-50)),notices:Object.fromEntries(Object.entries(state.notices).slice(-50))};try{storage().setItem(key,JSON.stringify({schemaVersion:1,...state}));}catch{}listeners.forEach(fn=>fn());}
  return {snapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},rememberOrigin(sessionId,value){const origin=workspaceLocation(value);if(validConversationId(sessionId)&&origin){state={...state,origins:{...state.origins,[sessionId]:origin}};publish();}},rememberReference(sessionId,value,label){const reference=signalReference(value);if(validConversationId(sessionId)&&reference){state={...state,references:{...state.references,[sessionId]:{...reference,label:typeof label==='string'?label.slice(0,200):reference.signalKey}}};publish();}},rememberNotice(sessionId,message){if(validConversationId(sessionId)){state={...state,notices:{...state.notices,[sessionId]:typeof message==='string'?message.slice(0,1000):''}};publish();}},dispose(){listeners.clear();}};
}
export function signalReferencePrompt({reference,signal}){
  return ['[工程信号引用]',`工程：${reference.projectId}`,`信号：${signal.label||reference.signalKey} (${reference.signalKey})`,signal.path?`声明路径：${signal.path}`:'',`保存版本：${reference.savedRevision}`,'此引用来自已保存工程，不代表当前运行值。'].filter(Boolean).join('\n');
}
export async function prepareReferenceDraft(api,value){
  const resolved=await readSignalReference(api,value);
  if(value.intent===undefined)return {...resolved,prompt:signalReferencePrompt(resolved)};
  if(value.intent!=='readonly-value'||typeof value.viewId!=='string'||typeof value.signalId!=='string')throw Error('未知的信号操作，请从工程重新选择。');
  const prompt=`在画面 ID“${value.viewId}”添加信号 ID“${value.signalId}”的只读数值显示`;
  if(!matchesHmiPlan('hmi-readonly-value-v1',prompt,{viewId:value.viewId,signalId:value.signalId}))throw Error('画面或信号标识无法形成受支持的需求。');
  const tasks=validateTasks(await api('tasks?project='+encodeURIComponent(resolved.reference.projectId)),resolved.reference.projectId);
  if(tasks.projectRevision!==resolved.reference.savedRevision||tasks.capabilities?.hmiReadonlyValueCandidate!==true||!Array.isArray(tasks.hmiValueTargets))throw Error('当前保存版本未确认支持新增只读显示，请重新读取工程。');
  const matches=tasks.hmiValueTargets.filter(row=>row?.viewId===value.viewId&&row?.signalId===value.signalId&&row?.path===resolved.signal.path&&row?.type===resolved.signal.type);
  if(matches.length!==1)throw Error('所选画面和信号不在当前可用目标中，未填写需求。');
  return {...resolved,prompt};
}

export async function prepareRetainedDraft(api,value,projectId){
  if(!value||!validConversationId(value.sourceSessionId)||!projectIdValid(value.sourceProjectId)
    ||!/^task-[0-9a-f]{32}$/.test(value.taskId||'')||!/^user-[0-9a-f]{32}$/.test(projectId||'')
    ||value.keptProjectId!==projectId||value.sourceProjectId===projectId
    ||!(/^[0-9a-f]{64}$/.test(value.candidateDigest||''))||!(/^[0-9a-f]{64}$/.test(value.revision||'')))throw Error('修改副本引用无效，请从原候选审阅重新进入。');
  const binding=validateBinding(await api('conversations?conversationId='+encodeURIComponent(value.sourceSessionId)),value.sourceSessionId);
  if(!binding.taskRefs.some(ref=>ref.projectId===value.sourceProjectId&&ref.taskId===value.taskId))throw Error('原候选不属于来源会话，未创建副本会话。');
  const listing=validateTasks(await api('tasks?project='+encodeURIComponent(value.sourceProjectId)),value.sourceProjectId);
  const task=listing.tasks.find(row=>row.taskId===value.taskId),retention=task?.retention;
  if(!task||!['kept','compiled','compile_failed'].includes(task.status)||task.candidate?.candidateDigest!==value.candidateDigest
    ||(retention?.keptProjectId||retention?.projectId)!==projectId||retention?.revision!==value.revision)throw Error('原候选与修改副本的对应关系已变化，请重新读取审阅结果。');
  const current=validateTasks(await api('tasks?project='+encodeURIComponent(projectId)),projectId);
  if(current.projectRevision!==value.revision)throw Error('修改副本已在其他位置保存了新内容。请打开副本工程，从当前版本新建工程会话。');
  const compilation=task.compilation,diagnostic=compilation?.sourceRevision===value.revision&&typeof compilation?.diagnostic==='string'?compilation.diagnostic.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,2400):'';
  const prompt=['[修改副本接续]',`当前工程：${projectId}`,`保存版本：${value.revision}`,`来源候选：${value.taskId}`,
    '请先读取当前工程上下文，基于这个修改副本继续，保留此前已有修改。',
    ...(task.status==='compile_failed'?['请修复该保存版本的编译问题，并生成新的修改候选。',diagnostic?'编译诊断：\n'+diagnostic:'编译未通过，当前回执未提供可直接引用的诊断；请先核对原因，不要推测源程序错误。']:['我的下一步修改需求：'])].join('\n');
  return {projectId,prompt};
}

function availableSession(sessions,id){const catalog=sessions.list?.getSnapshot?.();return catalog?.phase==='ready'&&catalog.ids?.includes(id)&&catalog.byId?.[id]&&catalog.byId[id].origin!=='subagent';}
function checkServices(services,held){const current=services();if(current.sessions!==held.sessions||current.workspace!==held.workspace||current.workspaces!==held.workspaces||current.conversation!==held.conversation)throw Error('宿主接口已变化，请重新操作。');}

// Only documented DSH Session and composer APIs are used. No prompt/send/submit
// method is called; a reference is appended to the exact retained draft.
export function createProjectSessionActions({services,api,openSession,navigation,onPrepared=()=>{},timeout=5000}){
  let busy=false;
  async function bounded(promise,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeout);})]);}finally{clearTimeout(timer);}}
  async function confirmWorkspace(workspaces,registered,sessionId){
    const registeredPath=absolutePath(registered.path);
    const confirmed=()=>{const catalog=workspaces.list.getSnapshot();if(catalog?.phase!=='ready'||!Array.isArray(catalog.items))return false;const matches=catalog.items.filter(row=>row?.workspaceId===registered.workspaceId&&absolutePath(row.path)?.key===registeredPath.key&&typeof row.title==='string'&&Array.isArray(row.sessionIds)&&row.sessionIds.includes(sessionId));return matches.length===1&&!catalog.archivedSessionIds?.includes(sessionId);};
    if(confirmed())return;
    let unsubscribe;try{await bounded(new Promise((resolve,reject)=>{unsubscribe=workspaces.list.subscribe(()=>{try{if(confirmed())resolve();}catch(error){reject(error);}});if(confirmed())resolve();}),'新会话的宿主工作区归属尚未确认，未打开空白会话。请重新读取工程，或在 DSH 工作区列表核对。');}finally{unsubscribe?.();}
  }
  async function confirmDraft(conversation,binding,prompt){
    const store=conversation.input.for(binding.ctx)?.state;
    if(typeof store?.getSnapshot!=='function'||typeof store?.subscribe!=='function')throw Error('宿主草稿读取接口不可用，无法确认带入结果；未重复追加。');
    const contains=()=>{const draft=store.getSnapshot()?.draft;return typeof draft==='string'&&draft.includes(prompt);};
    if(contains())return;
    let unsubscribe;
    try{await bounded(new Promise((resolve,reject)=>{unsubscribe=store.subscribe(()=>{try{if(contains())resolve();}catch(error){reject(error);}});if(contains())resolve();}),'引用已请求带入，但未能确认草稿显示；请检查该会话，未重复追加。');}
    finally{unsubscribe?.();}
  }
  async function prepare(projectId,value,existingSessionId,origin,retainedRequest){
    if(busy)return {ok:false,message:'已有会话操作正在处理，请稍候。'};
    if(!projectIdValid(projectId))return {ok:false,message:'工程身份无效。'};
    if(existingSessionId!==undefined&&!validConversationId(existingSessionId))return {ok:false,message:'会话身份无效。'};
    busy=true;let sessionId=existingSessionId,retained,hostBinding,draftApplied=false,draftVerified=false,created=false;
    try{
      const held=services(),{sessions,workspace,workspaces,conversation}=held;
      if(typeof sessions?.refresh!=='function'||typeof workspace?.openSession!=='function'||typeof sessions?.list?.getSnapshot!=='function')throw Error('宿主会话接口不可用。');
      if(!sessionId&&typeof sessions.create!=='function')throw Error('当前宿主不支持从工程新建会话，请在 DSH 新建会话后选择工程。');
      if(!sessionId&&(typeof workspaces?.create!=='function'||typeof workspaces?.list?.getSnapshot!=='function'||typeof workspaces?.list?.subscribe!=='function'))throw Error('宿主工作区接口不可用，请先在 DSH 选择工作区后关联工程；未创建会话。');
      if((value!==undefined||retainedRequest)&&(typeof sessions.retain!=='function'||typeof conversation?.input?.requestDraftInitialization!=='function'||typeof conversation?.input?.for!=='function'))throw Error('当前宿主不支持带入草稿；请在会话中手动填写需求。');
      const snapshot=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);
      if(snapshot.project.id!==projectId)throw Error('工程身份未确认。');
      const cwd=sessionId?undefined:projectSessionDirectory(snapshot,projectId);
      const resolved=retainedRequest?await prepareRetainedDraft(api,retainedRequest,projectId):value===undefined?null:await prepareReferenceDraft(api,value);
      if(resolved&&(resolved.reference?.projectId||resolved.projectId)!==projectId)throw Error('引用属于其他工程。');
      await bounded(sessions.refresh(),'宿主会话列表读取超时。');checkServices(services,held);
      const before=new Set(sessions.list.getSnapshot()?.ids||[]);
      if(!sessionId){
        // DSH's cwd-only create does NOT attach a Workspace. Blank conversations
        // remain inert unless their id is present in a real Workspace row.
        // Host Workspace.create canonicalizes and idempotently reuses the path.
        const registered=await workspaces.create({path:cwd});checkServices(services,held);
        if(!validConversationId(registered?.workspaceId)||absolutePath(registered?.path)?.key!==absolutePath(cwd)?.key||typeof registered.title!=='string')throw Error('宿主返回的工作区与已核验工程目录不一致；未创建会话。');
        sessionId=await sessions.create({workspaceId:registered.workspaceId});created=true;
        if(!validConversationId(sessionId)||before.has(sessionId))throw Error('宿主未确认独立的新会话；未改绑已有会话。');
        await confirmWorkspace(workspaces,registered,sessionId);checkServices(services,held);
      }
      if(!validConversationId(sessionId))throw Error('宿主返回了无效会话身份。');
      checkServices(services,held);
      if(!availableSession(sessions,sessionId)){await bounded(sessions.refresh(),'新会话列表读取超时。');if(!availableSession(sessions,sessionId))throw Error('目标主会话尚未确认可访问。');}
      let binding=validateBinding(await api('conversations?conversationId='+encodeURIComponent(sessionId)),sessionId);
      if(created){
        if(binding.projectId||binding.taskRefs.length||binding.revisionContext)throw Error('新会话已有工程上下文；未覆盖原绑定。');
        const blocked=bindingBlockedReason({binding});if(blocked)throw Error(blocked);
        binding=validateBinding(await api('conversations/bind',bindRequest(binding,projectId)),sessionId);
      }
      if(binding.projectId!==projectId)throw Error('目标会话当前属于其他工程；未改绑，也未追加草稿。');
      if(resolved){
        const blocked=bindingBlockedReason({binding});if(blocked)throw Error(blocked);
        retained=sessions.retain(sessionId,{source:'controllerOperation'});
        hostBinding=await bounded(retained.ready,'会话草稿尚未就绪，请稍后重试。');checkServices(services,held);
        // Recheck both the saved resource and current binding after asynchronous retain.
        if(retainedRequest){const latest=await prepareRetainedDraft(api,retainedRequest,projectId);if(latest.prompt!==resolved.prompt)throw Error('副本的编译状态已变化，未追加旧诊断，请重新核对。');}else await prepareReferenceDraft(api,value);
        binding=validateBinding(await api('conversations?conversationId='+encodeURIComponent(sessionId)),sessionId);
        if(binding.projectId!==projectId||bindingBlockedReason({binding}))throw Error('目标会话工程或请求状态已变化，未追加草稿。');
        checkServices(services,held);if(!availableSession(sessions,sessionId))throw Error('目标主会话已不可访问，未追加草稿。');
        if(conversation.input.requestDraftInitialization(hostBinding,{prompt:resolved.prompt,whenDraftExists:'append'})!=='applied')throw Error('会话正在提交或草稿暂不可编辑；原草稿保留，未追加引用。');
        draftApplied=true;
      }
      checkServices(services,held);onPrepared({projectId,sessionId,origin,...(resolved?.reference?{reference:resolved.reference,label:resolved.signal.label||resolved.reference.signalKey}:{})});
      const result=await openSession({projectId,sessionId});
      if(result.ok&&draftApplied){checkServices(services,held);await confirmDraft(conversation,hostBinding,resolved.prompt);draftVerified=true;}
      return {...result,sessionId,created,draftApplied,draftVerified,message:result.ok?(draftApplied?retainedRequest?'已在修改副本的新会话中填写接续需求，尚未发送。':'信号已带入草稿，尚未发送。':'已打开新的工程会话。'):result.message};
    }catch(error){return {ok:false,sessionId,created,draftApplied,draftVerified,message:error.message||'会话操作未确认。'};}
    finally{retained?.release();busy=false;}
  }
  return {
    create:(projectId,origin)=>prepare(projectId,undefined,undefined,origin),
    createFromRetained:(value,origin)=>prepare(value?.keptProjectId,undefined,undefined,origin,value),
    carry:(projectId,reference,sessionId,origin)=>prepare(projectId,reference,sessionId,origin),
    async returnToSession(sessionId){
      if(!validConversationId(sessionId))return {ok:false,message:'来源会话身份无效。'};
      let dispatched=false;
      try{const held=services(),{sessions,workspace}=held;if(typeof sessions?.refresh!=='function'||typeof workspace?.openSession!=='function')throw Error('宿主会话导航不可用。');await bounded(sessions.refresh(),'来源会话列表读取超时。');checkServices(services,held);if(!availableSession(sessions,sessionId))throw Error('来源主会话不可访问，请在宿主会话列表核对。');workspace.openSession(sessionId);dispatched=true;const receipt=await navigation.requestVerified({sessionId,returnOnly:true},timeout);return {...receipt,dispatched};}
      catch(error){return {ok:false,message:error.message||'来源会话无法打开。',dispatched};}
    }
  };
}
