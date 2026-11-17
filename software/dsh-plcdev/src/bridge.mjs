import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {validateProjectOperation} from './project-operations.mjs';
import {matchesHmiPlan} from './hmi-intent.mjs';
import {validKeepReceiptRequest,validKeepReceipt} from './review-receipt.mjs';
import {validProjectEditSubmission} from './project-edit-contract.mjs';

const PREFIX = '/api/plcdev';
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(['start', 'runtime-start', 'runtime-stop', 'end', 'show-hmi', 'reopen-hmi', 'open-hmi', 'tool']);
const TOOLS = new Set(['plc', 'eez', 'hmi', 'fuxa', 'oip', 'factory', 'factory-window', 'scene-folder', 'logs']);
const MODES = new Set(['local', 'factoryio', 'mock', 'fuxa-oip', 'fuxa-local']);
const SECRET_KEY = /^(token|authorization|cookie|password|secret|api[-_]?key|encryptedApiKey|controllerFile)$/i;
const RECOVERY_REASONS={none:['none'],pending:['pending','source_checkpoint_missing'],conflict:['config_changed','source_changed','write_outcome_unknown','undo_outcome_unknown','transaction_outcome_unknown','native_write_unknown'],unavailable:['not_supported','transaction_unreadable']};

class BridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new BridgeError(status, code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
function fields(body, required, optional = []) {
  if (!record(body) || required.some(key => !has(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key)))
    fail(400, 'invalid_request', '请求字段无效；不接受任意路径、网址或额外操作。');
}
function projectId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail(400, 'invalid_project', '请选择已登记的工程。');
  return value;
}
function scrub(value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map(item => scrub(item, token));
  if (record(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, scrub(item, token)]));
  return value;
}
function normalizeRoot(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function runtimeEventsReply(value, project) {
  const sources = ['compiler','runtime','fuxa','oip','plcdev'];
  const timestamp = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= Date.now()/1000 + 60;
  const nullableId = id => id === null || (typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id));
  const nullableDigest = id => id === null || (typeof id === 'string' && DIGEST.test(id));
  const short = (s, n) => typeof s === 'string' && s.length <= n;
  const validEvent = e => record(e) && e.projectId === project && typeof e.id === 'string' && /^evt-[0-9a-f]{32}$/.test(e.id)
    && sources.includes(e.source) && ['error','warning','info'].includes(e.severity) && ['active','resolved','recorded'].includes(e.status)
    && short(e.phase,120) && short(e.summary,1000) && short(e.detail,12000) && short(e.raw,32768)
    && timestamp(e.firstAt) && timestamp(e.lastAt) && e.firstAt <= e.lastAt && Number.isSafeInteger(e.count) && e.count > 0
    && (!has(e,'resolvedAt') || (e.status === 'resolved' && timestamp(e.resolvedAt)))
    && nullableId(e.sessionId) && nullableDigest(e.projectRevision) && nullableDigest(e.programHash)
    && (!has(e,'taskId') || nullableId(e.taskId)) && (!has(e,'origin') || short(e.origin,240))
    && Array.isArray(e.variables) && e.variables.length <= 12 && e.variables.every(v => record(v) && short(v.name,160) && short(v.value,120) && short(v.quality,80));
  if (!record(value) || value.ok !== true || value.schemaVersion !== 1 || value.projectId !== project || !timestamp(value.observedAt)
      || !nullableId(value.currentSessionId) || !nullableDigest(value.projectRevision)
      || !Array.isArray(value.events) || value.events.length > 300 || !value.events.every(validEvent)
      || new Set(value.events.map(e=>e.id)).size !== value.events.length
      || !Array.isArray(value.sources) || value.sources.length !== sources.length
      || new Set(value.sources.map(s=>s?.id)).size !== sources.length
      || value.sources.some(s => !record(s) || !sources.includes(s.id) || !['available','partial','unavailable'].includes(s.state) || !short(s.label,120) || (has(s,'reason')&&!short(s.reason,1600))))
    fail(503,'runtime_events_mismatch','运行事件的工程归属或格式无法核对，已保留上次结果。');
  const pick = (row, names) => Object.fromEntries(names.filter(k=>has(row,k)).map(k=>[k,row[k]]));
  return {...pick(value,['ok','schemaVersion','projectId','observedAt','currentSessionId','projectRevision']),
    events:value.events.map(e=>({...pick(e,['id','projectId','source','severity','phase','summary','detail','raw','firstAt','lastAt','count','status','resolvedAt','projectRevision','programHash','sessionId','taskId','origin']),variables:e.variables.map(v=>pick(v,['name','value','quality']))})),
    sources:value.sources.map(s=>pick(s,['id','state','label','reason']))};
}

