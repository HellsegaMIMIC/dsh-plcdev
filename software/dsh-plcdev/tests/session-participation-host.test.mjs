// Installed DSH agent loop, registry and prompt assembly; deterministic local
// adapter only. Does not call an external model or mutate the daily host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createProjectContext} from '../src/project-context.mjs';
import {TOOL_NAMES} from '../src/native-tools.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');
for(const mode of ['native','ptc'])test(`real host ${mode}: ordinary chat stays ordinary across project selection and cancellation`,{skip:!existsSync(host),timeout:20000},async()=>{
  const require=createRequire(host),load=async name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
  const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
  const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
  const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
  const ctx=new Context();
  await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
  if(mode==='ptc')ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body',timeoutMs:1000,maxTimeoutMs:1000});
  let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-'+mode);}catch{}
  if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode});
  await ctx.plugin(AgentLoop,{agents:[]});
  const binding={projectId:null,version:0},seen=[];let locks=0,editorExpected=null;
  const conversations={snapshot:()=>binding,participation:()=>({enabled:!!binding.projectId,locked:false}),lockParticipation(){locks++;}};
  try{
    const projectContext=createProjectContext({ctx,conversations,verifiedRoutes:[{provider:'safe',model:'one'}],getEditorPromptBinding:()=>editorExpected});
    for(const name of [...TOOL_NAMES,'ordinary_tool'])ctx.tools.register({name,description:'Local fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(){throw new Error('Fixture must not call tools');}},TOOL_NAMES.includes(name)?projectContext.toolRegistrationOptions:undefined);
    class Local extends LlmAdapter{async *stream(options){seen.push({names:options.tools.map(t=>t.name),messages:JSON.stringify(options.messages)});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'hello'};yield {type:'block-end',index:0,block:{type:'text',text:'hello'}};yield {type:'finish',reason:{kind:'stop'}};}}
    ctx.llm.registerAdapter(['safe'],new Local());const selection={current:{provider:'safe',model:'one'}};
    const handle=await ctx.agents.create({sessionId:'session-participation-'+mode,agentOptions:selection.current,setup:child=>{installModelSelection(child,selection);}});
    const send=async()=>{handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'你好'}]}));await handle.agent.whenIdle();};
    await send();binding.projectId='private-selected-project';binding.version++;await send();binding.projectId=null;binding.version++;await send();
    assert.equal(seen.length,3);assert.equal(locks,0);
    for(const index of [0,2]){
      assert.ok(!seen[index].messages.includes('PLCdev 工程操作规则'));
      // DSH keeps its append-only history, then explicitly supersedes the old
      // project snapshot. Disabling must clear CURRENT context, not erase logs.
      const runtime=JSON.parse(seen[index].messages).filter(message=>message.source?.kind==='runtime-context').at(-1);
      assert.ok(!JSON.stringify(runtime??{}).includes('private-selected-project'));
      if(index===2&&mode==='native')assert.match(JSON.stringify(runtime),/none|no longer apply/);
      for(const name of TOOL_NAMES){assert.ok(!seen[index].names.includes(name),name);if(mode==='ptc')assert.ok(!seen[index].messages.includes(name),name);}
      assert.ok(mode==='native'?seen[index].names.includes('ordinary_tool'):seen[index].messages.includes('ordinary_tool'));
    }
    if(mode==='native')assert.ok(TOOL_NAMES.every(name=>seen[1].names.includes(name)));
    else for(const name of TOOL_NAMES)assert.ok(!seen[1].names.includes(name));
    if(mode==='native'){
      const rpcId='plcdev-openplc-'+'a'.repeat(64),text='创建变量';
      binding.projectId='newly-selected-project';binding.version++;
      const sendEditor=async()=>{handle.agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text}]}));await handle.agent.whenIdle();};
      for(const expected of [null,{projectId:'private-selected-project',version:1,text},{projectId:binding.projectId,version:1,text},{projectId:binding.projectId,version:binding.version,text:'changed input'}]){
        editorExpected=expected;await sendEditor();
        assert.equal(seen.length,3,'a stale or unverified editor claim must not reach the model');
        assert.equal(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'blocked');
      }
      editorExpected={projectId:binding.projectId,version:binding.version,text};await sendEditor();
      assert.equal(seen.length,4,'a current editor claim remains usable');
      binding.projectId='later-project';binding.version++;await send();
      assert.equal(seen.length,5,'past editor history must not reject a new ordinary user message after switching');
      assert.equal(projectContext.notice(handle.agent.session.id),null);
    }
    await handle.dispose();
  }finally{await ctx.fiber.dispose();}
});
