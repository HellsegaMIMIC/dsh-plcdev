// Offline ordinary-model entry, strict proposal/revision scope and compile-only authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTools} from '../src/native-tools.mjs';
import {validProjectEditPlan,validProjectEditSubmission} from '../src/project-edit-contract.mjs';
import {candidateChanges,reviewActionRequest,recoverConversationRequest,artifactRows} from '../src/client/conversation-client.mjs';
const P='user-'+'1'.repeat(32),K='user-'+'2'.repeat(32),T='task-'+'3'.repeat(32),R='4'.repeat(64),D='5'.repeat(64),KR='6'.repeat(64);
const plan=()=>({schemaVersion:1,changes:[{kind:'plc-source',path:'plc/pous/programs/main.st',expectedHash:R,content:'PROGRAM main\nEND_PROGRAM'}]});
const sharedPlan=()=>({schemaVersion:1,changes:[{kind:'openplc-tools',calls:[
 {name:'create_pou',input:{name:'DelayLogic',type:'function-block',language:'st'}},
 {name:'create_variable',input:{pouName:'DelayLogic',name:'Enable',class:'input',type:'BOOL'}},
 {name:'write_ladder',input:{pouName:'RunLamp',variables:[{name:'On',type:'BOOL'},{name:'Lamp',type:'BOOL'}],rungs:[{series:[{variable:'On'}],coil:'Lamp'}]}}
]}]});
function fixture(){
 const binding={conversationId:'chat',projectId:P,version:1,taskRefs:[{projectId:P,taskId:T}],pendingRequests:[]};
 const source={schemaVersion:1,projectRevision:R,plcSources:[{path:'plc/pous/programs/main.st',sha256:R,content:'source'}]};
 const parent={...source,projectRevision:D,plcSources:[{...source.plcSources[0],sha256:D,content:'parent'}]};
 const task={projectId:P,taskId:T,workflow:'project-edit-v1',status:'awaiting_review',projectRevision:R,candidate:{candidateDigest:D,editingInput:parent,revisionSupported:true}};
 const listing={projectId:P,projectRevision:R,capabilities:{projectEditCandidate:true},editingInput:source,tasks:[task]};
 const scope={turnKey:'turn-1',route:{provider:'deepseek-account',model:'deepseek-flash'},userRequest:'添加延时逻辑，并显示剩余秒数'};
 const posts=[];
 const bridge={async handle(method,path){assert.equal(method,'GET');return {status:200,body:path.includes('/status?')?{project:{id:P,name:'工程'}}:listing};}};
 const conversations={snapshot:()=>structuredClone(binding),async handle(method,path,body){posts.push({method,path,body});return {status:202,body:{task:{...task,status:body.action==='compile'?'compiling':'queued'}}};}};
 const projectContext={assertExecution:()=>scope,get:()=>scope};
 const exec={agent:{session:{id:'chat'}},callId:'call-1',signal:new AbortController().signal,concludeTurn(){exec.concluded=true;}};
 const tools=createNativeTools({bridge,conversations,projectContext});
 const call=async(name,args={})=>JSON.parse(await tools.find(t=>t.name===name).execute(args,exec));
 return {binding,source,parent,task,listing,scope,posts,exec,tools,call};
}
test('project editing validates exact typed data and bounded source, not commands',()=>{
 assert.equal(validProjectEditPlan(plan()),true);
 assert.equal(validProjectEditPlan({...plan(),command:'shell'}),false);
 for(const change of [{kind:'shell',command:'x'},{...plan().changes[0],path:'../main.st'},{...plan().changes[0],path:'C:/main.st'},{...plan().changes[0],path:'plc\\main.st'},{...plan().changes[0],content:'a'.repeat(131073)},{kind:'oip-conveyor-speed',partId:'belt',value:NaN}])assert.equal(validProjectEditPlan({schemaVersion:1,changes:[change]}),false);
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[{...plan().changes[0],path:'plc/pous/程序.st'}]}),true);
 assert.equal(validProjectEditSubmission({schemaVersion:1,plan:plan(),route:{provider:'a',model:'b'}}),true);
 assert.equal(validProjectEditSubmission({schemaVersion:1,plan:plan(),route:{provider:'a',model:'b',key:'forbidden'}}),false);
});
test('shared editing transports ordered native calls without copying OpenPLC tool schemas',()=>{
 assert.equal(validProjectEditPlan(sharedPlan()),true);
 // Schema authority belongs to the native catalog/executor. The transport must
 // not maintain a second tool list which would drift when OpenPLC evolves.
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[{kind:'openplc-tools',calls:[{name:'future_editor_operation',input:{nativeProperty:true}}]}]}),true);
 const change=sharedPlan().changes[0],call=change.calls[0];
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[change,change]}),false);
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[change,plan().changes[0]]}),false);
 for(const bad of [
  {...change,command:'x'}, {...change,calls:[]}, {...change,calls:Array(65).fill(call)},
  {...change,calls:[{...call,projectPath:'other'}]}, {...change,calls:[{name:'../create_pou',input:{}}]},
  {...change,calls:[{name:call.name,input:[]}]}, {...change,calls:[{name:call.name,input:null}]},
  {...change,calls:[{name:call.name,input:{body:'x'.repeat(524288)}}]},
 ])assert.equal(validProjectEditPlan({schemaVersion:1,changes:[bad]}),false);
});
test('OIP native transport is ordered, bounded and independent from the OpenPLC batch',()=>{
 const change={kind:'oip-tools',calls:[{name:'update_part',input:{id:'belt-a',name:'输送带'}},{name:'get_problems',input:{}}]};
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[change]}),true);
 assert.equal(validProjectEditPlan({schemaVersion:1,changes:[change,sharedPlan().changes[0]]}),true);
 for(const changes of [[change,change],[change,{kind:'oip-part-name',partId:'a',name:'b'}],[change,{kind:'oip-conveyor-speed',partId:'a',value:1}],[{...change,calls:[]}],[{...change,calls:Array(65).fill(change.calls[0])}],[{...change,calls:[{...change.calls[0],path:'outside'}]}]])assert.equal(validProjectEditPlan({schemaVersion:1,changes}),false);
});

