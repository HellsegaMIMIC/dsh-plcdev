// Offline API behavior with a real temporary SQLite context store and an in-memory
// fake bridge. These tests do not exercise the live TaskService, DSH UI or Runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationRoutes } from '../src/conversations.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { hostSessionCatalog } from '../src/index.mjs';

const A = 'user-' + 'a'.repeat(32), B = 'user-' + 'b'.repeat(32);
const REVISION = 'e'.repeat(64);
const GET = '/api/plcdev/conversations';
const BIND = '/api/plcdev/conversations/bind';
const SUBMIT = '/api/plcdev/conversations/tasks';
const binding = (conversationId = 'conversation-a', projectId = A, expectedVersion = 0) => ({ conversationId, projectId, expectedVersion });
const submission = (overrides = {}) => ({
  conversationId: 'conversation-a', projectId: A, expectedVersion: 1,
  request: '将 Count 改为 BatchCount', expectedRevision: REVISION,
  executionScope: 'proposal', sourceBasis: 'saved_revision', clientRequestId: 'request-01', ...overrides,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('host list projection retains user forks and excludes hidden and subagent sessions from main counts', () => {
  const rows=hostSessionCatalog([
    {live:true,header:{id:'root'}},
    {live:false,header:{id:'fork',cwd:'C:/work',parentSession:'root',isSeeded:true}},
    {live:false,header:{id:'child',cwd:'C:/work',origin:'subagent',parentSession:'root'}},
    {live:false,header:{id:'hidden'}}
  ]);
  assert.deepEqual(rows,[{id:'root',kind:'main'},{id:'fork',kind:'main'},{id:'child',kind:'child'}]);
  assert.throws(()=>hostSessionCatalog([{live:true,header:{id:'other',origin:'future-kind'}}]),/origin unknown/);
});

async function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'plcdev-dsh-conversations-'));
  const calls = [], tasks = new Map(), ledger = new Map();
  const state = { projects: new Set([A, B]), statusOverride: null, afterCreate: null, beforeStatus: null,
    catalog: [{id:'conversation-a',kind:'main'}, {id:'conversation-b',kind:'main'}] };
  let sequence = 0;
  const bridge = {
    async reviewReceipt(body) {
      calls.push({method:'POST',url:'/internal/review-receipt',body:structuredClone(body)});
      if(state.reviewReceiptError)throw new Error('offline');
      return {ok:true,projectId:body.projectId,taskId:body.taskId,candidateDigest:body.candidateDigest,clientRequestId:body.clientRequestId,state:'unknown',reasonCode:'receipt_unconfirmed',keptProjectId:null,manifestPath:null,revision:null};
    },
    async taskReceipt(projectId, requestId) {
      if(state.receiptError)throw new Error('offline');
      if(state.beforeReceipt)await state.beforeReceipt(projectId,requestId);
      const entry=ledger.get(requestId),task=entry?tasks.get(entry.taskId):null;
      return {ok:true,projectId,clientRequestId:requestId,task:state.receiptOverride??(task?.projectId===projectId?structuredClone(task):null)};
    },
    async handle(method, url, body) {
      calls.push({ method, url, body: body == null ? undefined : structuredClone(body) });
      const parsed = new URL(url, 'http://127.0.0.1');
      if (method === 'GET' && parsed.pathname === '/api/plcdev/status') {
        const project = parsed.searchParams.get('project');
        if (state.beforeStatus) await state.beforeStatus(project);
        if (state.statusOverride) return structuredClone(state.statusOverride);
        if (!state.projects.has(project)) return { status: 404, body: { code: 'project_not_found', error: 'Unknown fixture project' } };
        return { status: 200, body: { project: { id: project }, projects: [...state.projects].map(id => ({ id })) } };
      }
      if (method === 'POST' && parsed.pathname === '/api/plcdev/tasks') {
        if(state.beforeCreate){const early=await state.beforeCreate(body);if(early)return early;}
        // Model the existing upstream idempotency contract, not a production service.
        const fingerprint = JSON.stringify(body);
        const prior = ledger.get(body.clientRequestId);
        if (prior && prior.fingerprint !== fingerprint) return { status: 409, body: { code: 'duplicate_conflict' } };
        let task = prior && tasks.get(prior.taskId);
        if (!prior) {
          task = { projectId: body.projectId, taskId: 'task-' + (++sequence).toString(16).padStart(32, '0'), status: 'awaiting_review' };
          tasks.set(task.taskId, task);
          ledger.set(body.clientRequestId, { taskId: task.taskId, fingerprint });
        }
        const result = { status: prior ? 200 : 202, body: { ok: true, task: structuredClone(task), duplicate: !!prior } };
        return state.afterCreate ? await state.afterCreate(result, body) : result;
      }
      if (method === 'GET' && parsed.pathname === '/api/plcdev/tasks') {
        const project = parsed.searchParams.get('project');
        return { status: 200, body: { projectId: project, ...(state.revision?{projectRevision:state.revision}:{}), tasks: [...tasks.values()].filter(task => task.projectId === project).map(task => structuredClone(task)) } };
      }
      if(method==='POST'&&parsed.pathname==='/api/plcdev/tasks/review')return {status:202,body:{ok:true,...body}};
      throw new Error('Unexpected fixture call: ' + method + ' ' + url);
    },
  };
  const open = () => createConversationRoutes({ controllerFile: path.join(root, 'controller.json'), bridge,
    visibleSessions: async () => { if (state.catalog instanceof Error) throw state.catalog; return state.catalog; } });
  const routes = open();
  const read = (conversationId = 'conversation-a', route = routes) => route.handle('GET', GET + '?conversationId=' + encodeURIComponent(conversationId));
  const posts = () => calls.filter(call => call.method === 'POST');
  t.after(async () => {
    // Every behavior test also proves the route never attempts tool or Runtime actions.
    try {
      assert.ok(calls.every(call => {
        const pathname = new URL(call.url, 'http://127.0.0.1').pathname;
        return call.method === 'POST' ? ['/api/plcdev/tasks','/api/plcdev/tasks/review','/internal/review-receipt'].includes(pathname) : ['/api/plcdev/status', '/api/plcdev/tasks'].includes(pathname);
      }), 'Conversation routes must never call /action or a Runtime endpoint');
    } finally {
      const target = path.resolve(root);
      assert.ok(target.startsWith(temporaryRoot + path.sep) && path.basename(target).startsWith('plcdev-dsh-conversations-'), 'Cleanup is restricted to this test temporary directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  return { root, routes, read, open, state, tasks, ledger, calls, posts };
}

test('keep receipt requires the original conversation task and survives later rebinding without replay',async t=>{
 const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
 const task=ok(await f.routes.handle('POST',SUBMIT,submission()),202).task;
 const request={conversationId:'conversation-a',projectId:A,taskId:task.taskId,candidateDigest:REVISION,expectedRevision:REVISION,action:'keep',clientRequestId:'review-1'};
 error(await f.routes.handle('POST',GET+'/review-receipt',{...request,conversationId:'conversation-b'}),403,'task_not_in_conversation');
 error(await f.routes.handle('POST',GET+'/review-receipt',{...request,projectId:B}),403,'task_not_in_conversation');
 error(await f.routes.handle('POST',GET+'/review-receipt',{...request,action:'undo'}),400,'invalid_request');
 assert.equal(f.calls.filter(c=>c.url==='/internal/review-receipt').length,0);
 ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
 const receipt=ok(await f.routes.handle('POST',GET+'/review-receipt',request));
 assert.equal(receipt.state,'unknown');assert.equal(receipt.keptProjectId,null);
 assert.equal(f.calls.filter(c=>c.url==='/internal/review-receipt').length,1);
 assert.equal(f.calls.filter(c=>c.url==='/api/plcdev/tasks/review').length,0);
 f.state.reviewReceiptError=true;
 error(await f.routes.handle('POST',GET+'/review-receipt',request),503,'receipt_unavailable');
 assert.equal(f.routes.snapshot('conversation-a').projectId,B);
});

test('read-only receipt reconciliation is session-scoped and never dispatches an unknown request',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  f.state.afterCreate=()=>({status:503,body:{code:'unknown'}});
  assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,503);
  const posts=f.posts().length, request={conversationId:'conversation-a',clientRequestId:'request-01'};
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
  error(await f.routes.handle('POST',GET+'/receipt',{...request,conversationId:'conversation-b'}),404,'not_found');
  f.state.receiptOverride={projectId:B,taskId:'task-'+'f'.repeat(32)};
  error(await f.routes.handle('POST',GET+'/receipt',request),503,'receipt_mismatch');
  f.state.receiptOverride=null;f.state.receiptError=true;
  error(await f.routes.handle('POST',GET+'/receipt',request),503,'receipt_unavailable');
  f.state.receiptError=false;
  const result=ok(await f.routes.handle('POST',GET+'/receipt',request));
  assert.equal(result.found,true);assert.equal(result.projectId,A);
  assert.equal(f.routes.snapshot('conversation-a').taskRefs[0].taskId,result.taskId);
  assert.equal(f.posts().length,posts);assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,0);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
});

