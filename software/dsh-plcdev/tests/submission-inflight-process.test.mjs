import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createConversationRoutes} from '../src/conversations.mjs';

const A='user-'+'a'.repeat(32),B='user-'+'b'.repeat(32),taskId='task-'+'c'.repeat(32),revision='e'.repeat(64),cid='chat-a';
const submit={conversationId:cid,projectId:A,expectedVersion:1,request:'isolated request',expectedRevision:revision,executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'fixed-request'};

async function fixture(t){
 const tmp=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(tmp,'plcdev-inflight-')),controllerFile=path.join(root,'controller.json');
 let found=true,posts=0,postUnknown=false;
 const bridge={async handle(method,url,body){
  if(method==='POST'){posts++;return postUnknown?{status:503,body:{code:'unknown'}}:{status:202,body:{ok:true,task:{projectId:A,taskId}}};}
  const project=new URL(url,'http://127.0.0.1').searchParams.get('project')||A;
  return url.startsWith('/api/plcdev/tasks?')?{status:200,body:{projectId:A,projectRevision:revision,tasks:[{projectId:A,taskId}]}}:{status:200,body:{project:{id:project},projects:[{id:A},{id:B}]}};
 },async taskReceipt(projectId,clientRequestId){return {ok:true,projectId,clientRequestId,task:found?{projectId:A,taskId}:null};}};
 const routes=createConversationRoutes({controllerFile,bridge});
 assert.equal((await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:cid,projectId:A,expectedVersion:0})).status,200);
 let child;
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(root).startsWith(tmp+path.sep)&&path.basename(root).startsWith('plcdev-inflight-'));await rm(root,{recursive:true,force:true});
 });
 async function start(kind='submit'){
  child=fork(fileURLToPath(new URL('./fixtures/submission-owner.mjs',import.meta.url)),[controllerFile,A],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  const message=once(child,'message');child.send(kind);assert.equal((await message)[0].kind,kind==='submit'?'upstream-received':'receipt-started');
 }
 async function end(){const exited=once(child,'exit');child.kill();await exited;}
 return {root,routes,start,end,bridge,setFound:v=>{found=v;},setPostUnknown:v=>{postUnknown=v;},posts:()=>posts};
}
const request=(routes,method,path,body)=>routes.handle(method,'/api/plcdev/conversations'+path,body);
const bindB=routes=>request(routes,'POST','/bind',{conversationId:cid,projectId:B,expectedVersion:1});
const receipt=routes=>request(routes,'POST','/receipt',{conversationId:cid,clientRequestId:'fixed-request'});

test('accepted receipt cannot unlock a live sender; an actual exited sender can be reconciled', {timeout:15000},async t=>{
 const f=await fixture(t);await f.start();
 assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'active_or_unknown');
 assert.equal((await request(f.routes,'POST','/tasks',submit)).body.code,'submission_in_flight');assert.equal(f.posts(),0);
 assert.equal((await receipt(f.routes)).body.found,true);
 let state=f.routes.snapshot(cid);assert.equal(state.taskRefs[0].taskId,taskId);assert.equal(state.submissionInFlight[0].state,'active_or_unknown');
 assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 await f.end();assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'owner_exited');
 assert.equal((await receipt(f.routes)).body.found,true);state=f.routes.snapshot(cid);assert.deepEqual(state.submissionInFlight,[]);
 assert.equal((await bindB(f.routes)).status,200);
});

test('an exited sender with no receipt can retry only its original request identity', {timeout:15000},async t=>{
 const f=await fixture(t);await f.start();await f.end();f.setFound(false);
 assert.equal((await receipt(f.routes)).body.found,false);
 const state=f.routes.snapshot(cid);assert.deepEqual(state.submissionInFlight,[]);assert.equal(state.pendingRequests[0].clientRequestId,'fixed-request');
 assert.equal((await bindB(f.routes)).body.code,'submission_unknown');
 assert.equal((await request(f.routes,'POST','/tasks',submit)).status,202);assert.equal(f.posts(),1);
});

test('an actual exited receipt reader is replaced only by an explicit new read', {timeout:15000},async t=>{
 const f=await fixture(t);f.setPostUnknown(true);
 assert.equal((await request(f.routes,'POST','/tasks',submit)).status,503);await f.start('receipt');
 assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'active_or_unknown');
 assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 assert.equal((await request(f.routes,'POST','/tasks',submit)).body.code,'submission_in_flight');
 await f.end();assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'owner_exited');
 assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 assert.equal((await receipt(f.routes)).body.found,true);assert.deepEqual(f.routes.snapshot(cid).submissionInFlight,[]);
 assert.equal((await bindB(f.routes)).status,200);
});

test('EPERM, reused PID and unknown legacy sender never authorize rebinding',async t=>{
 const f=await fixture(t);assert.equal((await request(f.routes,'POST','/tasks',submit)).status,202);
 const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
 try{
  const artificialPid=2147483000;db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(cid,'fixed-request','fixture-attempt',artificialPid);
  const originalKill=process.kill;
  try{
   for(const result of ['EPERM','EACCES','alive']){
    process.kill=(pid,signal)=>{assert.equal(pid,artificialPid);assert.equal(signal,0);if(result==='alive')return true;throw Object.assign(new Error('fixture'),{code:result});};
    assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'active_or_unknown');
    assert.equal((await receipt(f.routes)).body.found,true);assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
   }
  }finally{process.kill=originalKill;}
  db.prepare('DELETE FROM submission_inflight').run();
  db.prepare("UPDATE submissions SET state='pending',task_id=NULL,payload=? WHERE conversation_id=? AND request_id=?").run(JSON.stringify(submit),cid,'fixed-request');
  assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'legacy_unknown');
  assert.equal((await request(f.routes,'POST','/tasks',submit)).body.code,'submission_in_flight');
  assert.equal((await receipt(f.routes)).body.found,true);
  const snapshot=f.routes.snapshot(cid);assert.equal(snapshot.taskRefs[0].taskId,taskId);assert.equal(snapshot.submissionInFlight[0].state,'legacy_unknown');
  assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 }finally{db.close();}
});

