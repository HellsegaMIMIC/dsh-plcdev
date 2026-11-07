import { createHash } from 'node:crypto';

export const TOOL_NAMES = Object.freeze(['plcdev_project_context', 'plcdev_propose_joint', 'plcdev_task_status']);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
function exact(args, keys) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== keys.length || keys.some(k => !Object.hasOwn(args, k)))
    throw new Error('PLCdev 工具参数无效。');
}
function compactTask(task) {
  return { projectId: task.projectId, taskId: task.taskId, status: task.status,
    projectRevision: task.projectRevision,
    workflow: task.workflow, candidateDigest: task.candidate?.candidateDigest,
    summary: task.candidate?.summary, reason: task.reason,
    candidate: task.candidate ? { candidateDigest: task.candidate.candidateDigest,
      validation: task.candidate.validation,
      components: task.candidate.components?.map(({tool, summary, widgets}) => ({tool, summary, widgets})) } : undefined,
    retention: task.retention ? { status: task.retention.status, projectId: task.retention.projectId,
      keptProjectId: task.retention.keptProjectId } : undefined,
    compilation: task.compilation ? { status: task.compilation.status } : undefined,
    nextStep: '在 PLCdev 候选审阅中核对结果；保留、撤销和编译需用户点击，不会自动运行。' };
}

/** Native DSH tools use trusted session identity, fixed saved revision and proposal-only authority. */
export function createNativeTools({ bridge, conversations, turnScopes }) {
  async function projectName(projectId) {
    try {
      const result = await bridge.handle('GET', '/api/plcdev/status?project=' + encodeURIComponent(projectId));
      const project = result.status === 200 && result.body.project;
      return project?.id === projectId && typeof project.name === 'string' ? project.name : null;
    } catch { return null; } // Optional display metadata must never hide a durable task receipt.
  }
  function session(exec) {
    exec.signal?.throwIfAborted();
    const id = exec.agent?.session?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new Error('需要真实 DSH 对话身份，不能由工具参数指定会话。');
    return id;
  }
  async function context(id) {
    const binding = conversations.snapshot(id);
    if (!binding.projectId) throw new Error('请先在输入框上方关联 PLCdev 工程。');
    if (turnScopes) {
      const scope = turnScopes.get(id);
      if (!scope || scope.projectId !== binding.projectId || scope.version !== binding.version)
        throw new Error('本轮对话的工程绑定已变化或尚未核验，请重新发送明确需求。');
    }
    const response = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(binding.projectId));
    if (response.status !== 200 || response.body.projectId !== binding.projectId || !/^[0-9a-f]{64}$/.test(response.body.projectRevision ?? ''))
      throw new Error('尚未核对工程已保存版本。');
    const revision = response.body.projectRevision;
    const name = await projectName(binding.projectId);
    const current = conversations.snapshot(id);
    if (current.projectId !== binding.projectId || current.version !== binding.version)
      throw new Error('读取工程期间绑定已变化，请重新核对。');
    return { binding, listing: response.body, projectName: name, contextToken: hash(JSON.stringify([id, binding.projectId, binding.version, revision])) };
  }
  function define(name, title, description, parameters, execute) {
    return { name, description, parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: (_args, value) => { try { const data = JSON.parse(value); return data.task ? { projectId: data.task.projectId, taskId: data.task.taskId } : {}; } catch { return {}; } } },
      presentCall: () => ({ card: 'generic', title, kind: name === 'plcdev_propose_joint' ? 'edit' : 'read' }),
      isConcurrencySafe: () => name !== 'plcdev_propose_joint',
      async execute(args, exec) { return JSON.stringify(await execute(args, exec)); },
    };
  }
  return [
    define(TOOL_NAMES[0], '核对 PLCdev 工程', 'Read the project explicitly bound to this DSH conversation and its saved revision. Call before proposing a joint PLC/FUXA/OIP candidate. Does not inspect files or control Runtime.', object({}), async (args, exec) => {
      exact(args, []); const id = session(exec), { binding, listing, projectName, contextToken } = await context(id);
      const own = new Set(binding.taskRefs.filter(r => r.projectId === binding.projectId).map(r => r.taskId));
      return { ok: true, projectId: binding.projectId, projectName, sourceBasis: 'saved_revision', projectRevision: listing.projectRevision, contextToken,
        jointAiCandidate: listing.capabilities?.jointAiCandidate === true,
        tasks: listing.tasks.filter(t => own.has(t.taskId)).slice(-5).map(compactTask),
        boundary: 'Only saved project candidate generation. Unsaved editor changes excluded. Keep/Undo/Compile are explicit review actions; no Runtime start/stop.' };
    }),
    define(TOOL_NAMES[1], '生成 PLC／HMI／场景联合候选', 'Generate a real AI joint candidate for OpenPLC, FUXA and OIP in the bound project. Use the exact contextToken from plcdev_project_context. Request must preserve the user intent. Creates a separate candidate only, never keeps, compiles or runs it.', object({ request: string, contextToken: string }), async (args, exec) => {
      exact(args, ['request', 'contextToken']); const id = session(exec);
      if (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 4000) throw new Error('候选需求应为 1–4000 字符。');
      const { binding, listing, projectName, contextToken } = await context(id);
      if (args.contextToken !== contextToken) throw new Error('工程绑定或源版本已变化。请重新读取上下文，不得把旧需求自动投到新工程。');
      if (listing.capabilities?.jointAiCandidate !== true) throw new Error('当前工程尚未开放真实 AI 联合候选。');
      if (binding.pendingRequests.length) throw new Error('本对话仍有待核对请求，请在工程与任务区使用原请求编号恢复。');
      if (typeof exec.callId !== 'string' || !exec.callId) throw new Error('DSH 工具调用身份缺失。');
      exec.signal?.throwIfAborted();
      const result = await conversations.handle('POST', '/api/plcdev/conversations/tasks', {
        conversationId: id, projectId: binding.projectId, expectedVersion: binding.version,
        request: args.request.trim(), expectedRevision: listing.projectRevision, executionScope: 'proposal',
        sourceBasis: 'saved_revision', workflow: 'joint-ai-v1', clientRequestId: 'native-' + hash(exec.callId),
      });
      if (result.status < 200 || result.status >= 300) throw new Error(result.body.error || '候选任务未确认，请核对本对话任务。');
      // Durable asynchronous generation continues in TaskService, not a model polling loop.
      exec.concludeTurn?.();
      return { ok: true, projectName, task: compactTask(result.body.task) };
    }),
    define(TOOL_NAMES[2], '读取 PLCdev 候选状态', 'Read one candidate already referenced by this DSH conversation. Cannot access another conversation task or change project/Runtime state.', object({ taskId: string }), async (args, exec) => {
      exact(args, ['taskId']); const id = session(exec), binding = conversations.snapshot(id);
      const ref = binding.taskRefs.find(r => r.taskId === args.taskId);
      if (!ref) throw new Error('任务不属于当前 DSH 对话。');
      const result = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(ref.projectId));
      const task = result.status === 200 && result.body.tasks?.find(t => t.taskId === ref.taskId && t.projectId === ref.projectId);
      if (!task) throw new Error('所属工程暂未返回该任务。');
      return { ok: true, projectName: await projectName(ref.projectId), task: compactTask(task) };
    }),
  ];
}