test('an upstream 408 keeps the original request unknown and blocks rebinding until reconciled',async t=>{
 const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
 f.state.afterCreate=()=>({status:408,body:{code:'timeout'}});
 assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,408);
 assert.equal(f.routes.snapshot('conversation-a').pendingRequests[0].clientRequestId,'request-01');
 error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
 const before=f.posts().length,receipt=ok(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'}));
 assert.equal(receipt.found,true);assert.equal(f.posts().length,before);assert.equal(f.tasks.size,1);
});

test('an unexpected upstream redirect remains unknown rather than proving rejection',async t=>{
 const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
 f.state.afterCreate=()=>({status:302,body:{code:'unexpected_redirect'}});
 assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,302);
 assert.equal(f.routes.snapshot('conversation-a').pendingRequests[0].clientRequestId,'request-01');
 error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
 assert.equal(ok(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'})).found,true);
 assert.equal(f.tasks.size,1);
});

for(const malformed of [undefined,null,{}, {status:200}, {status:700,body:{}}, {status:200,body:null}])test(`malformed bridge reply ${String(malformed?.status??malformed)} settles its sender but preserves unknown`,async t=>{
 const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
 f.state.afterCreate=()=>malformed;
 error(await f.routes.handle('POST',SUBMIT,submission()),503,'submission_unknown');
 const snapshot=f.routes.snapshot('conversation-a');assert.equal(snapshot.pendingRequests.length,1);assert.deepEqual(snapshot.submissionInFlight,[]);
 error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
 assert.equal(ok(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'})).found,true);
});

test('no matching receipt remains unknown and continues to block rebinding',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  f.state.afterCreate=()=>({status:503,body:{code:'unknown'}});
  assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,503);
  f.ledger.clear();const before=f.posts().length;
  assert.equal(ok(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'})).found,false);
  assert.equal(f.posts().length,before);assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,1);
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
});

test('revision intent survives reopen, claims one turn and preserves parent identity on unknown replay',async t=>{
 const f=await fixture(t);await f.routes.handle('POST',BIND,binding());const first=await f.routes.handle('POST',SUBMIT,submission());
 const task=f.tasks.get(first.body.task.taskId);Object.assign(task,{workflow:'joint-ai-v1',request:'标题为 5',projectRevision:REVISION,candidate:{revisionSupported:true,candidateDigest:'d'.repeat(64),summary:{after:'标题 5'}}});
 // The fixture exposes task values; its list includes no revision until augmented below.
 const root=await mkdtemp(path.join(os.tmpdir(),'plcdev-revision-'));
 const bridge={async handle(method,url,body){if(method==='GET'&&url.includes('/tasks?'))return {status:200,body:{projectId:A,projectRevision:REVISION,tasks:[task]}};if(method==='GET')return {status:200,body:{project:{id:A},projects:[{id:A}]}};return {status:503,body:{code:'unknown'}};}};
 const routes=createConversationRoutes({controllerFile:path.join(root,'controller.json'),bridge});
 t.after(async()=>{assert.ok(path.basename(root).startsWith('plcdev-revision-'));await rm(root,{recursive:true,force:true});});
 await routes.handle('POST',BIND,binding());
 // Reference using the public submission path, then switch upstream to the existing candidate.
 bridge.handle=async(method,url,body)=>method==='POST'?{status:202,body:{ok:true,task}}:url.includes('/tasks?')?{status:200,body:{projectId:A,projectRevision:REVISION,tasks:[task]}}:{status:200,body:{project:{id:A},projects:[{id:A}]}};
 await routes.handle('POST',SUBMIT,submission());
 const arm={conversationId:'conversation-a',projectId:A,taskId:task.taskId,candidateDigest:'d'.repeat(64),expectedRevision:REVISION,expectedVersion:1,intentId:'revision-1'};
 assert.equal((await routes.handle('POST',GET+'/revision',arm)).status,200);
 const reopened=createConversationRoutes({controllerFile:path.join(root,'controller.json'),bridge});assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'armed');
 assert.equal(reopened.claimRevision('conversation-a','turn-1').parent.taskId,task.taskId);assert.throws(()=>reopened.claimRevision('conversation-a','turn-2'),/待核对/);
 assert.equal(reopened.releaseRevision('conversation-a','old-turn'),false);
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'claimed');
 assert.equal(reopened.releaseRevision('conversation-a','turn-1'),true);
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'armed');
 assert.equal(reopened.claimRevision('conversation-a','turn-2').parent.taskId,task.taskId);
 const payload=submission({clientRequestId:'revision-submit',workflow:'joint-ai-v1',request:'标题改成 6',revisionParent:{taskId:task.taskId,candidateDigest:'d'.repeat(64)},revisionIntentId:'revision-1'});
 let sent,enteredResolve,release;const entered=new Promise(resolve=>enteredResolve=resolve);
 bridge.handle=async(_m,_u,b)=>{sent=b;enteredResolve();await new Promise(resolve=>release=resolve);return {status:503,body:{code:'unknown'}};};
 const flight=reopened.handle('POST',SUBMIT,payload);await entered;
 assert.equal((await reopened.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'revision-1'})).body.code,'revision_pending');
 release();assert.equal((await flight).status,503);assert.equal(sent.revisionParent.taskId,task.taskId);assert.equal(sent.revisionIntentId,undefined);
 bridge.handle=async()=>({status:503,body:{code:'unknown'}});
 const pending=reopened.snapshot('conversation-a').pendingRequests[0];assert.equal(pending.revisionIntentId,'revision-1');
 assert.equal(reopened.releaseRevision('conversation-a','turn-2'),false);
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'submitting');
 assert.throws(()=>reopened.claimRevision('conversation-a','turn-3'),/投递结果待核对/);
 assert.equal((await reopened.handle('POST',SUBMIT,{...payload,clientRequestId:'duplicate-turn'})).status,409);
 assert.equal((await reopened.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'revision-1'})).body.code,'revision_pending');
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'submitting');
 assert.equal((await reopened.handle('POST',SUBMIT,payload)).status,503); // Existing exact outbox may still be reconciled.
 const child={projectId:A,taskId:'task-'+'9'.repeat(32)};
 bridge.handle=async(method,url)=>method==='POST'?{status:202,body:{ok:true,task:child}}:{status:200,body:{projectId:A,projectRevision:REVISION,tasks:[task]}};
 assert.equal((await reopened.handle('POST',SUBMIT,payload)).status,202);
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'submitted');
 assert.equal((await reopened.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'revision-1'})).status,200);
 // A definitively rejected submission does not permanently trap the context.
 assert.equal((await reopened.handle('POST',GET+'/revision',{...arm,intentId:'revision-2'})).status,200);
 reopened.claimRevision('conversation-a','turn-4');
 bridge.handle=async()=>({status:409,body:{code:'conflict'}});
 assert.equal((await reopened.handle('POST',SUBMIT,{...payload,clientRequestId:'rejected-revision',revisionIntentId:'revision-2'})).status,409);
 assert.equal((await reopened.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'revision-2'})).status,200);
});

