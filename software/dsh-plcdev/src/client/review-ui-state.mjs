import {reviewActionRequest} from './conversation-client.mjs';

export function revisionDisabledReason(state,task) {
  if(state.busy)return '正在处理会话操作，请稍候。';
  if(!state.binding)return '会话工程尚未确认，请重新读取。';
  if(state.storageError)return '浏览器恢复信息不可用，请先核对。';
  if(state.pending||state.binding.pendingRequests?.length)return '有已投递或结果未知的请求，请先核对原请求。';
  if(state.binding.revisionContext&&state.binding.revisionContext.state!=='submitted')return '本会话已有修订上下文，请先完成或取消。';
  if(state.binding.submissionConflicts?.length)return '原请求返回不同任务身份，请先人工核对，不能设置新修订。';
  if(state.binding.submissionInFlight?.some(f=>f.state==='evidence_conflict'))return '已记录任务与回执证据不一致，请人工核对，不能设置新修订。';
  if(state.binding.submissionInFlight?.length)return '原请求仍在途或发送者状态无法确认，不能设置新修订。';
  if(task?.status!=='awaiting_review')return '当前候选不能继续修改。';
  return '';
}

// Keep the explanation next to its disabled action, including when the
// conflicting version is above the fold in a narrow review sidebar.
export function reviewDisabledReason({sessionId,task,target,action,busy,pendingAction,revision,retainedProjectId}) {
  if(busy)return '操作正在处理。';
  if(pendingAction)return '上次审阅操作结果待核对。';
  if(task?.status==='unknown_outcome')return '上次操作结果未知，请先核对原请求，不要重复提交。';
  if(task?.status==='keeping')return '正在保留修改，请等待结果。';
  if(action==='keep'&&revision?.same!==true)return revision?.same===false
    ?'保存版本已变化，不能保留或继续修改。':'保存版本尚未确认，暂不能保留。';
  if(task?.supersededBy&&action!=='compile')return '此候选已被新候选替代。';
  if(action==='compile'&&!retainedProjectId)return ['kept','compiled','compile_failed'].includes(task?.status)
    ?'保留工程身份或版本尚未确认，暂不能编译。':'先保留修改，才能编译保留版本。';
  if(!reviewActionRequest(sessionId,task,target,action,'availability-check'))return '当前任务状态不允许此操作。';
  return '';
}
