import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectContext} from '../src/project-context.mjs';

function fixture(){
 const events=new Map(),log=[],binding={projectId:'p',version:1},disposers=[];let prompt;
 const boundary={lastTurn:1,openTurnStartSeq:0};
 const ctx={on:(n,f)=>events.set(n,f),effect:f=>{disposers.push(f());},systemPrompt:{context:p=>{prompt=p;return()=>{};}},sessionProjections:{stateOf:()=>boundary}};
 const route={provider:'A',model:'a'},agent={session:{id:'chat',snapshotEvents:()=>log,requestHeader:()=>({config:route})}};
 const conversations={snapshot:()=>binding,claimRevision:()=>null};
 const service=createProjectContext({ctx,conversations}),abort=new AbortController();
 const enter=async(turn=1)=>{boundary.lastTurn=turn;boundary.openTurnStartSeq=turn;await events.get('agent/pre-step')({agent,turn,step:1,signal:abort.signal,messages:[{source:{kind:'user'},content:[{type:'text',text:'标题改成 6'}]}]},async()=>({kind:'continue'}));await events.get('agent/request')({agent,turn,step:1},async()=>({...route}));};
 const call=()=>{log.push({type:'assistant/message',data:{turn:boundary.lastTurn,step:1,message:{content:[{type:'tool-call',id:'c'+boundary.lastTurn,name:'plcdev_project_context'}]}}});return {agent,callId:'c'+boundary.lastTurn,name:'plcdev_project_context',signal:abort.signal};};
 return {events,log,binding,boundary,route,agent,service,abort,enter,call,prompt:()=>prompt,conversations,dispose:()=>disposers.forEach(f=>f?.())};
}
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
 await f.events.get('agent/request')({agent:f.agent,turn:1},async()=>({...f.route}));assert.throws(()=>f.service.assertExecution(exec),/本轮模型已切换/);
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
