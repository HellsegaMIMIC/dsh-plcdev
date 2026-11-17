// Opt-in real DSH -> TaskService -> installed OIP tools. Scripted local model,
// temporary projects only; no provider requests, communication or scene Run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createProjectContext} from '../src/project-context.mjs';
import {createNativeTools} from '../src/native-tools.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {fixturePython} from './helpers/fixture-python.mjs';
import {ContextReadPlanner} from './helpers/context-read-planner.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');

test('ordinary DSH creates its first OIP scene, revises the same candidate, keeps in this project and discards a later edit',
 {skip:process.env.PLCDEV_DSH_OIP_NATIVE!=='1'?'Opt-in installed OIP native tools: PLCDEV_DSH_OIP_NATIVE=1':false,timeout:600000},async t=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const dir=await mkdtemp(path.join(tmpdir(),'plcdev-oip-create-host-'));
 const child=spawn(fixturePython(root),['-B','-X','utf8','-u',path.join(root,'tools/test_dsh_project_edit_backend.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=[];let stderr='',ctx,handle;
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;try{const r=JSON.parse(line);r.ok?p.resolve(r.result):p.reject(new Error(r.error));}catch(e){p.reject(e);}});
 child.on('exit',code=>{for(const p of pending.splice(0))p.reject(new Error(`fixture exited ${code}: ${stderr}`));});
 const rpc=data=>new Promise((resolve,reject)=>{if(child.exitCode!==null)return reject(new Error(stderr));pending.push({resolve,reject});child.stdin.write(JSON.stringify(data)+'\n');});
 try{
  const data=await rpc({op:'init'}),id='oip-first-scene-chat';assert.equal(data.schemaVersion,1);assert.equal((await rpc({op:'current'})).oip,null);
  const bridge={async handle(method,url,body){
   if(method==='POST')return {status:202,body:{ok:true,...await rpc({op:url.endsWith('/review')?'review':'create',body})}};
   if(url.includes('/status'))return {status:200,body:{project:{id:data.projectId,name:'原生首建场景测试'},projects:[{id:data.projectId}]}};
   return {status:200,body:await rpc({op:'context'})};
  }};
  const conversations=createConversationRoutes({controllerFile:path.join(dir,'controller.json'),bridge});
  assert.equal((await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:id,projectId:data.projectId,expectedVersion:0})).status,200);
  const selection={current:{provider:'deepseek-account',model:'deepseek-flash'}},observed=[];let phase=0,mode='create',readPlanner=new ContextReadPlanner(),fixtureCall=0;
  class Scripted extends LlmAdapter {async *stream(options){
   if(phase>=2){yield {type:'finish',reason:{kind:'stop'}};return;}
   let name,args;
   if(phase===0){phase=1;name='plcdev_project_context';args={};}
   else{
    const message=[...options.messages].reverse().find(m=>m.role==='tool');
    const read=readPlanner.accept(JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join('')));
    if(read){name=read.name;args=read.args;}
    else {phase=2;const context=readPlanner.value;
    observed.push({mode,context});assert.equal(context.projectId,data.projectId);assert.equal(context.projectEditCandidate,true);
    let change;
    if(mode==='create'){
     const native=context.editingInput.oipCreation;assert.ok(native?.tools.some(t=>t.name==='add_part'));
     assert.equal(context.editingInput.oipTools,undefined);assert.ok(context.editingInput.operations.includes('oip-create-scene'));
     change={kind:'oip-create-scene',name:'DSH 原生输送场景',calls:[{name:'add_part',input:{package:'oip.belt-conveyor',name:'本轮创建的输送带',position:[0,0,0],params:{speed:0.6}}}]};
    }else{
     const native=context.editingInput.oipTools;assert.ok(native?.tools.some(t=>t.name==='update_part'));
     const part=native.parts.find(p=>p.name===(mode==='revision'?'本轮创建的输送带':'对话创建并保留'));assert.ok(part,JSON.stringify(native.parts));
     change={kind:'oip-tools',calls:[{name:'update_part',input:{id:part.id,name:mode==='revision'?'对话创建并保留':'撤销后不应留存',params:{speed:mode==='revision'?1.1:1.7}}}]};
    }
    name='plcdev_propose_project_edit';args={contextToken:context.contextToken,planJson:JSON.stringify({schemaVersion:1,changes:[change]})};
    }
   }
   const callId=`oip-${mode}-${++fixtureCall}`;
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:JSON.stringify(args)};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}};yield {type:'finish',reason:{kind:'tool-calls'}};
  }}
  ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
  let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-native');}catch{}
  if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode:'native'});
  await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
  const authority=createProjectContext({ctx,conversations});for(const tool of createNativeTools({bridge,conversations,projectContext:authority}))ctx.tools.register(tool,authority.toolRegistrationOptions);
  ctx.llm.registerAdapter(['deepseek-account','deepseek-official'],new Scripted());
  handle=await ctx.agents.create({sessionId:id,agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  const send=async text=>{phase=0;readPlanner=new ContextReadPlanner();handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));await handle.agent.whenIdle();assert.equal(authority.size(),0);};
  await send('在这个新工程创建 OIP 场景，放一个速度 0.6 的输送带。');
  const first=(await rpc({op:'list'}))[0];assert.equal(first?.status,'awaiting_review',JSON.stringify({status:first?.status,reason:first?.reason}));assert.equal((await rpc({op:'current'})).oip,null);
  assert.ok(first.candidate.components.find(c=>c.tool==='oip')?.operations.some(op=>op.name==='new_project'));
  assert.ok(first.candidate.changes.some(c=>c.path.includes('/oip/')&&c.beforeSha256===null));
  const armed=await conversations.handle('POST','/api/plcdev/conversations/revision',{conversationId:id,projectId:data.projectId,taskId:first.taskId,candidateDigest:first.candidate.candidateDigest,expectedRevision:data.revision,expectedVersion:1,intentId:'oip-native-revision'});assert.equal(armed.status,200,JSON.stringify(armed));
  mode='revision';selection.current={provider:'deepseek-official',model:'deepseek-flash'};handle.agent.model?.select?.(selection.current);
  await send('继续修改这个场景，把输送带改名为对话创建并保留，速度改为 1.1。');
  const second=(await rpc({op:'list'})).find(t=>t.parentTaskId===first.taskId);assert.equal(second?.status,'awaiting_review',JSON.stringify({status:second?.status,reason:second?.reason}));
  assert.equal((await rpc({op:'current'})).oip,null);assert.ok(observed[1].context.editingInput.oipTools.parts.some(p=>p.name==='本轮创建的输送带'));
  const keep=await conversations.handle('POST','/api/plcdev/conversations/review',{conversationId:id,projectId:data.projectId,taskId:second.taskId,candidateDigest:second.candidate.candidateDigest,expectedRevision:data.revision,action:'keep',clientRequestId:'native-oip-keep'});
  assert.equal(keep.body.task?.status,'kept',JSON.stringify(keep));assert.equal(keep.body.task.retention.keptProjectId,data.projectId);assert.equal(keep.body.task.retention.completionScope,'saved-project-version');
  const saved=await rpc({op:'current'});assert.equal(saved.oip.name,'DSH 原生输送场景');const savedBelt=saved.oip.parts.find(p=>p.name==='对话创建并保留');assert.equal(savedBelt?.params.speed,1.1);assert.equal(saved.revision,keep.body.task.retention.revision);
  mode='discard';await send('把输送带临时改名，速度设为 1.7，先给我候选。');
  const third=(await rpc({op:'list'})).find(t=>t.status==='awaiting_review');assert.ok(third,JSON.stringify((await rpc({op:'list'})).map(t=>({status:t.status,reason:t.reason}))));
  const discarded=await conversations.handle('POST','/api/plcdev/conversations/review',{conversationId:id,projectId:data.projectId,taskId:third.taskId,candidateDigest:third.candidate.candidateDigest,expectedRevision:saved.revision,action:'undo',clientRequestId:'native-oip-discard'});
  assert.equal(discarded.body.task?.status,'discarded',JSON.stringify(discarded));assert.deepEqual(await rpc({op:'current'}),saved);
  assert.equal(conversations.snapshot(id).projectId,data.projectId);
  t.diagnostic(JSON.stringify({hostPackage:host,sourceProjectId:data.projectId,keptProjectId:keep.body.task.retention.keptProjectId,savedScene:saved.oip.name,taskCount:3,externalModelCalls:0,runtimeStarted:false}));
 }finally{
  await handle?.dispose();await ctx?.fiber.dispose();child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
  assert.ok(dir.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(dir).startsWith('plcdev-oip-create-host-'));await rm(dir,{recursive:true,force:true});
 }
});