test('first OIP scene accepts an empty native scene or bounded edits, with one exclusive OIP batch',()=>{
 const create={kind:'oip-create-scene',name:'输送场景',calls:[]},call={name:'add_part',input:{id:'belt'}};
 const valid=changes=>validProjectEditPlan({schemaVersion:1,changes});
 assert.equal(valid([create]),true);assert.equal(valid([{...create,calls:Array(64).fill(call)},sharedPlan().changes[0]]),true);
 for(const bad of [{...create,name:''},{...create,name:'x'.repeat(81)},{...create,name:'<scene>'},{...create,name:'a\n'},{...create,calls:Array(65).fill(call)},{...create,calls:[{name:'shell',input:[]}]},{...create,path:'outside'}])assert.equal(valid([bad]),false);
 for(const other of [create,{kind:'oip-tools',calls:[call]},{kind:'oip-part-name',partId:'a',name:'b'},{kind:'oip-conveyor-speed',partId:'a',value:1}])assert.equal(valid([create,other]),false);
});

test('old HMI parent gains current OIP creation planning contract without changing candidate evidence',async()=>{
 const f=fixture(),catalog={contractVersion:1,nativeVersion:'2026.11.9',catalogDigest:R,tools:[{name:'add_part',input_schema:{type:'object'}}],packages:['conveyor'],scene:{parts:[]}};
 Object.assign(f.source,{oipCreation:catalog,operations:['oip-create-scene'],planSchema:{schemaVersion:1,changes:{'oip-create-scene':['calls','kind','name']}},limitations:['当前工程没有 OIP 场景，使用 oip-create-scene。']});
 Object.assign(f.parent,{operations:['hmi-static-text'],hmiTargets:{staticTexts:[{text:'候选文字'}]},planSchema:{schemaVersion:1,changes:{'hmi-static-text':['kind','text']}},limitations:['保留 HMI 布局。','OIP 仅修改已有部件名称或未绑定的输送带速度。']});
 f.scope.revision={workflow:'project-edit-v1',intentId:'old-hmi',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const before=structuredClone(f.parent),ctx=await f.call('plcdev_project_context');
 assert.equal(ctx.workflowRoute.proposalTool,'plcdev_propose_project_edit');
 assert.ok(Object.keys(ctx).indexOf('workflowRoute')<Object.keys(ctx).indexOf('editingInput'),'Routing must precede potentially large native catalogs');
 assert.deepEqual(ctx.editingInput.oipCreation,catalog);assert.deepEqual(ctx.editingInput.hmiTargets,before.hmiTargets);assert.deepEqual(f.parent,before);
 assert.deepEqual(ctx.editingInput.operations,['hmi-static-text','oip-create-scene']);assert.deepEqual(ctx.editingInput.planSchema.changes['hmi-static-text'],before.planSchema.changes['hmi-static-text']);
 assert.ok(ctx.editingInput.limitations.includes('保留 HMI 布局。'));assert.doesNotMatch(ctx.editingInput.limitations.join(' '),/仅修改已有部件/);
 const plan={schemaVersion:1,changes:[{kind:'oip-create-scene',name:'新场景',calls:[]}]};
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(plan)});
 assert.deepEqual(f.posts[0].body.planSubmission.plan,plan);assert.deepEqual(f.posts[0].body.revisionParent,f.scope.revision.parent);
});

