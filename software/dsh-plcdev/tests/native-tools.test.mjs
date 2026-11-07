// Native DSH tool/adapter contract tests with in-memory fakes only. No provider or Runtime calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTools, TOOL_NAMES } from '../src/native-tools.mjs';
import { createProjectModelAdapter, projectModelRequest, MODEL_PROVIDER, MODEL_ID } from '../src/model-adapter.mjs';

const PROJECT='user-'+'a'.repeat(32),TASK='task-'+'b'.repeat(32),REV='c'.repeat(64);
function fixture(){
  const state={binding:{conversationId:'chat-a',projectId:PROJECT,version:1,taskRefs:[],pendingRequests:[]},revision:REV,posts:[],reads:[],concluded:0};
  const bridge={async handle(method,path){assert.equal(method,'GET');state.reads.push(path);return {status:200,body:{projectId:PROJECT,projectRevision:state.revision,capabilities:{jointAiCandidate:true},tasks:[{projectId:PROJECT,taskId:TASK,status:'awaiting_review'}]}};}};
  const conversations={snapshot:id=>({...structuredClone(state.binding),conversationId:id}),async handle(method,path,body){state.posts.push({method,path,body});state.binding.taskRefs.push({projectId:body.projectId,taskId:TASK});return {status:202,body:{task:{projectId:body.projectId,taskId:TASK,status:'queued',workflow:body.workflow}}};}};
  const tools=createNativeTools({bridge,conversations}),exec={agent:{session:{id:'chat-a'}},callId:'call-1',signal:new AbortController().signal,concludeTurn(){state.concluded++;}};
  const call=async(name,args={},execution=exec)=>JSON.parse(await tools.find(t=>t.name===name).execute(args,execution));
  return {state,bridge,conversations,tools,exec,call};
}
test('native tool registration exposes only context proposal status and trusted execution session',async()=>{
  const f=fixture();assert.deepEqual(f.tools.map(t=>t.name),TOOL_NAMES);
  await assert.rejects(f.call(TOOL_NAMES[0],{},{}),/真实 DSH/);
  await assert.rejects(f.call(TOOL_NAMES[0],{conversationId:'other'}),/参数无效/);
  const context=await f.call(TOOL_NAMES[0]);assert.equal(context.projectId,PROJECT);assert.equal(context.sourceBasis,'saved_revision');assert.match(context.contextToken,/^[a-f0-9]{64}$/);
  const result=await f.call(TOOL_NAMES[1],{request:'Count 改为 BatchCount，更新画面及场景标签',contextToken:context.contextToken});
  assert.equal(result.task.taskId,TASK);assert.equal(f.state.concluded,1);assert.equal(f.state.posts.length,1);
  assert.equal(f.state.posts[0].path,'/api/plcdev/conversations/tasks');assert.equal(f.state.posts[0].body.conversationId,'chat-a');assert.equal(f.state.posts[0].body.workflow,'joint-ai-v1');
  assert.equal(f.state.posts[0].body.expectedRevision,REV);assert.equal(f.state.posts[0].body.executionScope,'proposal');
  const again=await f.call(TOOL_NAMES[1],{request:'Count 改为 BatchCount，更新画面及场景标签',contextToken:context.contextToken});
  assert.equal(f.state.posts[0].body.clientRequestId,f.state.posts[1].body.clientRequestId);assert.equal(again.task.projectId,PROJECT);
});
test('native stale project binding and saved version tokens cannot redirect a proposal',async()=>{
  const f=fixture(),context=await f.call(TOOL_NAMES[0]);
  f.state.binding.version++;
  await assert.rejects(f.call(TOOL_NAMES[1],{request:'联合修改',contextToken:context.contextToken}),/已变化/);
  f.state.binding.version--;f.state.revision='d'.repeat(64);
  await assert.rejects(f.call(TOOL_NAMES[1],{request:'联合修改',contextToken:context.contextToken}),/已变化/);
  assert.equal(f.state.posts.length,0);
  f.state.binding.projectId=null;await assert.rejects(f.call(TOOL_NAMES[0]),/关联/);
});
test('native status cannot read another conversation task and pending uncertain submission is not duplicated',async()=>{
  const f=fixture();await assert.rejects(f.call(TOOL_NAMES[2],{taskId:TASK}),/不属于/);
  f.state.binding.taskRefs.push({projectId:PROJECT,taskId:TASK});assert.equal((await f.call(TOOL_NAMES[2],{taskId:TASK})).task.taskId,TASK);
  const context=await f.call(TOOL_NAMES[0]);f.state.binding.pendingRequests.push({clientRequestId:'unknown'});
  await assert.rejects(f.call(TOOL_NAMES[1],{request:'联合修改',contextToken:context.contextToken}),/待核对/);assert.equal(f.state.posts.length,0);
});

