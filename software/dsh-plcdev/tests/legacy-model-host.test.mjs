// Installed DSH host and real plugin adapter, with a local fake model transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createProjectContext} from '../src/project-context.mjs';
import {createNativeTools} from '../src/native-tools.mjs';
import {createProjectModelAdapter,MODEL_PROVIDER,MODEL_ID} from '../src/model-adapter.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),host=path.join(root,'.tools/dsh-host/package.json');
test('old model route stays executable for a saved session but leaves the host model catalog',{skip:!existsSync(host)?'DSH host package not installed':false,timeout:30000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const id='legacy-chat',projectId='user-'+'a'.repeat(32),conversations={snapshot:()=>({conversationId:id,projectId,version:1,taskRefs:[],pendingRequests:[]}),claimRevision:()=>null,releaseRevision:()=>false};
 let calls=0;const bridge={async model(){calls++;return {ok:true,completion:{choices:[{finish_reason:'stop',message:{content:'兼容路由可用'}}]}};}};
 let ctx,handle;
 try{
  ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await ctx.plugin(Tools,{mode:'native'});await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
  const projectContext=createProjectContext({ctx,conversations});for(const tool of createNativeTools({bridge,conversations,projectContext}))ctx.tools.register(tool);
  ctx.llm.registerAdapter([MODEL_PROVIDER],createProjectModelAdapter({bridge,conversations,projectContext,showLegacy:async()=>false}));
  assert.deepEqual(await ctx.llm.listModels(MODEL_PROVIDER),[]);
  assert.equal((await ctx.llm.resolveModelInfo(MODEL_PROVIDER,MODEL_ID)).id,MODEL_ID);
  const selection={current:{provider:MODEL_PROVIDER,model:MODEL_ID}};
  handle=await ctx.agents.create({sessionId:id,agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'隔离兼容测试'}]}));await handle.agent.whenIdle();
  assert.equal(calls,1);assert.ok(handle.agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.content?.some(b=>b.type==='text'&&b.text==='兼容路由可用')));
 }finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
});
