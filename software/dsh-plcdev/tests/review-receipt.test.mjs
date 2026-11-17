import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {validKeepReceipt} from '../src/review-receipt.mjs';
import {validateReviewReceipt} from '../src/client/conversation-client.mjs';
const request={projectId:'user-'+'a'.repeat(32),taskId:'task-'+'b'.repeat(32),candidateDigest:'c'.repeat(64),expectedRevision:'d'.repeat(64),action:'keep',clientRequestId:'save-1'};
const {expectedRevision,action,...identity}=request;
const base={ok:true,...identity,state:'confirmed_registered',reasonCode:'none',keptProjectId:request.projectId,manifestPath:path.resolve('test/project.plcdev'),revision:'e'.repeat(64)};
test('same-project receipt requires explicit confirmed scope and saved version, legacy remains distinct',()=>{
  const saved={...base,completionScope:'saved-project-version',version:2};
  assert.equal(validKeepReceipt(saved,request),true);assert.equal(validateReviewReceipt(saved,request),saved);
  for(const invalid of [base,{...saved,version:1},{...saved,version:'2'},{...saved,keptProjectId:'user-'+'f'.repeat(32)},{...saved,completionScope:'retained-new-project'}]){
    assert.equal(validKeepReceipt(invalid,request),false);assert.throws(()=>validateReviewReceipt(invalid,request));
  }
  const legacy={...base,keptProjectId:'user-'+'f'.repeat(32)};
  assert.equal(validKeepReceipt(legacy,request),true);assert.equal(validateReviewReceipt(legacy,request),legacy);
});
test('unknown receipt never upgrades same-project publication or exposes unconfirmed paths',()=>{
  const unknown={...base,state:'unknown',reasonCode:'copy_changed',keptProjectId:null,manifestPath:null,revision:null};
  assert.equal(validKeepReceipt(unknown,request),true);
  for(const value of [{...unknown,completionScope:'saved-project-version',version:2},{...unknown,manifestPath:base.manifestPath}]){
    assert.equal(validKeepReceipt(value,request),false);assert.throws(()=>validateReviewReceipt(value,request));
  }
});
