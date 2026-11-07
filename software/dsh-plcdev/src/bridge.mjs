import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const PREFIX = '/api/plcdev';
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(['start', 'runtime-start', 'runtime-stop', 'end', 'show-hmi', 'reopen-hmi', 'open-hmi', 'tool']);
const TOOLS = new Set(['plc', 'eez', 'hmi', 'fuxa', 'oip', 'factory', 'factory-window', 'scene-folder', 'logs']);
const MODES = new Set(['local', 'factoryio', 'mock', 'fuxa-oip', 'fuxa-local']);
const SECRET_KEY = /^(token|authorization|cookie|password|secret|api[-_]?key|encryptedApiKey|controllerFile)$/i;

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

function parseRequest(method, rawPath, body) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith(PREFIX + '/') || rawPath.includes('#') || rawPath.includes('\\'))
    fail(404, 'not_found', '未知的 PLCdev 接口。');
  const url = new URL(rawPath, 'http://127.0.0.1');
  const route = url.pathname.slice(PREFIX.length);
  const read = method === 'GET' && ['/health', '/status', '/tasks'].includes(route);
  const write = method === 'POST' && ['/tasks', '/tasks/open', '/tasks/review', '/action'].includes(route);
  if (!read && !write) fail(404, 'not_found', '未知的 PLCdev 接口。');
  let project;
  if (read) {
    if (body != null || [...url.searchParams.keys()].some(key => key !== 'project') || url.searchParams.getAll('project').length > 1 || (route === '/health' && url.search))
      fail(400, 'invalid_request', '读取请求字段无效。');
    if (url.searchParams.has('project')) project = projectId(url.searchParams.get('project'));
    if (route === '/tasks' && !project) fail(400, 'invalid_project', '读取任务前请选择工程。');
  } else {
    if (url.search) fail(400, 'invalid_request', '操作请求不能附带查询参数。');
    if (route === '/tasks') {
      fields(body, ['projectId', 'request', 'expectedRevision', 'executionScope', 'clientRequestId'], ['sourceBasis', 'workflow']);
      if (typeof body.request !== 'string' || !body.request.trim() || body.request.trim().length > 4000
        || typeof body.expectedRevision !== 'string' || !DIGEST.test(body.expectedRevision) || body.executionScope !== 'proposal'
        || typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.clientRequestId)
        || !['editor_current', 'saved_revision'].includes(body.sourceBasis ?? 'editor_current')
        || (has(body, 'workflow') && body.workflow !== 'joint-ai-v1'))
        fail(400, 'invalid_request', '候选任务的需求、版本或执行范围无效。');
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
      let token;
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
        if (request.route === '/action') {
          if (copy.sessionId !== probe.body.session.id) fail(409, 'session_mismatch', '工程运行会话已变化，旧操作已拒绝；请刷新后重试。');
          if (copy.expires < Date.now() / 1000) fail(409, 'expired', '操作已过期，未发送到工作台。');
        }
        // A replacement controller must not receive the previous instance's pending write.
        const current = await descriptor();
        if (JSON.stringify(current) !== JSON.stringify(desc)) fail(409, 'controller_changed', '后台配置已变化，本次请求未转发；请刷新后重试。');
        let endpoint;
        if (request.route === '/tasks') endpoint = '/api/agent/tasks' + (method === 'GET' ? '?project=' + encodeURIComponent(request.project) : '');
        else endpoint = ['/tasks/open', '/tasks/review'].includes(request.route) ? '/api/agent' + request.route : '/api/action';
        const result = await upstream(desc, method, endpoint, copy);
        if (result.status >= 200 && result.status < 300 && request.route === '/tasks') {
          if (method === 'GET') {
            if (result.body.projectId !== request.project || !Array.isArray(result.body.tasks) || result.body.tasks.some(task => !record(task) || task.projectId !== request.project))
              fail(503, 'task_project_mismatch', '任务列表的工程归属不一致，已拒绝显示。');
          } else if (!record(result.body.task) || result.body.task.projectId !== request.project || typeof result.body.task.taskId !== 'string')
            fail(503, 'task_project_mismatch', '任务结果归属未确认，请保留同一请求编号核对。');
        }
        if (result.status >= 200 && result.status < 300 && ['/tasks/open', '/tasks/review'].includes(request.route)
          && (result.body.projectId !== request.project || result.body.taskId !== copy.taskId || result.body.candidateDigest !== copy.candidateDigest))
          fail(503, 'candidate_mismatch', '候选打开结果未确认，请刷新当前工程任务。');
        return { status: result.status, body: scrub(result.body, token) };
      } catch (error) {
        const safe = error instanceof BridgeError ? error : new BridgeError(400, 'invalid_request', '请求无法处理，请刷新工程状态后重试。');
        return { status: safe.status, body: { ok: false, connected: false, code: safe.code, error: scrub(safe.message, token) } };
      }
    },
  });
}
