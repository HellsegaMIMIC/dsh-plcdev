import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {matchesHmiPlan} from './hmi-intent.mjs';
import {validKeepReceiptRequest} from './review-receipt.mjs';
import {validProjectEditSubmission} from './project-edit-contract.mjs';

const CID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const PID = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
// PID reuse, EPERM and every other uncertain OS result fail closed. A missing
// process table entry is not evidence: only the kernel's explicit ESRCH is.
function senderState(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)return 'legacy_unknown';
  try{process.kill(pid,0);return 'active_or_unknown';}
  catch(error){return error?.code==='ESRCH'?'owner_exited':'active_or_unknown';}
}
class ContextError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const reject = (status, code, message) => { throw new ContextError(status, code, message); };
function fields(body, names, optional = []) {
  if (!record(body) || Object.keys(body).some(key => !names.includes(key) && !optional.includes(key)) || names.some(key => !Object.hasOwn(body, key)))
    reject(400, 'invalid_request', '会话请求字段无效。');
}
function conversation(value) {
  if (typeof value !== 'string' || !CID.test(value)) reject(400, 'invalid_conversation', '缺少有效的 DSH 会话身份。');
  return value;
}
function bindingInput(body) {
  conversation(body.conversationId);
  if (!(body.projectId === null || (typeof body.projectId === 'string' && PID.test(body.projectId))) ||
      !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
    reject(400, 'invalid_binding', '工程绑定或绑定版本无效。');
}

/** Persist only DSH bindings, task references and an idempotent submission outbox.
 * TaskService remains authoritative for task status, candidate bytes and evidence.
 * No model call, tool launch or Runtime command is exposed here.
 */
export function createConversationRoutes({ controllerFile, bridge, visibleSessions }) {
  const file = join(dirname(controllerFile), 'dsh-context.sqlite');
  function open() {
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings (
        conversation_id TEXT PRIMARY KEY, project_id TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        project_id TEXT NOT NULL, binding_version INTEGER NOT NULL, upstream_id TEXT NOT NULL,
        payload TEXT, state TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS team_references (
        conversation_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(conversation_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS submission_identity_conflicts (
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, project_id TEXT NOT NULL,
        accepted_task_id TEXT NOT NULL, observed_task_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, request_id, observed_task_id)
      );
      CREATE TABLE IF NOT EXISTS submission_inflight (
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL, PRIMARY KEY(conversation_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS submission_receipt_inflight (
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL, PRIMARY KEY(conversation_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS submission_receipt_evidence_conflicts (
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, project_id TEXT NOT NULL,
        accepted_task_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(conversation_id, request_id)
      );`);
    db.exec(`CREATE TABLE IF NOT EXISTS revision_intents (
      conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, turn_key TEXT, state TEXT NOT NULL
    );
      CREATE TABLE IF NOT EXISTS participation_locks (
        conversation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL
      );`);
    return db;
  }
  function withDb(fn) { const db = open(); try { return fn(db); } finally { db.close(); } }
  function transaction(fn) { return withDb(db => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(db); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }); }
  function hasUnresolvedRevisionEvidence(db,id) {
    return !!db.prepare(`SELECT 1 FROM submission_inflight WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submissions WHERE conversation_id=? AND state IN ('pending','unknown') LIMIT 1`).get(id,id,id,id,id);
  }
  function readBinding(db, id) {
    const row = db.prepare('SELECT * FROM bindings WHERE conversation_id=?').get(id);
    return { conversationId: id, projectId: row?.project_id ?? null, version: row?.version ?? 0 };
  }
  // A selected project enables PLCdev. Once engineering work has started the
  // session keeps that identity, including after a historical unbind or reload.
  // Read existing ledgers as well so pre-switch sessions need no lossy migration.
  function readParticipation(db, id, binding = readBinding(db, id)) {
    const locked = !!db.prepare(`SELECT 1 FROM participation_locks WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submissions WHERE conversation_id=?
      UNION ALL SELECT 1 FROM team_references WHERE conversation_id=?
      UNION ALL SELECT 1 FROM revision_intents WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_inflight WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=?
      UNION ALL SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? LIMIT 1`)
      .get(id,id,id,id,id,id,id,id);
    return { enabled: !!binding.projectId || locked, locked };
  }
  function snapshot(id) { return withDb(db => {
    const rows = db.prepare('SELECT * FROM submissions WHERE conversation_id=? ORDER BY created_at, request_id').all(id);
    const revision=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(id);
    const deliveries=db.prepare(`SELECT f.request_id,f.attempt_id,f.owner_pid,s.project_id,s.state AS submission_state,'sender' AS kind,NULL AS evidence_task_id
      FROM submission_inflight f LEFT JOIN submissions s ON s.conversation_id=f.conversation_id AND s.request_id=f.request_id WHERE f.conversation_id=?
      UNION ALL SELECT f.request_id,f.attempt_id,f.owner_pid,s.project_id,s.state AS submission_state,'receipt' AS kind,NULL AS evidence_task_id
      FROM submission_receipt_inflight f LEFT JOIN submissions s ON s.conversation_id=f.conversation_id AND s.request_id=f.request_id WHERE f.conversation_id=?
      UNION ALL SELECT c.request_id,NULL AS attempt_id,NULL AS owner_pid,s.project_id,s.state AS submission_state,'evidence' AS kind,c.accepted_task_id AS evidence_task_id
      FROM submission_receipt_evidence_conflicts c LEFT JOIN submissions s ON s.conversation_id=c.conversation_id AND s.request_id=c.request_id AND s.project_id=c.project_id AND s.task_id=c.accepted_task_id AND s.state='accepted' WHERE c.conversation_id=?
      UNION ALL SELECT s.request_id,NULL AS attempt_id,NULL AS owner_pid,s.project_id,s.state AS submission_state,'legacy' AS kind,NULL AS evidence_task_id FROM submissions s
      WHERE s.conversation_id=? AND s.state='pending' AND NOT EXISTS(SELECT 1 FROM submission_inflight f WHERE f.conversation_id=s.conversation_id AND f.request_id=s.request_id)
      ORDER BY request_id LIMIT 129`).all(id,id,id,id);
    if(deliveries.length>128)reject(503,'submission_inflight_overflow','在途请求过多，无法完整显示；请保留原记录人工核对。');
    const byRequest=new Map(),rank={owner_exited:0,active_or_unknown:1,legacy_unknown:2,evidence_conflict:3};
    for(const d of deliveries){
      if(!PID.test(d.project_id||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(d.request_id||'')||!['pending','unknown','accepted','rejected'].includes(d.submission_state)||
         (d.kind==='evidence'&&!/^task-[0-9a-f]{32}$/.test(d.evidence_task_id||''))||
         (d.attempt_id!==null&&(typeof d.attempt_id!=='string'||!d.attempt_id||!Number.isSafeInteger(d.owner_pid)||d.owner_pid<0)))
        reject(503,'submission_inflight_corrupt','在途请求记录无法核对；请保留原记录。');
      const state=d.kind==='evidence'?'evidence_conflict':senderState(d.owner_pid),old=byRequest.get(d.request_id);
      if(old&&old.projectId!==d.project_id)reject(503,'submission_inflight_corrupt','在途请求归属不一致；请保留原记录。');
      if(!old)byRequest.set(d.request_id,{projectId:d.project_id,clientRequestId:d.request_id,state});
      else if(rank[state]>rank[old.state])old.state=state;
      if(byRequest.size>32)reject(503,'submission_inflight_overflow','在途请求过多，无法完整显示；请保留原记录人工核对。');
    }
    const submissionInFlight=[...byRequest.values()];
    // Retain every observed conflicting identity in SQLite. Bound the public
    // snapshot without silently truncating evidence; overflow fails closed.
    const conflicts=db.prepare(`SELECT c.*,s.project_id AS original_project_id,s.task_id AS current_task_id,s.state AS submission_state
      FROM submission_identity_conflicts c LEFT JOIN submissions s ON s.conversation_id=c.conversation_id AND s.request_id=c.request_id
      WHERE c.conversation_id=? ORDER BY c.request_id,c.observed_task_id LIMIT 513`).all(id);
    if(conflicts.length>512)reject(503,'submission_conflicts_overflow','任务身份冲突过多，无法完整显示；请保留原记录人工核对。');
    const grouped=new Map();
    for(const c of conflicts){
      if(c.submission_state!=='accepted'||c.project_id!==c.original_project_id||c.accepted_task_id!==c.current_task_id||!PID.test(c.project_id||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(c.request_id||'')||!/^task-[0-9a-f]{32}$/.test(c.accepted_task_id||'')||!/^task-[0-9a-f]{32}$/.test(c.observed_task_id||'')||c.accepted_task_id===c.observed_task_id)reject(503,'submission_conflict_corrupt','任务身份冲突记录无法核对；请保留原记录。');
      if(!grouped.has(c.request_id))grouped.set(c.request_id,{projectId:c.project_id,clientRequestId:c.request_id,acceptedTaskId:c.accepted_task_id,observedTaskIds:[]});
      const item=grouped.get(c.request_id);
      if(item.projectId!==c.project_id||item.acceptedTaskId!==c.accepted_task_id)reject(503,'submission_conflict_corrupt','任务身份冲突记录不一致；请保留原记录。');
      item.observedTaskIds.push(c.observed_task_id);
      if(item.observedTaskIds.length>16||grouped.size>32)reject(503,'submission_conflicts_overflow','任务身份冲突过多，无法完整显示；请保留原记录人工核对。');
    }
    return { ok: true, ...readBinding(db, id), participation:readParticipation(db,id), ...(revision?{revisionContext:{...JSON.parse(revision.payload),state:revision.state}}:{}),
      submissionConflicts:[...grouped.values()],submissionInFlight,
      taskRefs: [...rows.filter(r => r.state === 'accepted').map(r => ({ projectId: r.project_id, taskId: r.task_id, clientRequestId: r.request_id, createdAt: r.created_at })),
        ...db.prepare('SELECT * FROM team_references WHERE conversation_id=? ORDER BY created_at').all(id).map(r => ({ projectId: r.project_id, taskId: r.task_id, clientRequestId: 'team-' + r.task_id, createdAt: r.created_at }))],
      pendingRequests: rows.filter(r => ['pending', 'unknown'].includes(r.state)).map(r => ({
        ...JSON.parse(r.payload), conversationId: id, expectedVersion: r.binding_version,
        clientRequestId: r.request_id, state: 'unknown', createdAt: r.created_at,
      })),
    };
  }); }
  async function knownProject(id) {
    if (id === null) return;
    const probe = await bridge.handle('GET', '/api/plcdev/status?project=' + encodeURIComponent(id));
    if (probe.status !== 200) reject(probe.status, probe.body.code ?? 'project_unavailable', probe.body.error ?? '工程状态无法核对。');
    if (probe.body.project?.id !== id || !probe.body.projects?.some(p => p.id === id))
      reject(409, 'project_mismatch', '工程不在当前工作区中。');
  }
  // The plugin owns associations, not the host's session catalog.  A missing
  // catalog must not silently turn an incomplete count into a confirmed zero.
  async function projectConversations(id) {
    if (!PID.test(id ?? '')) reject(400, 'invalid_project', '工程身份无效。');
    await knownProject(id);
    if (typeof visibleSessions !== 'function') reject(503, 'session_catalog_unavailable', '宿主会话目录不可用，无法确认关联会话。');
    let catalog;
    try { catalog = await visibleSessions(); }
    catch { reject(503, 'session_catalog_unavailable', '宿主会话目录读取失败，无法确认关联会话。'); }
    if (!Array.isArray(catalog)) reject(503, 'session_catalog_unavailable', '宿主会话目录无效，无法确认关联会话。');
    const host = new Map();
    for (const row of catalog) {
      if (!record(row) || typeof row.id !== 'string' || !CID.test(row.id) || !['main', 'child'].includes(row.kind) || host.has(row.id))
        reject(503, 'session_catalog_unavailable', '宿主会话身份无法核实。');
      host.set(row.id, row.kind);
    }
    const associations = withDb(db => {
      const all = new Map();
      const get = id => { if (!all.has(id)) all.set(id, { conversationId: id, currentProjectId: null, taskIds: [] }); return all.get(id); };
      for (const row of db.prepare('SELECT conversation_id, project_id FROM bindings WHERE project_id=?').all(id))
        get(row.conversation_id).currentProjectId = row.project_id;
      const refs = db.prepare(`SELECT conversation_id, task_id FROM submissions WHERE project_id=? AND state='accepted'
        UNION SELECT conversation_id, task_id FROM team_references WHERE project_id=?`).all(id, id);
      for (const row of refs) {
        const item = get(row.conversation_id);
        item.taskIds.push(row.task_id);
      }
      // A former contributor may now be bound to a different project.
      const binding = db.prepare('SELECT project_id FROM bindings WHERE conversation_id=?');
      for (const item of all.values()) item.currentProjectId = binding.get(item.conversationId)?.project_id ?? null;
      return [...all.values()];
    });
    const current = [], historical = [], unavailable = [];
    for (const item of associations) {
      const kind = host.get(item.conversationId);
      if (kind === 'child') continue;
      if (!kind) { unavailable.push({ conversationId: item.conversationId }); continue; }
      item.taskIds.sort();
      (item.currentProjectId === id ? current : historical).push(item);
    }
    const byId = (a, b) => a.conversationId.localeCompare(b.conversationId);
    current.sort(byId); historical.sort(byId); unavailable.sort(byId);
    return { status: 200, body: { ok: true, projectId: id, current, historical, unavailable,
      // Missing host identities cannot safely be classified as main sessions.
      countsComplete: unavailable.length === 0 } };
  }
  async function bind(body) {
    fields(body, ['conversationId', 'projectId', 'expectedVersion']); bindingInput(body);
    await knownProject(body.projectId);
    transaction(db => {
      const old = readBinding(db, body.conversationId);
      if (old.version !== body.expectedVersion) reject(409, 'binding_changed', '会话绑定已变化，请重新读取后明确选择工程。');
      if (body.projectId === null && readParticipation(db,body.conversationId,old).locked)
        reject(409,'participation_locked','此会话已有工程操作，不能关闭 PLCdev。可收起工程面板，或新建普通会话。');
      if (old.projectId === body.projectId) return;
      if(db.prepare('SELECT 1 FROM submission_inflight WHERE conversation_id=? LIMIT 1').get(body.conversationId)||db.prepare('SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=? LIMIT 1').get(body.conversationId)||db.prepare('SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? LIMIT 1').get(body.conversationId)||
         db.prepare("SELECT 1 FROM submissions WHERE conversation_id=? AND state='pending' LIMIT 1").get(body.conversationId))
        reject(409,'submission_in_flight','原请求仍在途或发送者状态无法确认；核对完成前不能切换关联工程。');
      if(db.prepare("SELECT 1 FROM submissions WHERE conversation_id=? AND state IN ('pending','unknown') LIMIT 1").get(body.conversationId))
        reject(409,'submission_unknown','存在待核对请求；确认结果前不能切换关联工程。');
      if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? LIMIT 1').get(body.conversationId))
        reject(409,'submission_identity_conflict','原请求返回多个任务身份；人工核对前不能切换关联工程。');
      db.prepare(`INSERT INTO bindings VALUES(?,?,?,?) ON CONFLICT(conversation_id)
        DO UPDATE SET project_id=excluded.project_id, version=excluded.version, updated_at=excluded.updated_at`)
        .run(body.conversationId, body.projectId, old.version + 1, new Date().toISOString());
    });
    return { status: 200, body: snapshot(body.conversationId) };
  }
  async function submit(body) {
    fields(body, ['conversationId', 'projectId', 'expectedVersion', 'request', 'expectedRevision', 'executionScope', 'clientRequestId', 'sourceBasis'], ['workflow','revisionParent','planSubmission','revisionIntentId']);
    bindingInput(body);
    if (body.projectId === null || typeof body.request !== 'string' || !body.request.trim() || body.request.length > 4000 ||
        !HASH.test(body.expectedRevision ?? '') || body.executionScope !== 'proposal' || body.sourceBasis !== 'saved_revision' ||
        typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId) || (body.workflow !== undefined && !['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(body.workflow)))
      reject(400, 'invalid_task', '任务需要确定的工程、已保存版本与候选范围。');
    if(body.workflow==='project-edit-v1'&&!validProjectEditSubmission(body.planSubmission))reject(400,'invalid_task','工程修改计划格式无效。');
    const hmiIntentValid=!['hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1'].includes(body.workflow)||matchesHmiPlan(body.workflow,body.request,body.planSubmission?.plan);
    if(body.workflow==='hmi-readonly-value-v1'&&body.revisionParent)reject(400,'invalid_revision','新增只读显示暂不支持父候选修订。');
    const payload = { projectId: body.projectId, request: body.request.trim(), expectedRevision: body.expectedRevision,
      executionScope: body.executionScope, sourceBasis: body.sourceBasis, clientRequestId: body.clientRequestId,
      ...(body.planSubmission ? {planSubmission:body.planSubmission} : {}),...(body.workflow ? { workflow: body.workflow } : {}),...(body.revisionParent?{revisionParent:body.revisionParent}:{}) };
    if(body.revisionParent){
      fields(body.revisionParent,['taskId','candidateDigest']);
      if(!/^task-[0-9a-f]{32}$/.test(body.revisionParent.taskId||'')||!HASH.test(body.revisionParent.candidateDigest||'')||typeof body.revisionIntentId!=='string')reject(400,'invalid_revision','修订身份无效。');
    }else if(body.revisionIntentId)reject(400,'invalid_revision','修订身份不完整。');
    const digest = hash(JSON.stringify({ ...payload, expectedVersion: body.expectedVersion,...(body.revisionIntentId?{revisionIntentId:body.revisionIntentId}:{}) }));
    const attemptId=randomUUID();
    const row = transaction(db => {
      const old = db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(body.conversationId, body.clientRequestId);
      if (old) {
        if (old.fingerprint !== digest) reject(409, 'request_conflict', '原请求编号已绑定另一份输入；请核对已有任务，不得改写重放。');
        if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId))reject(503,'submission_identity_conflict','原请求返回多个任务身份；请保留记录并人工核对。');
        if(db.prepare('SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId))reject(503,'submission_receipt_conflict','原任务曾已确认，但后续回执缺失；请保留记录并人工核对。');
        if(db.prepare('SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId))reject(503,'submission_in_flight','原请求的只读核对仍在途或状态未知；未重发，请先核对。');
        const active=db.prepare('SELECT * FROM submission_inflight WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
        if(active){
          if(senderState(active.owner_pid)!=='owner_exited')reject(503,'submission_in_flight','原请求仍在途或发送者状态无法确认；未重发，请先只读核对。');
          db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(body.conversationId,body.clientRequestId,active.attempt_id);
          if(old.state!=='accepted'){db.prepare("UPDATE submissions SET state='unknown' WHERE conversation_id=? AND request_id=?").run(body.conversationId,body.clientRequestId);old.state='unknown';}
        }else if(old.state==='pending'){
          // An old plugin did not record its sender. It may still be running;
          // never interpret a missing marker as proof that it stopped.
          reject(503,'submission_in_flight','旧请求未记录发送者身份；未重发，请保留现场核对。');
        }
        // An already accepted legacy result remains readable. An uncertain
        // legacy mismatch must not be sent again under the tightened contract.
        if(!hmiIntentValid&&old.state!=='accepted')reject(409,'submission_unknown','旧请求的意图未能确认；结果待人工核对，未重发。');
        if(old.state==='rejected'){
          // A definite rejection can be retried, but never into a conversation
          // whose binding or revision context has since changed.
          const binding=readBinding(db,body.conversationId);
          if(binding.projectId!==body.projectId||binding.version!==body.expectedVersion)reject(409,'binding_changed','会话工程或绑定版本已变化，旧输入未提交。');
          if(body.revisionParent){
            const revision=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(body.conversationId),intent=revision&&JSON.parse(revision.payload);
            if(!intent||revision.state!=='submitting'||intent.intentId!==body.revisionIntentId||intent.projectId!==body.projectId||intent.expectedVersion!==body.expectedVersion||intent.expectedRevision!==body.expectedRevision||JSON.stringify(intent.parent)!==JSON.stringify(body.revisionParent)||(intent.workflow??'joint-ai-v1')!==body.workflow)reject(409,'revision_changed','修订上下文已变化，请重新选择。');
          }
          db.prepare("UPDATE submissions SET state='pending' WHERE conversation_id=? AND request_id=?").run(body.conversationId,body.clientRequestId);
          db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(body.conversationId,body.clientRequestId,attemptId,process.pid);
          return {...old,state:'pending',firstAttempt:true,attemptId};
        }
        if(!['unknown','accepted'].includes(old.state))reject(503,'submission_unknown','原请求状态无法确认；请保留编号并核对。');
        if(old.state==='unknown')db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(body.conversationId,body.clientRequestId,attemptId,process.pid);
        return {...old,firstAttempt:false,...(old.state==='unknown'?{attemptId}:{})};
      }
      if(!hmiIntentValid)reject(400,'invalid_task','请使用单条明确指令，例如：把静态文字“原文字”改为“新文字”。');
      const binding = readBinding(db, body.conversationId);
      if (binding.projectId !== body.projectId || binding.version !== body.expectedVersion)
        reject(409, 'binding_changed', '会话工程或绑定版本已变化，旧输入未提交。');
      if(body.revisionParent){
        const row=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(body.conversationId),intent=row&&JSON.parse(row.payload);
        if(!intent||row.state!=='claimed'||intent.intentId!==body.revisionIntentId||intent.projectId!==body.projectId||intent.expectedVersion!==body.expectedVersion||intent.expectedRevision!==body.expectedRevision||JSON.stringify(intent.parent)!==JSON.stringify(body.revisionParent)||(intent.workflow??'joint-ai-v1')!==body.workflow)reject(409,'revision_changed','修订上下文已变化，请重新选择。');
      }
      const upstream = 'dsh2-' + hash(body.conversationId + '\0' + body.clientRequestId);
      const created = new Date().toISOString();
      db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(body.conversationId, body.clientRequestId, digest,
        body.projectId, body.expectedVersion, upstream, JSON.stringify({...payload,...(body.revisionIntentId?{revisionIntentId:body.revisionIntentId}:{})}), 'pending', null, created);
      db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(body.conversationId,body.clientRequestId,attemptId,process.pid);
      if(body.revisionParent)db.prepare("UPDATE revision_intents SET state='submitting' WHERE conversation_id=?").run(body.conversationId);
      return { upstream_id: upstream, state: 'pending', firstAttempt:true, attemptId };
    });
    if (row.state === 'accepted') {
      const listing = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(body.projectId));
      if (listing.status !== 200) return listing;
      const task = listing.body.tasks.find(t => t.taskId === row.task_id && t.projectId === body.projectId);
      if (!task) reject(409, 'task_reference_missing', '会话引用的任务暂不可用，未创建替代任务。');
      withDb(db=>{
        const current=db.prepare('SELECT state,task_id FROM submissions WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
        if(!current||current.state!=='accepted'||current.task_id!==row.task_id||db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId)||db.prepare('SELECT 1 FROM submission_inflight WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId))reject(503,'submission_unknown','原请求状态已变化；请重新核对。');
      });
      return { status: 200, body: { ok: true, conversationId: body.conversationId, task, duplicate: true } };
    }
    let result;
    try {
      result = await bridge.handle('POST', '/api/plcdev/tasks', { ...payload, clientRequestId: row.upstream_id });
    } catch {
      result = { status: 503, body: { code: 'submission_unknown', error: '任务投递结果未确认；重新读取会话并使用原请求编号核对。' } };
    }
    if(!record(result)||!Number.isInteger(result.status)||result.status<200||result.status>=600||!record(result.body))
      result={status:503,body:{code:'submission_unknown',error:'任务结果格式无法确认；请保留原请求编号并核对。'}};
    if (result.status >= 200 && result.status < 300) {
      if (result.body.task?.projectId !== body.projectId || !/^task-[a-f0-9]{32}$/.test(result.body.task?.taskId ?? ''))
        result = { status: 503, body: { code: 'task_project_mismatch', error: '任务归属无法确认，未挂到当前会话。' } };
      else {
        const recorded=transaction(db => {
          const current=db.prepare('SELECT state,task_id FROM submissions WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
          if(!current)reject(503,'submission_unknown','原请求记录不可用，请保留编号并核对。');
          const active=db.prepare('SELECT attempt_id FROM submission_inflight WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
          if(!active||active.attempt_id!==row.attemptId)reject(503,'submission_unknown','原请求发送身份已变化，请保留编号并核对。');
          // The first accepted identity is evidence. A conflicting later
          // success cannot silently replace it or be reported as accepted.
          if(current.state==='accepted'&&current.task_id!==result.body.task.taskId){
            db.prepare('INSERT OR IGNORE INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)').run(body.conversationId,body.clientRequestId,body.projectId,current.task_id,result.body.task.taskId,new Date().toISOString());
            db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(body.conversationId,body.clientRequestId,row.attemptId);
            return false;
          }
          if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId)){db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(body.conversationId,body.clientRequestId,row.attemptId);return false;}
          db.prepare(`UPDATE submissions SET state='accepted', task_id=?, payload=NULL WHERE conversation_id=? AND request_id=?`).run(result.body.task.taskId, body.conversationId, body.clientRequestId);
          if(body.revisionIntentId){const r=db.prepare('SELECT payload FROM revision_intents WHERE conversation_id=?').get(body.conversationId);if(r&&JSON.parse(r.payload).intentId===body.revisionIntentId)db.prepare("UPDATE revision_intents SET state='submitted' WHERE conversation_id=?").run(body.conversationId);}
          db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(body.conversationId,body.clientRequestId,row.attemptId);
          return true;
        });
        if(!recorded)return {status:503,body:{ok:false,code:'submission_identity_conflict',error:'同一请求返回了不同任务；保留已记录身份，请人工核对。',conversationId:body.conversationId}};
        return { status: result.status, body: { ...result.body, conversationId: body.conversationId } };
      }
    }
    const rejected=Number.isInteger(result.status)&&result.status>=400&&result.status<500&&result.status!==408&&result.body?.code!=='task_project_mismatch';
    const finalState=transaction(db=>{
      const current=db.prepare('SELECT state FROM submissions WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
      if(!current)reject(503,'submission_unknown','原请求记录不可用，请保留编号并核对。');
      const active=db.prepare('SELECT attempt_id FROM submission_inflight WHERE conversation_id=? AND request_id=?').get(body.conversationId,body.clientRequestId);
      if(!active||active.attempt_id!==row.attemptId)reject(503,'submission_unknown','原请求发送身份已变化，请保留编号并核对。');
      db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(body.conversationId,body.clientRequestId,row.attemptId);
      if(current.state==='accepted')return 'accepted';
      const reading=db.prepare('SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? LIMIT 1').get(body.conversationId,body.clientRequestId);
      const state=rejected&&row.firstAttempt&&current.state==='pending'&&!reading?'rejected':'unknown';
      db.prepare('UPDATE submissions SET state=? WHERE conversation_id=? AND request_id=?').run(state,body.conversationId,body.clientRequestId);
      return state;
    });
    if(rejected&&finalState!=='rejected')return {status:503,body:{ok:false,code:'submission_unknown',error:'原请求可能已投递，请保留编号并核对结果。',conversationId:body.conversationId}};
    return { status: result.status, body: { ...result.body, conversationId: body.conversationId } };
  }
  async function checkReceipt(body) {
    fields(body,['conversationId','clientRequestId']);
    const id=conversation(body.conversationId);
    if(typeof body.clientRequestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId))reject(400,'invalid_request','请求编号无效。');
    const row=withDb(db=>{
      if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId))reject(503,'submission_identity_conflict','原请求返回多个任务身份；请保留记录并人工核对。');
      return db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
    });
    if(!row)reject(404,'not_found','当前会话没有该请求。');
    const existingCheck=withDb(db=>db.prepare('SELECT * FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId));
    const existingEvidence=withDb(db=>db.prepare('SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId));
    if(row.state==='accepted'&&!existingCheck&&!existingEvidence){
      transaction(db=>{
        const current=db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
        if(!current||current.state!=='accepted'||current.project_id!==row.project_id||current.upstream_id!==row.upstream_id||current.fingerprint!==row.fingerprint||current.task_id!==row.task_id)reject(503,'submission_unknown','原请求状态已变化；请重新核对。');
        if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId))reject(503,'submission_identity_conflict','原请求返回多个任务身份；请保留记录并人工核对。');
        if(db.prepare('SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId))reject(503,'submission_receipt_conflict','原任务曾已确认，但后续回执缺失；请保留记录并人工核对。');
        if(db.prepare('SELECT 1 FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId))reject(503,'submission_in_flight','原回执核对仍在途，请等待完成。');
        const active=db.prepare('SELECT * FROM submission_inflight WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
        if(active&&senderState(active.owner_pid)==='owner_exited')db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,active.attempt_id);
      });
      return {status:200,body:{ok:true,found:true,conversationId:id,projectId:row.project_id,taskId:row.task_id}};
    }
    const receiptAttempt=randomUUID();
    const acquired=transaction(db=>{
      const current=db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
      if(!current||current.project_id!==row.project_id||current.upstream_id!==row.upstream_id||current.fingerprint!==row.fingerprint)reject(409,'request_changed','请求身份已变化，请重新读取。');
      if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId))reject(503,'submission_identity_conflict','原请求返回多个任务身份；请保留记录并人工核对。');
      const prior=db.prepare('SELECT * FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
      const evidence=db.prepare('SELECT 1 FROM submission_receipt_evidence_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId);
      if(prior){
        if(senderState(prior.owner_pid)!=='owner_exited')reject(503,'submission_in_flight','原回执核对仍在途或发送者状态未知，请等待。');
        db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,prior.attempt_id);
        if(current.state==='rejected')db.prepare("UPDATE submissions SET state='unknown' WHERE conversation_id=? AND request_id=?").run(id,body.clientRequestId);
      }else if(current.state==='accepted'&&!evidence){return {acceptedTaskId:current.task_id};}
      else if(!['pending','unknown'].includes(current.state)&&!(current.state==='accepted'&&evidence))reject(409,'not_pending','该请求不处于待核对状态。');
      db.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)').run(id,body.clientRequestId,receiptAttempt,process.pid);
      return {startedAccepted:current.state==='accepted'};
    });
    if(acquired.acceptedTaskId)return {status:200,body:{ok:true,found:true,conversationId:id,projectId:row.project_id,taskId:acquired.acceptedTaskId}};
    const releaseCheck=()=>transaction(db=>db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,receiptAttempt));
    let receipt;
    try{receipt=await bridge.taskReceipt(row.project_id,row.upstream_id);}
    catch{releaseCheck();reject(503,'receipt_unavailable','任务回执暂不可核对；保留原请求，未重发。');}
    if(receipt?.ok!==true||receipt.projectId!==row.project_id||receipt.clientRequestId!==row.upstream_id||!(receipt.task===null||(record(receipt.task)&&receipt.task.projectId===row.project_id&&/^task-[0-9a-f]{32}$/.test(receipt.task.taskId??'')))){releaseCheck();reject(503,'receipt_mismatch','任务回执归属未确认；未重发。');}
    const outcome=transaction(db=>{
      const check=db.prepare('SELECT attempt_id FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
      if(!check||check.attempt_id!==receiptAttempt)reject(503,'submission_unknown','原回执核对身份已变化，请保留记录。');
      const current=db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
      if(!current||current.project_id!==row.project_id||current.upstream_id!==row.upstream_id||current.fingerprint!==row.fingerprint)reject(409,'request_changed','请求身份已变化，请重新读取。');
      if(db.prepare('SELECT 1 FROM submission_identity_conflicts WHERE conversation_id=? AND request_id=? LIMIT 1').get(id,body.clientRequestId)){
        db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,receiptAttempt);return {conflict:true};
      }
      const task=receipt.task,active=db.prepare('SELECT * FROM submission_inflight WHERE conversation_id=? AND request_id=?').get(id,body.clientRequestId);
      if(!task&&current.state==='accepted'&&acquired.startedAccepted){
        db.prepare('INSERT OR IGNORE INTO submission_receipt_evidence_conflicts VALUES(?,?,?,?,?)').run(id,body.clientRequestId,row.project_id,current.task_id,new Date().toISOString());
        db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,receiptAttempt);return {receiptConflict:true};
      }
      if(task&&current.state==='accepted'&&current.task_id!==task.taskId){
        db.prepare('INSERT OR IGNORE INTO submission_identity_conflicts VALUES(?,?,?,?,?,?)').run(id,body.clientRequestId,row.project_id,current.task_id,task.taskId,new Date().toISOString());
        db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,receiptAttempt);return {conflict:true};
      }
      if(task&&current.state!=='accepted'){
        if(!['pending','unknown','rejected'].includes(current.state))reject(409,'request_changed','请求状态已变化，请重新读取。');
        const saved=current.payload?JSON.parse(current.payload):null;
        if(!active&&current.state==='pending')db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(id,body.clientRequestId,'legacy-unknown',0);
        db.prepare("UPDATE submissions SET state='accepted',task_id=?,payload=NULL WHERE conversation_id=? AND request_id=?").run(task.taskId,id,body.clientRequestId);
        if(saved?.revisionIntentId){const revision=db.prepare('SELECT payload FROM revision_intents WHERE conversation_id=?').get(id);if(revision&&JSON.parse(revision.payload).intentId===saved.revisionIntentId)db.prepare("UPDATE revision_intents SET state='submitted' WHERE conversation_id=?").run(id);}
      }
      if(active&&senderState(active.owner_pid)==='owner_exited'){
        db.prepare('DELETE FROM submission_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,active.attempt_id);
        if(!task&&current.state==='pending')db.prepare("UPDATE submissions SET state='unknown' WHERE conversation_id=? AND request_id=?").run(id,body.clientRequestId);
      }
      if(!task&&current.state==='rejected')db.prepare("UPDATE submissions SET state='unknown' WHERE conversation_id=? AND request_id=?").run(id,body.clientRequestId);
      db.prepare('DELETE FROM submission_receipt_inflight WHERE conversation_id=? AND request_id=? AND attempt_id=?').run(id,body.clientRequestId,receiptAttempt);
      return {taskId:task?.taskId||(current.state==='accepted'?current.task_id:null)};
    });
    if(outcome.conflict)reject(503,'submission_identity_conflict','原请求返回多个任务身份；请保留记录并人工核对。');
    if(outcome.receiptConflict)reject(503,'submission_receipt_conflict','原任务曾已确认，但后续回执缺失；请保留记录并人工核对。');
    return {status:200,body:{ok:true,found:!!outcome.taskId,conversationId:id,projectId:row.project_id,...(outcome.taskId?{taskId:outcome.taskId}:{})}};
  }
  return {
    snapshot,
    participation(id) { conversation(id); return withDb(db => readParticipation(db,id)); },
    // Called only after authenticated native tool/bridge admission, before its
    // effects. Binding CAS and lock insertion are one transaction: an off click
    // racing the first tool either wins safely or is refused without losing work.
    lockParticipation(id, expected) {
      conversation(id);
      return transaction(db => {
        const binding=readBinding(db,id);
        if (!binding.projectId) reject(409,'participation_disabled','此会话尚未开启 PLCdev，请先选择工程。');
        if (!expected || binding.projectId!==expected.projectId || binding.version!==expected.version)
          reject(409,'binding_changed','会话工程已变化，旧工具调用未执行。');
        db.prepare('INSERT OR IGNORE INTO participation_locks VALUES(?,?,?)').run(id,binding.projectId,new Date().toISOString());
        return readParticipation(db,id,binding);
      });
    },
    claimRevision(id,turnKey){return transaction(db=>{
      const row=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(id);if(!row)return null;
      const intent=JSON.parse(row.payload),binding=readBinding(db,id);
      if(row.state==='submitted')return null;
      if(row.state==='submitting')reject(409,'revision_pending','修订任务投递结果待核对，请使用原请求编号恢复。');
      if(intent.projectId!==binding.projectId||intent.expectedVersion!==binding.version)reject(409,'revision_changed','修订工程已变化，请取消修订后重新选择。');
      if(row.turn_key&&row.turn_key!==turnKey)reject(409,'revision_claimed','上次修订结果尚待核对；请先取消修订或检查历史更改。');
      db.prepare("UPDATE revision_intents SET turn_key=?,state='claimed' WHERE conversation_id=?").run(turnKey,id);return intent;
    });},
    // Trusted lifecycle cleanup only. Submission changes claimed -> submitting in
    // the same transaction as the outbox insert, so an uncertain write is never rearmed.
    releaseRevision(id,turnKey){return transaction(db=>{
      return db.prepare("UPDATE revision_intents SET turn_key=NULL,state='armed' WHERE conversation_id=? AND turn_key=? AND state='claimed'")
        .run(id,turnKey).changes===1;
    });},
    // Callable only from trusted native Teams integration, never from HTTP/model input.
    referenceTeam(id, task) {
      conversation(id);
      if (!['team-analysis-v1','team-generation-v1'].includes(task?.workflow) || !PID.test(task.projectId ?? '') || !/^task-[0-9a-f]{32}$/.test(task.taskId ?? '')) throw new Error('团队任务引用无效。');
      transaction(db => {
        const old = db.prepare('SELECT project_id FROM team_references WHERE conversation_id=? AND task_id=?').get(id, task.taskId);
        if (old && old.project_id !== task.projectId) throw new Error('团队任务工程归属已变化。');
        db.prepare('INSERT OR IGNORE INTO team_references VALUES(?,?,?,?)').run(id, task.taskId, task.projectId, new Date().toISOString());
      });
    },
    async handle(method, rawPath, input) {
      try {
        const url = new URL(rawPath, 'http://127.0.0.1');
        if (method === 'GET' && url.pathname === '/api/plcdev/conversations/project') {
          if (url.hash || [...url.searchParams.keys()].some(k => k !== 'projectId') || url.searchParams.getAll('projectId').length !== 1)
            reject(400, 'invalid_request', '读取工程会话需要唯一的工程身份。');
          return await projectConversations(url.searchParams.get('projectId'));
        }
        if (method === 'GET' && url.pathname === '/api/plcdev/conversations') {
          if ([...url.searchParams.keys()].some(k => k !== 'conversationId') || url.searchParams.getAll('conversationId').length !== 1)
            reject(400, 'invalid_request', '读取会话需要唯一的会话身份。');
          return { status: 200, body: snapshot(conversation(url.searchParams.get('conversationId'))) };
        }
        if (method !== 'POST' || url.search || url.hash) reject(404, 'not_found', '未知的会话接口。');
        const body = JSON.parse(JSON.stringify(input ?? null));
        if (url.pathname === '/api/plcdev/conversations/bind') return await bind(body);
        if (url.pathname === '/api/plcdev/conversations/tasks') return await submit(body);
        if (url.pathname === '/api/plcdev/conversations/receipt') return await checkReceipt(body);
        if (url.pathname === '/api/plcdev/conversations/review-receipt') {
          fields(body,['conversationId','projectId','taskId','candidateDigest','expectedRevision','action','clientRequestId']);
          const state=snapshot(conversation(body.conversationId));
          const {conversationId,...request}=body;
          if(!validKeepReceiptRequest(request))reject(400,'invalid_request','保留回执请求身份无效。');
          if(!state.taskRefs.some(ref=>ref.projectId===request.projectId&&ref.taskId===request.taskId))
            reject(403,'task_not_in_conversation','此候选不属于当前对话，未查询保留回执。');
          try { return {status:200,body:await bridge.reviewReceipt(request)}; }
          catch { reject(503,'receipt_unavailable','保留回执暂不可核对；保留原请求编号，不会重发。'); }
        }
        if(url.pathname==='/api/plcdev/conversations/revision'){
          fields(body,['conversationId','projectId','taskId','candidateDigest','expectedRevision','expectedVersion','intentId']);bindingInput(body);
          if(typeof body.intentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.intentId))reject(400,'invalid_revision','修订编号无效。');
          const current=snapshot(body.conversationId);
          if(!current.taskRefs.some(t=>t.projectId===body.projectId&&t.taskId===body.taskId))reject(403,'task_not_in_conversation','此候选不属于当前对话。');
          const listing=await bridge.handle('GET','/api/plcdev/tasks?project='+encodeURIComponent(body.projectId));
          const task=listing.status===200&&listing.body.tasks?.find(t=>t.taskId===body.taskId&&t.projectId===body.projectId);
          if(!task||task.candidate?.revisionSupported!==true||!['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','project-edit-v1'].includes(task.workflow)||task.status!=='awaiting_review'||task.supersededBy||task.candidate?.candidateDigest!==body.candidateDigest||task.projectRevision!==body.expectedRevision||listing.body.projectRevision!==body.expectedRevision)reject(409,'revision_unavailable','候选已保留、被替代或版本变化，不能继续修改。');
          const previousSummary=Object.fromEntries(['before','after'].filter(k=>typeof task.candidate.summary?.[k]==='string').map(k=>[k,task.candidate.summary[k].slice(0,1000)]));
          const isHmi=['hmi-view-name-v1','hmi-static-text-v1'].includes(task.workflow),target=task.candidate.target;
          if(isHmi&&(!record(target)||typeof target.viewId!=='string'||!target.viewId||typeof previousSummary.before!=='string'||typeof previousSummary.after!=='string'||(task.workflow==='hmi-static-text-v1'&&(typeof target.elementId!=='string'||!/^PLCD_[A-Za-z0-9_-]{1,100}$/.test(target.elementId)))))reject(409,'revision_unavailable','旧候选缺少可核对的画面或文字身份，不能继续修改。');
          const intent={intentId:body.intentId,projectId:body.projectId,expectedVersion:body.expectedVersion,expectedRevision:body.expectedRevision,parent:{taskId:body.taskId,candidateDigest:body.candidateDigest},previousRequest:task.request.slice(0,4000),previousSummary,...(task.workflow==='project-edit-v1'?{workflow:task.workflow}:{}),...(isHmi?{workflow:task.workflow,target:task.workflow==='hmi-static-text-v1'?{viewId:target.viewId,elementId:target.elementId}:{viewId:target.viewId}}:{})};
          transaction(db=>{const b=readBinding(db,body.conversationId);if(b.projectId!==body.projectId||b.version!==body.expectedVersion)reject(409,'binding_changed','请先明确切回候选所属工程。');
            const old=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(body.conversationId);
            if(old){const p=JSON.parse(old.payload);if(p.intentId===body.intentId){if(JSON.stringify(p)!==JSON.stringify(intent))reject(409,'revision_changed','同一修订编号的内容已变化。');return;}if(old.state!=='submitted')reject(409,'revision_busy','请先取消已有修订上下文。');}
            if(hasUnresolvedRevisionEvidence(db,body.conversationId))reject(409,'revision_pending','会话存在在途或未核对的提交证据；请先核对原请求，再选择新的修订。');
            db.prepare("INSERT INTO revision_intents VALUES(?,?,NULL,'armed') ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload,turn_key=NULL,state='armed'").run(body.conversationId,JSON.stringify(intent));});
          return {status:200,body:snapshot(body.conversationId)};
        }
        if(url.pathname==='/api/plcdev/conversations/revision/cancel'){
          fields(body,['conversationId','intentId']);conversation(body.conversationId);
          transaction(db=>{const r=db.prepare('SELECT payload,state FROM revision_intents WHERE conversation_id=?').get(body.conversationId);if(r&&JSON.parse(r.payload).intentId!==body.intentId)reject(409,'revision_changed','修订上下文已变化。');
            // Accepted submissions clear their original payload, so an older
            // active marker may not retain its revision intent identity. Do
            // not guess: keep the context until all same-session delivery and
            // receipt evidence is settled, including persistent conflicts.
            if(r&&hasUnresolvedRevisionEvidence(db,body.conversationId))
              reject(409,'revision_pending','会话存在在途或未核对的提交证据；请先核对原请求，不能取消修订上下文。');
            if(r?.state==='submitting'){
              const rows=db.prepare("SELECT payload,state FROM submissions WHERE conversation_id=? AND state IN ('pending','unknown','rejected')").all(body.conversationId);
              const related=rows.filter(row=>JSON.parse(row.payload||'null')?.revisionIntentId===body.intentId);
              if(!related.length||related.some(row=>row.state!=='rejected'))reject(409,'revision_pending','修订请求已投递或结果未知，请先核对原请求；不能取消已投递的操作。');
            }
            // Cancel removes only the armed continuation, never the fact that
            // this chat already participated in engineering work.
            if(r){const projectId=JSON.parse(r.payload).projectId;if(PID.test(projectId??''))db.prepare('INSERT OR IGNORE INTO participation_locks VALUES(?,?,?)').run(body.conversationId,projectId,new Date().toISOString());}
            db.prepare('DELETE FROM revision_intents WHERE conversation_id=?').run(body.conversationId);});return {status:200,body:snapshot(body.conversationId)};
        }
        if (url.pathname === '/api/plcdev/conversations/review') {
          fields(body, ['conversationId', 'projectId', 'taskId', 'candidateDigest', 'expectedRevision', 'action', 'clientRequestId']);
          const state = snapshot(conversation(body.conversationId));
          if (!state.taskRefs.some(ref => ref.projectId === body.projectId && ref.taskId === body.taskId))
            reject(403, 'task_not_in_conversation', '此候选不属于当前对话，审阅操作未发送。');
          const { conversationId, ...review } = body;
          return await bridge.handle('POST', '/api/plcdev/tasks/review', review);
        }
        reject(404, 'not_found', '未知的会话接口。');
      } catch (error) {
        const safe = error instanceof ContextError ? error : new ContextError(503, 'context_unavailable', '会话关联存储暂不可用；未自动重试或接管运行实例。');
        return { status: safe.status, body: { ok: false, code: safe.code, error: safe.message } };
      }
    },
  };
}
