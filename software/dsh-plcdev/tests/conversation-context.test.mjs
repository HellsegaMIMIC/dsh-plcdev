import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationContexts,bindingError,bindingBlockedReason} from '../src/client/conversation-context.mjs';
import {createProjectContexts,runtimeToolActions} from '../src/client/project-context.mjs';
const flush=()=>new Promise(r=>setTimeout(r,0));
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const binding=(id,projectId='a',version=1)=>({conversationId:id,projectId,version,taskRefs:[],pendingRequests:[]});
const status=id=>({project:{id},projects:[{id:'a',name:'A'},{id:'b',name:'B'}],session:{id:null,active:false},runtimeOwner:null,capabilities:{canPrepare:true}});

function fakeClock(){
 let time=10000,serial=0;const timers=new Map();
 return {now:()=>time,setTimer(fn,ms){const id=++serial;timers.set(id,{fn,at:time+ms});return id;},clearTimer(id){timers.delete(id);},
  async advance(ms){const end=time+ms;for(;;){const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();await Promise.resolve();await Promise.resolve();}time=end;await Promise.resolve();await Promise.resolve();}};
}

test('disconnected directory recovers automatically without clearing action failures or replaying writes',async()=>{
 let online=false,posts=0,reads=0;
 const contexts=createConversationContexts({storage:memory,interval:15,api:async(path,body)=>{
  if(body){posts++;throw Object.assign(new Error('write uncertain'),{httpStatus:503});}
  if(path==='status'){reads++;if(!online)throw Object.assign(new Error('socket closed'),{code:'upstream_unavailable',httpStatus:503});return status('a');}
  return binding('chat');
 }}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{
  await flush();assert.equal(c.snapshot().backendDisconnected,true);assert.match(c.snapshot().error,/工程服务未连接/);
  await c.bind('b');assert.equal(posts,1);const writeError=c.snapshot().actionError;assert.ok(writeError);
  online=true;for(let i=0;i<30&&c.snapshot().directoryError;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(reads>=2);assert.equal(c.snapshot().directoryError,'');assert.equal(c.snapshot().backendDisconnected,false);assert.equal(c.snapshot().projects[0].name,'A');
  assert.equal(c.snapshot().error,writeError,'successful reads must preserve unresolved action messages');assert.equal(posts,1,'no write is replayed');
  c.refresh({preserveActionError:true});await flush();assert.equal(c.snapshot().error,writeError,'service recovery refresh is not acknowledgement of a prior write');assert.equal(posts,1);
 }finally{off();contexts.dispose();}
});

test('successful binding polling clears only the recovered binding read failure',async()=>{
 let online=false;
 const contexts=createConversationContexts({storage:memory,interval:15,api:async path=>{
  if(path==='status')return status('a');
  if(!online)throw Object.assign(new Error('offline'),{code:'upstream_unavailable',httpStatus:503});
  return binding('chat');
 }}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();assert.equal(c.snapshot().binding,null);assert.equal(c.snapshot().backendDisconnected,true);online=true;
  for(let i=0;i<30&&!c.snapshot().binding;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(c.snapshot().binding.projectId,'a');assert.equal(c.snapshot().error,'');assert.equal(c.snapshot().backendDisconnected,false);
 }finally{off();contexts.dispose();}
});

test('an already open conversation detects a later backend disconnection and recovery',async()=>{
 let online=true;
 const contexts=createConversationContexts({storage:memory,interval:15,api:async path=>{
  if(path!=='status')return binding('chat');
  if(!online)throw Object.assign(new Error('offline'),{code:'upstream_unavailable'});
  return status('a');
 }}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();assert.equal(c.snapshot().projects[0].name,'A');online=false;
  for(let i=0;i<30&&!c.snapshot().backendDisconnected;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(c.snapshot().backendDisconnected,true);assert.equal(c.snapshot().binding.projectId,'a');
  online=true;for(let i=0;i<30&&c.snapshot().backendDisconnected;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(c.snapshot().backendDisconnected,false);assert.equal(c.snapshot().error,'');
 }finally{off();contexts.dispose();}
});

test('header binding is independent of status/tasks and subscribers share reads',async()=>{
 let calls=[],release;const contexts=createConversationContexts({storage:memory,api:async(path)=>{calls.push(path);if(path==='status')return new Promise(r=>release=r);return binding('chat');}}),c=contexts.get('chat');
 const off=c.subscribe(()=>{}),off2=c.subscribe(()=>{});await flush();
 assert.equal(c.snapshot().binding.projectId,'a');assert.equal(calls.filter(p=>p.startsWith('conversations')).length,1);assert.equal(calls.some(p=>p.startsWith('tasks')),false);
 release(status('a'));await flush();assert.equal(c.snapshot().projects.length,2);off();off2();contexts.dispose();
});

test('a failed binding refresh invalidates stale binding before another change',async()=>{
 let online=true,writes=0;const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){writes++;return binding('chat','b',2);}if(!online)throw Object.assign(new Error('offline'),{httpStatus:503});return binding('chat','a');}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();assert.equal(c.snapshot().binding.projectId,'a');online=false;c.refresh();await flush();assert.equal(c.snapshot().binding,null);await c.bind('b');assert.equal(writes,0);online=true;c.refresh();await flush();assert.equal(c.snapshot().binding.projectId,'a');
 }finally{off();contexts.dispose();}
});
test('CAS switch preserves confirmed identity, rejects overlapping writes and reads back conflict',async()=>{
 let resolveWrite,posts=0,current='a';const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){posts++;assert.equal(body.expectedVersion,1);return new Promise(r=>resolveWrite=r);}return binding('chat',current);}}),c=contexts.get('chat'),off=c.subscribe(()=>{});await flush();
 const write=c.bind('b');await flush();assert.equal(c.snapshot().busy,true);assert.equal(c.snapshot().binding.projectId,'a');await c.bind('a');assert.equal(posts,1);
 current='b';resolveWrite(binding('chat','b',2));await write;await flush();assert.equal(c.snapshot().binding.projectId,'b');off();contexts.dispose();
});
test('session remount ignores old read responses and keeps sessions independent',async()=>{
 let release,n=0;const contexts=createConversationContexts({storage:memory,api:async(path)=>{if(path==='status')return status('a');if(path.includes('chat-b'))return binding('chat-b','b');if(++n===1)return new Promise(r=>release=r);return binding('chat-a','b',2);}}),a=contexts.get('chat-a');
 const off=a.subscribe(()=>{});off();const off2=a.subscribe(()=>{}),b=contexts.get('chat-b'),offB=b.subscribe(()=>{});await flush();release(binding('chat-a','a'));await flush();assert.equal(a.snapshot().binding.projectId,'b');assert.equal(b.snapshot().binding.conversationId,'chat-b');assert.equal(contexts.activeSession(),null);off2();offB();contexts.dispose();
});
test('binding failures remain actionable after readback and do not retry writes',async()=>{
 for(const code of [403,409,503]){let posts=0;const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(body){posts++;throw Object.assign(new Error(),{httpStatus:code});}return path==='status'?status('a'):binding('chat');}}),c=contexts.get('chat'),off=c.subscribe(()=>{});await flush();await c.bind('b');await flush();assert.ok(c.snapshot().error);assert.equal(c.snapshot().binding.projectId,'a');assert.equal(posts,1);off();contexts.dispose();}
});
test('runtime mutation is durable across unmount, never replays and fixes clicked identity',async()=>{
 const disk=memory();let resolveWrite,requests=[];const contexts=createProjectContexts({storage:()=>disk,api:async(path,body)=>{requests.push({path,body});return body?new Promise(r=>resolveWrite=r):status('a');}}),c=contexts.get('a'),off=c.subscribe(()=>{});await flush();
 const write=c.action('start');await flush();off();assert.equal(c.snapshot().pending.projectId,'a');assert.equal(c.snapshot().pending.action,'start');resolveWrite({ok:true});await write;assert.equal(c.snapshot().pending,null);assert.equal(requests.filter(r=>r.body).length,1);contexts.dispose();
});
test('storage failure blocks runtime writes and failed reads hide old STOP',async()=>{
 let failure=false,posts=0;const contexts=createProjectContexts({storage:()=>{throw new Error('denied');},api:async(path,body)=>{if(body)posts++;if(failure)throw new Error('offline');return status('a');}}),c=contexts.get('a'),off=c.subscribe(()=>{});await flush();await c.action('start');assert.equal(posts,0);failure=true;await c.refresh();assert.equal(c.snapshot().snapshot,null);assert.match(c.snapshot().error,/无法确认/);off();contexts.dispose();
});

