// Native API fixtures: role routing, durable receipts and request fences.
// No model network, real editor, compiler or Runtime is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamIntegration, TEAM_PROVIDER, TEAM_MODEL, TEAM_GENERATION_MODEL, GENERATION_ROLE_TOOLS } from '../src/teams.mjs';

function fixture() {
  const agents=new Map(['lead','plc','hmi','oip'].map((role,i)=>[role,{session:{id:role,header:{createdAt:10+i,isSeeded:false}},options:{provider:TEAM_PROVIDER,model:TEAM_GENERATION_MODEL}}]));
  const lead=agents.get('lead'), projectId='user-'+'a'.repeat(32), projectRevision='b'.repeat(64), taskId='task-'+'c'.repeat(32);
  const task={taskId,projectId,projectRevision,request:'生成批次5件、FUXA画面与输送速度0.6',workflow:'team-generation-v1',status:'team_waiting',
    teamAnalysis:{kind:'generation',bindingVersion:1,members:['plc','hmi','oip'].map((role,i)=>({role,name:role+'-task',sessionId:role,createdAt:11+i,nativeTaskId:'native-'+role,instruction:role+' 原生产物'}))}};
  let binding={projectId,version:1}, state=task, action=null, failed=false;
  const effects=new Map(),calls=[],notices=[],native=new Map(task.teamAnalysis.members.map(slot=>[slot.role,{
    id:slot.nativeTaskId,subject:taskId+'/'+slot.role,description:`工程 ${projectId}\n固定版本 ${projectRevision}\n${slot.instruction}`,
    ownerName:slot.name,status:'in_progress',revision:1,writeScopes:[`team-generation/${taskId}/${slot.role}.json`],
  }]));
  const ctx={agents:{get:id=>agents.get(id)},sessionProjections:{stateOf:()=>null},agentTeams:{
    membership:agent=>({root:lead,id:'lead',role:agent===lead?'lead':'teammate',name:agent===lead?'lead':agent.session.id+'-task'}),
    listMembers:()=>[...agents.values()].map(a=>({id:a.session.id,role:a===lead?'lead':'teammate',name:a===lead?'lead':a.session.id+'-task',context:'fresh',status:'inactive'})),
    listTasks:()=>[...native.values()],getTask:(_a,id)=>structuredClone([...native.values()].find(n=>n.id===id)),
    updateTask:async(a,args)=>{const n=native.get(a.session.id);assert.equal(args.action,'complete');assert.equal(n.id,args.taskId);n.status='completed';n.revision++;return structuredClone(n);},
    sendMessage:async(a,args)=>{notices.push({role:a.session.id,...args});return {messageId:'notice-'+notices.length};},
  }};
  const bridge={handle:async()=>({status:200,body:{projectId,projectRevision}}),team:async(operation,body)=>{
    calls.push({operation,body:structuredClone(body)});const {actor,input}=body;
    if(operation==='model')return {ok:true,completion:{choices:[{finish_reason:action?'tool_calls':'stop',message:action?{tool_calls:[{id:'call-'+calls.length,type:'function',function:{name:action,arguments:JSON.stringify(action==='plcdev_team_assemble'?{taskId,projectId,projectRevision}:{})}}]}:{content:'已核对'}}]}};
    if(operation==='context')return {ok:true,contextDigest:'d'.repeat(64),generationContract:{operations:{[actor.role]:'fixture'}},proposalSchema:{type:'object'}};
    if(operation==='create-generation'){state=task;return {ok:true,task};}
    if(operation==='generate'){
      const slot=task.teamAnalysis.members.find(s=>s.role===actor.role);
      assert.equal(input.contextDigest,'d'.repeat(64));
      slot.componentDigest='e'.repeat(64);slot.reportDigest='f'.repeat(64);
      slot.report={summary:actor.role+' 确定性产物回执',findings:['产物已生成'],unverified:['编译与运行未验证']};
      if(failed){failed=false;throw new Error('generation response lost');}
    }
    if(operation==='assemble'){assert.equal(actor.role,'lead');task.status='awaiting_review';task.candidate={candidateDigest:'a'.repeat(64)};}
    if(operation==='effect-start'){const old=effects.get(input.effectId);if(old)return {send:false,result:old.result};effects.set(input.effectId,{payload:input.payload});return {send:true};}
    if(operation==='effect-finish'){effects.get(input.effectId).result=input.result;}
    return {ok:true,task:state};
  }};
  const references=[], conversations={snapshot:()=>binding,referenceTeam:(id,t)=>references.push({id,task:t.taskId})};
  const reopen=()=>createTeamIntegration({ctx,bridge,conversations}), team=reopen();
  const ids={taskId,projectId,projectRevision};
  const exec=(role,callId='read-only')=>({agent:agents.get(role),callId,signal:new AbortController().signal});
  const stream=async(role='lead')=>{
    const events=[];
    for await(const e of team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_GENERATION_MODEL,sessionId:role,tools:team.tools,messages:[{role:'user',id:'user-1',content:[{type:'text',text:task.request}]}]}))events.push(e);
    return events.find(e=>e.block?.type==='tool-call')?.block;
  };
  return {agents,lead,task,native,bridge,ctx,calls,notices,ids,exec,team,reopen,stream,references,
    action:name=>{action=name;},rebind:()=>{binding={projectId:'user-'+'9'.repeat(32),version:2};},empty:()=>{state=null;},failGeneration:()=>{failed=true;}};
}

