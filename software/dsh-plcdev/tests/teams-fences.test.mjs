import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationRoutes } from '../src/conversations.mjs';
import { createTeamIntegration, TEAM_PROVIDER, TEAM_MODEL } from '../src/teams.mjs';

async function setup(t, accepted = true) {
  const directory=mkdtempSync(join(tmpdir(),'plcdev-team-fences-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const a='user-'+'a'.repeat(32), b='user-'+'b'.repeat(32), revision='c'.repeat(64);
  const agent=(id,createdAt)=>({session:{id,header:{id,createdAt,isSeeded:false}},options:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  const lead=agent('lead',10),actors=new Map([['lead',lead]]),effects=new Map(),hooks={},registrations=[];
  const residentSessions=new Map([['lead',lead.session]]),pendingLogs=new Map(),flushes=[];
  const logs=new Map([['lead',{header:structuredClone(lead.session.header),inheritedEventCount:0,events:[]}]]);
  const persistChild=(member,createdAt)=>{
    logs.get('lead').events.push({type:'team/member',data:{version:2,teamId:'lead',member:{id:member.id,name:member.name,provider:'spawn',context:'fresh',phase:'active'}}});
    logs.set(member.id,{header:{id:member.id,createdAt,isSeeded:false,parentSession:'lead'},inheritedEventCount:0,
      events:[{type:'subagent/descriptor',data:{version:3,mode:'continuable',provider:'spawn',agentProvider:TEAM_PROVIDER,agentModel:TEAM_MODEL}}]});
    residentSessions.set(member.id,actors.get(member.id)?.session??{id:member.id,header:structuredClone(logs.get(member.id).header)});
  };
  const stats={engineeringCreates:0,nativeCreates:0,spawns:0,interrupts:0,messages:0,runtimeActions:0};
  t.after(()=>assert.equal(stats.runtimeActions,0,'no Runtime action is permitted'));
  const original={taskId:'task-'+'d'.repeat(32),projectId:a,projectRevision:revision,workflow:'team-analysis-v1',request:'固定分析原工程',status:'team_waiting',
    teamAnalysis:{bindingVersion:1,members:['plc','hmi'].map(role=>({role,name:role+'-original',instruction:role+' fixed assignment',sessionId:null,nativeTaskId:null}))}};
  let task=accepted?structuredClone(original):null,reply=null,sequence=0;
  const members=[{id:'lead',name:'lead',role:'lead'}],nativeTasks=[];
  if(accepted)for(const [index,slot] of task.teamAnalysis.members.entries()) {
    const child=agent(slot.role,index+11);actors.set(child.session.id,child);slot.sessionId=child.session.id;slot.createdAt=child.session.header.createdAt;
    slot.nativeTaskId='native-'+slot.role;
    members.push({id:child.session.id,name:slot.name,role:'teammate',status:'inactive',context:'fresh'});
    persistChild(members.at(-1),child.session.header.createdAt);
    nativeTasks.push({id:slot.nativeTaskId,subject:task.taskId+'/'+slot.role,description:`工程 ${a}\n固定版本 ${revision}\n${slot.instruction}`,
      writeScopes:[`team-analysis/${task.taskId}/${slot.role}.json`],status:'in_progress',ownerName:slot.name,revision:2});
  }
  const ctx={agents:{get:id=>actors.get(id)},sessionProjections:{stateOf:()=>undefined},
    sessions:{get:id=>residentSessions.get(id),flush:async session=>{
      assert.equal(residentSessions.get(session.id),session);
      const pending=pendingLogs.get(session.id)??[];
      await hooks.flushBefore?.(session.id,pending.length);
      if(hooks.flushResult===false)return false;
      if(!hooks.dropFlush)logs.get(session.id).events.push(...structuredClone(pending));
      flushes.push({id:session.id,count:pending.length});pendingLogs.delete(session.id);
      await hooks.flushAfter?.(session.id,pending.length);return true;
    }},sessionPersistence:{open:async(id,mode)=>{
      assert.equal(mode,'read');await hooks.open?.(id);const value=logs.get(id);if(!value)throw new Error('native log missing');
      return {...structuredClone(value),read:async()=>({events:structuredClone(value.events)}),close:async()=>{}};
    }},agentTeams:{
    membership:who=>({root:lead,id:'lead',role:who===lead?'lead':'teammate',name:who===lead?'lead':members.find(m=>m.id===who.session.id).name}),
    listMembers:()=>structuredClone(members),listTasks:()=>structuredClone(nativeTasks),
    getTask:(_who,id)=>structuredClone(nativeTasks.find(x=>x.id===id)),
    createTask:async(_who,args)=>{stats.nativeCreates++;const value={...structuredClone(args),id:'native-'+nativeTasks.length,status:'pending',revision:1};nativeTasks.push(value);await hooks.nativeCreated?.();return structuredClone(value);},
    spawnTeammate:async(_who,args)=>{
      stats.spawns++;const member={id:'child-'+args.name,name:args.name,context:'fresh',role:'teammate',status:'inactive'};
      members.push(member);persistChild(member,100+stats.spawns);
      if(hooks.autoRegister!==false){const slot=task.teamAnalysis.members.find(s=>s.name===args.name);slot.sessionId=member.id;slot.createdAt=100+stats.spawns;}
      await hooks.spawned?.();return {member:structuredClone(member)};
    },
    interrupt:()=>{stats.interrupts++;return {previousStatus:'running'};},
    sendMessage:async(_who,args)=>{
      await hooks.sendBefore?.();stats.messages++;const messageId='message-'+stats.messages;
      const target=members.find(m=>m.name===args.target);assert.ok(target);
      const pending=pendingLogs.get(target.id)??[];
      pending.push({type:'user/message',data:{id:messageId,source:{kind:'agent-message',form:'relay',senderSessionId:'lead'},
        content:[{type:'text',text:'Team message from lead:'},...structuredClone(args.content)]}});pendingLogs.set(target.id,pending);
      await hooks.sendAfter?.();return {messageId};
    },
  }};
  const bridge={async handle(_method,path){
    if(path.startsWith('/api/plcdev/action')){stats.runtimeActions++;throw new Error('No Runtime action allowed');}
    const pid=new URL(path,'http://127.0.0.1').searchParams.get('project');
    return {status:200,body:{projectId:pid,projectRevision:revision,project:{id:pid},projects:[{id:a},{id:b}]}};
  },async team(operation,body){
    const {input}=body;
    if(operation==='model')return {ok:true,completion:{choices:[{finish_reason:reply?'tool_calls':'stop',message:reply?
      {content:null,tool_calls:[{id:reply.id,type:'function',function:{name:reply.name,arguments:JSON.stringify(reply.args)}}]}:{content:'read only'}}]}};
    if(operation==='create') {stats.engineeringCreates++;assert.equal(task,null,'must not recreate an accepted task');task=structuredClone(original);await hooks.accepted?.();}
    if(operation==='native-task')task.teamAnalysis.members.find(s=>s.role===input.role).nativeTaskId=input.nativeTaskId;
    if(operation==='member'){
      await hooks.memberBefore?.();const slot=task.teamAnalysis.members.find(s=>s.role===body.actor.role);
      assert.equal(slot.name,body.actor.name);assert.ok(slot.nativeTaskId);
      if(slot.sessionId){assert.equal(slot.sessionId,body.actor.sessionId);assert.equal(slot.createdAt,body.actor.createdAt);}
      else {slot.sessionId=body.actor.sessionId;slot.createdAt=body.actor.createdAt;registrations.push(structuredClone(body.actor));}
      await hooks.memberAfter?.();
    }
    if(operation==='effect-start'){
      const previous=effects.get(input.effectId);
      if(previous){assert.deepEqual(previous.payload,input.payload);return {send:false,result:previous.result};}
      effects.set(input.effectId,{payload:structuredClone(input.payload),result:null});
      await hooks.intent?.(input.effectId);return {send:true};
    }
    if(operation==='effect-finish'){
      await hooks.finishBefore?.(input.effectId);effects.get(input.effectId).result=structuredClone(input.result);await hooks.finishAfter?.(input.effectId);
    }
    return {ok:true,task:structuredClone(task)};
  }};
  const conversations=createConversationRoutes({controllerFile:join(directory,'controller.json'),bridge});
  const bind=async projectId=>{
    const value=await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'lead',projectId,expectedVersion:conversations.snapshot('lead').version});
    assert.equal(value.status,200);return value.body;
  };
  await bind(a);
  let integration=createTeamIntegration({ctx,bridge,conversations});
  const execute=async(name,args,execution)=>JSON.parse(await integration.tools.find(x=>x.name===name).execute(args,execution??{agent:lead,signal:new AbortController().signal,callId:'read-only'}));
  const issue=async(name,args,human='恢复原任务',humanId='human-'+sequence)=>{
    reply={id:'call-'+(++sequence),name,args};const id=reply.id;
    for await(const _ of integration.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:integration.tools,
      messages:[{id:humanId,role:'user',content:[{type:'text',text:human}]}]})){}
    reply=null;return {agent:lead,name,callId:id,signal:new AbortController().signal};
  };
  const planCall=async(assignments={plcInstruction:'plc fixed assignment',hmiInstruction:'hmi fixed assignment'})=>{
    const context=await execute('plcdev_team_context',{}),args={contextToken:context.contextToken,...assignments};
    return {args,execution:await issue('plcdev_team_plan',args)};
  };
  return {a,b,lead,ctx,stats,hooks,effects,members,nativeTasks,conversations,bind,execute,issue,planCall,logs,registrations,actors,bridge,pendingLogs,flushes,residentSessions,
    get task(){return task;},get integration(){return integration;},reopen({crash=false}={}){
      if(crash){pendingLogs.clear();residentSessions.clear();residentSessions.set('lead',lead.session);for(const id of actors.keys())if(id!=='lead')actors.delete(id);}
      integration=createTeamIntegration({ctx,bridge,conversations});
    }};
}