test('runtime tool choices follow configured resources and distinguish opening from execution',()=>{
 const fuxa={...status('a'),project:{id:'a',defaultMode:'fuxa-local',hmi:'hmi/main.fuxap',scene:'scene/project.json'},
  capabilities:{canShowHmi:true,tools:{oip:true},reasons:{oipRuntime:'通用 OIP 与 PLC 联动运行尚未接通。'}}};
 const choices=runtimeToolActions(fuxa);
 assert.deepEqual(choices.map(({id,action,tool,allowed})=>({id,action,tool,allowed})),[
  {id:'hmi',action:'open-hmi',tool:undefined,allowed:true},{id:'scene',action:'tool',tool:'oip',allowed:true}]);
 assert.match(choices[1].note,/尚未接通/);
 assert.equal(runtimeToolActions({...fuxa,hmiOpen:true})[0].action,'open-hmi','FUXA continues to use its current runtime page');
 const legacy={...status('a'),project:{id:'a',hmiExecutable:'hmi.exe'},capabilities:{canShowHmi:true,canReconnectHmi:false,reasons:{canReconnectHmi:'通道尚未核对'}}};
 assert.equal(runtimeToolActions(legacy)[0].action,'show-hmi');
 const reopened=runtimeToolActions({...legacy,hmiOpen:true})[0];
 assert.equal(reopened.action,'reopen-hmi');assert.equal(reopened.allowed,false);assert.equal(reopened.reason,'通道尚未核对');
 assert.deepEqual(runtimeToolActions({...status('a'),capabilities:{canShowHmi:true,tools:{oip:true}}}),[],'capabilities alone must not invent absent resources');
 assert.deepEqual(runtimeToolActions(null),[]);
 const declared={...status('a'),project:{id:'a',defaultMode:'fuxa-local',configuration:{hmiFile:'hmi/current.fuxap',sceneFile:'scene/current.json'}},
  capabilities:{canShowHmi:false,tools:{oip:false},reasons:{canShowHmi:'画面版本待核对',oip:'其他工程正在占用'}}};
 assert.equal(runtimeToolActions(declared)[0].reason,'画面版本待核对');
 assert.equal(runtimeToolActions(declared)[1].tool,'oip');assert.equal(runtimeToolActions(declared)[1].reason,'其他工程正在占用');
 const factory={...legacy,project:{...legacy.project,configuration:{sceneFile:'scene/current.factoryio'}},capabilities:{tools:{factory:false},reasons:{factory:'其他工程正在占用'}}};
 assert.equal(runtimeToolActions(factory)[1].tool,'factory');assert.equal(runtimeToolActions(factory)[1].reason,'其他工程正在占用');
});