function parseRequest(method, rawPath, body) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith(PREFIX + '/') || rawPath.includes('#') || rawPath.includes('\\'))
    fail(404, 'not_found', '未知的 PLCdev 接口。');
  const url = new URL(rawPath, 'http://127.0.0.1');
  const route = url.pathname.slice(PREFIX.length);
  const read = method === 'GET' && ['/health', '/status', '/tasks', '/task-records', '/task-state', '/fuxa-recovery', '/project-inspection', '/runtime-events'].includes(route);
  const write = method === 'POST' && ['/tasks', '/tasks/open', '/tasks/review', '/action', '/project-inspection'].includes(route);
  if (!read && !write) fail(404, 'not_found', '未知的 PLCdev 接口。');
  let project;
  if (read) {
    if (body != null || [...url.searchParams.keys()].some(key => key !== 'project') || url.searchParams.getAll('project').length > 1 || (route === '/health' && url.search))
      fail(400, 'invalid_request', '读取请求字段无效。');
    if (url.searchParams.has('project')) project = projectId(url.searchParams.get('project'));
    if (['/tasks','/task-records','/task-state','/fuxa-recovery','/project-inspection','/runtime-events'].includes(route) && !project) fail(400, 'invalid_project', '读取前请选择工程。');
  } else {
    if (url.search) fail(400, 'invalid_request', '操作请求不能附带查询参数。');
    if (route === '/tasks') {
      fields(body, ['projectId', 'request', 'expectedRevision', 'executionScope', 'clientRequestId'], ['sourceBasis', 'workflow', 'revisionParent', 'planSubmission']);
      if(body.workflow==='project-edit-v1'&&(body.sourceBasis!=='saved_revision'||!validProjectEditSubmission(body.planSubmission)))fail(400,'invalid_request','工程修改计划格式无效，请重新读取上下文。');
      if(body.workflow==='hmi-view-name-v1') {
        fields(body.planSubmission,['schemaVersion','plan','route']);
        fields(body.planSubmission.plan,['viewId','name']);
        fields(body.planSubmission.route,['provider','model']);
        const {viewId,name}=body.planSubmission.plan;
        if(body.sourceBasis!=='saved_revision'||body.planSubmission.schemaVersion!==1||typeof viewId!=='string'||!viewId||viewId.length>120||/[\x00-\x1f]/.test(viewId)||typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f<>]/.test(name)||!matchesHmiPlan(body.workflow,body.request,body.planSubmission.plan)||Object.values(body.planSubmission.route).some(v=>typeof v!=='string'||!v||v.length>160))fail(400,'invalid_request','请用单条明确指令，例如：把画面名称“原名称”改为“新名称”。');
      }
      if(body.workflow==='hmi-static-text-v1') {
        fields(body.planSubmission,['schemaVersion','plan','route']);
        fields(body.planSubmission.plan,['viewId','elementId','text']);
        fields(body.planSubmission.route,['provider','model']);
        const {viewId,elementId,text}=body.planSubmission.plan;
        if(body.sourceBasis!=='saved_revision'||body.planSubmission.schemaVersion!==1||typeof viewId!=='string'||!viewId||viewId.length>120||/[\x00-\x1f]/.test(viewId)||typeof elementId!=='string'||!/^PLCD_[A-Za-z0-9_-]{1,100}$/.test(elementId)||typeof text!=='string'||!text.trim()||text.length>160||/[\x00-\x1f<>]/.test(text)||!matchesHmiPlan(body.workflow,body.request,body.planSubmission.plan)||Object.values(body.planSubmission.route).some(v=>typeof v!=='string'||!v||v.length>160))fail(400,'invalid_request','请用单条明确指令，例如：把静态文字“原文字”改为“新文字”。');
      }
      if(body.workflow==='hmi-readonly-value-v1') {
        fields(body.planSubmission,['schemaVersion','plan','route']);
        fields(body.planSubmission.plan,['viewId','signalId']);
        fields(body.planSubmission.route,['provider','model']);
        if(body.sourceBasis!=='saved_revision'||body.planSubmission.schemaVersion!==1
            ||Object.values(body.planSubmission.plan).some(v=>typeof v!=='string'||!v.trim()||v.length>120||/[\x00-\x1f]/.test(v))
            ||!matchesHmiPlan(body.workflow,body.request,body.planSubmission.plan)
            ||Object.values(body.planSubmission.route).some(v=>typeof v!=='string'||!v||v.length>160))
          fail(400,'invalid_request','请明确指定画面和已声明信号，生成只读数值显示候选。');
      }
      if (has(body,'revisionParent')) {
        fields(body.revisionParent,['taskId','candidateDigest']);
        if(!['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','project-edit-v1'].includes(body.workflow)||!/^task-[0-9a-f]{32}$/.test(body.revisionParent.taskId||'')||!DIGEST.test(body.revisionParent.candidateDigest||''))fail(400,'invalid_request','修订父候选无效。');
      }
      if (typeof body.request !== 'string' || !body.request.trim() || body.request.trim().length > 4000
        || typeof body.expectedRevision !== 'string' || !DIGEST.test(body.expectedRevision) || body.executionScope !== 'proposal'
        || typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId)
        || !['editor_current', 'saved_revision'].includes(body.sourceBasis ?? 'editor_current')
        || (has(body, 'workflow') && !['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(body.workflow)))
        fail(400, 'invalid_request', '候选任务的需求、版本或执行范围无效。');
    } else if (route === '/project-inspection') {
      fields(body, ['projectId', 'action', 'expectedRevision', 'expectedBaseline']);
      if (!['capture','acknowledge'].includes(body.action) || !DIGEST.test(body.expectedRevision ?? '') || !(body.expectedBaseline === null || DIGEST.test(body.expectedBaseline ?? '')))
        fail(400, 'invalid_request', '读取动作或工程版本无效，请刷新后重试。');
    } else if (route === '/tasks/open' || route === '/tasks/review') {
      fields(body, route === '/tasks/review' ? ['projectId', 'taskId', 'candidateDigest', 'expectedRevision', 'action', 'clientRequestId'] : ['projectId', 'taskId', 'candidateDigest']);
      if (typeof body.taskId !== 'string' || !/^task-[0-9a-f]{32}$/.test(body.taskId) || typeof body.candidateDigest !== 'string' || !DIGEST.test(body.candidateDigest))
        fail(400, 'invalid_request', '候选任务身份或摘要无效。');
      if (route === '/tasks/review' && (!DIGEST.test(body.expectedRevision ?? '') || !['keep', 'undo', 'compile'].includes(body.action) || !/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId ?? '')))
        fail(400, 'invalid_request', '候选审阅动作或版本无效。');
    } else {
      fields(body, ['projectId', 'sessionId', 'action', 'client', 'sequence', 'expires'], ['tool', 'mode']);
      if (!ACTIONS.has(body.action) || !(body.sessionId === null || (typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId)))
        || typeof body.client !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(body.client)
        || !Number.isSafeInteger(body.sequence) || body.sequence < 0 || typeof body.expires !== 'number' || !Number.isFinite(body.expires))
        fail(400, 'invalid_request', '工具或会话操作字段无效。');
      if (body.expires < Date.now() / 1000 || body.expires > Date.now() / 1000 + 15)
        fail(409, 'expired', '操作已过期，请刷新工程状态后重试。');
      if ((body.action === 'tool' && !TOOLS.has(body.tool)) || (body.action !== 'tool' && has(body, 'tool')) || (has(body, 'mode') && (body.action !== 'start' || !MODES.has(body.mode))))
        fail(400, 'invalid_request', '当前插件不支持这个工具或运行模式。');
    }
    project = projectId(body.projectId);
  }
  return { method, route, project, body };
}

