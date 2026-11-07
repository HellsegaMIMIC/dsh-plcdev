import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge.mjs';

const A = 'user-' + 'a'.repeat(32), B = 'user-' + 'b'.repeat(32);
const TOKEN = 'test_capability_'.repeat(3);
const INSTANCE = 'd'.repeat(32), HASH = 'e'.repeat(64), TASK = 'task-' + 'f'.repeat(32);
const candidate = projectId => ({ projectId, taskId: TASK, candidateDigest: HASH, status: 'review' });
const taskBody = (projectId = A) => ({
  projectId, request: '将 Count 改为 BatchCount', expectedRevision: HASH,
  executionScope: 'proposal', sourceBasis: 'saved_revision', clientRequestId: 'dsh-test-0001',
});
const actionBody = (projectId = A, action = 'tool') => ({
  projectId, sessionId: 'session-A', action, client: 'dsh-test', sequence: 1,
  expires: Date.now() / 1000 + 10, ...(action === 'tool' ? { tool: 'plc' } : {}),
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plcdev-dsh-bridge-'));
  const controllerFile = path.join(root, 'controller.json');
  const calls = [];
  const state = { instance: INSTANCE, projectOverride: null, sessionOverride: null, tasks: [], beforeReply: null, fault: null };
  let descriptor;
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : null;
    calls.push({ method: req.method, url: req.url, body, headers: req.headers });
    const url = new URL(req.url, 'http://127.0.0.1');
    const project = url.searchParams.get('project') ?? A;
    let value, status = 200;
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { status = 403; value = { ok: false }; }
    else if (url.pathname === '/api/status') value = {
      service: 'plcdev-workbench', schemaVersion: 3, instance: state.instance,
      agentTaskInputVersion: 'saved-revision-v1',
      project: { id: state.projectOverride ?? project }, projects: [{ id: A }, { id: B }],
      session: { id: project === A ? 'session-A' : null, active: project === A, projectId: state.sessionOverride ?? project },
      otherSessions: project === B ? [{ id: 'session-A', projectId: A, active: true }] : [],
    };
    else if (url.pathname === '/api/agent/tasks' && req.method === 'GET')
      value = { ok: true, projectId: project, projectRevision: HASH, tasks: state.tasks.filter(item => item.projectId === project) };
    else if (url.pathname === '/api/agent/tasks' && req.method === 'POST') {
      let task = state.tasks.find(item => item.projectId === body.projectId);
      if (!task) { task = candidate(body.projectId); state.tasks.push(task); }
      value = { ok: true, task };
    } else if (['/api/agent/tasks/open', '/api/agent/tasks/review'].includes(url.pathname)) value = { ok: true, ...body };
    else if (url.pathname === '/api/action') value = { ok: true };
    else { status = 404; value = { ok: false }; }
    if (state.beforeReply) await state.beforeReply(req, value);
    if (state.fault) ({ value, status } = state.fault(req, value, status));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  descriptor = { base: 'http://127.0.0.1:' + server.address().port, token: TOKEN, instance: INSTANCE, root, pid: process.pid };
  await writeFile(controllerFile, JSON.stringify(descriptor));
  const config = { projectRoot: root, controllerFile, timeoutMs: 1000 };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, controllerFile, server, calls, state, descriptor, config,
    bridge: createBridge(config),
    async save(change) { Object.assign(descriptor, change); await writeFile(controllerFile, JSON.stringify(descriptor)); },
  };
}

test('health authenticates fixed localhost controller without exposing capability or file', async t => {
  const f = await fixture(t);
  const r = await f.bridge.handle('GET', '/api/plcdev/health');
  assert.equal(r.status, 200); assert.equal(r.body.connected, true); assert.equal(r.body.instance, INSTANCE);
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes(f.controllerFile), false);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(f.calls[0].headers['content-type'], 'application/json');
});

