import { makeCandidateRequest, candidateIdentity, externalRuntimeOwner, runtimeOwnerLabel, runtimeObservationFresh } from './model.mjs';
import {matchesHmiPlan} from '../hmi-intent.mjs';
import {validProjectEditSubmission} from '../project-edit-contract.mjs';

const projectPattern = /^[a-z][a-z0-9-]{0,63}$/;
const taskPattern = /^task-[0-9a-f]{32}$/;
export const PENDING_PREFIX = 'plcdev.dsh.d2.conversation-request.';
export const REVIEW_PREFIX = 'plcdev.dsh.d2.review-bookmark.';
export function validConversationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}
// The absence of a new-server participation field must never turn a legacy
// engineering conversation into ordinary chat or unlock retained history.
export function conversationParticipation(binding) {
  const history=!!(binding?.taskRefs?.length||binding?.pendingRequests?.length||binding?.submissionInFlight?.length||binding?.submissionConflicts?.length||binding?.revisionContext);
  const locked=binding?.participation?.locked===true||history;
  return {enabled:!!binding?.projectId||locked||binding?.participation?.enabled===true,locked};
}
export function validateBinding(value, conversationId) {
  if (!validConversationId(conversationId) || value?.conversationId !== conversationId ||
      !(value.projectId === null || projectPattern.test(value.projectId || '')) ||
      !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.taskRefs) || !Array.isArray(value.pendingRequests))
    throw new Error('DSH 会话工程归属未获确认，已停用任务操作。');
  if (value.taskRefs.some(ref => !projectPattern.test(ref?.projectId || '') || !taskPattern.test(ref?.taskId || '')) ||
      value.pendingRequests.some(ref => !projectPattern.test(ref?.projectId || '') || typeof ref?.clientRequestId !== 'string' || !['pending','unknown'].includes(ref.state)))
    throw new Error('会话任务引用无效，已拒绝显示。');
  if(value.participation!==undefined){
    const mode=value.participation;
    if(!mode||typeof mode!=='object'||Array.isArray(mode)||Object.keys(mode).sort().join(',')!=='enabled,locked'||
      typeof mode.enabled!=='boolean'||typeof mode.locked!=='boolean'||
      !mode.enabled&&(value.projectId!==null||mode.locked||conversationParticipation({...value,participation:undefined}).enabled)||
      !mode.locked&&conversationParticipation({...value,participation:undefined}).locked)
      throw new Error('会话的 PLCdev 状态无法核对，已停用工程操作。');
  }
  if(value.submissionConflicts!==undefined){
    const conflicts=value.submissionConflicts;
    if(!Array.isArray(conflicts)||conflicts.length>32||new Set(conflicts.map(c=>c?.clientRequestId)).size!==conflicts.length||conflicts.some(c=>
      !c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='acceptedTaskId,clientRequestId,observedTaskIds,projectId'||
      !projectPattern.test(c.projectId||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(c.clientRequestId||'')||!taskPattern.test(c.acceptedTaskId||'')||
      !Array.isArray(c.observedTaskIds)||!c.observedTaskIds.length||c.observedTaskIds.length>16||new Set(c.observedTaskIds).size!==c.observedTaskIds.length||
      c.observedTaskIds.some(id=>!taskPattern.test(id||'')||id===c.acceptedTaskId)||
      !value.taskRefs.some(ref=>ref.projectId===c.projectId&&ref.taskId===c.acceptedTaskId&&ref.clientRequestId===c.clientRequestId)))
      throw new Error('会话任务身份冲突无法安全核对，已停用操作。');
  }
  if(value.submissionInFlight!==undefined){
    const flights=value.submissionInFlight;
    if(!Array.isArray(flights)||flights.length>32||new Set(flights.map(f=>f?.clientRequestId)).size!==flights.length||flights.some(f=>
      !f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).sort().join(',')!=='clientRequestId,projectId,state'||
      !projectPattern.test(f.projectId||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(f.clientRequestId||'')||
      !['active_or_unknown','owner_exited','legacy_unknown','evidence_conflict'].includes(f.state)||
      !value.pendingRequests.some(ref=>ref.projectId===f.projectId&&ref.clientRequestId===f.clientRequestId)&&
      !value.taskRefs.some(ref=>ref.projectId===f.projectId&&ref.clientRequestId===f.clientRequestId)))
      throw new Error('会话在途请求无法安全核对，已停用操作。');
  }
  return value;
}
export function bindRequest(binding, projectId) {
  if (!binding || !validConversationId(binding.conversationId) || !(projectId===null||projectPattern.test(projectId || '')) || !Number.isSafeInteger(binding.version))
    throw new Error('请先读取会话状态并选择已登记工程。');
  if(projectId===null&&conversationParticipation(binding).locked)
    throw new Error('此会话已有工程操作，请保留工程关联；普通聊天请新建会话。');
  return {conversationId:binding.conversationId, projectId, expectedVersion:binding.version};
}
export function conversationTaskRequest(binding, { request, revision, consent, clientRequestId, workflow }) {
  if (!binding || !validConversationId(binding.conversationId) || !binding.projectId || !Number.isSafeInteger(binding.version))
    throw new Error('本对话尚未关联工程。');
  if(workflow!==undefined&&!['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(workflow))throw new Error('未知的候选工作流。');
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
  if(value.workflow==='project-edit-v1'&&!validProjectEditSubmission(value.planSubmission))return null;
  if(value.revisionParent){
    const parent=value.revisionParent;
    if(typeof parent!=='object'||Array.isArray(parent)||Object.keys(parent).length!==2||!Object.hasOwn(parent,'taskId')||!Object.hasOwn(parent,'candidateDigest')||!taskPattern.test(parent.taskId||'')||!/^[0-9a-f]{64}$/.test(parent.candidateDigest||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(value.revisionIntentId||''))return null;
  }else if(value.revisionIntentId!==undefined||value.revisionParent!==undefined)return null;
  if(value.workflow==='hmi-view-name-v1'){
    const submission=value.planSubmission,plan=submission?.plan,route=submission?.route;
    const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(k=>Object.hasOwn(object,k));
    if(!exact(submission,['schemaVersion','plan','route'])||submission.schemaVersion!==1||!exact(plan,['viewId','name'])||!exact(route,['provider','model'])||typeof plan.viewId!=='string'||!plan.viewId||plan.viewId.length>120||/[\x00-\x1f]/.test(plan.viewId)||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>80||/[\x00-\x1f<>]/.test(plan.name)||!matchesHmiPlan(value.workflow,value.request,plan)||Object.values(route).some(v=>typeof v!=='string'||!v||v.length>160))return null;
  }
  if(value.workflow==='hmi-static-text-v1'){
    const submission=value.planSubmission,plan=submission?.plan,route=submission?.route;
    const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(k=>Object.hasOwn(object,k));
    if(!exact(submission,['schemaVersion','plan','route'])||submission.schemaVersion!==1||!exact(plan,['viewId','elementId','text'])||!exact(route,['provider','model'])||typeof plan.viewId!=='string'||!plan.viewId||plan.viewId.length>120||/[\x00-\x1f]/.test(plan.viewId)||typeof plan.elementId!=='string'||!/^PLCD_[A-Za-z0-9_-]{1,100}$/.test(plan.elementId)||typeof plan.text!=='string'||!plan.text.trim()||plan.text.length>160||/[\x00-\x1f<>]/.test(plan.text)||!matchesHmiPlan(value.workflow,value.request,plan)||Object.values(route).some(v=>typeof v!=='string'||!v||v.length>160))return null;
  }
  if(value.workflow==='hmi-readonly-value-v1'){
    const submission=value.planSubmission,plan=submission?.plan,route=submission?.route;
    const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(k=>Object.hasOwn(object,k));
    if(value.revisionParent||!exact(submission,['schemaVersion','plan','route'])||submission.schemaVersion!==1||!exact(plan,['viewId','signalId'])||!exact(route,['provider','model'])||Object.values(plan).some(v=>typeof v!=='string'||!v.trim()||v.length>120||/[\x00-\x1f]/.test(v))||!matchesHmiPlan(value.workflow,value.request,plan)||Object.values(route).some(v=>typeof v!=='string'||!v||v.length>160))return null;
  }
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
export function runtimeDockLabel(snapshot,projectId,now=Date.now()) {
  if(!snapshot || !projectId || snapshot.project?.id!==projectId)return '未核验';
  if(snapshot.runtimeOwner?.state==='unknown')return runtimeOwnerLabel(snapshot.runtimeOwner);
  const owner=externalRuntimeOwner(snapshot);if(owner)return runtimeOwnerLabel(owner);
  const phase=snapshot.session?.phase||snapshot.phase;
  if(phase==='building')return '正在准备';if(phase==='stopping')return '正在结束';
  if(snapshot.session?.active){
    if(!runtimeObservationFresh(snapshot,now))return '运行状态未知';
    const state=snapshot.state?.runtimeState;
    return ({RUN:'运行中',RUNNING:'运行中',STOP:'已停止',STOPPED:'已停止',UNKNOWN:'状态未确认',FAULT:'异常'})[state]||'状态未确认';
  }
  if(phase==='fault')return '异常';if(phase==='ended')return '已结束';
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
  else if (validation === 'native-structure-only') validationState = 'structure_recorded';
  else if (validation) validationState = 'unknown';
  const retention = task.retention;
  const savedToCurrent = retention?.completionScope === 'saved-project-version' && /^[a-f0-9]{64}$/.test(retention?.revision || '');
  const retainedProjectId = projectPattern.test(retention?.keptProjectId || '') && (retention.keptProjectId !== task.projectId || savedToCurrent) ? retention.keptProjectId : null;
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
    validation: {passed:'已校验通过', recorded:'结构与绑定校验已记录', structure_recorded:'结构校验已记录', failed:'校验失败', unknown:'校验结果未确认', untested:'未校验', pending:'校验中'},
    retention: {kept:'已保留', keeping:'正在保留', discarding:'正在撤销', discarded:'候选已撤销', unretained:'未保留', pending:'保留处理中', unknown:'保留结果未确认'},
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
/** Display only supported summary shapes from TaskService, never raw objects. */
export function artifactSummary(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && !Array.isArray(value) && typeof value === 'object' &&
      typeof value.before === 'string' && typeof value.after === 'string')
    return value.before + ' → ' + value.after;
  return null;
}
export function artifactRows(task) {
  const components = Array.isArray(task?.candidate?.components) ? task.candidate.components : [];
  return [['openplc','OpenPLC','PLC'],['fuxa','FUXA','HMI'],['oip','OIP','场景']].map(([tool,name,badge]) => {
    const component = components.find(item => item?.tool === tool);
    const widgets = Number.isSafeInteger(component?.widgets) ? component.widgets : null;
    const summary=task?.workflow==='project-edit-v1'
      ? components.filter(item=>item?.tool===tool).map(item=>artifactSummary(item.summary)).filter(Boolean).join('；')||null
      : artifactSummary(component?.summary);
    return {tool,name,badge,component:component||null,summary,widgets};
  });
}
/** File-level differences supplied by TaskService against the fixed source.
 * Missing or malformed evidence is unknown, never an invented empty diff. */
export function candidateChanges(task) {
  const changes = task?.candidate?.changes;
  if (!Array.isArray(changes)) return null;
  const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (changes.some(row => !row || typeof row.path !== 'string' || !row.path.trim() ||
      !(digest(row.beforeSha256)||(task.workflow==='project-edit-v1'&&row.beforeSha256===null)) ||
      !(digest(row.afterSha256)||(task.workflow==='project-edit-v1'&&row.afterSha256===null)) ||
      (row.beforeSha256===null&&row.afterSha256===null))) return null;
  return changes.filter(row => row.beforeSha256 !== row.afterSha256)
    .map(({path,beforeSha256,afterSha256}) => ({path,beforeSha256,afterSha256}));
}
export function reviewedCandidate(task, target) {
  if(!target || task?.taskId!==target.taskId) return null;
  return candidateIdentity(task,target.projectId);
}
export function reviewActionRequest(conversationId, task, target, action, clientRequestId) {
  if(!validConversationId(conversationId)||!reviewTarget(target)||task?.projectId!==target.projectId||task?.taskId!==target.taskId||!['joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(task.workflow)||!/^[0-9a-f]{64}$/.test(task.candidate?.candidateDigest||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(clientRequestId||''))return null;
  if (task.supersededBy && action !== 'compile') return null;
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
// A receipt check is read-only and must use an existing accepted request or
// the original locally saved request; never invent a new effect identifier.
export function reviewReceiptRequest(conversationId,task,target,pending){
  const request=pending?.action==='keep'?pending:task?.reviewReceiptRequest;
  if(!validConversationId(conversationId)||!reviewTarget(target)||!['joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(task?.workflow)||task?.projectId!==target.projectId||task?.taskId!==target.taskId||
    request?.projectId!==target.projectId||request?.taskId!==target.taskId||request.action!=='keep'||
    request.candidateDigest!==task?.candidate?.candidateDigest||request.expectedRevision!==task?.projectRevision||
    !/^[0-9a-f]{64}$/.test(request.candidateDigest||'')||!/^[0-9a-f]{64}$/.test(request.expectedRevision||'')||
    !/^[A-Za-z0-9_-]{1,100}$/.test(request.clientRequestId||'')||
    (request.conversationId!==undefined&&request.conversationId!==conversationId))return null;
  return {conversationId,projectId:request.projectId,taskId:request.taskId,candidateDigest:request.candidateDigest,
    expectedRevision:request.expectedRevision,action:'keep',clientRequestId:request.clientRequestId};
}
export function validateReviewReceipt(value,request){
  if(value?.ok!==true||!request||['projectId','taskId','candidateDigest','clientRequestId'].some(k=>value[k]!==request[k])||
     !['confirmed_registered','confirmed_unregistered','unknown'].includes(value.state))throw new Error('保存回执归属或状态未确认。');
  if(value.state==='unknown'){
    if(value.keptProjectId!==null||value.manifestPath!==null||value.revision!==null||value.completionScope!==undefined||value.version!==undefined)throw new Error('未知回执包含未经确认的保存结果。');
  } else if(!projectPattern.test(value.keptProjectId||'')||typeof value.manifestPath!=='string'||!value.manifestPath||
    !/^[0-9a-f]{64}$/.test(value.revision||'')||
    (value.keptProjectId===value.projectId&&(value.completionScope!=='saved-project-version'||!Number.isSafeInteger(value.version)||value.version<2))||
    (value.keptProjectId!==value.projectId&&(value.completionScope!==undefined||value.version!==undefined)))throw new Error('保存身份或版本未确认。');
  return value;
}
export async function conversationApi(path, body, timeout = 15000) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const options={method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(globalThis.location?.protocol==='dsh-app:'?{'X-PLCdev-Desktop':'1'}:{})},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal:controller.signal};
    let response;
    try{response=await fetch('/api/plcdev/'+path,options);}
    catch(error){
      if(error?.name!=='TypeError'||controller.signal.aborted)throw error;
      const networkError=new Error('PLCdev 连接暂时中断；请求结果尚未确认，请核对后再操作。');
      networkError.code='request_network_error';throw networkError;
    }
    const value=await response.json().catch(()=>null);
    if(!response.ok){const error=new Error(value?.error||value?.message||`PLCdev 请求失败（${response.status}）`);error.httpStatus=response.status;if(typeof value?.code==='string')error.code=value.code;throw error;}
    if(!value || typeof value!=='object') throw new Error('PLCdev 未返回有效响应。');
    return value;
  } catch(error) {
    if(controller.signal.aborted){
      const timeoutError=new Error('PLCdev 响应超时；请求结果尚未确认，请核对后再操作。');
      timeoutError.code='request_timeout';throw timeoutError;
    }
    throw error;
  } finally {clearTimeout(timer);}
}

// Presentation-only navigation intent. It never binds a conversation or sends a task.
export function createConversationNavigation() {
  let intent=null, waiter=null; const listeners=new Set();
  const finish=(value,ok,message,notify=true)=>{
    if(intent!==value)return;
    intent=null;
    if(waiter?.intent===value){const pending=waiter;waiter=null;clearTimeout(pending.timer);pending.resolve({ok,message});}
    if(notify)listeners.forEach(fn=>fn());
  };
  function build(value,verified=false){if(verified&&value?.returnOnly===true&&validConversationId(value.sessionId))return {sessionId:value.sessionId,returnOnly:true,verified,nonce:Date.now()};const target=reviewTarget(value);if(!projectPattern.test(value?.projectId||'')||verified&&!validConversationId(value?.sessionId))return null;return {...(validConversationId(value?.sessionId)?{sessionId:value.sessionId}:{}),projectId:value.projectId,...(target?{taskId:target.taskId}:{}),verified,nonce:Date.now()};}
  return {
    snapshot:()=>intent,
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    request(value){const next=build(value);if(!next)return;if(intent)finish(intent,false,'导航被更新',false);intent=next;listeners.forEach(fn=>fn());},
    requestVerified(value,timeout=5000){
      const next=build(value,true);if(!next)return Promise.resolve({ok:false,message:'会话或任务身份无效。'});
      if(intent)finish(intent,false,'导航被更新',false);intent=next;
      return new Promise(resolve=>{const timer=setTimeout(()=>finish(next,false,'所属会话未确认打开，请在宿主会话列表中核对。'),timeout);waiter={intent:next,resolve,timer};listeners.forEach(fn=>fn());});
    },
    clear(value){finish(value,false,'导航已取消');},
    complete(value){finish(value,true,'已向目标会话请求打开审阅或会话');},
    fail(value,message){finish(value,false,message||'目标会话无法确认。');},
  };
}
