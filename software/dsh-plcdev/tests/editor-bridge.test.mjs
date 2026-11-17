import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createEditorBridge,editorMessages} from '../src/editor-bridge.mjs';
import {createConversationRoutes} from '../src/conversations.mjs';
import {createProjectContext} from '../src/project-context.mjs';
import {editorOpenNotice,readEditorObservation} from '../src/client/result-flow.mjs';

const PID='user-source',KEPT='user-kept',TASK='task-'+'a'.repeat(32),DIGEST='b'.repeat(64),REV='c'.repeat(64),KREV='d'.repeat(64);
async function fixture(t,{seed=true}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'plcdev-editor-bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const projects=new Map([[PID,{id:PID,name:'Source',revision:REV}],[KEPT,{id:KEPT,name:'Source · AI副本',revision:KREV}]]),sessions=new Map(),tasks=new Map([[PID,[]],[KEPT,[]]]),workspaces=new Map();
  const calls={prompt:0,create:0,cancel:0,open:[],prepare:[],select:[]};let time=100000,launch=0,flush=true,promptEffect=true,promptThrow=false;
  function addSession(id,cwd=dir){const s={id,header:{id,createdAt:1,cwd},events:[{seq:0,type:'model/selection',data:{provider:'deepseek-account',model:'deepseek-flash'}}],snapshotEvents(){return this.events;}};sessions.set(id,s);return s;}
  addSession('source-chat');
  const agents=new Map([...sessions].map(([id,session])=>[id,{session,status:'idle'}]));
  const host={agents:{get:id=>agents.get(id)},sessions:{get:id=>sessions.get(id),flush:async()=>flush},sessionProjections:{stateOf:()=>null},
    workspaceRegistry:{create:async(cwd,title)=>{
      let workspace=[...workspaces.values()].find(w=>w.path===cwd);if(!workspace){workspace={id:'workspace-'+workspaces.size,path:cwd,title,sessionIds:[],async attachSession(id){assert.equal(sessions.get(id).header.cwd,cwd);if(!this.sessionIds.includes(id))this.sessionIds.push(id);}};workspaces.set(workspace.id,workspace);}return workspace;
    }},
    sessionQuery:{readSession:async id=>{if(!sessions.has(id))throw Object.assign(Error('not found'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'});const s=sessions.get(id);return {session:s.header,events:structuredClone(s.events)};}},
    sessionPersistence:{open:async id=>({header:sessions.get(id).header,read:async()=>({events:structuredClone(sessions.get(id).events)}),close:async()=>{}})},
    sessionController:{create:async req=>{calls.create++;const s=addSession(req.sessionId,req.workspaceId?workspaces.get(req.workspaceId).path:req.cwd);agents.set(req.sessionId,{session:s,status:'idle'});if(req.workspaceId)await workspaces.get(req.workspaceId).attachSession(req.sessionId);return {sessionId:req.sessionId};},
      selectModel:async req=>{calls.select.push(req);sessions.get(req.sessionId).events.push({type:'model/selection',data:{provider:req.provider,model:req.model}});},rename:async()=>{},
      resolveAgent:async id=>({agent:agents.get(id)}),
      prompt:async req=>{calls.prompt++;if(promptEffect){const s=sessions.get(req.sessionId),message={id:'message-'+calls.prompt,source:{kind:'user',rpcId:req.requestId},content:req.content};s.events.push({type:'agent/inbox/spliced',data:{inserted:[message]}},{type:'user/message',data:message},{type:'assistant/message',data:{turn:1,message:{id:'assistant-'+calls.prompt,content:[{type:'text',text:'已生成修改'}]}}});}if(promptThrow)throw Error('reply lost');return {accepted:true};},
      cancel:()=>{calls.cancel++;return {accepted:true};}}};
  const controllerFile=path.join(dir,'controller.json');
  const bridge={async handle(method,url,body){const parsed=new URL(url,'http://localhost'),p=parsed.searchParams.get('project');
    if(parsed.pathname.endsWith('/status'))return {status:200,body:{project:projects.get(p),projects:[...projects.values()]}};
    if(['/tasks','/task-state'].some(s=>parsed.pathname.endsWith(s)))return {status:200,body:{projectId:p,projectRevision:projects.get(p).revision,tasks:tasks.get(p)}};
    throw Error('unexpected '+method+' '+url);},
    async editorPrepare(body){calls.prepare.push(body);const actual=body.target==='retained'?KEPT:body.projectId;return {ok:true,launchId:'editor-'+String(++launch).padStart(32,'0'),sourceProjectId:body.projectId,projectId:actual,nativeProjectPath:path.join(dir,actual,'project.json'),revision:projects.get(actual).revision,mode:body.target==='candidate'?'preview':'project',projectName:projects.get(actual).name};},
    async editorVerifyPrepared(body){return {ok:true,...body};},
    async editorOpen(body){calls.open.push(body);return {ok:true,launchId:body.launchId,projectId:body.connection.projectId,nativeProjectPath:body.connection.nativeProjectPath,state:'requested'};},
    async candidatePreview(body){return {ok:true,...body,files:[]};}};
  const conversations=createConversationRoutes({controllerFile,bridge});
  assert.equal((await conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'source-chat',projectId:PID,expectedVersion:0})).status,200);
  const create=()=>createEditorBridge({controllerFile,bridge,conversations,getHost:()=>host,getOrigin:()=> 'http://127.0.0.1:3200',now:()=>time});
  let api=create();t.after(()=>api.dispose());
  const task={taskId:TASK,projectId:PID,status:'awaiting_review',workflow:'project-edit-v1',projectRevision:REV,request:'创建函数',candidate:{candidateDigest:DIGEST,revisionSupported:true,summary:{after:'新增 DoubleValue'},changes:[{path:'plc/pous/functions/DoubleValue.st'}]}};
  // Register a real native-task reference using the same persisted submission path.
  const oldHandle=bridge.handle;bridge.handle=async(method,url,body)=>method==='POST'&&url.endsWith('/tasks')?{status:202,body:{ok:true,task}}:oldHandle(method,url,body);
  if(seed){await conversations.handle('POST','/api/plcdev/conversations/tasks',{conversationId:'source-chat',projectId:PID,expectedVersion:1,request:'生成候选',expectedRevision:REV,executionScope:'proposal',clientRequestId:'seed',sourceBasis:'saved_revision'});
  tasks.get(PID).push(task);}
  async function open(target='project'){
    const result=await api.handle('POST','/api/plcdev/conversations/editor-open',{conversationId:'source-chat',projectId:PID,target,...(target!=='project'?{taskId:TASK,candidateDigest:DIGEST}:{})});
    assert.equal(result.status,200,JSON.stringify(result));const connection=calls.open.at(-1).connection,g=api.authenticate({headers:{authorization:'Bearer '+connection.token}});assert.ok(g);
    return {result,connection,g};
  }
  async function loaded(g){return api.native('POST','/loaded',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,dirty:false},g);}
  return {controllerFile,get api(){return api;},restart(){api.dispose();api=create();},open,loaded,bridge,host,calls,task,projects,tasks,sessions,agents,conversations,workspaces,
    setFlush:v=>flush=v,setEffect:v=>promptEffect=v,setThrow:v=>promptThrow=v,advance:n=>time+=n};
}

test('editor connects only exact project/session and waits for matching loaded acknowledgement',async t=>{
  const f=await fixture(t),{g,connection}=await f.open();
  assert.equal(f.api.authenticate({headers:{authorization:'Bearer '+'0'.repeat(64)}}),null);
  let state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.canSend,false);
  assert.equal((await f.api.native('POST','/loaded',{launchId:g.launchId,nativeProjectPath:path.join(path.dirname(g.nativeProjectPath),'wrong.json'),dirty:false},g)).status,409);
  assert.equal((await f.loaded(g)).body.state,'loaded');state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.canSend,true);
  assert.equal(state.conversation.id,'source-chat');assert.equal(state.conversation.model.provider,'deepseek-account');assert.equal(JSON.stringify(state).includes(connection.token),false);
  f.projects.get(PID).revision='e'.repeat(64);assert.equal((await f.api.native('GET','/state',null,g)).body.canSend,false);
  assert.equal((await f.loaded(g)).body.code,'revision_changed');
  assert.equal((await f.api.native('POST','/submit',{requestId:'msg',text:'修改'},g)).body.state,'rejected');assert.equal(f.calls.prompt,0);
});