test('accepted but undispatched task recovers after durable A-B-A binding without recreating it',async t=>{
  const f=await setup(t,false);f.hooks.accepted=()=>f.bind(f.b);
  const first=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',first.args,first.execution),/绑定|改绑/);
  assert.equal(f.stats.engineeringCreates,1);assert.equal(f.stats.spawns,0);
  await f.bind(f.a);assert.equal(f.conversations.snapshot('lead').version,3);f.reopen();
  const original=structuredClone(f.task),retry=await f.planCall();
  const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.task.taskId,original.taskId);assert.equal(result.task.teamAnalysis.bindingVersion,1);
  await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.deepEqual(f.stats,{engineeringCreates:1,nativeCreates:2,spawns:2,interrupts:0,messages:0,runtimeActions:0});
});

test('binding changed after model response rejects final dispatch and direct execution',async t=>{
  const f=await setup(t),args={role:'plc',action:'interrupt',requestId:'control'};
  const execution=await f.issue('plcdev_team_control',args,'中断 PLC 成员');
  await f.bind(f.b);
  assert.match(f.integration.guard(execution),/绑定|改绑/);
  await assert.rejects(f.execute('plcdev_team_control',args,execution),/绑定|改绑/);
  assert.equal(f.stats.interrupts,0);assert.equal(f.effects.size,0);assert.equal(f.stats.runtimeActions,0);
});

