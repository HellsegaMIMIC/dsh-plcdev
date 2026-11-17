import { randomUUID } from 'node:crypto';
import { createModelCapabilityGate } from './model-capability.mjs';
import { PROJECT_WORKFLOW } from './project-workflow.mjs';

const text = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const unavailableMessages=Object.freeze({
  'model-unverified':'当前模型尚未接入 PLCdev 工程工具，暂时无法生成候选。请切换到已接入的模型后重新发送需求。',
  'executor-unsupported':'当前会话的工具执行模式尚未接入 PLCdev，暂时无法生成候选。请使用原生工具模式后重新发送需求。',
  'executor-unavailable':'当前会话的工具执行器不可用，暂时无法生成候选。请恢复宿主工具服务后重新发送需求。',
  'tools-filtered':'本次请求没有获得完整的工程工具，暂时无法生成候选。请检查会话的工具权限后重新发送需求。',
  'request-unverified':'本轮请求的工程工具状态未能核对，暂时无法生成候选。请在当前模型下重新发送需求。',
});

/** Ephemeral authority comes exclusively from host lifecycle and its append-only log.
 * Business state remains in conversations; restored logs never restore live authority. */
export function createProjectContext({ ctx, conversations, verifiedRoutes, getEditorPromptBinding }) {
  const scopes = new Map();
  const notices = new Map();
  const participating=agent=>{
    const id=agent?.session?.id;
    if(!id)return false;
    try{return typeof conversations.participation==='function'?conversations.participation(id).enabled===true:!!conversations.snapshot(id).projectId;}
    catch{return false;}
  };
  const capability = createModelCapabilityGate({ctx,verifiedRoutes,isParticipating:participating});
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
    if (!b.projectId || b.participation?.enabled===false) throw new Error('此会话尚未开启 PLCdev，请先选择工程。');
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
    if (!s.engineeringToolsAllowed || !capability.allows(exec.agent,route) || !exec.agent.session.requestHeader()?.tools?.some(t=>t.name===exec.name))
      throw new Error('本次模型或工具模式未经验证，未开放 PLCdev 工程工具；仍可聊天、查看和审阅。');
    conversations.lockParticipation?.(exec.agent.session.id,{projectId:s.projectId,version:s.version});
    return s;
  }
  ctx.on('agent/pre-step', async (p, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || p.signal.aborted) return decision;
    const id = p.agent.session.id;
    // An editor send can be durably queued before the user switches projects.
    // Reject its claimed input before any model request instead of treating the
    // old editor's words as a new request for the newly selected project.
    for(const message of p.messages){
      if(message.source?.kind!=='user'||!String(message.source.rpcId??'').startsWith('plcdev-openplc-'))continue;
      let expected,binding;
      try{expected=getEditorPromptBinding?.(id,message.source.rpcId);binding=conversations.snapshot(id);}catch{}
      if(!expected||!binding||expected.projectId!==binding.projectId||expected.version!==binding.version||expected.text!==text(message)){
        cleanup(scopes.get(id));
        if(binding)notices.set(id,{state:'tools-unavailable',reason:'editor-binding-changed',toolMode:'unknown',projectId:binding.projectId,bindingVersion:binding.version,
          message:'这条需求来自旧的 OpenPLC 工程连接，已停止处理。请从当前工程重新打开编辑器后发送。'});
        return {kind:'reject'};
      }
    }
    if(!participating(p.agent)){cleanup(scopes.get(id));notices.delete(id);return decision;}
    let s = scopes.get(id);
    if (!s || s.agent !== p.agent || s.turn !== p.turn) {
      cleanup(s);
      const b = conversations.snapshot(id);
      const user = [...p.messages].reverse().find(m => m.source?.kind === 'user');
      s = { agent:p.agent, turn:p.turn, step:p.step, signal:p.signal, projectId:b.projectId,
        version:b.version, turnKey:`${instance}:${id}:${p.turn}`, userRequest:text(user), revision:null };
      // Plain chat must survive missing project, old pending intent, or no tool support.
      if (b.projectId && user && capability.eligible(p.agent)) try { s.revision = conversations.claimRevision?.(id,s.turnKey) ?? null; }
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
    const allowed = capability.request(p.agent,config);
    const s = scopes.get(p.agent.session.id);
    if (s?.agent === p.agent && s.turn === p.turn) {
      if (s.route && (s.route.provider !== config.provider || s.route.model !== config.model)) s.error = '本轮模型已切换；工程提交停止，请在新一轮继续。';
      s.route ??= { provider:config.provider, model:config.model };
      s.engineeringToolsAllowed = allowed;
    }
    return config;
  },{prepend:true});
  ctx.on('session/event', (session,event) => {
    if (event.type === 'request/header' || event.type === 'turn/end') {
      const s=scopes.get(session.id), header=event.type==='request/header'?event.data.header:session.requestHeader();
      const binding=s?.projectId?conversations.snapshot(session.id):null;
      if (header && s?.projectId && binding?.projectId===s.projectId && binding.version===s.version && /添加|生成|修改|改成|改为|generate|revise/i.test(s.userRequest)) {
        const available=header.tools?.some(t=>t.name==='plcdev_project_context') && header.tools?.some(t=>['plcdev_propose_joint','plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text','plcdev_propose_hmi_readonly_value','plcdev_propose_project_edit'].includes(t.name));
        if(available)notices.delete(session.id);
        else {
          const diagnosis=capability.diagnose(s.agent,header.config),reason=diagnosis.reason??'tools-filtered';
          notices.set(session.id,{state:'tools-unavailable',reason,toolMode:diagnosis.toolMode,
            projectId:s.projectId,bindingVersion:s.version,provider:header.config?.provider,model:header.config?.model,
            message:unavailableMessages[reason]});
        }
      }
    }
    if (event.type === 'turn/end' && scopes.get(session.id)?.turn === event.data.turn) {const s=scopes.get(session.id);cleanup(s);capability.clear(s.agent);}
  });
  ctx.on('agent/disposed', payload => { const agent=payload?.agent ?? payload; if (scopes.get(agent?.session?.id)?.agent === agent) cleanup(scopes.get(agent.session.id)); capability.clear(agent); });
  // Host contexts are user-role snapshots. Engineering workflow is a system
  // instruction and must also exist on the FIRST assembly, before pre-step
  // creates the ephemeral execution scope or capability admission completes.
  ctx.effect(() => ctx.systemPrompt.section({name:'plcdev:workflow',order:650,interpolate:false,
    text:({agent}) => participating(agent) && conversations.snapshot(agent.session.id).projectId ? PROJECT_WORKFLOW : '',
  }));
  ctx.effect(() => ctx.systemPrompt.context({ name:'plcdev:project', order:100, required:true, interpolate:false,
    text:({agent}) => {
      const s = scopes.get(agent?.session?.id);
      if (!s || s.agent !== agent || !s.projectId || !participating(agent) || !capability.eligible(agent)) return '';
      return 'PLCdev 当前工程数据（不授予文件或运行权限）：\n' + JSON.stringify({projectId:s.projectId, bindingVersion:s.version,
        revision:s.revision ? {parent:s.revision.parent,workflow:s.revision.workflow||'joint-ai-v1',target:s.revision.target,previousRequest:s.revision.previousRequest,previousSummary:s.revision.previousSummary} : null,
        limitation:s.error || null});
    } }));
  ctx.effect(() => () => {for (const s of scopes.values()) cleanup(s);notices.clear();});
  function notice(id) {
    const entry=notices.get(id);
    if(!entry)return null;
    const binding=conversations.snapshot(id);
    if(binding.projectId!==entry.projectId || binding.version!==entry.bindingVersion) {notices.delete(id);return null;}
    return entry;
  }
  return { assertExecution, current, toolRegistrationOptions:capability.registrationOptions, get:id => scopes.get(id), notice, size:() => scopes.size };
}
