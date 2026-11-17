// Real installed DSH agent loop, plugin session identity and TaskService;
// model responses are scripted locally, no external model or Runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createProjectContext} from '../src/project-context.mjs';
import {createNativeTools} from '../src/native-tools.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=path.join(root,'.tools/dsh-host/package.json');
const python=path.join(root,'.tools/workbench-agent-venv/Scripts/python.exe');
const required=[host,python,path.join(root,'tools/test_dsh_hmi_revision_backend.py'),path.join(root,'software/project-interface-demo/project.plcdev')];
const missing=required.filter(p=>!existsSync(p));

test('real DSH loop pins HMI parent across reopen and returns to baseline without keeping',{skip:missing.length?`Local integration prerequisites missing: ${missing.join(', ')}`:false,timeout:120000},async()=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const dir=await mkdtemp(path.join(tmpdir(),'plcdev-hmi-host-'));
 const child=spawn(python,['-B','-X','utf8','-u',path.join(root,'tools/test_dsh_hmi_revision_backend.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=[];let stderr='';child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;try{const r=JSON.parse(line);r.ok?p.resolve(r.result):p.reject(new Error(r.error));}catch(e){p.reject(e);}});
 child.on('exit',code=>{for(const p of pending.splice(0))p.reject(new Error(`fixture exited ${code}: ${stderr}`));});
 const rpc=data=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(data)+'\n');});
 let ctx,handle;
 try{
  const data=await rpc({op:'init'}),id='hmi-revision-chat';
  const bridge={async handle(method,url,body){
   if(method==='POST')return {status:202,body:{ok:true,...await rpc({op:'create',body})}};
   if(url.includes('/status'))return {status:200,body:{project:{id:data.projectId,name:'隔离工程'},projects:[{id:data.projectId}]}};
   return {status:200,body:await rpc({op:'context'})};
  }};
  const options={controllerFile:path.join(dir,'controller.json'),bridge};let conversations=createConversationRoutes(options);
  assert.equal((await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:id,projectId:data.projectId,expectedVersion:0})).status,200);
  const selection={current:{provider:'offline-a',model:'a'}};let step=0,desired='';
  class Scripted extends LlmAdapter{
   async *stream(o){
    let name,args;
    if(step++===0){name='plcdev_project_context';args={};}
    else{
     const last=[...o.messages].reverse().find(m=>m.role==='tool');const context=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
     name='plcdev_propose_hmi_static_text';args={contextToken:context.contextToken,viewId:data.viewId,elementId:data.elementId,text:desired};
    }
    const callId=`offline-${step}`;
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:JSON.stringify(args)};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}};
    yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  let authority;
  async function start(seed){
   ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});await ctx.plugin(Tools,{mode:'native'});await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
   authority=createProjectContext({ctx,conversations,verifiedRoutes:[{provider:'offline-a',model:'a'},{provider:'offline-b',model:'b'}]});for(const tool of createNativeTools({bridge,conversations,projectContext:authority}))ctx.tools.register(tool);
   ctx.llm.registerAdapter(['offline-a','offline-b'],new Scripted());
   handle=await ctx.agents.create({sessionId:id,seed,agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
  }
  async function send(oldValue,newValue){step=0;desired=newValue;handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:`把静态文字“${oldValue}”改为“${newValue}”`}]}));await handle.agent.whenIdle();assert.equal(authority.size(),0);}
  async function arm(task){const r=await conversations.handle('POST','/api/plcdev/conversations/revision',{conversationId:id,projectId:data.projectId,taskId:task.taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:data.revision,expectedVersion:1,intentId:'rev-'+task.taskId});assert.equal(r.status,200,JSON.stringify(r.body));}
  await start();await send(data.oldText,'第一版');let tasks=await rpc({op:'list'});assert.equal(tasks.length,1);assert.equal(tasks[0].status,'awaiting_review',JSON.stringify(tasks[0]));const first=tasks[0];
  await arm(first);const seed=JSON.parse(JSON.stringify(handle.agent.session.snapshotEvents()));await handle.dispose();await ctx.fiber.dispose();handle=null;
  conversations=createConversationRoutes(options);const reopened=await rpc({op:'reopen'});assert.equal(reopened.sourceUnchanged,true);selection.current={provider:'offline-b',model:'b'};
  await start(seed);await send('第一版','第二版');tasks=await rpc({op:'list'});const second=tasks.find(t=>t.parentTaskId===first.taskId);
  assert.equal(second?.status,'awaiting_review',JSON.stringify(tasks));assert.deepEqual(second.candidate.summary,{before:data.oldText,after:'第二版'});assert.equal(tasks.find(t=>t.taskId===first.taskId).status,'superseded');
  await arm(second);await send('第二版',data.oldText);tasks=await rpc({op:'list'});const restored=tasks.find(t=>t.parentTaskId===second.taskId);
  assert.equal(restored?.status,'no_change',JSON.stringify(tasks));assert.equal(restored.candidate.noChange,true);assert.equal(restored.candidate.revisionSupported,false);assert.deepEqual(restored.candidate.changes,[]);
  assert.equal((await rpc({op:'check'})).sourceUnchanged,true);assert.equal(conversations.snapshot(id).taskRefs.length,3);
 } finally {if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await rm(dir,{recursive:true,force:true});}
});
