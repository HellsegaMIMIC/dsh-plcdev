import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRejection,reviewResultConfirmed,clearRejectedReview,clearReviewPending,settleReviewPending} from '../src/client/review-mutation.mjs';
import {reviewPendingKey} from '../src/client/conversation-client.mjs';

const target={projectId:'user-'+'a'.repeat(32),taskId:'task-'+'b'.repeat(32)};
const request={conversationId:'chat-a',...target,candidateDigest:'c'.repeat(64),expectedRevision:'d'.repeat(64),action:'keep',clientRequestId:'attempt-1'};
const refusal={...target,status:'awaiting_review',projectRevision:request.expectedRevision,candidate:{candidateDigest:request.candidateDigest},reviewRejection:{effectId:'attempt-1',code:'busy',reason:'工程正在使用，请稍后重试。',published:false}};

test('only the exact unpublished rejection releases a pending keep',()=>{
  const key=reviewPendingKey('chat-a',target),values=new Map([[key,JSON.stringify(request)]]);
  const storage={getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key)};
  for(const changed of [
    {...refusal,status:'unknown_outcome'},
    {...refusal,taskId:'task-'+'f'.repeat(32)},
    {...refusal,projectRevision:'e'.repeat(64)},
    {...refusal,candidate:{candidateDigest:'e'.repeat(64)}},
    {...refusal,reviewRejection:undefined},
    {...refusal,reviewRejection:{...refusal.reviewRejection,effectId:'attempt-0'}},
    {...refusal,reviewRejection:{...refusal.reviewRejection,published:true}},
    {...refusal,reviewRejection:{...refusal.reviewRejection,code:'unknown_outcome'}},
  ]){assert.equal(clearRejectedReview(storage,'chat-a',target,changed),null);assert.ok(values.has(key));}
  assert.equal(clearRejectedReview(storage,'chat-a',target,refusal).reason,refusal.reviewRejection.reason);
  assert.equal(values.has(key),false);
  values.set(key,JSON.stringify({...request,clientRequestId:'attempt-2'}));
  assert.equal(clearRejectedReview(storage,'chat-a',target,refusal),null,'late rejection cannot clear a newer retry');
  assert.ok(values.has(key));assert.equal(reviewRejection(refusal,{...request,action:'undo'}),null);
});

test('HTTP acceptance or an unrelated task cannot be treated as a successful keep',()=>{
  for(const status of ['awaiting_review','keeping','unknown_outcome','failed','discarded'])assert.equal(reviewResultConfirmed({...refusal,status},request),false);
  const kept={...refusal,status:'kept',retention:{keptProjectId:target.projectId,revision:'e'.repeat(64)}};
  assert.equal(reviewResultConfirmed(kept,request),true);
  assert.equal(reviewResultConfirmed({...kept,taskId:'task-'+'f'.repeat(32)},request),false);
  assert.equal(reviewResultConfirmed({...kept,retention:undefined},request),false);
});

test('polled confirmation requires every ledger identity field and current terminal state',()=>{
  const key=reviewPendingKey('chat-a',target),values=new Map([[key,JSON.stringify(request)]]);
  const storage={getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key)};
  const {conversationId,...completion}=request;
  const kept={...refusal,reviewRejection:undefined,status:'kept',retention:{keptProjectId:target.projectId,revision:'e'.repeat(64)},reviewCompletions:[completion]};
  for(const field of Object.keys(completion)){
    assert.equal(settleReviewPending(storage,'chat-a',target,{...kept,reviewCompletions:[{...completion,[field]:'different'}]}),null);
    assert.ok(values.has(key),field+' mismatch must retain the request');
  }
  for(const status of ['keeping','unknown_outcome','awaiting_review','discarded'])assert.equal(settleReviewPending(storage,'chat-a',target,{...kept,status}),null);
  assert.equal(settleReviewPending(storage,'chat-a',target,{...kept,reviewCompletions:undefined}),null);
  assert.equal(settleReviewPending(storage,'chat-a',target,kept).confirmed,true);assert.equal(values.has(key),false);
  assert.equal(settleReviewPending(storage,'chat-a',target,kept),null,'a second mounted view cannot settle/open twice');
});

test('late synchronous results cannot erase a replacement request or a different session',()=>{
  const key=reviewPendingKey('chat-a',target),replacement={...request,clientRequestId:'new-attempt'};
  const values=new Map([[key,JSON.stringify(replacement)]]),storage={getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key)};
  assert.equal(clearReviewPending(storage,'chat-a',target,request),false);
  assert.equal(clearReviewPending(storage,'chat-a',target,{...replacement,conversationId:'chat-b'}),false);
  assert.deepEqual(JSON.parse(values.get(key)),replacement);
  assert.equal(clearReviewPending(storage,'chat-a',target,replacement),true);
});