test('shared runtime controller opens the exact HMI view with project and instance identity but never starts it',async()=>{
 for(const [project,hmiOpen,action,capability] of [
  [{id:'a',defaultMode:'fuxa-local',hmi:'hmi/main.fuxap'},false,'open-hmi','canShowHmi'],
  [{id:'a',hmiExecutable:'hmi.exe'},false,'show-hmi','canShowHmi'],
  [{id:'a',hmiExecutable:'hmi.exe'},true,'reopen-hmi','canReconnectHmi'],
 ]){
  const disk=memory(),posts=[];let response={...status('a'),project,hmiOpen,session:{id:'run-a',active:false},capabilities:{[capability]:true}};
  const contexts=createProjectContexts({storage:()=>disk,now:()=>10000,api:async(_path,body)=>{if(body){posts.push(body);return {ok:true};}return response;}}),c=contexts.get('a'),off=c.subscribe(()=>{});
  try{
   await flush();await c.action(action);await flush();assert.equal(posts.length,1);
   assert.equal(posts[0].action,action);assert.equal(posts[0].projectId,'a');assert.equal(posts[0].sessionId,'run-a');assert.equal(posts[0].tool,undefined);assert.equal(posts[0].expires,22);
   assert.equal(disk.getItem('plcdev.dsh.runtime.pending.a'),null);
   response={...response,capabilities:{[capability]:false}};await c.refresh();await c.action(action);assert.equal(posts.length,1,'updated capability blocks another opening');
  }finally{off();contexts.dispose();}
 }
});

