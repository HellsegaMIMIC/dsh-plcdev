import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamIntegration, TEAM_MODEL, TEAM_PROVIDER, ROLE_TOOLS } from '../src/teams.mjs';

function fixture() {
  const agent = (id, time) => ({ session: { id, header: { createdAt: time, isSeeded: false } }, options: { provider: TEAM_PROVIDER, model: TEAM_MODEL } });
  const lead=agent('lead',10), plc=agent('plc',11), hmi=agent('hmi',12), actors=new Map([lead,plc,hmi].map(a=>[a.session.id,a]));
  const project='user-'+'a'.repeat(32), revision='b'.repeat(64);
  const task={taskId:'task-'+'c'.repeat(32),projectId:project,projectRevision:revision,workflow:'team-analysis-v1',request:'只分析本工程',status:'team_waiting',
    teamAnalysis:{bindingVersion:1,members:[{role:'plc',name:'plc-task',sessionId:'plc',createdAt:11,nativeTaskId:'t1',instruction:'PLC 接口'}, {role:'hmi',name:'hmi-task',sessionId:'hmi',createdAt:12,nativeTaskId:'t2',instruction:'HMI 控件'}]}};
  let binding={projectId:project,version:1};
  const selections=new Map();
  const ctx={agents:{get:id=>actors.get(id)},sessionProjections:{stateOf:(session,key)=>{assert.equal(key,'modelSelection');return selections.get(session.id);}},agentTeams:{
    membership:a=>({root:lead,id:'lead',role:a===lead?'lead':'teammate',name:a===lead?'lead':a.session.id+'-task'}),
    listMembers:()=>[{id:'lead',role:'lead',name:'lead'},{id:'plc',role:'teammate',name:'plc-task',context:'fresh',status:'inactive'},{id:'hmi',role:'teammate',name:'hmi-task',context:'fresh',status:'inactive'}],
    getTask:(_a,id)=>({id,status:'in_progress'}),listTasks:()=>[],
  }};
  const calls=[], references=[], issued=new Map();let sequence=0;
  const bridge={async team(operation,body){calls.push({operation,body});if(operation==='model'){
    const brief=JSON.parse(body.input.messages[0].content.split('\n').slice(1).join('\n'));
    if(brief.requestedControl){
      const id='call-'+(++sequence);issued.set(body.actor.sessionId,id);
      return {ok:true,completion:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id,type:'function',function:{name:'plcdev_team_control',arguments:JSON.stringify(brief.requestedControl)}}]}}]}};
    }
    return {ok:true,completion:{choices:[{finish_reason:'stop',message:{content:'独立分析'}}]}};
  }
    if(operation==='context')return {ok:true,context:{interface:body.actor.role}};return {ok:true,task};},async handle(){return {status:200,body:{projectId:project,projectRevision:revision}};}};
  const conversations={snapshot:()=>binding,referenceTeam:(id,t)=>references.push([id,t.taskId])};
  const reopen=()=>createTeamIntegration({ctx,bridge,conversations});
  const team=reopen();
  const exec=a=>({agent:a,signal:new AbortController().signal,callId:issued.get(a.session.id)??'read-only'});
  return {team,ctx,bridge,lead,plc,hmi,calls,task,exec,reopen,selections,rebind:()=>{binding={projectId:'user-'+'d'.repeat(32),version:2};}};
}

