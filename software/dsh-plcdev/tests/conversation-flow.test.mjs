import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationViews,createProjectSessionActions,projectSessionDirectory,readSignalReference} from '../src/client/conversation-flow.mjs';
import {createConversationNavigation,recoverConversationRequest} from '../src/client/conversation-client.mjs';

const projectId='project-a',sessionId='chat-new',revision='a'.repeat(64),reference={projectId,signalKey:'count',savedRevision:revision};
const projectRoot=String.raw`C:\PLCdev Projects\测试工程`,manifestPath=projectRoot+'\\project.plcdev';
function fixture(){
 const calls=[],rows={},drafts={'chat-old':'未发送的需求'},bindings={'chat-old':{conversationId:'chat-old',projectId,version:2,taskRefs:[],pendingRequests:[]}};
 const workspaceRow={workspaceId:'workspace-a',path:projectRoot,title:'测试工程',sessionIds:['chat-old']},workspaceListeners=new Set();
 const workspaces={create:async value=>{calls.push(['workspace-create',value]);return workspaceRow;},list:{getSnapshot:()=>({phase:'ready',items:[workspaceRow],archivedSessionIds:[]}),subscribe:fn=>{workspaceListeners.add(fn);return()=>workspaceListeners.delete(fn);}}};
 const inspection={ok:true,schemaVersion:1,projectId,projectRevision:revision,source:'saved-files-only',resources:[],signals:[{id:'count',label:'累计计数',path:'INSTANCE0.Count',type:'INT',access:'read',source:{kind:'plc',path:'plc/main.st'},hmi:[],scene:[]}],readback:{state:'untracked',observedRevision:revision,baselineRevision:null,capturedRevision:null,acknowledgedRevision:null,changes:[]},editorState:{state:'unknown',message:'未保存内容无法确认'},capabilities:{canCapture:true,canAcknowledgeLayout:false}};
 const tasks={projectId,projectRevision:revision,tasks:[],capabilities:{hmiReadonlyValueCandidate:true},hmiValueTargets:[{viewId:'view-main',viewName:'主画面',signalId:'Count',path:'INSTANCE0.Count',type:'INT'}]};
 const status={project:{id:projectId,name:'工程 A',kind:'user',projectRoot,manifestPath},projects:[{id:projectId,kind:'user',manifestPath}]};
 rows['chat-old']={};
 const sessions={refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',ids:Object.keys(rows),byId:rows})},create:async opts=>{calls.push(['create',opts]);rows[sessionId]={cwd:opts.cwd||workspaceRow.path};if(opts.workspaceId===workspaceRow.workspaceId){workspaceRow.sessionIds.push(sessionId);workspaceListeners.forEach(fn=>fn());}bindings[sessionId]={conversationId:sessionId,projectId:null,version:0,taskRefs:[],pendingRequests:[]};return sessionId;},retain(id,opts){calls.push(['retain',id,opts]);return {ready:Promise.resolve({sessionId:id,ctx:{sessionId:id}}),release(){calls.push(['release',id]);}};}};
 const workspace={openSession(id){calls.push(['open',id]);}},conversation={input:{requestDraftInitialization(binding,options){calls.push(['draft',binding.sessionId,options]);drafts[binding.sessionId]=(drafts[binding.sessionId]||'')+'\n'+options.prompt;return 'applied';},for(ctx){return {state:{getSnapshot:()=>({draft:drafts[ctx.sessionId]||''}),subscribe:()=>()=>{}}};}}};
 const navigation=createConversationNavigation();navigation.subscribe(()=>{const intent=navigation.snapshot();if(intent)navigation.complete(intent);});
 const api=async(path,body)=>{calls.push(['api',path,body]);if(path.startsWith('status'))return status;if(path.startsWith('project-inspection'))return inspection;if(path.startsWith('tasks?'))return tasks;if(path==='conversations/bind'){const current=bindings[body.conversationId];assert.equal(body.expectedVersion,current.version);return bindings[body.conversationId]={...current,projectId:body.projectId,version:current.version+1};}return bindings[new URL('http://host/'+path).searchParams.get('conversationId')];};
 const actions=createProjectSessionActions({services:()=>({sessions,workspace,workspaces,conversation}),api,navigation,openSession:async({sessionId})=>{workspace.openSession(sessionId);return {ok:true,dispatched:true};},onPrepared:value=>calls.push(['prepared',value]),timeout:50});
 return {actions,calls,rows,drafts,bindings,inspection,tasks,status,sessions,workspace,workspaces,workspaceRow,workspaceListeners,conversation,api};
}
test('new project chat creates a distinct host session then binds only that session',async()=>{
 const f=fixture(),result=await f.actions.create(projectId);assert.equal(result.ok,true);assert.equal(result.sessionId,sessionId);assert.deepEqual(f.calls.find(c=>c[0]==='workspace-create')[1],{path:projectRoot});assert.deepEqual(f.calls.find(c=>c[0]==='create')[1],{workspaceId:'workspace-a'});assert.equal(f.bindings['chat-old'].version,2);assert.equal(f.bindings[sessionId].projectId,projectId);assert.equal(f.drafts['chat-old'],'未发送的需求');assert.equal(f.calls.some(c=>c[0]==='draft'),false);
});
test('signal carry uses exact retained generation and appends existing draft without sending or rebinding',async()=>{
 const f=fixture(),result=await f.actions.carry(projectId,reference,'chat-old');assert.equal(result.ok,true);assert.equal(result.draftApplied,true);assert.equal(result.draftVerified,true);assert.ok(f.drafts['chat-old'].startsWith('未发送的需求\n'));assert.match(f.drafts['chat-old'],/信号：累计计数 \(count\)/);assert.equal(f.calls.find(c=>c[0]==='draft')[2].whenDraftExists,'append');assert.equal(f.calls.some(c=>c[0]==='create'||c[1]==='conversations/bind'),false);assert.equal(f.calls.at(-1)[0],'release');
});
test('stale references and foreign current bindings never mutate a draft or create a chat',async()=>{
 const f=fixture();f.inspection.projectRevision='b'.repeat(64);f.inspection.readback.observedRevision=f.inspection.projectRevision;assert.equal((await f.actions.carry(projectId,reference)).ok,false);assert.equal(f.calls.some(c=>c[0]==='create'||c[0]==='draft'),false);
 const g=fixture();g.bindings['chat-old'].projectId='project-other';assert.equal((await g.actions.carry(projectId,reference,'chat-old')).ok,false);assert.equal(g.calls.some(c=>c[0]==='draft'||c[1]==='conversations/bind'),false);
});
test('missing composer capability fails before creating or binding any session',async()=>{
 const f=fixture();delete f.conversation.input.requestDraftInitialization;const result=await f.actions.carry(projectId,reference);assert.equal(result.ok,false);assert.match(result.message,/不支持带入草稿/);assert.equal(f.calls.length,0);
});
test('retention-time binding changes block append and release the retained generation',async()=>{
 const f=fixture(),retain=f.sessions.retain;f.sessions.retain=(id,opts)=>{f.bindings[id].projectId='project-other';return retain(id,opts);};const result=await f.actions.carry(projectId,reference,'chat-old');assert.equal(result.ok,false);assert.equal(f.calls.some(c=>c[0]==='draft'||c[0]==='open'),false);assert.equal(f.calls.at(-1)[0],'release');
});
test('return to original session needs only host membership and never writes engineering state',async()=>{
 const f=fixture();delete f.bindings['chat-old'];const result=await f.actions.returnToSession('chat-old');assert.equal(result.ok,true);assert.deepEqual(f.calls,[['open','chat-old']]);delete f.rows['chat-old'];assert.equal((await f.actions.returnToSession('chat-old')).ok,false);assert.equal(f.calls.length,1);
});
test('view bookmarks preserve separate origins and references per session without changing bindings',()=>{
 const disk=new Map(),storage=()=>({getItem:key=>disk.get(key),setItem:(key,value)=>disk.set(key,value)}),views=createConversationViews({storage});views.rememberOrigin('chat-a',{projectId,view:'sessions',selected:'signal:count',scroll:421});views.rememberOrigin('chat-b',{projectId:'other',view:'runtime'});views.rememberReference('chat-a',reference,'累计计数');views.rememberNotice('chat-a','草稿未能确认显示，未重复追加。');const restored=createConversationViews({storage});assert.equal(restored.snapshot().origins['chat-a'].scroll,421);assert.equal(restored.snapshot().origins['chat-b'].view,'runtime');assert.equal(restored.snapshot().references['chat-a'].signalKey,'count');assert.equal(restored.snapshot().references['chat-b'],undefined);assert.equal(restored.snapshot().notices['chat-a'],'草稿未能确认显示，未重复追加。');assert.equal(restored.snapshot().notices['chat-b'],undefined);
});
test('inspection cannot redirect a saved signal reference to another project',async()=>{
 const f=fixture();f.inspection.projectId='other';await assert.rejects(readSignalReference(f.api,reference),/身份或版本未确认/);
});
test('readonly HMI action verifies fresh target catalog and prepares the exact supported requirement only',async()=>{
 const value={...reference,intent:'readonly-value',viewId:'view-main',signalId:'Count'},f=fixture();const result=await f.actions.carry(projectId,value);assert.equal(result.ok,true);assert.equal(f.calls.find(c=>c[0]==='draft')[2].prompt,'在画面 ID“view-main”添加信号 ID“Count”的只读数值显示');assert.equal(f.calls.filter(c=>c[0]==='api'&&c[1].startsWith('tasks?')).length,2);
 for(const invalidate of [x=>x.tasks.projectRevision='f'.repeat(64),x=>x.tasks.hmiValueTargets[0].path='INSTANCE0.Other',x=>x.tasks.capabilities.hmiReadonlyValueCandidate=false]){const other=fixture();invalidate(other);assert.equal((await other.actions.carry(projectId,value)).ok,false);assert.equal(other.calls.some(c=>c[0]==='draft'||c[0]==='create'),false);}
});
test('readonly HMI recovery preserves exact request identity and rejects extra writes or parent revision',()=>{
 const body={conversationId:'chat-old',projectId,expectedVersion:2,executionScope:'proposal',sourceBasis:'saved_revision',expectedRevision:revision,clientRequestId:'original-request',request:'在画面 ID“view-main”添加信号 ID“Count”的只读数值显示',workflow:'hmi-readonly-value-v1',planSubmission:{schemaVersion:1,plan:{viewId:'view-main',signalId:'Count'},route:{provider:'provider',model:'model'}}};
 assert.deepEqual(recoverConversationRequest(body,'chat-old'),body);assert.equal(recoverConversationRequest({...body,request:body.request+'并启动 PLC'},'chat-old'),null);assert.equal(recoverConversationRequest({...body,revisionParent:{taskId:'task-'+'b'.repeat(32),candidateDigest:'c'.repeat(64)},revisionIntentId:'intent'},'chat-old'),null);
});
test('new chats refuse missing, relative, foreign or inconsistent registered project directories before creation',async()=>{
 const invalidations=[
  f=>delete f.status.project.projectRoot,
  f=>f.status.project.projectRoot='relative/project',
  f=>f.status.project.projectRoot=String.raw`C:\PLCdev Projects\Other`,
  f=>f.status.projects[0].manifestPath=String.raw`C:\Other\project.plcdev`,
  f=>f.status.projects[0].id='project-other',
  f=>f.status.project.kind='builtin',
  f=>f.status.projects.push({...f.status.projects[0]})
 ];
 for(const invalidate of invalidations){const f=fixture();invalidate(f);const result=await f.actions.carry(projectId,reference);assert.equal(result.ok,false);assert.match(result.message,/未创建会话|当前工程不在工程清单/);assert.equal(f.calls.some(c=>c[0]==='create'||c[0]==='draft'||c[1]==='conversations/bind'),false);}
 const f=fixture();f.status.projects[0].manifestPath=manifestPath.replaceAll('\\','/').toLowerCase();assert.equal(projectSessionDirectory(f.status,projectId),projectRoot);
});
test('a caller-supplied cwd cannot override the registered user project directory',async()=>{
 const f=fixture();const result=await f.actions.carry(projectId,{...reference,cwd:String.raw`C:\Other`,projectRoot:String.raw`C:\Other`});assert.equal(result.ok,true);assert.equal(result.draftVerified,true);assert.deepEqual(f.calls.find(c=>c[0]==='workspace-create')[1],{path:projectRoot});assert.deepEqual(f.calls.find(c=>c[0]==='create')[1],{workspaceId:'workspace-a'});assert.equal(f.rows[sessionId].cwd,projectRoot);assert.match(f.drafts[sessionId],/工程信号引用/);
});
test('a draft lost during host navigation is reported without appending it a second time',async()=>{
 const f=fixture();f.workspace.openSession=id=>{f.calls.push(['open',id]);f.drafts[id]='';};const result=await f.actions.carry(projectId,reference);assert.equal(result.ok,false);assert.equal(result.draftApplied,true);assert.equal(result.draftVerified,false);assert.match(result.message,/未能确认草稿显示/);assert.equal(f.calls.filter(c=>c[0]==='draft').length,1);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.at(-1)[0],'release');
});
test('host workspace membership must be observed before binding, drafting or navigation',async()=>{
 const f=fixture(),create=f.sessions.create;f.sessions.create=async opts=>{const id=await create(opts);f.workspaceRow.sessionIds=f.workspaceRow.sessionIds.filter(member=>member!==id);return id;};const result=await f.actions.carry(projectId,reference);assert.equal(result.ok,false);assert.match(result.message,/工作区归属尚未确认/);assert.equal(f.calls.some(c=>c[0]==='draft'||c[0]==='open'||c[1]==='conversations/bind'),false);assert.equal(f.workspaceListeners.size,0);
 const g=fixture(),createLater=g.sessions.create;g.sessions.create=async opts=>{const id=await createLater(opts);g.workspaceRow.sessionIds=g.workspaceRow.sessionIds.filter(member=>member!==id);setTimeout(()=>{g.workspaceRow.sessionIds.push(id);g.workspaceListeners.forEach(fn=>fn());},10);return id;};assert.equal((await g.actions.carry(projectId,reference)).ok,true);assert.equal(g.workspaceListeners.size,0);
});
test('a workspace returned for a different directory never receives a new engineering session',async()=>{
 const f=fixture();f.workspaceRow.path=String.raw`C:\Other`;const result=await f.actions.create(projectId);assert.equal(result.ok,false);assert.match(result.message,/工作区与已核验工程目录不一致/);assert.equal(f.calls.some(c=>c[0]==='create'||c[1]==='conversations/bind'),false);
});
