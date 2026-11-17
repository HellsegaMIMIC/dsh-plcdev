// Real DSH registration and prompt assembly; deterministic local adapters only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createTeamToolAdmission} from '../src/team-tool-admission.mjs';
import {createModelCapabilityGate} from '../src/model-capability.mjs';
import {TEAM_PROVIDER,TEAM_GENERATION_MODEL,ROLE_TOOLS,GENERATION_ROLE_TOOLS} from '../src/teams.mjs';
import {TOOL_NAMES} from '../src/native-tools.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');
const teamNames=[...new Set([...Object.values(ROLE_TOOLS),...Object.values(GENERATION_ROLE_TOOLS)].flat())];

for(const mode of ['native','ptc'])test(`actual DSH ${mode} catalog isolates team role, survives model switching and preserves ordinary project tools`,{skip:!process.env.PLCDEV_DSH_TEST_HOST_PACKAGE&&!existsSync(host)?'Optional local DSH installation is absent':false,timeout:30000},async()=>{
 const require=createRequire(host),load=async name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
 if(mode==='ptc')ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body',timeoutMs:1000,maxTimeoutMs:1000});
 let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-'+mode);}catch{}
 if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode});
 await ctx.plugin(AgentLoop,{agents:[]});
 const selection={current:{provider:'deepseek-account',model:'deepseek-flash'}},seen=[];let role='lead',handle;
 const tool=name=>({name,description:'Local catalog test',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},async execute(){return 'ok';}});
 try{
  const ordinary=createModelCapabilityGate({ctx});
  for(const name of TOOL_NAMES)ctx.tools.register(tool(name),ordinary.registrationOptions);
  const team={tools:teamNames.map(tool),async toolNamesFor({agent,modelSelection}){
   return agent===handle?.agent&&modelSelection?.provider===TEAM_PROVIDER&&modelSelection?.model===TEAM_GENERATION_MODEL&&selection.current.provider===TEAM_PROVIDER ? GENERATION_ROLE_TOOLS[role]:[];
  }};
  const gate=createTeamToolAdmission({ctx,team});
  for(const tool of team.tools)ctx.tools.register(tool,gate.registrationOptions(tool.name));
  ctx.tools.register(tool('normal_host_tool'));
  class Local extends LlmAdapter {async *stream(options){seen.push({provider:options.provider,tools:options.tools.map(t=>t.name),messages:JSON.stringify(options.messages)});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'ok'};yield {type:'block-end',index:0,block:{type:'text',text:'ok'}};yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['deepseek-account','other',TEAM_PROVIDER],new Local());
  handle=await ctx.agents.create({sessionId:'team-catalog-'+mode,agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  const send=async(provider,model,newRole)=>{role=newRole??role;selection.current={provider,model};handle.agent.model?.select?.(selection.current);handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'读取工程'}]}));await handle.agent.whenIdle();};
  await send('deepseek-account','deepseek-flash');await send(TEAM_PROVIDER,TEAM_GENERATION_MODEL,'lead');await send(TEAM_PROVIDER,TEAM_GENERATION_MODEL,'oip');await send('other','unverified');await send('deepseek-account','deepseek-flash');
  assert.equal(seen.length,5,'Every filtered request reaches the local adapter: '+JSON.stringify(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end')));
  for(const [index,item] of seen.entries()){
   if(mode==='ptc'){
    assert.ok(item.tools.includes('run_code'));assert.ok(item.messages.includes('normal_host_tool'));
    for(const name of [...teamNames,...TOOL_NAMES])assert.ok(!item.messages.includes(name),`${index}: ${name} leaked into PTC SDK`);
   }else{
    assert.ok(item.tools.includes('normal_host_tool'));
    const expected=index===1?GENERATION_ROLE_TOOLS.lead:index===2?GENERATION_ROLE_TOOLS.oip:[];
    assert.deepEqual(new Set(item.tools.filter(n=>teamNames.includes(n))),new Set(expected));
    assert.equal(item.tools.includes(TOOL_NAMES[0]),index===0||index===4);
   }
  }
 }finally{await handle?.dispose();await ctx.fiber.dispose();}
});
