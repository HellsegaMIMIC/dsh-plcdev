// Actual installed DSH loop + production plugin tools/context/SQLite + Python native
// generator/TaskStore. Only model responses and transport are offline fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createProjectContext} from '../src/project-context.mjs';
import {createNativeTools} from '../src/native-tools.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {recoverConversationRequest} from '../src/client/conversation-client.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=path.join(root,'.tools/dsh-host/package.json');
// Public source exports contain the test code, but deliberately omit teaching
// projects and installed editor/FUXA assets. Missing prerequisites are a visible
// skipped integration check, never evidence that native generation passed.
const prerequisites=[
 '.tools/dsh-host/package.json',
 'tools/test_dsh_decoupling_backend.py',
 'software/fuxa-oip/plc/project/project.json',
 'software/fuxa-oip/hmi/batch-ai.fuxap',
 'software/oip-batch/ContinuousBatch/project.json',
 'software/openplc-editor-zh/src/cli/commands/agent-candidate.ts',
 'software/openplc-editor-zh/src/cli/commands/agent-candidate-worker.cjs',
 'software/openplc-editor-zh/node_modules/typescript',
 'software/openplc-editor-zh/node_modules/jsdom',
 'outputs/openplc-editor-zh/OpenPLC-Editor-ZH-workbench-r3-20261028/OpenPLC Editor.exe',
 ...Object.keys(JSON.parse(readFileSync(path.join(root,'tools/fuxa_permission_engine.json'),'utf8')).files),
];
const missing=prerequisites.filter(name=>!existsSync(path.join(root,name)));

