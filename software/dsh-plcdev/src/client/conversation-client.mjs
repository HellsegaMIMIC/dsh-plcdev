import { makeCandidateRequest, candidateIdentity, externalRuntimeOwner, runtimeOwnerLabel } from './model.mjs';

const projectPattern = /^[a-z][a-z0-9-]{0,63}$/;
const taskPattern = /^task-[0-9a-f]{32}$/;
export const PENDING_PREFIX = 'plcdev.dsh.d2.conversation-request.';
export const REVIEW_PREFIX = 'plcdev.dsh.d2.review-bookmark.';
export function validConversationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}
export function validateBinding(value, conversationId) {
  if (!validConversationId(conversationId) || value?.conversationId !== conversationId ||
      !(value.projectId === null || projectPattern.test(value.projectId || '')) ||
      !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.taskRefs) || !Array.isArray(value.pendingRequests))
    throw new Error('DSH 会话工程归属未获确认，已停用任务操作。');
  if (value.taskRefs.some(ref => !projectPattern.test(ref?.projectId || '') || !taskPattern.test(ref?.taskId || '')) ||
      value.pendingRequests.some(ref => !projectPattern.test(ref?.projectId || '') || typeof ref?.clientRequestId !== 'string' || !['pending','unknown'].includes(ref.state)))
    throw new Error('会话任务引用无效，已拒绝显示。');
  return value;
}
export function bindRequest(binding, projectId) {
  if (!binding || !validConversationId(binding.conversationId) || !projectPattern.test(projectId || '') || !Number.isSafeInteger(binding.version))
    throw new Error('请先读取会话状态并选择已登记工程。');
  return {conversationId:binding.conversationId, projectId, expectedVersion:binding.version};
}
export function conversationTaskRequest(binding, { request, revision, consent, clientRequestId, workflow }) {
  if (!binding || !validConversationId(binding.conversationId) || !binding.projectId || !Number.isSafeInteger(binding.version))
    throw new Error('本对话尚未关联工程。');
  if(workflow!==undefined&&workflow!=='joint-ai-v1')throw new Error('未知的候选工作流。');
  return {...makeCandidateRequest({projectId:binding.projectId,request,revision,consent,clientRequestId}), conversationId:binding.conversationId, expectedVersion:binding.version,...(workflow?{workflow}:{})};
}
export function referenceTasks(binding, taskList) {
  if (!binding || !taskList || taskList.projectId !== binding.projectId) return [];
  const refs = new Set(binding.taskRefs.filter(ref=>ref.projectId===binding.projectId).map(ref=>ref.taskId));
  return taskList.tasks.filter(task=>task.projectId===binding.projectId && refs.has(task.taskId));
}
export function saveConversationPending(storage, value) {
  storage.setItem(PENDING_PREFIX + value.conversationId, JSON.stringify(value));
}
export function readConversationPending(storage, conversationId) {
  try {
    const value=JSON.parse(storage.getItem(PENDING_PREFIX+conversationId)||'null');
    return recoverConversationRequest(value,conversationId);
  } catch { return null; }
}
export function recoverConversationRequest(value,conversationId) {
  if(value?.conversationId !== conversationId || !projectPattern.test(value?.projectId || '') || !Number.isSafeInteger(value?.expectedVersion) || value.expectedVersion<0 || value.executionScope!=='proposal' || value.sourceBasis!=='saved_revision' || !/^[0-9a-f]{64}$/.test(value.expectedRevision||'') || !/^[A-Za-z0-9_-]{1,100}$/.test(value.clientRequestId||''))return null;
  if(value.revisionParent&&(!taskPattern.test(value.revisionParent.taskId||'')||!/^[0-9a-f]{64}$/.test(value.revisionParent.candidateDigest||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(value.revisionIntentId||'')))return null;
  try{return {...conversationTaskRequest({conversationId,projectId:value.projectId,version:value.expectedVersion},{request:value.request,revision:value.expectedRevision,consent:true,clientRequestId:value.clientRequestId,workflow:value.workflow}),...(value.planSubmission?{planSubmission:value.planSubmission}:{}),...(value.revisionParent?{revisionParent:value.revisionParent,revisionIntentId:value.revisionIntentId}:{})};}catch{return null;}
}
export function clearConversationPending(storage, conversationId) {storage.removeItem(PENDING_PREFIX+conversationId);}
export function reviewTarget(value) {
  if (typeof value?.projectId !== 'string' || typeof value?.taskId !== 'string' || !projectPattern.test(value.projectId) || !taskPattern.test(value.taskId)) return null;
  return {projectId:value.projectId,taskId:value.taskId};
}
/** A presentation bookmark only. TaskService is always queried again before showing a candidate. */
export function saveReviewBookmark(storage, conversationId, value) {
  const target=reviewTarget(value);if(!validConversationId(conversationId)||!target)return false;
  storage.setItem(REVIEW_PREFIX+conversationId,JSON.stringify({schemaVersion:1,conversationId,...target}));return true;
}
export function restoredReviewTarget(storage, conversationId, params) {
  // An invalid explicit navigation must not fall back to a previous selection.
  if(params !== undefined && params !== null)return reviewTarget(params);
  if(!validConversationId(conversationId))return null;
  try{const value=JSON.parse(storage.getItem(REVIEW_PREFIX+conversationId)||'null');return value?.schemaVersion===1&&value.conversationId===conversationId?reviewTarget(value):null;}catch{return null;}
}
export function runtimeDockLabel(snapshot,projectId) {
  if(!snapshot || !projectId || snapshot.project?.id!==projectId)return '未核验';
  if(snapshot.runtimeOwner?.state==='unknown')return runtimeOwnerLabel(snapshot.runtimeOwner);
  const owner=externalRuntimeOwner(snapshot);if(owner)return runtimeOwnerLabel(owner);
  if(snapshot.session?.active){
    if(snapshot.observerFresh!==true)return '运行数据失效';
    const state=snapshot.state?.runtimeState||snapshot.session.runtimeState;
    return ({RUN:'运行中',RUNNING:'运行中',STOP:'已停止',STOPPED:'已停止',UNKNOWN:'状态未确认',FAULT:'异常'})[state]||'状态未确认';
  }
  const phase=snapshot.session?.phase||snapshot.phase;
  if(phase==='building')return '正在准备';if(phase==='fault')return '异常';if(phase==='ended')return '已结束';
  if(snapshot.session?.active===false && !snapshot.session?.id && snapshot.runtimeOwner===null)return '本工程未创建';
  return '未核验';
}
/**
 * Project display identity for review surfaces. Name is shown only when the
 * status response really carried one for the exact project id; nothing is guessed.
 */
export function projectIdentity(status, expectedProjectId) {
  if (!status || status.project?.id !== expectedProjectId) return null;
  const name = typeof status.project.name === 'string' && status.project.name.trim() ? status.project.name.trim() : null;
  const listed = Array.isArray(status.projects) ? status.projects.find(p => p.id === expectedProjectId) : null;
  const listedName = typeof listed?.name === 'string' && listed.name.trim() ? listed.name.trim() : null;
  return {id: expectedProjectId, name: name || listedName};
}
export function projectLabel(identity) {
  if (!identity?.name) return '工程名称未提供';
  return identity.name;
}
/** The saved revision TaskService reports now, compared with a task's input baseline. */
export function revisionBasis(taskProjectRevision, currentRevision) {
  const baseline = /^[0-9a-f]{64}$/.test(taskProjectRevision || '') ? taskProjectRevision : null;
  const current = /^[0-9a-f]{64}$/.test(currentRevision || '') ? currentRevision : null;
  if (!baseline) return {baseline: null, current, same: null};
  if (!current) return {baseline, current: null, same: null};
  return {baseline, current, same: baseline === current};
}
/** Layered review states: validation, retention, compilation and Runtime never merge. */
export function reviewStages(task) {
  if (!task) return null;
  const status = task.status;
  const validation = task.candidate?.validation;
  let validationState = 'untested';
  if (validation?.ok === true || validation?.status === 'passed' || validation?.state === 'passed') validationState = 'passed';
  else if (validation?.ok === false || validation?.status === 'failed' || validation?.state === 'failed') validationState = 'failed';
  else if (['joint-native-structure-and-bindings','native-structure-types-addresses-permission-nonexpansion'].includes(validation)) validationState = 'recorded';
  else if (validation) validationState = 'unknown';
  const retention = task.retention;
  const retainedProjectId = projectPattern.test(retention?.keptProjectId || '') && retention.keptProjectId !== task.projectId ? retention.keptProjectId : null;
  const retentionState = retainedProjectId ? 'kept' : status === 'keeping' ? 'keeping' : status === 'discarding' ? 'discarding' : status === 'discarded' ? 'discarded' : ['unknown_outcome','conflict','kept','compiled','compile_failed'].includes(status) ? 'unknown' : 'unretained';
  const compilationRaw = task.compilation?.status;
  const compilationState = status === 'conflict' ? 'conflict' : status === 'unknown_outcome' ? 'unknown' : status === 'compiling' ? 'running' : status === 'compile_failed' ? 'failed' : compilationRaw === 'compiled' ? 'passed' : ['failed','compile_failed'].includes(compilationRaw) ? 'failed' : ['compiling','running','pending'].includes(compilationRaw) ? 'running' : compilationRaw ? 'unknown' : 'untested';
  return {
    validation: validationState,
    retention: retentionState,
    retainedProjectId,
    compilation: compilationState,
    compilationRaw: compilationRaw || null,
    historicalCompilation: compilationRaw === 'compiled' && compilationState !== 'passed',
    runtime: 'untested',
    status,
  };
}
export function stageLabel(kind, state) {
  const table = {
    validation: {passed:'已校验通过', recorded:'结构与绑定校验已记录', failed:'校验失败', unknown:'校验结果未确认', untested:'未校验', pending:'校验中'},
    retention: {kept:'已保留为新工程', keeping:'正在保留', discarding:'正在撤销', discarded:'候选已撤销', unretained:'未保留', pending:'保留处理中', unknown:'保留结果未确认'},
    compilation: {passed:'编译通过', conflict:'本次操作版本冲突', failed:'编译失败', running:'正在编译', unknown:'编译结果未确认', untested:'未编译'},
    runtime: {untested:'本任务无运行验收', unknown:'Runtime 状态未确认'},
  };
  return table[kind]?.[state] || '状态未确认';
}
export function stageTone(kind, state) {
  if (kind === 'retention' && state === 'kept') return 'good';
  if (kind === 'compilation' && state === 'passed') return 'good';
  if (kind === 'validation' && state === 'passed') return 'good';
  if (['failed','discarded','conflict'].includes(state)) return 'bad';
  if (['running','keeping','discarding','unknown'].includes(state)) return 'warn';
  return 'muted';
}
export function stageColor(tone) {
  // Native state tokens are accent fills (idle is near-white in light mode).
  // Blend accents with inherited text, and keep untested evidence fully legible.
  if (tone === 'good') return 'color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f5a) 60%,currentColor)';
  if (tone === 'bad') return 'color-mix(in srgb,var(--dsw-alias-state-error-primary,#b42318) 60%,currentColor)';
  if (tone === 'warn') return 'color-mix(in srgb,var(--dsw-alias-state-warn-primary,#8b5b14) 60%,currentColor)';
  return 'inherit';
}
/** Per-artifact summaries exactly as TaskService reports them; missing means not provided. */
export function artifactRows(task) {
  const components = Array.isArray(task?.candidate?.components) ? task.candidate.components : [];
  return [['openplc','OpenPLC','PLC'],['fuxa','FUXA','HMI'],['oip','OIP','场景']].map(([tool,name,badge]) => {
    const component = components.find(item => item?.tool === tool);
    const widgets = Number.isSafeInteger(component?.widgets) ? component.widgets : null;
    return {tool,name,badge,component:component||null,summary:component?.summary||null,widgets};
  });
}
export function reviewedCandidate(task, target) {
  if(!target || task?.taskId!==target.taskId) return null;
  return candidateIdentity(task,target.projectId);
}
export function reviewActionRequest(conversationId, task, target, action, clientRequestId) {
  if(!validConversationId(conversationId)||!reviewTarget(target)||task?.projectId!==target.projectId||task?.taskId!==target.taskId||!['joint-ai-v1','team-generation-v1'].includes(task.workflow)||!/^[0-9a-f]{64}$/.test(task.candidate?.candidateDigest||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(clientRequestId||''))return null;
  const states={keep:['awaiting_review'],undo:['awaiting_review'],compile:['kept','compiled','compile_failed']};
  if(!states[action]?.includes(task.status))return null;
  const expectedRevision=action==='compile'?task.retention?.revision:task.projectRevision;
  if(!/^[0-9a-f]{64}$/.test(expectedRevision||''))return null;
  return {conversationId,projectId:target.projectId,taskId:target.taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision,action,clientRequestId};
}
export function reviewPendingKey(conversationId,target){return validConversationId(conversationId)&&reviewTarget(target)?'plcdev.dsh.d3.review.'+conversationId+'.'+target.projectId+'.'+target.taskId:null;}
export function readReviewPending(storage,conversationId,target){
  const key=reviewPendingKey(conversationId,target);if(!key)return null;
  const value=JSON.parse(storage.getItem(key)||'null');if(!value)return null;
  if(value.conversationId!==conversationId||value.projectId!==target.projectId||value.taskId!==target.taskId||!['keep','undo','compile'].includes(value.action)||!/^[0-9a-f]{64}$/.test(value.candidateDigest||'')||!/^[0-9a-f]{64}$/.test(value.expectedRevision||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(value.clientRequestId||''))throw new Error('保存的审阅请求无效，请保留现场核对。');
  return value;
}
export async function conversationApi(path, body, timeout = 15000) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch('/api/plcdev/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(globalThis.location?.protocol==='dsh-app:'?{'X-PLCdev-Desktop':'1'}:{})},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal:controller.signal});
    const value=await response.json().catch(()=>null);
    if(!response.ok){const error=new Error(value?.error||value?.message||`PLCdev 请求失败（${response.status}）`);error.httpStatus=response.status;throw error;}
    if(!value || typeof value!=='object') throw new Error('PLCdev 未返回有效响应。');
    return value;
  } finally {clearTimeout(timer);}
}

// Presentation-only navigation intent. It never binds a conversation or sends a task.
export function createConversationNavigation() {
  let intent=null; const listeners=new Set();
  return {
    snapshot:()=>intent,
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    request(value){const target=reviewTarget(value); if(!projectPattern.test(value?.projectId||''))return;intent={...(validConversationId(value?.sessionId)?{sessionId:value.sessionId}:{}),projectId:value.projectId,...(target?{taskId:target.taskId}:{}),nonce:Date.now()};listeners.forEach(fn=>fn());},
    clear(value){if(intent===value){intent=null;listeners.forEach(fn=>fn());}},
  };
}
