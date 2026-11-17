// Real installed DSH loop and tool registry. Adapters are deterministic local
// fixtures; no network, model service, editor, compiler or Runtime is started.
import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';import path from 'node:path';
import {createModelCapabilityGate,isVerifiedNativeRoute} from '../src/model-capability.mjs';
import {createProjectContext} from '../src/project-context.mjs';
import {TOOL_NAMES} from '../src/native-tools.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');
async function installTools(ctx,Tools,mode) {
 const require=createRequire(host);
 let executor;
 try { executor=require.resolve('@deepseek-ai/dsh-tool-executor-'+mode); } catch {}
 if(executor) {
  await ctx.plugin(Tools,{});
  await ctx.plugin(await import(pathToFileURL(executor).href),{});
 } else await ctx.plugin(Tools,{mode});
}

test('production trust is exact and limited to evidenced model routes',()=>{
 assert.equal(isVerifiedNativeRoute('deepseek-official','deepseek-flash'),true);
 assert.equal(isVerifiedNativeRoute('deepseek-official','deepseek-v4-pro'),true);
 assert.equal(isVerifiedNativeRoute('deepseek-account','deepseek-flash'),true);
 assert.equal(isVerifiedNativeRoute('deepseek-account','deepseek-v4-pro'),false,'Account compatibility is limited to the observed Flash route');
 assert.equal(isVerifiedNativeRoute('plcdev-deepseek','project-agent'),true);
 assert.equal(isVerifiedNativeRoute('some-provider','deepseek-flash'),false);
 assert.equal(isVerifiedNativeRoute('deepseek-official','unverified'),false);
});

test('actual DSH account sign-in route executes native project calls and preserves revision across supported model routes',{skip:!existsSync(host),timeout:20000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await installTools(ctx,Tools,'native');await ctx.plugin(AgentLoop,{agents:[]});
 const binding={projectId:'account-fixture-project',version:3,revisionContext:{intentId:'revision-1',state:'armed',parent:{taskId:'parent-1'}}};
 const conversations={snapshot:()=>binding,claimRevision:()=>{binding.revisionContext.state='claimed';return binding.revisionContext;},releaseRevision:()=>{binding.revisionContext.state='armed';}};
 const executed=[],seen=[];let phase=0;
 try {
  const authority=createProjectContext({ctx,conversations});
  for(const name of TOOL_NAMES)ctx.tools.register({name,description:'Offline authority probe',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(_args,exec){
   const scope=authority.assertExecution(exec);executed.push({name,route:scope.route,projectId:scope.projectId,parent:scope.revision.parent.taskId});return 'ok';
  }},authority.toolRegistrationOptions);
  class Local extends LlmAdapter {async *stream(o){
   seen.push({provider:o.provider,names:o.tools.map(t=>t.name)});
   if(!o.tools.some(t=>t.name===TOOL_NAMES[0])||phase>=2){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'done'};yield {type:'block-end',index:0,block:{type:'text',text:'done'}};yield {type:'finish',reason:{kind:'stop'}};return;}
   const name=phase++===0?TOOL_NAMES[0]:'plcdev_propose_hmi_readonly_value',id=`account-${seen.length}`;
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:'{}'};
   yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};
  }}
  ctx.llm.registerAdapter(['deepseek-official','deepseek-account','unverified-provider'],new Local());
  const selection={current:{provider:'deepseek-account',model:'deepseek-flash'}};
  const handle=await ctx.agents.create({sessionId:'account-native-fixture',agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  for(const provider of ['deepseek-account','deepseek-official','unverified-provider']) {
   selection.current={provider,model:'deepseek-flash'};if(handle.agent.model?.select)handle.agent.model.select(selection.current);phase=0;
   handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'添加当前计数只读显示'}]}));await handle.agent.whenIdle();
   assert.equal(binding.projectId,'account-fixture-project');assert.equal(binding.revisionContext.parent.taskId,'parent-1');assert.equal(binding.revisionContext.state,'armed');
   assert.equal(authority.notice('account-native-fixture')?.reason??null,provider==='unverified-provider'?'model-unverified':null);
  }
  assert.deepEqual(executed.map(e=>[e.name,e.route.provider]),[[TOOL_NAMES[0],'deepseek-account'],['plcdev_propose_hmi_readonly_value','deepseek-account'],[TOOL_NAMES[0],'deepseek-official'],['plcdev_propose_hmi_readonly_value','deepseek-official']]);
  assert.ok(executed.every(e=>e.projectId==='account-fixture-project'&&e.parent==='parent-1'));
  assert.ok(TOOL_NAMES.every(name=>seen.find(r=>r.provider==='deepseek-account').names.includes(name)));
  assert.ok(seen.filter(r=>r.provider==='unverified-provider').every(r=>TOOL_NAMES.every(name=>!r.names.includes(name))));
  assert.ok(TOOL_NAMES.every(name=>!handle.agent.session.requestHeader().tools?.some(t=>t.name===name)));
  await handle.dispose();
 } finally {await ctx.fiber.dispose();}
});

