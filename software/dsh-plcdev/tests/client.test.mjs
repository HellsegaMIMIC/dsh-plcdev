import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadGate, validateSnapshot, validateTasks, makeCandidateRequest, readPending, persistPending, pendingKey, definitiveFailure, candidateIdentity, canUseTool, externalRuntimeOwner, runtimeOwnerLabel, graphEntities, connectionLabel } from '../src/client/model.mjs';

test('switch A → B → A rejects results from the first A and superseded same-project polls', () => {
  const gate = createReadGate(); gate.select('A'); const a = gate.begin('status'); gate.select('B'); const b = gate.begin('tasks'); gate.select('A');
  assert.equal(gate.accepts(a), false); assert.equal(gate.accepts(b), false);
  const earlier = gate.begin('status'), latest = gate.begin('status'); assert.equal(gate.accepts(earlier), false); assert.equal(gate.accepts(latest), true);
  const tasks = gate.begin('tasks'); assert.equal(gate.accepts(latest), true); assert.equal(gate.accepts(tasks), true);
});
test('status and task identity mismatches are rejected rather than displayed as current', () => {
  assert.throws(() => validateSnapshot({ project: { id: 'B' }, projects: [{ id: 'B' }] }, 'A'));
  assert.throws(() => validateTasks({ projectId: 'A', projectRevision: 'hash', tasks: [{ projectId: 'B' }] }, 'A'));
  assert.throws(() => validateTasks({ projectId: 'A', projectRevision: '', tasks: [] }, 'A'));
});
test('saved-version consent required; persisted uncertain retry preserves every original field', () => {
  const args = { projectId: 'A', request: 'Count 改名 BatchCount', revision: 'old-revision', clientRequestId: 'same-id', consent: false };
  assert.throws(() => makeCandidateRequest(args));
  const original = makeCandidateRequest({ ...args, consent: true });
  const storage = { value: '', setItem(k, v) { assert.equal(k, pendingKey); this.value = v; }, getItem() { return this.value; } };
  persistPending(storage, new Map([['A', original]]));
  assert.deepEqual(readPending(storage).get('A'), original); assert.equal(original.executionScope, 'proposal'); assert.equal(original.sourceBasis, 'saved_revision');
  assert.equal(readPending(storage).has('B'), false);
});
test('unknown/malformed legacy pending consent is never upgraded silently', () => {
  const storage = { getItem: () => JSON.stringify([['A', { projectId: 'A', request: 'x', expectedRevision: 'r', executionScope: 'proposal', clientRequestId: 'id' }]]) };
  assert.equal(readPending(storage).size, 0); assert.equal(definitiveFailure({ httpStatus: 409 }), true); assert.equal(definitiveFailure({ httpStatus: 503 }), false); assert.equal(definitiveFailure({ httpStatus: 408 }), false);
});
test('candidate open needs matching project, state, task ID and whole digest', () => {
  const task = { projectId: 'A', taskId: 'task-' + 'a'.repeat(32), status: 'awaiting_review', candidate: { candidateDigest: 'b'.repeat(64) } };
  assert.ok(candidateIdentity(task, 'A')); assert.equal(candidateIdentity(task, 'B'), null); assert.equal(candidateIdentity({ ...task, status: 'failed' }, 'A'), null); assert.equal(candidateIdentity({ ...task, candidate: { candidateDigest: 'b'.repeat(12) } }, 'A'), null);
});
test('offline or wrong-project snapshots never authorize native entry actions', () => {
  const s = { project: { id: 'A' }, capabilities: { tools: { plc: true } } };
  assert.equal(canUseTool(s, 'A', 'plc', true), true); assert.equal(canUseTool(s, 'A', 'plc', false), false); assert.equal(canUseTool(s, 'B', 'plc', true), false);
});
test('local project graph contains only configured real instances', () => {
  assert.deepEqual(graphEntities({ project: { id: 'A', kind: 'user', plc: 'A/project.json', target: 'local' } }).map(n => n.id), ['plc', 'runtime']);
  const fuxa = graphEntities({ project: { id: 'B', plc: 'B/project.json', target: 'local', defaultMode: 'fuxa-oip', configuration: { hmiFile: 'B/hmi.json', sceneFile: 'B/scene.json' } } });
  assert.deepEqual(fuxa.map(n => n.id), ['plc', 'runtime', 'designer', 'hmi', 'scene']); assert.equal(fuxa.find(n => n.id === 'scene').tool, 'oip');
});
test('a global Runtime owner cannot be mistaken for the selected project session', () => {
  const owner = { sessionId: 'other-session', pid: 42 };
  assert.deepEqual(externalRuntimeOwner({ runtimeOwner: owner }), owner);
  assert.deepEqual(externalRuntimeOwner({ runtimeOwner: owner, session: { id: 'selected-session' } }), owner);
  assert.equal(externalRuntimeOwner({ runtimeOwner: owner, session: { id: 'other-session' } }), null);
});
test('unknown Runtime lock inspection is never upgraded to confirmed occupancy', () => {
  const unknown = { state: 'unknown', reason: '无法访问全局会话锁' };
  assert.deepEqual(externalRuntimeOwner({ runtimeOwner: unknown }), unknown);
  assert.equal(runtimeOwnerLabel(unknown), '共享 Runtime 状态无法核验');
  assert.equal(runtimeOwnerLabel({ sessionId: 'external' }), '共享 Runtime 被其他入口占用');
});
test('communication cannot remain live after telemetry expiry, stop or lost backend', () => {
  const s = { session: { active: true }, observerFresh: true, links: { variables: { state: 'connected', channelConnected: true, dataFresh: true, dataQuality: 'live', observedAt: 10 } } };
  assert.equal(connectionLabel(s, 'variables', true, 11000).tone, 'good'); assert.equal(connectionLabel(s, 'variables', true, 13000).label, '数据过期'); assert.equal(connectionLabel(s, 'variables', false, 11000).label, '状态未知');
  assert.equal(connectionLabel({ ...s, session: { active: false } }, 'variables', true, 11000).label, '无运行会话');
});