test('HMI revisions are pinned to an owned parent and cannot switch workflows',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'plcdev-hmi-revision-'));
 t.after(async()=>{assert.ok(path.basename(root).startsWith('plcdev-hmi-revision-'));await rm(root,{recursive:true,force:true});});
 const task={taskId:'task-'+'b'.repeat(32),projectId:A,projectRevision:REVISION,workflow:'hmi-static-text-v1',status:'awaiting_review',request:'把静态文字“源”改为“第一版”',candidate:{candidateDigest:'d'.repeat(64),revisionSupported:true,target:{viewId:'v-a',elementId:'PLCD_tTitle'},summary:{before:'源',after:'第一版'}}};
 let writes=0;const child={taskId:'task-'+'c'.repeat(32),projectId:A};
 const bridge={async taskReceipt(projectId,clientRequestId){return {ok:true,projectId,clientRequestId,task:child};},async handle(method,url,body){if(method==='GET')return url.includes('/tasks?')?{status:200,body:{projectId:A,projectRevision:REVISION,tasks:[task]}}:{status:200,body:{project:{id:new URL(url,'http://127.0.0.1').searchParams.get('project')},projects:[{id:A},{id:B}]}};writes++;return writes===1?{status:202,body:{ok:true,task}}:{status:503,body:{code:'unknown'}};}};
 const routes=createConversationRoutes({controllerFile:path.join(root,'controller.json'),bridge});
 await routes.handle('POST',BIND,binding());await routes.handle('POST',SUBMIT,submission());
 const arm={conversationId:'conversation-a',projectId:A,taskId:task.taskId,candidateDigest:'d'.repeat(64),expectedRevision:REVISION,expectedVersion:1,intentId:'r1'};
 assert.equal((await routes.handle('POST',GET+'/revision',arm)).status,200);
 const intent=routes.claimRevision('conversation-a','turn-1');assert.equal(intent.workflow,'hmi-static-text-v1');assert.deepEqual(intent.target,task.candidate.target);
 const parent={taskId:task.taskId,candidateDigest:task.candidate.candidateDigest};
 const wrong=submission({clientRequestId:'wrong-workflow',workflow:'joint-ai-v1',revisionParent:parent,revisionIntentId:'r1'});
 assert.equal((await routes.handle('POST',SUBMIT,wrong)).status,409);assert.equal(writes,1);
 const valid=submission({clientRequestId:'hmi-revision',workflow:'hmi-static-text-v1',request:'把静态文字“第一版”改为“第二版”',revisionParent:parent,revisionIntentId:'r1',planSubmission:{schemaVersion:1,plan:{viewId:'v-a',elementId:'PLCD_tTitle',text:'第二版'},route:{provider:'offline',model:'fixture'}}});
 assert.equal((await routes.handle('POST',SUBMIT,valid)).status,503);assert.equal(writes,2);assert.equal(routes.snapshot('conversation-a').revisionContext.state,'submitting');
 assert.equal((await routes.handle('POST',BIND,binding('conversation-a',B,1))).body.code,'submission_unknown');
 const receipt=await routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'hmi-revision'});
 assert.equal(receipt.body.found,true);assert.equal(receipt.body.taskId,child.taskId);assert.equal(writes,2,'read-only receipt must not replay');assert.equal(routes.snapshot('conversation-a').revisionContext.state,'submitted');
 task.candidate.target=undefined;const retry={...arm,intentId:'r2'};
 assert.equal((await routes.handle('POST',GET+'/revision',retry)).status,409);
});