test('native authority requires exact live child identity; same name, fork and stale epoch cannot grant roles',async()=>{
  const f=fixture();
  assert.equal((await f.team.authority(f.plc)).role,'plc');
  await assert.rejects(f.team.authority({...f.plc}),/真实/);
  f.plc.session.header.isSeeded=true;
  await assert.rejects(f.team.authority(f.plc),/fork/);f.plc.session.header.isSeeded=false;
  f.task.teamAnalysis.members[0].createdAt=99;
  await assert.rejects(f.team.authority(f.plc),/另一个/);
});
test('final native dispatch guard is synchronous, role scoped and blocks generic tools and old engineering tools',async()=>{
  const f=fixture();await f.team.authority(f.plc);
  assert.equal(f.team.guard({...f.exec(f.plc),name:'plcdev_plc_analyze'}),undefined);
  for(const name of ['plcdev_hmi_analyze','plcdev_team_plan','plcdev_propose_joint','pwsh','read','team_task_update']){
    const value=f.team.guard({...f.exec(f.plc),name});assert.equal(typeof value,'string');
  }
  const hmi=f.team.tools.find(t=>t.name==='plcdev_hmi_analyze');
  await assert.rejects(hmi.execute({taskId:f.task.taskId,projectId:f.task.projectId,projectRevision:f.task.projectRevision},f.exec(f.plc)),/角色/);
  assert.equal(f.team.guard({name:'read',agent:{options:{provider:'normal'}}}),undefined);
});
test('member route drops private host and unrelated history, exposes only own tools and pins original project after rebind',async()=>{
  const f=fixture();f.rebind();
  const options={provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'plc',tools:f.team.tools,messages:[{role:'system',content:[{type:'text',text:'PRIVATE HOST'}]},
    {role:'user',content:[{type:'text',text:'UNRELATED HISTORY'}]}, {role:'tool',source:{callId:'unknown'},content:[{type:'text',text:'SECRET FILE'}]}]};
  const events=[];for await(const e of f.team.adapter.stream(options))events.push(e);
  const sent=f.calls.find(c=>c.operation==='model').body;
  assert.deepEqual(sent.input.tools.map(t=>t.function.name),ROLE_TOOLS.plc);
  assert.equal(sent.input.projectId,f.task.projectId);
  assert.ok(!/PRIVATE|UNRELATED|SECRET/.test(JSON.stringify(sent)));
  assert.ok(events.some(e=>e.type==='text-delta'));
});
test('inflight Lead rebind rejects model result before any tool emission',async()=>{
  const f=fixture(),original=f.bridge.team;
  f.bridge.team=async(op,body)=>{const value=await original(op,body);if(op==='model')f.rebind();return value;};
  const emitted=[];
  await assert.rejects(async()=>{for await(const e of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:f.team.tools,messages:[{role:'user',content:[{type:'text',text:'只分析本工程'}]}]}))emitted.push(e);},/改绑/);
  assert.equal(emitted.length,0);
});

test('a settled rebind does not prevent Lead from inspecting the original pinned task',async()=>{
  const f=fixture();f.rebind();const events=[];
  for await(const event of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:f.team.tools,
    messages:[{id:'inspect-old-task',role:'user',content:[{type:'text',text:'核对原任务'}]}]}))events.push(event);
  assert.ok(events.some(event=>event.type==='text-delta'));
  assert.equal(f.calls.find(call=>call.operation==='model').body.input.projectId,f.task.projectId);
});

function recoveryFixture(failure) {
  const f=fixture(),slot=f.task.teamAnalysis.members[0],effects=new Map(),stats={reports:0,completions:0,notices:0};
  const original=f.bridge.team;
  const interrupt=at=>{if(failure===at){failure=null;throw new Error('simulated interruption: '+at);}};
  const native={id:slot.nativeTaskId,subject:f.task.taskId+'/plc',description:`工程 ${f.task.projectId}\n固定版本 ${f.task.projectRevision}\n${slot.instruction}`,
    ownerName:slot.name,status:'in_progress',revision:2,writeScopes:[`team-analysis/${f.task.taskId}/plc.json`]};
  f.ctx.agentTeams.getTask=(_a,id)=>{assert.equal(id,slot.nativeTaskId);return structuredClone(native);};
  f.ctx.agentTeams.updateTask=async(_a,args)=>{
    assert.equal(args.taskId,native.id);assert.equal(args.expectedRevision,native.revision);assert.equal(args.action,'complete');
    interrupt('before-complete');native.status='completed';native.revision++;stats.completions++;interrupt('complete-response');return structuredClone(native);
  };
  f.ctx.agentTeams.sendMessage=async(_a,args)=>{assert.equal(args.target,'lead');stats.notices++;return {messageId:'notice-1'};};
  f.bridge.team=async(op,body)=>{
    const base=await original(op,body),a=body.input;
    if(op==='report'){
      stats.reports++;slot.report=structuredClone(a.report);slot.reportDigest='e'.repeat(64);slot.contextDigest=a.contextDigest;interrupt('report-response');
    }
    if(op==='effect-start'){
      const old=effects.get(a.effectId);
      if(old){assert.deepEqual(old.payload,a.payload);return {send:false,result:old.result};}
      effects.set(a.effectId,{payload:structuredClone(a.payload)});interrupt('notice-intent');return {send:true};
    }
    if(op==='effect-finish'){
      interrupt('notice-response');effects.get(a.effectId).result=structuredClone(a.result);
      if(a.effectId==='report-notice-plc')slot.notice='accepted';
    }
    return base;
  };
  const ids={taskId:f.task.taskId,projectId:f.task.projectId,projectRevision:f.task.projectRevision};
  const reportArgs={...ids,contextDigest:'f'.repeat(64),report:{summary:'PLC 接口核对',findings:['目标值与应用反馈不同'],unverified:['运行中断线尚未验证']}};
  return {...f,slot,native,stats,ids,reportArgs};
}