/** Fixed local capability proxy. It never creates, restarts or owns a controller/Runtime process. */
export function createBridge(config) {
  if (!record(config) || typeof config.controllerFile !== 'string' || !path.isAbsolute(config.controllerFile)
    || typeof config.projectRoot !== 'string' || !path.isAbsolute(config.projectRoot))
    throw new TypeError('PLCdev bridge requires absolute controllerFile and projectRoot.');
  const controllerFile = path.resolve(config.controllerFile);
  const projectRoot = path.resolve(config.projectRoot);
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 50 && config.timeoutMs <= 30000 ? config.timeoutMs : 10000;

  async function descriptor() {
    let raw;
    try {
      const text = await readFile(controllerFile, 'utf8');
      if (Buffer.byteLength(text) > 16384) throw new Error('oversize');
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch { fail(503, 'controller_unavailable', 'PLCdev 后台尚未连接，请先启动既有工作台后台。'); }
    if (!record(raw) || typeof raw.base !== 'string' || !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(raw.base)
      || Number(raw.base.split(':').at(-1)) < 1 || Number(raw.base.split(':').at(-1)) > 65535
      || typeof raw.token !== 'string' || !/^[A-Za-z0-9_-]{24,256}$/.test(raw.token)
      || typeof raw.instance !== 'string' || !/^[0-9a-f]{32}$/.test(raw.instance)
      || typeof raw.root !== 'string' || !path.isAbsolute(raw.root))
      fail(503, 'invalid_controller', 'PLCdev 后台描述无效，已拒绝连接。');
    try {
      if (normalizeRoot(await realpath(raw.root)) !== normalizeRoot(await realpath(projectRoot)))
        fail(409, 'root_mismatch', '后台所属 PLCdev 目录与插件配置不一致，已拒绝连接。');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      fail(503, 'invalid_root', '无法核对 PLCdev 后台所属目录。');
    }
    return { base: raw.base, token: raw.token, instance: raw.instance, root: raw.root };
  }

  function upstream(desc, method, endpoint, body, options = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body == null ? undefined : JSON.stringify(body);
      const headers = { Authorization: 'Bearer ' + desc.token, 'Content-Type': 'application/json' };
      if (encoded) headers['Content-Length'] = Buffer.byteLength(encoded);
      let timer;
      const req = http.request(desc.base + endpoint, { method, headers, agent: false, signal: options.signal }, res => {
        let length = 0;
        const chunks = [];
        res.on('data', chunk => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) req.destroy(new Error('Response too large'));
          else chunks.push(chunk);
        });
        res.on('error', () => { clearTimeout(timer); reject(new BridgeError(503, 'upstream_unavailable', 'PLCdev 后台响应中断；操作结果未确认，请保留原请求编号。')); });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            if (!(res.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
              || res.statusCode < 200 || res.statusCode >= 600 || (res.statusCode >= 300 && res.statusCode < 400))
              throw new Error('Invalid response');
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!record(value)) throw new Error('Invalid response');
            resolve({ status: res.statusCode, body: value });
          } catch { reject(new BridgeError(503, 'invalid_response', 'PLCdev 后台返回无效响应；未自动重试操作。')); }
        });
      });
      timer = setTimeout(() => req.destroy(new Error('Timeout')), options.timeoutMs ?? timeoutMs);
      req.on('error', () => { clearTimeout(timer); reject(new BridgeError(503, 'upstream_unavailable', 'PLCdev 后台暂不可用；操作结果未确认，请保留原请求编号后核对。')); });
      req.end(encoded);
    });
  }

  function identity(desc, value, expectedProject) {
    if (value?.instance !== desc.instance || value?.service !== 'plcdev-workbench')
      fail(409, 'instance_mismatch', '后台实例已经变化，已拒绝旧连接；请刷新后重试。');
    if (value.schemaVersion !== 3 || !Array.isArray(value.projects) || !record(value.project) || !ID.test(value.project.id ?? '') || (expectedProject && value.project.id !== expectedProject))
      fail(503, 'project_mismatch', '后台未确认当前工程身份，已拒绝显示或操作。');
    if (!record(value.session) || value.session.projectId !== value.project.id)
      fail(503, 'session_mismatch', '后台会话归属不明确，已拒绝显示或操作。');
  }

  return Object.freeze({
    // Trusted editor handoff only. The host validates conversation ownership;
    // the controller resolves paths and owns preview copies / editor processes.
    async editorPrepare(body) {
      body=JSON.parse(JSON.stringify(body));
      fields(body,['projectId','target'],['taskId','candidateDigest']);projectId(body.projectId);
      if(!['candidate','retained','project'].includes(body.target)||
        (body.target!=='project'&&(!/^task-[0-9a-f]{32}$/.test(body.taskId||'')||!DIGEST.test(body.candidateDigest||'')))||
        (body.target==='project'&&(has(body,'taskId')||has(body,'candidateDigest'))))throw new Error('编辑器目标无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(body.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body,body.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/editor/prepare',body,{timeoutMs:60000});
      if(result.status!==200||result.body.ok!==true)throw new Error(scrub(result.body.error||'无法准备编辑器工程。',desc.token));
      const value=result.body;
      if(!/^[A-Za-z0-9_-]{16,100}$/.test(value.launchId||'')||!ID.test(value.projectId||'')||value.sourceProjectId!==body.projectId||
        !DIGEST.test(value.revision||'')||typeof value.nativeProjectPath!=='string'||!path.isAbsolute(value.nativeProjectPath)||path.basename(value.nativeProjectPath)!=='project.json'||
        !['preview','project'].includes(value.mode)||(body.target==='candidate')!==(value.mode==='preview'))throw new Error('编辑器目标回执无法核对。');
      return scrub(value,desc.token);
    },
    async editorVerifyPrepared(body) {
      body=JSON.parse(JSON.stringify(body));fields(body,['launchId','projectId','revision','nativeProjectPath']);projectId(body.projectId);
      if(!/^editor-[0-9a-f]{32}$/.test(body.launchId||'')||!DIGEST.test(body.revision||'')||typeof body.nativeProjectPath!=='string'||!path.isAbsolute(body.nativeProjectPath))throw new Error('同步目标无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(body.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body,body.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/editor/verify-prepared',body,{timeoutMs:30000});
      if(result.status!==200||result.body.ok!==true||Object.keys(body).some(k=>result.body[k]!==body[k]))throw new Error(scrub(result.body.error||'同步目标无法核对。',desc.token));
      return scrub(result.body,desc.token);
    },
    async editorOpen(body) {
      body=JSON.parse(JSON.stringify(body));
      fields(body,['launchId','connection']);
      const c=body.connection;
      if(!/^[A-Za-z0-9_-]{16,100}$/.test(body.launchId||'')||!record(c)||c.launchId!==body.launchId||
        !ID.test(c.projectId||'')||!DIGEST.test(c.revision||'')||typeof c.token!=='string'||!/^[0-9a-f]{64}$/.test(c.token)||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/plcdev\/editor-bridge$/.test(c.baseUrl||''))throw new Error('编辑器连接无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status');
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/editor/open',body,{timeoutMs:30000});
      if(result.status!==200||result.body.ok!==true)throw new Error(scrub(result.body.error||'编辑器打开结果尚未确认。',desc.token));
      if(result.body.launchId!==body.launchId||result.body.projectId!==c.projectId||result.body.nativeProjectPath!==c.nativeProjectPath)throw new Error('编辑器打开目标不一致。');
      return scrub(scrub(result.body,c.token),desc.token);
    },
    async candidatePreview(body) {
      body=JSON.parse(JSON.stringify(body));
      fields(body,['projectId','taskId','candidateDigest']);projectId(body.projectId);
      if(!/^task-[0-9a-f]{32}$/.test(body.taskId||'')||!DIGEST.test(body.candidateDigest||''))throw new Error('候选预览身份无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(body.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body,body.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'GET','/api/agent/tasks/preview?project='+encodeURIComponent(body.projectId)+'&task='+encodeURIComponent(body.taskId)+'&digest='+body.candidateDigest);
      if(result.status!==200||result.body.ok!==true||result.body.projectId!==body.projectId||result.body.taskId!==body.taskId||result.body.candidateDigest!==body.candidateDigest)throw new Error(scrub(result.body.error||'候选预览归属无法核对。',desc.token));
      return scrub(result.body,desc.token);
    },
    async resultResourceOpen(body) {
      body=JSON.parse(JSON.stringify(body));
      fields(body,['projectId','taskId','candidateDigest','tool','target']);projectId(body.projectId);
      if(!/^task-[0-9a-f]{32}$/.test(body.taskId||'')||!DIGEST.test(body.candidateDigest||'')||!['fuxa','oip'].includes(body.tool)||!['candidate','retained'].includes(body.target))throw new Error('结果工具目标无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(body.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body,body.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/editor/resource-open',body,{timeoutMs:60000});
      if(result.status!==200||result.body.ok!==true||Object.keys(body).some(key=>result.body[key]!==body[key]))throw new Error(scrub(result.body.error||'结果工具打开归属尚未确认。',desc.token));
      return scrub(result.body,desc.token);
    },
    async resultResourceStatus(body) {
      body=JSON.parse(JSON.stringify(body));
      fields(body,['projectId','taskId','candidateDigest','tool','target','launchId']);projectId(body.projectId);
      if(!/^task-[0-9a-f]{32}$/.test(body.taskId||'')||!DIGEST.test(body.candidateDigest||'')||body.tool!=='oip'||!['candidate','retained'].includes(body.target)||!/^editor-[0-9a-f]{32}$/.test(body.launchId||''))throw new Error('结果工具状态请求无效。');
      const desc=await descriptor(),probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(body.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');identity(desc,probe.body,body.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/editor/resource-status',body);
      if(result.status!==200||result.body.ok!==true||Object.keys(body).some(key=>result.body[key]!==body[key]))throw new Error(scrub(result.body.error||'结果工具状态归属尚未确认。',desc.token));
      return scrub(result.body,desc.token);
    },
    // Only the session-owned route may call this read-only check. It never
    // forwards arbitrary paths or repeats the original keep operation.
    async reviewReceipt(body) {
      const copy=JSON.parse(JSON.stringify(body));
      if(!validKeepReceiptRequest(copy))throw new Error('保留回执身份无效。');
      const desc=await descriptor();
      const probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(copy.projectId));
      if(probe.status!==200)throw new Error('工程后台不可用。');
      identity(desc,probe.body,copy.projectId);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'POST','/api/agent/tasks/review-receipt',copy);
      if(result.status!==200 || !validKeepReceipt(result.body,copy))throw new Error('保留回执归属或状态未确认。');
      return scrub(result.body,desc.token);
    },
    // Internal only: the conversation route supplies an already persisted
    // upstream identity. No browser-accessible general receipt proxy exists.
    async taskReceipt(project, requestId) {
      projectId(project);
      if(typeof requestId!=='string'||!/^dsh2-[0-9a-f]{64}$/.test(requestId))throw new Error('回执身份无效。');
      const desc=await descriptor();
      const probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(project));
      if(probe.status!==200)throw new Error('工程后台不可用。');
      identity(desc,probe.body,project);
      if(JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('工程后台已变化。');
      const result=await upstream(desc,'GET','/api/agent/receipt?project='+encodeURIComponent(project)+'&request='+encodeURIComponent(requestId));
      if(result.status!==200||result.body.ok!==true||result.body.projectId!==project||result.body.clientRequestId!==requestId||
         (result.body.task!==null&&(!record(result.body.task)||result.body.task.projectId!==project||!/^task-[0-9a-f]{32}$/.test(result.body.task.taskId||''))))throw new Error('回执归属未确认。');
      return scrub(result.body,desc.token);
    },
    // Server-only, bounded catalog operation. Public access goes through the
    // durable project-operations receipt; this is not a general HTTP proxy.
    async projectOperation(body) {
      const {client,sequence,expires,...operation}=body;
      if (!validateProjectOperation({...operation,requestId:'server-check'}) || typeof client!=='string' || !/^dsh-catalog-[0-9a-f-]{36}$/.test(client) || sequence!==1 || !Number.isFinite(expires) || expires < Date.now()/1000 || expires > Date.now()/1000+15) throw new Error('Invalid catalog operation');
      const copy=JSON.parse(JSON.stringify(body)),desc=await descriptor();
      const probe=await upstream(desc,'GET','/api/status?project='+encodeURIComponent(copy.projectId));
      if(probe.status!==200)throw new Error('Project unavailable');
      identity(desc,probe.body,copy.projectId);
      if(probe.body.session.id!==copy.sessionId)throw new Error('Session changed');
      const capability=copy.action==='project-create'?'canCreate':copy.action==='project-open'?'canOpen':copy.action==='project-configure'?'canConfigureProject':copy.action==='project-oip-configure'?'canConfigureOip':'canConfigureInterface';
      const allowed=copy.action==='project-create'||copy.action==='project-open'?probe.body.projectCatalog?.[capability]:probe.body.capabilities?.[capability];
      if(allowed!==true)throw new Error('Operation unavailable');
      if(expires<Date.now()/1000||JSON.stringify(await descriptor())!==JSON.stringify(desc))throw new Error('Operation expired or controller changed');
      const result=await upstream(desc,'POST','/api/action',copy,{timeoutMs:150000});
      return {status:result.status,body:scrub(result.body,desc.token)};
    },
    // Host-only native Team gateway. No corresponding browser HTTP route.
    async team(operation, body, signal) {
      if (!['create','create-generation','snapshot','native-task','member','context','report','generate','assemble','effect-start','effect-finish','model'].includes(operation)) throw new Error('未知团队服务操作。');
      const copy = JSON.parse(JSON.stringify(body));
      const desc = await descriptor();
      const probe = await upstream(desc, 'GET', '/api/status', undefined, { signal });
      if (probe.status !== 200) throw new Error('团队后台尚未就绪。');
      identity(desc, probe.body);
      if (JSON.stringify(await descriptor()) !== JSON.stringify(desc)) throw new Error('团队后台已替换，请核对原任务。');
      const result = await upstream(desc, 'POST', '/api/agent/team/' + operation, copy, { signal, timeoutMs: operation === 'model' ? 180000 : ['generate','assemble'].includes(operation) ? 120000 : 30000 });
      if (result.status !== 200 || result.body.ok !== true) throw new Error(scrub(result.body.error || '团队操作结果未确认。', desc.token));
      return scrub(result.body, desc.token);
    },
    // Server-only model access. There is deliberately no public /api/plcdev/model route.
    async model(body, signal) {
      const desc = await descriptor();
      const probe = await upstream(desc, 'GET', '/api/status', undefined, { signal });
      if (probe.status !== 200) throw new Error('PLCdev 模型后台尚未就绪。');
      identity(desc, probe.body);
      if (JSON.stringify(await descriptor()) !== JSON.stringify(desc)) throw new Error('PLCdev 后台已经变化，请重试。');
      const result = await upstream(desc, body ? 'POST' : 'GET', body ? '/api/agent/model' : '/api/agent/model/status', body, { signal, timeoutMs: body ? 180000 : timeoutMs });
      if (result.status !== 200) throw new Error(scrub(result.body.error || 'PLCdev 受控模型调用失败。', desc.token));
      return scrub(result.body, desc.token);
    },
    async handle(method, rawPath, body) {
      let token, mutationForwarded = false;
      try {
        // Clone before asynchronous checks; a caller cannot change project/session in flight.
        const copy = body == null ? body : JSON.parse(JSON.stringify(body));
        const request = parseRequest(method, rawPath, copy);
        const desc = await descriptor();
        token = desc.token;
        const probePath = '/api/status' + (request.project ? '?project=' + encodeURIComponent(request.project) : '');
        const probe = await upstream(desc, 'GET', probePath);
        if (probe.status !== 200) return { status: probe.status, body: scrub(probe.body, token) };
        identity(desc, probe.body, request.project);
        if (request.route === '/health') return { status: 200, body: { ok: true, connected: true, service: 'plcdev-workbench', instance: desc.instance } };
        if (request.route === '/status') return { status: 200, body: scrub(probe.body, token) };
        if (request.route.startsWith('/tasks') && probe.body.agentTaskInputVersion !== 'saved-revision-v1')
          fail(409, 'version_mismatch', '后台候选任务版本不兼容，请先更新既有工作台后台。');
        if (request.route === '/project-inspection' && probe.body.projectInspectionVersion !== 1)
          fail(409, 'version_mismatch', '后台尚未提供工程关系和保存回读，请更新并重启 PLCdev 后台。');
        if (request.route === '/runtime-events' && probe.body.runtimeEventsVersion !== 1)
          fail(409, 'version_mismatch', '后台尚未提供运行事件，请更新并重启 PLCdev 后台。');
        if (request.route === '/action') {
          if (copy.sessionId !== probe.body.session.id) fail(409, 'session_mismatch', '工程运行会话已变化，旧操作已拒绝；请刷新后重试。');
          if (copy.expires < Date.now() / 1000) fail(409, 'expired', '操作已过期，未发送到工作台。');
        }
        // A replacement controller must not receive the previous instance's pending write.
        const current = await descriptor();
        if (JSON.stringify(current) !== JSON.stringify(desc)) fail(409, 'controller_changed', '后台配置已变化，本次请求未转发；请刷新后重试。');
        let endpoint;
        if (['/tasks','/task-records','/task-state'].includes(request.route)) endpoint = '/api/agent' + request.route + (method === 'GET' ? '?project=' + encodeURIComponent(request.project) : '');
        else if(request.route==='/fuxa-recovery')endpoint='/api/fuxa/recovery?project='+encodeURIComponent(request.project);
        else if(request.route==='/project-inspection')endpoint='/api/project-inspection'+(method==='GET'?'?project='+encodeURIComponent(request.project):'');
        else if(request.route==='/runtime-events')endpoint='/api/runtime-events?project='+encodeURIComponent(request.project);
        else endpoint = ['/tasks/open', '/tasks/review'].includes(request.route) ? '/api/agent' + request.route : '/api/action';
        // After dispatch, even an unexpected local failure while validating or
        // redacting the reply cannot prove that a mutation was not accepted.
        mutationForwarded = method === 'POST';
        const result = await upstream(desc, method, endpoint, copy);
        if(request.route==='/runtime-events'&&result.status>=200&&result.status<300)
          return {status:200,body:scrub(runtimeEventsReply(result.body,request.project),token)};
        if(request.route==='/project-inspection'&&result.status>=200&&result.status<300){
          const value=result.body, revision=value?.projectRevision, readback=value?.readback;
          const relative=p=>typeof p==='string'&&!!p&&!/[\\:\x00-\x1f]/.test(p)&&!p.startsWith('/')&&!p.split('/').includes('..');
          const text=v=>typeof v==='string'&&v.length>0;
          const change=c=>record(c)&&relative(c.path)&&['added','removed','changed'].includes(c.kind)&&['hmi-layout','hmi-content','plc','binding','scene','configuration','unknown'].includes(c.scope);
          const review=readback?.lastReview;
          if(value?.ok!==true||value.schemaVersion!==1||value.projectId!==request.project||!DIGEST.test(revision??'')||value.source!=='saved-files-only'||value.editorState?.state!=='unknown'
              ||!Array.isArray(value.resources)||value.resources.some(r=>!record(r)||!relative(r.path)||!DIGEST.test(r.sha256??''))
              ||!Array.isArray(value.signals)||value.signals.some(s=>!record(s)||!text(s.id)||!text(s.path)||!relative(s.source?.path)||!Array.isArray(s.hmi)||!Array.isArray(s.scene)
                ||s.hmi.some(h=>!record(h)||!text(h.viewId)||!text(h.elementId)||!text(h.tagId))
                ||s.scene.some(c=>!record(c)||!text(c.id)||!relative(c.path)||!['model-to-plc','plc-to-model'].includes(c.direction)))
              ||!record(readback)||!['untracked','current','changed'].includes(readback.state)||readback.observedRevision!==revision||!Array.isArray(readback.changes)
              ||['baselineRevision','capturedRevision','acknowledgedRevision'].some(k=>readback[k]!==null&&!DIGEST.test(readback[k]??''))
              ||readback.changes.some(c=>!change(c))||readback.layoutOnly!==(readback.changes.length>0&&readback.changes.every(c=>c.scope==='hmi-layout'))
              ||(readback.state==='untracked'&&(readback.baselineRevision!==null||readback.changes.length!==0))
              ||(readback.state==='current'&&(readback.baselineRevision!==revision||readback.changes.length!==0))
              ||(readback.state==='changed'&&(!readback.baselineRevision||readback.baselineRevision===revision||readback.changes.length===0))
              ||(review!==null&&(!record(review)||review.type!=='layout'||!DIGEST.test(review.fromRevision??'')||review.toRevision!==readback.acknowledgedRevision||!DIGEST.test(review.toRevision??'')||!text(review.confirmedAt)||!Array.isArray(review.changes)||!review.changes.length||review.changes.some(c=>!change(c)||c.scope!=='hmi-layout')))
              ||!record(value.capabilities)||typeof value.capabilities.canCapture!=='boolean'||typeof value.capabilities.canAcknowledgeLayout!=='boolean'
              ||(value.capabilities.canAcknowledgeLayout&&(!value.capabilities.canCapture||!readback.layoutOnly||readback.capturedRevision!==revision)))
            fail(503,'inspection_mismatch','工程读取结果的归属或版本无法核对，已拒绝显示。');
        }
        if(request.route==='/fuxa-recovery'&&result.status>=200&&result.status<300){
          const allowed=RECOVERY_REASONS[result.body?.state];
          if(result.body?.ok!==true||result.body.projectId!==request.project||!Array.isArray(allowed)||!allowed.includes(result.body.reasonCode))fail(503,'recovery_mismatch','旧预览归属或状态未确认。');
          return {status:200,body:{ok:true,projectId:request.project,state:result.body.state,reasonCode:result.body.reasonCode}};
        }
        if (result.status >= 200 && result.status < 300 && ['/tasks','/task-records','/task-state'].includes(request.route)) {
          if (method === 'GET') {
            if (result.body.projectId !== request.project || !Array.isArray(result.body.tasks) || result.body.tasks.some(task => !record(task) || task.projectId !== request.project))
              fail(503, 'task_project_mismatch', '任务列表的工程归属不一致，已拒绝显示。');
            if(request.route==='/task-state'&&!DIGEST.test(result.body.projectRevision||''))fail(503,'task_revision_mismatch','任务状态的保存版本无法核对。');
            if(request.route==='/task-records'&&has(result.body,'projectRevision'))fail(503,'task_records_mismatch','记录列表不能作为操作版本。');
          } else if (!record(result.body.task) || result.body.task.projectId !== request.project || typeof result.body.task.taskId !== 'string')
            fail(503, 'task_project_mismatch', '任务结果归属未确认，请保留同一请求编号核对。');
        }
        if (result.status >= 200 && result.status < 300 && ['/tasks/open', '/tasks/review'].includes(request.route)
          && (result.body.projectId !== request.project || result.body.taskId !== copy.taskId || result.body.candidateDigest !== copy.candidateDigest))
          fail(503, 'candidate_mismatch', '候选打开结果未确认，请刷新当前工程任务。');
        return { status: result.status, body: scrub(result.body, token) };
      } catch (error) {
        const safe = error instanceof BridgeError ? error : mutationForwarded
          ? new BridgeError(503, 'mutation_unknown', '操作结果未确认；请保留原请求编号并核对。')
          : new BridgeError(400, 'invalid_request', '请求无法处理，请刷新工程状态后重试。');
        return { status: safe.status, body: { ok: false, connected: false, code: safe.code, error: scrub(safe.message, token) } };
      }
    },
  });
}