test('runtime controller rejects action and tool capability substitution and the wrong HMI lane',async()=>{
 const posts=[],response={...status('a'),project:{id:'a',defaultMode:'fuxa-local',hmi:'hmi/main.fuxap'},capabilities:{canShowHmi:true,canReconnectHmi:true,canRun:false,tools:{oip:true}}};
 const contexts=createProjectContexts({storage:memory,api:async(_path,body)=>{if(body){posts.push(body);return {ok:true};}return response;}}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{
  await flush();for(const [action,tool] of [['runtime-start','oip'],['start','oip'],['unknown','oip'],['open-hmi','oip'],['tool'],['tool','fuxa'],['show-hmi'],['reopen-hmi']])await c.action(action,tool);
  assert.deepEqual(posts,[]);
  await c.action('tool','oip');await flush();assert.equal(posts.length,1);assert.equal(posts[0].action,'tool');assert.equal(posts[0].tool,'oip');
 }finally{off();contexts.dispose();}
});

test('an uncertain HMI opening is durable and never replays or authorizes subsequent runtime actions',async()=>{
 const disk=memory(),posts=[];const response={...status('a'),project:{id:'a',defaultMode:'fuxa-local',hmi:'hmi/main.fuxap'},capabilities:{canShowHmi:true,canPrepare:true,tools:{oip:true}}};
 const contexts=createProjectContexts({storage:()=>disk,api:async(_path,body)=>{if(body){posts.push(body);throw Object.assign(Error('outcome unknown'),{httpStatus:503});}return response;}}),c=contexts.get('a');let off=c.subscribe(()=>{});
 try{
  await flush();await c.action('open-hmi');await flush();assert.equal(c.snapshot().pending.action,'open-hmi');
  off();off=c.subscribe(()=>{});await flush();assert.equal(c.snapshot().pending.action,'open-hmi');
  await c.action('start');await c.action('tool','oip');await c.action('open-hmi');assert.equal(posts.length,1);assert.match(c.snapshot().notice,/不会自动重发/);
 }finally{off();contexts.dispose();}
});

test('runtime disconnection keeps only labelled historical ownership and a free status clears it',async()=>{
 let response={...status('a'),runtimeOwner:{sessionId:'run-old',projectId:'project-owner',owner:'本机入口',programHash:'c'.repeat(64)}},posts=0;
 const contexts=createProjectContexts({storage:memory,now:()=>12345,api:async(_path,body)=>{if(body){posts++;return {ok:true};}if(response instanceof Error)throw response;return response;}}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{await flush();assert.equal(c.snapshot().lastRuntimeOwner.sessionId,'run-old');assert.equal(c.snapshot().lastRuntimeOwner.observedAt,12345);
  response=Error('offline');await c.refresh();assert.equal(c.snapshot().snapshot,null);assert.equal(c.snapshot().lastRuntimeOwner.projectId,'project-owner');await c.action('start');assert.equal(posts,0);
  response={...status('a'),runtimeOwner:{state:'unknown',owner:'无法核验'}};await c.refresh();assert.equal(c.snapshot().lastRuntimeOwner.sessionId,'run-old');
  response=status('a');await c.refresh();assert.equal(c.snapshot().lastRuntimeOwner,null,'a confirmed free owner clears old display evidence');
  const other=contexts.get('b'),offOther=other.subscribe(()=>{});await flush();assert.equal(other.snapshot().lastRuntimeOwner,null,'ownership history is never moved across project contexts');offOther();
 }finally{off();contexts.dispose();}
});

test('active monitoring refreshes before expiry and drops a delayed stale snapshot without a write',async()=>{
 let clock=10000,serial=0,release,reads=0,writes=0;const timers=new Map();
 const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:clock+ms});return id;},clearTimer=id=>timers.delete(id);
 const advance=async ms=>{const end=clock+ms;for(;;){const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;clock=due[1].at;timers.delete(due[0]);due[1].fn();await Promise.resolve();await Promise.resolve();}clock=end;await Promise.resolve();await Promise.resolve();};
 const active=at=>({...status('a'),session:{id:'run-a',active:true},observerFresh:true,state:{observedAt:at,runtimeState:'RUNNING',telemetryFresh:true,dataQuality:'live',variables:[{path:'Count',value:3}]},capabilities:{canStop:true}});
 const contexts=createProjectContexts({storage:memory,now:()=>clock,setTimer,clearTimer,api:async(_path,body)=>{if(body){writes++;return {ok:true};}reads++;if(reads===1)return active(9.6);return new Promise(resolve=>{release=resolve;});}}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{
  await Promise.resolve();await Promise.resolve();const first=c.snapshot().snapshot;assert.ok(first);
  await advance(1000);assert.equal(reads,2);assert.equal(c.snapshot().snapshot,first,'fresh snapshot remains visible during normal refresh');
  await advance(599);assert.equal(c.snapshot().snapshot,first);
  await advance(1);assert.equal(c.snapshot().snapshot,null,'sample age, not request start time, determines expiry');assert.match(c.snapshot().error,/过期/);
  await c.action('runtime-stop');assert.equal(writes,0,'stale status cannot authorize an action');
  release(active(clock/1000));await Promise.resolve();await Promise.resolve();assert.equal(c.snapshot().snapshot.state.observedAt,clock/1000);
  off();assert.equal(c.snapshot().snapshot,null);await advance(5000);assert.equal(reads,2);
 }finally{contexts.dispose();}
});

