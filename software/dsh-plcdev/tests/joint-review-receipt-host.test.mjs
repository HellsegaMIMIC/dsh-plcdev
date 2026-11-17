// Real isolated TaskService + workbench and DSH conversation/bridge routes.
// The complete joint plan is a local fixture; no model, editor or Runtime runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,appendFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBridge} from '../src/bridge.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {fixturePython} from './helpers/fixture-python.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
// Python children must share this fixture's writable workspace boundary.
const staging=path.resolve(root,'outputs/dsh-receipt-test-staging');
const python=fixturePython(root);
const backend=path.join(root,'tools/test_dsh_joint_review_receipt_backend.py');
const required=[python,backend,path.join(root,'software/fuxa-oip/plc/project/project.json')];
const missing=required.filter(p=>!existsSync(p));

test('joint keep receipt traverses the actual isolated services and remains read-only',{
 skip:missing.length?`Missing local integration prerequisites: ${missing.join(', ')}`:false,timeout:180000
},async()=>{
 await mkdir(staging,{recursive:true});
 const dir=await mkdtemp(path.join(staging,'plcdev-joint-review-receipt-'));
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
  const projectRoot=path.resolve(data.projectRoot);assert.ok(projectRoot.startsWith(path.resolve(dir)+path.sep));
  const sourceFiles=Object.entries(data.files);assert.ok(sourceFiles.length>3);
  const controllerFile=path.join(dir,'workbench/controller.json'),bridge=createBridge({projectRoot:root,controllerFile,timeoutMs:10000});
  const conversations=createConversationRoutes({controllerFile,bridge}),session='joint-receipt-owner',route='/api/plcdev/conversations';
  ok(await conversations.handle('POST',route+'/bind',{conversationId:session,projectId:data.projectId,expectedVersion:0}));
  const submitted=ok(await conversations.handle('POST',route+'/tasks',{
   conversationId:session,projectId:data.projectId,expectedVersion:1,request:'生成批次计数联合候选，保留原控制逻辑',
   expectedRevision:data.revision,executionScope:'proposal',clientRequestId:'joint-receipt-candidate',sourceBasis:'saved_revision',workflow:'joint-ai-v1',
   planSubmission:{schemaVersion:1,plan:data.plan,route:{provider:'offline',model:'fixture'}}
  }));
  const taskId=submitted.task.taskId;
  async function settled(terminal){
   const until=Date.now()+90000;
   while(Date.now()<until){const r=await bridge.handle('GET','/api/plcdev/tasks?project='+data.projectId);const task=r.body.tasks?.find(t=>t.taskId===taskId);if(task&&terminal.includes(task.status))return task;if(task&&['conflict','failed','unknown_outcome'].includes(task.status))throw new Error(JSON.stringify(task));await new Promise(resolve=>setTimeout(resolve,100));}
   throw new Error('isolated joint task did not settle');
  }
  const task=await settled(['awaiting_review']);assert.equal(task.workflow,'joint-ai-v1');assert.equal(task.candidate.modelEvidence.modelCalled,false);
  const original={conversationId:session,projectId:data.projectId,taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:data.revision,action:'keep',clientRequestId:'joint-receipt-keep'};
  ok(await conversations.handle('POST',route+'/review',original));await settled(['kept']);
  const receiptFile=path.join(dir,'agent/joint-changes/effects/joint-receipt-keep.json'),originalReceipt=await readFile(receiptFile);
  const verified=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(verified.state,'confirmed_registered');assert.equal(verified.keptProjectId,data.projectId);
  assert.equal(verified.completionScope,'saved-project-version');assert.equal(verified.version,2);
  assert.equal(path.resolve(verified.manifestPath),path.resolve(data.manifestPath));assert.notEqual(verified.revision,data.revision);
  assert.ok(path.resolve(verified.manifestPath).startsWith(path.resolve(dir)+path.sep));
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,conversationId:'other-session'})).status,403);
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,clientRequestId:'wrong-effect'})).status,503);
  assert.deepEqual(ok(await conversations.handle('POST',route+'/review-receipt',original)),verified);
  const copy=JSON.parse(await readFile(verified.manifestPath,'utf8')),copyHmi=path.resolve(path.dirname(verified.manifestPath),copy.hmi.project);
  assert.ok(copyHmi.startsWith(path.resolve(dir)+path.sep));await appendFile(copyHmi,' ');
  const changed=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(changed.state,'unknown');assert.equal(changed.reasonCode,'copy_changed');
  assert.equal(changed.keptProjectId,null);assert.equal(changed.manifestPath,null);assert.equal(changed.revision,null);
  assert.deepEqual(await readFile(receiptFile),originalReceipt,'read-only checks must not alter the keep receipt');
  for(const [relative,hash] of sourceFiles){const file=path.resolve(projectRoot,relative);assert.ok(file.startsWith(projectRoot+path.sep));if(file===path.resolve(data.manifestPath))continue;assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash,relative);}
 }finally{
  child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
  const code=child.exitCode,target=path.resolve(dir);assert.ok(path.basename(target).startsWith('plcdev-joint-review-receipt-')&&path.dirname(target)===staging);
  await rm(target,{recursive:true,force:true});assert.equal(code,0,stderr);
 }
});