test('FUXA and OIP result openings preserve task ownership without granting arbitrary tools or paths',async t=>{
 const f=await fixture(t),opened=[];
 f.bridge.resultResourceOpen=async body=>{opened.push(body);return {ok:true,...body,state:'opened'};};
 const request={conversationId:'source-chat',projectId:PID,taskId:TASK,candidateDigest:DIGEST,target:'candidate',tool:'fuxa'};
 assert.equal((await f.api.handle('POST','/api/plcdev/conversations/result-resource-open',request)).status,200);
 assert.equal(opened.length,1);assert.equal(opened[0].conversationId,undefined);
 for(const change of [{conversationId:'foreign-chat'},{projectId:KEPT},{candidateDigest:'f'.repeat(64)},{tool:'shell'},{nativeProjectPath:'C:/arbitrary'}]){
  const result=await f.api.handle('POST','/api/plcdev/conversations/result-resource-open',{...request,...change});assert.ok(result.status>=400,JSON.stringify(result));
 }
 assert.equal(opened.length,1);
});
test('OIP result status observes one owned launch without reopening or creating a preview',async t=>{
 const f=await fixture(t),observed=[];
 f.bridge.resultResourceOpen=async()=>{throw Error('Status must not reopen an editor');};
 f.bridge.resultResourceStatus=async body=>{observed.push(body);if(body.launchId!=='editor-'+'e'.repeat(32))throw Error('Foreign launch');return {ok:true,...body,observationRevision:REV,toolSync:{oip:{state:'pending_confirmation'}}};};
 const request={conversationId:'source-chat',projectId:PID,taskId:TASK,candidateDigest:DIGEST,target:'candidate',tool:'oip',launchId:'editor-'+'e'.repeat(32)};
 const result=await f.api.handle('POST','/api/plcdev/conversations/result-resource-status',request);
 assert.equal(result.status,200);assert.equal(result.body.toolSync.oip.state,'pending_confirmation');
 const {conversationId,...identity}=request;assert.deepEqual(observed,[identity]);assert.deepEqual(f.calls.open,[]);assert.deepEqual(f.calls.prepare,[]);
 for(const change of [{conversationId:'foreign-chat'},{projectId:KEPT},{taskId:'task-'+'f'.repeat(32)},{candidateDigest:'f'.repeat(64)},{launchId:'../private'},{launchId:'editor-short'},{tool:'fuxa'},{target:'source'},{nativeProjectPath:'F:/arbitrary'}]){
  const denied=await f.api.handle('POST','/api/plcdev/conversations/result-resource-status',{...request,...change});assert.ok(denied.status>=400,JSON.stringify(denied));
 }
 assert.equal(observed.length,1);
 const foreign=await f.api.handle('POST','/api/plcdev/conversations/result-resource-status',{...request,launchId:'editor-'+'f'.repeat(32)});assert.ok(foreign.status>=400);assert.equal(observed.length,2,'Valid-shaped foreign launches are checked against the backend launch record');
 assert.equal(f.calls.prompt,0);assert.deepEqual(f.calls.open,[]);assert.deepEqual(f.calls.prepare,[]);
});

test('editor prompt is one durable DSH message, repeated request only reconciles, candidate continuation is shared',async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);
  const sent=await f.api.native('POST','/submit',{requestId:'msg-1',text:'把函数改成乘以3'},g);
  assert.equal(sent.body.state,'accepted',JSON.stringify(sent));assert.equal(f.calls.prompt,1);
  assert.equal(f.conversations.snapshot('source-chat').revisionContext.parent.taskId,TASK);
  const repeat=await f.api.native('POST','/submit',{requestId:'msg-1',text:'把函数改成乘以3'},g);assert.equal(repeat.body.messageId,sent.body.messageId);assert.equal(f.calls.prompt,1);
  assert.equal((await f.api.native('POST','/submit',{requestId:'msg-1',text:'不同内容'},g)).status,409);
  const state=(await f.api.native('GET','/state',null,g)).body;assert.deepEqual(state.messages.map(m=>m.role),['user','assistant']);assert.equal(state.tasks[0].taskId,TASK);
});

test('unknown delivery survives bridge restart without second prompt, then reconciles durable evidence',async t=>{
  const f=await fixture(t);let {g}=await f.open();await f.loaded(g);f.setFlush(false);
  assert.equal((await f.api.native('POST','/submit',{requestId:'lost-reply',text:'修改函数'},g)).body.state,'unknown');assert.equal(f.calls.prompt,1);
  f.restart();({g}=await f.open());await f.loaded(g);
  assert.equal((await f.api.native('POST','/submit',{requestId:'lost-reply',text:'修改函数'},g)).body.state,'unknown');assert.equal(f.calls.prompt,1);
  f.setFlush(true);assert.equal((await f.api.native('POST','/submit',{requestId:'lost-reply',text:'修改函数'},g)).body.state,'accepted');assert.equal(f.calls.prompt,1);
});

