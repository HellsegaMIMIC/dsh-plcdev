// Native DSH tool/adapter contract tests with in-memory fakes only. No provider or Runtime calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTools, TOOL_NAMES } from '../src/native-tools.mjs';
import { createProjectModelAdapter, projectModelRequest, MODEL_PROVIDER, MODEL_ID } from '../src/model-adapter.mjs';

const PROJECT='user-'+'a'.repeat(32),TASK='task-'+'b'.repeat(32),REV='c'.repeat(64);
function fixture(){
  const state={binding:{conversationId:'chat-a',projectId:PROJECT,version:1,taskRefs:[],pendingRequests:[]},revision:REV,posts:[],reads:[],concluded:0};
  const bridge={async handle(method,path){assert.equal(method,'GET');state.reads.push(path);return {status:200,body:{projectId:PROJECT,projectRevision:state.revision,capabilities:{jointAiCandidate:true,jointPlanCandidate:true},tasks:[{projectId:PROJECT,taskId:TASK,status:'awaiting_review'}]}};}};
  const conversations={snapshot:id=>({...structuredClone(state.binding),conversationId:id}),async handle(method,path,body){state.posts.push({method,path,body});state.binding.taskRefs.push({projectId:body.projectId,taskId:TASK});return {status:202,body:{task:{projectId:body.projectId,taskId:TASK,status:'queued',workflow:body.workflow}}};}};
  const scope={route:{provider:'model-a',model:'a'},userRequest:'用户的真实生成请求'};
  const projectContext={assertExecution:()=>scope,get:()=>scope};
  const tools=createNativeTools({bridge,conversations,projectContext}),exec={agent:{session:{id:'chat-a'}},callId:'call-1',signal:new AbortController().signal,concludeTurn(){state.concluded++;}};
  const call=async(name,args={},execution=exec)=>JSON.parse(await tools.find(t=>t.name===name).execute(args,execution));
  return {state,bridge,conversations,projectContext,tools,exec,call};
}
test('native tool registration exposes only context proposal status and trusted execution session',async()=>{
  const f=fixture();assert.deepEqual(f.tools.map(t=>t.name),TOOL_NAMES);
  await assert.rejects(f.call(TOOL_NAMES[0],{},{}),/真实 DSH/);
  await assert.rejects(f.call(TOOL_NAMES[0],{conversationId:'other'}),/参数无效/);
  const context=await f.call(TOOL_NAMES[0]);assert.equal(context.projectId,PROJECT);assert.equal(context.sourceBasis,'saved_revision');assert.match(context.contextToken,/^[a-f0-9]{64}$/);
  assert.equal(context.workflowRoute.proposalTool,'plcdev_propose_joint');
  const result=await f.call(TOOL_NAMES[1],{planJson:'{}',request:'Count 改为 BatchCount，更新画面及场景标签',contextToken:context.contextToken});
  assert.equal(result.task.taskId,TASK);assert.equal(f.state.concluded,1);assert.equal(f.state.posts.length,1);
  assert.equal(f.state.posts[0].path,'/api/plcdev/conversations/tasks');assert.equal(f.state.posts[0].body.conversationId,'chat-a');assert.equal(f.state.posts[0].body.workflow,'joint-ai-v1');
  assert.equal(f.state.posts[0].body.expectedRevision,REV);assert.equal(f.state.posts[0].body.executionScope,'proposal');
  const again=await f.call(TOOL_NAMES[1],{planJson:'{}',request:'Count 改为 BatchCount，更新画面及场景标签',contextToken:context.contextToken});
  assert.equal(f.state.posts[0].body.clientRequestId,f.state.posts[1].body.clientRequestId);assert.equal(again.task.projectId,PROJECT);
});
test('static HMI text uses only an exact listed target and an explicit user phrase',async()=>{
  const f=fixture();
  f.projectContext.assertExecution=()=>({route:{provider:'model-a',model:'a'},userRequest:'把静态文字“原标题”改为“设备演示”'});
  f.bridge.handle=async(method,path)=>({status:200,body:path.includes('/status?')?{project:{id:PROJECT,name:'A'}}:{projectId:PROJECT,projectRevision:REV,capabilities:{hmiStaticTextCandidate:true},hmiTextTargets:[{viewId:'v-a',elementId:'PLCD_tTitle',text:'原标题',ambiguousText:false}],tasks:[]}});
  const ctx=await f.call(TOOL_NAMES[0]);assert.equal(ctx.hmiStaticTextCandidate,true);
  await assert.rejects(f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_other',text:'设备演示'}),/身份/);
  await assert.rejects(f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_tTitle',text:'未经请求'}),/无法唯一确认/);
  await f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_tTitle',text:'设备演示'});
  assert.deepEqual(f.state.posts[0].body.planSubmission.plan,{viewId:'v-a',elementId:'PLCD_tTitle',text:'设备演示'});
  assert.equal(f.state.posts[0].body.workflow,'hmi-static-text-v1');
});

test('readonly value proposal uses a saved target, complete user intent and durable session receipt',async()=>{
  const f=fixture(),scope=f.projectContext.get();
  scope.userRequest='在画面 ID“v-a”添加信号 ID“actual”的只读数值显示';
  f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')?{project:{id:PROJECT,name:'A'}}:{projectId:PROJECT,projectRevision:REV,capabilities:{hmiReadonlyValueCandidate:true},hmiValueTargets:[{viewId:'v-a',signalId:'actual',label:'当前速度'}],tasks:[]}});
  const context=await f.call(TOOL_NAMES[0]),args={contextToken:context.contextToken,viewId:'v-a',signalId:'actual'};
  assert.equal(context.hmiReadonlyValueCandidate,true);
  await assert.rejects(f.call(TOOL_NAMES[5],{...args,signalId:'speed'}),/明确指定/);
  scope.userRequest+='，并启动PLC';await assert.rejects(f.call(TOOL_NAMES[5],args),/明确指定/);
  scope.userRequest=scope.userRequest.split('，')[0];scope.revision={};await assert.rejects(f.call(TOOL_NAMES[5],args),/父候选/);delete scope.revision;
  f.state.binding.pendingRequests=[{}];await assert.rejects(f.call(TOOL_NAMES[5],args),/待核对/);f.state.binding.pendingRequests=[];
  await f.call(TOOL_NAMES[5],args);
  assert.equal(f.state.posts.length,1);assert.equal(f.state.posts[0].body.workflow,'hmi-readonly-value-v1');
  assert.deepEqual(f.state.posts[0].body.planSubmission.plan,{viewId:'v-a',signalId:'actual'});
  assert.equal(f.state.posts[0].body.conversationId,'chat-a');assert.equal(f.state.concluded,1);
});
test('HMI revision uses the parent target and current value, never the saved source text',async()=>{
  const f=fixture(),scope=f.projectContext.get();
  scope.userRequest='把静态文字“第一版”改为“第二版”';
  scope.revision={workflow:'hmi-static-text-v1',target:{viewId:'v-a',elementId:'PLCD_tTitle'},previousSummary:{before:'源文字',after:'第一版'},expectedRevision:REV,parent:{taskId:TASK,candidateDigest:'d'.repeat(64)},intentId:'revision-1'};
  f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')?{project:{id:PROJECT,name:'A'}}:{projectId:PROJECT,projectRevision:REV,capabilities:{hmiStaticTextCandidate:true},hmiTextTargets:[{viewId:'v-a',elementId:'PLCD_tTitle',text:'源文字',ambiguousText:false}],tasks:[]}});
  const ctx=await f.call(TOOL_NAMES[0]);assert.equal(ctx.revision.previousSummary.after,'第一版');assert.equal(ctx.revision.target.elementId,'PLCD_tTitle');
  assert.equal(ctx.workflowRoute.proposalTool,'plcdev_propose_hmi_static_text');
  await assert.rejects(f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_tTitle',text:'不符'}),/无法唯一确认/);
  scope.userRequest='把静态文字“源文字”改为“第二版”';
  await assert.rejects(f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_tTitle',text:'第二版'}),/无法唯一确认/);
  scope.userRequest='把静态文字“第一版”改为“第二版”';
  await f.call(TOOL_NAMES[4],{contextToken:ctx.contextToken,viewId:'v-a',elementId:'PLCD_tTitle',text:'第二版'});
  assert.deepEqual(f.state.posts[0].body.revisionParent,scope.revision.parent);assert.equal(f.state.posts[0].body.revisionIntentId,'revision-1');
  assert.equal(f.state.posts[0].body.request,scope.userRequest);assert.equal(f.state.posts[0].body.expectedRevision,REV);
  f.state.revision='e'.repeat(64);f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')?{project:{id:PROJECT}}:{projectId:PROJECT,projectRevision:f.state.revision,capabilities:{},tasks:[]}});
  await assert.rejects(f.call(TOOL_NAMES[0]),/父候选源版本已变化/);
});
test('native stale project binding and saved version tokens cannot redirect a proposal',async()=>{
  const f=fixture(),context=await f.call(TOOL_NAMES[0]);
  f.state.binding.version++;
  await assert.rejects(f.call(TOOL_NAMES[1],{planJson:'{}',request:'联合修改',contextToken:context.contextToken}),/已变化/);
  f.state.binding.version--;f.state.revision='d'.repeat(64);
  await assert.rejects(f.call(TOOL_NAMES[1],{planJson:'{}',request:'联合修改',contextToken:context.contextToken}),/已变化/);
  assert.equal(f.state.posts.length,0);
  f.state.binding.projectId=null;await assert.rejects(f.call(TOOL_NAMES[0]),/关联/);
});
test('native status cannot read another conversation task and pending uncertain submission is not duplicated',async()=>{
  const f=fixture();await assert.rejects(f.call(TOOL_NAMES[2],{taskId:TASK}),/不属于/);
  f.state.binding.taskRefs.push({projectId:PROJECT,taskId:TASK});assert.equal((await f.call(TOOL_NAMES[2],{taskId:TASK})).task.taskId,TASK);
  const context=await f.call(TOOL_NAMES[0]);f.state.binding.pendingRequests.push({clientRequestId:'unknown'});
  await assert.rejects(f.call(TOOL_NAMES[1],{planJson:'{}',request:'联合修改',contextToken:context.contextToken}),/待核对/);assert.equal(f.state.posts.length,0);
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

test('project context isolates independent historical details while explicit status still reads them',async()=>{
  const f=fixture();f.state.binding.taskRefs.push({projectId:PROJECT,taskId:TASK});
  const previous={projectId:PROJECT,taskId:TASK,status:'kept',workflow:'hmi-static-text-v1',
    request:'历史独立需求',reason:'历史原因',candidate:{candidateDigest:'d'.repeat(64),summary:{before:'操作区',after:'设备操作区'},components:[{tool:'hmi',summary:'历史差异'}]}};
  f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')
    ? {project:{id:PROJECT,name:'A'}} : {projectId:PROJECT,projectRevision:REV,capabilities:{},tasks:[previous,{...previous,taskId:'foreign'}]}});
  const context=await f.call(TOOL_NAMES[0]);
  assert.deepEqual(context.tasks,[{projectId:PROJECT,taskId:TASK,status:'kept',workflow:'hmi-static-text-v1'}]);
  assert.equal(JSON.stringify(context).includes('历史独立需求'),false);
  assert.equal(JSON.stringify(context).includes('设备操作区'),false);
  const status=await f.call(TOOL_NAMES[2],{taskId:TASK});
  assert.deepEqual(status.task.summary,{before:'操作区',after:'设备操作区'});
  assert.equal(status.task.candidate.components[0].summary,'历史差异');
  await assert.rejects(f.call(TOOL_NAMES[2],{taskId:'foreign'}),/不属于/);
});

test('same-project saved versions can compile in this session, with explicit scope and current revision',async()=>{
  const f=fixture();f.state.binding.taskRefs.push({projectId:PROJECT,taskId:TASK});
  const retained={projectId:PROJECT,taskId:TASK,status:'kept',workflow:'project-edit-v1',candidate:{candidateDigest:'d'.repeat(64)},retention:{keptProjectId:PROJECT,completionScope:'saved-project-version',version:2,revision:REV}};
  f.bridge.handle=async(_method,path)=>({status:200,body:path.includes('/status?')?{project:{id:PROJECT,name:'A'}}:{projectId:PROJECT,projectRevision:REV,tasks:[retained]}});
  const args={contextToken:(await f.call(TOOL_NAMES[0])).contextToken,taskId:TASK};
  const status=await f.call(TOOL_NAMES[2],{taskId:TASK});assert.equal(status.task.retention.version,2);assert.equal(status.task.retention.revision,REV);assert.match(status.task.nextStep,/本会话继续修改/);
  await f.call(TOOL_NAMES[7],args);assert.equal(f.state.posts.length,1);assert.equal(f.state.posts[0].body.action,'compile');assert.equal(f.state.posts[0].body.expectedRevision,REV);
  retained.retention.revision='e'.repeat(64);await assert.rejects(f.call(TOOL_NAMES[7],args),/当前工程已变化/);
  retained.retention.revision=REV;delete retained.retention.completionScope;await assert.rejects(f.call(TOOL_NAMES[7],args),/先在结果卡/);
  retained.retention.completionScope='saved-project-version';retained.retention.version=1;await assert.rejects(f.call(TOOL_NAMES[7],args),/先在结果卡/);
  assert.equal(f.state.posts.length,1);
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

test('revision proposal preserves exact user request and pinned parent independently of adapter',async()=>{
 const f=fixture(),scope=f.projectContext.get();
 scope.userRequest='标题改成 6';scope.revision={parent:{taskId:TASK,candidateDigest:'d'.repeat(64)},intentId:'r-1'};
 const c=await f.call(TOOL_NAMES[0]);await f.call(TOOL_NAMES[1],{contextToken:c.contextToken,request:'模型重写',planJson:'{}'});
 assert.equal(f.state.posts[0].body.request,'标题改成 6');assert.deepEqual(f.state.posts[0].body.revisionParent,scope.revision.parent);
 assert.equal(f.state.posts[0].body.planSubmission.route.provider,'model-a');
});

test('provider projection strips host prompts environment older turns other tools and foreign tool output',()=>{
  const request=projectModelRequest(options()),json=JSON.stringify(request);
  assert.equal(request.messages[0].content,'CURRENT PROJECT REQUEST');assert.equal(request.messages.length,3);assert.equal(request.tools.length,TOOL_NAMES.length);
  for(const excluded of ['PRIVATE','OLD USER','OTHER TOOL','INJECTED','FOREIGN','shell'])assert.equal(json.includes(excluded),false);
  assert.equal(request.messages[2].tool_call_id,'ours');
  assert.throws(()=>projectModelRequest({...options(),purpose:'session-title'}),/普通原生对话/);
  assert.throws(()=>projectModelRequest({...options(),tools:[{name:'run_code'}]}),/native/);
});
test('server adapter emits real returned tool content and disjoint usage without exposing credentials',async()=>{
  const f=fixture(),requests=[];
  f.bridge.model=async(body,signal)=>{requests.push({body,signal});return {ok:true,completion:{choices:[{message:{content:'已读取需求',tool_calls:[{id:'call-A',type:'function',function:{name:TOOL_NAMES[0],arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:5,prompt_cache_hit_tokens:3,total_tokens:25}}};};
  const adapter=createProjectModelAdapter({...f,showLegacy:async()=>false}),prepared=await adapter.prepareCall(MODEL_PROVIDER,MODEL_ID);
  assert.equal(prepared.model.id,MODEL_ID);assert.deepEqual(await adapter.listModels(MODEL_PROVIDER),[]);assert.match(prepared.model.name,/旧版.*兼容/);
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
  assert.equal(f.state.posts.length,0);
});

test('HMI name tool pins its saved view and user intent without a PLC or scene plan',async()=>{
  const f=fixture(); const original=f.bridge.handle;
  f.bridge.handle=async(method,path)=>{const result=await original(method,path);if(path.startsWith('/api/plcdev/tasks?')){result.body.capabilities.hmiViewNameCandidate=true;result.body.hmiViews=[{id:'v_existing',name:'old',ambiguousName:false}];}return result;};
  f.projectContext.get=()=>({route:{provider:'offline',model:'test'},userRequest:'把画面名称“old”改为“车间画面”'});
  f.projectContext.assertExecution=f.projectContext.get;
  const context=await f.call(TOOL_NAMES[0]);
  await assert.rejects(f.call(TOOL_NAMES[3],{contextToken:context.contextToken,viewId:'foreign',name:'车间画面'}),/画面身份/);
  await assert.rejects(f.call(TOOL_NAMES[3],{contextToken:context.contextToken,viewId:'v_existing',name:'不存在的名称'}),/无法唯一确认/);
  const result=await f.call(TOOL_NAMES[3],{contextToken:context.contextToken,viewId:'v_existing',name:'车间画面'});
  assert.equal(result.task.projectId,PROJECT);const body=f.state.posts[0].body;
  assert.equal(body.workflow,'hmi-view-name-v1');assert.equal(body.conversationId,'chat-a');assert.equal(body.expectedRevision,REV);
  assert.deepEqual(body.planSubmission.plan,{viewId:'v_existing',name:'车间画面'});
  assert.equal(body.request,'把画面名称“old”改为“车间画面”');assert.equal(body.sourceBasis,'saved_revision');
});