test('binding changed while effect-start is in flight prevents the native member action',async t=>{
  const f=await setup(t),args={role:'plc',action:'interrupt',requestId:'control'};
  const execution=await f.issue('plcdev_team_control',args,'中断 PLC 成员','same-human-request');
  f.hooks.intent=()=>f.bind(f.b);
  await assert.rejects(f.execute('plcdev_team_control',args,execution),/绑定|改绑/);
  assert.equal(f.stats.interrupts,0);assert.equal(f.effects.size,1);assert.equal(f.stats.runtimeActions,0);
  f.hooks.intent=null;
  const stable=await f.issue('plcdev_team_control',args,'中断 PLC 成员','same-human-request');
  const result=await f.execute('plcdev_team_control',args,stable);
  assert.equal(result.result.unknown,true);assert.equal(result.ok,false);assert.equal(f.stats.interrupts,0);
});

test('A-B-A version changes and a newer stable request cannot lend authority to an old call',async t=>{
  const f=await setup(t),args={role:'plc',action:'interrupt',requestId:'control'};
  const old=await f.issue('plcdev_team_control',args,'中断 PLC 成员','old-human');
  await f.bind(f.b);await f.bind(f.a);
  assert.match(f.integration.guard(old),/绑定/);
  const fresh=await f.issue('plcdev_team_control',args,'中断 PLC 成员','new-human');
  await assert.rejects(f.execute('plcdev_team_control',args,old),/绑定/);
  assert.equal(f.integration.guard(fresh),undefined);
  assert.equal((await f.execute('plcdev_team_control',args,fresh)).ok,true);
  await f.execute('plcdev_team_control',args,fresh);
  assert.equal(f.stats.interrupts,1);assert.equal(f.stats.engineeringCreates,0);
});

test('stable binding B permits inspection and explicit control of the original task A',async t=>{
  const f=await setup(t),original=structuredClone(f.task);await f.bind(f.b);
  const status=await f.execute('plcdev_team_status',{});
  assert.equal(status.task.taskId,original.taskId);assert.equal(status.task.projectId,f.a);
  const args={role:'plc',action:'resume',requestId:'resume'},execution=await f.issue('plcdev_team_control',args,'恢复 PLC 成员');
  await f.execute('plcdev_team_control',args,execution);
  assert.equal(f.stats.messages,1);assert.equal(f.stats.engineeringCreates,0);
  assert.deepEqual(f.task,original);
});

