import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationContexts} from '../src/client/conversation-context.mjs';
import {createProjectContexts} from '../src/client/project-context.mjs';
const flush=()=>new Promise(r=>setTimeout(r,0));
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const binding=(id,projectId='a',version=1)=>({conversationId:id,projectId,version,taskRefs:[],pendingRequests:[]});
const status=id=>({project:{id},projects:[{id:'a',name:'A'},{id:'b',name:'B'}],session:{id:null,active:false},runtimeOwner:null,capabilities:{canPrepare:true}});

test('header binding is independent of status/tasks and subscribers share reads',async()=>{
 let calls=[],release;const contexts=createConversationContexts({storage:memory,api:async(path)=>{calls.push(path);if(path==='status')return new Promise(r=>release=r);return binding('chat');}}),c=contexts.get('chat');
 const off=c.subscribe(()=>{}),off2=c.subscribe(()=>{});await flush();
 assert.equal(c.snapshot().binding.projectId,'a');assert.equal(calls.filter(p=>p.startsWith('conversations')).length,1);assert.equal(calls.some(p=>p.startsWith('tasks')),false);
 release(status('a'));await flush();assert.equal(c.snapshot().projects.length,2);off();off2();contexts.dispose();
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

test('continue modification explicitly binds the parent project before arming and cancel never sends a model task',async()=>{
 let current=binding('chat','b',3),calls=[];const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{if(body){calls.push({path,body});if(path.endsWith('/bind'))current=binding('chat',body.projectId,4);else if(path.endsWith('/cancel'))delete current.revisionContext;else current.revisionContext={intentId:body.intentId,state:'armed'};return current;}return path==='status'?status('a'):current;}}),c=contexts.get('chat'),off=c.subscribe(()=>{});await flush();
 await c.revise({projectId:'a',taskId:'task-'+'a'.repeat(32),projectRevision:'b'.repeat(64),candidate:{candidateDigest:'c'.repeat(64)}});
 assert.deepEqual(calls.map(c=>c.path),['conversations/bind','conversations/revision']);assert.equal(calls[1].body.expectedVersion,4);assert.equal(c.snapshot().binding.revisionContext.state,'armed');
 await c.cancelRevision();assert.equal(calls.at(-1).path,'conversations/revision/cancel');assert.equal(calls.some(c=>c.path==='conversations/tasks'),false);off();contexts.dispose();
});
