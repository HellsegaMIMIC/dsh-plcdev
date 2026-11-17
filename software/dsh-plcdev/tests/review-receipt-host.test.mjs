// Real TaskService and workbench HTTP gateway, using a disposable copied
// project. The HMI plan is scripted locally; no model, editor or Runtime runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBridge} from '../src/bridge.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {fixturePython} from './helpers/fixture-python.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
// Python children must share this fixture's writable workspace boundary.
const staging=path.resolve(root,'outputs/dsh-receipt-test-staging');
const python=fixturePython(root);
const backend=path.join(root,'tools/test_dsh_review_receipt_backend.py');
const required=[python,backend,path.join(root,'software/project-interface-demo/project.plcdev')];
const missing=required.filter(p=>!existsSync(p));

test('session keep receipt traverses real workbench and TaskService without replay',{skip:missing.length?`Missing local integration prerequisites: ${missing.join(', ')}`:false,timeout:150000},async()=>{
 await mkdir(staging,{recursive:true});
 const dir=await mkdtemp(path.join(staging,'plcdev-review-receipt-'));
 const child=spawn(python,['-B','-X','utf8','-u',backend,dir],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 const ready=new Promise((resolve,reject)=>{
  const lines=createInterface({input:child.stdout});
  lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(e){reject(e);}});
  child.once('error',reject);child.once('exit',code=>reject(new Error(`isolated services exited ${code}: ${stderr}`)));
 });
 const ok=(result,status=200)=>{assert.equal(result.status,status,JSON.stringify(result.body));return result.body;};
 try{
  const data=await ready;assert.equal(data.ok,true);
  const source=await readFile(data.hmiPath),controllerFile=path.join(dir,'workbench/controller.json');
  const bridge=createBridge({projectRoot:root,controllerFile,timeoutMs:10000});
  const conversations=createConversationRoutes({controllerFile,bridge});
  const session='receipt-owner',route='/api/plcdev/conversations';
  ok(await conversations.handle('POST',route+'/bind',{conversationId:session,projectId:data.projectId,expectedVersion:0}));
  const text='离线回执核查';
  const submitted=ok(await conversations.handle('POST',route+'/tasks',{
   conversationId:session,projectId:data.projectId,expectedVersion:1,request:`把画面 ID“${data.viewId}”的文字 ID“${data.elementId}”改为“${text}”`,
   expectedRevision:data.revision,executionScope:'proposal',clientRequestId:'receipt-candidate',sourceBasis:'saved_revision',workflow:'hmi-static-text-v1',
   planSubmission:{schemaVersion:1,plan:{viewId:data.viewId,elementId:data.elementId,text},route:{provider:'offline',model:'fixture'}}
  }));
  const taskId=submitted.task.taskId;
  async function settled(terminal){
   const until=Date.now()+60000;
   while(Date.now()<until){const r=await bridge.handle('GET','/api/plcdev/tasks?project='+data.projectId);const task=r.body.tasks?.find(t=>t.taskId===taskId);if(task&&terminal.includes(task.status))return task;if(task&&['conflict','failed','unknown_outcome'].includes(task.status))throw new Error(JSON.stringify(task));await new Promise(resolve=>setTimeout(resolve,100));}
   throw new Error('isolated task did not settle');
  }
  const task=await settled(['awaiting_review']);
  const original={conversationId:session,projectId:data.projectId,taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:data.revision,action:'keep',clientRequestId:'receipt-keep'};
  ok(await conversations.handle('POST',route+'/review',original));
  await settled(['kept']);
  const receiptFile=path.join(dir,'agent/joint-changes/effects/receipt-keep.json');
  const originalReceipt=await readFile(receiptFile);
  const verified=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(verified.state,'confirmed_registered');assert.equal(verified.keptProjectId,data.projectId);
  assert.equal(verified.completionScope,'saved-project-version');assert.equal(verified.version,2);
  assert.equal(path.resolve(verified.manifestPath),path.resolve(data.manifestPath));assert.notEqual(verified.revision,data.revision);
  assert.ok(path.resolve(verified.manifestPath).startsWith(path.resolve(dir)+path.sep));
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,conversationId:'other-session'})).status,403);
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,clientRequestId:'wrong-effect'})).status,503);
  const unchanged=ok(await conversations.handle('POST',route+'/review-receipt',original));assert.deepEqual(unchanged,verified);
  const copy=JSON.parse(await readFile(verified.manifestPath,'utf8'));
  const copyHmi=path.resolve(path.dirname(verified.manifestPath),copy.hmi.project);
  assert.ok(copyHmi.startsWith(path.resolve(dir)+path.sep));
  await appendFile(copyHmi,' ');
  const changed=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(changed.state,'unknown');assert.equal(changed.reasonCode,'copy_changed');
  assert.equal(changed.keptProjectId,null);assert.equal(changed.manifestPath,null);assert.equal(changed.revision,null);
  assert.deepEqual(await readFile(receiptFile),originalReceipt,'read-only checks must not alter the original keep receipt');
  assert.deepEqual(await readFile(data.hmiPath),source,'source HMI must not change');
 } finally {
  child.stdin.end();
  if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
  const target=path.resolve(dir);assert.ok(path.basename(target).startsWith('plcdev-review-receipt-')&&path.dirname(target)===staging);
  await rm(target,{recursive:true,force:true});
 }
});