for(const delayed of ['sender','receipt'])test(`a submitted revision cannot be cancelled while its ${delayed} remains in flight`,async t=>{
 const temporaryRoot=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(temporaryRoot,'plcdev-revision-pending-'));
 t.after(async()=>{const target=path.resolve(root);assert.ok(target.startsWith(temporaryRoot+path.sep)&&path.basename(target).startsWith('plcdev-revision-pending-'));await rm(target,{recursive:true,force:true});});
 const parent={taskId:'task-'+'b'.repeat(32),projectId:A,projectRevision:REVISION,workflow:'hmi-view-name-v1',status:'awaiting_review',request:'把画面名称“源”改为“第一版”',candidate:{candidateDigest:'d'.repeat(64),revisionSupported:true,target:{viewId:'v-a'},summary:{before:'源',after:'第一版'}}};
 const child={taskId:'task-'+'c'.repeat(32),projectId:A},sendEntered=deferred(),finishSend=deferred(),readEntered=deferred(),finishRead=deferred();let writes=0;
 const bridge={async handle(method,url){
  if(method==='GET')return url.includes('/tasks?')?{status:200,body:{projectId:A,projectRevision:REVISION,tasks:[parent,child]}}:{status:200,body:{project:{id:A},projects:[{id:A}]}};
  if(++writes===1)return {status:202,body:{ok:true,task:parent}};
  sendEntered.resolve();await finishSend.promise;return {status:202,body:{ok:true,task:child}};
 },async taskReceipt(projectId,clientRequestId){readEntered.resolve();if(delayed==='receipt')await finishRead.promise;return {ok:true,projectId,clientRequestId,task:child};}};
 const routes=createConversationRoutes({controllerFile:path.join(root,'controller.json'),bridge});
 try{
  ok(await routes.handle('POST',BIND,binding()));ok(await routes.handle('POST',SUBMIT,submission()),202);
  const arm={conversationId:'conversation-a',projectId:A,taskId:parent.taskId,candidateDigest:'d'.repeat(64),expectedRevision:REVISION,expectedVersion:1,intentId:'hmi-intent'};
  ok(await routes.handle('POST',GET+'/revision',arm));routes.claimRevision('conversation-a','turn-1');
  const request=submission({clientRequestId:'revision-live',workflow:'hmi-view-name-v1',request:'把画面名称“第一版”改为“第二版”',revisionParent:{taskId:parent.taskId,candidateDigest:'d'.repeat(64)},revisionIntentId:'hmi-intent',planSubmission:{schemaVersion:1,plan:{viewId:'v-a',name:'第二版'},route:{provider:'offline',model:'fixture'}}});
  const delivery=routes.handle('POST',SUBMIT,request);await sendEntered.promise;
  const read=routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'revision-live'});await readEntered.promise;
  if(delayed==='sender'){
    assert.equal(ok(await read).found,true);assert.equal(routes.snapshot('conversation-a').revisionContext.state,'submitted');
  }else{
    finishSend.resolve();assert.equal((await delivery).status,202);assert.equal(routes.snapshot('conversation-a').revisionContext.state,'submitted');
  }
  error(await routes.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'hmi-intent'}),409,'revision_pending');
  assert.equal(routes.snapshot('conversation-a').revisionContext.intentId,'hmi-intent');
  assert.equal((await routes.handle('POST',GET+'/revision',arm)).status,200,'same intent remains an idempotent read');
  error(await routes.handle('POST',GET+'/revision',{...arm,intentId:'next-intent'}),409,'revision_pending');
  assert.equal(routes.snapshot('conversation-a').revisionContext.intentId,'hmi-intent');
  if(delayed==='sender'){finishSend.resolve();assert.equal((await delivery).status,202);}else{finishRead.resolve();assert.equal(ok(await read).found,true);}
  // Earlier plugin versions may have pending rows without a sender marker;
  // completed sends may also remain unknown. Neither may be silently ignored.
  const db=new DatabaseSync(path.join(root,'dsh-context.sqlite'));
  try{for(const state of ['pending','unknown']){
    db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)').run('conversation-a','legacy-'+state,'f'.repeat(64),A,1,'upstream-'+state,JSON.stringify({projectId:A,clientRequestId:'legacy-'+state}),state,null,'fixture');
    error(await routes.handle('POST',GET+'/revision',{...arm,intentId:'next-intent'}),409,'revision_pending');
    error(await routes.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'hmi-intent'}),409,'revision_pending');
    db.prepare('DELETE FROM submissions WHERE conversation_id=? AND request_id=?').run('conversation-a','legacy-'+state);
  }}finally{db.close();}
  assert.equal((await routes.handle('POST',GET+'/revision',{...arm,intentId:'next-intent'})).status,200);
  assert.equal((await routes.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'next-intent'})).status,200);
  // The same guard also applies when there is no previous revision context.
  const markers=new DatabaseSync(path.join(root,'dsh-context.sqlite'));
  try{
    const checks=[
      ['submission_inflight',()=>markers.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run('conversation-a','request-01','fixture-sender',process.pid)],
      ['submission_receipt_inflight',()=>markers.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)').run('conversation-a','request-01','fixture-reader',process.pid)],
      ['submission_receipt_evidence_conflicts',()=>markers.prepare('INSERT INTO submission_receipt_evidence_conflicts VALUES(?,?,?,?,?)').run('conversation-a','request-01',A,parent.taskId,'fixture')],
      ['submission_identity_conflicts',()=>markers.prepare('INSERT INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)').run('conversation-a','request-01',A,parent.taskId,'task-'+'f'.repeat(32),'fixture')],
      ...['pending','unknown'].map(state=>['submissions',()=>markers.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)').run('conversation-a','legacy-'+state,'f'.repeat(64),A,1,'upstream-'+state,JSON.stringify({projectId:A,clientRequestId:'legacy-'+state}),state,null,'fixture')]),
    ];
    for(const [table,setup] of checks){
      setup();error(await routes.handle('POST',GET+'/revision',{...arm,intentId:'fresh-intent'}),409,'revision_pending');
      assert.equal(routes.snapshot('conversation-a').revisionContext,undefined);
      if(table==='submissions')markers.prepare("DELETE FROM submissions WHERE conversation_id=? AND request_id LIKE 'legacy-%'").run('conversation-a');
      else markers.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run('conversation-a');
    }
  }finally{markers.close();}
  assert.equal((await routes.handle('POST',GET+'/revision',{...arm,intentId:'fresh-intent'})).status,200);
 }finally{finishSend.resolve();finishRead.resolve();}
});

function ok(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; }
function error(result, status, code) { assert.equal(result.status, status); assert.equal(result.body.code, code); }

test('review requires this conversation task reference, preserving original ownership after rebinding',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const submitted=ok(await f.routes.handle('POST',SUBMIT,submission({workflow:'joint-ai-v1'})),202);
  assert.equal(f.posts().at(-1).body.workflow,'joint-ai-v1');
  const body={conversationId:'conversation-a',projectId:A,taskId:submitted.task.taskId,candidateDigest:REVISION,expectedRevision:REVISION,action:'keep',clientRequestId:'explicit-review'};
  const before=f.posts().length;
  error(await f.routes.handle('POST','/api/plcdev/conversations/review',{...body,conversationId:'conversation-b'}),403,'task_not_in_conversation');
  error(await f.routes.handle('POST','/api/plcdev/conversations/review',{...body,projectId:B}),403,'task_not_in_conversation');
  assert.equal(f.posts().length,before);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
  ok(await f.open().handle('POST','/api/plcdev/conversations/review',body),202);
  assert.equal(f.posts().at(-1).body.projectId,A);
  assert.equal(Object.hasOwn(f.posts().at(-1).body,'conversationId'),false);
});

test('native generation references survive reopen and cannot migrate to another project or conversation',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const task={taskId:'task-'+'a'.repeat(32),projectId:A,workflow:'team-generation-v1'};
  f.routes.referenceTeam('conversation-a',task);
  assert.equal(f.open().snapshot('conversation-a').taskRefs[0].taskId,task.taskId);
  assert.throws(()=>f.routes.referenceTeam('conversation-a',{...task,projectId:B}),/归属/);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
  const body={conversationId:'conversation-a',projectId:A,taskId:task.taskId,candidateDigest:REVISION,expectedRevision:REVISION,action:'keep',clientRequestId:'generation-review'};
  ok(await f.open().handle('POST','/api/plcdev/conversations/review',body),202);
  error(await f.open().handle('POST','/api/plcdev/conversations/review',{...body,conversationId:'conversation-b'}),403,'task_not_in_conversation');
  assert.equal(f.posts().at(-1).body.projectId,A);
});

