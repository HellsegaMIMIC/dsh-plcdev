// Real DSH prompt assembly/executor with a local scripted adapter. This proves
// role/first-request delivery and ordinary-tool compatibility, not LLM choices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createProjectContext} from '../src/project-context.mjs';
import {TOOL_NAMES} from '../src/native-tools.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');
const messageText=m=>(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');

test('bound first request receives one system workflow; project data stays separate; unbound chat and read-only tools survive',
 {skip:!existsSync(host),timeout:20000},async()=>{
 const require=createRequire(host),load=async name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:Loop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);
 await ctx.plugin(SystemPrompt,{});
 let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-native');}catch{}
 if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode:'native'});
 await ctx.plugin(Loop,{agents:[]});
 const binding={projectId:'workflow-fixture',version:1},selection={current:{provider:'deepseek-account',model:'deepseek-flash'}};
 const seen=[],executed=[];let mode='engineering',phase=0,handle;
 try{
  const authority=createProjectContext({ctx,conversations:{snapshot:()=>binding,claimRevision:()=>null}});
  for(const name of [...TOOL_NAMES,'read_probe','pwsh','write'])ctx.tools.register({
   name,description:'Local contract probe',parameters:{type:'object',properties:{}},
   output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},
   async execute(){executed.push(name);return 'read-only fixture';},
  },TOOL_NAMES.includes(name)?authority.toolRegistrationOptions:undefined);
  class Local extends LlmAdapter {async *stream(o){
   seen.push({mode,messages:o.messages,tools:o.tools.map(t=>t.name)});
   if(mode==='read-only'&&phase++===0){
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'tool-call-delta',index:0,id:'read-only-call',name:'read_probe',argumentsDelta:'{}'};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:'read-only-call',name:'read_probe',arguments:'{}'}};
    yield {type:'finish',reason:{kind:'tool-calls'}};return;
   }
   yield {type:'block-start',index:0,blockType:'text'};
   yield {type:'text-delta',index:0,text:'local prompt contract'};
   yield {type:'block-end',index:0,block:{type:'text',text:'local prompt contract'}};
   yield {type:'finish',reason:{kind:'stop'}};
  }}
  ctx.llm.registerAdapter(['deepseek-account','unverified'],new Local());
  handle=await ctx.agents.create({sessionId:'workflow-host-fixture',agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  const send=async text=>{phase=0;handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));await handle.agent.whenIdle();};
  await send('把 PLC 计数目标改为 8，同时更新画面标题和输送场景名称');
  const first=seen[0];assert.ok(first,'First ordinary request reached local adapter');
  const system=first.messages.filter(m=>m.role==='system').map(messageText).join('\n');
  assert.equal((system.match(/PLCdev 工程操作规则/g)??[]).length,1);
  assert.match(system,/plcdev_project_context/);assert.match(system,/不要用 write\/edit、shell/);
  const data=first.messages.filter(m=>m.role==='user').map(messageText).filter(s=>s.includes('PLCdev 当前工程数据')).join('\n');
  assert.match(data,/workflow-fixture/);assert.doesNotMatch(data,/PLCdev 工程操作规则|plcdev_propose_project_edit/);
  assert.ok(TOOL_NAMES.every(n=>first.tools.includes(n)));
  for(const name of ['read_probe','pwsh','write'])assert.ok(first.tools.includes(name),'No broad tool restriction: '+name);
  mode='read-only';await send('只读查看工作目录中的说明，不修改工程');
  assert.deepEqual(executed,['read_probe']);
  // New assembly after unbinding must remove project policy, even in an old chat.
  binding.projectId=null;binding.version++;mode='unbound';await send('你好');
  const unbound=seen.find(s=>s.mode==='unbound');
  assert.doesNotMatch(unbound.messages.filter(m=>m.role==='system').map(messageText).join('\n'),/PLCdev 工程操作规则/);
  assert.ok(unbound.tools.includes('read_probe'));
  // Unsupported route remains a normal chat; it must not receive project schemas.
  binding.projectId='workflow-fixture';binding.version++;mode='unsupported';selection.current={provider:'unverified',model:'other'};
  if(handle.agent.model?.select)handle.agent.model.select(selection.current);
  await send('解释一下工程的修改流程');
  const unsupported=seen.find(s=>s.mode==='unsupported');assert.ok(unsupported);
  assert.ok(TOOL_NAMES.every(n=>!unsupported.tools.includes(n)));
  assert.ok(unsupported.tools.includes('read_probe'));assert.deepEqual(executed,['read_probe']);
 }finally{if(handle)await handle.dispose();await ctx.fiber.dispose();}
});
