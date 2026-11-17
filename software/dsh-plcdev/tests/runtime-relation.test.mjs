import test from 'node:test';
import assert from 'node:assert/strict';
import {currentRuntimeIssues, runtimeEnvironment, runtimeRelation} from '../src/client/runtime-relation.mjs';

const now = 2_000_000;
const savedRevision = 'a'.repeat(64);
const programHash = 'b'.repeat(64);
const oldRevision = 'c'.repeat(64);
const projectId = 'user-runtime-model';
let eventSequence = 0;

function snapshot() {
  return {
    project: {id: projectId, defaultMode: 'fuxa-oip', hmi: 'main.fuxap', scene: 'project.json'},
    session: {id: 'current-instance', active: true, programHash},
    phase: 'ready', observerFresh: true, projectChanged: false,
    state: {observedAt: now / 1000, runtimeState: 'RUNNING', communication: {lastSuccessAt: now / 1000}},
    links: {load: {state: 'current'}},
    dependencies: [{id: 'runtime', available: true}, {id: 'msys', available: true}],
  };
}
const model = s => runtimeRelation(s, {now, projectRevision: savedRevision});
const node = (value, id) => value.nodes.find(row => row.id === id);
function event(source, overrides = {}) {
  return {id: 'event-' + ++eventSequence, source, status: 'active', severity: 'error', firstAt: now / 1000, lastAt: now / 1000, sessionId: null, projectRevision: savedRevision, ...overrides};
}
function events(rows, overrides = {}) {
  return {projectId, currentSessionId: 'current-instance', projectRevision: savedRevision, events: rows, ...overrides};
}

test('RUN and current load require a fresh observation from an active instance', () => {
  const current = model(snapshot());
  assert.equal(current.fresh, true);
  assert.equal(node(current, 'runtime').value, 'RUN · 运行中');
  assert.equal(node(current, 'runtime').tone, 'good');
  assert.equal(current.wires.load, 'good');
  for (const observedAt of [(now - 2000) / 1000, (now - 9000) / 1000, (now + 1) / 1000, undefined, NaN]) {
    const s = snapshot(); s.state.observedAt = observedAt;
    const r = model(s);
    assert.equal(r.fresh, false, `timestamp ${observedAt}`);
    assert.equal(node(r, 'runtime').value, '运行状态未知');
    assert.notEqual(node(r, 'runtime').tone, 'good');
    assert.notEqual(r.wires.load, 'good');
    assert.equal(node(r, 'compiler').value, '上次装载的编译产物');
  }
  for (const field of ['observerFresh', 'active']) {
    const s = snapshot();
    if (field === 'active') s.session.active = false; else s.observerFresh = false;
    const r = model(s);
    assert.equal(r.fresh, false);
    assert.doesNotMatch(node(r, 'runtime').value, /RUN/);
    assert.notEqual(r.wires.load, 'good');
  }
});

test('saved engineering revision and compiled PLC hash are different identities', () => {
  const r = model(snapshot());
  assert.notEqual(savedRevision, programHash);
  assert.equal(r.revision, savedRevision.slice(0, 8));
  assert.equal(r.stale, false);
  assert.equal(r.configurationChanged, false);
  assert.equal(node(r, 'runtime').note, '已装载当前 PLC 程序');
  assert.equal(r.wires.compile, 'good');
  assert.equal(r.wires.load, 'good');
  assert.equal(node(r, 'compiler').note.includes(programHash.slice(0, 8)), false);
});

test('configuration changes do not claim the PLC source or compiled program changed', () => {
  const s = snapshot(); s.projectChanged = true;
  const r = model(s);
  assert.equal(r.stale, false);
  assert.equal(r.configurationChanged, true);
  assert.equal(node(r, 'runtime').tone, 'warning');
  assert.match(node(r, 'runtime').note, /工程配置已变化/);
  assert.doesNotMatch(node(r, 'runtime').note, /新的 PLC 修改/);
  assert.equal(node(r, 'compiler').tone, 'good');
  assert.equal(r.wires.compile, 'good');
  assert.equal(r.wires.load, 'warning');
});

test('stale PLC load is distinguished from configuration-only changes', () => {
  const s = snapshot(); s.projectChanged = true; s.links.load.state = 'stale';
  const r = model(s);
  assert.equal(r.stale, true);
  assert.equal(r.configurationChanged, false);
  assert.match(node(r, 'runtime').note, /新的 PLC 修改/);
  assert.equal(node(r, 'compiler').tone, 'warning');
  assert.equal(r.wires.load, 'warning');
  assert.notEqual(r.wires.compile, 'good');
});

test('building and unconfirmed states never imply the PLC is already running', () => {
  const s = snapshot(); s.phase = 'building';
  const r = model(s);
  assert.equal(node(r, 'runtime').value, '正在准备');
  assert.equal(node(r, 'compiler').value, '编译与准备中');
  assert.match(node(r, 'compiler').note, /不会自动运行/);
  assert.equal(r.wires.load, 'active');
  s.phase = 'stopping';
  assert.equal(node(model(s), 'runtime').value, '正在结束');
  assert.notEqual(node(model(s), 'runtime').tone, 'good');
  s.phase = 'ended'; s.session.active = false;
  assert.equal(node(model(s), 'runtime').value, '已结束');
  const unknown = model(null);
  assert.equal(unknown.fresh, false);
  assert.equal(node(unknown, 'runtime').value, '状态未确认');
  assert.equal(node(unknown, 'project').value, '工程状态未确认');
  assert.ok(Object.values(unknown.wires).every(tone => tone !== 'good'));
});