test('switching projects is a read, and preserves other project Runtime and task ownership', async t => {
  const f = await fixture(t);
  f.state.tasks = [candidate(A)];
  const first = await f.bridge.handle('GET', '/api/plcdev/status?project=' + A);
  const second = await f.bridge.handle('GET', '/api/plcdev/status?project=' + B);
  const tasksA = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + A);
  const tasksB = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + B);
  assert.equal(first.body.session.active, true);
  assert.deepEqual(second.body.otherSessions, [{ id: 'session-A', projectId: A, active: true }]);
  assert.equal(tasksA.body.tasks[0].projectId, A); assert.deepEqual(tasksB.body.tasks, []);
  assert.equal(f.calls.every(c => c.method === 'GET'), true);
});

test('candidate create/open forwards original proposal and saved revision unchanged', async t => {
  const f = await fixture(t), body = taskBody();
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', body);
  assert.equal(r.status, 200); assert.equal(r.body.task.projectId, A);
  assert.deepEqual(f.calls.find(c => c.method === 'POST').body, body);
  const open = { projectId: A, taskId: TASK, candidateDigest: HASH };
  assert.equal((await f.bridge.handle('POST', '/api/plcdev/tasks/open', open)).status, 200);
  assert.deepEqual(f.calls.at(-1).body, open);
});

test('joint review accepts only explicit keep undo compile with pinned identities', async t => {
  const f=await fixture(t);
  const body={projectId:A,taskId:TASK,candidateDigest:HASH,expectedRevision:HASH,action:'keep',clientRequestId:'review-1'};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',body)).status,200);
  assert.deepEqual(f.calls.at(-1).body,body);
  for(const action of ['run','end','tool'])assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',{...body,action})).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',{...body,sessionId:'forbidden'})).status,400);
  assert.equal(f.calls.some(c=>c.url==='/api/action'),false);
  const wrong=f.state.fault=(_req,value,status)=>({status,value:{...value,taskId:'task-'+'0'.repeat(32)}});
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',body)).body.code,'candidate_mismatch');
});

test('joint workflow is explicitly forwarded while unknown workflows and browser model access are rejected', async t=>{
  const f=await fixture(t),body={...taskBody(),workflow:'joint-ai-v1'};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
  assert.equal(f.calls.at(-1).body.workflow,'joint-ai-v1');
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',{...body,workflow:'arbitrary'})).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/model',{})).status,404);
});

test('bridge reopen recovers upstream candidates and performs no Runtime actions', async t => {
  const f = await fixture(t);
  await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  const reopened = createBridge(f.config);
  const r = await reopened.handle('GET', '/api/plcdev/tasks?project=' + A);
  assert.deepEqual(r.body.tasks, [candidate(A)]);
  assert.equal(f.calls.some(c => c.url === '/api/action'), false);
});

test('stale instance blocks mutation before any task or Runtime dispatch', async t => {
  const f = await fixture(t); f.state.instance = '0'.repeat(32);
  const r = await f.bridge.handle('POST', '/api/plcdev/action', actionBody(A, 'end'));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'instance_mismatch');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
});

test('wrong project root and nonloopback descriptor fail without network access', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'); await mkdir(other);
  await f.save({ root: other });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'root_mismatch');
  await f.save({ root: f.root, base: 'http://example.org:1234' });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_controller');
  assert.equal(f.calls.length, 0);
});

test('descriptor replacement during probe cannot redirect pending write to new instance', async t => {
  const f = await fixture(t);
  f.state.beforeReply = async req => { if (req.url.startsWith('/api/status')) await f.save({ instance: '0'.repeat(32) }); };
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 409); assert.equal(r.body.code, 'controller_changed');
  assert.equal(f.calls.length, 1);
});

test('unknown route, arbitrary path/URL and unsafe actions are rejected before connecting', async t => {
  const f = await fixture(t);
  for (const raw of ['http://evil.test', '/api/plcdev/../action', '/api/plcdev/status?project=' + A + '&url=http://evil.test', '/api/plcdev/tasks?project=' + A + '&project=' + B])
    assert.ok((await f.bridge.handle('GET', raw)).status >= 400);
  for (const body of [{ ...actionBody(), action: 'kill' }, { ...actionBody(), tool: 'http://evil.test' },
    { ...actionBody(), path: 'C:/secret' }, { ...taskBody(), executionScope: 'local_validation' }])
    assert.ok((await f.bridge.handle('POST', body.request ? '/api/plcdev/tasks' : '/api/plcdev/action', body)).status >= 400);
  assert.equal(f.calls.length, 0);
});

