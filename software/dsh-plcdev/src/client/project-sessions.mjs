// Views only: the source of associations and task state remains the services.
export function validateProjectConversations(value, projectId) {
  const seen = new Set();
  if (!value || value.projectId !== projectId || !Array.isArray(value.current) || !Array.isArray(value.historical) || !Array.isArray(value.unavailable) || typeof value.countsComplete !== 'boolean') throw new Error('工程会话归属无法确认。');
  for (const [kind,rows] of [['current',value.current],['historical',value.historical]]) for (const row of rows) {
    if (!row || typeof row.conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.conversationId) || seen.has(row.conversationId) || !Array.isArray(row.taskIds) || new Set(row.taskIds).size !== row.taskIds.length || row.taskIds.some(id => !/^task-[0-9a-f]{32}$/.test(id)) || (kind === 'current') !== (row.currentProjectId === projectId)) throw new Error('工程会话归属不一致。');
    seen.add(row.conversationId);
  }
  for (const row of value.unavailable) {
    if (!row || typeof row.conversationId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.conversationId) || seen.has(row.conversationId)) throw new Error('工程会话身份无法确认。');
    seen.add(row.conversationId);
  }
  if (value.countsComplete && value.unavailable.length) throw new Error('工程会话数量未完全确认。');
  return value;
}
// Collapse only complete, unbranched explicit parent chains inside one session.
export function revisionGroups(taskIds, tasks, projectId) {
  const allowed = new Set(taskIds), rows = tasks.filter(t => t?.projectId === projectId && allowed.has(t.taskId));
  const byId = new Map(rows.map(t => [t.taskId,t]));
  const linkedParent = task => {
    const parent=byId.get(task.parentTaskId);
    return parent && /^[0-9a-f]{64}$/.test(task.parentCandidateDigest || '') && task.parentCandidateDigest === parent.candidate?.candidateDigest && typeof task.projectRevision === 'string' && task.projectRevision && task.projectRevision === parent.projectRevision ? parent : null;
  };
  const children = new Map();
  for (const task of rows) if (linkedParent(task)) {
    const list = children.get(task.parentTaskId) || []; list.push(task.taskId); children.set(task.parentTaskId,list);
  }
  const assigned = new Set(), groups=[];
  for (const task of rows) {
    if (assigned.has(task.taskId) || linkedParent(task)) continue;
    const chain=[], visiting=new Set(); let current=task, ambiguous=false;
    while (current) {
      if (visiting.has(current.taskId) || (children.get(current.taskId)||[]).length > 1) { ambiguous=true; break; }
      visiting.add(current.taskId); chain.push(current); current=byId.get((children.get(current.taskId)||[])[0]);
    }
    if (!ambiguous) {chain.forEach(t=>assigned.add(t.taskId));groups.push(chain);}
  }
  // Incomplete/branched/cyclic evidence is never merged or dropped.
  for (const task of rows) if (!assigned.has(task.taskId)) groups.push([task]);
  return groups;
}
export function hostSessionTitle(catalog, id) {
  if (!catalog || !Array.isArray(catalog.ids) || !catalog.ids.includes(id)) return null;
  const row=catalog.byId?.[id];
  if (!row || row.origin==='subagent') return null;
  return typeof row.title==='string' && row.title.trim() ? row.title.trim() : null;
}