test('generation is a distinct model and analysis sessions cannot silently acquire its tools',async()=>{
  const f=fixture();assert.deepEqual((await f.team.adapter.listModels(TEAM_PROVIDER)).map(m=>m.id),[TEAM_MODEL,TEAM_GENERATION_MODEL]);
  f.task.workflow='team-analysis-v1';
  await assert.rejects(f.team.stateFor(f.lead),/模型路由不同/);
  for(const a of f.agents.values())a.options.model=TEAM_MODEL;
  await f.team.authority(f.agents.get('plc'));
  assert.ok(f.team.guard({...f.exec('plc'),name:'plcdev_plc_generate'}));
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_plc_generate').execute({...f.ids,contextDigest:'d'.repeat(64),proposal:{operation:'batch-default-target',value:5}},f.exec('plc')),/角色/);
});

for(const role of ['plc','hmi','oip'])test(`${role} receives only its independent generation route and rejects sibling/model lifecycle tools`,async()=>{
  const f=fixture();await f.stream(role);
  const sent=f.calls.find(c=>c.operation==='model').body;
  assert.equal(sent.input.maxTokens,role==='hmi'?8192:4096);
  assert.deepEqual(new Set(sent.input.tools.map(t=>t.function.name)),new Set(GENERATION_ROLE_TOOLS[role]));
  assert.match(sent.input.messages[0].content,/本角色 generate|本角色原生产物/);
  assert.ok(!sent.input.tools.some(t=>/joint|team_report|assemble/.test(t.function.name)));
  for(const name of ['plcdev_team_report','plcdev_team_assemble','plcdev_propose_joint','pwsh','runtime-start',...['plc','hmi','oip'].filter(r=>r!==role).map(r=>'plcdev_'+r+'_generate')])
    assert.ok(f.team.guard({...f.exec(role),name}),name);
  const read=await f.team.tools.find(t=>t.name==='plcdev_'+role+'_analyze').execute(f.ids,f.exec(role));
  assert.equal(JSON.parse(read).contextDigest,'d'.repeat(64));
});

for(const role of ['plc','hmi','oip'])test(`${role} generation stores one native artifact, completes its task and reconciles after reopen without regeneration`,async()=>{
  const f=fixture(),proposal=role==='plc'?{operation:'batch-default-target',value:5}:role==='hmi'?{operation:'native-page',defaultTarget:5,spec:{widgets:[]}}:{operation:'conveyor-speed',partId:'conveyor',value:.6};
  const result=JSON.parse(await f.team.tools.find(t=>t.name==='plcdev_'+role+'_generate').execute({...f.ids,contextDigest:'d'.repeat(64),proposal},f.exec(role)));
  assert.equal(result.ok,true);assert.equal(f.native.get(role).status,'completed');assert.equal(f.notices.length,1);assert.match(f.notices[0].content[0].text,/独立原生产物/);
  await f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile').execute(f.ids,f.exec(role));
  assert.equal(f.calls.filter(c=>c.operation==='generate').length,1);assert.equal(f.notices.length,1);
  assert.ok(!f.calls.some(c=>['model','report','assemble','create'].includes(c.operation)));
});

