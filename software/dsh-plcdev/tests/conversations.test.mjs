// Offline API behavior with a real temporary SQLite context store and an in-memory
// fake bridge. These tests do not exercise the live TaskService, DSH UI or Runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationRoutes } from '../src/conversations.mjs';

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

async function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'plcdev-dsh-conversations-'));
  const calls = [], tasks = new Map(), ledger = new Map();
  const state = { projects: new Set([A, B]), statusOverride: null, afterCreate: null, beforeStatus: null };
  let sequence = 0;
  const bridge = {
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
        return { status: 200, body: { projectId: project, tasks: [...tasks.values()].filter(task => task.projectId === project).map(task => structuredClone(task)) } };
      }
      if(method==='POST'&&parsed.pathname==='/api/plcdev/tasks/review')return {status:202,body:{ok:true,...body}};
      throw new Error('Unexpected fixture call: ' + method + ' ' + url);
    },
  };
  const open = () => createConversationRoutes({ controllerFile: path.join(root, 'controller.json'), bridge });
  const routes = open();
  const read = (conversationId = 'conversation-a', route = routes) => route.handle('GET', GET + '?conversationId=' + encodeURIComponent(conversationId));
  const posts = () => calls.filter(call => call.method === 'POST');
  t.after(async () => {
    // Every behavior test also proves the route never attempts tool or Runtime actions.
    try {
      assert.ok(calls.every(call => {
        const pathname = new URL(call.url, 'http://127.0.0.1').pathname;
        return call.method === 'POST' ? ['/api/plcdev/tasks','/api/plcdev/tasks/review'].includes(pathname) : ['/api/plcdev/status', '/api/plcdev/tasks'].includes(pathname);
      }), 'Conversation routes must never call /action or a Runtime endpoint');
    } finally {
      const target = path.resolve(root);
      assert.ok(target.startsWith(temporaryRoot + path.sep) && path.basename(target).startsWith('plcdev-dsh-conversations-'), 'Cleanup is restricted to this test temporary directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  return { routes, read, open, state, tasks, ledger, calls, posts };
}

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
 let sent;bridge.handle=async(_m,_u,b)=>{sent=b;return {status:503,body:{code:'unknown'}};};
 assert.equal((await reopened.handle('POST',SUBMIT,payload)).status,503);assert.equal(sent.revisionParent.taskId,task.taskId);assert.equal(sent.revisionIntentId,undefined);
 const pending=reopened.snapshot('conversation-a').pendingRequests[0];assert.equal(pending.revisionIntentId,'revision-1');
 assert.equal(reopened.releaseRevision('conversation-a','turn-2'),false);
 assert.equal(reopened.snapshot('conversation-a').revisionContext.state,'submitting');
 assert.throws(()=>reopened.claimRevision('conversation-a','turn-3'),/投递结果待核对/);
 assert.equal((await reopened.handle('POST',SUBMIT,{...payload,clientRequestId:'duplicate-turn'})).status,409);
 assert.equal((await reopened.handle('POST',GET+'/revision/cancel',{conversationId:'conversation-a',intentId:'revision-1'})).status,200);
 assert.equal((await reopened.handle('POST',SUBMIT,payload)).status,503); // Existing exact outbox may still be reconciled.
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
  assert.deepEqual(ok(await f.read()), { ok: true, conversationId: 'conversation-a', projectId: null, version: 0, taskRefs: [], pendingRequests: [] });
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
  ok(await reopened.handle('POST', BIND, binding('conversation-a', B, 1)));
  f.state.afterCreate = null;
  const recovered = ok(await reopened.handle('POST', SUBMIT, submission()));
  assert.equal(recovered.task.projectId, A); assert.equal(f.tasks.size, 1);
  assert.equal(f.posts()[0].body.clientRequestId, f.posts()[1].body.clientRequestId);
  const final = ok(await f.read('conversation-a', f.open()));
  assert.equal(final.projectId, B); assert.equal(final.taskRefs[0].taskId, recovered.task.taskId);
  assert.equal(final.taskRefs[0].projectId, A); assert.deepEqual(final.pendingRequests, []);
});

test('concurrent duplicate deliveries from reopened stores retain one task and cannot regress accepted state to unknown', async t => {
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
  error(await first, 503, 'submission_unknown'); ok(second);
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
