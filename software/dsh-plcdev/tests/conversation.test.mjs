import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createConversationContexts} from '../src/client/conversation-context.mjs';
import { createConversationNavigation, validateBinding, bindRequest, conversationTaskRequest, referenceTasks, saveConversationPending, readConversationPending, recoverConversationRequest, reviewTarget, reviewedCandidate, runtimeDockLabel, REVIEW_PREFIX } from '../src/client/conversation-client.mjs';

const hash='a'.repeat(64),taskId='task-'+'1'.repeat(32);
const binding=(id='chat-a',projectId='project-a',version=1)=>({ok:true,conversationId:id,projectId,version,taskRefs:[],pendingRequests:[]});
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
test('binding validates exact DSH conversation identity and version',()=>{
  assert.equal(validateBinding(binding(),'chat-a').projectId,'project-a');
  assert.throws(()=>validateBinding(binding(),'chat-b'));
  assert.throws(()=>validateBinding({...binding(),version:NaN},'chat-a'));
  assert.deepEqual(bindRequest(binding(),'project-b'),{conversationId:'chat-a',projectId:'project-b',expectedVersion:1});
});
test('candidate request fixes conversation, project, binding version and saved source',()=>{
  const r=conversationTaskRequest(binding(),{request:'rename Count to BatchCount',revision:hash,consent:true,clientRequestId:'one'});
  assert.equal(r.conversationId,'chat-a');assert.equal(r.projectId,'project-a');assert.equal(r.expectedVersion,1);assert.equal(r.expectedRevision,hash);assert.equal(r.sourceBasis,'saved_revision');
  assert.throws(()=>conversationTaskRequest(binding(),{request:'rename',revision:hash,consent:false,clientRequestId:'one'}));
  assert.throws(()=>conversationTaskRequest(binding('chat-a',null),{request:'rename',revision:hash,consent:true,clientRequestId:'one'}));
});
test('pending request recovery keeps original identity and rejects another conversation',()=>{
  const r=conversationTaskRequest(binding(),{request:'rename Count to BatchCount',revision:hash,consent:true,clientRequestId:'one'}),storage=memory();
  saveConversationPending(storage,r);assert.deepEqual(readConversationPending(storage,'chat-a'),r);assert.equal(readConversationPending(storage,'chat-b'),null);
  assert.deepEqual(recoverConversationRequest({...r,state:'unknown',createdAt:'today'},'chat-a'),r);
  assert.equal(recoverConversationRequest({...r,executionScope:'runtime'},'chat-a'),null);
  assert.equal(recoverConversationRequest(r,'chat-b'),null);
});
test('HMI unknown submission recovers its original view, name, model route and request identity',()=>{
  const r={...conversationTaskRequest(binding(),{request:'把画面名称“旧画面”改为“操作画面”',revision:hash,consent:true,clientRequestId:'hmi-one',workflow:'hmi-view-name-v1'}),planSubmission:{schemaVersion:1,plan:{viewId:'v-one',name:'操作画面'},route:{provider:'deepseek',model:'model-a'}}};
  const disk=memory();saveConversationPending(disk,r);
  assert.deepEqual(readConversationPending(disk,'chat-a'),r);
  assert.deepEqual(recoverConversationRequest({...r,state:'unknown'},'chat-a'),r);
  assert.equal(readConversationPending(disk,'chat-b'),null);
  assert.equal(recoverConversationRequest({...r,planSubmission:{...r.planSubmission,plan:{viewId:'v-one',name:'未请求'}}},'chat-a'),null);
  assert.equal(recoverConversationRequest({...r,planSubmission:{...r.planSubmission,plan:{...r.planSubmission.plan,other:'unexpected'}}},'chat-a'),null);
});
test('static text unknown submission keeps its precise target and rejects other scopes',()=>{
  const request={...conversationTaskRequest(binding(),{request:'把静态文字“原标题”改为“设备演示”',revision:hash,consent:true,clientRequestId:'text-one',workflow:'hmi-static-text-v1'}),planSubmission:{schemaVersion:1,plan:{viewId:'v-one',elementId:'PLCD_tTitle',text:'设备演示'},route:{provider:'deepseek',model:'model-a'}}};
  assert.deepEqual(recoverConversationRequest({...request,state:'unknown'},'chat-a'),request);
  assert.equal(recoverConversationRequest({...request,planSubmission:{...request.planSubmission,plan:{...request.planSubmission.plan,elementId:'value_dynamic'}}},'chat-a'),null);
  assert.equal(recoverConversationRequest({...request,planSubmission:{...request.planSubmission,plan:{...request.planSubmission.plan,text:'未经要求'}}},'chat-a'),null);
});
test('HMI parent revisions recover the exact request and reject incomplete or foreign identity',()=>{
  for(const [workflow,request,plan] of [
    ['hmi-view-name-v1','把画面名称“第一版”改为“第二版”',{viewId:'v-one',name:'第二版'}],
    ['hmi-static-text-v1','把静态文字“第一版”改为“第二版”',{viewId:'v-one',elementId:'PLCD_tTitle',text:'第二版'}]
  ]){
    const original={...conversationTaskRequest(binding(),{request,revision:hash,consent:true,clientRequestId:'revision-lost',workflow}),
      revisionParent:{taskId,candidateDigest:'d'.repeat(64)},revisionIntentId:'intent-original',
      planSubmission:{schemaVersion:1,plan,route:{provider:'deepseek',model:'model-a'}}};
    const disk=memory();saveConversationPending(disk,original);
    assert.deepEqual(readConversationPending(disk,'chat-a'),original);
    assert.deepEqual(recoverConversationRequest({...original,state:'unknown'},'chat-a'),original);
    assert.equal(recoverConversationRequest(original,'chat-b'),null);
    assert.equal(recoverConversationRequest({...original,revisionIntentId:undefined},'chat-a'),null);
    assert.equal(recoverConversationRequest({...original,revisionParent:undefined},'chat-a'),null);
    assert.equal(recoverConversationRequest({...original,revisionParent:{...original.revisionParent,candidateDigest:'invalid'}},'chat-a'),null);
    assert.equal(recoverConversationRequest({...original,revisionParent:{...original.revisionParent,projectId:'project-b'}},'chat-a'),null);
    assert.equal(recoverConversationRequest({...original,planSubmission:{...original.planSubmission,plan:{...plan,[workflow==='hmi-view-name-v1'?'name':'text']:'未请求'}}},'chat-a'),null);
  }
});
test('an uncertain HMI revision is recovered per conversation without switching the binding',async()=>{
  const original={...conversationTaskRequest(binding(),{request:'把画面名称“第一版”改为“第二版”',revision:hash,consent:true,clientRequestId:'lost-hmi-revision',workflow:'hmi-view-name-v1'}),
    revisionParent:{taskId,candidateDigest:'d'.repeat(64)},revisionIntentId:'intent-original',planSubmission:{schemaVersion:1,plan:{viewId:'v-one',name:'第二版'},route:{provider:'deepseek',model:'model-a'}}};
  const disk=memory(),posts=[];let b={...binding('chat-a','project-b',2),pendingRequests:[{...original,state:'unknown'}]};
  const api=async(route,body)=>{
    if(route.startsWith('conversations?'))return structuredClone(b);
    if(route==='status')return {project:{id:'project-b'},projects:[{id:'project-a'},{id:'project-b'}]};
    if(route==='conversations/tasks'){
      posts.push(structuredClone(body));assert.deepEqual(body,original);
      b={...b,pendingRequests:[],taskRefs:[{projectId:original.projectId,taskId,clientRequestId:original.clientRequestId}]};
      return {conversationId:'chat-a',task:{projectId:original.projectId,taskId},duplicate:true};
    }
    throw Error('unexpected route '+route);
  };
  const contexts=createConversationContexts({api,storage:()=>disk,interval:60000}),controller=contexts.get('chat-a');
  const stop=controller.subscribe(()=>{});
  const until=async predicate=>{for(let i=0;i<80&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};
  try{
    await until(()=>controller.snapshot().pending!==null);
    assert.deepEqual(controller.snapshot().pending,original);assert.deepEqual(readConversationPending(disk,'chat-a'),original);
    await controller.bind('project-a');assert.equal(posts.length,0);assert.equal(controller.snapshot().binding.projectId,'project-b');
    await controller.retryPending();assert.equal(posts.length,1);assert.equal(controller.snapshot().pending,null);
    assert.equal(readConversationPending(disk,'chat-a'),null);assert.equal(controller.snapshot().binding.projectId,'project-b');
  }finally{stop();contexts.dispose();}
});
test('task list shows only this conversation references and review fixes task identity',()=>{
  const b={...binding(),taskRefs:[{projectId:'project-a',taskId}]};
  const task={projectId:'project-a',taskId,status:'awaiting_review',candidate:{candidateDigest:hash}};
  const list={projectId:'project-a',tasks:[task,{...task,taskId:'task-'+'2'.repeat(32)}]};
  assert.deepEqual(referenceTasks(b,list),[task]);assert.deepEqual(referenceTasks({...b,projectId:'project-b'},list),[]);
  const target=reviewTarget(task);assert.deepEqual(reviewedCandidate(task,target),{projectId:'project-a',taskId,candidateDigest:hash});
  assert.equal(reviewedCandidate({...task,taskId:'task-'+'3'.repeat(32)},target),null);
});
test('overview navigation is presentation-only and never mutates bindings',()=>{
  const nav=createConversationNavigation();let changes=0;const remove=nav.subscribe(()=>changes++);
  nav.request({projectId:'project-a',taskId});const one=nav.snapshot();assert.equal(one.taskId,taskId);
  nav.request({projectId:'project-b'});nav.clear(one);assert.equal(nav.snapshot().projectId,'project-b');
  nav.clear(nav.snapshot());assert.equal(nav.snapshot(),null);assert.equal(changes,3);remove();
});

test('dock Runtime label keeps shared unknown and occupied state distinct from no local instance',()=>{
  const snapshot={project:{id:'project-a'},session:{active:false,id:null,phase:'idle'},runtimeOwner:null};
  assert.equal(runtimeDockLabel(snapshot,'project-a'),'本工程未创建');
  assert.equal(runtimeDockLabel({...snapshot,runtimeOwner:{state:'unknown'}},'project-a'),'共享 Runtime 状态无法核验');
  assert.equal(runtimeDockLabel({...snapshot,runtimeOwner:{sessionId:'other',state:'owned'}},'project-a'),'共享 Runtime 被其他入口占用');
  assert.equal(runtimeDockLabel({...snapshot,session:{active:true,id:'own'},runtimeOwner:{sessionId:'own'},observerFresh:false},'project-a'),'运行状态未知');
  const live={...snapshot,session:{active:true,id:'own',runtimeState:'RUNNING'},runtimeOwner:{sessionId:'own'},observerFresh:true,state:{runtimeState:'STOPPED',observedAt:10}};
  assert.equal(runtimeDockLabel(live,'project-a',11000),'已停止');
  assert.equal(runtimeDockLabel({...live,state:{observedAt:10}},'project-a',11000),'状态未确认','historical session state cannot replace a current observation');
  for(const observedAt of [undefined,NaN,12.1,9])assert.equal(runtimeDockLabel({...live,state:{runtimeState:'RUNNING',observedAt}},'project-a',11000),'运行状态未知');
  assert.equal(runtimeDockLabel({...live,state:{runtimeState:'RUNNING',observedAt:10}},'project-a',11000),'运行中');
  assert.equal(runtimeDockLabel(live,'project-a',12000),'运行状态未知');
  assert.equal(runtimeDockLabel({...live,phase:'stopping'},'project-a',11000),'正在结束');
  assert.equal(runtimeDockLabel({...live,phase:'building'},'project-a',11000),'正在准备');
  assert.equal(runtimeDockLabel(snapshot,'project-b'),'未核验');
  assert.equal(runtimeDockLabel({...snapshot,session:{active:false,id:'previous',phase:'ended'}},'project-a'),'已结束');
});

test('native header binds once, isolates sessions and restores the original candidate request',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const deps=packages,{build}=buildTools;
  const React=deps('react'),{JSDOM,VirtualConsole}=deps('jsdom');
  const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:55112',pretendToBeVisual:true,virtualConsole:vc});
  const previous={window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator,fetch:globalThis.fetch};
  Object.defineProperty(globalThis,'window',{configurable:true,writable:true,value:dom.window});Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:dom.window.document});Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:dom.window.navigator});
  const {createRoot}=deps('react-dom/client');
  const binds=new Map([['chat-a',binding('chat-a',null,0)],['chat-b',binding('chat-b',null,0)]]),posts=[];
  const firstTask={projectId:'project-a',taskId,clientRequestId:'first-native-request'};
  const recoveredTask={projectId:'project-a',taskId:'task-'+'2'.repeat(32)};
  const original={...conversationTaskRequest(binding(),{request:'Change the title',revision:hash,consent:true,clientRequestId:'lost-native-request',workflow:'joint-ai-v1'}),
    planSubmission:{schemaVersion:1,plan:{hmi:{title:'6'}},route:{provider:'model-b',model:'selected-model'}}};
  const response=value=>({ok:true,status:200,json:async()=>value});
  globalThis.fetch=async(url,options={})=>{
    const u=new URL(url,'http://127.0.0.1:55112'),body=options.body?JSON.parse(options.body):null;
    if(body)posts.push({path:u.pathname,body});
    if(u.pathname==='/api/plcdev/conversations')return response(structuredClone(binds.get(u.searchParams.get('conversationId'))));
    if(u.pathname==='/api/plcdev/status')return response({project:{id:'project-a'},projects:[{id:'project-a',name:'工程 A'},{id:'project-b',name:'工程 B'}],session:{active:false},observerFresh:false});
    if(u.pathname==='/api/plcdev/conversations/bind'){const b=binds.get(body.conversationId);assert.equal(body.expectedVersion,b.version);b.projectId=body.projectId;b.version++;return response(structuredClone(b));}
    if(u.pathname==='/api/plcdev/conversations/tasks'){
      assert.deepEqual(body,original,'Recovery must retain the original project, version, plan, route and request ID');
      const b=binds.get(body.conversationId);b.taskRefs.push({...recoveredTask,clientRequestId:body.clientRequestId});b.pendingRequests=[];
      return response({conversationId:body.conversationId,task:recoveredTask,duplicate:true});
    }
    throw new Error('Unexpected route '+u.pathname);
  };
  const bundle=await build({entryPoints:[resolve(root,'software/dsh-plcdev/src/client/ConversationHeader.tsx')],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(deps,module,module.exports);
  const {ConversationHeader}=module.exports,reactRoot=createRoot(dom.window.document.getElementById('root')),nav=createConversationNavigation(),reviews=[],contexts=createConversationContexts();
  const wait=(ms=90)=>new Promise(done=>setTimeout(done,ms));
  const waitFor=async predicate=>{for(let i=0;i<60&&!predicate();i++)await wait(50);assert.ok(predicate(),'expected UI state did not arrive');};
  const render=id=>reactRoot.render(React.createElement(ConversationHeader,{key:id,sessionId:id,contexts,onProject:()=>{},onPicker:()=>{},onReview:(session,t)=>reviews.push({session,...t}),navigation:nav}));
  const doc=()=>dom.window.document;
  const button=text=>{const b=[...doc().querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,'Button '+text);assert.equal(b.disabled,false,'Enabled '+text);return b;};
  const click=async text=>{await waitFor(()=>[...doc().querySelectorAll('button')].some(b=>b.textContent===text&&!b.disabled));button(text).click();await wait();};
  const choose=async id=>{const select=doc().querySelector('select');select.value=id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait();};
  try{
    render('chat-a');await waitFor(()=>contexts.get('chat-a').snapshot().binding?.conversationId==='chat-a');assert.equal(posts.length,0);await contexts.get('chat-a').bind('project-a');await wait();await click('⋯');
    assert.equal(binds.get('chat-a').projectId,'project-a');assert.equal(posts.filter(x=>x.path.endsWith('/bind')).length,1);
    assert.equal(doc().querySelector('textarea'),null,'The host composer remains the sole requirement input');
    // A native tool has already created this task; the header only reads its durable reference.
    binds.get('chat-a').taskRefs=[firstTask];contexts.get('chat-a').refresh();await wait();
    assert.ok(!doc().body.textContent.includes('历史更改'),'history is owned by the native records tab');
    nav.request({sessionId:'chat-a',projectId:'project-a',taskId});await wait();assert.equal(reviews[0].session,'chat-a');assert.equal(reviews[0].taskId,taskId);
    render('chat-b');await wait();assert.equal(doc().querySelector('.pc-context'),null,'ordinary chat has no engineering header; the start screen owns the PLCdev choice');assert.ok(!doc().body.textContent.includes('历史更改'));assert.equal(binds.get('chat-b').projectId,null);
    render('chat-a');await wait();await click('⋯');assert.equal(contexts.get('chat-a').snapshot().binding.taskRefs[0].taskId,taskId);
    // The candidate exists despite a lost receipt; another client subsequently changed the binding.
    const a=binds.get('chat-a');a.pendingRequests=[{...original,state:'unknown'}];a.projectId='project-b';a.version++;
    render('chat-b');await wait();render('chat-a');await wait();await click('⋯');
    const before=posts.length;await contexts.get('chat-a').bind('project-a');assert.equal(posts.length,before,'Unresolved submission blocks a new binding change');
    assert.deepEqual(readConversationPending(dom.window.localStorage,'chat-a'),original);
    await click('以原请求编号核对／重试');
    assert.equal(posts.filter(x=>x.path.endsWith('/conversations/tasks')).length,1);
    assert.equal(readConversationPending(dom.window.localStorage,'chat-a'),null);
    assert.equal(binds.get('chat-a').projectId,'project-b');assert.equal(binds.get('chat-a').taskRefs.length,2);
    assert.equal(contexts.get('chat-a').snapshot().pending,null);assert.ok(contexts.get('chat-a').snapshot().binding.taskRefs.some(t=>t.taskId===taskId));
    assert.equal(posts.some(x=>x.path.includes('/action')),false);assert.deepEqual(errors,[]);
  }finally{
    reactRoot.unmount();contexts.dispose();dom.window.close();
    for(const [key,value]of Object.entries(previous))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
});

test('host registers session-scoped slots and detaches navigation without Runtime actions',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const deps=packages;
  const {build}=buildTools;
  const bundle=await build({entryPoints:[resolve(root,'software/dsh-plcdev/src/client/index.tsx')],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(deps,module,module.exports);
  const registrations=[],effects=[],listeners=new Map(),navigation=[],tabs=[];const previous=globalThis.window;
  globalThis.window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const turnReads=[];
  const ctx={slots:{inject:(_name,fn)=>fn(),register:(definition,component)=>{registrations.push({definition,component});return()=>{};}},layout:{selectPanel:id=>navigation.push(id)},sidebarRight:{openTabIn:(...args)=>tabs.push(args)},sidebarRightTabs:{register:def=>{assert.ok(['plcdev-candidate-review','plcdev-project'].includes(def.kind));return()=>{};}},effect:fn=>effects.push(fn()),inject:(services,fn)=>{if(services.includes('uiConversation'))fn({...ctx,sessions:{binding:id=>({sessionId:id})},uiConversation:{binding:binding=>({target:target=>({getSnapshot:()=>({nodes:{turnDataSource:(turn,kind)=>{turnReads.push({binding,target,turn,kind});return ['exact-turn-source'];}}})})})}});}};
  try{
    module.exports.apply(ctx);
    const names=registrations.map(r=>r.definition.name);
    assert.ok(!names.includes('conversation.input.dock'));assert.ok(names.includes('conversation.session.header.utilities'));assert.ok(names.includes('sidebar.right.pane.tab'));
    const header=registrations.find(r=>r.definition.name==='conversation.session.header.utilities').definition.inject('chat-a');
    listeners.get('plcdev:open-conversation')({detail:{projectId:'project-a',sessionId:'chat-a'}});assert.deepEqual(navigation,[null]);
    assert.equal(header.navigation.snapshot().projectId,'project-a');
    header.onReview('chat-a',{projectId:'project-a',taskId});assert.deepEqual(tabs,[['chat-a','plcdev-candidate-review',{params:{projectId:'project-a',taskId}}]]);
    const tool=registrations.find(r=>r.definition.name==='tool.call.toolview'&&r.definition.key==='plcdev_propose_joint').definition.inject('chat-tool-owner');
    tool.onReviewTask({projectId:'project-a',taskId});assert.deepEqual(tabs.at(-1),['chat-tool-owner','plcdev-candidate-review',{params:{projectId:'project-a',taskId}}]);
    const tail=registrations.find(r=>r.definition.name==='conversation.chat.turnTail').definition.inject('chat-turn-owner');
    assert.equal(tail.sessionId,'chat-turn-owner');assert.deepEqual(tail.keyedHooks.plcdevTurnTools('7'),['exact-turn-source']);
    assert.deepEqual(turnReads,[{binding:{sessionId:'chat-turn-owner'},target:'chat',turn:7,kind:'tool-call'}]);
    tail.onReviewTask({projectId:'project-a',taskId});assert.equal(tabs.at(-1)[0],'chat-turn-owner');
    header.onProject('chat-a','project-b');assert.equal(tabs.at(-1)[0],'chat-a');assert.equal(tabs.at(-1)[1],'plcdev-project');
    effects.reverse().forEach(dispose=>dispose?.());assert.equal(listeners.size,0);
  }finally{globalThis.window=previous;}
});

test('native review restores exact conversation bookmark after a fresh document without cross-session fallback',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const deps=packages;
  const {build}=buildTools;
  const React=deps('react'),{JSDOM,VirtualConsole}=deps('jsdom');
  const previous={window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator,fetch:globalThis.fetch};
  let dom,reactRoot;const errors=[],reads=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  function newDocument(){dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:55112',pretendToBeVisual:true,virtualConsole:vc});for(const key of ['window','document','navigator'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});}
  newDocument();const {createRoot}=deps('react-dom/client');
  const bundle=await build({entryPoints:[resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx')],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(deps,module,module.exports);const {ConversationReview}=module.exports;
  globalThis.fetch=async(url,options={})=>{assert.ok(!options.body,'Review recovery must not issue any mutation');const u=new URL(url,'http://127.0.0.1:55112');if(u.pathname.endsWith('/conversations'))return {ok:true,status:200,json:async()=>({conversationId:u.searchParams.get('conversationId'),projectId:'project-a',version:1,taskRefs:u.searchParams.get('conversationId')==='chat-a'?[{projectId:'project-a',taskId},{projectId:'project-b',taskId}]:[],pendingRequests:[]})};assert.equal(u.pathname,'/api/plcdev/tasks');const project=u.searchParams.get('project');reads.push(project);return {ok:true,status:200,json:async()=>({projectId:project,projectRevision:hash,tasks:project==='project-a'?[{projectId:project,taskId,request:'EXACT-A-CANDIDATE',status:'awaiting_review',candidate:{candidateDigest:hash}}]:[]})};};
  const wait=()=>new Promise(done=>setTimeout(done,90));
  const render=(sessionId,params)=>reactRoot.render(React.createElement(ConversationReview,{sessionId,onOverview:()=>{},useTabInfo:()=>({tab:{navigation:{params}}})}));
  try{
    reactRoot=createRoot(dom.window.document.getElementById('root'));render('chat-a',{projectId:'project-a',taskId});await wait();assert.ok(dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));
    const saved=dom.window.localStorage.getItem(REVIEW_PREFIX+'chat-a');assert.equal(JSON.parse(saved).conversationId,'chat-a');
    reactRoot.unmount();dom.window.close();newDocument();dom.window.localStorage.setItem(REVIEW_PREFIX+'chat-a',saved);reactRoot=createRoot(dom.window.document.getElementById('root'));
    render('chat-a',undefined);await wait();assert.ok(dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));assert.equal(reads.at(-1),'project-a');
    const before=reads.length;render('chat-b',undefined);await wait();assert.ok(dom.window.document.body.textContent.includes('未指定有效的工程候选'));assert.ok(!dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));assert.equal(reads.length,before);
    dom.window.localStorage.setItem(REVIEW_PREFIX+'chat-b',saved);render('chat-b',undefined);await wait();assert.equal(reads.length,before);
    render('chat-b',{projectId:'project-a',taskId});await wait();assert.match(dom.window.document.body.textContent,/此候选不属于当前会话/);assert.equal(reads.length,before);
    render('chat-a',{projectId:'invalid project',taskId});await wait();assert.ok(dom.window.document.body.textContent.includes('未指定有效的工程候选'));assert.equal(reads.length,before);
    render('chat-a',{projectId:'project-b',taskId});await wait();assert.equal(reads.at(-1),'project-b');assert.ok(dom.window.document.body.textContent.includes('未回退到其他候选'));assert.ok(!dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));
    assert.deepEqual(errors,[]);
  }finally{reactRoot?.unmount();dom?.window.close();for(const [key,value]of Object.entries(previous))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
});