test('actual DSH model selection filters only PLCdev schemas before streaming, then restores on switch',{skip:!existsSync(host),timeout:20000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await installTools(ctx,Tools,'native');await ctx.plugin(AgentLoop,{agents:[]});
 const seen=[];let allowed=[];
 try{
  const gate=createModelCapabilityGate({ctx,verifiedRoutes:[{provider:'safe',model:'one'}]});
  ctx.on('agent/request',async (p,next)=>{const config=await next();allowed.push(gate.request(p.agent,config));return config;},{prepend:true});
  for(const name of [...TOOL_NAMES,'normal_host_tool','team_tool'])ctx.tools.register({name,description:'local test',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){return 'ok';}},TOOL_NAMES.includes(name)?gate.registrationOptions:undefined);
  class Local extends LlmAdapter {async *stream(o){seen.push({provider:o.provider,model:o.model,tools:o.tools.map(t=>t.name)});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'ok'};yield {type:'block-end',index:0,block:{type:'text',text:'ok'}};yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['safe','other'],new Local());const selection={current:{provider:'safe',model:'one'}};
  const handle=await ctx.agents.create({sessionId:'capability-fixture',agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  const send=async()=>{handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}));await handle.agent.whenIdle();};
  const select=value=>{selection.current=value;if(handle.agent.model?.select)handle.agent.model.select(value);};
  await send();select({provider:'other',model:'unsupported'});await send();select({provider:'safe',model:'one'});await send();
  assert.equal(seen.length,3);assert.deepEqual(allowed,[true,false,true]);
  for(const item of seen){assert.ok(item.tools.includes('normal_host_tool'));assert.ok(item.tools.includes('team_tool'));}
  assert.ok(TOOL_NAMES.every(n=>seen[0].tools.includes(n)));assert.ok(TOOL_NAMES.every(n=>!seen[1].tools.includes(n)));assert.ok(TOOL_NAMES.every(n=>seen[2].tools.includes(n)));
  assert.throws(()=>gate.request(handle.agent,{provider:'other',model:'unsupported'}),/组装后变化/);
  await handle.dispose();
 } finally {await ctx.fiber.dispose();}
});

test('PTC generated SDK is rebuilt with PLCdev names removed', {skip:!existsSync(host),timeout:20000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
 ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body',timeoutMs:1000,maxTimeoutMs:1000});
 await installTools(ctx,Tools,'ptc');await ctx.plugin(AgentLoop,{agents:[]});let captured;
 try{
  const gate=createModelCapabilityGate({ctx,verifiedRoutes:[{provider:'safe',model:'one'}]});
  ctx.on('agent/request',async(p,next)=>{const config=await next();assert.equal(gate.request(p.agent,config),false);assert.deepEqual(gate.diagnose(p.agent,config),{reason:'executor-unsupported',toolMode:'ptc'});return config;},{prepend:true});
  for(const name of [...TOOL_NAMES,'normal_host_tool'])ctx.tools.register({name,description:'local test',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){return 'ok';}},TOOL_NAMES.includes(name)?gate.registrationOptions:undefined);
  class Local extends LlmAdapter {async *stream(o){captured=o;yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'ok'};yield {type:'block-end',index:0,block:{type:'text',text:'ok'}};yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['safe'],new Local());const selection={current:{provider:'safe',model:'one'}};
  const handle=await ctx.agents.create({sessionId:'ptc-fixture',agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}));await handle.agent.whenIdle();
  assert.ok(captured,'PTC model received a request');assert.ok(captured.tools.some(t=>t.name==='run_code'));
  const wire=JSON.stringify(captured.messages);assert.ok(wire.includes('normal_host_tool'));for(const name of TOOL_NAMES)assert.ok(!wire.includes(name),name);
  await handle.dispose();
 } finally {await ctx.fiber.dispose();}
});

