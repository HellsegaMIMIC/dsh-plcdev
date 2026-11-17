import {isVerifiedNativeRoute} from './model-capability.mjs';

// Do not strand an existing legacy session or a profile with no verified host
// model. Catalog discovery errors are unknown, not evidence of a replacement.
export async function showLegacyModel(ctx) {
  try {
    if(typeof ctx?.llm?.listProviders!=='function'||typeof ctx.llm.listModels!=='function'||typeof ctx?.agents?.list!=='function'||typeof ctx?.sessionProjections?.stateOf!=='function')return true;
    for(const agent of ctx.agents.list()){
      const state=ctx.sessionProjections.stateOf(agent.session,'modelSelection');
      if(!state)return true;
      // Newer hosts expose the actual selection even before the first request.
      // Keep the projection and header fallbacks for older hosts.
      const route=state.pending||agent.model?.current?.()||agent.session.requestHeader()?.config||ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if(!route||route.provider==='plcdev-deepseek'&&route.model==='project-agent')return true;
    }
    if(!ctx.llm.listProviders().some(p=>p.id==='deepseek-official'))return true;
    const models=await ctx.llm.listModels('deepseek-official');
    return !models.some(model=>isVerifiedNativeRoute(model.provider,model.id));
  } catch { return true; }
}