for(const failure of ['report-response','before-complete','complete-response'])test(`persisted report recovers ${failure} after integration restart without duplicate work`,async()=>{
  const f=recoveryFixture(failure);
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute(f.reportArgs,f.exec(f.plc)),/simulated interruption/);
  assert.ok(f.slot.reportDigest);
  if(failure==='report-response')f.rebind();
  const restarted=f.reopen(),tool=restarted.tools.find(t=>t.name==='plcdev_team_reconcile');
  const result=JSON.parse(await tool.execute(f.ids,f.exec(f.plc)));
  assert.equal(result.task.teamAnalysis.members[0].notice,'accepted');
  await tool.execute(f.ids,f.exec(f.plc));
  assert.deepEqual(f.stats,{reports:1,completions:1,notices:1});
  assert.deepEqual(f.slot.report,f.reportArgs.report);
  assert.equal(f.calls.filter(c=>c.operation==='model'||c.operation==='create').length,0);
});

for(const failure of ['notice-intent','notice-response'])test(`unknown ${failure} remains unknown after restart and is never resent`,async()=>{
  const f=recoveryFixture(failure);
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute(f.reportArgs,f.exec(f.plc)),/simulated interruption/);
  const tool=f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile');
  for(let n=0;n<2;n++)assert.equal(JSON.parse(await tool.execute(f.ids,f.exec(f.plc))).notification.unknown,true);
  assert.equal(f.stats.reports,1);assert.equal(f.stats.completions,1);assert.equal(f.stats.notices,failure==='notice-intent'?0:1);
  assert.notEqual(f.slot.notice,'accepted');
});

function durableNoticeFixture() {
  const f=recoveryFixture('notice-response'),events=[];let closes=0,flushes=0;
  const send=f.ctx.agentTeams.sendMessage;
  f.ctx.agentTeams.sendMessage=async(agent,args)=>{
    const receipt=await send(agent,args);
    const message={id:receipt.messageId,source:{kind:'agent-message',form:'relay',senderSessionId:agent.session.id},
      content:[{type:'text',text:`Team message from ${f.slot.name}:`},...args.content]};
    events.push({type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:0,inserted:[message]}});
    events.push({type:'user/message',data:structuredClone(message)});
    return receipt;
  };
  f.ctx.sessions={flush:async session=>{assert.equal(session,f.lead.session);flushes++;}};
  const header={id:'lead',createdAt:10,isSeeded:false};
  f.ctx.sessionPersistence={open:async(id,mode)=>{assert.equal(id,'lead');assert.equal(mode,'read');return {
    header,inheritedEventCount:0,read:async()=>({events:structuredClone(events)}),close:async()=>{closes++;},
  };}};
  return {...f,events,header,counts:()=>({closes,flushes})};
}

test('lost notification receipt is recovered from the exact durable native message without resending',async()=>{
  const f=durableNoticeFixture();
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute(f.reportArgs,f.exec(f.plc)),/interruption/);
  const reconcile=f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile');
  for(let n=0;n<2;n++){
    const result=JSON.parse(await reconcile.execute(f.ids,f.exec(f.plc)));
    assert.equal(result.ok,true);assert.deepEqual(result.notification,{messageId:'notice-1'});
    assert.equal(result.task.teamAnalysis.members[0].notice,'accepted');
  }
  assert.deepEqual(f.stats,{reports:1,completions:1,notices:1});assert.equal(f.counts().closes,1);
});