test('unverified chat does not claim revision or project context; verified switch can claim it',{skip:!existsSync(host),timeout:20000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await installTools(ctx,Tools,'native');await ctx.plugin(AgentLoop,{agents:[]});
 let claims=0,releases=0;const seen=[],intent={intentId:'revision-1',parent:{taskId:'private-parent'}};
 const binding={projectId:'private-project',version:1,revisionContext:{...intent,state:'armed'}};
 const conversations={snapshot:()=>binding,claimRevision:()=>{claims++;binding.revisionContext.state='claimed';return intent;},releaseRevision:()=>{releases++;binding.revisionContext.state='armed';}};
 try{
  const projectContext=createProjectContext({ctx,conversations,verifiedRoutes:[{provider:'safe',model:'one'}]});
  for(const name of [...TOOL_NAMES,'normal_host_tool'])ctx.tools.register({name,description:'local test',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){return 'ok';}},TOOL_NAMES.includes(name)?projectContext.toolRegistrationOptions:undefined);
  class Local extends LlmAdapter {async *stream(o){seen.push({tools:o.tools.map(t=>t.name),messages:JSON.stringify(o.messages)});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'ok'};yield {type:'block-end',index:0,block:{type:'text',text:'ok'}};yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['safe','other'],new Local());const selection={current:{provider:'other',model:'unsupported'}};
  const handle=await ctx.agents.create({sessionId:'revision-gate-fixture',agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  const send=async()=>{handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'你好'}]}));await handle.agent.whenIdle();};
  await send();assert.equal(claims,0);assert.equal(releases,0);assert.equal(binding.revisionContext.state,'armed');
  assert.ok(TOOL_NAMES.every(n=>!seen[0].tools.includes(n)));assert.ok(!seen[0].messages.includes('private-project'));assert.ok(!seen[0].messages.includes('private-parent'));
  selection.current={provider:'safe',model:'one'};if(handle.agent.model?.select)handle.agent.model.select(selection.current);await send();assert.equal(claims,1);assert.equal(releases,1);assert.equal(binding.revisionContext.state,'armed');
  assert.ok(TOOL_NAMES.every(n=>seen[1].tools.includes(n)));assert.ok(seen[1].messages.includes('private-project'));assert.ok(seen[1].messages.includes('private-parent'));
  await handle.dispose();
 } finally {await ctx.fiber.dispose();}
});

test('step admission fails closed if a PLCdev tool bypasses its registration condition',{skip:!existsSync(host),timeout:20000},async t=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
 await installTools(ctx,Tools,'native');await ctx.plugin(AgentLoop,{agents:[]});
 try {
  if(typeof ctx.tools.resolve!=='function'){t.skip('step admission is not provided by this host');return;}
  createModelCapabilityGate({ctx,verifiedRoutes:[]});let calls=0;
  ctx.tools.register({name:TOOL_NAMES[0],description:'fault injection',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){return 'ok';}});
  class Local extends LlmAdapter {async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['other'],new Local());
  const handle=await ctx.agents.create({sessionId:'bypass-fixture',agentOptions:{provider:'other',model:'unsupported'}});
  handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}));await handle.agent.whenIdle();
  assert.equal(calls,0,'unfiltered schema must never reach a model');
  assert.ok(handle.agent.session.snapshotEvents().some(e=>e.type==='turn/end'&&e.data.reason?.kind==='error'));
  await handle.dispose();
 } finally {await ctx.fiber.dispose();}
});