test('transport exception after admission is reconciled without replay; missing evidence stays unknown',async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);f.setThrow(true);
  assert.equal((await f.api.native('POST','/submit',{requestId:'effect',text:'修改函数'},g)).body.state,'accepted');assert.equal(f.calls.prompt,1);
  f.setEffect(false);const v=await f.api.native('POST','/submit',{requestId:'no-evidence',text:'继续说明'},g);assert.equal(v.body.state,'unknown');
  assert.equal((await f.api.native('POST','/submit',{requestId:'no-evidence',text:'继续说明'},g)).body.state,'unknown');assert.equal(f.calls.prompt,2);
});

test('retained result opens actual kept project, creates one matched DSH continuation and preserves source',async t=>{
  const f=await fixture(t);f.task.status='kept';f.task.retention={keptProjectId:KEPT,revision:KREV};
  let {g,result}=await f.open('retained');await f.loaded(g);const session=g.sessionId;
  assert.notEqual(session,'source-chat');assert.equal(f.calls.create,1);assert.equal(f.calls.select[0].provider,'deepseek-account');
  assert.equal(result.body.projectId,KEPT);assert.equal(result.body.taskId,TASK);assert.equal(result.body.candidateDigest,DIGEST);
  assert.equal(f.conversations.snapshot(session).projectId,KEPT);assert.equal(f.conversations.snapshot('source-chat').projectId,PID);
  const state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.sourceConversation.id,'source-chat');assert.equal(state.tasks[0].origin,true);
  ({g}=await f.open('retained'));assert.equal(g.sessionId,session);assert.equal(f.calls.create,1);
  f.restart();({g}=await f.open('retained'));assert.equal(g.sessionId,session);assert.equal(f.calls.create,1);
});

test('candidate preview cannot submit or expose token in public open status',async t=>{
  const f=await fixture(t),{g,connection,result}=await f.open('candidate');await f.loaded(g);
  assert.equal(connection.canSend,false);assert.equal((await f.api.native('POST','/submit',{requestId:'msg',text:'修改'},g)).body.state,'rejected');assert.equal(f.calls.prompt,0);
  const status=await f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId=source-chat&launchId='+result.body.launchId);
  assert.equal(status.body.state,'loaded');assert.equal(JSON.stringify(status).includes(connection.token),false);
  assert.equal((await f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId=other&launchId='+g.launchId)).status,403);
});

test('an open native preview follows its exact source result into historical status without claiming a reload',async t=>{
  const f=await fixture(t),{g}=await f.open('candidate');await f.loaded(g);
  const state=async()=>(await f.api.native('GET','/state',null,g)).body;
  assert.deepEqual((await state()).editor.preview,{taskId:TASK,status:'awaiting_review',historical:false});
  f.tasks.get(PID).push({...f.task,taskId:'task-'+'f'.repeat(32),status:'kept'});
  for(const [status,notice] of [['discarded',/撤销前的历史预览.*未切回原工程/],['superseded',/已有后续修改.*历史预览/],['kept',/保留前的历史预览/],['compiled',/保留前的历史预览/]]){
    f.task.status=status;
    if(['kept','compiled'].includes(status)){f.task.retention={keptProjectId:PID,revision:KREV};f.projects.get(PID).revision=KREV;}
    const value=await state();assert.equal(value.canSend,false);assert.equal(value.editor.preview.taskId,TASK);assert.equal(value.editor.preview.status,status);assert.equal(value.editor.preview.historical,true);assert.match(value.blockedReason,notice);
    if(['kept','compiled'].includes(status))assert.equal(value.editor.preview.retainedProjectId,PID);
    assert.equal((await f.api.native('POST','/submit',{requestId:'stale-preview-'+status,text:'修改'},g)).body.state,'rejected');
  }
  f.task.candidate.candidateDigest='e'.repeat(64);
  const unknown=await state();assert.equal(unknown.editor.preview.status,'unverified');assert.match(unknown.blockedReason,/待核对/);
  assert.equal(f.calls.prompt,0);assert.equal(f.calls.open.length,1,'State inspection never opens or restores an editor');
});

test('actual nested observations distinguish candidate previews from saved projects and preserve historical notices',async t=>{
  const f=await fixture(t);f.advance(Date.now()-100000);const {g}=await f.open('candidate');await f.loaded(g);
  const observe=dirty=>f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,loaded:true,dirty},g);
  const visible=async()=>(await f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId=source-chat&launchId='+g.launchId)).body;
  let state=(await observe(false)).body;assert.equal(state.editor.observation.revisionMatches,true);assert.equal(state.canSend,false);
  let value=await visible();assert.equal(value.mode,'preview');assert.equal(value.editor.preview.status,'awaiting_review');
  assert.match(editorOpenNotice(value),/已加载候选预览/);assert.doesNotMatch(editorOpenNotice(value),/仍是旧版本|已加载对应版本/);
  await observe(true);assert.match(editorOpenNotice(await visible()),/候选预览有未保存调整/);
  for(const status of ['discarded','superseded','kept']){
    f.task.status=status;if(status==='kept'){f.task.retention={keptProjectId:PID,revision:KREV};f.projects.get(PID).revision=KREV;}
    value=await visible();assert.equal(value.editor.preview.historical,true);assert.equal(value.editor.preview.status,status);assert.equal(value.editor.observation.revisionMatches,false);
    assert.match(editorOpenNotice(value,status==='kept'),/历史预览/);assert.match(editorOpenNotice(value,status==='kept'),/未保存调整/);
    assert.doesNotMatch(editorOpenNotice(value,status==='kept'),/已加载对应版本|仍是旧版本/);
  }
  f.advance(6001);assert.match(editorOpenNotice(await visible(),true),/历史预览.*当前内容尚未确认/);
  assert.equal(f.calls.open.length,1);assert.equal(f.calls.prompt,0);
});

test('navigation has an owner lease and can reveal the source result from retained conversation',async t=>{
  const f=await fixture(t);f.task.status='kept';f.task.retention={keptProjectId:KEPT,revision:KREV};const {g}=await f.open('retained');
  const reveal=await f.api.native('POST','/reveal',{taskId:TASK},g);assert.equal(reveal.body.sessionId,'source-chat');
  const a=await f.api.handle('GET','/api/plcdev/conversations/editor-navigation?consumerId=window-a');assert.equal(a.body.navigation.taskId,TASK);
  assert.equal((await f.api.handle('GET','/api/plcdev/conversations/editor-navigation?consumerId=window-b')).body.navigation,null);
  assert.equal((await f.api.handle('POST','/api/plcdev/conversations/editor-navigation',{navigationId:reveal.body.navigationId,consumerId:'window-b'})).status,409);
  f.advance(10001);const b=await f.api.handle('GET','/api/plcdev/conversations/editor-navigation?consumerId=window-b');assert.equal(b.body.navigation.navigationId,reveal.body.navigationId);
  assert.equal((await f.api.handle('POST','/api/plcdev/conversations/editor-navigation',{navigationId:reveal.body.navigationId,consumerId:'window-b'})).body.ok,true);
});

test('cancel only cancels an editor-origin active request and state shows live stream without reasoning',async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);
  f.agents.get('source-chat').status='running';assert.equal((await f.api.native('POST','/cancel',{requestId:'cancel-1'},g)).status,409);assert.equal(f.calls.cancel,0);
  f.agents.get('source-chat').status='idle';await f.api.native('POST','/submit',{requestId:'send',text:'修改函数'},g);f.agents.get('source-chat').status='running';
  f.api.stream({agent:f.agents.get('source-chat'),frame:{type:'start',attemptId:'a',turn:2}});
  f.api.stream({agent:f.agents.get('source-chat'),frame:{type:'chunk',attemptId:'a',chunk:{type:'thinking-delta',text:'private'}}});
  f.api.stream({agent:f.agents.get('source-chat'),frame:{type:'chunk',attemptId:'a',chunk:{type:'text-delta',text:'正在修改'}}});
  const state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.canCancel,true);assert.equal(state.messages.at(-1).text,'正在修改');assert.equal(JSON.stringify(state).includes('private'),false);
  assert.equal((await f.api.native('POST','/cancel',{requestId:'cancel-2'},g)).body.accepted,true);assert.equal(f.calls.cancel,1);
});