test('resume is fenced after effect-start and its unknown delivery is not resent',async t=>{
  const f=await setup(t),args={role:'hmi',action:'resume',requestId:'resume'};
  const execution=await f.issue('plcdev_team_control',args,'继续 HMI 成员','same-resume');
  f.hooks.intent=()=>f.bind(f.b);
  await assert.rejects(f.execute('plcdev_team_control',args,execution),/绑定/);
  f.hooks.intent=null;f.reopen();
  const stable=await f.issue('plcdev_team_control',args,'继续 HMI 成员','same-resume');
  for(let i=0;i<2;i++)assert.equal((await f.execute('plcdev_team_control',args,stable)).ok,false);
  assert.equal(f.stats.messages,0);assert.equal(f.effects.size,1);
});

test('aborted request waiting on intent cannot act and leaves the receipt unknown',async t=>{
  const f=await setup(t),args={role:'plc',action:'interrupt',requestId:'stop'};
  const execution=await f.issue('plcdev_team_control',args,'中断 PLC 成员','abort-human');
  const controller=new AbortController();execution.signal=controller.signal;
  f.hooks.intent=()=>controller.abort(new Error('interrupted while awaiting intent'));
  await assert.rejects(f.execute('plcdev_team_control',args,execution),/interrupted/);
  f.hooks.intent=null;
  const stable=await f.issue('plcdev_team_control',args,'中断 PLC 成员','abort-human');
  assert.equal((await f.execute('plcdev_team_control',args,stable)).result.unknown,true);
  assert.equal(f.stats.interrupts,0);
});

test('unissued and pre-restart tool calls cannot mutate even with the current binding',async t=>{
  const f=await setup(t),args={role:'plc',action:'interrupt',requestId:'stop'};
  const issued=await f.issue('plcdev_team_control',args,'中断 PLC 成员');
  await assert.rejects(f.execute('plcdev_team_control',args,{...issued,callId:'forged'}),/请求绑定/);
  f.reopen();await assert.rejects(f.execute('plcdev_team_control',args,issued),/请求绑定/);
  assert.equal(f.effects.size,0);assert.equal(f.stats.interrupts,0);
});

test('plan response from A cannot deploy after final-dispatch binding changes',async t=>{
  const f=await setup(t,false),call=await f.planCall();await f.bind(f.b);
  assert.match(f.integration.guard(call.execution),/绑定/);
  await assert.rejects(f.execute('plcdev_team_plan',call.args,call.execution),/绑定/);
  assert.equal(f.task,null);assert.equal(f.effects.size,0);assert.equal(f.stats.engineeringCreates,0);
});

for(const effectId of ['native-task-plc','spawn-plc'])test(`binding change at ${effectId} intent blocks dispatch and no evidence means no retry`,async t=>{
  const f=await setup(t,false);f.hooks.intent=id=>id===effectId?f.bind(f.b):undefined;
  const first=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',first.args,first.execution),/绑定/);
  const snapshot=structuredClone(f.stats),taskId=f.task.taskId;assert.equal(snapshot.spawns,0);
  assert.equal(snapshot.nativeCreates,effectId==='spawn-plc'?1:0);
  f.hooks.intent=null;await f.bind(f.a);f.reopen();
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/待核对/);
  assert.deepEqual(f.stats,snapshot);assert.equal(f.task.taskId,taskId);
});

test('partial deployment recovers the exact original native task after rebind without another create',async t=>{
  const f=await setup(t,false);f.hooks.nativeCreated=()=>f.bind(f.b);
  const first=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',first.args,first.execution),/绑定/);
  const nativeId=f.nativeTasks[0].id,taskId=f.task.taskId;
  assert.equal(f.stats.nativeCreates,1);assert.equal(f.stats.spawns,0);
  f.hooks.nativeCreated=null;await f.bind(f.a);f.reopen();
  const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.task.taskId,taskId);assert.equal(result.task.teamAnalysis.members[0].nativeTaskId,nativeId);
  assert.equal(f.stats.engineeringCreates,1);assert.equal(f.stats.nativeCreates,2);assert.equal(f.stats.spawns,2);
});

