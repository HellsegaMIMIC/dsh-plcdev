/** Model/tool compatibility is evidence about a concrete native host route,
 * not a property inferred from a model name or its text modality. */
import {TOOL_NAMES} from './native-tools.mjs';

export const verifiedNativeRoutes = Object.freeze([
  Object.freeze({provider:'deepseek-official',model:'deepseek-flash'}),
  Object.freeze({provider:'deepseek-official',model:'deepseek-v4-pro'}),
  // DSH 0.2.2 account sign-in uses the same DeepSeekAdapter/native tool
  // serialization as the API-key route, under a distinct provider identity.
  Object.freeze({provider:'deepseek-account',model:'deepseek-flash'}),
  Object.freeze({provider:'plcdev-deepseek',model:'project-agent'}),
]);
export function isVerifiedNativeRoute(provider,model,routes=verifiedNativeRoutes) {
  return typeof provider==='string' && typeof model==='string' && Array.isArray(routes) &&
    routes.some(r=>r?.provider===provider && r?.model===model);
}

/** Filter before a prompt reaches the model, using the current host selection.
 * If the tool presentation is PTC, rebuild the assembly with an agent-scoped
 * deny mask so the generated SDK cannot leak PLCdev schema either. This does
 * not alter another agent, other tools, or the user's preset.
 */
export function createModelCapabilityGate({ctx,verifiedRoutes=verifiedNativeRoutes,isParticipating=()=>true}) {
  const running=new WeakSet(),states=new WeakMap();
  const participating=agent=>{try{return isParticipating(agent)===true;}catch{return false;}};
  // DSH 0.2.2 resolves conditional registrations before prompt assembly and
  // restores tool declarations after the assembly waterfall. Restrict them at
  // admission time instead of relying on a transformed waterfall result.
  const stepAdmission=typeof ctx.tools?.resolve==='function' && typeof ctx.tools?.selectExecutor==='function';
  function diagnoseSelection(agent,route,tools) {
    let toolMode='unknown',executorUnavailable=false;
    if(stepAdmission) {
      try {
        const name=ctx.tools.selectExecutor(agent)?.constructor?.name;
        toolMode=name==='NativeToolExecutor'?'native':name==='PtcExecutor'?'ptc':'unknown';
      } catch { executorUnavailable=true; }
    } else if(Array.isArray(tools)) toolMode=tools.some(t=>t?.name==='run_code')?'ptc':'native';
    const reason=!participating(agent)?'session-disabled':!isVerifiedNativeRoute(route?.provider,route?.model,verifiedRoutes)?'model-unverified':
      executorUnavailable?'executor-unavailable':toolMode!=='native'?'executor-unsupported':null;
    return {reason,toolMode};
  }
  function admitted({agent,modelSelection}) {
    return diagnoseSelection(agent,modelSelection).reason===null;
  }
  const selected=a=>({provider:a?.variables?.provider,model:a?.variables?.model});
  const same=(a,b)=>a?.provider===b?.provider && a?.model===b?.model;
  ctx.on('system-prompt/assemble',async (_proposed,context,next)=>{
    const result=await next(),agent=context?.agent;
    if(!agent || running.has(agent))return result;
    if(stepAdmission) {
      const route=context.modelSelection, view=context.toolSet?.view?.(agent);
      if (!(view instanceof Map)) throw new Error('无法确认本轮工程工具准入。');
      const names=[...view.keys()].filter(n=>TOOL_NAMES.includes(n));
      const allowed=admitted({agent,modelSelection:route});
      if (!allowed && names.length) throw new Error('无法确认工程工具已从本次模型请求移除。');
      const diagnosis=diagnoseSelection(agent,route);
      states.set(agent,{route,allowed:allowed && names.length>0,...diagnosis,
        reason:diagnosis.reason??(names.length?null:'tools-filtered')});
      return result;
    }
    const route=selected(result),tools=Array.isArray(result.tools)?result.tools:[];
    const diagnosis=diagnoseSelection(agent,route,tools);
    const native=tools.some(t=>TOOL_NAMES.includes(t?.name)) && !tools.some(t=>t?.name==='run_code');
    if(diagnosis.reason===null && native){
      states.set(agent,{route,allowed:true,...diagnosis});return result;
    }
    // Rebuild under a temporary scoped mask, so native schemas and a PTC SDK
    // are both generated from the same filtered registry. The model-routing
    // hook may wrap this waterfall, so require the second selection to match.
    if(typeof agent.ctx?.tools?.restrict!=='function' || typeof ctx.systemPrompt?.assemble!=='function')
      throw new Error('无法确认工程工具隔离，已停止本轮模型请求。');
    const dispose=agent.ctx.tools.restrict({deny:[...TOOL_NAMES]});
    running.add(agent);
    try {
      const filtered=await ctx.systemPrompt.assemble(context);
      if(!same(route,selected(filtered)) || !Array.isArray(filtered.tools) ||
          filtered.tools.some(t=>TOOL_NAMES.includes(t?.name)) ||
          (filtered.sections??[]).some(s=>s.name==='tools:sdk' && TOOL_NAMES.some(n=>String(s.text??'').includes(n))))
        throw new Error('无法确认工程工具已从本次模型请求移除。');
      states.set(agent,{route,allowed:false,...diagnosis,reason:diagnosis.reason??'tools-filtered'});return filtered;
    } finally {running.delete(agent);dispose();}
  },{prepend:true});
  // A separately installed host extension may rewrite agent/request after
  // our listener has returned. Recheck the actual provider/model immediately
  // at the shared LLM stream boundary before an adapter receives the schema.
  ctx.on('llm/stream',(options,next)=>{
    if(options?.tools?.some(t=>TOOL_NAMES.includes(t?.name))) {
      if(!isVerifiedNativeRoute(options.provider,options.model,verifiedRoutes))
        throw new Error('当前模型未通过 PLCdev native 工具能力验证；请求未发送。');
      const agent=options.sessionId&&ctx.agents?.get?.(options.sessionId);
      if(agent&&!participating(agent))throw new Error('PLCdev 会话状态已变化；工程工具请求未发送。');
    }
    return next();
  },{prepend:true});
  return {
    registrationOptions:stepAdmission?{when:admitted}:undefined,
    request(agent,config){
      const state=states.get(agent);
      if(!state)throw new Error('无法核对本轮模型工具能力。');
      // If an extension changes a previously allowed route after prompt
      // assembly, stop before any schemas reach the different model.
      if(state.allowed && !same(state.route,config))throw new Error('模型路由在工具组装后变化；本轮请求已停止。');
      if(state.allowed && !participating(agent))throw new Error('PLCdev 会话状态在工具组装后变化；本轮请求已停止。');
      return state.allowed && same(state.route,config);
    },
    allows(agent,route){const state=states.get(agent);return participating(agent) && state?.allowed===true && same(state.route,route);},
    diagnose(agent,config){
      const state=states.get(agent);
      if(!state || config && !same(state.route,config))return {reason:'request-unverified',toolMode:state?.toolMode??'unknown'};
      return {reason:state.reason||null,toolMode:state.toolMode};
    },
    eligible(agent){return participating(agent) && states.get(agent)?.allowed===true;},
    clear(agent){states.delete(agent);},
  };
}
