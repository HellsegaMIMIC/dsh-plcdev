import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const PID = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
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
export function createConversationRoutes({ controllerFile, bridge }) {
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
      );`);
    db.exec(`CREATE TABLE IF NOT EXISTS revision_intents (
      conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, turn_key TEXT, state TEXT NOT NULL
    );`);
    return db;
  }
  function withDb(fn) { const db = open(); try { return fn(db); } finally { db.close(); } }
  function transaction(fn) { return withDb(db => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(db); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }); }
  function readBinding(db, id) {
    const row = db.prepare('SELECT * FROM bindings WHERE conversation_id=?').get(id);
    return { conversationId: id, projectId: row?.project_id ?? null, version: row?.version ?? 0 };
  }
  function snapshot(id) { return withDb(db => {
    const rows = db.prepare('SELECT * FROM submissions WHERE conversation_id=? ORDER BY created_at, request_id').all(id);
    const revision=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(id);
    return { ok: true, ...readBinding(db, id), ...(revision?{revisionContext:{...JSON.parse(revision.payload),state:revision.state}}:{}),
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
  async function bind(body) {
    fields(body, ['conversationId', 'projectId', 'expectedVersion']); bindingInput(body);
    await knownProject(body.projectId);
    transaction(db => {
      const old = readBinding(db, body.conversationId);
      if (old.version !== body.expectedVersion) reject(409, 'binding_changed', '会话绑定已变化，请重新读取后明确选择工程。');
      if (old.projectId === body.projectId) return;
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
        typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId) || (body.workflow !== undefined && body.workflow !== 'joint-ai-v1'))
      reject(400, 'invalid_task', '任务需要确定的工程、已保存版本与候选范围。');
    const payload = { projectId: body.projectId, request: body.request.trim(), expectedRevision: body.expectedRevision,
      executionScope: body.executionScope, sourceBasis: body.sourceBasis, clientRequestId: body.clientRequestId,
      ...(body.planSubmission ? {planSubmission:body.planSubmission} : {}),...(body.workflow ? { workflow: body.workflow } : {}),...(body.revisionParent?{revisionParent:body.revisionParent}:{}) };
    if(body.revisionParent){
      fields(body.revisionParent,['taskId','candidateDigest']);
      if(!/^task-[0-9a-f]{32}$/.test(body.revisionParent.taskId||'')||!HASH.test(body.revisionParent.candidateDigest||'')||typeof body.revisionIntentId!=='string')reject(400,'invalid_revision','修订身份无效。');
    }else if(body.revisionIntentId)reject(400,'invalid_revision','修订身份不完整。');
    const digest = hash(JSON.stringify({ ...payload, expectedVersion: body.expectedVersion,...(body.revisionIntentId?{revisionIntentId:body.revisionIntentId}:{}) }));
    const row = transaction(db => {
      const old = db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND request_id=?').get(body.conversationId, body.clientRequestId);
      if (old) {
        if (old.fingerprint !== digest) reject(409, 'request_conflict', '原请求编号已绑定另一份输入；请核对已有任务，不得改写重放。');
        // An explicit retry retains its original project/version, even after a later binding change.
        return old;
      }
      const binding = readBinding(db, body.conversationId);
      if (binding.projectId !== body.projectId || binding.version !== body.expectedVersion)
        reject(409, 'binding_changed', '会话工程或绑定版本已变化，旧输入未提交。');
      if(body.revisionParent){
        const row=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(body.conversationId),intent=row&&JSON.parse(row.payload);
        if(!intent||row.state!=='claimed'||intent.intentId!==body.revisionIntentId||intent.projectId!==body.projectId||intent.expectedVersion!==body.expectedVersion||intent.expectedRevision!==body.expectedRevision||JSON.stringify(intent.parent)!==JSON.stringify(body.revisionParent))reject(409,'revision_changed','修订上下文已变化，请重新选择。');
      }
      const upstream = 'dsh2-' + hash(body.conversationId + '\0' + body.clientRequestId);
      const created = new Date().toISOString();
      db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(body.conversationId, body.clientRequestId, digest,
        body.projectId, body.expectedVersion, upstream, JSON.stringify({...payload,...(body.revisionIntentId?{revisionIntentId:body.revisionIntentId}:{})}), 'pending', null, created);
      if(body.revisionParent)db.prepare("UPDATE revision_intents SET state='submitting' WHERE conversation_id=?").run(body.conversationId);
      return { upstream_id: upstream, state: 'pending' };
    });
    if (row.state === 'accepted') {
      const listing = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(body.projectId));
      if (listing.status !== 200) return listing;
      const task = listing.body.tasks.find(t => t.taskId === row.task_id && t.projectId === body.projectId);
      if (!task) reject(409, 'task_reference_missing', '会话引用的任务暂不可用，未创建替代任务。');
      return { status: 200, body: { ok: true, conversationId: body.conversationId, task, duplicate: true } };
    }
    let result;
    try {
      result = await bridge.handle('POST', '/api/plcdev/tasks', { ...payload, clientRequestId: row.upstream_id });
    } catch {
      result = { status: 503, body: { code: 'submission_unknown', error: '任务投递结果未确认；重新读取会话并使用原请求编号核对。' } };
    }
    if (result.status >= 200 && result.status < 300) {
      if (result.body.task?.projectId !== body.projectId || !/^task-[a-f0-9]{32}$/.test(result.body.task?.taskId ?? ''))
        result = { status: 503, body: { code: 'task_project_mismatch', error: '任务归属无法确认，未挂到当前会话。' } };
      else {
        transaction(db => {
          db.prepare(`UPDATE submissions SET state='accepted', task_id=?, payload=NULL WHERE conversation_id=? AND request_id=?`).run(result.body.task.taskId, body.conversationId, body.clientRequestId);
          if(body.revisionIntentId){const r=db.prepare('SELECT payload FROM revision_intents WHERE conversation_id=?').get(body.conversationId);if(r&&JSON.parse(r.payload).intentId===body.revisionIntentId)db.prepare("UPDATE revision_intents SET state='submitted' WHERE conversation_id=?").run(body.conversationId);}
        });
        return { status: result.status, body: { ...result.body, conversationId: body.conversationId } };
      }
    }
    transaction(db => db.prepare(`UPDATE submissions SET state=? WHERE conversation_id=? AND request_id=? AND state!='accepted'`)
      .run(result.status >= 500 || result.body.code === 'task_project_mismatch' ? 'unknown' : 'rejected', body.conversationId, body.clientRequestId));
    return { status: result.status, body: { ...result.body, conversationId: body.conversationId } };
  }
  return {
    snapshot,
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
        if (method === 'GET' && url.pathname === '/api/plcdev/conversations') {
          if ([...url.searchParams.keys()].some(k => k !== 'conversationId') || url.searchParams.getAll('conversationId').length !== 1)
            reject(400, 'invalid_request', '读取会话需要唯一的会话身份。');
          return { status: 200, body: snapshot(conversation(url.searchParams.get('conversationId'))) };
        }
        if (method !== 'POST' || url.search || url.hash) reject(404, 'not_found', '未知的会话接口。');
        const body = JSON.parse(JSON.stringify(input ?? null));
        if (url.pathname === '/api/plcdev/conversations/bind') return await bind(body);
        if (url.pathname === '/api/plcdev/conversations/tasks') return await submit(body);
        if(url.pathname==='/api/plcdev/conversations/revision'){
          fields(body,['conversationId','projectId','taskId','candidateDigest','expectedRevision','expectedVersion','intentId']);bindingInput(body);
          if(typeof body.intentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.intentId))reject(400,'invalid_revision','修订编号无效。');
          const current=snapshot(body.conversationId);
          if(!current.taskRefs.some(t=>t.projectId===body.projectId&&t.taskId===body.taskId))reject(403,'task_not_in_conversation','此候选不属于当前对话。');
          const listing=await bridge.handle('GET','/api/plcdev/tasks?project='+encodeURIComponent(body.projectId));
          const task=listing.status===200&&listing.body.tasks?.find(t=>t.taskId===body.taskId&&t.projectId===body.projectId);
          if(!task||task.candidate?.revisionSupported!==true||task.workflow!=='joint-ai-v1'||task.status!=='awaiting_review'||task.supersededBy||task.candidate?.candidateDigest!==body.candidateDigest||task.projectRevision!==body.expectedRevision||listing.body.projectRevision!==body.expectedRevision)reject(409,'revision_unavailable','候选已保留、被替代或版本变化，不能继续修改。');
          const previousSummary=Object.fromEntries(['before','after'].filter(k=>typeof task.candidate.summary?.[k]==='string').map(k=>[k,task.candidate.summary[k].slice(0,1000)]));
          const intent={intentId:body.intentId,projectId:body.projectId,expectedVersion:body.expectedVersion,expectedRevision:body.expectedRevision,parent:{taskId:body.taskId,candidateDigest:body.candidateDigest},previousRequest:task.request.slice(0,4000),previousSummary};
          transaction(db=>{const b=readBinding(db,body.conversationId);if(b.projectId!==body.projectId||b.version!==body.expectedVersion)reject(409,'binding_changed','请先明确切回候选所属工程。');
            const old=db.prepare('SELECT * FROM revision_intents WHERE conversation_id=?').get(body.conversationId);
            if(old){const p=JSON.parse(old.payload);if(p.intentId===body.intentId){if(JSON.stringify(p)!==JSON.stringify(intent))reject(409,'revision_changed','同一修订编号的内容已变化。');return;}if(old.state!=='submitted')reject(409,'revision_busy','请先取消已有修订上下文。');}
            db.prepare("INSERT INTO revision_intents VALUES(?,?,NULL,'armed') ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload,turn_key=NULL,state='armed'").run(body.conversationId,JSON.stringify(intent));});
          return {status:200,body:snapshot(body.conversationId)};
        }
        if(url.pathname==='/api/plcdev/conversations/revision/cancel'){
          fields(body,['conversationId','intentId']);conversation(body.conversationId);
          transaction(db=>{const r=db.prepare('SELECT payload FROM revision_intents WHERE conversation_id=?').get(body.conversationId);if(r&&JSON.parse(r.payload).intentId!==body.intentId)reject(409,'revision_changed','修订上下文已变化。');db.prepare('DELETE FROM revision_intents WHERE conversation_id=?').run(body.conversationId);});return {status:200,body:snapshot(body.conversationId)};
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
