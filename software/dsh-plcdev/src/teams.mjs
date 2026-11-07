import { createHash } from 'node:crypto';

export const TEAM_PROVIDER = 'plcdev-team';
export const TEAM_MODEL = 'team-analysis';
export const TEAM_GENERATION_MODEL = 'team-generation';
export const ROLE_TOOLS = Object.freeze({
  lead: ['plcdev_team_context', 'plcdev_team_plan', 'plcdev_team_status', 'plcdev_team_control'],
  plc: ['plcdev_plc_analyze', 'plcdev_team_report', 'plcdev_team_reconcile'],
  hmi: ['plcdev_hmi_analyze', 'plcdev_team_report', 'plcdev_team_reconcile'],
});
export const GENERATION_ROLE_TOOLS = Object.freeze({
  lead: ['plcdev_team_context', 'plcdev_team_generate_plan', 'plcdev_team_status', 'plcdev_team_control', 'plcdev_team_assemble'],
  plc: ['plcdev_plc_analyze', 'plcdev_plc_generate', 'plcdev_team_reconcile'],
  hmi: ['plcdev_hmi_analyze', 'plcdev_hmi_generate', 'plcdev_team_reconcile'],
  oip: ['plcdev_oip_analyze', 'plcdev_oip_generate', 'plcdev_team_reconcile'],
});
const generationTask = task => task?.workflow === 'team-generation-v1';
const taskScope = task => generationTask(task) ? 'team-generation' : 'team-analysis';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const string = { type: 'string' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const identityFields = { taskId: string, projectId: string, projectRevision: string };
const reportItem = { type: 'string', minLength: 1, maxLength: 1000 };
const reportFields = {
  summary: { type: 'string', minLength: 1, maxLength: 2000 },
  findings: { type: 'array', minItems: 1, maxItems: 12, items: reportItem },
  unverified: { type: 'array', minItems: 1, maxItems: 12, items: reportItem },
};
// Mirror TaskService's report admission bounds before any report write. A
// rejected report can be corrected; this is not an unknown delivery receipt.
function validateReport(report) {
  exact(report, Object.keys(reportFields));
  const bounded = (value, max) => typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= max;
  if (!bounded(report.summary, 2000)) throw new Error('报告未提交：summary 必须为 1–2000 个字符。请修正后重新提交。');
  for (const key of ['findings', 'unverified']) {
    const items = report[key];
    if (!Array.isArray(items) || items.length < 1 || items.length > 12 || items.some(value => !bounded(value, 1000)))
      throw new Error(`报告未提交：${key} 必须包含 1–12 条，每条 1–1000 个字符。请合并或缩减后重新提交。`);
  }
}
function exact(args, keys) {
  if (!args || Array.isArray(args) || Object.keys(args).length !== keys.length || keys.some(k => !Object.hasOwn(args, k))) throw new Error('团队工具参数无效。');
}

/** Uses native Teams as the roster/task/message owner. TaskService owns engineering state. */
export function createTeamIntegration({ ctx, bridge, conversations }) {
  const turns = new Map(), activePlans = new Map(), registered = new WeakMap(), issuedCalls = new WeakMap();
  const leadMutations = new Set(['plcdev_team_plan', 'plcdev_team_generate_plan', 'plcdev_team_assemble', 'plcdev_team_control']);
  // Web model selection is request-scoped: Agent.options keeps its creation
  // defaults. Pending native intent must win so switching away rejects both
  // an in-flight reply and its final tool dispatch before another request runs.
  function currentRoute(agent) {
    if (!agent?.session) return agent?.options;
    const selected = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
    return selected?.pending ?? agent.session.requestHeader?.()?.config ?? selected?.lastUsed ?? agent.options;
  }
  const isTeamRoute = agent => {
    const route = currentRoute(agent);
    return route?.provider === TEAM_PROVIDER && [TEAM_MODEL, TEAM_GENERATION_MODEL].includes(route?.model);
  };
  const generationRoute = agent => currentRoute(agent)?.model === TEAM_GENERATION_MODEL;
  const allowedTools = agent => generationRoute(agent) ? GENERATION_ROLE_TOOLS : ROLE_TOOLS;
  function matchingWorkflow(agent, task) {
    if (task && task.workflow !== (generationRoute(agent) ? 'team-generation-v1' : 'team-analysis-v1'))
      throw new Error('原任务与当前团队模型路由不同；请返回原模型核对任务，新生成需求须使用新的原生对话。');
  }
  function live(agent) {
    if (!agent || ctx.agents.get(agent.session?.id) !== agent || !isTeamRoute(agent) || agent.session.header.isSeeded)
      throw new Error('团队工具需要本路由的真实原生会话；不接受继承历史的 fork 或会话替身。');
    const m = ctx.agentTeams.membership(agent);
    if (ctx.agents.get(m.root.session.id) !== m.root || !isTeamRoute(m.root) || currentRoute(m.root).model !== currentRoute(agent).model)
      throw new Error('原生父会话已替换或离开团队模型路由。');
    return m;
  }
  function rootActor(m) {
    return { sessionId: m.root.session.id, createdAt: m.root.session.header.createdAt,
      rootSessionId: m.root.session.id, rootCreatedAt: m.root.session.header.createdAt,
      teamId: m.id, role: 'lead', name: 'lead' };
  }
  const call = (operation, actor, input = {}, signal) => bridge.team(operation, { actor, input }, signal);
  function requestScope(exec, name) {
    const issued = issuedCalls.get(exec.agent)?.get(exec.callId);
    if (!issued || issued.name !== name) throw new Error('本次工具调用没有有效的请求绑定；请重新核对原任务。');
    assertRequest(exec, issued.scope);
    return issued.scope;
  }
  function assertRequest(exec, scope) {
    exec.signal?.throwIfAborted();
    const m = live(exec.agent), binding = conversations.snapshot(m.root.session.id);
    if (!scope || turns.get(exec.agent.session.id) !== scope ||
        binding.projectId !== scope.requestBinding.projectId || binding.version !== scope.requestBinding.version ||
        (scope.model && currentRoute(exec.agent).model !== scope.model))
      throw new Error('本次请求的工程绑定或会话已变化；旧调用未执行，原任务保留原工程。');
  }
  async function authority(agent) {
    const m = live(agent), root = rootActor(m);
    if (m.role === 'lead') { registered.set(agent, root); return root; }
    const state = await call('snapshot', root);
    matchingWorkflow(agent, state.task);
    const slot = state.task?.teamAnalysis?.members.find(s => s.name === m.name);
    const row = ctx.agentTeams.listMembers(agent).find(r => r.id === agent.session.id && r.name === m.name);
    if (!slot || !row || row.context !== 'fresh' || !['running', 'inactive', 'provisioning'].includes(row.status) || !slot.nativeTaskId)
      throw new Error('真实原生成员不属于工程服务登记的专业角色。');
    const actor = { ...root, sessionId: agent.session.id, createdAt: agent.session.header.createdAt, role: slot.role, name: slot.name };
    if (slot.sessionId && (slot.sessionId !== actor.sessionId || slot.createdAt !== actor.createdAt)) throw new Error('该角色已绑定另一个原生子会话。');
    live(agent);
    await call('member', actor);
    registered.set(agent, actor);
    return actor;
  }
  async function stateFor(agent) {
    const actor = await authority(agent), result = await call('snapshot', actor);
    live(agent);
    matchingWorkflow(agent, result.task);
    if (result.task) {
      conversations.referenceTeam(actor.rootSessionId, result.task);
      if (actor.role !== 'lead') conversations.referenceTeam(actor.sessionId, result.task);
    }
    return { actor, ...result };
  }
  function nativeMemberStates(agent, task) {
    if (!task) return [];
    const members = ctx.agentTeams.listMembers(agent);
    return task.teamAnalysis.members.map(slot => {
      const member = members.find(row => row.id === slot.sessionId && row.name === slot.name);
      let nativeTaskStatus = 'unknown';
      if (slot.nativeTaskId) {
        try { nativeTaskStatus = ctx.agentTeams.getTask(agent, slot.nativeTaskId).status; } catch {}
      }
      return { role: slot.role, sessionId: slot.sessionId ?? null, name: slot.name,
        status: member?.status ?? 'unknown', nativeTaskId: slot.nativeTaskId ?? null, nativeTaskStatus,
        reportStored: !!slot.reportDigest, notice: slot.notice ?? 'not_confirmed' };
    });
  }
  async function context(agent) {
    const state = await stateFor(agent), { actor } = state;
    if (actor.role !== 'lead') throw new Error('只有 Lead 可读取团队分工上下文。');
    const binding = conversations.snapshot(actor.rootSessionId);
    if (!binding.projectId) throw new Error('请先明确关联工程。');
    if (state.task) return { ...state, memberStates: nativeMemberStates(agent, state.task), projectId: state.task.projectId, projectRevision: state.task.projectRevision,
      bindingVersion: state.task.teamAnalysis.bindingVersion, bindingChanged: binding.projectId !== state.task.projectId || binding.version !== state.task.teamAnalysis.bindingVersion,
      contextToken: hash([actor.rootSessionId, state.task.projectId, state.task.teamAnalysis.bindingVersion, state.task.projectRevision, binding.projectId, binding.version]) };
    const listing = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(binding.projectId));
    if (listing.status !== 200 || listing.body.projectId !== binding.projectId || !/^[0-9a-f]{64}$/.test(listing.body.projectRevision ?? '')) throw new Error('尚未核对工程保存版本。');
    const current = conversations.snapshot(actor.rootSessionId);
    if (current.projectId !== binding.projectId || current.version !== binding.version) throw new Error('读取期间工程绑定变化。');
    return { ...state, projectId: binding.projectId, projectRevision: listing.body.projectRevision, bindingVersion: binding.version,
      bindingChanged: false, contextToken: hash([actor.rootSessionId, binding.projectId, binding.version, listing.body.projectRevision, binding.projectId, binding.version]) };
  }
  async function effect(actor, id, payload, execute, fence = () => {}) {
    fence();
    const receipt = await call('effect-start', actor, { effectId: id, payload });
    // The intent is durable before the action. A bind change while its receipt
    // is in flight must not authorize an action; leave that intent unknown.
    fence();
    if (!receipt.send) return receipt.result ?? { unknown: true, reason: '原意图已登记但回执未确认；没有自动重发。' };
    const result = await execute();
    await call('effect-finish', actor, { effectId: id, payload, result });
    return result;
  }
  function originalMember(agent, slot) {
    const rows = ctx.agentTeams.listMembers(agent).filter(m => m.name === slot.name);
    const member = rows[0];
    if (rows.length !== 1 || member.role !== 'teammate' || member.context !== 'fresh' ||
        (slot.sessionId && member.id !== slot.sessionId) || !['running', 'inactive'].includes(member.status))
      throw new Error('原生成员身份或状态未核实，尚未恢复；不创建替代成员。');
    return member;
  }
  async function nativeLog(id, exec, createdAt) {
    if (!ctx.sessions?.flush || !ctx.sessionPersistence?.open) throw new Error('缺少持久身份核对服务，成员尚未恢复。');
    // Inactive Agents may be released before their Session attachment. Flush
    // the exact native Session owner, not only an Agent still in the registry.
    const session = ctx.sessions.get?.(id) ?? ctx.agents.get(id)?.session;
    const expectedCreatedAt = createdAt ?? session?.header.createdAt;
    if (session) {
      if (session.id !== id || session.header.id !== id || session.header.createdAt !== expectedCreatedAt)
        throw new Error('持久化目标会话身份不符，恢复投递未知。');
      if (await ctx.sessions.flush(session) !== true) throw new Error('没有持久化监听器确认，恢复投递未知。');
    }
    exec.signal?.throwIfAborted();
    const handle = await ctx.sessionPersistence.open(id, 'read', { signal: exec.signal });
    try {
      if (handle.header.id !== id || (expectedCreatedAt !== undefined && handle.header.createdAt !== expectedCreatedAt))
        throw new Error('持久日志与目标会话身份不符，恢复投递未知。');
      const { events } = await handle.read(0, undefined, { signal: exec.signal });
      const owner = ctx.sessions.get?.(id) ?? ctx.agents.get(id)?.session;
      if (owner && (owner.id !== id || owner.header.createdAt !== handle.header.createdAt))
        throw new Error('落盘期间目标会话身份变化，恢复投递未知。');
      return { header: handle.header, inherited: handle.inheritedEventCount, events };
    } finally { await handle.close(); }
  }
  async function proveMember(actor, slot, exec, scope) {
    const member = originalMember(exec.agent, slot);
    let root, child;
    try { root = await nativeLog(actor.rootSessionId, exec, actor.rootCreatedAt); child = await nativeLog(member.id, exec, slot.createdAt); }
    catch (error) { throw new Error('持久父子身份未能核实，成员尚未恢复。', { cause: error }); }
    assertRequest(exec, scope);
    const durable = root.events.filter(e => e.type === 'team/member' && e.data.teamId === actor.teamId && e.data.member?.name === slot.name).at(-1)?.data.member;
    const descriptors = child.events.filter(e => e.type === 'subagent/descriptor');
    const descriptor = descriptors[0]?.data;
    if (root.header.id !== actor.rootSessionId || root.header.createdAt !== actor.rootCreatedAt || root.header.isSeeded !== false || root.inherited !== 0 ||
        durable?.id !== member.id || durable.context !== 'fresh' || durable.provider !== 'spawn' || durable.phase !== 'active' ||
        child.header.id !== member.id || child.header.parentSession !== actor.rootSessionId || child.header.isSeeded !== false || child.inherited !== 0 ||
        !Number.isSafeInteger(child.header.createdAt) || child.header.createdAt < 1 ||
        (slot.createdAt && slot.createdAt !== child.header.createdAt) ||
        descriptors.length !== 1 || descriptor.version !== 3 || descriptor.mode !== 'continuable' || descriptor.provider !== 'spawn' ||
        descriptor.agentProvider !== TEAM_PROVIDER || descriptor.agentModel !== currentRoute(exec.agent).model)
      throw new Error('持久父子身份、原生 roster 或继续执行描述不符，成员尚未恢复。');
    const current = originalMember(exec.agent, slot);
    if (current.id !== member.id) throw new Error('核对期间原成员身份变化，尚未恢复。');
    const resident = ctx.agents.get(member.id);
    if (resident && (live(resident).root !== exec.agent || resident.session.header.createdAt !== child.header.createdAt))
      throw new Error('活动成员与持久身份不符，尚未恢复。');
    return { actor: { ...actor, sessionId: member.id, createdAt: child.header.createdAt, role: slot.role, name: slot.name }, events: child.events };
  }
  async function recoverMember(actor, task, plannedSlot, exec, scope) {
    const fence = () => assertRequest(exec, scope);
    const current = await stateFor(exec.agent);
    let slot = current.task?.teamAnalysis.members.find(s => s.role === plannedSlot.role);
    if (current.task?.taskId !== task.taskId || slot?.nativeTaskId !== plannedSlot.nativeTaskId) throw new Error('原任务登记变化，成员尚未恢复。');
    const needed = !slot.sessionId;
    const member = originalMember(exec.agent, slot);
    const proof = needed ? await proveMember(actor, slot, exec, scope) : null;
    const child = proof?.actor ?? { ...actor, sessionId: slot.sessionId, createdAt: slot.createdAt, role: slot.role, name: slot.name };
    const effectId = 'member-recovery-' + slot.role, payload = { sessionId: child.sessionId, createdAt: child.createdAt, nativeTaskId: slot.nativeTaskId };
    const identityFence = () => {
      fence();
      const original = originalMember(exec.agent, slot), resident = ctx.agents.get(child.sessionId);
      if (original.id !== child.sessionId || (resident && (live(resident).root !== exec.agent || resident.session.header.createdAt !== child.createdAt)))
        throw new Error('登记或恢复前原成员身份变化，尚未恢复。');
      return original;
    };
    fence();
    // Persist the recovery intent BEFORE registration. A crash after member
    // registration must not erase the fact that a wake-up is still unresolved.
    let receipt;
    try { receipt = await call('effect-start', actor, { effectId, payload }); }
    catch (error) { throw new Error('成员恢复意图回执未知，尚未恢复；不自动重发。', { cause: error }); }
    identityFence();
    if (needed) {
      let registered;
      try { registered = await call('member', child, {}, exec.signal); }
      catch (error) { throw new Error('原成员登记回执未知，尚未恢复；未发送恢复消息。', { cause: error }); }
      fence();
      slot = registered.task?.teamAnalysis.members.find(s => s.role === child.role);
      if (registered.task?.taskId !== task.taskId || slot?.sessionId !== child.sessionId || slot.createdAt !== child.createdAt || slot.nativeTaskId !== payload.nativeTaskId)
        throw new Error('原成员登记回执未核实，尚未恢复；恢复意图保留未知。');
      conversations.referenceTeam(child.sessionId, registered.task);
    }
    const leadName = ctx.agentTeams.listMembers(exec.agent).find(m => m.id === actor.rootSessionId && m.role === 'lead')?.name;
    if (!leadName) throw new Error('原 Lead 身份未核实，成员尚未恢复。');
    const body = `恢复原成员登记 ${task.taskId}/${slot.role}，Session ${child.sessionId}，固定版本 ${task.projectRevision}。继续原分工；先核对工程任务，已有报告仅核对回执，不创建替代任务或成员。`;
    const unknown = { unknown: true, registered: true, reason: '原成员已登记；恢复投递未确认，尚不能确认继续执行，不自动重发。' };
    const durableReceipt = async expectedId => {
      let saved;
      try { saved = await proveMember(actor, slot, exec, scope); }
      catch { fence(); return null; }
      const ids = new Set();
      const expected = [{ type: 'text', text: `Team message from ${leadName}:` }, { type: 'text', text: body }];
      const check = message => {
        if (typeof message?.id === 'string' && message.source?.kind === 'agent-message' && message.source.form === 'relay' &&
            message.source.senderSessionId === actor.rootSessionId && JSON.stringify(message.content) === JSON.stringify(expected)) ids.add(message.id);
      };
      for (const event of saved.events) {
        if (event.type === 'user/message') check(event.data);
        if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted ?? []) check(message);
      }
      if (ids.size > 1) throw new Error('恢复消息存在多个编号，投递未知；不重发。');
      if (!ids.size || (expectedId !== undefined && !ids.has(expectedId))) return null;
      return { registered: true, activation: 'accepted', messageId: [...ids][0], durable: true };
    };
    let result = receipt.result;
    if (!receipt.send && (!result || result.activation === 'accepted')) {
      // Also revalidate legacy 0.4.7 accepted receipts: acceptance alone was not
      // a durability barrier and must not become proof merely by reopening.
      if (result && typeof result.messageId !== 'string') return unknown;
      result = await durableReceipt(result?.messageId);
      if (!result) return unknown;
    } else if (receipt.send) {
      const ready = identityFence();
      result = { registered: true, activation: ready.status === 'running' ? 'running' : 'already-registered' };
      if (needed && ready.status === 'inactive' && !slot.reportDigest) {
        try {
          const sent = await ctx.agentTeams.sendMessage(exec.agent, { target: member.name, content: [{ type: 'text', text: body }], signal: exec.signal });
          if (typeof sent?.messageId !== 'string') return unknown;
          // Native sendMessage only acknowledges admission. The exact child's
          // buffered log must flush and contain this same id before effect-finish.
          result = await durableReceipt(sent.messageId);
          if (!result) return unknown;
        } catch { return unknown; }
      }
    }
    identityFence();
    if (!receipt.result) await call('effect-finish', actor, { effectId, payload, result });
    return result;
  }
  async function deploy(agent, task, exec, scope) {
    const { signal } = exec, fence = () => assertRequest(exec, scope);
    const actor = await authority(agent), recovery = [];
    for (const slot of task.teamAnalysis.members) {
      fence();
      const subject = task.taskId + '/' + slot.role;
      const description = `工程 ${task.projectId}\n固定版本 ${task.projectRevision}\n${slot.instruction}`;
      const writeScopes = [`${taskScope(task)}/${task.taskId}/${slot.role}.json`];
      const matches = ctx.agentTeams.listTasks(agent).filter(t => t.subject === subject);
      let native = matches[0];
      if (matches.length > 1 || (slot.nativeTaskId && native?.id !== slot.nativeTaskId) ||
          (native && (native.description !== description || JSON.stringify(native.writeScopes) !== JSON.stringify(writeScopes))))
        throw new Error('原生团队任务身份或内容与工程分工不符；不创建替代任务。');
      if (!native) {
        const result = await effect(actor, 'native-task-' + slot.role, { subject, description }, () => ctx.agentTeams.createTask(agent, {
          subject, description, writeScopes,
        }), fence);
        if (result.unknown) throw new Error('原生任务登记待核对；未创建替代任务。');
        native = result;
      }
      fence();
      await call('native-task', actor, { role: slot.role, nativeTaskId: native.id });
      fence();
      const members = ctx.agentTeams.listMembers(agent).filter(m => m.name === slot.name);
      let member = members[0];
      if (members.length > 1 || (slot.sessionId && member?.id !== slot.sessionId)) throw new Error('原生成员身份不符；不创建替代成员。');
      if (!member) {
        const result = await effect(actor, 'spawn-' + slot.role, { name: slot.name, nativeTaskId: native.id }, () => ctx.agentTeams.spawnTeammate(agent, {
          name: slot.name, description: slot.role.toUpperCase() + (generationTask(task) ? ' 专业产物' : ' 专业分析'), context: 'fresh', provider: 'spawn', signal,
          prompt: [{ type: 'text', text: `你负责 ${slot.role}。工程任务 ${task.taskId}；工程 ${task.projectId}；固定版本 ${task.projectRevision}。\n${slot.instruction}\n${generationTask(task) ? '先读取本角色专业接口及生成契约，再使用本角色生成工具提交 proposal；服务生成独立原生产物与确定性回执。不能生成其他角色产物，不修改源工程，不编译或运行。' : '先读取本角色专业接口，再提交独立分析和未验证项。不修改源文件。'}` }],
        }), fence);
        if (result.unknown) throw new Error('成员创建意图待核对；未新建替代成员。');
        member = result.member;
      }
      fence();
      if (member.context !== 'fresh' || !['running', 'inactive', 'provisioning'].includes(member.status)) throw new Error('原生成员不可用；保留原编号待核对。');
      const result = await recoverMember(actor, task, { ...slot, nativeTaskId: native.id }, exec, scope);
      recovery.push({ role: slot.role, ...result });
      if (result.unknown) break;
    }
    return { task: (await stateFor(agent)).task, recovery };
  }
  async function plan(args, exec, turn) {
    const current = await context(exec.agent), actor = current.actor;
    assertRequest(exec, turn);
    if (turn.requestBinding.projectId !== current.projectId || args.contextToken !== current.contextToken) throw new Error('工程绑定或固定版本已变化；请关联原工程并重新核对上下文，旧团队不会转投新工程。');
    if (!turn || turn.projectId !== current.projectId || turn.bindingVersion !== current.bindingVersion) throw new Error('本轮工程身份未核验。');
    if (current.task && current.task.teamAnalysis.members.some(slot => args[slot.role + 'Instruction'] !== slot.instruction))
      throw new Error('恢复必须保留原任务的原分工；不重新规划或改写任务。');
    if (activePlans.has(actor.rootSessionId)) return activePlans.get(actor.rootSessionId);
    const work = (async () => {
      // Existing TaskService acceptance survives A -> B -> A and restarts.
      // Reconcile its original assignments; never send a second create request.
      const generating = generationRoute(exec.agent);
      const response = current.task ? current : await call(generating ? 'create-generation' : 'create', actor, { projectId: current.projectId, expectedRevision: current.projectRevision,
        request: turn.request, clientRequestId: 'team-' + hash([actor.rootSessionId, actor.rootCreatedAt]),
        bindingVersion: current.bindingVersion, assignments: { plc: args.plcInstruction, hmi: args.hmiInstruction, ...(generating ? { oip: args.oipInstruction } : {}) } });
      conversations.referenceTeam(actor.rootSessionId, response.task);
      // A binding change while creation was accepted must not dispatch new members.
      assertRequest(exec, turn);
      const { task, recovery } = await deploy(exec.agent, response.task, exec, turn);
      exec.concludeTurn?.();
      const ok = recovery.length === task.teamAnalysis.members.length && recovery.every(r => r.registered && !r.unknown);
      return { ok, task, recovery, members: ctx.agentTeams.listMembers(exec.agent),
        next: ok ? '原成员身份登记已核对；恢复消息受理不等于分析完成，等待原生成员通知。' : '恢复尚未确认；保留原任务与成员，未知意图不重发。' };
    })();
    activePlans.set(actor.rootSessionId, work);
    try { return await work; } finally { activePlans.delete(actor.rootSessionId); }
  }
  async function professional(role, args, exec) {
    const { actor, task } = await stateFor(exec.agent);
    if (actor.role !== role) throw new Error('此会话没有该专业资源权限。');
    const result = await call('context', actor, args);
    const slot = task.teamAnalysis.members.find(s => s.role === role);
    const native = ctx.agentTeams.getTask(exec.agent, slot.nativeTaskId);
    if (native.status === 'pending' && !native.ownerName) await ctx.agentTeams.updateTask(exec.agent, { taskId: native.id, expectedRevision: native.revision, action: 'claim' });
    return result;
  }
  const noticeText = (actor, task, slot) => generationTask(task)
    ? `${actor.role} 已提交 ${task.taskId} 的独立原生产物。产物摘要 ${slot.componentDigest}，回执摘要 ${slot.reportDigest}。请从 TaskService 核对三端结果后组装候选；保留、编译与运行未执行。`
    : `${actor.role} 已提交 ${task.taskId} 的独立分析。报告摘要 ${slot.reportDigest}。请从 TaskService 核对结果；编译与运行未测。`;
  async function persistedNotice(actor, task, slot, exec) {
    // A send receipt can be lost after native acceptance. Only the exact
    // sender + task/digest body in the original Lead's durable log proves it.
    // Absence is not proof of non-delivery, so it must never authorize a resend.
    if (!ctx.sessions?.flush || !ctx.sessionPersistence?.open) return null;
    const { root } = live(exec.agent);
    await ctx.sessions.flush(root.session);
    exec.signal?.throwIfAborted();
    const handle = await ctx.sessionPersistence.open(actor.rootSessionId, 'read', { signal: exec.signal });
    try {
      if (handle.header.id !== actor.rootSessionId || handle.header.createdAt !== actor.rootCreatedAt || handle.inheritedEventCount)
        throw new Error('原生通知日志身份不符；保留未知投递，不重发。');
      const { events } = await handle.read(0, undefined, { signal: exec.signal });
      const ids = new Set();
      const check = message => {
        if (typeof message?.id !== 'string' || message.source?.kind !== 'agent-message' || message.source?.form !== 'relay' ||
            message.source.senderSessionId !== actor.sessionId) return;
        const expected = [{ type: 'text', text: `Team message from ${slot.name}:` }, { type: 'text', text: noticeText(actor, task, slot) }];
        if (JSON.stringify(message.content) === JSON.stringify(expected)) ids.add(message.id);
      };
      // Read committed acceptance events as well as consumed user messages.
      // The same id appearing in both is one delivery, not two.
      for (const event of events) {
        if (event.type === 'user/message') check(event.data);
        if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted ?? []) check(message);
      }
      live(exec.agent);
      if (ids.size > 1) throw new Error('发现多条不同编号的通知；保留未知状态，需核对重复投递。');
      return ids.size === 1 ? { messageId: [...ids][0] } : null;
    } finally { await handle.close(); }
  }
  async function finishReport(actor, task, exec) {
    const slot = task.teamAnalysis.members.find(s => s.role === actor.role);
    if (!slot?.reportDigest || !slot.report) throw new Error('尚无本角色的持久报告；不能完成原生任务。');
    exec.signal?.throwIfAborted(); live(exec.agent);
    const native = ctx.agentTeams.getTask(exec.agent, slot.nativeTaskId);
    const description = `工程 ${task.projectId}\n固定版本 ${task.projectRevision}\n${slot.instruction}`;
    if (native.id !== slot.nativeTaskId || native.subject !== task.taskId + '/' + actor.role || native.description !== description ||
        native.ownerName !== slot.name || !['in_progress', 'completed'].includes(native.status) ||
        JSON.stringify(native.writeScopes) !== JSON.stringify([`${taskScope(task)}/${task.taskId}/${actor.role}.json`]))
      throw new Error('原生任务身份、归属或状态与持久报告不符；保留原记录待核对。');
    if (native.status !== 'completed') await ctx.agentTeams.updateTask(exec.agent, { taskId: native.id, expectedRevision: native.revision, action: 'complete' });
    exec.signal?.throwIfAborted(); live(exec.agent);
    const leadName = ctx.agentTeams.listMembers(exec.agent).find(m => m.role === 'lead' && m.id === actor.rootSessionId)?.name;
    if (!leadName) throw new Error('原生 Lead 归属尚未核对；未投递报告通知。');
    const effectId = 'report-notice-' + actor.role, payload = { reportDigest: slot.reportDigest };
    let notice = await effect(actor, effectId, payload, async () => {
      const result = await ctx.agentTeams.sendMessage(exec.agent, {
        target: leadName, content: [{ type: 'text', text: noticeText(actor, task, slot) }], signal: exec.signal,
      });
      if (ctx.sessions?.flush) await ctx.sessions.flush(live(exec.agent).root.session);
      return result;
    });
    if (notice.unknown) {
      const receipt = await persistedNotice(actor, task, slot, exec);
      if (receipt) {
        await call('effect-finish', actor, { effectId, payload, result: receipt });
        notice = receipt;
      }
    }
    const current = await stateFor(exec.agent);
    exec.concludeTurn?.();
    return { ok: !notice.unknown, task: current.task, notification: notice };
  }
  async function report(args, exec) {
    validateReport(args.report);
    const { actor } = await stateFor(exec.agent);
    if (actor.role === 'lead') throw new Error('Lead 不能冒名提交专业成员报告。');
    const result = await call('report', actor, args);
    return finishReport(actor, result.task, exec);
  }
  async function reconcile(args, exec) {
    const { actor, task } = await stateFor(exec.agent);
    if (!task || Object.keys(identityFields).some(key => args[key] !== task[key])) throw new Error('恢复必须使用原工程、固定版本和原任务编号。');
    return finishReport(actor, task, exec);
  }
  async function generate(role, args, exec) {
    const { actor, task } = await stateFor(exec.agent);
    if (actor.role !== role || !generationTask(task)) throw new Error('此原生会话没有本角色产物生成权限。');
    const result = await call('generate', actor, args, exec.signal);
    live(exec.agent);
    return finishReport(actor, result.task, exec);
  }
  async function assemble(args, exec, scope) {
    const { actor, task } = await stateFor(exec.agent);
    assertRequest(exec, scope);
    if (actor.role !== 'lead' || !generationTask(task) || Object.keys(identityFields).some(key => args[key] !== task[key]))
      throw new Error('组装必须使用原工程、固定版本和原生成任务。');
    const result = await call('assemble', actor, args, exec.signal);
    assertRequest(exec, scope);
    conversations.referenceTeam(actor.rootSessionId, result.task);
    exec.concludeTurn?.();
    return result;
  }
  function define(name, title, description, properties, execute) {
    return { name, description, parameters: object(properties), output: { schema: string, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => { try { const { task } = JSON.parse(value); return task ? { projectId: task.projectId, taskId: task.taskId } : {}; } catch { return {}; } } },
      presentCall: () => ({ card: 'generic', title, kind: ['plcdev_team_plan','plcdev_team_generate_plan','plcdev_team_assemble','plcdev_plc_generate','plcdev_hmi_generate','plcdev_oip_generate','plcdev_team_report','plcdev_team_reconcile','plcdev_team_control'].includes(name) ? 'edit' : 'read' }), isConcurrencySafe: () => false,
      async execute(args, exec) {
        exact(args, Object.keys(properties)); exec.signal?.throwIfAborted();
        // Capture before the first await, so a newer model turn cannot lend its
        // stable binding to a delayed tool call from an earlier response.
        const scope = leadMutations.has(name) && live(exec.agent).role === 'lead' ? requestScope(exec, name) : null;
        const actor = await authority(exec.agent);
        if (!allowedTools(exec.agent)[actor.role]?.includes(name)) throw new Error('原生会话角色不能执行该工具。');
        if (scope) assertRequest(exec, scope);
        return JSON.stringify(await execute(args, exec, scope));
      } };
  }
  const tools = [
    define('plcdev_team_context', '核对原生团队工程', 'Lead: read bound project/revision, existing pinned task and contextToken. No PLC actions.', {}, (_a, e) => context(e.agent)),
    define('plcdev_team_plan', '分派 PLC／HMI 原生成员', 'Lead: create one fixed-version analysis task, or recover deployment of the existing original task using its exact saved instructions and a fresh contextToken while bound to its original project. Reconcile existing native tasks/members; never recreate them or replan. Ends this turn; wait for notifications.',
      { contextToken: string, plcInstruction: string, hmiInstruction: string }, plan),
    define('plcdev_team_generate_plan', '分派 PLC／HMI／OIP 原生产物', 'Generation Lead only: create one fixed-version task for three independent native members. Each role reads and generates only its own native artifact. Recover only original assignments and members with a fresh contextToken. Ends this turn; wait for notifications. Never keep, compile or run.',
      { contextToken: string, plcInstruction: string, hmiInstruction: string, oipInstruction: string }, plan),
    define('plcdev_team_assemble', '组装三端联合候选', 'Generation Lead only: assemble the three persisted, same-version role artifacts into one reviewable candidate. This does not keep, compile or run it. Human review is required. No alternative joint generator is called.', identityFields, assemble),
    define('plcdev_team_status', '收回团队分析', 'Lead: read the original pinned engineering task, reports and real native task board. Call once per notification; never poll.', {}, async (_a, e) => ({ ...await stateFor(e.agent), members: ctx.agentTeams.listMembers(e.agent), nativeTasks: ctx.agentTeams.listTasks(e.agent) })),
    define('plcdev_team_control', '中断／继续专业成员', 'Lead, only on explicit user request: interrupt a member or resume the same inactive unfinished member, including after host restart or a rejected report. Resume does not require a prior interrupt event. Never resume an already running member or recreate it. Stable requestId deduplicates; unknown delivery is never retried automatically.',
      { role: { type: 'string', enum: ['plc', 'hmi', 'oip'] }, action: { type: 'string', enum: ['interrupt', 'resume'] }, requestId: string }, async (a, e, turn) => {
        const { actor, task } = await stateFor(e.agent);
        if (!(generationTask(task) ? ['plc','hmi','oip'] : ['plc','hmi']).includes(a.role) || !['interrupt','resume'].includes(a.action) || !/^[A-Za-z0-9_-]{1,80}$/.test(a.requestId)) throw new Error('成员控制请求无效。');
        assertRequest(e, turn);
        if (!turn?.controlRequested || turn.controlRole !== a.role || turn.controlAction !== a.action) throw new Error('当前用户消息没有明确要求对该成员执行此动作。');
        const slot = task?.teamAnalysis.members.find(m => m.role === a.role);
        if (!slot?.sessionId) throw new Error('成员尚未登记。');
        if (slot.reportDigest && a.action === 'interrupt') throw new Error('报告已持久化；仅可继续核对回执，不再中断分析。');
        if (slot.reportDigest && slot.notice === 'accepted' && ctx.agentTeams.getTask(e.agent, slot.nativeTaskId).status === 'completed')
          throw new Error('成员已完成报告与原生回执核对，无需重复控制。');
        const nativeMember = ctx.agentTeams.listMembers(e.agent).find(member => member.id === slot.sessionId && member.name === slot.name);
        if (!nativeMember || nativeMember.context !== 'fresh') throw new Error('原生成员身份尚未核对，未发送控制。');
        if (a.action === 'resume' && nativeMember.status !== 'inactive')
          throw new Error(nativeMember.status === 'running' ? '成员正在运行，不重复发送继续请求。' : '成员当前状态不可恢复，须先核对原生登记。');
        const result = await effect(actor, 'control-' + turn.controlId, { role: a.role, action: a.action }, async () => a.action === 'interrupt' ? ctx.agentTeams.interrupt(e.agent, slot.name) : ctx.agentTeams.sendMessage(e.agent, {
          target: slot.name, content: [{ type: 'text', text: '用户明确要求继续原任务。核对 TaskService 原编号；报告已登记则只调用 plcdev_team_reconcile 核对原生任务和通知，否则继续本角色分析。不新建任务或改写已登记报告。' }], signal: e.signal,
        }), () => assertRequest(e, turn));
        return { ok: !result.unknown, task, result };
      }),
    define('plcdev_plc_analyze', '读取 PLC 专业资源', 'PLC member only: read fixed native PLC declarations, function blocks, LD semantic projection and bindings. Returns contextDigest required for report.', identityFields, (a,e) => professional('plc',a,e)),
    define('plcdev_hmi_analyze', '读取 HMI 专业资源', 'HMI member only: read fixed FUXA widget properties and bindings. Returns contextDigest required for report. Script bodies and geometry are omitted.', identityFields, (a,e) => professional('hmi',a,e)),
    define('plcdev_oip_analyze', '读取 OIP 专业资源', 'OIP generation member only: read the fixed native scene and its bounded generation contract. Only existing conveyor speed is supported; no new geometry, material simulation or scene Run.', identityFields, (a,e) => professional('oip',a,e)),
    define('plcdev_plc_generate', '生成 OpenPLC 原生产物', 'PLC generation member only: use contextDigest from own resource read. Propose batch-default-target value 1..1000; preserve native LD structure and bindings. Persist one immutable artifact; complete native task and notify Lead. Reconcile an existing receipt instead of regenerating.',
      { ...identityFields, contextDigest: string, proposal: object({ operation: { type: 'string', enum: ['batch-default-target'] }, value: { type: 'integer', minimum: 1, maximum: 1000 } }) }, (a,e) => generate('plc',a,e)),
    define('plcdev_hmi_generate', '生成 FUXA 原生画面', 'HMI generation member only: use contextDigest and the proposalSchema/allowedSpec returned by own resource read. Generate an editable native-page preserving existing tag and action permissions. spec is validated server-side; never add PLC/sensor write permissions. Persist once; no keep/compile/run.',
      { ...identityFields, contextDigest: string, proposal: object({ operation: { type: 'string', enum: ['native-page'] }, defaultTarget: { type: 'integer', minimum: 1, maximum: 1000 }, spec: { type: 'object', description: 'Exact HMI spec shape from the current professional context allowedSpec; validated by TaskService.' } }) }, (a,e) => generate('hmi',a,e)),
    define('plcdev_oip_generate', '生成 OIP 原生产物', 'OIP generation member only: use contextDigest and conveyorId from own read. Change existing unbound conveyor-speed only (0.1..3 m/s). No geometry edits, new scene or scene Run. Persist once; reconcile existing receipt.',
      { ...identityFields, contextDigest: string, proposal: object({ operation: { type: 'string', enum: ['conveyor-speed'] }, partId: string, value: { type: 'number', minimum: 0.1, maximum: 3 } }) }, (a,e) => generate('oip',a,e)),
    define('plcdev_team_report', '提交独立专业分析', 'Member only, after professional read: persist immutable role report to original TaskService task, complete native task and notify Lead once. Bounds: summary 1-2000 characters; findings and unverified each 1-12 strings, each string 1-1000 characters. Merge related findings to stay within these limits. Validation rejection means no report was submitted; correct the bounds and resubmit. This is analysis, not generation/compile/run.',
      { ...identityFields, contextDigest: string, report: object(reportFields) }, report),
    define('plcdev_team_reconcile', '核对报告与原生任务回执', 'Member only, when report is already persisted: reconcile its original native task and notification without rewriting the report. Unknown delivery is never resent. Ends this turn.', identityFields, reconcile),
  ];
  function guard(exec) {
    const nameIsTeam = tools.some(t => t.name === exec.name);
    // A pending switch cannot authorize an old team request to dispatch
    // generic tools before a new request header commits the other route.
    const isTeam = currentRoute(exec.agent)?.provider === TEAM_PROVIDER || exec.agent?.session?.requestHeader?.()?.config?.provider === TEAM_PROVIDER;
    if (!nameIsTeam && !isTeam) return;
    try {
      const m = live(exec.agent), actor = registered.get(exec.agent);
      if (!actor || actor.rootSessionId !== m.root.session.id || (m.role !== 'lead' && actor.name !== m.name)) throw new Error('团队工具尚未核对真实角色登记。');
      if (!allowedTools(exec.agent)[actor.role]?.includes(exec.name)) throw new Error('此团队角色只允许自己的受控专业工具；不能执行通用文件、Shell、其他工程或原生管理工具。');
      if (leadMutations.has(exec.name)) requestScope(exec, exec.name);
    } catch (error) { return error.message; }
  }
  const info = (model = TEAM_MODEL) => ({ provider: TEAM_PROVIDER, id: model, name: model === TEAM_GENERATION_MODEL ? 'DeepSeek · PLCdev 三端生成团队' : 'DeepSeek · PLCdev 原生团队', inputModalities: ['text'], description: model === TEAM_GENERATION_MODEL ? '首批范围：PLC 批次初始目标、FUXA 原生页面、OIP 既有输送带速度；固定版本独立产物与人工审阅。' : '原生 Lead / PLC / HMI，固定工程版本，仅分析。' });
  const adapter = {
    providerInfo: () => ({ id: TEAM_PROVIDER, name: 'PLCdev 原生团队' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 }),
    imageRequestPricing: () => undefined, imageRequestTarget: () => { throw new Error('团队模型不发送图片。'); },
    async listModels(p) { return p === TEAM_PROVIDER ? [info(), info(TEAM_GENERATION_MODEL)] : []; },
    async resolveModel(p,m,s) { s?.throwIfAborted(); if(p!==TEAM_PROVIDER||![TEAM_MODEL, TEAM_GENERATION_MODEL].includes(m))throw new Error('未知团队模型。'); return info(m); },
    async prepareCall(p,m,s) { return { model: await adapter.resolveModel(p,m,s), stream: options => adapter.stream(options) }; },
    async *stream(options) {
      if (options.provider !== TEAM_PROVIDER || ![TEAM_MODEL, TEAM_GENERATION_MODEL].includes(options.model) || options.purpose) throw new Error('团队模型仅用于本路由的原生会话。');
      const agent = ctx.agents.get(options.sessionId), state = await stateFor(agent), { actor } = state;
      if (currentRoute(agent).model !== options.model) throw new Error('原生团队模型已切换，旧请求未发送。');
      const root = actor.role === 'lead' ? await context(agent) : null;
      const requestBinding = actor.role === 'lead' ? conversations.snapshot(actor.rootSessionId) : null;
      const human = [...options.messages].reverse().find(m => m.role === 'user' && (!m.source || m.source.kind === 'user'));
      const request = state.task?.request ?? text(human);
      if (!request || (!state.task && human?.content?.some(b=>b.type!=='text'))) throw new Error('需要本轮明确的文字分析需求。');
      const control = actor.role === 'lead' && /^(?:请)?(中断|继续|恢复)\s*(PLC|HMI|OIP)\s*成员[。.!！]?$/i.exec(text(human).trim());
      const scope = { request, model: options.model, requestBinding: requestBinding && { projectId: requestBinding.projectId, version: requestBinding.version },
        projectId: state.task?.projectId ?? root.projectId, bindingVersion: state.task?.teamAnalysis.bindingVersion ?? root.bindingVersion,
        controlRequested: !!control, controlRole: control ? control[2].toLowerCase() : null,
        controlAction: control ? (control[1] === '中断' ? 'interrupt' : 'resume') : null,
        controlId: control ? hash([actor.sessionId, human.id ?? text(human), control[1], control[2]]) : null };
      turns.set(actor.sessionId, scope);
      const slot = state.task?.teamAnalysis.members.find(m => m.role === actor.role);
      const brief = actor.role === 'lead' ? { role: 'lead', projectId: scope.projectId, taskId: state.task?.taskId, bindingChanged: root.bindingChanged,
        userControlRequest: scope.controlRequested ? text(human) : undefined,
        memberStates: root.memberStates ?? [],
        requestedControl: scope.controlRequested ? { role: scope.controlRole, action: scope.controlAction, requestId: scope.controlId } : undefined,
        next: scope.controlRequested
          ? '用户已明确要求上述成员控制。先核对 memberStates，再调用 plcdev_team_control，参数使用 requestedControl。继续表示恢复同一个 inactive 且未完成的原生成员，包含宿主重开或报告校验失败，不要求先有 interrupt 事件。running 成员不重复继续，全部回执已完成则无需控制；状态未知须报告。不要新建成员，不要仅以已分派或尚未回报为由拒绝恢复。'
          : state.task ? '按原任务读取团队状态；不重新规划。原任务已受理但原生成员未派发齐时，关联原工程，读取 plcdev_team_context，再以原分工和新 contextToken 调用 plcdev_team_plan 恢复派发。已登记成员只核对，不重建。' : '先核对上下文，再分别分派 PLC/HMI。' } : {
        role: actor.role, taskId: state.task.taskId, projectId: state.task.projectId, projectRevision: state.task.projectRevision, instruction: slot.instruction,
        submitted: !!slot.reportDigest, next: slot.reportDigest ? '报告已有持久回执；只调用 plcdev_team_reconcile 核对原生任务与通知，不重新分析或提交报告，然后结束。' : '读取自己的专业接口再提交独立报告。',
      };
      if (generationRoute(agent)) {
        brief.workflow = 'team-generation-v1';
        if (actor.role === 'lead' && !scope.controlRequested) brief.next = state.task
          ? '按原任务读取三个成员的持久产物与回执。分派未齐时用原分工和新 contextToken 调用 plcdev_team_generate_plan 恢复；不可重建。三产物齐全后只调用 plcdev_team_assemble 组装一次，交用户保留/撤销/编译。已有 candidate 则直接引导审阅，不重新组装。不运行 PLC。'
          : '先调用 plcdev_team_context，然后 plcdev_team_generate_plan 分派 PLC/HMI/OIP 三名原生成员。每个角色只生成本工具原生产物，OIP 仅支持现有输送带速度；不调用联合生成器。';
        if (actor.role !== 'lead') brief.next = slot.reportDigest
          ? '本角色原生产物与确定性回执已持久化；仅调用 plcdev_team_reconcile 核对原任务和通知。不重新生成或提交分析报告。'
          : '先读取自己的专业接口及 generationContract/proposalSchema/allowedSpec，再调用本角色 generate 工具，严格沿用 contextDigest 和限定操作。只生成自己一端，不调用其他角色或联合生成器。服务回执不代表编译或运行通过。';
      }
      const names = new Set(allowedTools(agent)[actor.role]);
      const messages = [{ role: 'user', content: request + '\n' + JSON.stringify(brief) }];
      const calls = new Set();
      // Only this route's own tool history in the current turn. Host prompts,
      // workspace files, inherited conversations and team-message bodies omitted.
      let start = -1;
      for (let i=0;i<options.messages.length;i++) if(options.messages[i].role==='user')start=i;
      for (const m of options.messages.slice(start+1)) {
        if (m.role === 'assistant' && m.source?.provider === TEAM_PROVIDER) {
          const tool_calls = (m.content??[]).filter(b=>b.type==='tool-call'&&names.has(b.name)).map(b=>{calls.add(b.id);return {id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}};});
          if(tool_calls.length)messages.push({role:'assistant',content:text(m)||null,tool_calls});
        } else if(m.role==='tool'&&calls.has(m.source?.callId)) messages.push({role:'tool',tool_call_id:m.source.callId,content:text(m)});
      }
      const schemas = (options.tools??[]).filter(t=>names.has(t.name)).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));
      if(schemas.length!==names.size)throw new Error('团队专业工具未完整注册。');
      const result = await call('model', actor, { projectId: scope.projectId, messages, tools: schemas, maxTokens: generationRoute(agent) && actor.role === 'hmi' ? 8192 : 4096 }, options.signal);
      options.signal?.throwIfAborted(); live(agent);
      if (currentRoute(agent).model !== options.model) throw new Error('模型请求期间团队路由变化，旧响应未执行。');
      if(turns.get(actor.sessionId)!==scope)throw new Error('团队会话已经变化，旧响应未执行。');
      if(actor.role==='lead'){
        const binding=conversations.snapshot(actor.rootSessionId);
        if(binding.projectId!==requestBinding.projectId||binding.version!==requestBinding.version)throw new Error('模型请求期间工程改绑，旧响应未执行；原任务保留原工程。');
      }
      const choice=result.completion?.choices?.[0], message=choice?.message;
      if(!message||!['stop','tool_calls','length',undefined,null].includes(choice.finish_reason))throw new Error('团队模型响应无效。');
      if (generationRoute(agent) && choice.finish_reason === 'length') throw new Error('生成响应达到长度上限；未执行截断结果，请缩小画面需求后核对原任务。');
      const blocks=[],ids=new Set();
      if(typeof message.content==='string'&&message.content)blocks.push({type:'text',text:message.content});
      for(const c of message.tool_calls??[]){
        if(c.type!=='function'||!names.has(c.function?.name)||typeof c.id!=='string'||ids.has(c.id)||typeof c.function.arguments!=='string')throw new Error('团队模型返回未授权调用。');
        JSON.parse(c.function.arguments);ids.add(c.id);blocks.push({type:'tool-call',id:c.id,name:c.function.name,arguments:c.function.arguments});
      }
      if (actor.role === 'lead') {
        const issued = issuedCalls.get(agent) ?? new Map();
        for (const block of blocks.filter(b => b.type === 'tool-call' && leadMutations.has(b.name))) {
          if (issued.has(block.id)) throw new Error('工具调用编号已使用；不接受跨请求复用。');
          issued.set(block.id, { name: block.name, scope });
        }
        issuedCalls.set(agent, issued);
      }
      for(let index=0;index<blocks.length;index++){
        const block=blocks[index];yield {type:'block-start',index,blockType:block.type};
        yield block.type==='text'?{type:'text-delta',index,text:block.text}:{type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};
        yield {type:'block-end',index,block};
      }
      yield {type:'finish',reason:{kind:blocks.some(b=>b.type==='tool-call')?'tool-calls':choice.finish_reason==='length'?'max-tokens':'stop'}};
    },
  };
  return { tools, guard, adapter, stateFor, authority };
}
