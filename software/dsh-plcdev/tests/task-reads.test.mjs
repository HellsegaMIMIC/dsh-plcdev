import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskReads} from '../src/client/task-reads.mjs';

const projectId='user-'+'a'.repeat(32),otherProject='user-'+'b'.repeat(32),taskId='task-'+'c'.repeat(32),revision='d'.repeat(64);
const task={projectId,taskId,status:'awaiting_review',candidate:{candidateDigest:revision,editingInput:{large:'native source'},planningInput:{large:'context'}}};
const binding=session=>({conversationId:session,projectId,version:1,taskRefs:[{projectId,taskId}],pendingRequests:[]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('twenty simultaneous cards share task and ownership reads; completed results never authorize the next read',async t=>{
 const gate=deferred(),requests=[];
 const reads=createTaskReads({api:async path=>{requests.push(path);await gate.promise;return path.startsWith('conversations')?binding('chat-a'):{projectId,projectRevision:revision,tasks:[task]};}});
 const cards=Array.from({length:20},()=>Promise.all([reads.readTasks(projectId),reads.readBinding('chat-a')]));
 await tick();assert.equal(requests.length,2);gate.resolve();await Promise.all(cards);
 assert.equal(reads.peekRecords(projectId).tasks.length,1);assert.equal(reads.peekRecords(projectId).tasks[0].candidate.editingInput,undefined);
 assert.equal(reads.peekRecords(projectId).tasks[0].candidate.planningInput,undefined);
 await Promise.all([reads.readTasks(projectId),reads.readBinding('chat-a')]);assert.equal(requests.length,4);
 t.diagnostic('20 mounted cards: 2 simultaneous requests instead of 40; next completed-read cycle still sends 2 fresh requests.');
 reads.dispose();
});

test('record and binding reads isolate projects and sessions and reject mismatched project responses',async()=>{
 const requests=[];
 const reads=createTaskReads({api:async path=>{requests.push(path);if(path.startsWith('conversations'))return binding(new URLSearchParams(path.split('?')[1]).get('conversationId'));return {projectId,tasks:[task]};}});
 await Promise.all([reads.readRecords(projectId),reads.readBinding('chat-a'),reads.readBinding('chat-b')]);
 assert.equal(requests.length,3);assert.equal(reads.peekRecords(otherProject),null);
 await assert.rejects(reads.readRecords(otherProject),/工程身份无法确认/);assert.equal(reads.peekRecords(otherProject),null);
 reads.dispose();
});

test('failed refresh preserves display evidence, retries normally, and a light record cannot satisfy a full read',async()=>{
 let fail=false;const requests=[];
 const reads=createTaskReads({api:async path=>{requests.push(path);if(fail)throw new Error('offline');return path.startsWith('task-records')?{projectId,tasks:[task]}:{projectId,projectRevision:revision,tasks:[task]};}});
 await reads.readRecords(projectId);fail=true;await assert.rejects(reads.readRecords(projectId),/offline/);
 assert.equal(reads.peekRecords(projectId).tasks[0].taskId,taskId);
 await assert.rejects(reads.readTasks(projectId),/offline/);fail=false;await reads.readTasks(projectId);
 assert.deepEqual(requests.map(p=>p.split('?')[0]),['task-records','task-records','task-state','task-state']);reads.dispose();
});

test('mutation invalidation prevents old in-flight results from replacing newer confirmed display state',async()=>{
 const slow=deferred();let count=0;
 const reads=createTaskReads({api:async()=>{if(++count===1)return slow.promise;return {projectId,tasks:[{...task,status:'kept'}]};}});
 const old=reads.readRecords(projectId);await tick();reads.invalidate(projectId,'chat-a');
 await reads.readRecords(projectId);slow.resolve({projectId,tasks:[task]});await old;
 assert.equal(count,2);assert.equal(reads.peekRecords(projectId).tasks[0].status,'kept');reads.dispose();
});

test('a slow history response cannot regress display state already confirmed by a newer full read',async()=>{
 const slow=deferred();
 const reads=createTaskReads({api:async path=>path.startsWith('task-records')?slow.promise:{projectId,projectRevision:revision,tasks:[{...task,status:'kept'}]}});
 const old=reads.readRecords(projectId);await tick();await reads.readTasks(projectId);
 slow.resolve({projectId,tasks:[task]});await old;
 assert.equal(reads.peekRecords(projectId).tasks[0].status,'kept');reads.dispose();
});

test('display cache is bounded and pending responses cannot restore a disposed cache',async()=>{
 const slow=deferred();let delayed=false;
 const reads=createTaskReads({maxProjects:1,api:async path=>{if(delayed)return slow.promise;const id=new URLSearchParams(path.split('?')[1]).get('project');return {projectId:id,tasks:[{...task,projectId:id}]};}});
 await reads.readRecords(projectId);await reads.readRecords(otherProject);
 assert.equal(reads.peekRecords(projectId),null);assert.equal(reads.peekRecords(otherProject).tasks.length,1);
 delayed=true;const pending=reads.readRecords(projectId);await tick();reads.dispose();slow.resolve({projectId,tasks:[task]});await pending;
 assert.equal(reads.peekRecords(projectId),null);await assert.rejects(reads.readRecords(projectId),/已关闭/);
});
test('OIP status display reads reuse a bounded cache and invalidate immediately after an open or keep',async()=>{
 let count=0;const value={project:{id:projectId},projects:[{id:projectId}],oipSync:{state:'synced',revision}};
 const reads=createTaskReads({api:async()=>{count++;return value;}});
 await Promise.all(Array.from({length:20},()=>reads.readSnapshot(projectId)));await reads.readSnapshot(projectId);assert.equal(count,1);
 reads.invalidate(projectId);await reads.readSnapshot(projectId);assert.equal(count,2);
 await assert.rejects(reads.readSnapshot(otherProject),/工程/);reads.dispose();await assert.rejects(reads.readSnapshot(projectId),/已关闭/);
});