test('lost spawn receipt adopts the original roster member without respawning or resending',async t=>{
  const f=await setup(t,false);f.hooks.autoRegister=false;f.hooks.spawned=()=>{throw new Error('lost spawn response');};
  const first=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',first.args,first.execution),/lost spawn/);
  const id=f.members[1].id,taskId=f.task.taskId,createdAt=f.logs.get(id).header.createdAt;f.hooks.spawned=null;f.hooks.autoRegister=true;f.reopen();
  const retry=await f.planCall();const recovered=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(recovered.ok,true);assert.equal(f.task.teamAnalysis.members[0].sessionId,id);assert.equal(f.task.teamAnalysis.members[0].createdAt,createdAt);
  assert.equal(f.conversations.snapshot(id).taskRefs[0].taskId,taskId);
  await f.execute('plcdev_team_plan',retry.args,retry.execution);
  const control={role:'plc',action:'interrupt',requestId:'after-registration'},execution=await f.issue('plcdev_team_control',control,'中断 PLC 成员');
  assert.equal((await f.execute('plcdev_team_control',control,execution)).ok,true);
  assert.equal(f.task.taskId,taskId);assert.equal(f.members[1].id,id);
  assert.equal(f.stats.engineeringCreates,1);assert.equal(f.stats.nativeCreates,2);assert.equal(f.stats.spawns,2);assert.equal(f.stats.messages,1);assert.equal(f.registrations.length,1);
});

test('accepted task retains exact saved assignments, original project and fresh context token',async t=>{
  const f=await setup(t);
  const changed=await f.planCall({plcInstruction:'replacement work',hmiInstruction:'hmi fixed assignment'});
  await assert.rejects(f.execute('plcdev_team_plan',changed.args,changed.execution),/原分工/);
  const old=await f.planCall();await f.bind(f.b);
  const other=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',other.args,other.execution),/原工程/);
  await f.bind(f.a);const fresh=await f.planCall();
  await assert.rejects(f.execute('plcdev_team_plan',old.args,fresh.execution),/上下文/);
  await f.execute('plcdev_team_plan',fresh.args,fresh.execution);
  assert.equal(f.stats.engineeringCreates,0);assert.equal(f.stats.nativeCreates,0);assert.equal(f.stats.spawns,0);
});

for(const mismatch of ['native-id','native-scopes','duplicate-task','member-id'])test(`recovery refuses ${mismatch} instead of creating replacements`,async t=>{
  const f=await setup(t);
  if(mismatch==='native-id')f.nativeTasks[0].id='other-task';
  if(mismatch==='native-scopes')f.nativeTasks[0].writeScopes=['other-scope'];
  if(mismatch==='duplicate-task')f.nativeTasks.push({...f.nativeTasks[0],id:'duplicate'});
  if(mismatch==='member-id')f.members[1].id='other-member';
  const call=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',call.args,call.execution),/身份|内容/);
  assert.equal(f.stats.engineeringCreates,0);assert.equal(f.stats.nativeCreates,0);assert.equal(f.stats.spawns,0);assert.equal(f.stats.messages,0);
});

async function interruptedRegistration(t) {
  const f=await setup(t,false);f.hooks.autoRegister=false;f.hooks.spawned=()=>{throw new Error('lost spawn response before member registration');};
  const first=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',first.args,first.execution),/lost spawn/);
  assert.equal(f.task.teamAnalysis.members[0].sessionId,null);
  f.hooks.spawned=null;f.hooks.autoRegister=true;f.reopen();return f;
}

for(const mismatch of ['parent-creation','parent-id','child-parent','child-id','seeded','inherited','descriptor','model-route','roster-id','roster-phase','missing-log'])
test(`unregistered roster recovery rejects ${mismatch} durable evidence`,async t=>{
  const f=await interruptedRegistration(t),root=f.logs.get('lead'),child=f.logs.get(f.members[1].id);
  if(mismatch==='parent-creation')root.header.createdAt=99;
  if(mismatch==='parent-id')root.header.id='other-lead';
  if(mismatch==='child-parent')child.header.parentSession='other-lead';
  if(mismatch==='child-id')child.header.id='other-child';
  if(mismatch==='seeded')child.header.isSeeded=true;
  if(mismatch==='inherited')child.inheritedEventCount=1;
  if(mismatch==='descriptor')child.events[0].data.mode='one-shot';
  if(mismatch==='model-route')child.events[0].data.agentProvider='other-provider';
  if(mismatch==='roster-id')root.events[0].data.member.id='other-child';
  if(mismatch==='roster-phase')root.events[0].data.member.phase='provisioning';
  if(mismatch==='missing-log')f.logs.delete(f.members[1].id);
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/身份|尚未恢复/);
  assert.equal(f.task.teamAnalysis.members[0].sessionId,null);assert.equal(f.registrations.length,0);
  assert.equal(f.stats.spawns,1);assert.equal(f.stats.nativeCreates,1);assert.equal(f.stats.messages,0);
});