test('new context is unbound; invalid or ambiguous conversation reads never reach the bridge', async t => {
  const f = await fixture(t);
  assert.deepEqual(ok(await f.read()), { ok: true, conversationId: 'conversation-a', projectId: null, version: 0, participation:{enabled:false,locked:false}, submissionConflicts: [], submissionInFlight: [], taskRefs: [], pendingRequests: [] });
  error(await f.routes.handle('GET', GET + '?conversationId=a&conversationId=b'), 400, 'invalid_request');
  error(await f.routes.handle('GET', GET + '?conversationId=..%2Fother'), 400, 'invalid_conversation');
  error(await f.routes.handle('GET', GET + '?conversationId=a&projectId=' + A), 400, 'invalid_request');
  assert.equal(f.calls.length, 0);
});

test('binding uses compare-and-swap, keeps same-binding version stable and supports explicit unbinding', async t => {
  const f = await fixture(t);
  assert.equal(ok(await f.routes.handle('POST', BIND, binding())).version, 1);
  error(await f.routes.handle('POST', BIND, binding('conversation-a', B, 0)), 409, 'binding_changed');
  assert.equal(ok(await f.read()).projectId, A);
  assert.equal(ok(await f.routes.handle('POST', BIND, binding('conversation-a', A, 1))).version, 1);
  const unbound = ok(await f.routes.handle('POST', BIND, binding('conversation-a', null, 1)));
  assert.equal(unbound.projectId, null); assert.equal(unbound.version, 2);
  error(await f.routes.handle('POST', SUBMIT, submission()), 409, 'binding_changed');
  assert.equal(f.posts().length, 0);
});

test('unknown or identity-mismatched projects cannot replace a valid binding', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  error(await f.routes.handle('POST', BIND, binding('conversation-a', 'user-missing', 1)), 404, 'project_not_found');
  f.state.statusOverride = { status: 200, body: { project: { id: B }, projects: [{ id: A }, { id: B }] } };
  error(await f.routes.handle('POST', BIND, binding('conversation-a', A, 1)), 409, 'project_mismatch');
  assert.equal(ok(await f.read()).projectId, A); assert.equal(ok(await f.read()).version, 1);
});

test('same client request ID in two conversations creates separate upstream namespaces and task references', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  ok(await f.routes.handle('POST', BIND, binding('conversation-b')));
  const first = ok(await f.routes.handle('POST', SUBMIT, submission()), 202);
  const second = ok(await f.routes.handle('POST', SUBMIT, submission({ conversationId: 'conversation-b' })), 202);
  assert.notEqual(first.task.taskId, second.task.taskId);
  assert.notEqual(f.posts()[0].body.clientRequestId, f.posts()[1].body.clientRequestId);
  assert.ok(f.posts().every(call => call.body.clientRequestId !== 'request-01'));
  assert.deepEqual(ok(await f.read()).taskRefs.map(ref => ref.taskId), [first.task.taskId]);
  assert.deepEqual(ok(await f.read('conversation-b')).taskRefs.map(ref => ref.taskId), [second.task.taskId]);
});

test('binding switch preserves old task ownership; explicit old replay does not create a task in the new project', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  const first = ok(await f.routes.handle('POST', SUBMIT, submission()), 202);
  const changed = ok(await f.routes.handle('POST', BIND, binding('conversation-a', B, 1)));
  assert.equal(changed.projectId, B); assert.equal(changed.taskRefs[0].projectId, A);
  const second = ok(await f.routes.handle('POST', SUBMIT, submission({ projectId: B, expectedVersion: 2, clientRequestId: 'request-02' })), 202);
  const duplicate = ok(await f.routes.handle('POST', SUBMIT, submission()));
  assert.equal(duplicate.task.taskId, first.task.taskId); assert.equal(duplicate.duplicate, true);
  assert.equal(f.posts().length, 2);
  assert.deepEqual(ok(await f.read()).taskRefs.map(ref => [ref.projectId, ref.taskId]), [[A, first.task.taskId], [B, second.task.taskId]]);
});

test('project lookup distinguishes current and historical main sessions and deduplicates team references', async t => {
  const f = await fixture(t);
  f.state.catalog.push({id:'child-session',kind:'child'});
  ok(await f.routes.handle('POST', BIND, binding()));
  ok(await f.routes.handle('POST', BIND, binding('conversation-b')));
  const a = ok(await f.routes.handle('POST', SUBMIT, submission()), 202).task;
  const b = ok(await f.routes.handle('POST', SUBMIT, submission({conversationId:'conversation-b'})), 202).task;
  const team = {workflow:'team-generation-v1',projectId:A,taskId:'task-'+'c'.repeat(32)};
  f.routes.referenceTeam('conversation-a',team);
  f.routes.referenceTeam('conversation-a',team);
  f.routes.referenceTeam('child-session',team);
  ok(await f.routes.handle('POST', BIND, binding('conversation-a', B, 1)));
  const lookup = ok(await f.routes.handle('GET', GET+'/project?projectId='+A));
  assert.equal(lookup.countsComplete,true);
  assert.deepEqual(lookup.current.map(x=>x.conversationId),['conversation-b']);
  assert.deepEqual(lookup.current[0].taskIds,[b.taskId]);
  assert.deepEqual(lookup.historical.map(x=>x.conversationId),['conversation-a']);
  assert.equal(lookup.historical[0].currentProjectId,B);
  assert.deepEqual(lookup.historical[0].taskIds.sort(),[a.taskId,team.taskId].sort());
  assert.deepEqual(lookup.unavailable,[]);
  const other=ok(await f.routes.handle('GET',GET+'/project?projectId='+B));
  assert.deepEqual(other.current.map(x=>x.conversationId),['conversation-a']);
  assert.deepEqual(other.historical,[]);
});

test('project lookup fails closed on catalog failure and does not classify unavailable identities', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  f.state.catalog=[];
  const missing=ok(await f.routes.handle('GET',GET+'/project?projectId='+A));
  assert.deepEqual(missing.current,[]); assert.deepEqual(missing.unavailable,[{conversationId:'conversation-a'}]);
  assert.equal(missing.countsComplete,false);
  f.state.catalog=new Error('offline');
  error(await f.routes.handle('GET',GET+'/project?projectId='+A),503,'session_catalog_unavailable');
  f.state.catalog=[{id:'conversation-a',kind:'main'},{id:'conversation-a',kind:'child'}];
  error(await f.routes.handle('GET',GET+'/project?projectId='+A),503,'session_catalog_unavailable');
  error(await f.routes.handle('GET',GET+'/project?projectId='+A+'&projectId='+B),400,'invalid_request');
  error(await f.routes.handle('GET',GET+'/project?projectId=bad!'),400,'invalid_project');
});

