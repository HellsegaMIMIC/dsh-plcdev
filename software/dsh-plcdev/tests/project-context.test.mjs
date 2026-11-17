import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectContext} from '../src/project-context.mjs';
import {createNativeTools,TOOL_NAMES} from '../src/native-tools.mjs';

function fixture(){
 const events=new Map(),log=[],binding={projectId:'p',version:1},disposers=[];let prompt,section;
 const boundary={lastTurn:1,openTurnStartSeq:0};
 const ctx={on:(n,f)=>events.set(n,f),effect:f=>{disposers.push(f());},systemPrompt:{context:p=>{prompt=p;return()=>{};},section:p=>{section=p;return()=>{};}},sessionProjections:{stateOf:()=>boundary}};
 const route={provider:'A',model:'a'},agent={session:{id:'chat',snapshotEvents:()=>log,requestHeader:()=>({config:route,tools:TOOL_NAMES.map(name=>({name}))})}};
 const conversations={snapshot:()=>binding,claimRevision:()=>null};
 const service=createProjectContext({ctx,conversations,verifiedRoutes:[{provider:'A',model:'a'},{provider:'B',model:'b'}]}),abort=new AbortController();
 agent.ctx={tools:{restrict:()=>()=>{}}};
 ctx.systemPrompt.assemble=async()=>({variables:{...route},tools:[]});
 const enter=async(turn=1)=>{boundary.lastTurn=turn;boundary.openTurnStartSeq=turn;await events.get('system-prompt/assemble')({}, {agent},async()=>({variables:{...route},tools:[{name:'plcdev_project_context'}]}));await events.get('agent/pre-step')({agent,turn,step:1,signal:abort.signal,messages:[{source:{kind:'user'},content:[{type:'text',text:'标题改成 6'}]}]},async()=>({kind:'continue'}));await events.get('agent/request')({agent,turn,step:1},async()=>({...route}));};
 let callSeq=0;
 const call=(name='plcdev_project_context')=>{const callId='c'+(++callSeq);log.push({type:'assistant/message',data:{turn:boundary.lastTurn,step:1,message:{content:[{type:'tool-call',id:callId,name}]}}});return {agent,callId,name,signal:abort.signal};};
 return {events,log,binding,boundary,route,agent,service,abort,enter,call,prompt:()=>prompt,section:()=>section,conversations,dispose:()=>disposers.forEach(f=>f?.())};
}
test('engineering policy is available before first pre-step and is separate from project data',async()=>{
 const f=fixture(),section=f.section();assert.equal(f.service.size(),0);
 assert.equal(section.name,'plcdev:workflow');assert.equal(section.interpolate,false);
 assert.match(section.text({agent:f.agent}),/直接用自然语言/);
 assert.match(section.text({agent:f.agent}),/普通聊天、解释、只读查询及无关文件任务/);
 assert.match(section.text({agent:f.agent}),/不要用 write\/edit、shell/);
 assert.equal(section.text({}), '');
 f.binding.projectId=null;assert.equal(section.text({agent:f.agent}),'');
 f.binding.projectId='p';await f.enter();
 assert.doesNotMatch(f.prompt().text({agent:f.agent}),/plcdev_propose_project_edit|PLCdev 工程操作规则/);
 f.dispose();
});
test('context detail grants require live turn/session/model/binding/source and never survive cancellation',async()=>{
 const f=fixture();f.binding.taskRefs=[];f.binding.pendingRequests=[];let revision='a'.repeat(64);
 const bridge={handle:async(_method,path)=>({status:200,body:path.includes('/status')?{project:{id:'p',name:'test'}}:{projectId:'p',projectRevision:revision,capabilities:{projectEditCandidate:true},editingInput:{operations:['test'],native:{large:'x'.repeat(50000)}},tasks:[]}})};
 const tools=createNativeTools({bridge,conversations:f.conversations,projectContext:f.service});
 const invoke=async(name,args={},exec=f.call(name))=>JSON.parse(await tools.find(t=>t.name===name).execute(args,exec));
 await f.enter();const context=await invoke('plcdev_project_context'),args={contextToken:context.contextToken,path:'/editingInput/operations',offset:0};
 assert.deepEqual((await invoke('plcdev_project_read',args)).value,['test']);
 await assert.rejects(invoke('plcdev_project_read',args,{...f.call('plcdev_project_read'),agent:{session:f.agent.session}}),/活动轮/);
 f.binding.version++;await assert.rejects(invoke('plcdev_project_read',args),/绑定已变化/);f.binding.version--;
 f.binding.projectId='other';await assert.rejects(invoke('plcdev_project_read',args),/绑定已变化/);f.binding.projectId='p';
 revision='b'.repeat(64);await assert.rejects(invoke('plcdev_project_read',args),/源版本已变化/);revision='a'.repeat(64);
 f.route.model='other';await assert.rejects(invoke('plcdev_project_read',args),/模型路由/);f.route.model='a';
 f.events.get('session/event')(f.agent.session,{type:'turn/end',data:{turn:1}});
 await f.enter(2);await assert.rejects(invoke('plcdev_project_read',args),/本轮尚未读取上下文/);
 const newer=await invoke('plcdev_project_context');assert.notEqual(newer.contextToken,args.contextToken);
 await assert.rejects(invoke('plcdev_project_read',args),/已过期/);
 f.abort.abort();await assert.rejects(invoke('plcdev_project_read',{...args,contextToken:newer.contextToken}));f.dispose();
});
test('two model routes share live context; end, cancel and fresh service never restore authority',async()=>{
 const f=fixture();await f.enter();const a=f.call();assert.equal(f.service.assertExecution(a).route.provider,'A');
 f.events.get('session/event')(f.agent.session,{type:'turn/end',data:{turn:1}});assert.equal(f.service.size(),0);assert.throws(()=>f.service.assertExecution(a));
 f.route.provider='B';f.route.model='b';await f.enter(2);assert.equal(f.service.assertExecution(f.call()).route.provider,'B');
 assert.throws(()=>f.service.assertExecution(a),/不属于/);
 f.abort.abort();assert.equal(f.service.size(),0);assert.throws(()=>f.service.assertExecution(a));
 const reopened=fixture();assert.throws(()=>reopened.service.assertExecution(a));
});
test('reject cross session, old call, binding/source route changes and same-turn model switch',async()=>{
 const f=fixture();await f.enter();const exec=f.call();
 assert.throws(()=>f.service.assertExecution({...exec,agent:{session:f.agent.session}}),/活动轮/);
 assert.throws(()=>f.service.assertExecution({...exec,callId:'stale'}),/不属于/);
 f.binding.version++;assert.throws(()=>f.service.assertExecution(exec),/绑定已变化/);f.binding.version--;
 f.route.model='other';assert.throws(()=>f.service.assertExecution(exec),/模型路由/);
 await assert.rejects(f.events.get('agent/request')({agent:f.agent,turn:1},async()=>({...f.route})),/组装后变化/);
});
test('plain chat remains available with no project or an unresolved revision',async()=>{
 const f=fixture();f.binding.projectId=null;await f.enter();assert.equal(f.prompt().text({agent:f.agent}),'');
 f.binding.projectId='p';f.conversations.claimRevision=()=>{throw new Error('原请求待核对');};await f.enter(2);
 assert.match(f.prompt().text({agent:f.agent}),/原请求待核对/);assert.throws(()=>f.service.assertExecution(f.call()),/原请求待核对/);
});
test('new human steering in the same turn invalidates the old plan rather than overwriting intent',async()=>{
 const f=fixture();await f.enter();const exec=f.call();
 await f.events.get('agent/pre-step')({agent:f.agent,turn:1,step:2,signal:f.abort.signal,messages:[{source:{kind:'user'},content:[{type:'text',text:'换成另一项修改'}]}]},async()=>({kind:'continue'}));
 assert.throws(()=>f.service.assertExecution(exec),/新的用户需求/);
 assert.equal(f.service.get('chat').userRequest,'标题改成 6');
});

