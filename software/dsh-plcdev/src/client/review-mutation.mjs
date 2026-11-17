import {readReviewPending,reviewPendingKey} from './conversation-client.mjs';

/** A card and an open review share the same persisted request and in-page lock. */
export const reviewMutationLocks=new Set();
export const REVIEW_CHANGED='plcdev:review-changed';
export function notifyReviewChange(key){
  window.dispatchEvent(new window.CustomEvent(REVIEW_CHANGED,{detail:{key}}));
}

function sameReviewTask(task,request){
  return !!task&&!!request&&task.projectId===request.projectId&&task.taskId===request.taskId&&
    task.candidate?.candidateDigest===request.candidateDigest&&
    (request.action==='compile'?task.retention?.revision:task.projectRevision)===request.expectedRevision;
}

const requestFields=['projectId','taskId','candidateDigest','expectedRevision','action','clientRequestId'];
const sameRequest=(actual,expected)=>!!actual&&!!expected&&requestFields.every(field=>actual[field]===expected[field]);

// A late response must never remove a replacement request under the same key.
export function clearReviewPending(storage,conversationId,target,request){
  const stored=readReviewPending(storage,conversationId,target);
  if(!sameRequest(stored,request)||stored.conversationId!==request.conversationId)return false;
  storage.removeItem(reviewPendingKey(conversationId,target));return true;
}

// HTTP acceptance does not prove that the keep/undo/compile actually finished.
export function reviewResultConfirmed(task,request){
  if(!sameReviewTask(task,request))return false;
  if(request.action==='keep')return ['kept','compiled','compile_failed'].includes(task.status)&&
    typeof task.retention?.keptProjectId==='string'&&/^[0-9a-f]{64}$/.test(task.retention?.revision||'');
  if(request.action==='undo')return task.status==='discarded';
  return request.action==='compile'&&['compiled','compile_failed'].includes(task.status);
}

export function reviewRejection(task,request){
  const rejection=task?.reviewRejection;
  return sameReviewTask(task,request)&&request.action==='keep'&&task.status==='awaiting_review'&&
    rejection?.effectId===request.clientRequestId&&rejection.published===false&&
    ['not_ready','busy'].includes(rejection.code)&&typeof rejection.reason==='string'&&rejection.reason.trim()
    ?rejection:null;
}

// Read the current stored request, so an old response cannot clear a newer retry.
export function clearRejectedReview(storage,conversationId,target,task){
  const request=readReviewPending(storage,conversationId,target),rejected=reviewRejection(task,request);
  if(!rejected)return null;
  storage.removeItem(reviewPendingKey(conversationId,target));
  return rejected;
}

// Status polls are not responses to the mutation. Require the exact confirmed
// ledger identity as well as the terminal task state before releasing a lock.
export function settleReviewPending(storage,conversationId,target,task){
  const request=readReviewPending(storage,conversationId,target);
  if(!request)return null;
  const rejected=reviewRejection(task,request);
  const confirmed=reviewResultConfirmed(task,request)&&Array.isArray(task.reviewCompletions)&&
    task.reviewCompletions.some(completion=>sameRequest(completion,request));
  if(!confirmed&&!rejected)return null;
  if(!clearReviewPending(storage,conversationId,target,request))return null;
  return {request,confirmed,rejected};
}