test('idle background refresh keeps resource capabilities stable but expires a hung read at eight seconds',async()=>{
 const clock=fakeClock();let reads=0,writes=0,release;const seen=[];
 const contexts=createProjectContexts({...clock,storage:memory,api:async(_path,body)=>{
  if(body){writes++;return {ok:true};}reads++;if(reads===1)return status('a');return new Promise(resolve=>{release=resolve;});
 }}),c=contexts.get('a'),off=c.subscribe(()=>seen.push(c.snapshot().snapshot));
 try{
  await flush();const first=c.snapshot().snapshot;assert.ok(first);seen.length=0;
  await clock.advance(4000);assert.equal(reads,2);assert.equal(c.snapshot().snapshot,first);
  await clock.advance(3999);assert.equal(c.snapshot().snapshot,first);assert.equal(seen.includes(null),false,'ordinary polling must not publish a loading gap');
  await clock.advance(1);assert.equal(c.snapshot().snapshot,null);assert.match(c.snapshot().error,/过期/);
  await c.action('start');assert.equal(writes,0,'expired idle permissions cannot authorize a write');
  release(status('a'));await flush();assert.ok(c.snapshot().snapshot);assert.equal(c.snapshot().error,'');
 }finally{off();contexts.dispose();}
});

test('retrying an idle read does not extend the freshness of the last successful snapshot',async()=>{
 const clock=fakeClock();let reads=0;
 const contexts=createProjectContexts({...clock,storage:memory,api:async()=>++reads===1?status('a'):new Promise(()=>{})}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{
  await flush();const first=c.snapshot().snapshot;
  await clock.advance(7000);assert.equal(c.snapshot().snapshot,first);c.refresh();
  await clock.advance(999);assert.equal(c.snapshot().snapshot,first);
  await clock.advance(1);assert.equal(c.snapshot().snapshot,null,'the original success time still sets the deadline');
 }finally{off();contexts.dispose();}
});

test('explicit project invalidation drops prior permissions until the new state is confirmed',async()=>{
 let reads=0,writes=0,release;
 const contexts=createProjectContexts({storage:memory,api:async(_path,body)=>{
  if(body){writes++;return {ok:true};}return ++reads===1?status('a'):new Promise(resolve=>{release=resolve;});
 }}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{
  await flush();assert.ok(c.snapshot().snapshot);
  const pending=c.refresh({invalidate:true});assert.equal(c.snapshot().snapshot,null);
  await c.action('start');assert.equal(writes,0);
  release(status('a'));await pending;assert.ok(c.snapshot().snapshot);
 }finally{off();contexts.dispose();}
});

test('a completed mutation invalidates the previous idle status before readback permits another action',async()=>{
 let reads=0,writes=0,release;
 const contexts=createProjectContexts({storage:memory,api:async(_path,body)=>{
  if(body){writes++;return {ok:true};}return ++reads===1?status('a'):new Promise(resolve=>{release=resolve;});
 }}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{
  await flush();await c.action('start');assert.equal(writes,1);assert.equal(c.snapshot().snapshot,null);
  await c.action('start');assert.equal(writes,1,'old idle capability cannot send a second mutation');
  release({...status('a'),capabilities:{canPrepare:false}});await flush();assert.equal(c.snapshot().snapshot.capabilities.canPrepare,false);
 }finally{off();contexts.dispose();}
});

test('a late runtime status cannot replace a newer refresh',async()=>{
 let old,reads=0;const active=value=>({...status('a'),session:{id:'run-a',active:true},observerFresh:true,state:{observedAt:Date.now()/1000,runtimeState:'RUNNING',variables:[{path:'Count',value}]}});
 const contexts=createProjectContexts({storage:memory,api:async()=>{reads++;if(reads===1)return active(1);if(reads===2)return new Promise(resolve=>{old=resolve;});return active(3);}}),c=contexts.get('a'),off=c.subscribe(()=>{});
 try{await flush();const slow=c.refresh();await flush();await c.refresh();assert.equal(c.snapshot().snapshot.state.variables[0].value,3);old(active(2));await slow;assert.equal(c.snapshot().snapshot.state.variables[0].value,3);}finally{off();contexts.dispose();}
});

test('an already expired or undated sample is never exposed as a usable snapshot',async()=>{
 for(const observedAt of [8,undefined,11]){
  let scheduled,clock=10000,writes=0;const visible=[];
  const contexts=createProjectContexts({storage:memory,now:()=>clock,setTimer:(fn,ms)=>{scheduled={fn,ms};return 1;},clearTimer:()=>{},api:async(_path,body)=>body?(writes++,{ok:true}):({...status('a'),session:{id:'run-a',active:true},observerFresh:true,state:{observedAt,runtimeState:'RUNNING'},capabilities:{canStop:true}})});
  const c=contexts.get('a'),off=c.subscribe(()=>visible.push(c.snapshot().snapshot));
  try{await Promise.resolve();await Promise.resolve();assert.equal(c.snapshot().snapshot,null);assert.ok(visible.every(v=>v===null));assert.equal(scheduled.ms,1000);await c.action('runtime-stop');assert.equal(writes,0);}finally{off();contexts.dispose();}
 }
});

test('continue modification explicitly binds the parent project before arming and cancel never sends a model task',async()=>{
 let current=binding('chat','b',3),calls=[];const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(body){calls.push({path,body});if(path.endsWith('/bind'))current=binding('chat',body.projectId,4);else if(path.endsWith('/cancel'))delete current.revisionContext;else current.revisionContext={intentId:body.intentId,state:'armed'};return current;}return path==='status'?status('a'):current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});await flush();
 await c.revise({projectId:'a',taskId:'task-'+'a'.repeat(32),projectRevision:'b'.repeat(64),candidate:{candidateDigest:'c'.repeat(64)}});
 assert.deepEqual(calls.map(c=>c.path),['conversations/bind','conversations/revision']);assert.equal(calls[1].body.expectedVersion,4);assert.equal(c.snapshot().binding.revisionContext.state,'armed');
 await c.cancelRevision();assert.equal(calls.at(-1).path,'conversations/revision/cancel');assert.equal(calls.some(c=>c.path==='conversations/tasks'),false);off();contexts.dispose();
});

test('existing revision or unreconciled submission prevents cross-project revision from changing the binding',async()=>{
 let current={...binding('chat','b',3),revisionContext:{intentId:'existing',state:'armed'}},writes=[];
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){writes.push({path,body});return current;}return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 const parent={projectId:'a',taskId:'task-'+'a'.repeat(32),projectRevision:'b'.repeat(64),candidate:{candidateDigest:'c'.repeat(64)}};
 try{
  await flush();await c.revise(parent);assert.equal(writes.length,0);assert.equal(c.snapshot().binding.projectId,'b');assert.match(c.snapshot().error,/已有修订上下文/);
  current={...binding('chat','b',3),pendingRequests:[{projectId:'b',clientRequestId:'pending',state:'unknown'}]};c.refresh();await flush();await c.revise(parent);
  assert.equal(writes.length,0);assert.equal(c.snapshot().binding.projectId,'b');assert.match(c.snapshot().error,/先核对原请求/);
 }finally{off();contexts.dispose();}
});