test('local input telemetry is not evidence of an HMI connection', () => {
  const s = snapshot();
  s.links.variables = {source: 'inputs', state: 'connected', observedAt: now / 1000, channelConnected: true, dataFresh: true, dataQuality: 'live'};
  const r = model(s);
  assert.equal(node(r, 'hmi').value, '通信未确认');
  assert.equal(node(r, 'hmi').tone, 'muted');
  assert.equal(r.wires.hmi, 'muted');
});

test('HMI and OIP require their own fresh connection evidence', () => {
  const s = snapshot();
  s.links.variables = {source: 'hmi', state: 'connected', observedAt: now / 1000, channelConnected: true, dataFresh: true, dataQuality: 'live'};
  s.links.io = {state: 'connected'};
  assert.equal(model(s).wires.hmi, 'good');
  assert.equal(model(s).wires.oip, 'good');
  for (const alter of [
    value => { value.observerFresh = false; },
    value => { value.links.variables.observedAt = (now - 2000) / 1000; value.state.communication.lastSuccessAt = (now - 2000) / 1000; },
    value => { value.links.variables.channelConnected = false; value.links.io.state = 'unknown'; },
    value => { value.links.variables.dataQuality = 'historical'; value.links.io.requiresManualRecovery = true; },
  ]) {
    const changed = structuredClone(s); alter(changed);
    const r = model(changed);
    assert.notEqual(r.wires.hmi, 'good');
    assert.notEqual(r.wires.oip, 'good');
  }
  const absent = snapshot(); absent.project = {id: projectId};
  assert.equal(node(model(absent), 'hmi').value, '工程未配置画面');
  assert.equal(node(model(absent), 'oip').value, '工程未配置场景');
});

test('current badges exclude other instances, other saved revisions and historical records', () => {
  const value = events([
    event('oip', {projectRevision: oldRevision}),
    event('compiler', {sessionId: 'old-instance'}),
    event('fuxa', {status: 'resolved'}),
    event('plcdev', {status: 'recorded'}),
    event('runtime', {severity: 'info', sessionId: 'current-instance'}),
    event('compiler'),
  ]);
  assert.deepEqual(currentRuntimeIssues(value, snapshot(), savedRevision), {compiler: 1, runtime: 0, fuxa: 0, oip: 0, plcdev: 0});
});

test('live snapshot instance and saved revision override a delayed event response context', () => {
  const value = events([
    event('runtime', {sessionId: 'old-instance', projectRevision: oldRevision}),
    event('runtime', {sessionId: 'current-instance', projectRevision: oldRevision}),
    event('oip', {projectRevision: oldRevision}),
    event('oip'),
  ], {currentSessionId: 'old-instance', projectRevision: oldRevision});
  const counts = currentRuntimeIssues(value, snapshot(), savedRevision);
  assert.equal(counts.runtime, 1, 'current runtime incidents remain relevant after a project save');
  assert.equal(counts.oip, 1, 'only the current saved revision contributes unowned check badges');
  assert.equal(value.currentSessionId, 'old-instance', 'normalization must not mutate event data');
  assert.equal(value.projectRevision, oldRevision);
});

test('no snapshot or a different project cannot borrow event badges', () => {
  const value = events([event('compiler')]);
  assert.deepEqual(currentRuntimeIssues(value, null), {});
  assert.deepEqual(currentRuntimeIssues({...value, projectId: 'user-other'}, snapshot()), {});
  const s = snapshot(); s.session.id = null; s.session.active = false;
  const counts = currentRuntimeIssues(events([event('runtime', {sessionId: 'old-instance'}), event('plcdev', {projectRevision: null})]), s);
  assert.equal(counts.runtime, 0);
  assert.equal(counts.plcdev, 1, 'project-level environment issues need no runtime instance');
});

test('legacy dependency probes stay partial and missing information stays unchecked', () => {
  const oldHost = runtimeEnvironment(snapshot(), null);
  assert.deepEqual(oldHost.map(row => row.state), ['partial', 'partial']);
  assert.ok(oldHost.every(row => row.labelState === '基本入口已找到'));
  assert.deepEqual(runtimeEnvironment(null, null).map(row => row.state), ['unchecked', 'unchecked']);
  const s = snapshot(); s.dependencies[1].available = false;
  assert.deepEqual(runtimeEnvironment(s, null).map(row => row.state), ['partial', 'missing']);
});

test('full environment probes take precedence without treating entry presence as runtime verification', () => {
  const s = snapshot(); s.session.active = false; s.dependencies.forEach(row => { row.available = false; });
  const environment = {tools: [{id: 'runtime', state: 'found', version: '4.3.0'}, {id: 'msys', state: 'found'}]};
  const r = runtimeRelation(s, {now, environment});
  assert.deepEqual(r.environment.map(row => row.state), ['found', 'found']);
  assert.equal(r.environment[0].version, '4.3.0');
  assert.equal(r.missing, false);
  assert.equal(node(r, 'runtime').value, '尚未准备');
  assert.equal(node(r, 'compiler').value, '尚无已确认编译产物');
  assert.notEqual(r.wires.load, 'good');
  environment.tools[1].state = 'missing';
  const missing = runtimeRelation(s, {now, environment});
  assert.equal(missing.missing, true);
  assert.equal(node(missing, 'compiler').value, '运行依赖未齐备');
  assert.equal(node(missing, 'compiler').tone, 'warning');
  environment.tools[1].state = 'unchecked';
  assert.equal(runtimeEnvironment(snapshot(), environment)[1].state, 'unchecked', 'an explicitly unknown full probe must not fall back to legacy success');
});
