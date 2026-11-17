import {reviewTarget,reviewStages,validConversationId} from './conversation-client.mjs';
import {validHmiSnapshot} from './hmi-preview.mjs';

const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const project=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const candidateTools=new Set(['plcdev_propose_project_edit','plcdev_propose_joint','plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text','plcdev_propose_hmi_readonly_value','plcdev_validate_candidate','plcdev_task_status','plcdev_team_assemble']);

/** Only completed calls supplied by this turn's Chat projection may own a card. */
export function turnCandidateResults(nodes){
  const found=new Map();
  const visit=block=>{
    if(!block||typeof block!=='object')return;
    const toolName=block.call?.name;
    if(block.kind&&!block.isError&&candidateTools.has(toolName)){
      try{
        const content=(block.content||[]).filter(x=>x?.type==='text').map(x=>x.text).join('\n');
        if(content.length<=2_000_000){
          const data=JSON.parse(content),target=reviewTarget(data?.task);
          if(target&&(data.task.candidate||toolName.startsWith('plcdev_propose_')||toolName==='plcdev_team_assemble')){
            const key=target.projectId+':'+target.taskId;
            found.set(key,{key,toolName,block,target});
          }
        }
      }catch{}
    }
    for(const child of Array.isArray(block.subCalls)?block.subCalls:[])visit(child);
  };
  for(const node of Array.isArray(nodes)?nodes:[])visit(node?.root);
  return [...found.values()];
}

export function editorOpenRequest(conversationId,task,target){
  const identity=reviewTarget(task);
  if(!validConversationId(conversationId)||!identity||!digest(task.candidate?.candidateDigest))throw new Error('工程修改身份尚未确认，不能打开编辑器。');
  const retained=reviewStages(task)?.retainedProjectId;
  const requested=target||(retained?'retained':'candidate');
  if(!['candidate','retained'].includes(requested)||requested==='retained'&&!retained)throw new Error('修改工程尚未保留。');
  if(requested==='candidate'&&!['awaiting_review','kept','compiled','compile_failed'].includes(task.status))throw new Error('当前候选尚不可预览。');
  return {conversationId,...identity,candidateDigest:task.candidate.candidateDigest,target:requested};
}

export function validateEditorOpen(value,request,task){
  if(value?.ok!==true||value.sourceProjectId!==request.projectId||(request.target==='project'?value.taskId!=null:value.taskId!==request.taskId)||
     typeof value.launchId!=='string'||!value.launchId||!['requested','loaded','failed'].includes(value.state)||
     !project(value.targetProjectId)||typeof value.nativeProjectPath!=='string'||!value.nativeProjectPath||
     value.sessionId!=null&&!validConversationId(value.sessionId)||
     request.target==='retained'&&value.targetProjectId!==reviewStages(task)?.retainedProjectId||
     request.target==='project'&&value.targetProjectId!==request.projectId)
    throw new Error('编辑器打开结果与目标工程不一致，尚未确认打开。');
  return value;
}