test('lost generation receipt is recovered from the persisted original artifact without another generation request',async()=>{
  const f=fixture();f.failGeneration();
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_plc_generate').execute({...f.ids,contextDigest:'d'.repeat(64),proposal:{operation:'batch-default-target',value:5}},f.exec('plc')),/response lost/);
  assert.equal(f.native.get('plc').status,'in_progress');f.rebind();
  await f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile').execute(f.ids,f.exec('plc'));
  assert.equal(f.calls.filter(c=>c.operation==='generate').length,1);assert.equal(f.native.get('plc').status,'completed');assert.equal(f.notices.length,1);
});

test('Lead assembles only under the original model-issued request and stops at human review',async()=>{
  const f=fixture(),tool=f.team.tools.find(t=>t.name==='plcdev_team_assemble');
  await assert.rejects(tool.execute(f.ids,f.exec('lead')),/请求绑定/);
  f.action('plcdev_team_assemble');const call=await f.stream();
  await assert.rejects(tool.execute({...f.ids,projectRevision:'0'.repeat(64)},f.exec('lead',call.id)),/原生成任务/);
  const result=JSON.parse(await tool.execute(f.ids,f.exec('lead',call.id)));
  assert.equal(result.task.status,'awaiting_review');
  assert.equal(f.calls.filter(c=>c.operation==='assemble').length,1);
  assert.ok(!f.calls.some(c=>/keep|compile|runtime/.test(c.operation)));
});

test('Lead rebind invalidates an already emitted assemble call without touching the original task',async()=>{
  const f=fixture();f.action('plcdev_team_assemble');const call=await f.stream();f.rebind();
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_assemble').execute(f.ids,f.exec('lead',call.id)),/绑定/);
  assert.equal(f.calls.filter(c=>c.operation==='assemble').length,0);
});

test('generation planning registers exactly three role assignments and recovers the original native tasks',async()=>{
  const f=fixture();f.empty();f.action('plcdev_team_generate_plan');
  const context=JSON.parse(await f.team.tools.find(t=>t.name==='plcdev_team_context').execute({},f.exec('lead')));
  const call=await f.stream();
  const args={contextToken:context.contextToken,plcInstruction:'plc 原生产物',hmiInstruction:'hmi 原生产物',oipInstruction:'oip 原生产物'};
  const result=JSON.parse(await f.team.tools.find(t=>t.name==='plcdev_team_generate_plan').execute(args,f.exec('lead',call.id)));
  assert.equal(result.ok,true);assert.equal(result.recovery.length,3);
  const create=f.calls.filter(c=>c.operation==='create-generation');assert.equal(create.length,1);
  assert.deepEqual(Object.keys(create[0].body.input.assignments),['plc','hmi','oip']);
  assert.equal(create[0].body.input.expectedRevision,f.ids.projectRevision);
  assert.equal(f.calls.filter(c=>c.operation==='create'||c.operation==='generate').length,0);
  assert.equal(f.notices.length,0);
});

test('truncated generation response emits neither model text nor tool actions',async()=>{
  const f=fixture(),original=f.bridge.team;
  f.bridge.team=async(op,body)=>{const value=await original(op,body);if(op==='model')value.completion.choices[0].finish_reason='length';return value;};
  await assert.rejects(f.stream('hmi'),/长度上限/);
  assert.equal(f.calls.filter(c=>c.operation==='generate').length,0);
});

test('model switch during generation rejects the old response and mixed parent/member model identity',async()=>{
  const f=fixture(),original=f.bridge.team;
  f.bridge.team=async(op,body)=>{const result=await original(op,body);if(op==='model')f.lead.options.model=TEAM_MODEL;return result;};
  await assert.rejects(f.stream('lead'),/路由变化/);
  await assert.rejects(f.team.authority(f.agents.get('oip')),/父会话/);
});

test('OIP schema bounds speed and does not expose geometry or scene Run',()=>{
  const f=fixture(),schema=f.team.tools.find(t=>t.name==='plcdev_oip_generate').parameters.properties.proposal;
  assert.deepEqual(schema.properties.operation.enum,['conveyor-speed']);assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.value.minimum,.1);assert.equal(schema.properties.value.maximum,3);
  assert.deepEqual(GENERATION_ROLE_TOOLS.oip,['plcdev_oip_analyze','plcdev_oip_generate','plcdev_team_reconcile']);
});