for(const mismatch of ['sender','body','source','missing'])test(`unknown notification with ${mismatch} evidence is not acknowledged or resent`,async()=>{
  const f=durableNoticeFixture();
  await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute(f.reportArgs,f.exec(f.plc)),/interruption/);
  if(mismatch==='missing')f.events.splice(0);
  else for(const event of f.events){
    const message=event.type==='user/message'?event.data:event.data.inserted[0];
    if(mismatch==='sender')message.source.senderSessionId='hmi';
    if(mismatch==='body')message.content[1].text+=' altered';
    if(mismatch==='source')message.source.kind='user';
  }
  const result=JSON.parse(await f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile').execute(f.ids,f.exec(f.plc)));
  assert.equal(result.ok,false);assert.equal(result.notification.unknown,true);
  assert.notEqual(f.slot.notice,'accepted');assert.deepEqual(f.stats,{reports:1,completions:1,notices:1});
});

test('duplicate message identities and replaced Lead logs fail closed and close the read handle',async()=>{
  for(const cause of ['duplicate','replaced']){
    const f=durableNoticeFixture();
    await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute(f.reportArgs,f.exec(f.plc)),/interruption/);
    if(cause==='duplicate')f.events.push({type:'user/message',data:{...f.events[1].data,id:'notice-2'}});
    else f.header.createdAt=99;
    await assert.rejects(f.reopen().tools.find(t=>t.name==='plcdev_team_reconcile').execute(f.ids,f.exec(f.plc)),/多条|身份/);
    assert.equal(f.counts().closes,1);assert.notEqual(f.slot.notice,'accepted');assert.equal(f.stats.notices,1);
  }
});

test('reconciliation rejects another project, stale version, absent report and mismatched native task',async()=>{
  const f=recoveryFixture();const tool=f.team.tools.find(t=>t.name==='plcdev_team_reconcile');
  await assert.rejects(tool.execute(f.ids,f.exec(f.lead)),/角色/);
  await assert.rejects(tool.execute(f.ids,f.exec(f.plc)),/尚无/);
  f.slot.report=f.reportArgs.report;f.slot.reportDigest='e'.repeat(64);
  for(const key of ['taskId','projectId','projectRevision'])await assert.rejects(tool.execute({...f.ids,[key]:'other'},f.exec(f.plc)),/原工程/);
  for(const [key,value] of [['subject','other'],['description','changed'],['ownerName','hmi-task'],['status','pending'],['status','deleted'],['writeScopes',[]]]){
    const saved=f.native[key];f.native[key]=value;
    await assert.rejects(tool.execute(f.ids,f.exec(f.plc)),/不符/);f.native[key]=saved;
  }
  assert.deepEqual(f.stats,{reports:0,completions:0,notices:0});
});

test('a resumed member with a persisted report is instructed to reconcile, not generate another report',async()=>{
  const f=recoveryFixture();f.slot.report=f.reportArgs.report;f.slot.reportDigest='e'.repeat(64);
  for await(const _ of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'plc',tools:f.team.tools,messages:[]})){}
  const sent=f.calls.find(c=>c.operation==='model').body.input;
  const brief=JSON.parse(sent.messages[0].content.split('\n').slice(1).join('\n'));
  assert.equal(brief.submitted,true);assert.match(brief.next,/plcdev_team_reconcile/);
  assert.ok(sent.tools.some(t=>t.function.name==='plcdev_team_reconcile'));
});

test('explicit resume can recover persisted reports; one human request sends only once and settled work is rejected',async()=>{
  const f=recoveryFixture();f.slot.report=f.reportArgs.report;f.slot.reportDigest='e'.repeat(64);
  let resumes=0;
  f.ctx.agentTeams.sendMessage=async(_a,args)=>{assert.equal(args.target,f.slot.name);assert.match(args.content[0].text,/plcdev_team_reconcile/);resumes++;return {messageId:'resume-1'};};
  const tool=f.team.tools.find(t=>t.name==='plcdev_team_control');
  for await(const _ of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:f.team.tools,
    messages:[{id:'human-resume-1',role:'user',content:[{type:'text',text:'继续 PLC 成员'}]}]})){}
  await tool.execute({role:'plc',action:'resume',requestId:'model-request-1'},f.exec(f.lead));
  await tool.execute({role:'plc',action:'resume',requestId:'model-request-2'},f.exec(f.lead));
  assert.equal(resumes,1);assert.equal(f.stats.reports,0);
  f.native.status='completed';f.slot.notice='accepted';
  await assert.rejects(tool.execute({role:'plc',action:'resume',requestId:'model-request-3'},f.exec(f.lead)),/已完成/);
});