export function editorOpenNotice(value,retained=false){
  const prefix=retained?'修改工程已保存。':'';
  if(value?.openingStatus==='waiting')return prefix+'正在等待 OpenPLC 窗口确认，自动核对中…';
  if(value?.openingStatus==='unconfirmed')return prefix+'打开结果待核对；请查看 OpenPLC 窗口，未重复发送打开请求。';
  const observation=value?.observation??value?.editor?.observation;
  if(value?.mode==='preview'){
    const preview=value?.editor?.preview;
    const historical=preview?.historical||retained;
    const history=preview?.status==='discarded'?'候选已撤销；此窗口仍是撤销前的历史预览。'
      :preview?.status==='superseded'?'已有后续修改；此窗口仍是历史预览。'
      :preview?.status==='unverified'?'候选预览的修改记录尚未核对。'
      :historical?'修改已保留；此窗口仍是候选历史预览，请从结果卡打开已保留工程。':'';
    if(observation){
      const observedAt=Date.parse(observation.observedAt),fresh=Number.isFinite(observedAt)&&Date.now()-observedAt>=-2000&&Date.now()-observedAt<=6000;
      if(!fresh||['unknown','stale','unverified'].includes(observation.state))return history+'候选预览当前内容尚未确认。';
      if(observation.state==='mismatch'||observation.state==='not_loaded'||observation.loaded===false)return history+'OpenPLC 尚未加载对应候选预览。';
      if(observation.dirty===true||observation.state==='dirty')return history+'候选预览有未保存调整。';
      if(history)return history;
      if(observation.state==='clean'&&observation.loaded===true&&observation.revisionMatches===true)return '已加载候选预览；尚未保留到工程。';
      return '候选预览当前内容尚未确认。';
    }
    if(history)return history;
    if(value.state==='failed')return '候选预览未能打开，请重试。';
    return value.state==='loaded'?'候选预览已确认打开，当前内容尚未核对。':'已请求打开候选预览，正在等待载入确认。';
  }
  if(observation){
    if(observation.revisionMatches===false)return prefix+(observation.dirty===true?'OpenPLC 有未保存调整，处理后同步新版本。':value?.editor?.sync?.state==='pending'?'OpenPLC 正在同步新版本。':value?.editor?.sync?.state==='available'?'OpenPLC 等待同步新版本。':value?.editor?.sync?.state==='blocked'?(value.editor.sync.reason||'OpenPLC 等待处理当前内容后同步。'):'OpenPLC 仍是旧版本，请重新打开当前工程。');
    const observedAt=Date.parse(observation.observedAt),fresh=Number.isFinite(observedAt)&&Date.now()-observedAt>=-2000&&Date.now()-observedAt<=6000;
    if(!fresh||['unknown','stale','unverified'].includes(observation.state))return prefix+'OpenPLC 当前内容尚未确认。';
    if(observation.state==='mismatch'||observation.state==='not_loaded'||observation.loaded===false)return prefix+'OpenPLC 当前未加载此工程。';
    if(observation.dirty===true||observation.state==='dirty')return prefix+'OpenPLC 有未保存调整。';
    if(observation.state==='clean'&&observation.loaded===true&&observation.revisionMatches===true)return prefix+(value?.editor?.synchronizedFrom?.length?'OpenPLC 已同步到当前保存版本。':'OpenPLC 已加载对应版本，无未保存调整。');
  }
  if(value?.state==='loaded')return prefix+'OpenPLC 已确认打开对应工程。';
  if(value?.state==='failed')return prefix+(value.message||value.error||'OpenPLC 未能打开，请重试打开已有成果。');
  return prefix+'已请求打开 OpenPLC，正在等待工程加载确认。';
}

/** Observe an existing launch; never reopen a window or accept another target. */
export async function readEditorObservation(api,conversationId,receipt){
  if(!validConversationId(conversationId)||typeof receipt?.launchId!=='string'||!receipt.launchId)throw new Error('编辑器观察身份未确认。');
  const value=await api('conversations/editor-status?conversationId='+encodeURIComponent(conversationId)+'&launchId='+encodeURIComponent(receipt.launchId)+(receipt.taskId?'&taskId='+encodeURIComponent(receipt.taskId):''),undefined,15000);
  const sameTarget=value?.nativeProjectPath===receipt.nativeProjectPath&&value?.revision===receipt.revision;
  const synced=value?.mode==='project'&&receipt.mode==='project'&&digest(value.revision)&&Array.isArray(value.editor?.synchronizedFrom)&&value.editor.synchronizedFrom.some(previous=>previous?.nativeProjectPath===receipt.nativeProjectPath&&previous?.revision===receipt.revision);
  if(value?.ok!==true||!['requested','loaded','failed'].includes(value.state)||['sourceProjectId','taskId','candidateDigest','targetProjectId','launchId','sessionId'].some(key=>value[key]!==receipt[key])||(!sameTarget&&!synced))throw new Error('编辑器观察与原打开目标不一致。');
  return value;
}

/** Continue from the same persisted editor conversation without launching a window. */
export async function prepareEditorSession(api,conversationId,task){
  const request=editorOpenRequest(conversationId,task,'retained');
  const value=await api('conversations/editor-session',request,65000);
  if(value?.ok!==true||value.sourceProjectId!==request.projectId||value.taskId!==request.taskId||value.candidateDigest!==request.candidateDigest||value.targetProjectId!==reviewStages(task)?.retainedProjectId||!validConversationId(value.sessionId))
    throw new Error('编辑器会话与保留工程不一致，未跳转。');
  return value;
}