test('persisted submission identity conflict prevents rebinding without inventing a task reference',async()=>{
 const accepted='task-'+'a'.repeat(32),observed='task-'+'b'.repeat(32),conflict={projectId:'a',clientRequestId:'req-1',acceptedTaskId:accepted,observedTaskIds:[observed]};
 let current={...binding('chat','a'),taskRefs:[{projectId:'a',taskId:accepted,clientRequestId:'req-1'}],submissionConflicts:[conflict]},writes=[];
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){writes.push({path,body});return current;}return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();await c.bind('b');assert.equal(writes.length,0);assert.match(c.snapshot().error,/不同任务身份/);assert.equal(c.snapshot().binding.projectId,'a');assert.equal(c.snapshot().binding.taskRefs.some(t=>t.taskId===observed),false);
  await c.revise({projectId:'b',taskId:accepted,projectRevision:'b'.repeat(64),candidate:{candidateDigest:'c'.repeat(64)}});assert.equal(writes.length,0);assert.match(c.snapshot().error,/不同任务身份/);
  await c.revise({projectId:'a',taskId:accepted,projectRevision:'b'.repeat(64),candidate:{candidateDigest:'c'.repeat(64)}});assert.equal(writes.length,0);assert.match(c.snapshot().error,/不能设置新修订/);
 }finally{off();contexts.dispose();}
});

