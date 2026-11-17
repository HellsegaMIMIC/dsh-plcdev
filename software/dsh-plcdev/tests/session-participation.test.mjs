// Offline session identity and tool admission. Real SQLite, no model requests,
// user projects, editors, Runtime or host profile changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createConversationRoutes} from '../src/conversations.mjs';
import {createModelCapabilityGate} from '../src/model-capability.mjs';
import {createProjectContext} from '../src/project-context.mjs';
import {TOOL_NAMES} from '../src/native-tools.mjs';

const A='user-'+'a'.repeat(32),B='user-'+'b'.repeat(32),SID='participation-chat';
const evidence=fileURLToPath(new URL('../../../outputs/session-participation-20261117/',import.meta.url));
async function fixture(t){
  await mkdir(evidence,{recursive:true});
  const root=await mkdtemp(path.join(evidence,'state-'));
  const bridge={async handle(method,url){
    assert.equal(method,'GET');const id=new URL(url,'http://local').searchParams.get('project');
    return {status:200,body:{project:{id},projects:[A,B].map(id=>({id}))}};
  }};
  const open=()=>createConversationRoutes({controllerFile:path.join(root,'controller.json'),bridge});
  const routes=open();
  const bind=(projectId,expectedVersion,conversationId=SID)=>routes.handle('POST','/api/plcdev/conversations/bind',{conversationId,projectId,expectedVersion});
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(evidence));await rm(root,{recursive:true,force:true});});
  return {root,routes,open,bind};
}
test('new chat is ordinary; selecting then cancelling a project persists without engineering work',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.routes.snapshot(SID).participation,{enabled:false,locked:false});
  const on=await f.bind(A,0);assert.equal(on.status,200);assert.deepEqual(on.body.participation,{enabled:true,locked:false});
  assert.deepEqual(f.open().participation(SID),{enabled:true,locked:false});
  const off=await f.bind(null,1);assert.equal(off.status,200);assert.equal(off.body.version,2);
  assert.deepEqual(f.open().participation(SID),{enabled:false,locked:false});
  assert.throws(()=>f.routes.lockParticipation(SID,{projectId:A,version:1}),/尚未开启/);
  assert.deepEqual(f.routes.snapshot(SID).taskRefs,[]);
});
test('first authenticated operation locks identity durably; project switching remains separate from disabling',async t=>{
  const f=await fixture(t);await f.bind(A,0);
  assert.throws(()=>f.routes.lockParticipation(SID,{projectId:B,version:1}),/工程已变化/);
  assert.deepEqual(f.routes.participation(SID),{enabled:true,locked:false});
  assert.deepEqual(f.routes.lockParticipation(SID,{projectId:A,version:1}),{enabled:true,locked:true});
  assert.deepEqual(f.open().participation(SID),{enabled:true,locked:true});
  const off=await f.bind(null,1);assert.equal(off.status,409);assert.equal(off.body.code,'participation_locked');
  assert.equal(f.routes.snapshot(SID).projectId,A);assert.equal(f.routes.snapshot(SID).version,1);
  const switched=await f.bind(B,1);assert.equal(switched.status,200);assert.equal(switched.body.projectId,B);
  assert.deepEqual(switched.body.participation,{enabled:true,locked:true});
  assert.deepEqual(f.routes.participation('another-chat'),{enabled:false,locked:false});
});
test('legacy task evidence retains engineering identity even if an earlier version unbound the chat',async t=>{
  const f=await fixture(t);await f.bind(A,0);await f.bind(null,1);
  f.routes.referenceTeam(SID,{workflow:'team-analysis-v1',projectId:A,taskId:'task-'+'1'.repeat(32)});
  const restored=f.open().snapshot(SID);
  assert.equal(restored.projectId,null);assert.equal(restored.taskRefs.length,1);
  assert.deepEqual(restored.participation,{enabled:true,locked:true});
  const off=await f.bind(null,2);assert.equal(off.body.code,'participation_locked');
  const rebound=await f.bind(A,2);assert.equal(rebound.status,200);assert.equal(rebound.body.taskRefs.length,1);
});
test('pending, unknown and rejected submission attempts cannot be hidden by disabling',async t=>{
  for(const state of ['pending','unknown','rejected']){
    const f=await fixture(t);await f.bind(A,0);
    const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
    try{db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(SID,'attempt','fingerprint',A,1,'upstream','{}',state,null,'2026-11-17');}finally{db.close();}
    assert.deepEqual(f.open().participation(SID),{enabled:true,locked:true});
    assert.equal((await f.bind(null,1)).body.code,'participation_locked');
    const verify=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
    try{assert.equal(verify.prepare('SELECT state FROM submissions WHERE conversation_id=?').get(SID).state,state);}finally{verify.close();}
  }
});
test('canceling a legacy revision marker preserves the engineering identity after reopen',async t=>{
  const f=await fixture(t);await f.bind(A,0);
  const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
  try{db.prepare('INSERT INTO revision_intents VALUES(?,?,NULL,?)').run(SID,JSON.stringify({intentId:'legacy-intent',projectId:A,expectedVersion:1}),'armed');}finally{db.close();}
  assert.equal(f.routes.participation(SID).locked,true);
  const result=await f.routes.handle('POST','/api/plcdev/conversations/revision/cancel',{conversationId:SID,intentId:'legacy-intent'});
  assert.equal(result.status,200);assert.equal(result.body.revisionContext,undefined);
  assert.deepEqual(f.open().participation(SID),{enabled:true,locked:true});
  assert.equal((await f.bind(null,1)).body.code,'participation_locked');
});