test('controller spawn failure is visible independently of retained saving',async t=>{
  const f=await fixture(t);f.task.status='kept';f.task.retention={keptProjectId:KEPT,revision:KREV};const original=f.bridge.editorOpen;
  f.bridge.editorOpen=async body=>({...await original(body),state:'failed'});
  const {result}=await f.open('retained');assert.equal(result.body.state,'failed');assert.equal(result.body.projectId,KEPT);assert.ok(result.body.error);
});

test('message projection contains readable user/assistant text only',()=>{
  assert.deepEqual(editorMessages([{type:'turn/start',data:{turn:4}},{seq:1,type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'Hello'}]}},{seq:2,type:'assistant/message',data:{turn:4,message:{id:'a',content:[{type:'thinking',text:'hidden'},{type:'text',text:'World'},{type:'tool-call',name:'private'}]}}},{seq:3,type:'user/message',data:{id:'s',source:{kind:'system'},content:[{type:'text',text:'private context'}]}}]),[{id:'u',role:'user',text:'Hello',turn:4},{id:'a',role:'assistant',text:'World',turn:4}]);
});

test('fresh renderer observations expose dirty/path state without claiming reload or allowing writes',async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);
  const observe=change=>f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,loaded:true,dirty:false,...change},g);
  assert.equal((await observe({launchId:'another-launch'})).status,400);
  let state=(await observe({dirty:true})).body;
  assert.equal(state.canSend,false);assert.equal(state.editor.observation.state,'dirty');assert.equal(state.editor.observation.revisionMatches,true);
  const visible=(await f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId=source-chat&launchId='+g.launchId)).body;
  assert.equal(visible.state,'loaded','Loaded receipt remains distinct from a fresh draft observation');assert.equal(visible.editor.observation.dirty,true);
  assert.equal((await f.api.native('POST','/submit',{requestId:'dirty-send',text:'修改'},g)).body.state,'rejected');assert.equal(f.calls.prompt,0);
  state=(await observe({})).body;assert.equal(state.canSend,true);assert.equal(state.editor.observation.state,'clean');
  f.advance(6001);state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.canSend,false);assert.equal(state.editor.observation.state,'stale');
  assert.equal((await observe({nativeProjectPath:null,loaded:null,dirty:null})).body.editor.observation.state,'unknown');
  assert.equal((await observe({nativeProjectPath:path.join(path.dirname(g.nativeProjectPath),'other.json')})).body.editor.observation.state,'mismatch');
  assert.equal((await observe({loaded:false})).body.editor.observation.state,'not_loaded');
  assert.equal((await observe({})).body.canSend,true);assert.equal(f.calls.open.length,1);
});

test('a newly retained revision keeps old editor observation visible but blocks old-version submissions',async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);
  f.projects.get(PID).revision='e'.repeat(64);
  const state=(await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,loaded:true,dirty:true},g)).body;
  assert.equal(state.editor.observation.revisionMatches,false);assert.match(state.blockedReason,/未保存.*核对/);assert.equal(state.editor.sync.state,'blocked');assert.equal(state.canSend,false);
  assert.equal((await f.api.native('POST','/submit',{requestId:'old-version',text:'修改'},g)).body.state,'rejected');assert.equal(f.calls.prompt,0);
  const visible=(await f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId=source-chat&launchId='+g.launchId)).body;
  assert.equal(visible.editor.observation.revisionMatches,false);assert.equal(visible.editor.observation.dirty,true);assert.equal(f.calls.open.length,1);
});

test('same project hot sync advances one existing grant, confirms files and replays a lost acknowledgement without a second open',async t=>{
 const f=await fixture(t),{g,result}=await f.open();await f.loaded(g);
 const oldRevision=g.revision,oldPath=g.nativeProjectPath;
 await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:oldPath,loaded:true,dirty:false},g);
 f.projects.get(PID).revision='e'.repeat(64);
 const prepare=f.bridge.editorPrepare;f.bridge.editorPrepare=async input=>({...await prepare(input),nativeProjectPath:path.join(path.dirname(oldPath),'v2','project.json')});
 assert.equal((await f.api.native('GET','/state',null,g)).body.editor.sync.state,'available');
 const input={launchId:g.launchId,expectedRevision:oldRevision,nativeProjectPath:oldPath};
 const p=(await f.api.native('POST','/sync/prepare',input,g)).body;
 assert.equal(p.state,'prepared');assert.equal(p.fromRevision,oldRevision);assert.equal(p.fromNativeProjectPath,oldPath);
 assert.deepEqual((await f.api.native('POST','/sync/prepare',input,g)).body,p,'lost prepare response returns identical target');
 const complete={syncId:p.syncId,launchId:g.launchId,expectedRevision:oldRevision,revision:p.revision,nativeProjectPath:p.nativeProjectPath,loaded:true,dirty:false};
 assert.equal((await f.api.native('POST','/sync/complete',{...complete,nativeProjectPath:oldPath},g)).status,409);
 let verified=0;f.bridge.editorVerifyPrepared=async body=>{verified++;assert.equal(body.nativeProjectPath,p.nativeProjectPath);return {ok:true,...body};};
 // A third saved version can land while the second is loading. Acknowledge
 // the exact loaded second version, then advertise the third, not a false match.
 f.projects.get(PID).revision='f'.repeat(64);
 const ack=await f.api.native('POST','/sync/complete',complete,g);assert.equal(ack.status,200);assert.equal(g.revision,p.revision);assert.equal(verified,1);
 const replay=await f.api.native('POST','/sync/complete',Object.fromEntries(Object.entries(complete).reverse()),g);assert.equal(replay.status,200);assert.equal(verified,1);
 const state=(await f.api.native('GET','/state',null,g)).body;assert.equal(state.editor.sync.state,'available');assert.equal(state.editor.observation.revisionMatches,false);assert.equal(state.canSend,false);
 assert.equal(f.calls.open.length,1);assert.equal(f.calls.create,0);assert.equal(f.calls.prompt,0);assert.equal(g.sessionId,'source-chat');
 assert.deepEqual(ack.body.editor.synchronizedFrom,[{revision:oldRevision,nativeProjectPath:oldPath}]);
 f.projects.get(PID).revision=p.revision;
 assert.equal((await f.loaded(g)).status,200,'native path effect can repeat its loaded acknowledgement after sync');
 assert.deepEqual(g.editor.synchronizedFrom,[{revision:oldRevision,nativeProjectPath:oldPath}],'repeat loaded must preserve the old card path proof');
});