test('a chat without engineering tools releases an unsubmitted revision for the next model',async()=>{
 const f=fixture();let owner=null;
 const intent={intentId:'revision-1',parent:{taskId:'candidate-1'}};
 f.binding.revisionContext={...intent,state:'armed'};
 f.conversations.claimRevision=(_id,key)=>{
  if(owner&&owner!==key)throw new Error('上次修订尚待核对');
  owner=key;f.binding.revisionContext.state='claimed';return intent;
 };
 f.conversations.releaseRevision=(_id,key)=>{
  if(owner!==key||f.binding.revisionContext.state!=='claimed')return false;
  owner=null;f.binding.revisionContext.state='armed';return true;
 };
 await f.enter();assert.equal(f.binding.revisionContext.state,'claimed');
 f.events.get('session/event')(f.agent.session,{type:'turn/end',data:{turn:1}});
 assert.equal(f.binding.revisionContext.state,'armed');assert.equal(f.service.size(),0);
 f.route.provider='B';f.route.model='b';await f.enter(2);
 assert.equal(f.service.assertExecution(f.call()).revision.parent.taskId,'candidate-1');
});

test('cancel, agent disposal and plugin unload release only their live unsubmitted claim',async()=>{
 for(const finish of [f=>f.abort.abort(),f=>f.events.get('agent/disposed')(f.agent),f=>f.dispose()]){
  const f=fixture(),released=[];
  f.conversations.claimRevision=()=>({intentId:'revision-1'});
  f.conversations.releaseRevision=(id,key)=>{released.push({id,key});return true;};
  await f.enter();const key=f.service.get('chat').turnKey;finish(f);
  assert.deepEqual(released,[{id:'chat',key}]);assert.equal(f.service.size(),0);
  f.events.get('session/event')(f.agent.session,{type:'turn/end',data:{turn:1}});
  assert.equal(released.length,1);
 }
});
test('engineering availability requires context plus at least one proposal tool',async()=>{
 for(const [tools,available] of [
  [['plcdev_propose_hmi_view_name'],false],
  [['plcdev_project_context'],false],
  [['plcdev_project_context','plcdev_propose_hmi_view_name'],true],
  [['plcdev_project_context','plcdev_propose_joint'],true],
 ]){
  const f=fixture();await f.enter();
  f.events.get('session/event')(f.agent.session,{type:'request/header',data:{header:{config:{...f.route},tools:tools.map(name=>({name}))}}});
  assert.equal(f.service.notice('chat')?.state||null,available?null:'tools-unavailable');
  if(!available){assert.equal(f.service.notice('chat').reason,'tools-filtered');assert.equal(f.service.notice('chat').toolMode,'native');}
  f.dispose();
 }
});

test('tool notice belongs to the exact project binding and an available request clears it',async()=>{
 const f=fixture();await f.enter();
 const header=tools=>f.events.get('session/event')(f.agent.session,{type:'request/header',data:{header:{config:{...f.route},tools:tools.map(name=>({name}))}}});
 header([]);assert.equal(f.service.notice('chat').projectId,'p');assert.equal(f.service.notice('chat').bindingVersion,1);
 header(['plcdev_project_context','plcdev_propose_hmi_readonly_value']);assert.equal(f.service.notice('chat'),null);
 header([]);f.binding.projectId='another-project';f.binding.version++;
 assert.equal(f.service.notice('chat'),null,'The old project notice must not follow a rebind');
 header([]);assert.equal(f.service.notice('chat'),null,'An old live scope must not recreate a stale notice');
 f.binding.projectId='p';f.binding.version=1;header([]);assert.ok(f.service.notice('chat'));
 f.binding.version=3;assert.equal(f.service.notice('chat'),null,'Returning to the same project is a new binding');
 f.dispose();
});
