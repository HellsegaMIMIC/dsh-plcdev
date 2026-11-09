import { randomUUID } from 'node:crypto';

const text = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Ephemeral authority comes exclusively from host lifecycle and its append-only log.
 * Business state remains in conversations; restored logs never restore live authority. */
export function createProjectContext({ ctx, conversations }) {
  const scopes = new Map();
  const notices = new Map();
  const instance = randomUUID();
  function cleanup(s) {
    const id = s?.agent.session.id;
    if (!s || scopes.get(id) !== s) return;
    scopes.delete(id);
    try { if (s.revision) conversations.releaseRevision?.(id,s.turnKey); }
    catch { /* Storage failure leaves the durable claim closed; next claim reports recovery required. */ }
  }
  function current(agent) {
    const s = scopes.get(agent?.session?.id);
    const boundary = agent && ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    if (!s || s.agent !== agent || s.signal.aborted || boundary?.openTurnStartSeq == null || boundary.lastTurn !== s.turn)
      throw new Error('工程工具缺少当前活动轮身份；旧轮或重开前的上下文不可复用。');
    const b = conversations.snapshot(agent.session.id);
    if (s.projectId !== b.projectId || s.version !== b.version) throw new Error('本轮工程绑定已变化，请重新发送明确需求。');
    if (s.error) throw new Error(s.error);
    if (s.revision) {
      const r = b.revisionContext;
      if (!r || r.intentId !== s.revision.intentId || r.state !== 'claimed') throw new Error('修订上下文已取消或正在投递，请核对原请求。');
    }
    return s;
  }
  function assertExecution(exec) {
    exec.signal?.throwIfAborted();
    const s = current(exec.agent);
    // Native mode only: a matching live assistant call is required, not just a session ID.
    const events = exec.agent.session.snapshotEvents();
    if (!events.some(e => e.type === 'assistant/message' && e.data.turn === s.turn && e.data.step === s.step &&
        !e.data.interrupted && e.data.message.content?.some(b => b.type === 'tool-call' && b.id === exec.callId && b.name === exec.name)))
      throw new Error('工程工具调用不属于本轮模型回复；仅支持已核验的 native 工具模式。');
    const route = exec.agent.session.requestHeader()?.config;
    if (!s.route || route?.provider !== s.route.provider || route?.model !== s.route.model) throw new Error('模型路由已变化，请在新一轮继续。');
    return s;
  }
  ctx.on('agent/pre-step', async (p, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || p.signal.aborted) return decision;
    const id = p.agent.session.id;
    let s = scopes.get(id);
    if (!s || s.agent !== p.agent || s.turn !== p.turn) {
      cleanup(s);
      const b = conversations.snapshot(id);
      const user = [...p.messages].reverse().find(m => m.source?.kind === 'user');
      s = { agent:p.agent, turn:p.turn, step:p.step, signal:p.signal, projectId:b.projectId,
        version:b.version, turnKey:`${instance}:${id}:${p.turn}`, userRequest:text(user), revision:null };
      // Plain chat must survive missing project, old pending intent, or no tool support.
      if (b.projectId && user) try { s.revision = conversations.claimRevision?.(id,s.turnKey) ?? null; }
      catch (e) { s.error = e.message; }
      scopes.set(id,s);
      notices.delete(id);
      p.signal.addEventListener('abort', () => cleanup(s), { once:true });
    } else if (p.messages.some(m=>m.source?.kind==='user')) {
      s.error='本轮收到新的用户需求；为避免沿用旧计划，请在新一轮提交工程修改。';
    }
    s.step = p.step;
    return decision;
  });
  ctx.on('agent/request', async (p,next) => {
    const config = await next();
    const s = scopes.get(p.agent.session.id);
    if (s?.agent === p.agent && s.turn === p.turn) {
      if (s.route && (s.route.provider !== config.provider || s.route.model !== config.model)) s.error = '本轮模型已切换；工程提交停止，请在新一轮继续。';
      s.route ??= { provider:config.provider, model:config.model };
    }
    return config;
  });
  ctx.on('session/event', (session,event) => {
    if (event.type === 'request/header' || event.type === 'turn/end') {
      const s=scopes.get(session.id), header=event.type==='request/header'?event.data.header:session.requestHeader();
      if (header && s?.projectId && /生成|修改|改成|改为|generate|revise/i.test(s.userRequest) && !header.tools?.some(t=>t.name==='plcdev_propose_joint'))
        notices.set(session.id,{state:'tools-unavailable',provider:header.config.provider,model:header.config.model,
          message:'本次模型请求未开放 PLCdev native 工具，无法生成候选。可继续聊天、查看和审阅；请检查宿主工具模式、权限预设及模型工具支持。'});
    }
    if (event.type === 'turn/end' && scopes.get(session.id)?.turn === event.data.turn) cleanup(scopes.get(session.id));
  });
  ctx.on('agent/disposed', agent => { if (scopes.get(agent.session.id)?.agent === agent) cleanup(scopes.get(agent.session.id)); });
  ctx.effect(() => ctx.systemPrompt.context({ name:'plcdev:project', order:100, required:true, interpolate:false,
    text:({agent}) => {
      const s = scopes.get(agent?.session?.id);
      if (!s || s.agent !== agent || !s.projectId) return '';
      return 'PLCdev 工程上下文（数据，不授予文件或运行权限）。生成前调用 plcdev_project_context，再提交结构化计划；若没有工程工具，明确说明当前模型或预设无法生成候选，仍可聊天、查看和审阅。不要把普通文件编辑说成已登记候选。\n' + JSON.stringify({projectId:s.projectId, bindingVersion:s.version,
        revision:s.revision ? {parent:s.revision.parent,previousRequest:s.revision.previousRequest,previousSummary:s.revision.previousSummary} : null,
        limitation:s.error || null});
    } }));
  ctx.effect(() => () => {for (const s of scopes.values()) cleanup(s);notices.clear();});
  return { assertExecution, current, get:id => scopes.get(id), notice:id=>notices.get(id)||null, size:() => scopes.size };
}