test('hot sync refuses dirty/unknown/preview/rebound connections and never adopts a failed target',async t=>{
 const f=await fixture(t),{g}=await f.open();await f.loaded(g);const revision=g.revision,nativeProjectPath=g.nativeProjectPath;
 f.projects.get(PID).revision='e'.repeat(64);const input={launchId:g.launchId,expectedRevision:revision,nativeProjectPath};
 for(const dirty of [true,null]){
  await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath,loaded:true,dirty},g);
  assert.equal((await f.api.native('POST','/sync/prepare',input,g)).status,409);
 }
 await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath,loaded:true,dirty:false},g);
 const p=(await f.api.native('POST','/sync/prepare',input,g)).body;
 const complete={syncId:p.syncId,launchId:g.launchId,expectedRevision:revision,revision:p.revision,nativeProjectPath:p.nativeProjectPath,loaded:true,dirty:false};
 f.bridge.editorVerifyPrepared=async()=>{throw Error('target changed');};
 assert.equal((await f.api.native('POST','/sync/complete',complete,g)).status,503);assert.equal(g.revision,revision);
 f.bridge.editorVerifyPrepared=async body=>body;
 const b=f.conversations.snapshot('source-chat');await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'source-chat',projectId:KEPT,expectedVersion:b.version});
 assert.equal((await f.api.native('POST','/sync/complete',complete,g)).status,409);assert.equal(g.revision,revision);
 const preview=await fixture(t),opened=await preview.open('candidate');
 assert.equal((await preview.api.native('POST','/sync/prepare',{launchId:opened.g.launchId,expectedRevision:opened.g.revision,nativeProjectPath:opened.g.nativeProjectPath},opened.g)).status,409);
});

test('continue without opening reuses retained mapping and inherits host agent/permission presets',async t=>{
 const f=await fixture(t);f.task.status='kept';f.task.retention={keptProjectId:KEPT,revision:KREV};
 f.sessions.get('source-chat').events.push({type:'agent-preset/selected',data:{agentPreset:'native'}},{type:'permission/preset',data:{preset:'workspace-write'}});
 let applied;f.host.get=name=>name==='permissionPresets'?{current:()=> 'workspace-write',set:(session,preset)=>{applied={sessionId:session.id,preset};}}:undefined;
 const old=f.host.sessionController.create;let createRequest;f.host.sessionController.create=async req=>{createRequest=req;return old(req);};
 const body={conversationId:'source-chat',projectId:PID,target:'retained',taskId:TASK,candidateDigest:DIGEST};
 const session=await f.api.handle('POST','/api/plcdev/conversations/editor-session',body);
 assert.equal(session.status,200,JSON.stringify(session));assert.equal(f.calls.open.length,0);assert.equal(createRequest.agentPreset,'native');assert.equal(applied.preset,'workspace-write');assert.equal(applied.sessionId,session.body.sessionId);
 assert.equal(typeof createRequest.workspaceId,'string');assert.equal(createRequest.cwd,undefined);assert.ok(f.workspaces.get(createRequest.workspaceId).sessionIds.includes(session.body.sessionId));
 const opened=await f.open('retained');assert.equal(opened.g.sessionId,session.body.sessionId);assert.equal(f.calls.create,1);
 const count=f.calls.prepare.length;f.projects.get(KEPT).revision='e'.repeat(64);f.bridge.editorPrepare=()=>{throw Error('Historical prepare must not run when locating a ready conversation');};
 const afterSave=await f.api.handle('POST','/api/plcdev/conversations/editor-session',body);assert.equal(afterSave.status,200,JSON.stringify(afterSave));assert.equal(afterSave.body.sessionId,session.body.sessionId);assert.equal(f.calls.prepare.length,count);
 f.workspaces.clear();const repaired=await f.api.handle('POST','/api/plcdev/conversations/editor-session',body);assert.equal(repaired.status,200,JSON.stringify(repaired));assert.ok(f.workspaces.get(repaired.body.workspaceId).sessionIds.includes(session.body.sessionId));assert.equal(f.calls.create,1,'ready mapping repair must not create another session');
});

test('long CJK conversations and many changed files stay below the editor response budget',async t=>{
 const f=await fixture(t),{g}=await f.open();await f.loaded(g);
 for(let i=0;i<150;i++)f.sessions.get('source-chat').events.push({type:'user/message',data:{id:'large-'+i,source:{kind:'user'},content:[{type:'text',text:'修改'.repeat(16000)}]}});
 f.task.candidate.changes=Array.from({length:20000},(_,i)=>({path:'plc/'+i+'/'.repeat(2000)}));
 const result=await f.api.native('GET','/state',null,g);assert.equal(result.status,200);assert.equal(result.body.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(result.body))<=1500000);assert.equal(result.body.messages.at(-1).id,'large-149');assert.equal(result.body.tasks[0].changedFiles.length,100);
});