test('native cards preserve evidence and accept a name only from the exact project',async()=>{
  const f=fixture();f.state.binding.taskRefs.push({projectId:PROJECT,taskId:TASK});
  let returnedId=PROJECT;
  f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')
    ? {project:{id:returnedId,name:'工程 A'}}
    : {projectId:PROJECT,projectRevision:REV,tasks:[{projectId:PROJECT,taskId:TASK,projectRevision:REV,status:'compiled',workflow:'joint-ai-v1',
      candidate:{candidateDigest:'d'.repeat(64),validation:'joint-native-structure-and-bindings',components:[{tool:'openplc',summary:'Count → BatchCount',path:'PRIVATE-PATH'}]},
      retention:{projectId:PROJECT,keptProjectId:'user-'+'e'.repeat(32),status:'kept',manifestPath:'PRIVATE-PATH'},compilation:{status:'compiled',logs:'PRIVATE-LOG'}}]}});
  const result=await f.call(TOOL_NAMES[2],{taskId:TASK});
  assert.equal(result.projectName,'工程 A');assert.equal(result.task.projectRevision,REV);
  assert.equal(result.task.candidate.components[0].summary,'Count → BatchCount');assert.equal(result.task.compilation.status,'compiled');
  assert.equal(result.task.retention.keptProjectId,'user-'+'e'.repeat(32));assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  returnedId='user-'+'f'.repeat(32);
  assert.equal((await f.call(TOOL_NAMES[2],{taskId:TASK})).projectName,null);
});

