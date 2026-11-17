/** Team schemas belong only to an authenticated role on the legacy team route.
 * Filter registration on 0.2.2; older hosts rebuild native/PTC presentation
 * under a temporary agent mask. Dispatch guards remain an independent fence. */
export function createTeamToolAdmission({ctx,team}) {
  const names=team.tools.map(tool=>tool.name),pending=new WeakMap(),running=new WeakSet();
  const modern=typeof ctx.tools?.resolve==='function'&&typeof ctx.tools?.selectExecutor==='function';
  const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model;
  const selected=result=>({provider:result?.variables?.provider,model:result?.variables?.model});
  async function allowed(context,tools) {
    if(modern){try{if(ctx.tools.selectExecutor(context.agent)?.constructor?.name!=='NativeToolExecutor')return new Set();}catch{return new Set();}}
    else if(tools?.some(t=>t.name==='run_code'))return new Set();
    return new Set(await team.toolNamesFor(context));
  }
  const forStep=context=>{
    let result=pending.get(context);
    if(!result){result=allowed(context);pending.set(context,result);}
    return result;
  };
  ctx.on('system-prompt/assemble',async (_proposed,context,next)=>{
    const result=await next(),agent=context?.agent;
    if(!agent||running.has(agent))return result;
    if(modern){
      const permitted=await forStep(context),view=context.toolSet?.view?.(agent);
      if(!(view instanceof Map)||names.some(name=>view.has(name)&&!permitted.has(name)))
        throw new Error('无法确认团队工具角色隔离，本轮请求未发送。');
      return result;
    }
    const route=selected(result),permitted=await allowed({agent,modelSelection:route},result.tools);
    const denied=names.filter(name=>!permitted.has(name));
    if(!denied.length)return result;
    if(typeof agent.ctx?.tools?.restrict!=='function'||typeof ctx.systemPrompt?.assemble!=='function')
      throw new Error('无法确认团队工具隔离，本轮请求未发送。');
    const dispose=agent.ctx.tools.restrict({deny:denied});running.add(agent);
    try{
      const filtered=await ctx.systemPrompt.assemble(context);
      if(!same(route,selected(filtered))||!Array.isArray(filtered.tools)||filtered.tools.some(t=>denied.includes(t.name))||
        (filtered.sections??[]).some(s=>s.name==='tools:sdk'&&denied.some(n=>String(s.text??'').includes(n))))
        throw new Error('无法确认团队工具已从本次模型请求移除。');
      return filtered;
    }finally{running.delete(agent);dispose();}
  },{prepend:true});
  ctx.on('llm/stream',async function*(options,next){
    if(options?.tools?.some(t=>names.includes(t.name))){
      const permitted=await allowed({agent:ctx.agents.get(options.sessionId),modelSelection:{provider:options.provider,model:options.model}},options.tools);
      if(options.tools.some(t=>names.includes(t.name)&&!permitted.has(t.name)))
        throw new Error('团队角色或模型路由已变化，本轮请求未发送。');
    }
    yield* next();
  },{prepend:true});
  return {registrationOptions:name=>modern?{when:async context=>(await forStep(context)).has(name)}:undefined};
}