test('session-changing and expired actions are not sent', async t => {
  const f = await fixture(t);
  const wrong = await f.bridge.handle('POST', '/api/plcdev/action', { ...actionBody(), sessionId: 'session-old' });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.code, 'session_mismatch');
  const expired = await f.bridge.handle('POST', '/api/plcdev/action', { ...actionBody(), expires: Date.now() / 1000 - 1 });
  assert.equal(expired.status, 409); assert.equal(expired.body.code, 'expired');
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('explicit tool/start/run/stop/end retain all ownership and replay fields', async t => {
  const f = await fixture(t);
  for (const action of ['tool', 'start', 'runtime-start', 'runtime-stop', 'end']) {
    const body = actionBody(A, action);
    const r = await f.bridge.handle('POST', '/api/plcdev/action', body);
    assert.equal(r.status, 200); assert.deepEqual(f.calls.at(-1).body, body);
  }
});

test('response project and session mismatches never become visible data', async t => {
  const f = await fixture(t);
  f.state.projectOverride = B;
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status?project=' + A)).body.code, 'project_mismatch');
  f.state.projectOverride = null; f.state.sessionOverride = B;
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status?project=' + A)).body.code, 'session_mismatch');
});

test('cross-project task contamination is rejected', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({ status, value: req.url.startsWith('/api/agent/tasks') ? { ok: true, projectId: A, tasks: [candidate(B)] } : value });
  const r = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + A);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'task_project_mismatch');
  assert.equal(JSON.stringify(r).includes(B), false);
});

test('backend errors and nested secrets are scrubbed, mutations never automatically retried', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({
    status: req.method === 'POST' ? 503 : status,
    value: req.method === 'POST' ? { ok: false, error: 'Bearer ' + TOKEN, nested: { token: TOKEN, apiKey: 'secret-key', safe: 'ok' } } : value,
  });
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 503); assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes('secret-key'), false); assert.equal(r.body.nested.safe, 'ok');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('offline or missing controller is a bounded failure, without process ownership or cleanup', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  const r = await f.bridge.handle('GET', '/api/plcdev/status');
  assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream_unavailable');
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  const missing = createBridge({ ...f.config, controllerFile: path.join(f.root, 'missing.json') });
  assert.equal((await missing.handle('GET', '/api/plcdev/health')).body.code, 'controller_unavailable');
});

test('caller mutation during health cannot switch original project identity', async t => {
  const f = await fixture(t), body = taskBody();
  f.state.beforeReply = async () => { body.projectId = B; };
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', body);
  assert.equal(r.status, 200); assert.equal(r.body.task.projectId, A);
  assert.equal(f.calls.at(-1).body.projectId, A);
});

test('incompatible task version refuses generation but keeps readonly status available', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({ status, value: { ...value, agentTaskInputVersion: 'old' } });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status')).status, 200);
  assert.equal((await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody())).body.code, 'version_mismatch');
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});


test('request timeout is bounded and an uncertain mutation is not resent', async t => {
  const f = await fixture(t);
  f.state.beforeReply = async req => {
    if (req.method === 'POST') await new Promise(resolve => setTimeout(resolve, 180));
  };
  const bridge = createBridge({ ...f.config, timeoutMs: 60 });
  const r = await bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('redirect or invalid JSON is never treated as healthy or followed', async t => {
  const f = await fixture(t);
  f.state.fault = () => ({ status: 302, value: { location: 'http://example.org' } });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_response');
  assert.equal(f.calls.length, 1);
  f.state.fault = () => ({ status: 200, value: null });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_response');
  assert.equal(f.calls.length, 2);
});
