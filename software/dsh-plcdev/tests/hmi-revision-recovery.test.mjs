// Real conversation SQLite/outbox and client recovery; the upstream task service
// is an idempotent in-memory fixture, not a model, Runtime or desktop host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createConversationRoutes} from '../src/conversations.mjs';
import {createConversationContexts} from '../src/client/conversation-context.mjs';

for(const workflow of ['hmi-view-name-v1','hmi-static-text-v1'])test(`${workflow} unknown parent revision recovers original outbox across reopen without a second child`,async t=>{
 const tmp=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(tmp,'plcdev-hmi-outbox-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(tmp+path.sep)&&path.basename(root).startsWith('plcdev-hmi-outbox-'));await rm(root,{recursive:true,force:true});});
 const projectId='user-'+'a'.repeat(32),revision='e'.repeat(64),digest='d'.repeat(64),session='conversation-a';
 const parentId='task-'+'b'.repeat(32),childId='task-'+'c'.repeat(32),staticText=workflow==='hmi-static-text-v1';
 const target=staticText?{viewId:'v-a',elementId:'PLCD_tTitle'}:{viewId:'v-a'};
 const parent={projectId,taskId:parentId,projectRevision:revision,workflow,status:'awaiting_review',request:'父候选',candidate:{candidateDigest:digest,revisionSupported:true,target,summary:{before:'源',after:'第一版'}}};
 const child={projectId,taskId:childId,projectRevision:revision,workflow,status:'awaiting_review'};
 const map=new Map(),calls=[],file=path.join(root,'controller.json');let childCreated=0;
 const bridge={async handle(method,url,body){
  if(method==='GET'&&url.startsWith('/api/plcdev/status'))return {status:200,body:{project:{id:projectId},projects:[{id:projectId}]}};
  if(method==='GET'&&url.startsWith('/api/plcdev/tasks'))return {status:200,body:{projectId,projectRevision:revision,tasks:[parent,...(childCreated?[child]:[])]}};
  assert.equal(method,'POST');assert.equal(url,'/api/plcdev/tasks');calls.push(structuredClone(body));
  const old=map.get(body.clientRequestId),fingerprint=JSON.stringify(body);
  if(old){assert.equal(fingerprint,old.fingerprint);return {status:200,body:{ok:true,task:old.task,duplicate:true}};}
  const task=map.size===0?parent:child;map.set(body.clientRequestId,{fingerprint,task});
  if(task===child){childCreated++;throw Error('fixture response lost after durable child registration');}
  return {status:202,body:{ok:true,task}};
 }};
 const open=()=>createConversationRoutes({controllerFile:file,bridge});let routes=open();
 assert.equal((await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:session,projectId,expectedVersion:0})).status,200);
 const base={conversationId:session,projectId,expectedVersion:1,expectedRevision:revision,executionScope:'proposal',sourceBasis:'saved_revision',workflow};
 const plan=(value)=>staticText?{...target,text:value}:{...target,name:value};
 const text=(from,to)=>staticText?`把静态文字“${from}”改为“${to}”`:`把画面名称“${from}”改为“${to}”`;
 const submission=(from,to,clientRequestId)=>({...base,request:text(from,to),clientRequestId,planSubmission:{schemaVersion:1,plan:plan(to),route:{provider:'offline',model:'fixture'}}});
 assert.equal((await routes.handle('POST','/api/plcdev/conversations/tasks',submission('源','第一版','original'))).status,202);
 const arm={conversationId:session,projectId,taskId:parentId,candidateDigest:digest,expectedRevision:revision,expectedVersion:1,intentId:'intent-original'};
 assert.equal((await routes.handle('POST','/api/plcdev/conversations/revision',arm)).status,200);
 assert.equal(routes.claimRevision(session,'turn-one').parent.taskId,parentId);
 const original={...submission('第一版','第二版','revision-original'),revisionParent:{taskId:parentId,candidateDigest:digest},revisionIntentId:'intent-original'};
 assert.equal((await routes.handle('POST','/api/plcdev/conversations/tasks',original)).status,503);assert.equal(childCreated,1);
 routes=open();const disk=new Map(),storage={getItem:k=>disk.get(k)||null,setItem:(k,v)=>disk.set(k,v),removeItem:k=>disk.delete(k)};
 const api=async(route,body)=>{
  if(route==='status')return {project:{id:projectId},projects:[{id:projectId}]};
  const result=await routes.handle(body?'POST':'GET','/api/plcdev/'+route,body);
  if(result.status>=400)throw Error(result.body?.error||'fixture API failure');return result.body;
 };
 const contexts=createConversationContexts({api,storage:()=>storage,interval:60000}),controller=contexts.get(session),unsub=controller.subscribe(()=>{});
 const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),'pending outbox request was not restored');};
 try{
  await until(()=>controller.snapshot().pending!==null);
  assert.deepEqual(controller.snapshot().pending,original);
  assert.equal(routes.snapshot(session).revisionContext.state,'submitting');
  await controller.retryPending();assert.equal(childCreated,1);assert.equal(calls.length,3);
  assert.deepEqual(calls[2],calls[1]);assert.equal(routes.snapshot(session).revisionContext.state,'submitted');
  assert.equal(controller.snapshot().pending,null);assert.equal(routes.snapshot(session).projectId,projectId);
  assert.ok(routes.snapshot(session).taskRefs.some(ref=>ref.taskId===childId));
 }finally{unsub();contexts.dispose();}
});
