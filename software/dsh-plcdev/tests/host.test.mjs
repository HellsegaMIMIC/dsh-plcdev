import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';

const A = 'user-' + 'a'.repeat(32);
const INSTANCE = '1'.repeat(32);
const TOKEN = 'test-only-local-capability-' + 'x'.repeat(24);
const HASH = '2'.repeat(64);
const taskBody = () => ({
  projectId: A, request: '将 Count 改为 BatchCount', expectedRevision: HASH,
  executionScope: 'proposal', sourceBasis: 'saved_revision', clientRequestId: 'host-request-1',
});
function send(base, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const data = Buffer.concat(chunks);
        const type = response.headers['content-type'] ?? '';
        resolve({ status: response.statusCode, headers: response.headers,
          body: type.startsWith('application/json') ? JSON.parse(data.toString()) : data });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
async function fixture(t, admission) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plcdev-dsh-host-'));
  const upstreamCalls = [];
  let ticks = 0;
  const monitor = setInterval(() => ticks++, 10);
  const controller = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({ method: req.method, path: req.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    let value;
    if (req.headers.authorization !== 'Bearer ' + TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); return;
    }
    if (req.url.startsWith('/api/status')) value = {
      service: 'plcdev-workbench', schemaVersion: 3, instance: INSTANCE,
      agentTaskInputVersion: 'saved-revision-v1', project: { id: A },
      projects: [{ id: A }], session: { id: 'session-A', active: true, projectId: A },
    };
    else if (req.url === '/api/agent/tasks') value = { ok: true,
      task: { projectId: A, taskId: 'task-' + '3'.repeat(32) } };
    else value = { ok: true };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening');
  const descriptorPath = path.join(root, 'controller.json');
  await writeFile(descriptorPath, JSON.stringify({ base: 'http://127.0.0.1:' + controller.address().port,
    token: TOKEN, instance: INSTANCE, root }));
  const assetDir = path.join(root, 'software', 'workbench', 'assets');
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, 'openplc-logo.png'), Buffer.from([137, 80, 78, 71]));
  const handlers = [], disposers = [];
  const server = http.createServer((req, res) => {
    const route = handlers.find(item => req.url.startsWith(item.path));
    if (!route) { res.writeHead(404); res.end('unregistered'); return; }
    void route.handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = { projectRoot: root, controllerFile: descriptorPath };
  const ctx = {
    on() { return () => {}; },
    systemPrompt: { context() { return () => {}; } },
    sessionProjections: { stateOf() { return undefined; } },
    // Base-profile fixture intentionally has no optional native Teams service.
    inject(names,fn) { if(names.length===1&&names[0]==='connection'&&admission)fn({connection:{admit:admission},effect:ctx.effect});return () => {}; },
    tools: { register() { return () => {}; } },
    llm: { registerAdapter() { return () => {}; } },
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); },
    webServer: {
      getOrigin: () => base,
      register(route) { handlers.push(route); return () => handlers.splice(handlers.indexOf(route), 1); },
    },
  };
  apply(ctx, config);
  const unload = () => { for (const dispose of disposers.splice(0)) dispose(); };
  t.after(async () => {
    unload(); clearInterval(monitor);
    server.closeAllConnections(); controller.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => controller.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  return { base, config, root, controller, upstreamCalls, ctx, unload, ticks: () => ticks,
    request: (route, options) => send(base, route, options) };
}

test('host serves bridge health with unique host identity and no cache or capability leakage', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/plcdev/health');
  assert.equal(r.status, 200); assert.equal(r.body.instance, INSTANCE);
  assert.match(r.body.hostInstance, /^[a-f0-9-]{36}$/); assert.equal(r.body.hostPid, process.pid);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(JSON.stringify(r).includes(TOKEN), false); assert.equal(JSON.stringify(r).includes(f.config.controllerFile), false);
});

test('host rejects foreign Host, Origin and fetch-site before reaching controller', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: 'evil.example' }, { Origin: 'http://evil.example' },
    { Origin: f.base, 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) assert.equal((await f.request('/api/plcdev/health', { headers })).status, 403);
  assert.equal(f.upstreamCalls.length, 0);
});