for(const window of ['memberBefore','memberAfter'])test(`lost ${window} response preserves unknown recovery intent without a duplicate wake-up`,async t=>{
  const f=await interruptedRegistration(t);f.hooks[window]=()=>{throw new Error('lost registration response');};
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/登记回执未知/);
  assert.equal(f.stats.messages,0);f.hooks[window]=null;f.reopen();
  const next=await f.planCall();
  for(let n=0;n<2;n++){
    const result=await f.execute('plcdev_team_plan',next.args,next.execution);
    assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(result.recovery[0].registered,true);
  }
  assert.equal(f.task.teamAnalysis.members[0].sessionId,f.members[1].id);
  assert.equal(f.registrations.length,1);assert.equal(f.stats.messages,0);assert.equal(f.stats.spawns,1);assert.equal(f.stats.nativeCreates,1);
});

for(const window of ['sendBefore','sendAfter'])test(`lost ${window} recovery receipt reconciles only proven delivery without resending`,async t=>{
  const f=await interruptedRegistration(t);f.hooks[window]=()=>{throw new Error('lost recovery delivery response');};
  const retry=await f.planCall();assert.equal((await f.execute('plcdev_team_plan',retry.args,retry.execution)).ok,false);
  f.hooks[window]=null;f.reopen();const next=await f.planCall();
  const recovered=await f.execute('plcdev_team_plan',next.args,next.execution);
  assert.equal(recovered.ok,window==='sendAfter');
  if(window==='sendAfter')assert.equal(recovered.recovery[0].messageId,'message-1');
  else assert.equal(recovered.recovery[0].unknown,true);
  await f.execute('plcdev_team_plan',next.args,next.execution);
  assert.equal(f.stats.messages,window==='sendAfter'?1:0);assert.equal(f.registrations.length,1);
  assert.equal(f.stats.spawns,window==='sendAfter'?2:1);
});

for(const mismatch of ['sender','body','duplicate'])test(`unknown member activation cannot use ${mismatch} message evidence`,async t=>{
  const f=await interruptedRegistration(t);f.hooks.sendAfter=()=>{throw new Error('lost delivery receipt');};
  const retry=await f.planCall();assert.equal((await f.execute('plcdev_team_plan',retry.args,retry.execution)).ok,false);
  f.hooks.sendAfter=null;const events=f.pendingLogs.get(f.members[1].id),message=events.at(-1).data;
  if(mismatch==='sender')message.source.senderSessionId='other-lead';
  if(mismatch==='body')message.content[1].text+=' wrong';
  if(mismatch==='duplicate')events.push({type:'user/message',data:{...structuredClone(message),id:'duplicate-message'}});
  f.reopen();const next=await f.planCall();
  if(mismatch==='duplicate')await assert.rejects(f.execute('plcdev_team_plan',next.args,next.execution),/多个编号/);
  else assert.equal((await f.execute('plcdev_team_plan',next.args,next.execution)).ok,false);
  assert.equal(f.stats.messages,1);assert.equal(f.stats.spawns,1);assert.equal(f.registrations.length,1);
});

test('running original member is registered without sending another prompt and can be controlled by the original identity',async t=>{
  const f=await interruptedRegistration(t);f.members[1].status='running';
  const retry=await f.planCall(),result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,true);assert.equal(result.recovery[0].activation,'running');assert.equal(f.stats.messages,0);
  const args={role:'plc',action:'interrupt',requestId:'original-member'},execution=await f.issue('plcdev_team_control',args,'中断 PLC 成员');
  assert.equal((await f.execute('plcdev_team_control',args,execution)).ok,true);
  assert.equal(f.registrations[0].sessionId,f.members[1].id);assert.equal(f.stats.interrupts,1);
});

for(const window of ['proof','intent','roster-swap'])test(`member registration recovery fences ${window} changes before registration or delivery`,async t=>{
  const f=await interruptedRegistration(t);
  if(window==='proof')f.hooks.open=()=>f.bind(f.b);
  else f.hooks.intent=id=>{
    if(id!=='member-recovery-plc')return;
    if(window==='roster-swap')f.members[1].id='replacement-child';else return f.bind(f.b);
  };
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/绑定|身份/);
  assert.equal(f.registrations.length,0);assert.equal(f.stats.messages,0);assert.equal(f.stats.spawns,1);
});