test('hot sync completion preserves a newer native observation received during file verification',async t=>{
 for(const kind of ['dirty','not_loaded','mismatch'])await t.test(kind,async t=>{
  const f=await fixture(t),{g}=await f.open();await f.loaded(g);
  const oldRevision=g.revision,oldPath=g.nativeProjectPath;
  await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:oldPath,loaded:true,dirty:false},g);
  f.projects.get(PID).revision='e'.repeat(64);
  const prepare=f.bridge.editorPrepare;
  f.bridge.editorPrepare=async input=>({...await prepare(input),nativeProjectPath:path.join(path.dirname(oldPath),'v2','project.json')});
  const plan=(await f.api.native('POST','/sync/prepare',{launchId:g.launchId,expectedRevision:oldRevision,nativeProjectPath:oldPath},g)).body;
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),checking=new Promise(resolve=>entered=resolve);
  f.bridge.editorVerifyPrepared=async body=>{entered();await gate;return {ok:true,...body};};
  const complete={syncId:plan.syncId,launchId:g.launchId,expectedRevision:oldRevision,
   revision:plan.revision,nativeProjectPath:plan.nativeProjectPath,loaded:true,dirty:false};
  const completing=f.api.native('POST','/sync/complete',complete,g);
  await checking;
  const observation={launchId:g.launchId,loaded:kind!=='not_loaded',dirty:kind==='dirty',
   nativeProjectPath:kind==='mismatch'?path.join(path.dirname(oldPath),'other-project','project.json'):plan.nativeProjectPath};
  await f.api.native('POST','/state',observation,g);
  release();
  const ack=await completing;
  assert.equal(ack.status,200,JSON.stringify(ack));assert.equal(g.revision,plan.revision);
  assert.equal(ack.body.editor.observation.state,kind);
  assert.equal(ack.body.editor.observation.dirty,observation.dirty);
  assert.equal(ack.body.editor.observation.loaded,observation.loaded);
  assert.equal(ack.body.editor.observation.nativeProjectPath,observation.nativeProjectPath);
  const replay=await f.api.native('POST','/sync/complete',complete,g);
  assert.equal(replay.status,200);assert.equal(replay.body.editor.observation.state,kind);
  assert.equal((await f.api.native('GET','/state',null,g)).body.canSend,false);
  assert.equal(f.calls.open.length,1);assert.equal(f.calls.prompt,0);
 });
});

test('saving a local old-version branch does not make a clean window safe to auto replace',async t=>{
 const f=await fixture(t),{g}=await f.open();await f.loaded(g);
 const oldPath=g.nativeProjectPath,oldRevision=g.revision;
 const observe=dirty=>f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:oldPath,loaded:true,dirty},g);
 f.projects.get(PID).revision='e'.repeat(64);
 await observe(true);
 const request={launchId:g.launchId,expectedRevision:oldRevision,nativeProjectPath:oldPath};
 assert.equal((await f.api.native('POST','/sync/prepare',request,g)).status,409);
 // Saving the old branch clears dirty, but the prepared source hash check
 // still detects that these are local changes absent from the newer version.
 await observe(false);
 const preparations=f.calls.prepare.length;let checked;
 f.bridge.editorVerifyPrepared=async body=>{checked=body;throw Error('old PLC bytes changed after load');};
 const rejected=await f.api.native('POST','/sync/prepare',request,g);
 assert.equal(rejected.status,409);assert.equal(rejected.body.code,'sync_source_changed');
 assert.deepEqual(checked,{launchId:g.launchId,projectId:PID,revision:oldRevision,nativeProjectPath:oldPath});
 assert.equal(f.calls.prepare.length,preparations,'do not even stage the new target after source verification fails');
 assert.equal(g.revision,oldRevision);assert.equal(g.nativeProjectPath,oldPath);assert.equal(g.syncPending,undefined);
 const state=(await f.api.native('GET','/state',null,g)).body;
 assert.equal(state.editor.sync.state,'blocked');assert.match(state.editor.sync.reason,/本地保存/);assert.equal(state.canSend,false);
 // A result-card open must retain the active blocked window. Starting a new
 // editor here would hide the user's locally saved old-version branch.
 const original=f.bridge.editorPrepare;
 f.bridge.editorPrepare=async input=>({...await original(input),nativeProjectPath:path.join(path.dirname(oldPath),'v2','project.json')});
 const reopened=await f.open();
 assert.equal(reopened.g.launchId,g.launchId);assert.equal(reopened.g.revision,oldRevision);
 assert.equal(reopened.result.body.reused,true);assert.equal(reopened.result.body.editor.sync.state,'blocked');
 assert.equal(g.nativeProjectPath,oldPath);assert.equal(f.calls.open.length,1);assert.equal(f.calls.prompt,0);
});

test('explicit sync retry rechecks a failed source and later verifies the latest completed native target',async t=>{
 const f=await fixture(t),{g}=await f.open();await f.loaded(g);
 const oldPath=g.nativeProjectPath,oldRevision=g.revision;
 await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:oldPath,loaded:true,dirty:false},g);
 f.projects.get(PID).revision='e'.repeat(64);
 const request={launchId:g.launchId,expectedRevision:oldRevision,nativeProjectPath:oldPath};
 let unavailable=true;const verified=[];
 f.bridge.editorVerifyPrepared=async body=>{verified.push({...body});if(unavailable)throw Error('temporary unavailable');return {ok:true,...body};};
 assert.equal((await f.api.native('POST','/sync/prepare',request,g)).body.code,'sync_source_changed');
 const initialPrepare=f.bridge.editorPrepare;
 f.bridge.editorPrepare=async input=>({...await initialPrepare(input),nativeProjectPath:path.join(path.dirname(oldPath),'v2','project.json')});
 unavailable=false;
 const retry=await f.api.native('POST','/sync/prepare',request,g);
 assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(g.syncBlockedReason,undefined);
 assert.deepEqual(verified[1],verified[0],'a retry must recheck the original source instead of bypassing it');
 const plan=retry.body,stagedLaunch=g.syncPreparedLaunch;
 const ack=await f.api.native('POST','/sync/complete',{syncId:plan.syncId,launchId:g.launchId,
  expectedRevision:oldRevision,revision:plan.revision,nativeProjectPath:plan.nativeProjectPath,loaded:true,dirty:false},g);
 assert.equal(ack.status,200);assert.equal(g.nativePreparedLaunch,stagedLaunch);
 assert.equal((await f.api.native('GET','/state',null,g)).body.editor.sync.state,'current');
 f.projects.get(PID).revision='f'.repeat(64);
 f.bridge.editorPrepare=async input=>({...await initialPrepare(input),nativeProjectPath:path.join(path.dirname(oldPath),'v3','project.json')});
 const next=await f.api.native('POST','/sync/prepare',{launchId:g.launchId,expectedRevision:g.revision,nativeProjectPath:g.nativeProjectPath},g);
 assert.equal(next.status,200,JSON.stringify(next));
 assert.deepEqual(verified.at(-1),{launchId:stagedLaunch,projectId:PID,revision:plan.revision,nativeProjectPath:plan.nativeProjectPath});
 assert.notEqual(stagedLaunch,g.launchId,'second sync verifies v2 bytes, not the original v1 launch');
 assert.equal(f.calls.open.length,1);assert.equal(f.calls.prompt,0);
});