test('created OIP parent refreshes from saved creation catalog and preserves its new scene',async()=>{
 const f=fixture(),catalog={contractVersion:1,nativeVersion:'2026.11.9',catalogDigest:R,tools:[{name:'update_part'}]};
 f.source.oipCreation={...catalog,scene:{parts:[]}};f.parent.oipTools={...catalog,tools:[{name:'old'}],scene:{parts:[{id:'new-belt'}]}};
 f.scope.revision={workflow:'project-edit-v1',intentId:'new-scene-parent',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const before=structuredClone(f.parent),ctx=await f.call('plcdev_project_context');
 assert.deepEqual(ctx.editingInput.oipTools.tools,catalog.tools);assert.deepEqual(ctx.editingInput.oipTools.scene,before.oipTools.scene);assert.equal(ctx.editingInput.oipCreation,undefined);assert.deepEqual(f.parent,before);
 f.source.oipCreation.catalogDigest='changed';await assert.rejects(f.call('plcdev_project_context'),/OIP 编辑工具版本已变化/);
});
test('detail reads reject a discarded, superseded or changed parent even when saved revision is unchanged',async()=>{
 for(const mutate of [f=>f.task.status='discarded',f=>f.task.supersededBy='new-task',f=>f.task.candidate.candidateDigest='c'.repeat(64),f=>f.binding.taskRefs=[]]){
  const f=fixture();f.scope.revision={workflow:'project-edit-v1',intentId:'parent-view',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
  const context=await f.call('plcdev_project_context'),args={contextToken:context.contextToken,path:'/editingInput/plcSources',offset:0};
  assert.equal((await f.call('plcdev_project_read',args)).value[0].content,'parent');mutate(f);
  await assert.rejects(f.call('plcdev_project_read',args),/父候选已变化/);
 }
});
test('unread context references cannot be submitted as native parameters',async()=>{
 const f=fixture(),context=await f.call('plcdev_project_context');
 const bad={schemaVersion:1,changes:[{kind:'oip-tools',calls:[{name:'update_part',input:{params:{_plcdevRead:{path:'/editingInput'}}}}]}]};
 await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:context.contextToken,planJson:JSON.stringify(bad)}),/尚未读取/);
 assert.equal(f.posts.length,0);
});
test('ordinary model extra request field receives exact corrective guidance without accepting or dropping user intent',async()=>{
 const f=fixture(),context=await f.call('plcdev_project_context');
 await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:context.contextToken,planJson:JSON.stringify(plan()),request:'model paraphrase'}),error=>{
  assert.match(error.message,/只接受 contextToken、planJson/);assert.match(error.message,/多余 request/);assert.match(error.message,/重试同一工具/);return true;
 });
 const excessive=Object.fromEntries(Array.from({length:1000},(_,i)=>['extra'+i,'not echoed']));
 await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:context.contextToken,planJson:JSON.stringify(plan()),...excessive}),error=>{
  assert.ok(error.message.length<1000);assert.match(error.message,/共 1000 项/);assert.doesNotMatch(error.message,/not echoed/);return true;
 });
 assert.equal(f.posts.length,0);
 await f.call('plcdev_propose_project_edit',{contextToken:context.contextToken,planJson:JSON.stringify(plan())});
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.request,f.scope.userRequest);
});
test('first HMI title guidance is a model projection and preserves the native interface contract',async()=>{
 const f=fixture();f.source.interfaceTemplate={schemaVersion:1,protocol:'project-interface-v1',title:'首屏标题',description:'工程说明',variables:[],operations:[]};
 const original=structuredClone(f.source),context=await f.call('plcdev_project_context');
 assert.match(context.interfaceGuidance,/change.definition.title/);assert.match(context.interfaceGuidance,/description 是合法/);
 assert.match(context.interfaceGuidance,/80 字符/);assert.match(context.interfaceGuidance,/500 字符/);
 assert.match(context.interfaceGuidance,/不会自动重写已有画面/);assert.deepEqual(f.source,original);
});
test('OIP revisions keep parent scene data, use the installed catalog and reject version drift',async()=>{
 const f=fixture(),currentTools=[{name:'update_part',input_schema:{type:'object'}}];
 f.source.oipTools={contractVersion:1,nativeVersion:'2026.11.9',catalogDigest:R,tools:currentTools,scene:{parts:[{id:'source'}]}};
 f.parent.oipTools={...f.source.oipTools,tools:[{name:'invented'}],scene:{parts:[{id:'parent'}]}};
 f.scope.revision={workflow:'project-edit-v1',intentId:'oip-revision',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const before=structuredClone(f.parent),ctx=await f.call('plcdev_project_context');
 assert.deepEqual(ctx.editingInput.oipTools.scene,before.oipTools.scene);assert.deepEqual(ctx.editingInput.oipTools.tools,currentTools);assert.deepEqual(f.parent,before);
 assert.match(ctx.boundary,/do not prove physical simulation/);
 const plan={schemaVersion:1,changes:[{kind:'oip-tools',calls:[{name:'update_part',input:{id:'parent',name:'新名称'}}]}]};
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(plan)});
 assert.deepEqual(f.posts[0].body.planSubmission.plan,plan);assert.deepEqual(f.posts[0].body.revisionParent,f.scope.revision.parent);
 for(const key of ['nativeVersion','catalogDigest','contractVersion']){const original=f.source.oipTools[key];f.source.oipTools[key]='changed';await assert.rejects(f.call('plcdev_project_context'),/OIP 编辑工具版本已变化/);f.source.oipTools[key]=original;}
});
test('native task receipts expose OIP operations and checks without raw native payloads',async()=>{
 const f=fixture();f.task.candidate.components=[{tool:'oip',summary:'修改输送带',nativeVersion:'2026.11.9',operations:[{name:'update_part',summary:'重命名输送带',privatePath:'secret'}],checks:[{id:'scene',label:'场景结构',status:'passed'},{id:'bindings',label:'信号绑定',status:'warning',summary:'PLC 尚未连接',raw:{password:'secret'}}],raw:'secret'}];
 const result=await f.call('plcdev_task_status',{taskId:T});
 assert.equal(result.task.candidate.components[0].checks[1].status,'warning');assert.equal(result.task.candidate.components[0].operations[0].summary,'重命名输送带');assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('ordinary DSH forwards the native catalog and ordered POU variable ladder plan unchanged',async()=>{
 const f=fixture();
 const nativeCatalog={contractVersion:1,tools:[{name:'write_ladder',description:'Native bounded ladder operation',input_schema:{type:'object',properties:{nativeOnly:{type:'boolean'}}}}],project:{pous:[{name:'main',language:'ld'}]}};
 f.source.openplcTools=nativeCatalog;
 const ctx=await f.call('plcdev_project_context');assert.deepEqual(ctx.editingInput.openplcTools,nativeCatalog);
 assert.match(ctx.boundary,/same editing tools/);
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(sharedPlan())});
 assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].body.planSubmission.plan,sharedPlan());
 assert.equal(f.posts[0].body.request,f.scope.userRequest);assert.equal(f.exec.concluded,true);
 const request={...f.posts[0].body};assert.deepEqual(recoverConversationRequest(request,'chat'),request);
});
test('shared editing revision uses the parent native project state after a model change',async()=>{
 const f=fixture();f.source.openplcTools={contractVersion:1,tools:[],project:{pous:[{name:'main'}]}};
 f.parent.openplcTools={contractVersion:1,tools:[],project:{pous:[{name:'main'},{name:'DelayLogic'}]}};
 f.scope.route={provider:'deepseek-official',model:'deepseek-flash'};
 f.scope.revision={workflow:'project-edit-v1',intentId:'shared-revision',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const ctx=await f.call('plcdev_project_context');assert.deepEqual(ctx.editingInput.openplcTools,f.parent.openplcTools);
 const next={schemaVersion:1,changes:[{kind:'openplc-tools',calls:[{name:'update_variable',input:{pouName:'DelayLogic',currentName:'Enable',initialValue:'TRUE'}}]}]};
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(next)});
 assert.deepEqual(f.posts[0].body.planSubmission,{schemaVersion:1,plan:next,route:f.scope.route});
 assert.deepEqual(f.posts[0].body.revisionParent,f.scope.revision.parent);assert.equal(f.posts[0].body.revisionIntentId,'shared-revision');
});
test('a shared revision refreshes trusted tool schemas without replacing or mutating parent project state',async()=>{
 const f=fixture();
 const currentTools=[{name:'write_ladder',description:'Current executor contract',input_schema:{type:'object',properties:{pouName:{type:'string'}},required:['pouName']}}];
 const storedTools=[{name:'write_ladder',description:'Outdated contract',input_schema:{type:'object',properties:{obsolete:{type:'boolean'}}}},{name:'invented_shell_tool',description:'Not registered by the executor',input_schema:{type:'object'}}];
 f.source.openplcTools={contractVersion:1,tools:currentTools,project:{pous:[{name:'main',body:{language:'st',value:'source body'}}]}};
 f.parent.openplcTools={contractVersion:1,tools:storedTools,project:{pous:[{name:'main',body:{language:'st',value:'parent body'}},{name:'DelayLogic',body:{language:'ld',value:{rungs:[]}}}]}};
 f.scope.revision={workflow:'project-edit-v1',intentId:'catalog-refresh',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const parentBefore=structuredClone(f.parent),sourceBefore=structuredClone(f.source);
 const ctx=await f.call('plcdev_project_context');
 assert.deepEqual(ctx.editingInput.openplcTools.tools,currentTools);
 assert.equal(ctx.editingInput.openplcTools.tools.some(tool=>tool.name==='invented_shell_tool'),false);
 assert.deepEqual(ctx.editingInput.openplcTools.project,parentBefore.openplcTools.project);
 assert.equal(ctx.editingInput.projectRevision,D);assert.deepEqual(ctx.editingInput.plcSources,parentBefore.plcSources);
 assert.deepEqual(f.parent,parentBefore,'Refreshing documentation must not rewrite the stored parent evidence');
 assert.deepEqual(f.source,sourceBefore,'Reading a revision must not alter source context');
});
test('unavailable shared editing exposes its reason while retaining HMI targets and owned tasks',async()=>{
 const f=fixture();f.listing.capabilities={projectEditCandidate:false,hmiViewNameCandidate:true,hmiStaticTextCandidate:true};
 f.listing.editingInput=null;
 f.listing.editingUnavailable={code:'not_ready',message:'OpenPLC 共享编辑工具构建依赖不可用。'};
 f.listing.hmiViews=[{id:'view-1',name:'操作画面'}];
 f.listing.hmiTextTargets=[{viewId:'view-1',elementId:'PLCD_label',text:'就绪'}];
 const ctx=await f.call('plcdev_project_context');
 assert.equal(ctx.ok,true);assert.equal(ctx.projectEditCandidate,false);assert.equal(ctx.editingInput,null);
 assert.deepEqual(ctx.editingUnavailable,f.listing.editingUnavailable);
 assert.equal(ctx.hmiViewNameCandidate,true);assert.deepEqual(ctx.hmiViews,f.listing.hmiViews);
 assert.equal(ctx.hmiStaticTextCandidate,true);assert.deepEqual(ctx.hmiTextTargets,f.listing.hmiTextTargets);
 assert.deepEqual(ctx.tasks.map(task=>task.taskId),[T]);
 await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(sharedPlan())}),/没有已接入/);
 assert.equal(f.posts.length,0,'An unavailable capability must not submit a candidate');
});
test('ordinary model reads source then proposes original user intent without a second model',async()=>{
 const f=fixture(),ctx=await f.call('plcdev_project_context');
 assert.equal(ctx.projectEditCandidate,true);assert.deepEqual(ctx.editingInput,f.source);
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(plan())});
 assert.equal(f.posts.length,1);const post=f.posts[0];assert.equal(post.path,'/api/plcdev/conversations/tasks');
 assert.equal(post.body.workflow,'project-edit-v1');assert.equal(post.body.request,f.scope.userRequest);assert.equal(post.body.sourceBasis,'saved_revision');
 assert.deepEqual(post.body.planSubmission.plan,plan());assert.equal(f.exec.concluded,true);
 await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(plan()),parentTaskId:T}),/参数无效/);
 f.binding.version++;await assert.rejects(f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(plan())}),/已变化/);
 assert.equal(f.posts.length,1);
});
test('selected project revision reads parent sources and publishes exact parent identity',async()=>{
 const f=fixture();f.scope.revision={workflow:'project-edit-v1',intentId:'revision-1',expectedRevision:R,parent:{taskId:T,candidateDigest:D}};
 const ctx=await f.call('plcdev_project_context');assert.deepEqual(ctx.editingInput,f.parent);
 const next=plan();next.changes[0].expectedHash=D;
 await f.call('plcdev_propose_project_edit',{contextToken:ctx.contextToken,planJson:JSON.stringify(next)});
 assert.deepEqual(f.posts[0].body.revisionParent,f.scope.revision.parent);assert.equal(f.posts[0].body.revisionIntentId,'revision-1');
 f.task.candidate.editingInput.projectRevision=R;await assert.rejects(f.call('plcdev_project_context'),/父候选内容/);
 f.task.candidate.editingInput.projectRevision=D;f.binding.taskRefs=[];await assert.rejects(f.call('plcdev_project_context'),/父候选内容/);
});
test('compile tool never keeps or runs and uses retained revision rather than source revision',async()=>{
 const f=fixture(),ctx=await f.call('plcdev_project_context'),args={contextToken:ctx.contextToken,taskId:T};
 await assert.rejects(f.call('plcdev_validate_candidate',args),/先在结果卡/);assert.equal(f.posts.length,0);
 f.task.status='kept';f.task.retention={projectId:P,revision:KR};
 await assert.rejects(f.call('plcdev_validate_candidate',args),/先在结果卡/);assert.equal(f.posts.length,0);
 f.task.retention.keptProjectId=K;
 const keptContext=await f.call('plcdev_project_context');assert.equal(keptContext.tasks[0].keptProjectId,K);assert.match(keptContext.boundary,/NOT automatically rebound/);
 const result=await f.call('plcdev_validate_candidate',args);assert.equal(result.task.status,'compiling');assert.equal(f.exec.concluded,undefined);
 assert.deepEqual(f.posts[0].body,{conversationId:'chat',projectId:P,taskId:T,candidateDigest:D,expectedRevision:KR,action:'compile',clientRequestId:f.posts[0].body.clientRequestId});
 assert.match(f.posts[0].body.clientRequestId,/^native-compile-[a-f0-9]{64}$/);assert.equal(f.posts[0].path,'/api/plcdev/conversations/review');
 assert.equal(f.tools.find(t=>t.name==='plcdev_validate_candidate').isConcurrencySafe(),false);
 f.binding.taskRefs=[];await assert.rejects(f.call('plcdev_validate_candidate',args),/不属于/);
});
test('review/recovery support integrated changes without weakening old workflows',()=>{
 const f=fixture(),changes=[{path:'interface.json',beforeSha256:null,afterSha256:R},{path:'old.st',beforeSha256:R,afterSha256:null}];
 assert.deepEqual(candidateChanges({...f.task,candidate:{changes}}),changes);
 assert.equal(candidateChanges({...f.task,workflow:'joint-ai-v1',candidate:{changes}}),null);
 assert.equal(candidateChanges({...f.task,candidate:{changes:[{path:'x',beforeSha256:null,afterSha256:null}]}}),null);
 assert.equal(reviewActionRequest('chat',f.task,{projectId:P,taskId:T},'keep','review-1').action,'keep');
 const request={conversationId:'chat',projectId:P,expectedVersion:1,request:'改进程序',expectedRevision:R,sourceBasis:'saved_revision',executionScope:'proposal',clientRequestId:'p1',workflow:'project-edit-v1',planSubmission:{schemaVersion:1,plan:plan(),route:{provider:'a',model:'b'}}};
 assert.deepEqual(recoverConversationRequest(request,'chat'),request);
 assert.equal(recoverConversationRequest({...request,planSubmission:{...request.planSubmission,plan:{command:'x'}}},'chat'),null);
 assert.equal(artifactRows({...f.task,candidate:{components:[{tool:'fuxa',summary:'画面改名'},{tool:'fuxa',summary:'新增只读显示'}]}})[1].summary,'画面改名；新增只读显示');
});