test('recorded task with an active sender still prevents rebinding and can be checked read-only',async()=>{
 const taskId='task-'+'a'.repeat(32),flight={projectId:'a',clientRequestId:'request-1',state:'active_or_unknown'};
 const current={...binding('chat','a'),taskRefs:[{projectId:'a',taskId,clientRequestId:'request-1'}],revisionContext:{intentId:'revision-1',state:'armed'},submissionInFlight:[flight]},posts=[];
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){posts.push({path,body});if(path==='conversations/receipt')return {conversationId:'chat',projectId:'a',found:true,taskId};throw Error('unexpected write');}return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();await c.bind('b');assert.equal(posts.length,0);assert.match(c.snapshot().error,/仍在途/);await c.cancelRevision();assert.equal(posts.length,0);assert.match(c.snapshot().error,/不能取消修订/);await c.checkReceipt(flight);assert.equal(posts.length,1);assert.equal(posts[0].path,'conversations/receipt');assert.match(c.snapshot().notice,/已核对到原任务/);assert.equal(c.snapshot().binding.projectId,'a');
 }finally{off();contexts.dispose();}
});

test('an active or unconfirmed sender blocks client retry without discarding the original request',async()=>{
 const request={conversationId:'chat',projectId:'a',expectedVersion:1,expectedRevision:'d'.repeat(64),executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'original',request:'修改画面',workflow:'joint-ai-v1'};
 let current={...binding('chat','a'),pendingRequests:[{...request,state:'unknown'}],submissionInFlight:[{projectId:'a',clientRequestId:'original',state:'active_or_unknown'}]},posts=[];
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){posts.push({path,body});return {conversationId:'chat',task:{projectId:'a',taskId:'task-'+'a'.repeat(32)}};}return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();assert.equal(c.snapshot().pending.clientRequestId,'original');await c.retryPending();assert.equal(posts.length,0);assert.match(c.snapshot().error,/暂不重发/);assert.equal(c.snapshot().pending.clientRequestId,'original');
  current={...current,submissionInFlight:[{...current.submissionInFlight[0],state:'owner_exited'}]};c.refresh();await flush();await c.retryPending();assert.equal(posts.length,1);assert.equal(posts[0].body.clientRequestId,'original');
 }finally{off();contexts.dispose();}
});