test('receipt reader EPERM fails closed; only explicit ESRCH permits a fresh read',async t=>{
 const f=await fixture(t);assert.equal((await request(f.routes,'POST','/tasks',submit)).status,202);
 const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite')),artificialPid=2147483000,originalKill=process.kill;
 try{
  db.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)').run(cid,'fixed-request','fixture-reader',artificialPid);
  process.kill=(pid,signal)=>{assert.equal(pid,artificialPid);assert.equal(signal,0);throw Object.assign(new Error('fixture'),{code:'EPERM'});};
  assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'active_or_unknown');
  assert.equal((await receipt(f.routes)).body.code,'submission_in_flight');assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
  process.kill=(pid,signal)=>{assert.equal(pid,artificialPid);assert.equal(signal,0);throw Object.assign(new Error('fixture'),{code:'ESRCH'});};
  assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'owner_exited');
  assert.equal((await receipt(f.routes)).body.found,true);assert.deepEqual(f.routes.snapshot(cid).submissionInFlight,[]);
  assert.equal((await bindB(f.routes)).status,200);
 }finally{process.kill=originalKill;db.close();}
});

test('mixed sender and receipt lifetimes keep the more conservative in-flight status',async t=>{
 const f=await fixture(t);assert.equal((await request(f.routes,'POST','/tasks',submit)).status,202);
 const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite')),dead=2147483000,reader=2147483001,originalKill=process.kill;
 try{
  db.prepare('INSERT INTO submission_inflight VALUES(?,?,?,?)').run(cid,'fixed-request','dead-sender',dead);
  db.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)').run(cid,'fixed-request','active-reader',reader);
  let readerAlive=true;
  process.kill=(pid,signal)=>{assert.equal(signal,0);if(pid===reader&&readerAlive)return true;assert.ok(pid===dead||pid===reader);throw Object.assign(new Error('fixture'),{code:'ESRCH'});};
  assert.deepEqual(f.routes.snapshot(cid).submissionInFlight,[{projectId:A,clientRequestId:'fixed-request',state:'active_or_unknown'}]);
  assert.equal((await receipt(f.routes)).body.code,'submission_in_flight');assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
  readerAlive=false;assert.equal(f.routes.snapshot(cid).submissionInFlight[0].state,'owner_exited');
  assert.equal((await receipt(f.routes)).body.found,true);assert.deepEqual(f.routes.snapshot(cid).submissionInFlight,[]);
  assert.equal((await bindB(f.routes)).status,200);
 }finally{process.kill=originalKill;db.close();}
});

test('an accepted task whose later original receipt disappears keeps durable evidence conflict',async t=>{
 const f=await fixture(t);assert.equal((await request(f.routes,'POST','/tasks',submit)).status,202);
 const db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite')),artificialPid=2147483000,originalKill=process.kill;
 try{
  db.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)').run(cid,'fixed-request','dead-reader',artificialPid);
  process.kill=(pid,signal)=>{assert.equal(pid,artificialPid);assert.equal(signal,0);throw Object.assign(new Error('fixture'),{code:'ESRCH'});};
  f.setFound(false);assert.equal((await receipt(f.routes)).body.code,'submission_receipt_conflict');
  let snapshot=f.routes.snapshot(cid);assert.equal(snapshot.taskRefs[0].taskId,taskId);assert.equal(snapshot.submissionInFlight[0].state,'evidence_conflict');
  assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
  assert.equal((await request(f.routes,'POST','/tasks',submit)).body.code,'submission_receipt_conflict');
  f.setFound(true);assert.equal((await receipt(f.routes)).body.found,true);
  snapshot=f.routes.snapshot(cid);assert.equal(snapshot.submissionInFlight[0].state,'evidence_conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submission_receipt_evidence_conflicts').get().n,1);
  assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 }finally{process.kill=originalKill;db.close();}
});

test('more than 32 in-flight requests fails closed without truncating coordination records',async t=>{
 const f=await fixture(t),db=new DatabaseSync(path.join(f.root,'dsh-context.sqlite'));
 try{
  const submitRow=db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)'),marker=db.prepare('INSERT INTO submission_receipt_inflight VALUES(?,?,?,?)');
  for(let n=1;n<=33;n++){
   const requestId='inflight-'+n,id='task-'+n.toString(16).padStart(32,'0');
   submitRow.run(cid,requestId,'f'.repeat(64),A,1,'upstream-'+n,null,'accepted',id,'fixture');
   marker.run(cid,requestId,'legacy-reader',0);
  }
  const snapshot=await request(f.routes,'GET','?conversationId='+cid);
  assert.equal(snapshot.status,503);assert.equal(snapshot.body.code,'submission_inflight_overflow');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submission_receipt_inflight').get().n,33);
  assert.equal((await bindB(f.routes)).body.code,'submission_in_flight');
 }finally{db.close();}
});