test('native UI model selection supersedes creation options without weakening live identity',async()=>{
  const f=fixture();
  f.lead.options={provider:'old-provider',model:'old-model'};
  f.plc.options={};
  f.selections.set('lead',{pending:{provider:TEAM_PROVIDER,model:TEAM_MODEL},lastUsed:null});
  f.plc.session.requestHeader=()=>({config:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  assert.equal((await f.team.authority(f.plc)).role,'plc');
  assert.equal(f.team.guard({...f.exec(f.plc),name:'plcdev_plc_analyze'}),undefined);
  assert.equal(typeof f.team.guard({...f.exec(f.plc),name:'read'}),'string');
  await assert.rejects(f.team.authority({...f.plc}),/真实/);
  f.plc.session.header.isSeeded=true;
  await assert.rejects(f.team.authority(f.plc),/fork/);
});

test('latest native request header overrides stale construction and projection routes',async()=>{
  const f=fixture();
  f.selections.set('plc',{pending:null,lastUsed:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  f.plc.session.requestHeader=()=>({config:{provider:'other-provider',model:'other-model'}});
  await assert.rejects(f.team.authority(f.plc),/本路由/);
});

test('pending native switch rejects child tool dispatch and a child whose Lead switched away',async()=>{
  const f=fixture();await f.team.authority(f.plc);
  const away={provider:'other-provider',model:'other-model'};
  f.plc.session.requestHeader=()=>({config:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  f.selections.set('plc',{pending:away,lastUsed:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  assert.match(f.team.guard({...f.exec(f.plc),name:'plcdev_plc_analyze'}),/本路由/);
  assert.match(f.team.guard({...f.exec(f.plc),name:'read'}),/本路由/);
  f.plc.session.requestHeader=()=>({config:away});
  assert.equal(f.team.guard({...f.exec(f.plc),name:'read'}),undefined);
  f.plc.session.requestHeader=()=>({config:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  f.selections.delete('plc');f.selections.set('lead',{pending:away,lastUsed:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
  await assert.rejects(f.team.authority(f.plc),/父会话/);
});

test('native model switch while the provider is in flight rejects its old response',async()=>{
  const f=fixture(),original=f.bridge.team;
  f.bridge.team=async(op,body)=>{
    const value=await original(op,body);
    if(op==='model')f.selections.set('plc',{pending:{provider:'other',model:'other'},lastUsed:{provider:TEAM_PROVIDER,model:TEAM_MODEL}});
    return value;
  };
  const emitted=[];
  await assert.rejects(async()=>{
    for await(const event of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'plc',tools:f.team.tools,messages:[]}))emitted.push(event);
  },/本路由/);
  assert.equal(emitted.length,0);
});


test('team provider receives the real report bounds instead of an unbounded array schema',async()=>{
  const f=fixture();
  for await(const _ of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'plc',tools:f.team.tools,messages:[]})){}
  const schema=f.calls.find(c=>c.operation==='model').body.input.tools.find(t=>t.function.name==='plcdev_team_report').function.parameters.properties.report;
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required,['summary','findings','unverified']);
  assert.deepEqual(schema.properties.summary,{type:'string',minLength:1,maxLength:2000});
  for(const field of ['findings','unverified'])assert.deepEqual(schema.properties[field],{
    type:'array',minItems:1,maxItems:12,items:{type:'string',minLength:1,maxLength:1000},
  });
});

test('over-limit and empty reports are explicitly rejected before report writes or native completion',async()=>{
  const invalid=[
    {summary:''},{summary:'结'.repeat(2001)},{summary:12},
    {findings:[]},{findings:Array(13).fill('发现')},{findings:['']},{findings:['项'.repeat(1001)]},{findings:[null]},
    {unverified:[]},{unverified:Array(13).fill('待验')},{unverified:['']},{unverified:['项'.repeat(1001)]},{unverified:'待验'},
  ];
  for(const change of invalid){
    const f=recoveryFixture();
    await assert.rejects(f.team.tools.find(t=>t.name==='plcdev_team_report').execute({
      ...f.reportArgs,report:{...f.reportArgs.report,...change},
    },f.exec(f.plc)),/报告未提交.*重新提交/);
    assert.deepEqual(f.stats,{reports:0,completions:0,notices:0});
    assert.equal(f.slot.reportDigest,undefined);
    assert.ok(!f.calls.some(c=>c.operation==='report'||c.operation==='effect-start'));
  }
});

test('a rejected report can be corrected to exact bounds and submitted once without truncation',async()=>{
  const f=recoveryFixture(),tool=f.team.tools.find(t=>t.name==='plcdev_team_report');
  await assert.rejects(tool.execute({...f.reportArgs,report:{...f.reportArgs.report,findings:Array(13).fill('发现')}},f.exec(f.plc)),/报告未提交/);
  // Python and JSON Schema count Unicode code points, not UTF-16 code units.
  const bounded={summary:'😀'.repeat(2000),findings:Array(12).fill('😀'.repeat(1000)),unverified:Array(12).fill('待'.repeat(1000))};
  const result=JSON.parse(await tool.execute({...f.reportArgs,report:bounded},f.exec(f.plc)));
  assert.equal(result.ok,true);
  assert.deepEqual(f.slot.report,bounded);
  assert.deepEqual(f.stats,{reports:1,completions:1,notices:1});
});


test('explicit resume sees live inactive state and restores an unfinished original member without requiring prior interrupt',async()=>{
  const f=recoveryFixture();let resumes=0;
  f.ctx.agentTeams.sendMessage=async(_a,args)=>{assert.equal(args.target,'plc-task');resumes++;return {messageId:'resumed-original'};};
  const human={id:'resume-after-restart',role:'user',content:[{type:'text',text:'继续 PLC 成员'}]};
  for await(const _ of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:f.team.tools,messages:[human]})){}
  const sent=f.calls.find(c=>c.operation==='model').body.input;
  const brief=JSON.parse(sent.messages[0].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(brief.memberStates[0],{role:'plc',sessionId:'plc',name:'plc-task',status:'inactive',nativeTaskId:'t1',nativeTaskStatus:'in_progress',reportStored:false,notice:'not_confirmed'});
  assert.equal(brief.requestedControl.action,'resume');assert.equal(brief.requestedControl.role,'plc');
  assert.match(brief.next,/宿主重开或报告校验失败/);
  const context=JSON.parse(await f.team.tools.find(t=>t.name==='plcdev_team_context').execute({},f.exec(f.lead)));
  assert.deepEqual(context.memberStates,brief.memberStates);
  const tool=f.team.tools.find(t=>t.name==='plcdev_team_control');
  await tool.execute(brief.requestedControl,f.exec(f.lead));
  await tool.execute({...brief.requestedControl,requestId:'different-model-id'},f.exec(f.lead));
  assert.equal(resumes,1);assert.deepEqual(f.stats,{reports:0,completions:0,notices:0});
  assert.ok(!f.calls.some(c=>c.operation==='create'));
});

test('resume rechecks native state and refuses running, provisioning, failed and missing members before delivery intent',async()=>{
  for(const status of ['running','provisioning','failed','missing']){
    const f=recoveryFixture();
    const original=f.ctx.agentTeams.listMembers;
    f.ctx.agentTeams.listMembers=()=>original().filter(m=>status!=='missing'||m.id!=='plc').map(m=>m.id==='plc'?{...m,status}:m);
    for await(const _ of f.team.adapter.stream({provider:TEAM_PROVIDER,model:TEAM_MODEL,sessionId:'lead',tools:f.team.tools,messages:[{id:'resume',role:'user',content:[{type:'text',text:'继续 PLC 成员'}]}]})){}
    const tool=f.team.tools.find(t=>t.name==='plcdev_team_control');
    await assert.rejects(tool.execute({role:'plc',action:'resume',requestId:'resume-1'},f.exec(f.lead)),/正在运行|不可恢复|未核对/);
    assert.ok(!f.calls.some(c=>c.operation==='effect-start'));
    assert.deepEqual(f.stats,{reports:0,completions:0,notices:0});
  }
});