/** Poll the same launch receipt; timeout never causes another editor launch. */
export async function openResultInEditor({api,conversationId,task,projectId,target,onState,isCurrent=()=>true,wait=ms=>new Promise(r=>setTimeout(r,ms)),polls=15}){
  if(target==='project'&&(!validConversationId(conversationId)||!project(projectId)))throw new Error('工程与会话身份尚未确认。');
  const request=target==='project'?{conversationId,projectId,target}:editorOpenRequest(conversationId,task,target);
  const transient=error=>!(error?.httpStatus>=400&&error.httpStatus<500)&&
    (error?.code==='request_timeout'||error?.code==='request_network_error'||error?.code==='upstream_unavailable'||error?.name==='AbortError');
  let result;
  try{result=validateEditorOpen(await api('conversations/editor-open',request,65000),request,task);}
  catch(error){
    // No launch receipt: its side effect may already have completed. Never
    // retry the opening mutation or claim that the native window failed.
    if(!transient(error))throw error;
    const uncertain=new Error('打开请求结果待核对；请查看 OpenPLC 窗口，未重复发送打开请求。');
    uncertain.code='editor_open_unconfirmed';throw uncertain;
  }
  if(isCurrent())onState?.(result);
  let timeouts=0;
  for(let i=0;result.state==='requested'&&i<polls&&isCurrent();i++){
    await wait(1200);
    if(!isCurrent())break;
    let next;
    try{next=await readEditorObservation(api,conversationId,result);}
    catch(error){
      if(!transient(error))throw error;
      // Only re-read this exact launch; at most three transport failures per
      // opening attempt, also bounded by the existing overall poll budget.
      const done=++timeouts>=3||i===polls-1;
      result={...result,openingStatus:done?'unconfirmed':'waiting'};
      if(isCurrent())onState?.(result);
      if(done)break;
      continue;
    }
    if(next?.launchId!==result.launchId)throw new Error('编辑器加载回执与本次打开请求不一致。');
    result=validateEditorOpen(next,request,task);
    if(isCurrent())onState?.(result);
  }
  return result;
}

export function previewUrl(conversationId,task){
  const target=reviewTarget(task);
  if(!validConversationId(conversationId)||!target||!digest(task?.candidate?.candidateDigest))throw new Error('修改记录身份尚未确认，不能读取预览。');
  // Historical preview is read-only. Discarded and superseded records may be
  // inspected, but editorOpenRequest continues to reject their editor launch.
  const identity={conversationId,...target,candidateDigest:task.candidate.candidateDigest};
  return 'conversations/preview?'+new URLSearchParams(identity).toString();
}

export function validateResultPreview(value,task){
  if(value?.projectId!==task.projectId||value?.taskId!==task.taskId||value?.candidateDigest!==task.candidate?.candidateDigest||!Array.isArray(value.files)||value.files.length>128)
    throw new Error('修改预览与当前候选不一致。');
  for(const file of value.files){
    if(typeof file?.path!=='string'||!file.path||file.path.length>1024||!['st','ld','text','metadata','hmi'].includes(file.kind)||
       ![file.beforeText,file.afterText].every(text=>text===null||typeof text==='string'&&text.length<=524288))
      throw new Error('修改预览内容格式无效。');
    if(file.kind==='hmi'&&(file.beforeText!==null||file.afterText!==null||
       !validHmiSnapshot(file.beforeHmi)||!validHmiSnapshot(file.afterHmi)))
      throw new Error('HMI 画面预览格式无效。');
  }
  return value;
}

/** Bound LCS to keep a large generated file from blocking the review page. */
export function textDiff(before,after,maxLines=500){
  const a=before?String(before).split('\n'):[],b=after?String(after).split('\n'):[];
  if(a.length>maxLines||b.length>maxLines)return {large:true,before:String(before||''),after:String(after||'')};
  const rows=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
  const lines=[];let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){lines.push({kind:'same',text:a[i],before:++i,after:++j});}
    else if(j<b.length&&(i===a.length||rows[i][j+1]>=rows[i+1][j]))lines.push({kind:'add',text:b[j],before:null,after:++j});
    else lines.push({kind:'remove',text:a[i],before:++i,after:null});
  }
  return {large:false,lines};
}

export function ladderDeclarations(text){return typeof text==='string'?text.split(/\r?\n\s*\{/)[0].trim():'';}
export function ladderSummary(graph){
  if(!graph||!Array.isArray(graph.rungs))return null;
  return graph.rungs.slice(0,64).map((rung,index)=>({
    index:index+1,comment:typeof rung.comment==='string'?rung.comment:'',
    nodes:(Array.isArray(rung.nodes)?rung.nodes:[]).filter(n=>n&&['contact','coil','block','variable'].includes(n.type)).map(n=>({
      type:n.type,name:typeof n.data?.variable?.name==='string'?n.data.variable.name:'',
      variant:typeof n.data?.variant==='string'?n.data.variant:null,
      blockName:typeof n.data?.variant?.name==='string'?n.data.variant.name:null,
      bindings:(Array.isArray(n.data?.connectedVariables)?n.data.connectedVariables:[]).map(v=>({port:String(v.handleId||''),variable:String(v.variable?.name||'')})),
    })),
    connectionCount:Array.isArray(rung.edges)?rung.edges.length:0,
  }));
}
