export const STORAGE_PREFIX = 'plcdev.dsh.d1.';
export const pendingKey = STORAGE_PREFIX + 'pending';
export const selectionKey = STORAGE_PREFIX + 'project';

export function createReadGate() {
  let epoch = 0, project = '', reads = new Map();
  return {
    select(id) { project = id; epoch++; reads = new Map(); },
    begin(channel) { const serial = (reads.get(channel) || 0) + 1; reads.set(channel, serial); return { epoch, project, channel, serial }; },
    accepts(ticket) { return ticket.epoch === epoch && ticket.project === project && reads.get(ticket.channel) === ticket.serial; },
    matches(id) { return project === id; },
  };
}

export function validateSnapshot(value, projectId) {
  if (!value || typeof value.project?.id !== 'string' || !Array.isArray(value.projects)) throw new Error('工程服务未返回有效工程身份。');
  if (projectId && value.project.id !== projectId) throw new Error('工程服务返回了其他工程，已停用操作。');
  if (!value.projects.some(p => p.id === value.project.id)) throw new Error('当前工程不在工程清单中。');
  return value;
}

export function validateTasks(value, projectId) {
  if (!value || value.projectId !== projectId || typeof value.projectRevision !== 'string' || !value.projectRevision || !Array.isArray(value.tasks)) throw new Error('任务工程身份或保存版本无法确认。');
  if (value.tasks.some(task => !task || task.projectId !== projectId)) throw new Error('任务列表包含其他工程，已停用候选操作。');
  return value;
}