test('real host A generates; reopened B revises; failure and unknown replay retain exact plan/route', {skip:missing.length?`Maintainer integration prerequisites missing: ${missing.join(', ')}`:false,timeout:90000}, async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const dir=await mkdtemp(path.join(tmpdir(),'plcdev-model-switch-'));
 const child=spawn('python',['-u',path.join(root,'tools/test_dsh_decoupling_backend.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=[];let stderr='';child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;const r=JSON.parse(line);r.ok?p.resolve(r.result):p.reject(new Error(r.error));});
 child.on('exit',code=>{for(const p of pending.splice(0))p.reject(new Error(`fixture exited ${code}: ${stderr}`));});
 const rpc=data=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(data)+'\n');});
 let ctx,handle;let requests=0,drop=false,invalid=false;
 try {
  const data=await rpc({op:'init'}),id='model-switch-chat';
  const bridge={async handle(method,url,body){
   if(method==='POST'){const result=await rpc({op:'create',body});if(drop){drop=false;throw new Error('lost response');}return {status:202,body:{ok:true,...result}};}
   if(url.includes('/status'))return {status:200,body:{project:{id:data.projectId,name:'Offline isolated project'},projects:[{id:data.projectId}]}};
   return {status:200,body:{projectId:data.projectId,projectRevision:data.revision,capabilities:{jointAiCandidate:true,jointPlanCandidate:true},planningInput:data.planningInput,tasks:await rpc({op:'list'})}};
  }};
  const options={controllerFile:path.join(dir,'controller.json'),bridge};let conversations=createConversationRoutes(options);
  await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:id,projectId:data.projectId,expectedVersion:0});
  const selection={current:{provider:'offline-a',model:'a'}};
  class Scripted extends LlmAdapter {
   async *stream(o){
    if (!o.tools?.some(t=>t.name==='plcdev_propose_joint')) {
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'当前请求没有工程工具；可以继续聊天和审阅。'};
      yield {type:'block-end',index:0,block:{type:'text',text:'当前请求没有工程工具；可以继续聊天和审阅。'}};
      yield {type:'finish',reason:{kind:'stop'}};return;
    }
    requests++;if(requests>20)throw new Error('Offline fixture exceeded expected requests');const latest=[...o.messages].reverse().find(m=>m.role==='tool');let name,args;
    const revision=conversations.snapshot(id).revisionContext;
    const context=latest&&JSON.parse(latest.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    if(!context?.contextToken || context?.projectRevision!==data.revision){name='plcdev_project_context';args={};}
    else {
      name='plcdev_propose_joint';const plan=structuredClone(data.plan);plan.hmi.title=revision?'6':'5';
      if(revision)plan.oip.value='unrequested regression';if(invalid)plan.hmi.title='7';
      args={request:'model paraphrase must not replace user text',contextToken:context.contextToken,planJson:JSON.stringify(plan)};
    }
    const callId=`model-call-${requests}`;
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:JSON.stringify(args)};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}};
    yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  let authority;
  async function start(seed){
   ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await ctx.plugin(Tools,{mode:'native'});await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
   authority=createProjectContext({ctx,conversations});for(const tool of createNativeTools({bridge,conversations,projectContext:authority}))ctx.tools.register(tool);
   ctx.llm.registerAdapter(['offline-a','offline-b'],new Scripted());
   handle=await ctx.agents.create({sessionId:id,seed,agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  }
  const send=async text=>{handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));await handle.agent.whenIdle();assert.equal(authority.size(),0);};
  const arm=async task=>{const r=await conversations.handle('POST','/api/plcdev/conversations/revision',{conversationId:id,projectId:data.projectId,taskId:task.taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:data.revision,expectedVersion:1,intentId:'rev-'+task.taskId});assert.equal(r.status,200);};
  await start();await send('生成联合候选，标题为 5');let tasks=await rpc({op:'list'});assert.equal(tasks.length,1,JSON.stringify(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'||e.type==='tool/result'&&e.data.message.isError)));assert.equal(tasks[0].status,'awaiting_review');const parent=tasks[0];
  await arm(parent);const seed=JSON.parse(JSON.stringify(handle.agent.session.snapshotEvents()));await handle.dispose();await ctx.fiber.dispose();handle=null;
  conversations=createConversationRoutes(options);await rpc({op:'reopen'});selection.current={provider:'offline-b',model:'b'};
  await start(seed);await send('标题改成 6');tasks=await rpc({op:'list'});
  const revised=tasks.find(t=>t.parentTaskId===parent.taskId);assert.ok(revised);assert.equal(revised.status,'awaiting_review');assert.equal(revised.request,'标题改成 6');assert.equal(tasks.find(t=>t.taskId===parent.taskId).status,'superseded');
  await arm(revised);invalid=true;await send('标题改成 6');invalid=false;
  // A mismatched title fails without replacing the previous candidate.
  const check=await rpc({op:'check'});assert.equal(check.sourceUnchanged,true);assert.ok(check.tasks.some(t=>t.status==='failed'));assert.equal(check.tasks.find(t=>t.taskId===revised.taskId).status,'awaiting_review');
  assert.equal(check.plans[parent.taskId].route.provider,'offline-a');assert.equal(check.plans[revised.taskId].route.provider,'offline-b');
  // Lost submission response is retried from durable outbox, never regenerated by new model.
  const latest=check.tasks.find(t=>t.status==='awaiting_review');await arm(latest);drop=true;
  // Stop after first failed tool response so this offline model does not invent retries.
  const original=bridge.handle;bridge.handle=async(...args)=>{try{return await original(...args);}catch(e){handle.agent.cancel();throw e;}};
  await send('标题改成 6');conversations=createConversationRoutes(options);
  const before=await rpc({op:'list'}),pendingRequest=conversations.snapshot(id).pendingRequests[0];assert.ok(pendingRequest);
  const replay=recoverConversationRequest(pendingRequest,id);assert.ok(replay.planSubmission);assert.equal(replay.planSubmission.route.provider,'offline-b');
  const result=await conversations.handle('POST','/api/plcdev/conversations/tasks',replay);assert.equal(result.status,202);assert.equal((await rpc({op:'list'})).length,before.length);
  handle.agent.ctx.tools.restrict({deny:['plcdev_project_context','plcdev_propose_joint','plcdev_task_status']});
  await send('请生成一个候选');assert.equal(authority.notice(id).state,'tools-unavailable');
  assert.equal((await rpc({op:'list'})).length,before.length);assert.ok(conversations.snapshot(id).taskRefs.length);
  await send('你好');assert.equal(authority.notice(id),null);assert.equal((await rpc({op:'check'})).sourceUnchanged,true);
 } finally {if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await rm(dir,{recursive:true,force:true});}
});