test('GET accepts own origin and same-origin browser fetch without requiring a browser-readable token', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/plcdev/status?project=' + A, {
    headers: { Origin: f.base, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(r.status, 200); assert.equal(r.body.session.active, true);
  assert.equal(f.upstreamCalls[0].method, 'GET');
});

test('POST requires an explicit matching Origin and exact JSON content type', async t => {
  const f = await fixture(t), body = JSON.stringify(taskBody());
  for (const headers of [
    { 'Content-Type': 'application/json' }, { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    { Origin: f.base, 'Content-Type': 'text/plain' }, { Origin: f.base },
  ]) assert.equal((await f.request('/api/plcdev/tasks', { method: 'POST', headers, body })).status, 403);
  assert.equal(f.upstreamCalls.length, 0);
});

test('same-origin POST forwards candidate creation with saved version and proposal unchanged', async t => {
  const f = await fixture(t), body = taskBody();
  const r = await f.request('/api/plcdev/tasks', {
    method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(r.status, 200); assert.equal(r.body.task.projectId, A);
  assert.deepEqual(f.upstreamCalls.at(-1).body, body);
});

test('oversize or malformed JSON never reaches controller and reports an explicit client error', async t => {
  const f = await fixture(t), headers = { Origin: f.base, 'Content-Type': 'application/json' };
  const large = await f.request('/api/plcdev/tasks', { method: 'POST', headers, body: 'x'.repeat(131073) });
  assert.equal(large.status, 413);
  assert.equal((await f.request('/api/plcdev/tasks', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal(f.upstreamCalls.length, 0);
});

test('assets are restricted to the two known files and use same-origin policy', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/plcdev/assets/openplc-logo.png');
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'image/png');
  assert.deepEqual(r.body, Buffer.from([137, 80, 78, 71]));
  assert.equal((await f.request('/api/plcdev/assets/openplc-logo.png', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/plcdev/assets/../../controller.json')).status, 404);
  assert.equal(f.upstreamCalls.length, 0);
});

test('configuration change requires reload instead of mixing old bridge and new project paths', async t => {
  const f = await fixture(t);
  f.config.projectRoot = path.join(f.root, 'changed');
  const r = await f.request('/api/plcdev/health');
  assert.equal(r.status, 409); assert.equal(f.upstreamCalls.length, 0);
});

test('plugin unload unregisters routes only; independent controller remains alive without Runtime commands', async t => {
  const f = await fixture(t);
  const first = await f.request('/api/plcdev/health');
  f.unload();
  assert.equal((await f.request('/api/plcdev/health')).status, 404);
  const before = f.ticks();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(f.ticks() > before); assert.equal(f.controller.listening, true);
  assert.equal(f.upstreamCalls.some(call => call.method !== 'GET'), false);
  apply(f.ctx, f.config);
  const reopened = await f.request('/api/plcdev/health');
  assert.equal(reopened.status, 200); assert.notEqual(reopened.body.hostInstance, first.body.hostInstance);
  assert.equal(reopened.body.instance, first.body.instance);
  assert.equal(f.upstreamCalls.some(call => call.path === '/api/action'), false);
});


test('desktop write requires authenticated owner and retains source fence',async t=>{
 const f=await fixture(t,req=>req.headers.cookie==='fixture-owner'?{peer:{principal:{kind:'owner'},signal:{aborted:false}}}:{rejection:401});
 const route='/api/plcdev/conversations/bind',body=JSON.stringify({conversationId:'native-chat',projectId:A,expectedVersion:0});
 const headers={'Content-Type':'application/json','X-PLCdev-Desktop':'1'};
 assert.equal((await f.request(route,{method:'POST',headers,body})).status,403);
 assert.equal((await f.request(route,{method:'POST',headers:{...headers,Cookie:'fixture-owner',Origin:'https://evil.example'},body})).status,403);
 assert.equal((await f.request(route,{method:'POST',headers:{...headers,Cookie:'fixture-owner','Sec-Fetch-Site':'cross-site'},body})).status,403);
 const result=await f.request(route,{method:'POST',headers:{...headers,Cookie:'fixture-owner'},body});
 assert.equal(result.status,200);assert.equal(result.body.projectId,A);assert.equal(result.body.version,1);
 assert.equal((await f.request(route,{method:'POST',headers:{...headers,Cookie:'fixture-owner'},body})).status,409);
});
