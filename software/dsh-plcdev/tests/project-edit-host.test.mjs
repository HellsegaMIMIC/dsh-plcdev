// Actual DSH agent/executor, SQLite conversations, Python TaskService and native
// candidate files. Local scripted model only. Compiler defaults to a fixture;
// PLCDEV_DSH_NATIVE_COMPILE=1 runs the actual isolated compile-only CLI.
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
import {createNativeTools,TOOL_NAMES} from '../src/native-tools.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {createEditorBridge} from '../src/editor-bridge.mjs';
import {nativeSessionHost} from './helpers/editor-native-session.mjs';
import {fixturePython} from './helpers/fixture-python.mjs';
import {ContextReadPlanner} from './helpers/context-read-planner.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const host=process.env.PLCDEV_DSH_TEST_HOST_PACKAGE?path.resolve(process.env.PLCDEV_DSH_TEST_HOST_PACKAGE):path.join(root,'.tools/dsh-host/package.json');
const python=fixturePython(root);
const missing=[host,python,path.join(root,'software/project-interface-demo/project.plcdev')].filter(p=>!existsSync(p));

let controllerAvailable=false,controllerVersion='not extracted';try{
 const r=createRequire(host),entry=r.resolve('@deepseek-ai/dsh-api-session-controller');
 controllerVersion=r(path.join(path.dirname(entry),'..','package.json')).version;
 // The old 0.2.1 test fixture has a different model-selection contract. This
 // integration proves the installed 0.2.2 API, not an invented compatibility
 // adapter or a synthetic selection for that earlier host.
 controllerAvailable=/^0\.2\.2(?:-|$)/.test(controllerVersion);
}catch{}
for(const {shared,editor} of [{shared:false},{shared:true},{shared:true,editor:true}])test(`actual DSH ordinary model ${editor?'receives OpenPLC bridge input through native sessionController.prompt, ':''}${shared?'uses shared OpenPLC POU variable and ladder tools':'edits legacy ST'}, revises across models, keeps and compiles through one task chain`,
 {skip:missing.length?`Local integration prerequisites missing: ${missing.join(', ')}`:editor&&!controllerAvailable?`OpenPLC session bridge integration requires verified DSH 0.2.2 API; fixture reports ${controllerVersion}`:false,timeout:360000},async t=>{
 const require=createRequire(host),load=async n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)).href);
 const {Context}=await load('cordis'),{default:Sessions}=await load('dsh-session'),{default:Projections}=await load('dsh-session-projection');
 const {default:Agents,installModelSelection}=await load('dsh-agent'),{default:Llm,LlmAdapter,createUserMessage}=await load('dsh-llm');
 const {default:SystemPrompt}=await load('dsh-system-prompt'),{default:Tools}=await load('dsh-tools'),{default:AgentLoop}=await load('dsh-agent-loop');
 const dir=await mkdtemp(path.join(tmpdir(),'plcdev-project-edit-host-'));
 const child=spawn(python,['-B','-X','utf8','-u',path.join(root,'tools/test_dsh_project_edit_backend.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=[];let stderr='',ctx,handle,editorApi,editorGrant,editorHost;
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;try{const r=JSON.parse(line);r.ok?p.resolve(r.result):p.reject(new Error(r.error));}catch(e){p.reject(e);}});
 child.on('exit',code=>{for(const p of pending.splice(0))p.reject(new Error(`fixture exited ${code}: ${stderr}`));});
 const rpc=data=>new Promise((resolve,reject)=>{if(child.exitCode!==null)return reject(new Error(`fixture exited: ${stderr}`));pending.push({resolve,reject});child.stdin.write(JSON.stringify(data)+'\n');});
 try{
  const data=await rpc({op:'init'}),id='project-edit-host-chat';assert.equal(data.schemaVersion,1);
  const bridge={async handle(method,url,body){
   if(method==='POST')return {status:202,body:{ok:true,...await rpc({op:url.endsWith('/review')?'review':'create',body})}};
   if(url.includes('/status'))return {status:200,body:{project:{id:data.projectId,name:'新建会话工程'},projects:[{id:data.projectId}]}};
   return {status:200,body:await rpc({op:'context'})};
  }};
  if(editor){
   bridge.editorPrepare=async()=>({ok:true,launchId:'editor-'+'a'.repeat(32),sourceProjectId:data.projectId,...await rpc({op:'current'}),mode:'project',projectName:'新建会话工程'});
   bridge.editorOpen=async({connection})=>{editorGrant=editorApi.authenticate({headers:{authorization:'Bearer '+connection.token}});return {ok:true,state:'requested'};};
  }
  const options={controllerFile:path.join(dir,'controller.json'),bridge};let conversations=createConversationRoutes(options);
  assert.equal((await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:id,projectId:data.projectId,expectedVersion:0})).status,200);
  const selection={current:{provider:'deepseek-account',model:'deepseek-flash'}};
  let phase=0,mode='first',compileTask,authority,readPlanner=new ContextReadPlanner(),fixtureCall=0;const seen=[];
  class Scripted extends LlmAdapter{
   async *stream(o){
    seen.push({provider:o.provider,tools:o.tools.map(t=>t.name),mode});
    if(phase>=2){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'已返回真实任务结果。'};yield {type:'block-end',index:0,block:{type:'text',text:'已返回真实任务结果。'}};yield {type:'finish',reason:{kind:'stop'}};return;}
    let name,args;
    if(phase===0){phase=1;name='plcdev_project_context';args={};}
    else {
     const last=[...o.messages].reverse().find(m=>m.role==='tool');
     const read=readPlanner.accept(JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join('')));
     if(read){name=read.name;args=read.args;}
     else {phase=2;const context=readPlanner.value;
     assert.equal(context.projectEditCandidate,true);assert.equal(context.projectId,data.projectId);
     if(mode==='compile'){name='plcdev_validate_candidate';args={contextToken:context.contextToken,taskId:compileTask.taskId};}
     else {
      const source=context.editingInput.plcSources.find(s=>s.content.includes('SpeedSetpoint : INT := '));assert.ok(source,'Actual ST source must reach the ordinary model');
      let changes;
      if(shared){
       const native=context.editingInput.openplcTools;assert.equal(native?.contractVersion,1);assert.ok(native.project);
       for(const name of ['create_pou','update_pou_body','create_variable','update_variable','delete_variable','write_ladder'])assert.ok(native.tools.some(tool=>tool.name===name&&tool.input_schema),'Native schema missing: '+name);
       const main=context.editingInput.plcConfiguration.resource.instances[0].program;
       const calls=[{name:'update_variable',input:{pouName:main,currentName:'SpeedSetpoint',initialValue:mode==='first'?'45':'60'}}];
       if(mode==='first')calls.push(
        {name:'create_pou',input:{name:'ScaleSpeed',type:'function',language:'st',returnType:'INT'}},
        {name:'create_variable',input:{pouName:'ScaleSpeed',name:'InValue',class:'input',type:'INT'}},
        {name:'create_variable',input:{pouName:'ScaleSpeed',name:'Scratch',type:'INT'}},
        {name:'update_pou_body',input:{pouName:'ScaleSpeed',code:'ScaleSpeed := InValue * 2;'}},
       );
       else calls.push({name:'delete_variable',input:{pouName:'ScaleSpeed',variableName:'Scratch'}});
       calls.push({name:'write_ladder',input:{pouName:'StartRelay',pouType:'function-block',variables:[{name:'Request',class:'input',type:'BOOL'},{name:'Running',class:'output',type:'BOOL'}],rungs:[{series:[{variable:'Request',negated:mode!=='first'}],coil:'Running'}]}});
       if(mode==='first'){
        const body=native.project.pous.find(p=>p.name===main)?.body?.value;assert.equal(typeof body,'string','Native context must expose the configured program body');
        calls.push(
         {name:'create_variable',input:{pouName:main,name:'ScaleResult',type:'INT'}},
         {name:'create_variable',input:{pouName:main,name:'RelayInstance',type:'StartRelay'}},
         {name:'create_variable',input:{pouName:main,name:'RelayRunning',type:'BOOL'}},
         {name:'update_pou_body',input:{pouName:main,code:body+'\nScaleResult := ScaleSpeed(InValue := SpeedSetpoint);\nRelayInstance(Request := TRUE);\nRelayRunning := RelayInstance.Running;'}},
        );
       }
       changes=[{kind:'openplc-tools',calls}];
      }else{
       const content=source.content.replace(`SpeedSetpoint : INT := ${mode==='first'?'30':'45'}`,`SpeedSetpoint : INT := ${mode==='first'?'45':'60'}`);assert.notEqual(content,source.content);
       changes=[{kind:'plc-source',path:source.path,expectedHash:source.sha256,content}];
      }
      if(mode==='first'){
       assert.equal(context.editingInput.interfaceDefinition,null);assert.ok(context.editingInput.interfaceTemplate,'New projects must provide the interface contract to the model');
       const instance=context.editingInput.plcConfiguration.resource.instances[0].name;
       changes.push({kind:'interface',definition:{schemaVersion:1,protocol:'project-interface-v1',title:'风机调速',variables:[{id:'speed',label:'速度设定',path:instance+'.SpeedSetpoint',type:'INT',access:'read',aiVisible:true}],operations:[]}});
      }
      else {assert.equal(context.revision.workflow,'project-edit-v1');assert.equal(context.editingInput.projectRevision,context.revision.parent.candidateDigest);changes.push({kind:'hmi-view-name',viewId:context.editingInput.hmiTargets.views[0].id,name:'接续修改的风机画面'});}
      name='plcdev_propose_project_edit';args={contextToken:context.contextToken,planJson:JSON.stringify({schemaVersion:1,changes})};
     }
     }
    }
    const callId=`offline-${mode}-${++fixtureCall}`;
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:JSON.stringify(args)};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}};yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  async function start(seed){
   ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(Agents);await ctx.plugin(Llm);await ctx.plugin(SystemPrompt,{});
   let executor;try{executor=require.resolve('@deepseek-ai/dsh-tool-executor-native');}catch{}
   if(executor){await ctx.plugin(Tools,{});await ctx.plugin(await import(pathToFileURL(executor).href),{});}else await ctx.plugin(Tools,{mode:'native'});
   await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
   authority=createProjectContext({ctx,conversations});for(const tool of createNativeTools({bridge,conversations,projectContext:authority}))ctx.tools.register(tool,authority.toolRegistrationOptions);
   ctx.llm.registerAdapter(['deepseek-account','deepseek-official'],new Scripted());
   handle=await ctx.agents.create({sessionId:id,seed,...(editor?{meta:{cwd:dir}}:{}),agentOptions:selection.current,setup:c=>{installModelSelection(c,selection);}});
   if(handle.agent.model?.select)handle.agent.model.select(selection.current);
   if(editor){
    editorHost=await nativeSessionHost({require,ctx,agent:handle.agent,dir});
    editorApi?.dispose();editorApi=createEditorBridge({...options,conversations,getHost:()=>editorHost,getOrigin:()=> 'http://127.0.0.1:3200'});
    ctx.on('agent/assistant-stream',payload=>editorApi.stream(payload));
    const opened=await editorApi.handle('POST','/api/plcdev/conversations/editor-open',{conversationId:id,projectId:data.projectId,target:'project'});assert.equal(opened.status,200,JSON.stringify(opened));
    const loaded=await editorApi.native('POST','/loaded',{launchId:editorGrant.launchId,nativeProjectPath:editorGrant.nativeProjectPath,dirty:false},editorGrant);assert.equal(loaded.status,200,JSON.stringify(loaded));
   }
  }
  async function send(text){phase=0;readPlanner=new ContextReadPlanner();
   if(editor){
    const before=editorHost.promptCalls,request={requestId:'editor-'+mode,text};
    const sent=await editorApi.native('POST','/submit',request,editorGrant);assert.equal(sent.body.state,'accepted',JSON.stringify(sent));
    const repeat=await editorApi.native('POST','/submit',request,editorGrant);assert.equal(repeat.body.messageId,sent.body.messageId);assert.equal(editorHost.promptCalls,before+1);
   }else handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));
   await handle.agent.whenIdle();assert.equal(authority.size(),0);
   if(editor){const state=await editorApi.native('GET','/state',null,editorGrant);assert.equal(state.status,200,JSON.stringify(state));assert.equal(state.body.conversation.id,id);assert.ok(state.body.messages.some(m=>m.role==='user'&&m.text===text));assert.ok(!state.body.messages.some(m=>m.text.includes('Current runtime context.')));}
  }
  await start();await send('将新工程默认速度设为45，并添加变量声明与HMI。');
  let tasks=await rpc({op:'list'});assert.equal(tasks.length,1,JSON.stringify(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').map(e=>e.data.reason)));const first=tasks[0];assert.equal(first.status,'awaiting_review',JSON.stringify(first));assert.equal(first.workflow,'project-edit-v1');
  assert.ok(first.candidate.editingInput.plcSources.some(s=>s.content.includes('SpeedSetpoint : INT := 45')));
  assert.ok(first.candidate.editingInput.hmiTargets.views.length);assert.ok(first.candidate.changes.some(c=>c.beforeSha256===null));
  if(editor){const mirrored=(await editorApi.native('GET','/state',null,editorGrant)).body;assert.equal(mirrored.tasks[0].taskId,first.taskId);assert.equal(mirrored.tasks[0].candidateDigest,first.candidate.candidateDigest);assert.ok(mirrored.tasks[0].changedFiles.some(p=>p.endsWith('/ScaleSpeed.st')));}
  if(shared){assert.ok(first.candidate.changes.some(c=>c.path.endsWith('/ScaleSpeed.st')&&c.beforeSha256===null));assert.ok(first.candidate.changes.some(c=>c.path.endsWith('/StartRelay.ld')&&c.beforeSha256===null));assert.ok(first.candidate.editingInput.plcSources.some(s=>s.path.endsWith('/ScaleSpeed.st')&&s.content.includes('Scratch')));}
  const armed=await conversations.handle('POST','/api/plcdev/conversations/revision',{conversationId:id,projectId:data.projectId,taskId:first.taskId,candidateDigest:first.candidate.candidateDigest,expectedRevision:data.revision,expectedVersion:1,intentId:'project-edit-revision'});assert.equal(armed.status,200,JSON.stringify(armed.body));
  const seed=JSON.parse(JSON.stringify(handle.agent.session.snapshotEvents()));await handle.dispose();await ctx.fiber.dispose();handle=null;ctx=null;
  conversations=createConversationRoutes(options);assert.equal((await rpc({op:'reopen'})).sourceUnchanged,true);
  selection.current={provider:'deepseek-official',model:'deepseek-flash'};mode='revision';await start(seed);await send('接着把速度改成60，将画面改名为接续修改的风机画面。');
  tasks=await rpc({op:'list'});const second=tasks.find(task=>task.parentTaskId===first.taskId);assert.equal(second?.status,'awaiting_review',JSON.stringify(tasks));assert.equal(tasks.find(task=>task.taskId===first.taskId).status,'superseded');
  assert.ok(second.candidate.editingInput.plcSources.some(s=>s.content.includes('SpeedSetpoint : INT := 60')));assert.equal(second.candidate.editingInput.hmiTargets.views[0].name,'接续修改的风机画面');
  if(shared){const fn=second.candidate.editingInput.plcSources.find(s=>s.path.endsWith('/ScaleSpeed.st'));assert.ok(fn?.content.includes('ScaleSpeed := InValue * 2;'));assert.ok(!fn.content.includes('Scratch'));assert.ok(second.candidate.changes.some(c=>c.path.endsWith('/StartRelay.ld')&&c.beforeSha256===null));}
  const kept=await conversations.handle('POST','/api/plcdev/conversations/review',{conversationId:id,projectId:data.projectId,taskId:second.taskId,candidateDigest:second.candidate.candidateDigest,expectedRevision:data.revision,action:'keep',clientRequestId:'host-user-keep'});
  assert.equal(kept.body.task?.status,'kept',JSON.stringify(kept));assert.equal(kept.body.task.retention.keptProjectId,data.projectId);
  assert.equal(kept.body.task.retention.completionScope,'saved-project-version');assert.equal(kept.body.task.retention.version,2);
  if(editor){
   const stale=await editorApi.native('POST','/submit',{requestId:'stale-after-keep',text:'编译验证新版本'},editorGrant);
   assert.equal(stale.body.state,'rejected','Old native window must not claim that it loaded the newly saved version');
   const opened=await editorApi.handle('POST','/api/plcdev/conversations/editor-open',{conversationId:id,projectId:data.projectId,target:'project'});
   assert.equal(opened.status,200,JSON.stringify(opened));
   assert.equal(editorGrant.revision,kept.body.task.retention.revision);
   const loaded=await editorApi.native('POST','/loaded',{launchId:editorGrant.launchId,nativeProjectPath:editorGrant.nativeProjectPath,dirty:false},editorGrant);
   assert.equal(loaded.status,200,JSON.stringify(loaded));
  }
  compileTask=kept.body.task;mode='compile';await send('编译验证刚才保留的工程版本。');
  const check=await rpc({op:'check'}),compiled=check.tasks.find(task=>task.taskId===second.taskId);
  assert.equal(compiled.status,'compiled',JSON.stringify(compiled));assert.equal(compiled.compilation.completionScope,'compile-only');assert.equal(compiled.compilation.uploaded,false);assert.equal(compiled.compilation.runtimeStarted,false);assert.equal(check.sourceUnchanged,false);assert.equal(check.oldResourcesUnchanged,true);
  assert.ok(seen.every(request=>TOOL_NAMES.every(name=>request.tools.includes(name))));assert.deepEqual([...new Set(seen.map(request=>request.provider))],['deepseek-account','deepseek-official']);
  t.diagnostic(JSON.stringify({hostPackage:host,editorBridge:!!editor,...(editor?{sessionControllerSourceHash:editorHost.sourceHash}:{}),sharedOpenPLC:shared,nativeCompiler:data.nativeCompiler,sourceUnchanged:check.sourceUnchanged,sourceProjectId:data.projectId,keptProjectId:compiled.retention.keptProjectId,taskCount:check.tasks.length,checks:compiled.compilation.checks,externalModelCalls:0,runtimeStarted:false}));
 }finally{
  editorApi?.dispose();
  if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
  assert.ok(dir.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(dir).startsWith('plcdev-project-edit-host-'));await rm(dir,{recursive:true,force:true});
 }
});