async function addResult(f,{taskId='task-'+'f'.repeat(32),candidateDigest='e'.repeat(64),keptProjectId=PID}={}){
 const task={...f.task,taskId,status:'awaiting_review',candidate:{...f.task.candidate,candidateDigest},retention:undefined};
 const prior=f.bridge.handle;
 f.bridge.handle=async(method,url,body)=>method==='POST'&&url.endsWith('/tasks')?{status:202,body:{ok:true,task}}:prior(method,url,body);
 try{
  const result=await f.conversations.handle('POST','/api/plcdev/conversations/tasks',{conversationId:'source-chat',projectId:PID,
   expectedVersion:f.conversations.snapshot('source-chat').version,request:'下一轮修改',expectedRevision:f.projects.get(PID).revision,
   executionScope:'proposal',clientRequestId:'seed-'+taskId,sourceBasis:'saved_revision'});
  assert.equal(result.status,202,JSON.stringify(result));
 }finally{f.bridge.handle=prior;}
 task.status='kept';task.retention={keptProjectId,revision:f.projects.get(keptProjectId).revision,completionScope:keptProjectId===PID?'saved-project-version':undefined};
 f.tasks.get(PID).push(task);return task;
}
function sameProjectPreparation(f){
 const prior=f.bridge.editorPrepare;
 f.bridge.editorPrepare=async input=>{
  const prepared=await prior(input.target==='retained'?{projectId:input.projectId,target:'project'}:input);
  return {...prepared,nativeProjectPath:path.join(path.dirname(prepared.nativeProjectPath),prepared.revision,'project.json')};
 };
}
const resultOpen=(f,task)=>f.api.handle('POST','/api/plcdev/conversations/editor-open',{
 conversationId:'source-chat',projectId:PID,target:'retained',taskId:task.taskId,candidateDigest:task.candidate.candidateDigest});
const resultStatus=(f,launchId,taskId,session='source-chat')=>f.api.handle('GET','/api/plcdev/conversations/editor-status?conversationId='+session+'&launchId='+launchId+(taskId?'&taskId='+taskId:''));

test('successive retained results share the active project window while preserving both cards and persisted task identities',async t=>{
 const f=await fixture(t);sameProjectPreparation(f);f.task.status='kept';f.task.retention={keptProjectId:PID,revision:REV,completionScope:'saved-project-version'};
 const first=await f.open('retained'),g=first.g;await f.loaded(g);
 await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,loaded:true,dirty:false},g);
 f.projects.get(PID).revision=KREV;const next=await addResult(f);
 assert.equal((await resultStatus(f,g.launchId,next.taskId)).status,403,'an owned result is not an alias until explicitly opened');
 const opened=await resultOpen(f,next);assert.equal(opened.status,200,JSON.stringify(opened));
 assert.equal(opened.body.reused,true);assert.equal(opened.body.launchId,g.launchId);assert.equal(opened.body.taskId,next.taskId);assert.equal(opened.body.candidateDigest,next.candidate.candidateDigest);
 assert.equal(opened.body.revision,REV);assert.equal(opened.body.editor.sync.state,'available');assert.equal(opened.body.editor.observation.revisionMatches,false);
 assert.equal(g.sourceTaskId,TASK);assert.equal(f.calls.open.length,1);assert.equal(f.calls.create,0);
 const plan=(await f.api.native('POST','/sync/prepare',{launchId:g.launchId,expectedRevision:g.revision,nativeProjectPath:g.nativeProjectPath},g)).body;
 assert.equal((await f.api.native('POST','/sync/complete',{syncId:plan.syncId,launchId:g.launchId,expectedRevision:REV,
  revision:plan.revision,nativeProjectPath:plan.nativeProjectPath,loaded:true,dirty:false},g)).status,200);
 const api=async route=>{const value=await f.api.handle('GET','/api/plcdev/'+route);assert.equal(value.status,200,JSON.stringify(value));return value.body;};
 for(const receipt of [first.result.body,opened.body]){
  const value=await readEditorObservation(api,'source-chat',receipt);
  assert.equal(value.taskId,receipt.taskId);assert.equal(value.candidateDigest,receipt.candidateDigest);assert.equal(value.revision,KREV);assert.equal(value.launchId,g.launchId);
  assert.equal(value.resultReferences,undefined);assert.equal(value.editor.observation.revisionMatches,true);
 }
 const project=await f.open();assert.equal(project.result.body.taskId,undefined);assert.equal(project.result.body.reused,true);
 assert.equal((await resultStatus(f,g.launchId)).body.taskId,undefined,'project opening is not accidentally tied to an earlier task');
 assert.equal((await resultStatus(f,g.launchId,TASK,'foreign-chat')).status,403);
 assert.equal((await resultStatus(f,g.launchId,'../bad')).status,400);
 f.restart();
 for(const task of [f.task,next]){
  const saved=await resultStatus(f,g.launchId,task.taskId);assert.equal(saved.status,200);assert.equal(saved.body.state,'disconnected');
  assert.equal(saved.body.taskId,task.taskId);assert.equal(saved.body.candidateDigest,task.candidate.candidateDigest);assert.equal(saved.body.resultReferences,undefined);
 }
 assert.equal((await resultStatus(f,g.launchId,'task-'+'9'.repeat(32))).status,403);assert.equal(f.calls.open.length,1);
});

test('automatic retained opening keeps a dirty project window and its original branch intact',async t=>{
 const f=await fixture(t);sameProjectPreparation(f);const {g}=await f.open();await f.loaded(g);
 const original={nativeProjectPath:g.nativeProjectPath,revision:g.revision};
 await f.api.native('POST','/state',{launchId:g.launchId,nativeProjectPath:g.nativeProjectPath,loaded:true,dirty:true},g);
 f.projects.get(PID).revision=KREV;f.task.status='kept';f.task.retention={keptProjectId:PID,revision:KREV,completionScope:'saved-project-version'};
 const opened=await resultOpen(f,f.task);assert.equal(opened.status,200,JSON.stringify(opened));assert.equal(opened.body.reused,true);
 assert.equal(opened.body.launchId,g.launchId);assert.equal(opened.body.nativeProjectPath,original.nativeProjectPath);assert.equal(opened.body.revision,original.revision);
 assert.equal(opened.body.editor.sync.state,'blocked');assert.equal(opened.body.editor.observation.dirty,true);assert.match(editorOpenNotice(opened.body,true),/未保存调整.*同步/);
 assert.equal(f.calls.open.length,1);assert.equal(g.syncPending,undefined);assert.equal((await f.api.native('GET','/state',null,g)).body.canSend,false);
 for(const observation of [
  {loaded:null,dirty:null,nativeProjectPath:null},
  {loaded:false,dirty:false,nativeProjectPath:g.nativeProjectPath},
  {loaded:true,dirty:false,nativeProjectPath:path.join(path.dirname(g.nativeProjectPath),'another','project.json')},
 ]){
  await f.api.native('POST','/state',{launchId:g.launchId,...observation},g);
  const waiting=await resultOpen(f,f.task);assert.equal(waiting.status,200);assert.equal(waiting.body.reused,true);
  assert.equal(waiting.body.editor.sync.state,'blocked');assert.equal(waiting.body.nativeProjectPath,original.nativeProjectPath);
  assert.equal(waiting.body.revision,original.revision);assert.equal(f.calls.open.length,1);
 }
});