test('an existing request ID rejects changed text, source revision, project or binding version', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  ok(await f.routes.handle('POST', SUBMIT, submission()), 202);
  for (const patch of [{ request: '改成另一个操作' }, { expectedRevision: 'f'.repeat(64) }, { projectId: B }, { expectedVersion: 2 }]) {
    error(await f.routes.handle('POST', SUBMIT, submission(patch)), 409, 'request_conflict');
  }
  assert.equal(f.tasks.size, 1); assert.equal(f.posts().length, 1);
});

test('fresh submissions with stale binding or another project never reach the upstream task service', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  error(await f.routes.handle('POST', SUBMIT, submission({ expectedVersion: 0 })), 409, 'binding_changed');
  error(await f.routes.handle('POST', SUBMIT, submission({ projectId: B })), 409, 'binding_changed');
  assert.equal(f.posts().length, 0); assert.deepEqual(ok(await f.read()).pendingRequests, []);
});

test('uncertain delivered submission survives reopening and retries the same upstream ID without duplicate logical work', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  f.state.afterCreate = () => { throw new Error('Simulated transport loss after upstream acceptance'); };
  error(await f.routes.handle('POST', SUBMIT, submission()), 503, 'submission_unknown');
  assert.equal(f.tasks.size, 1);
  const reopened = f.open();
  const pending = ok(await f.read('conversation-a', reopened));
  assert.equal(pending.pendingRequests.length, 1); assert.equal(pending.pendingRequests[0].state, 'unknown');
  assert.equal(pending.pendingRequests[0].clientRequestId, 'request-01');
  assert.equal(pending.pendingRequests[0].expectedRevision, REVISION);
  assert.equal(pending.pendingRequests[0].expectedVersion, 1);
  error(await reopened.handle('POST', BIND, binding('conversation-a', B, 1)),409,'submission_unknown');
  f.state.afterCreate = null;
  const recovered = ok(await reopened.handle('POST', SUBMIT, submission()));
  assert.equal(recovered.task.projectId, A); assert.equal(f.tasks.size, 1);
  assert.equal(f.posts()[0].body.clientRequestId, f.posts()[1].body.clientRequestId);
  ok(await reopened.handle('POST', BIND, binding('conversation-a', B, 1)));
  const final = ok(await f.read('conversation-a', f.open()));
  assert.equal(final.projectId, B); assert.equal(final.taskRefs[0].taskId, recovered.task.taskId);
  assert.equal(final.taskRefs[0].projectId, A); assert.deepEqual(final.pendingRequests, []);
});

test('a later refusal never erases an earlier unknown delivery or permits rebinding',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  f.state.afterCreate=()=>({status:503,body:{code:'unknown'}});
  assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,503);
  f.state.afterCreate=()=>({status:409,body:{code:'not_ready'}});
  error(await f.open().handle('POST',SUBMIT,submission()),503,'submission_unknown');
  assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,1);
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
  assert.equal(ok(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'})).found,true);
  assert.equal(f.tasks.size,1);
});

test('a parallel replay does not dispatch while the original delivery is pending',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const entered=deferred(),release=deferred();
  f.state.beforeCreate=async()=>{entered.resolve();await release.promise;return {status:409,body:{code:'not_ready'}};};
  const first=f.routes.handle('POST',SUBMIT,submission());await entered.promise;
  const second=await f.open().handle('POST',SUBMIT,submission());release.resolve();
  error(second,503,'submission_in_flight');assert.equal((await first).status,409);
  assert.equal(f.posts().length,1);assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,0);assert.equal(f.tasks.size,0);
});

test('a receipt found during delivery keeps binding blocked until the sender finishes',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const entered=deferred(),release=deferred();
  f.state.afterCreate=async()=>{entered.resolve();await release.promise;return {status:409,body:{code:'not_ready'}};};
  const first=f.routes.handle('POST',SUBMIT,submission());await entered.promise;
  const receipt=ok(await f.open().handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'}));
  assert.equal(receipt.found,true);assert.equal(f.routes.snapshot('conversation-a').taskRefs[0].taskId,receipt.taskId);
  assert.equal(f.routes.snapshot('conversation-a').submissionInFlight[0].state,'active_or_unknown');
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_in_flight');release.resolve();
  error(await first,503,'submission_unknown');
  const snapshot=f.routes.snapshot('conversation-a');assert.equal(snapshot.pendingRequests.length,0);assert.equal(snapshot.taskRefs[0].taskId,receipt.taskId);assert.deepEqual(snapshot.submissionInFlight,[]);
});

test('a slower receipt keeps binding locked after the sender reports a refusal',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const sent=deferred(),finishSend=deferred(),reading=deferred(),finishRead=deferred();
  f.state.afterCreate=async()=>{sent.resolve();await finishSend.promise;return {status:409,body:{code:'not_ready'}};};
  f.state.beforeReceipt=async()=>{reading.resolve();await finishRead.promise;};
  const delivery=f.routes.handle('POST',SUBMIT,submission());await sent.promise;
  const reconciliation=f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'});await reading.promise;
  assert.deepEqual(f.routes.snapshot('conversation-a').submissionInFlight,[{projectId:A,clientRequestId:'request-01',state:'active_or_unknown'}]);
  finishSend.resolve();error(await delivery,503,'submission_unknown');
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_in_flight');
  finishRead.resolve();const receipt=ok(await reconciliation);assert.equal(receipt.found,true);
  assert.equal(f.routes.snapshot('conversation-a').taskRefs[0].taskId,receipt.taskId);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
});

for(const outcome of ['unavailable','empty'])test(`a ${outcome} slower receipt never turns a prior uncertain delivery into rejection`,async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const sent=deferred(),finishSend=deferred(),reading=deferred(),finishRead=deferred();
  f.state.afterCreate=async()=>{sent.resolve();await finishSend.promise;return {status:409,body:{code:'not_ready'}};};
  f.state.beforeReceipt=async()=>{reading.resolve();await finishRead.promise;if(outcome==='unavailable')throw Error('offline');};
  const delivery=f.routes.handle('POST',SUBMIT,submission());await sent.promise;
  const reconciliation=f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'});await reading.promise;
  finishSend.resolve();error(await delivery,503,'submission_unknown');
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_in_flight');
  if(outcome==='empty')f.ledger.clear();finishRead.resolve();
  const result=await reconciliation;if(outcome==='empty')assert.equal(ok(result).found,false);else error(result,503,'receipt_unavailable');
  const snapshot=f.routes.snapshot('conversation-a');assert.equal(snapshot.pendingRequests.length,1);assert.deepEqual(snapshot.submissionInFlight,[]);
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_unknown');
});

test('an empty receipt read begun before an accepted response is not a false conflict',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const sent=deferred(),finishSend=deferred(),reading=deferred(),finishRead=deferred();
  f.state.afterCreate=async result=>{sent.resolve();await finishSend.promise;return result;};
  f.state.beforeReceipt=async()=>{reading.resolve();await finishRead.promise;};
  const delivery=f.routes.handle('POST',SUBMIT,submission());await sent.promise;
  const reconciliation=f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'});await reading.promise;
  finishSend.resolve();const accepted=ok(await delivery,202);error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_in_flight');
  f.ledger.clear();finishRead.resolve();const receipt=ok(await reconciliation);
  assert.equal(receipt.found,true);assert.equal(receipt.taskId,accepted.task.taskId);
  assert.deepEqual(f.routes.snapshot('conversation-a').submissionInFlight,[]);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
});