test('provisioning and unavailable persistence never count as recovered registration',async t=>{
  const f=await interruptedRegistration(t);f.members[1].status='provisioning';
  let retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/尚未恢复/);
  f.members[1].status='inactive';f.ctx.sessionPersistence=null;
  retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/尚未恢复/);
  assert.equal(f.registrations.length,0);assert.equal(f.stats.messages,0);assert.equal(f.stats.spawns,1);
});

test('lost recovery intent receipt cannot silently turn into successful deployment',async t=>{
  const f=await interruptedRegistration(t);f.hooks.intent=id=>{if(id==='member-recovery-plc')throw new Error('lost intent response');};
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/意图回执未知/);
  assert.equal(f.registrations.length,0);f.hooks.intent=null;f.reopen();const next=await f.planCall();
  const result=await f.execute('plcdev_team_plan',next.args,next.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.registrations.length,1);assert.equal(f.stats.messages,0);
});

for(const window of ['finishBefore','finishAfter'])test(`lost recovery ${window} confirmation recovers the same registration and one message`,async t=>{
  const f=await interruptedRegistration(t);f.hooks[window]=id=>{if(id==='member-recovery-plc')throw new Error('lost confirmation response');};
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/lost confirmation/);
  assert.equal(f.registrations.length,1);assert.equal(f.stats.messages,1);
  f.hooks[window]=null;f.reopen();const next=await f.planCall();
  for(let n=0;n<2;n++){
    const result=await f.execute('plcdev_team_plan',next.args,next.execution);
    assert.equal(result.ok,true);assert.equal(result.recovery[0].messageId,'message-1');
  }
  assert.equal(f.registrations.length,1);assert.equal(f.stats.messages,1);assert.equal(f.stats.spawns,2);assert.equal(f.stats.nativeCreates,2);
});

test('a replaced live child appearing during intent persistence cannot be registered or resumed',async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.intent=effectId=>{
    if(effectId==='member-recovery-plc')f.actors.set(id,{session:{id,header:{id,createdAt:999,isSeeded:false}},options:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  };
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/身份变化/);
  assert.equal(f.registrations.length,0);assert.equal(f.stats.messages,0);assert.equal(f.stats.spawns,1);
});

test('buffered recovery acceptance is persisted before the engineering receipt can finish',async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.finishBefore=effectId=>{
    if(effectId!=='member-recovery-plc')return;
    assert.ok(f.flushes.some(row=>row.id===id&&row.count===1),'must flush the target child after send');
    assert.equal(f.logs.get(id).events.filter(e=>e.type==='user/message'&&e.data.id==='message-1').length,1,'same messageId must be durable');
  };
  const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,true);assert.equal(result.recovery[0].messageId,'message-1');assert.equal(f.stats.messages,1);
});

test('recovery flush failure remains unknown after buffered messages are lost with the host',async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.flushBefore=(_id,count)=>{if(count)throw new Error('buffered write failed');};
  const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.effects.get('member-recovery-plc').result,null);
  assert.equal(f.logs.get(id).events.filter(e=>e.type==='user/message').length,0);
  f.hooks.flushBefore=null;f.reopen({crash:true});const after=await f.planCall();
  assert.equal((await f.execute('plcdev_team_plan',after.args,after.execution)).ok,false);assert.equal(f.stats.messages,1);assert.equal(f.stats.spawns,1);
});

test('legacy accepted recovery receipt without a durable message is unknown after reopen',async t=>{
  const f=await interruptedRegistration(t),slot=f.task.teamAnalysis.members[0],id=f.members[1].id;
  slot.sessionId=id;slot.createdAt=f.logs.get(id).header.createdAt;
  f.effects.set('member-recovery-plc',{payload:{sessionId:id,createdAt:slot.createdAt,nativeTaskId:slot.nativeTaskId},result:{registered:true,activation:'accepted',messageId:'missing-message'}});
  f.reopen({crash:true});const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.stats.messages,0);assert.equal(f.stats.spawns,1);
});