test('conflict and in-flight failures give actionable binding explanations',()=>{
 assert.match(bindingError({httpStatus:409,code:'submission_identity_conflict'}),/不同任务身份/);
 assert.match(bindingError({httpStatus:409,code:'submission_in_flight'}),/仍在途/);
 assert.match(bindingError({httpStatus:503,code:'submission_inflight_overflow'}),/无法完整核对/);
 assert.match(bindingBlockedReason({binding:{pendingRequests:[],submissionInFlight:[{state:'evidence_conflict'}]}}),/回执证据不一致.*人工核对/);
});

test('pending revision delivery cannot be cancelled, while a definite rejection can be cleared',async()=>{
 let current={...binding('chat'),revisionContext:{intentId:'revision-1',state:'submitting'},pendingRequests:[{projectId:'a',clientRequestId:'request-1',state:'unknown'}]},posts=[];
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body){posts.push({path,body});delete current.revisionContext;return current;}return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{
  await flush();await c.cancelRevision();assert.equal(posts.length,0);assert.match(c.snapshot().error,/结果未知/);assert.equal(c.snapshot().binding.revisionContext.intentId,'revision-1');
  current={...current,pendingRequests:[]};c.refresh();await flush();await c.cancelRevision();
  assert.equal(posts.length,1);assert.equal(posts[0].path,'conversations/revision/cancel');assert.equal(posts[0].body.intentId,'revision-1');
 }finally{off();contexts.dispose();}
});

test('a legacy unresolved submission blocks cancelling an armed revision in the same session',async()=>{
 const current={...binding('chat'),revisionContext:{intentId:'revision-1',state:'armed'},pendingRequests:[{projectId:'a',clientRequestId:'legacy',state:'unknown'}]};let writes=0;
 const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(path==='status')return status('a');if(body)writes++;return current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();await c.cancelRevision();assert.equal(writes,0);assert.match(c.snapshot().error,/结果未知.*不能取消修订/);assert.equal(c.snapshot().binding.revisionContext.intentId,'revision-1');
 }finally{off();contexts.dispose();}
});

test('late directory responses and errors cannot overwrite a newer session directory',async()=>{
 let slowResolve,slowReject,n=0;const directory=id=>({...status(id),projects:[{id,name:id}]});
 const contexts=createConversationContexts({storage:memory,api:async(path)=>{if(path==='status'){n++;if(n===1)return new Promise(r=>slowResolve=r);if(n===3)return new Promise((_,r)=>slowReject=r);return directory('b');}return binding('chat','a');}}),c=contexts.get('chat'),off=c.subscribe(()=>{});
 try{await flush();c.refresh();await flush();assert.equal(c.snapshot().projects[0].id,'b');slowResolve(directory('a'));await flush();assert.equal(c.snapshot().projects[0].id,'b');c.refresh();await flush();c.refresh();await flush();slowReject(new Error('old request failed'));await flush();assert.equal(c.snapshot().projects[0].id,'b');assert.equal(c.snapshot().error,'');}finally{off();contexts.dispose();}
});