test('a later conflicting success never replaces the first accepted task identity',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const entered=deferred(),release=deferred();
  f.state.afterCreate=async result=>{entered.resolve();await release.promise;return result;};
  const first=f.routes.handle('POST',SUBMIT,submission());await entered.promise;
  f.state.receiptOverride={projectId:A,taskId:'task-'+'f'.repeat(32)};
  const receipt=ok(await f.open().handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'}));release.resolve();
  error(await first,503,'submission_identity_conflict');
  const reopened=f.open(),snapshot=ok(await f.read('conversation-a',reopened)),refs=snapshot.taskRefs;
  assert.equal(refs.length,1);assert.equal(refs[0].taskId,receipt.taskId);
  assert.deepEqual(snapshot.submissionConflicts,[{projectId:A,clientRequestId:'request-01',acceptedTaskId:receipt.taskId,observedTaskIds:[...f.tasks.keys()]}]);
  const posts=f.posts().length;
  error(await reopened.handle('POST',SUBMIT,submission()),503,'submission_identity_conflict');
  error(await reopened.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'}),503,'submission_identity_conflict');
  error(await reopened.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_identity_conflict');
  assert.equal(f.posts().length,posts,'conflict checks do not replay original request');
  assert.deepEqual(ok(await f.read('conversation-b')).submissionConflicts,[]);
  ok(await reopened.handle('POST',BIND,binding('conversation-b',B,0)));
  f.state.afterCreate=null;
  assert.equal((await reopened.handle('POST',SUBMIT,submission({clientRequestId:'independent'}))).status,202,'independent task in the same conversation remains available');
});

test('an accepted receipt rechecks a conflict inserted between its initial read and transaction',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));const first=ok(await f.routes.handle('POST',SUBMIT,submission()),202);
  const originalPrepare=DatabaseSync.prototype.prepare,originalClose=DatabaseSync.prototype.close,marked=new WeakSet();let injected=false;
  try{
    DatabaseSync.prototype.prepare=function(sql){
      const stmt=originalPrepare.call(this,sql),owner=this;
      if(sql!=='SELECT * FROM submissions WHERE conversation_id=? AND request_id=?')return stmt;
      return {get(...args){const row=stmt.get(...args);if(!injected&&row?.state==='accepted')marked.add(owner);return row;}};
    };
    DatabaseSync.prototype.close=function(){
      const shouldInject=marked.has(this)&&!injected;originalClose.call(this);
      if(shouldInject){injected=true;const writer=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
        try{writer.prepare('INSERT INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)').run('conversation-a','request-01',A,first.task.taskId,'task-'+'f'.repeat(32),'fixture');}finally{writer.close();}}
    };
    error(await f.routes.handle('POST',GET+'/receipt',{conversationId:'conversation-a',clientRequestId:'request-01'}),503,'submission_identity_conflict');
    assert.equal(injected,true);
  }finally{DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.close=originalClose;}
  assert.equal(f.routes.snapshot('conversation-a').submissionConflicts.length,1);
  error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_identity_conflict');
});

test('conflict identities are sorted and overflow is reported without truncating stored evidence',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const first=ok(await f.routes.handle('POST',SUBMIT,submission()),202),db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
  try{
    const insert=db.prepare('INSERT INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)');
    for(const n of [15,2])insert.run('conversation-a','request-01',A,first.task.taskId,'task-'+n.toString(16).padStart(32,'0'),'fixture');
    assert.deepEqual(ok(await f.read()).submissionConflicts[0].observedTaskIds,['task-'+(2).toString(16).padStart(32,'0'),'task-'+(15).toString(16).padStart(32,'0')]);
    for(let n=16;n<31;n++)insert.run('conversation-a','request-01',A,first.task.taskId,'task-'+n.toString(16).padStart(32,'0'),'fixture');
    error(await f.read(),503,'submission_conflicts_overflow');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submission_identity_conflicts').get().n,17);
    error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_identity_conflict');
  }finally{db.close();}
});

test('more than 32 conflicting requests fails closed without hiding database records',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
  try{
    const submit=db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)'),conflict=db.prepare('INSERT INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)');
    for(let n=1;n<=33;n++){
      const request='overflow-'+n,accepted='task-'+n.toString(16).padStart(32,'0'),observed='task-'+(n+100).toString(16).padStart(32,'0');
      submit.run('conversation-a',request,'f'.repeat(64),A,1,'upstream-'+n,null,'accepted',accepted,'fixture');
      conflict.run('conversation-a',request,A,accepted,observed,'fixture');
    }
    error(await f.read(),503,'submission_conflicts_overflow');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submission_identity_conflicts').get().n,33);
    error(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)),409,'submission_identity_conflict');
    assert.deepEqual(ok(await f.read('conversation-b')).submissionConflicts,[]);
  }finally{db.close();}
});

test('a definite rejection is retryable only while its original binding is still current',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  f.state.beforeCreate=()=>({status:409,body:{code:'not_ready'}});
  assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,409);
  assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,0);
  ok(await f.routes.handle('POST',BIND,binding('conversation-a',B,1)));
  error(await f.open().handle('POST',SUBMIT,submission()),409,'binding_changed');
  assert.equal(f.tasks.size,0);
});

test('a definitely rejected exact request can be retried with its unchanged binding',async t=>{
  const f=await fixture(t);ok(await f.routes.handle('POST',BIND,binding()));
  f.state.beforeCreate=()=>({status:409,body:{code:'not_ready'}});
  assert.equal((await f.routes.handle('POST',SUBMIT,submission())).status,409);
  f.state.beforeCreate=null;
  const accepted=ok(await f.open().handle('POST',SUBMIT,submission()),202);
  assert.equal(accepted.task.projectId,A);assert.equal(f.tasks.size,1);assert.equal(f.routes.snapshot('conversation-a').pendingRequests.length,0);
});

test('concurrent duplicate deliveries wait for the original before reusing its request ID', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  const entered = deferred(), release = deferred(); let attempt = 0;
  f.state.afterCreate = async result => {
    if (++attempt === 1) { entered.resolve(); await release.promise; throw new Error('Older delivery loses its response'); }
    return result;
  };
  const first = f.routes.handle('POST', SUBMIT, submission());
  await entered.promise;
  const second = await f.open().handle('POST', SUBMIT, submission());
  release.resolve();
  error(await first, 503, 'submission_unknown'); error(second,503,'submission_in_flight');
  assert.equal(f.posts().length,1);f.state.afterCreate=null;ok(await f.open().handle('POST',SUBMIT,submission()));
  assert.equal(f.tasks.size, 1); assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[0].body.clientRequestId, f.posts()[1].body.clientRequestId);
  const state = ok(await f.read());
  assert.equal(state.taskRefs.length, 1); assert.deepEqual(state.pendingRequests, []);
  ok(await f.open().handle('POST', SUBMIT, submission()));
  assert.equal(f.posts().length, 2, 'Known accepted retry reads the existing task instead of submitting again');
});