export function readPending(storage) {
  try {
    const entries = JSON.parse(storage.getItem(pendingKey) || '[]');
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && validPending(entry[1]) && entry[0] === entry[1].projectId).slice(-30));
  } catch { return new Map(); }
}
export function validPending(p) {
  return p && typeof p.projectId === 'string' && p.projectId.length > 0 && typeof p.request === 'string' && p.request.length > 0 && p.request.length <= 4000 && typeof p.expectedRevision === 'string' && p.expectedRevision.length > 0 && typeof p.clientRequestId === 'string' && p.clientRequestId.length > 0 && p.executionScope === 'proposal' && p.sourceBasis === 'saved_revision';
}
export function persistPending(storage, pending) { storage.setItem(pendingKey, JSON.stringify([...pending])); }
export function makeCandidateRequest({ projectId, request, revision, consent, clientRequestId }) {
  if (!consent) throw new Error('请先确认基于当前已保存版本生成候选。');
  const result = { projectId, request: request.trim(), expectedRevision: revision, executionScope: 'proposal', sourceBasis: 'saved_revision', clientRequestId };
  if (!validPending(result)) throw new Error('任务请求或工程保存版本无效。');
  return result;
}
export const definitiveFailure = error => Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408;
export function candidateIdentity(task, projectId) {
  if (task?.projectId !== projectId || task.status !== 'awaiting_review' || !/^task-[0-9a-f]{32}$/.test(task.taskId || '') || !/^[0-9a-f]{64}$/.test(task.candidate?.candidateDigest || '')) return null;
  return { projectId, taskId: task.taskId, candidateDigest: task.candidate.candidateDigest };
}
export function canUseTool(snapshot, projectId, tool, connected) {
  return connected === true && snapshot?.project?.id === projectId && snapshot?.capabilities?.tools?.[tool] === true;
}
export function externalRuntimeOwner(snapshot) {
  const owner = snapshot?.runtimeOwner;
  const ownSession = snapshot?.session?.id ?? snapshot?.sessionId;
  return owner && (!ownSession || owner.sessionId !== ownSession) ? owner : null;
}
export function runtimeOwnerLabel(owner) {
  return owner?.state === 'unknown' ? '共享 Runtime 状态无法核验' : '共享 Runtime 被其他入口占用';
}
export function graphEntities(snapshot) {
  const p = snapshot?.project || {}, c = snapshot?.components || {};
  const fuxa = ['fuxa-oip', 'fuxa-local'].includes(p.defaultMode);
  const hmi = p.configuration?.hmiFile || p.hmi;
  const scene = p.defaultMode === 'fuxa-local' ? null : p.configuration?.sceneFile || p.scene;
  const entities = [];
  if (p.plc) entities.push({ id: 'plc', title: 'OpenPLC', role: 'PLC 工程', path: p.plc, tool: 'plc', component: c.plc, icon: 'plc' });
  if (p.target || p.targetDefinition || c.runtime) entities.push({ id: 'runtime', title: 'OpenPLC Runtime', role: '本机执行实例', path: p.target || '本机隔离 Runtime', component: c.runtime, icon: 'runtime' });
  if (hmi) entities.push({ id: 'designer', title: fuxa ? 'FUXA' : 'EEZ Studio', role: 'HMI 画面工程', path: hmi, tool: fuxa ? 'fuxa' : 'eez', component: c.fuxa || c.eez, icon: fuxa ? 'fuxa' : 'eez' });
  if (p.hmiExecutable || hmi && (c.hmi || fuxa)) entities.push({ id: 'hmi', title: fuxa ? 'FUXA HMI' : 'HMI', role: fuxa ? '浏览器运行画面' : 'LVGL 运行画面', path: p.hmiExecutable || hmi, component: c.hmi, icon: 'hmi', hmi: true, fuxa });
  if (scene) entities.push({ id: 'scene', title: fuxa ? 'Open Industry Project' : 'Factory I/O', role: '当前工程仿真场景', path: scene, tool: fuxa ? 'oip' : 'factory', component: c.oip || c.factory, icon: 'scene' });
  return entities;
}
export function connectionLabel(snapshot, key, connected, now = Date.now()) {
  if (!connected) return { label: '状态未知', tone: 'muted' };
  const l = snapshot?.links?.[key] || {};
  if (key === 'generate' || key === 'load') return { label: ({ current: '版本一致', stale: '需要更新', missing: '缺少产物', inactive: '尚未装载' })[l.state] || l.label || '尚未确认', tone: l.state === 'current' ? 'good' : ['stale', 'missing'].includes(l.state) ? 'warn' : 'muted' };
  if (!snapshot?.session?.active) return { label: '无运行会话', tone: 'muted' };
  if (snapshot.observerFresh !== true) return { label: '观察数据失效', tone: 'warn' };
  if (l.state === 'disconnected') return { label: '已断开', tone: 'warn' };
  const at = key === 'variables' ? l.observedAt : snapshot.state?.communication?.lastSuccessAt;
  const fresh = typeof at === 'number' && now - at * 1000 >= 0 && now - at * 1000 < 2000;
  const valid = l.state === 'connected' && fresh && (key !== 'variables' || l.channelConnected === true && l.dataFresh === true && l.dataQuality === 'live');
  if (valid) return { label: l.requiresManualRecovery ? '已连接 · 待确认' : '实时连接', tone: l.requiresManualRecovery ? 'warn' : 'good' };
  if (key === 'variables' && l.dataQuality === 'historical' && snapshot.state?.runtimeState === 'STOPPED') return { label: '历史值', tone: 'muted' };
  return { label: l.state === 'connected' || l.state === 'stale' ? '数据过期' : l.label || '尚未确认', tone: 'warn' };
}
export const taskStatus = value => ({ team_waiting: '等待专业成员成果', analysis_ready: '专业分析已收回', components_ready: '三端产物齐全 · 待组装', generation_assembling: '组装结果待核对', queued: '待执行', pending: '待执行', created: '已创建', running: '执行中', generating: '生成候选', validating: '校验中', awaiting_review: '待审阅', needs_review: '待核对', blocked: '待处理', conflict: '冲突', failed: '失败', cancelled: '已取消', completed: '已完成', keeping: '正在保留', kept: '已保留为独立工程', discarding: '正在撤销', discarded: '候选已撤销', compiling: '正在编译', compiled: '编译通过', compile_failed: '编译失败', unknown_outcome: '结果待核对', not_ready: '尚未就绪' })[value] || value || '未知';
