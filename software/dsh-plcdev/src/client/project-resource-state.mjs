import {graphEntities} from './model.mjs';
import {validateBinding,validConversationId} from './conversation-client.mjs';
import {candidateOperationGroups} from './candidate-operations.mjs';

const projectPattern=/^[a-z][a-z0-9-]{0,63}$/;
const taskPattern=/^task-[0-9a-f]{32}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const workflows=new Set(['project-edit-v1','joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1']);
const toolNames={plc:'openplc',openplc:'openplc',hmi:'fuxa',fuxa:'fuxa',oip:'oip'};
const roles={openplc:'PLC 工程',fuxa:'HMI 画面工程',oip:'仿真场景'};
const kindLabels={added:'本轮新增 · 待保留',modified:'本轮修改 · 待保留',removed:'本轮移除 · 待保留'};
const normalizedPath=value=>typeof value==='string'?value.replaceAll('\\','/').replace(/^\.\//,'').toLowerCase():'';

function rowKind(group,saved){
  if(!saved)return 'added';
  // Deleting a POU, image, or part file does not remove its whole tool. Only a
  // verified deletion of the saved resource's entry file supports that label.
  const path=normalizedPath(saved.path);
  return path&&group.files.some(file=>normalizedPath(file.path)===path&&file.afterSha256===null)?'removed':'modified';
}

/**
 * Display projection only. The saved graph stays separate from this session's
 * pending proposals; neither saved capabilities nor this projection authorize
 * a candidate open. Callers must use the task/digest-bound result endpoint.
 * `tasks` is a fresh task-state response, including its saved projectRevision.
 */
export function projectResourceState({projectId,sessionId,snapshot,binding,tasks}={}){
  const result={saved:[],pending:[]};
  const error=message=>({...result,error:message});
  if(!projectPattern.test(projectId||''))return error('工程身份尚未确认。');
  if(snapshot&&snapshot.project?.id!==projectId)return error('工程资源返回了其他工程，已停用显示。');
  if(snapshot)result.saved=graphEntities(snapshot).filter(row=>row.tool);
  if(!validConversationId(sessionId))return error('当前会话身份尚未确认。');
  if(!binding)return error('本轮修改的会话归属尚未确认。');
  try{validateBinding(binding,sessionId);}catch{return error('本轮修改的会话归属尚未确认。');}
  // Looking at another project never imports its own or another chat's drafts.
  if(binding.projectId!==projectId)return result;
  const refs=new Set(binding.taskRefs.filter(ref=>ref.projectId===projectId).map(ref=>ref.taskId));
  if(!refs.size)return result;
  if(!tasks)return error('本轮修改尚未读取。');
  if(tasks.projectId!==projectId||!Array.isArray(tasks.tasks)||tasks.tasks.some(task=>!task||task.projectId!==projectId))return error('本轮修改返回了其他工程，已停用显示。');
  const seen=new Set(),errors=[];
  const savedByTool=new Map(result.saved.map(row=>[toolNames[row.tool]||row.tool,row]));
  const savedRevision=hashPattern.test(tasks.projectRevision||'')?tasks.projectRevision:null;
  for(const task of tasks.tasks){
    if(!refs.has(task.taskId)||task.status!=='awaiting_review'||task.supersededBy||!workflows.has(task.workflow))continue;
    if(!taskPattern.test(task.taskId||'')||!hashPattern.test(task.candidate?.candidateDigest||'')){
      errors.push('有本轮候选的身份尚未确认，暂不展示其资源。');continue;
    }
    if(seen.has(task.taskId))return {...result,pending:[],error:'本轮修改出现重复任务身份，已停用显示。'};
    seen.add(task.taskId);
    const disabledReason=!snapshot?'已保存资源尚未读取，请刷新后查看。':
      !savedRevision||!hashPattern.test(task.projectRevision||'')?'工程保存版本尚未核对，请刷新后查看。':
      task.projectRevision!==savedRevision?'工程保存版本已变化，此候选对应旧版本。':'';
    const taskLabel=typeof task.request==='string'&&task.request.trim()?task.request.trim():'修改 '+task.taskId.slice(-8);
    for(const group of candidateOperationGroups(task)){
      const tool=toolNames[group.tool];if(!tool)continue;
      const kind=rowKind(group,savedByTool.get(tool));
      result.pending.push({key:task.taskId+':'+tool,task,taskLabel,tool,name:group.name,role:roles[tool],kind,label:kindLabels[kind],disabledReason:disabledReason||(kind==='removed'?'该资源在此候选中已移除，可在对话中查看改动。':'')});
    }
  }
  return errors.length?{...result,error:[...new Set(errors)].join(' ')}:result;
}
