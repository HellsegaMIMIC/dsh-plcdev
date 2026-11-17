// Isolated real TaskService + workbench and DSH conversation/bridge routes.
// Team identities and proposals are fixture inputs; no live model or Runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,appendFile,readdir,rm} from 'node:fs/promises';
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
const backend=path.join(root,'tools/test_dsh_team_review_receipt_backend.py');
const missing=[python,backend,path.join(root,'software/teaching-cases/c02-retained/project.plcdev')].filter(p=>!existsSync(p));

test('team keep receipt traverses isolated services and the owning DSH conversation',{
 skip:missing.length?`Missing local integration prerequisites: ${missing.join(', ')}`:false,timeout:180000
},async()=>{
 await mkdir(staging,{recursive:true});
 const dir=await mkdtemp(path.join(staging,'plcdev-team-review-receipt-'));
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
  const projectRoot=path.resolve(data.projectRoot),agentHome=path.resolve(data.agentHome);
  assert.ok(projectRoot.startsWith(path.resolve(dir)+path.sep));assert.ok(agentHome.startsWith(path.resolve(dir)+path.sep));
  const sourceFiles=Object.entries(data.files);assert.ok(sourceFiles.length>3);
  const controllerFile=path.join(dir,'workbench/controller.json'),bridge=createBridge({projectRoot:root,controllerFile,timeoutMs:10000});
  const conversations=createConversationRoutes({controllerFile,bridge}),session='team-receipt-owner',route='/api/plcdev/conversations';
  ok(await conversations.handle('POST',route+'/bind',{conversationId:session,projectId:data.projectId,expectedVersion:0}));
  assert.equal(data.task.workflow,'team-generation-v1');assert.equal(data.task.status,'awaiting_review');
  // This is the trusted native-team integration hook, not an HTTP API and not
  // evidence that a desktop host actually created these fixture sessions.
  conversations.referenceTeam(session,data.task);
  const taskId=data.task.taskId;
  const original={conversationId:session,projectId:data.projectId,taskId,candidateDigest:data.task.candidate.candidateDigest,
   expectedRevision:data.revision,action:'keep',clientRequestId:'team-receipt-keep'};
  ok(await conversations.handle('POST',route+'/review',original));
  const until=Date.now()+90000;let task;
  while(Date.now()<until){
   const listing=await bridge.handle('GET','/api/plcdev/tasks?project='+data.projectId);
   task=listing.body.tasks?.find(item=>item.taskId===taskId);
   if(task?.status==='kept')break;
   if(task&&['conflict','failed','unknown_outcome'].includes(task.status))throw new Error(JSON.stringify(task));
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(task?.status,'kept');
  const receiptFile=path.join(agentHome,'joint-changes/effects/team-receipt-keep.json'),receipt=await readFile(receiptFile);
  const verified=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(verified.state,'confirmed_registered');assert.match(verified.keptProjectId,/^user-[0-9a-f]{32}$/);
  assert.notEqual(verified.keptProjectId,data.projectId,'Native-team retention still creates its separate project');
  assert.equal(verified.completionScope,undefined);assert.equal(verified.version,undefined);
  assert.ok(path.resolve(verified.manifestPath).startsWith(path.resolve(dir)+path.sep));
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,conversationId:'other-session'})).status,403);
  assert.equal((await conversations.handle('POST',route+'/review-receipt',{...original,clientRequestId:'wrong-effect'})).status,503);
  assert.deepEqual(ok(await conversations.handle('POST',route+'/review-receipt',original)),verified);
  assert.deepEqual(await readdir(path.join(agentHome,'joint-changes/retained')),['team-receipt-keep']);
  const copy=JSON.parse(await readFile(verified.manifestPath,'utf8')),copyHmi=path.resolve(path.dirname(verified.manifestPath),copy.hmi.project);
  assert.ok(copyHmi.startsWith(path.resolve(dir)+path.sep));await appendFile(copyHmi,' ');
  const changed=ok(await conversations.handle('POST',route+'/review-receipt',original));
  assert.equal(changed.state,'unknown');assert.equal(changed.reasonCode,'copy_changed');
  assert.equal(changed.keptProjectId,null);assert.equal(changed.manifestPath,null);assert.equal(changed.revision,null);
  assert.deepEqual(await readFile(receiptFile),receipt);
  for(const [relative,hash] of sourceFiles){const file=path.resolve(projectRoot,relative);assert.ok(file.startsWith(projectRoot+path.sep));assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash,relative);}
 }finally{
  child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
  const code=child.exitCode,target=path.resolve(dir);assert.ok(path.basename(target).startsWith('plcdev-team-review-receipt-')&&path.dirname(target)===staging);
  await rm(target,{recursive:true,force:true});assert.equal(code,0,stderr);
 }
});