const options=()=>({provider:MODEL_PROVIDER,model:MODEL_ID,sessionId:'chat-a',tools:[...TOOL_NAMES.map(name=>({name,description:name,parameters:{type:'object',properties:{}}})),{name:'shell',description:'do not send',parameters:{}}],messages:[
  {role:'system',content:[{type:'text',text:'PRIVATE SYSTEM ENVIRONMENT'}]},
  {role:'user',source:{kind:'user'},content:[{type:'text',text:'OLD USER TURN'}]},
  {role:'tool',source:{callId:'old'},content:[{type:'text',text:'OTHER TOOL SECRET'}]},
  {role:'user',source:{kind:'user'},content:[{type:'text',text:'CURRENT PROJECT REQUEST'}]},
  {role:'developer',content:[{type:'text',text:'PRIVATE PATH'}]},
  {role:'user',source:{kind:'workspace',form:'snapshot'},content:[{type:'text',text:'INJECTED ENVIRONMENT'}]},
  {role:'assistant',source:{provider:MODEL_PROVIDER},content:[{type:'tool-call',id:'ours',name:TOOL_NAMES[0],arguments:'{}'}]},
  {role:'tool',source:{callId:'ours'},content:[{type:'text',text:'{"projectId":"bound"}'}]},
  {role:'tool',source:{callId:'foreign'},content:[{type:'text',text:'FOREIGN TOOL DATA'}]},
]});
test('provider projection strips host prompts environment older turns other tools and foreign tool output',()=>{
  const request=projectModelRequest(options()),json=JSON.stringify(request);
  assert.equal(request.messages[0].content,'CURRENT PROJECT REQUEST');assert.equal(request.messages.length,3);assert.equal(request.tools.length,3);
  for(const excluded of ['PRIVATE','OLD USER','OTHER TOOL','INJECTED','FOREIGN','shell'])assert.equal(json.includes(excluded),false);
  assert.equal(request.messages[2].tool_call_id,'ours');
  assert.throws(()=>projectModelRequest({...options(),purpose:'session-title'}),/普通原生对话/);
  assert.throws(()=>projectModelRequest({...options(),tools:[{name:'run_code'}]}),/native/);
});
test('server adapter emits real returned tool content and disjoint usage without exposing credentials',async()=>{
  const f=fixture(),requests=[];
  f.bridge.model=async(body,signal)=>{requests.push({body,signal});return {ok:true,completion:{choices:[{message:{content:'已读取需求',tool_calls:[{id:'call-A',type:'function',function:{name:TOOL_NAMES[0],arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:5,prompt_cache_hit_tokens:3,total_tokens:25}}};};
  const adapter=createProjectModelAdapter(f),prepared=await adapter.prepareCall(MODEL_PROVIDER,MODEL_ID);
  assert.equal(prepared.model.id,MODEL_ID);assert.equal((await adapter.listModels(MODEL_PROVIDER))[0].name,'DeepSeek · PLCdev 工程助手');
  const chunks=await Array.fromAsync(prepared.stream(options()));assert.equal(requests.length,1);assert.equal(chunks.at(-1).reason.kind,'tool-calls');
  assert.deepEqual(chunks.find(c=>c.type==='usage').usage,{inputTokens:17,outputTokens:5,cacheReadTokens:3,totalTokens:25});
  assert.equal(chunks.find(c=>c.type==='tool-call-delta').name,TOOL_NAMES[0]);assert.equal(adapter.providerRetryPolicy().maxRetries,0);
});
test('adapter rejects forbidden tool before yielding any output; unbound and aborted calls never dispatch',async()=>{
  const f=fixture();let requests=0;
  f.bridge.model=async()=>{requests++;return {ok:true,completion:{choices:[{message:{content:'DO NOT EMIT',tool_calls:[{id:'x',type:'function',function:{name:'runtime_start',arguments:'{}'}}]},finish_reason:'tool_calls'}]}};};
  const adapter=createProjectModelAdapter(f),emitted=[];
  await assert.rejects(async()=>{for await(const chunk of adapter.stream(options()))emitted.push(chunk);},/未授权工具/);assert.deepEqual(emitted,[]);
  f.state.binding.projectId=null;await assert.rejects(Array.fromAsync(adapter.stream(options())),/关联/);assert.equal(requests,1);
  const controller=new AbortController();controller.abort();await assert.rejects(Array.fromAsync(adapter.stream({...options(),signal:controller.signal})));assert.equal(requests,1);
});

test('rebinding while native model request is in flight discards old reply before tools can act',async()=>{
  const f=fixture(),turnScopes=new Map();let resolve,started;
  const ready=new Promise(done=>started=done);
  f.bridge.model=async()=>{started();return await new Promise(done=>resolve=done);};
  const adapter=createProjectModelAdapter({...f,turnScopes}),pending=Array.fromAsync(adapter.stream(options()));await ready;
  f.state.binding.version++;
  resolve({ok:true,completion:{choices:[{message:{tool_calls:[{id:'late',type:'function',function:{name:TOOL_NAMES[0],arguments:'{}'}}]},finish_reason:'tool_calls'}]}});
  await assert.rejects(pending,/旧回复未执行/);
  const tools=createNativeTools({...f,turnScopes});await assert.rejects(tools[0].execute({},f.exec),/工程绑定已变化/);
  await assert.rejects(Array.fromAsync(adapter.stream(options())),/本轮对话期间/);assert.equal(f.state.posts.length,0);
});
