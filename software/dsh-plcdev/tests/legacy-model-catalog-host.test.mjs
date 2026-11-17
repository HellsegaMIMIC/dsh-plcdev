// Verify the visibility decision against the installed host's actual live
// agent, session projection and model registry. No model call is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {showLegacyModel} from '../src/legacy-model-catalog.mjs';
import {createProjectModelAdapter,MODEL_ID,MODEL_PROVIDER} from '../src/model-adapter.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');

test('actual host catalog follows live model selection before the first request', {skip:!existsSync(host),timeout:20000},async t=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents}=await load('dsh-agent'),{default:Llm,LlmAdapter}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();let handle;
 try {
  await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
  let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-native');}catch{}
  if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode:'native'});
  await ctx.plugin(AgentLoop,{agents:[]});
  class NativeCatalog extends LlmAdapter {providerInfo(provider){return {id:provider,name:'fixture'};} async listModels(provider){return [{provider,id:'deepseek-flash',name:'fixture',inputModalities:['text']}];}}
  ctx.llm.registerAdapter(['deepseek-official'],new NativeCatalog());
  ctx.llm.registerAdapter([MODEL_PROVIDER],createProjectModelAdapter({bridge:{},conversations:{},showLegacy:()=>showLegacyModel(ctx)}));
  assert.equal(await showLegacyModel(ctx),false,'verified host model is available without a live session');
  assert.deepEqual(await ctx.llm.listModels(MODEL_PROVIDER),[]);
  handle=await ctx.agents.create({sessionId:'catalog-host-fixture',agentOptions:{provider:'deepseek-official',model:'deepseek-flash'}});
  if(typeof handle.agent.model?.select!=='function'){t.skip('host has no live AgentModel selection API');return;}
  assert.equal(await showLegacyModel(ctx),false,'an unsent native session should not force the old entry');
  handle.agent.model.select({provider:'plcdev-deepseek',model:'project-agent'});
  assert.equal(await showLegacyModel(ctx),true,'an explicitly selected old route remains available');
  assert.equal((await ctx.llm.listModels(MODEL_PROVIDER))[0].id,MODEL_ID);
  handle.agent.model.select({provider:'deepseek-official',model:'deepseek-flash'});
  assert.equal(await showLegacyModel(ctx),false,'switching back hides the old entry without a model request');
  assert.deepEqual(await ctx.llm.listModels(MODEL_PROVIDER),[]);
  assert.equal((await ctx.llm.resolveModelInfo(MODEL_PROVIDER,MODEL_ID)).id,MODEL_ID,'hidden legacy route remains resolvable');
 } finally {if(handle)await handle.dispose();await ctx.fiber.dispose();}
});