test('concurrent binding changes from the same version have exactly one winner', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.state.beforeStatus = async project => { if (project === A) { entered.resolve(); await release.promise; } };
  const first = f.routes.handle('POST', BIND, binding());
  await entered.promise;
  const second = await f.open().handle('POST', BIND, binding('conversation-a', B, 0));
  release.resolve(); ok(second);
  error(await first, 409, 'binding_changed');
  const state = ok(await f.read()); assert.equal(state.projectId, B); assert.equal(state.version, 1);
});

test('wrong-project upstream result stays uncertain and is never attached to the conversation', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  f.state.afterCreate = result => ({ ...result, body: { task: { ...result.body.task, projectId: B } } });
  error(await f.routes.handle('POST', SUBMIT, submission()), 503, 'task_project_mismatch');
  const snapshot = ok(await f.read()); assert.deepEqual(snapshot.taskRefs, []); assert.equal(snapshot.pendingRequests[0].state, 'unknown');
  f.state.afterCreate = null;
  const recovered = ok(await f.open().handle('POST', SUBMIT, submission()));
  assert.equal(recovered.task.projectId, A); assert.equal(f.tasks.size, 1);
});

test('missing accepted task reference is reported rather than silently creating replacement work', async t => {
  const f = await fixture(t);
  ok(await f.routes.handle('POST', BIND, binding()));
  const accepted = ok(await f.routes.handle('POST', SUBMIT, submission()), 202);
  f.tasks.delete(accepted.task.taskId);
  error(await f.open().handle('POST', SUBMIT, submission()), 409, 'task_reference_missing');
  assert.equal(f.posts().length, 1);
  assert.equal(ok(await f.read()).taskRefs[0].taskId, accepted.task.taskId);
});
test('HMI name must appear in original request before any durable submission',async t=>{
 const f=await fixture(t);assert.equal((await f.routes.handle('POST',BIND,binding())).status,200);
 const body=submission({workflow:'hmi-view-name-v1',request:'把画面名称“旧画面”改为“车间”',planSubmission:{schemaVersion:1,plan:{viewId:'view-a',name:'车间'},route:{provider:'offline',model:'fixture'}}});
 const invalid={...body,request:'请修改名称'};
 assert.equal((await f.routes.handle('POST',SUBMIT,invalid)).status,400);
 assert.equal(f.posts().length,0);assert.equal((await f.read()).body.pendingRequests.length,0);
 assert.equal((await f.routes.handle('POST',SUBMIT,body)).status,202);
 assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.request,body.request);
});

test('legacy mismatch never resends an uncertain task and can still read an accepted receipt',async t=>{
 const f=await fixture(t);assert.equal((await f.routes.handle('POST',BIND,binding())).status,200);
 const body=submission({workflow:'hmi-view-name-v1',request:'把画面名称“旧画面”改为“车间”',planSubmission:{schemaVersion:1,plan:{viewId:'view-a',name:'车间'},route:{provider:'offline',model:'fixture'}}});
 assert.equal((await f.routes.handle('POST',SUBMIT,body)).status,202);const count=f.posts().length;
 const legacy={...body,request:'请修改画面'};
 const payload={projectId:legacy.projectId,request:legacy.request,expectedRevision:legacy.expectedRevision,executionScope:legacy.executionScope,sourceBasis:legacy.sourceBasis,clientRequestId:legacy.clientRequestId,planSubmission:legacy.planSubmission,workflow:legacy.workflow};
 const fingerprint=createHash('sha256').update(JSON.stringify({...payload,expectedVersion:legacy.expectedVersion})).digest('hex');
 const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));db.prepare('UPDATE submissions SET fingerprint=? WHERE conversation_id=? AND request_id=?').run(fingerprint,legacy.conversationId,legacy.clientRequestId);db.close();
 const accepted=await f.routes.handle('POST',SUBMIT,legacy);assert.equal(accepted.status,200);assert.equal(accepted.body.duplicate,true);assert.equal(f.posts().length,count);
 const db2=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));db2.prepare("UPDATE submissions SET state='unknown' WHERE conversation_id=? AND request_id=?").run(legacy.conversationId,legacy.clientRequestId);db2.close();
 const uncertain=await f.routes.handle('POST',SUBMIT,legacy);assert.equal(uncertain.status,409);assert.equal(uncertain.body.code,'submission_unknown');assert.equal(f.posts().length,count);
});

test('integrated project revision persists cross-target workflow across reopen and trusted turn claim',async t=>{
 const f=await fixture(t);f.state.revision=REVISION;ok(await f.routes.handle('POST',BIND,binding()));
 const plan={schemaVersion:1,changes:[{kind:'plc-source',path:'plc/pous/programs/main.st',expectedHash:REVISION,content:'PROGRAM main\nEND_PROGRAM'}]};
 const body=submission({workflow:'project-edit-v1',request:'新增延时逻辑',planSubmission:{schemaVersion:1,plan,route:{provider:'account',model:'flash'}}});
 const first=ok(await f.routes.handle('POST',SUBMIT,body),202).task;
 const parent=f.tasks.get(first.taskId);Object.assign(parent,{workflow:'project-edit-v1',request:body.request,projectRevision:REVISION,candidate:{revisionSupported:true,candidateDigest:'d'.repeat(64),summary:{before:'保存版',after:'修改 1 项'}}});
 const arm={conversationId:'conversation-a',projectId:A,taskId:parent.taskId,candidateDigest:'d'.repeat(64),expectedRevision:REVISION,expectedVersion:1,intentId:'project-revision'};
 ok(await f.routes.handle('POST',GET+'/revision',arm));
 const reopened=f.open(),claimed=reopened.claimRevision('conversation-a','turn-2');assert.equal(claimed.workflow,'project-edit-v1');assert.equal(claimed.target,undefined);
 const child=submission({workflow:'project-edit-v1',request:'接着修改画面名称',clientRequestId:'project-child',revisionParent:claimed.parent,revisionIntentId:claimed.intentId,planSubmission:{schemaVersion:1,plan:{schemaVersion:1,changes:[{kind:'hmi-view-name',viewId:'v-a',name:'新版'}]},route:{provider:'other-account',model:'flash'}}});
 ok(await reopened.handle('POST',SUBMIT,child),202);assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'submitted');
 const forwarded=f.posts().at(-1).body;assert.equal(forwarded.workflow,'project-edit-v1');assert.deepEqual(forwarded.revisionParent,claimed.parent);assert.equal(forwarded.planSubmission.plan.changes[0].kind,'hmi-view-name');
 const count=f.posts().length;error(await reopened.handle('POST',SUBMIT,{...body,clientRequestId:'bad-plan',planSubmission:{...body.planSubmission,plan:{shell:'no'}}}),400,'invalid_task');assert.equal(f.posts().length,count);
});