for(const failure of ['no-listener','dropped-write','disconnect','missing-log'])test(`accepted recovery with ${failure} never completes the engineering receipt`,async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.sendAfter=()=>{
    if(failure==='no-listener')f.hooks.flushResult=false;
    if(failure==='dropped-write')f.hooks.dropFlush=true;
    if(failure==='disconnect')f.hooks.flushBefore=(_id,count)=>{if(count){f.pendingLogs.clear();f.residentSessions.delete(id);throw new Error('host disconnected before flush');}};
    if(failure==='missing-log')f.logs.delete(id);
  };
  const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.effects.get('member-recovery-plc').result,null);
  assert.equal(f.stats.messages,1);assert.equal(f.stats.nativeCreates,1);assert.equal(f.stats.spawns,1);
});

test('flush response loss after durable write recovers the same message after a host crash',async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.flushAfter=(_id,count)=>{if(count)throw new Error('flush response lost after persistence');};
  const retry=await f.planCall();assert.equal((await f.execute('plcdev_team_plan',retry.args,retry.execution)).ok,false);
  assert.equal(f.logs.get(id).events.filter(e=>e.type==='user/message').length,1);assert.equal(f.effects.get('member-recovery-plc').result,null);
  f.hooks.flushAfter=null;f.reopen({crash:true});const next=await f.planCall();const result=await f.execute('plcdev_team_plan',next.args,next.execution);
  assert.equal(result.ok,true);assert.equal(result.recovery[0].messageId,'message-1');assert.equal(result.recovery[0].durable,true);assert.equal(f.stats.messages,1);
});

test('binding change while recovery flush is pending leaves the receipt unknown and never resends',async t=>{
  const f=await interruptedRegistration(t);
  f.hooks.flushBefore=(_id,count)=>count?f.bind(f.b):undefined;
  const retry=await f.planCall();assert.equal((await f.execute('plcdev_team_plan',retry.args,retry.execution)).ok,false);
  assert.equal(f.effects.get('member-recovery-plc').result,null);assert.equal(f.stats.messages,1);
  f.hooks.flushBefore=null;await f.bind(f.a);f.reopen({crash:true});const next=await f.planCall();
  assert.equal((await f.execute('plcdev_team_plan',next.args,next.execution)).ok,true);assert.equal(f.stats.messages,1);assert.equal(f.stats.spawns,2);
});

test('replacement Session owner during flush cannot attest the original child message',async t=>{
  const f=await interruptedRegistration(t),id=f.members[1].id;
  f.hooks.flushAfter=(sessionId,count)=>{
    if(sessionId===id&&count)f.residentSessions.set(id,{id,header:{id,createdAt:999,isSeeded:false}});
  };
  const retry=await f.planCall();const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.effects.get('member-recovery-plc').result,null);assert.equal(f.stats.messages,1);
});

test('a confirmed recovery receipt must retain the exact persisted messageId on reopen',async t=>{
  const f=await interruptedRegistration(t),retry=await f.planCall();
  assert.equal((await f.execute('plcdev_team_plan',retry.args,retry.execution)).ok,true);
  f.effects.get('member-recovery-plc').result.messageId='different-id';f.reopen({crash:true});const next=await f.planCall();
  const result=await f.execute('plcdev_team_plan',next.args,next.execution);
  assert.equal(result.ok,false);assert.equal(result.recovery[0].unknown,true);assert.equal(f.stats.messages,1);
});

test('durable recovery stays confirmed after host memory loss without another native task or message',async t=>{
  const f=await interruptedRegistration(t),retry=await f.planCall();
  const result=await f.execute('plcdev_team_plan',retry.args,retry.execution);assert.equal(result.ok,true);assert.equal(result.recovery[0].durable,true);
  const counts=structuredClone(f.stats),original=structuredClone(f.task);f.reopen({crash:true});const next=await f.planCall();
  for(let n=0;n<2;n++)assert.equal((await f.execute('plcdev_team_plan',next.args,next.execution)).ok,true);
  assert.deepEqual(f.stats,counts);assert.deepEqual(f.task,original);assert.equal(f.stats.messages,1);
});

test('host loss before engineering confirmation recovers the durable message without repeating the send',async t=>{
  const f=await interruptedRegistration(t);f.hooks.finishBefore=id=>{
    if(id==='member-recovery-plc'){f.reopen({crash:true});throw new Error('host lost before engineering confirmation');}
  };
  const retry=await f.planCall();await assert.rejects(f.execute('plcdev_team_plan',retry.args,retry.execution),/host lost/);
  assert.equal(f.effects.get('member-recovery-plc').result,null);f.hooks.finishBefore=null;const next=await f.planCall();
  const result=await f.execute('plcdev_team_plan',next.args,next.execution);assert.equal(result.ok,true);assert.equal(result.recovery[0].messageId,'message-1');assert.equal(f.stats.messages,1);
});