test('window reuse never crosses previews, source sessions or legacy-copy result identities',async t=>{
 await t.test('preview is not a saved project window',async t=>{
  const f=await fixture(t);sameProjectPreparation(f);const preview=await f.open('candidate');await f.loaded(preview.g);
  f.task.status='kept';f.task.retention={keptProjectId:PID,revision:REV,completionScope:'saved-project-version'};
  const saved=await resultOpen(f,f.task);assert.equal(saved.status,200);assert.notEqual(saved.body.launchId,preview.g.launchId);assert.equal(f.calls.open.length,2);
 });
 await t.test('same project in a different source session is separate',async t=>{
  const f=await fixture(t),first=await f.open();await f.loaded(first.g);
  await f.host.sessionController.create({sessionId:'other-chat',cwd:f.sessions.get('source-chat').header.cwd});
  assert.equal((await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'other-chat',projectId:PID,expectedVersion:0})).status,200);
  const opened=await f.api.handle('POST','/api/plcdev/conversations/editor-open',{conversationId:'other-chat',projectId:PID,target:'project'});
  assert.equal(opened.status,200);assert.notEqual(opened.body.launchId,first.g.launchId);assert.equal(f.calls.open.length,2);
  assert.equal((await resultStatus(f,first.g.launchId,undefined,'other-chat')).status,403);
 });
 await t.test('legacy copies do not adopt another round just because the target matches',async t=>{
  const f=await fixture(t);f.task.status='kept';f.task.retention={keptProjectId:KEPT,revision:KREV};const first=await f.open('retained');await f.loaded(first.g);
  const next=await addResult(f,{keptProjectId:KEPT}),opened=await resultOpen(f,next);
  assert.equal(opened.status,200,JSON.stringify(opened));assert.notEqual(opened.body.launchId,first.g.launchId);assert.equal(f.calls.open.length,2);
  assert.equal((await resultStatus(f,first.g.launchId,next.taskId)).status,403);
 });
});

test('editor grant cannot send after session opt-out; a new editor send retains engineering identity',async t=>{
  const f=await fixture(t,{seed:false}),old=await f.open();await f.loaded(old.g);
  let b=f.conversations.snapshot('source-chat');
  assert.deepEqual(b.participation,{enabled:true,locked:false});
  const off=await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'source-chat',projectId:null,expectedVersion:b.version});
  assert.equal(off.status,200);
  assert.equal((await f.api.native('POST','/submit',{requestId:'stale-editor',text:'创建变量'},old.g)).status,409);
  assert.equal(f.calls.prompt,0);
  b=f.conversations.snapshot('source-chat');
  assert.equal((await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'source-chat',projectId:PID,expectedVersion:b.version})).status,200);
  const next=await f.open();await f.loaded(next.g);
  const sent=await f.api.native('POST','/submit',{requestId:'new-editor',text:'创建变量'},next.g);
  assert.equal(sent.status,200,JSON.stringify(sent));assert.equal(f.calls.prompt,1);
  b=f.conversations.snapshot('source-chat');assert.deepEqual(b.participation,{enabled:true,locked:true});
  assert.equal((await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:'source-chat',projectId:null,expectedVersion:b.version})).status,409);
  assert.equal(f.conversations.snapshot('source-chat').projectId,PID);
});

test('queued editor demand retains its original binding and is rejected after switching projects',async t=>{
  const f=await fixture(t,{seed:false}),{g}=await f.open();await f.loaded(g);
  const hooks=new Map(),sections=[];
  const ctx={on:(name,fn)=>hooks.set(name,fn),effect:fn=>fn(),sessionProjections:{stateOf:()=>({lastTurn:1,openTurnStartSeq:0})},systemPrompt:{section:value=>{sections.push(value);return()=>{};},context:()=>()=>{}}};
  const service=createProjectContext({ctx,conversations:f.conversations,getEditorPromptBinding:(id,rpc)=>f.api.promptBinding(id,rpc)});
  const actual=f.host.sessionController.prompt;let decision,seenBinding;
  f.host.sessionController.prompt=async request=>{
    seenBinding=f.api.promptBinding(request.sessionId,request.requestId);
    const old=f.conversations.snapshot(request.sessionId);
    assert.equal((await f.conversations.handle('POST','/api/plcdev/conversations/bind',{conversationId:request.sessionId,projectId:KEPT,expectedVersion:old.version})).status,200);
    await actual(request); // Durable admission happened before host consumption.
    const message=f.sessions.get(request.sessionId).events.find(e=>e.type==='user/message'&&e.data.source.rpcId===request.requestId).data;
    decision=await hooks.get('agent/pre-step')({agent:{session:{id:request.sessionId}},turn:1,step:1,signal:new AbortController().signal,messages:[message]},async()=>({kind:'enter',messages:[message]}));
  };
  const sent=await f.api.native('POST','/submit',{requestId:'queued-source',text:'创建变量'},g);
  assert.equal(sent.status,200);assert.equal(sent.body.accepted,true,'delivery receipt does not mean engineering execution');
  assert.deepEqual(seenBinding,{projectId:PID,version:1,text:'创建变量'});
  assert.deepEqual(decision,{kind:'reject'});assert.equal(service.size(),0);
  assert.equal(service.notice('source-chat').reason,'editor-binding-changed');
  assert.equal(f.conversations.snapshot('source-chat').projectId,KEPT);
  const rpc=f.sessions.get('source-chat').events.find(e=>e.type==='user/message').data.source.rpcId;
  f.restart();assert.deepEqual(f.api.promptBinding('source-chat',rpc),seenBinding);
  assert.equal(f.api.promptBinding('foreign-chat',rpc),null);
});

test('legacy editor request rows migrate intact without guessing a queued request binding',async t=>{
  const f=await fixture(t,{seed:false}),file=path.join(path.dirname(f.controllerFile),'dsh-editor.sqlite');
  const db=new DatabaseSync(file),rpc='plcdev-openplc-'+'a'.repeat(64);
  try{
    db.exec('CREATE TABLE editor_requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,rpc_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id))');
    db.prepare('INSERT INTO editor_requests VALUES(?,?,?,?,?,?,?,?)').run('source-chat','legacy','original',rpc,'原需求','unknown',null,'2026-11-17');
  }finally{db.close();}
  assert.equal(f.api.promptBinding('source-chat',rpc),null);
  const verify=new DatabaseSync(file);
  try{const row=verify.prepare('SELECT * FROM editor_requests').get();assert.equal(row.fingerprint,'original');assert.equal(row.state,'unknown');assert.equal(row.text,'原需求');assert.equal(row.project_id,null);assert.equal(row.binding_version,null);}finally{verify.close();}
});