function gateFixture({modern=false,mode='native',enabled=false}={}){
  const hooks=new Map(),normal='host_normal_tool',agent={session:{id:SID}},route={provider:'safe',model:'one'};
  const state={enabled,restricted:false,filters:0};
  const assemble=()=>({variables:route,tools:mode==='ptc'?[{name:'run_code'}]:[{name:normal},...(!state.restricted?TOOL_NAMES.map(name=>({name})):[])],sections:mode==='ptc'?[{name:'tools:sdk',text:[normal,...(!state.restricted?TOOL_NAMES:[])].join(',')}]:[]});
  agent.ctx={tools:{restrict:({deny})=>{assert.deepEqual(deny,TOOL_NAMES);state.restricted=true;state.filters++;return()=>{state.restricted=false;};}}};
  const ctx={on:(name,fn)=>hooks.set(name,fn),systemPrompt:{assemble:async()=>assemble()},agents:{get:()=>agent}};
  if(modern)ctx.tools={resolve(){},selectExecutor:()=>({constructor:{name:mode==='native'?'NativeToolExecutor':'PtcExecutor'}})};
  const gate=createModelCapabilityGate({ctx,verifiedRoutes:[route],isParticipating:()=>state.enabled});
  const run=async()=>{
    const names=gate.registrationOptions?.when({agent,modelSelection:route})?TOOL_NAMES:[];
    const context={agent,modelSelection:route,toolSet:{view:()=>new Map(names.map(name=>[name,{}]))}};
    return hooks.get('system-prompt/assemble')({},context,async()=>modern?{variables:route,tools:[{name:normal},...names.map(name=>({name}))]}:assemble());
  };
  return {gate,state,route,agent,run,hooks};
}
for(const modern of [false,true])for(const mode of ['native','ptc'])test(`${modern?'conditional':'legacy'} ${mode}: ordinary chat gets no PLCdev schema, enabled compatible chat does`,async()=>{
  const f=gateFixture({modern,mode});
  const ordinary=await f.run();assert.ok(ordinary.tools.some(t=>t.name==='host_normal_tool'||t.name==='run_code'));
  for(const name of TOOL_NAMES)assert.ok(!JSON.stringify(ordinary).includes(name),name);
  assert.equal(f.gate.request(f.agent,f.route),false);assert.equal(f.gate.diagnose(f.agent,f.route).reason,'session-disabled');
  f.state.enabled=true;const engineering=await f.run();
  assert.equal(f.gate.request(f.agent,f.route),mode==='native');
  if(mode==='native'){
    assert.ok(engineering.tools.some(t=>t.name===TOOL_NAMES[0]));
    f.state.enabled=false;
    assert.equal(f.gate.allows(f.agent,f.route),false);
    assert.throws(()=>f.gate.request(f.agent,f.route),/状态.*变化/);
    assert.throws(()=>f.hooks.get('llm/stream')({...f.route,sessionId:SID,tools:engineering.tools},()=>{}),/状态已变化/);
  }else for(const name of TOOL_NAMES)assert.ok(!JSON.stringify(engineering).includes(name),name);
});

test('forged/stale executions do not lock a chat; authenticated read locks before returning authority',async t=>{
  const f=await fixture(t);await f.bind(A,0);
  const hooks=new Map(),log=[],route={provider:'safe',model:'one'},boundary={lastTurn:1,openTurnStartSeq:0};
  const ctx={on:(name,fn)=>hooks.set(name,fn),effect:fn=>fn(),sessionProjections:{stateOf:()=>boundary},systemPrompt:{section:()=>()=>{},context:()=>()=>{}}};
  const agent={session:{id:SID,snapshotEvents:()=>log,requestHeader:()=>({config:route,tools:TOOL_NAMES.map(name=>({name}))})}};
  const service=createProjectContext({ctx,conversations:f.routes,verifiedRoutes:[route]}),signal=new AbortController().signal;
  await hooks.get('system-prompt/assemble')({}, {agent},async()=>({variables:route,tools:[{name:TOOL_NAMES[0]}]}));
  await hooks.get('agent/pre-step')({agent,turn:1,step:1,signal,messages:[]},async()=>({kind:'continue'}));
  await hooks.get('agent/request')({agent,turn:1,step:1},async()=>route);
  const exec={agent,callId:'call-1',name:TOOL_NAMES[0],signal};
  assert.throws(()=>service.assertExecution(exec),/不属于/);assert.equal(f.routes.participation(SID).locked,false);
  log.push({type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'tool-call',id:exec.callId,name:exec.name}]}}});
  assert.equal(service.assertExecution(exec).projectId,A);assert.equal(f.open().participation(SID).locked,true);
  assert.equal((await f.bind(null,1)).body.code,'participation_locked');
});
test('off winning the first-operation race rejects the old execution without reactivating the session',async t=>{
  const f=await fixture(t);await f.bind(A,0);await f.bind(null,1);
  assert.throws(()=>f.routes.lockParticipation(SID,{projectId:A,version:1}),/尚未开启/);
  assert.deepEqual(f.open().participation(SID),{enabled:false,locked:false});
  await f.bind(B,2);
  assert.throws(()=>f.routes.lockParticipation(SID,{projectId:A,version:1}),/工程已变化/);
  assert.deepEqual(f.open().participation(SID),{enabled:true,locked:false});
});
