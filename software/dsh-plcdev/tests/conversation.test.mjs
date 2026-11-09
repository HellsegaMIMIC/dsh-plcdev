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
  assert.equal(runtimeDockLabel({...snapshot,session:{active:true,id:'own'},runtimeOwner:{sessionId:'own'},observerFresh:false},'project-a'),'运行数据失效');
  assert.equal(runtimeDockLabel({...snapshot,session:{active:true,id:'own'},runtimeOwner:{sessionId:'own'},observerFresh:true,state:{runtimeState:'STOPPED'}},'project-a'),'已停止');
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
  const render=id=>reactRoot.render(React.createElement(ConversationHeader,{key:id,sessionId:id,contexts,onProject:()=>{},onReview:(session,t)=>reviews.push({session,...t}),navigation:nav}));
  const doc=()=>dom.window.document;
  const button=text=>{const b=[...doc().querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,'Button '+text);assert.equal(b.disabled,false,'Enabled '+text);return b;};
  const click=async text=>{button(text).click();await wait();};
  const choose=async id=>{const select=doc().querySelector('select');select.value=id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait();};
  try{
    render('chat-a');await wait();assert.equal(posts.length,0);await click('▾');await choose('project-a');
    assert.equal(binds.get('chat-a').projectId,'project-a');assert.equal(posts.filter(x=>x.path.endsWith('/bind')).length,1);
    assert.equal(doc().querySelector('textarea'),null,'The host composer remains the sole requirement input');
    // A native tool has already created this task; the header only reads its durable reference.
    binds.get('chat-a').taskRefs=[firstTask];contexts.get('chat-a').refresh();await wait();
    await click('查看 工程 A 的更改');assert.equal(reviews[0].session,'chat-a');assert.equal(reviews[0].taskId,taskId);
    render('chat-b');await wait();assert.ok(doc().body.textContent.includes('选择工程'));assert.ok(!doc().body.textContent.includes('历史更改'));assert.equal(binds.get('chat-b').projectId,null);
    render('chat-a');await wait();await click('▾');assert.ok(doc().body.textContent.includes('查看 工程 A 的更改'));
    // The candidate exists despite a lost receipt; another client subsequently changed the binding.
    const a=binds.get('chat-a');a.pendingRequests=[{...original,state:'unknown'}];a.projectId='project-b';a.version++;
    render('chat-b');await wait();render('chat-a');await wait();await click('▾');
    assert.equal(doc().querySelector('select').disabled,true,'Unresolved submission blocks a new binding change');
    assert.deepEqual(readConversationPending(dom.window.localStorage,'chat-a'),original);
    await click('以原请求编号核对／重试');
    assert.equal(posts.filter(x=>x.path.endsWith('/conversations/tasks')).length,1);
    assert.equal(readConversationPending(dom.window.localStorage,'chat-a'),null);
    assert.equal(binds.get('chat-a').projectId,'project-b');assert.equal(binds.get('chat-a').taskRefs.length,2);
    assert.equal(contexts.get('chat-a').snapshot().pending,null);assert.ok(doc().body.textContent.includes('查看 工程 A 的更改'));
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
  const ctx={slots:{inject:(_name,fn)=>fn(),register:(definition,component)=>{registrations.push({definition,component});return()=>{};}},layout:{selectPanel:id=>navigation.push(id)},sidebarRight:{openTabIn:(...args)=>tabs.push(args)},sidebarRightTabs:{register:def=>{assert.ok(['plcdev-candidate-review','plcdev-project'].includes(def.kind));return()=>{};}},effect:fn=>effects.push(fn())};
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
  globalThis.fetch=async(url,options={})=>{assert.ok(!options.body,'Review recovery must not issue any mutation');const u=new URL(url,'http://127.0.0.1:55112');assert.equal(u.pathname,'/api/plcdev/tasks');const project=u.searchParams.get('project');reads.push(project);return {ok:true,status:200,json:async()=>({projectId:project,projectRevision:hash,tasks:project==='project-a'?[{projectId:project,taskId,request:'EXACT-A-CANDIDATE',status:'awaiting_review',candidate:{candidateDigest:hash}}]:[]})};};
  const wait=()=>new Promise(done=>setTimeout(done,90));
  const render=(sessionId,params)=>reactRoot.render(React.createElement(ConversationReview,{sessionId,onOverview:()=>{},useTabInfo:()=>({tab:{navigation:{params}}})}));
  try{
    reactRoot=createRoot(dom.window.document.getElementById('root'));render('chat-a',{projectId:'project-a',taskId});await wait();assert.ok(dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));
    const saved=dom.window.localStorage.getItem(REVIEW_PREFIX+'chat-a');assert.equal(JSON.parse(saved).conversationId,'chat-a');
    reactRoot.unmount();dom.window.close();newDocument();dom.window.localStorage.setItem(REVIEW_PREFIX+'chat-a',saved);reactRoot=createRoot(dom.window.document.getElementById('root'));
    render('chat-a',undefined);await wait();assert.ok(dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));assert.equal(reads.at(-1),'project-a');
    const before=reads.length;render('chat-b',undefined);await wait();assert.ok(dom.window.document.body.textContent.includes('未指定有效的工程候选'));assert.ok(!dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));assert.equal(reads.length,before);
    dom.window.localStorage.setItem(REVIEW_PREFIX+'chat-b',saved);render('chat-b',undefined);await wait();assert.equal(reads.length,before);
    render('chat-a',{projectId:'invalid project',taskId});await wait();assert.ok(dom.window.document.body.textContent.includes('未指定有效的工程候选'));assert.equal(reads.length,before);
    render('chat-a',{projectId:'project-b',taskId});await wait();assert.equal(reads.at(-1),'project-b');assert.ok(dom.window.document.body.textContent.includes('未回退到其他候选'));assert.ok(!dom.window.document.body.textContent.includes('EXACT-A-CANDIDATE'));
    assert.deepEqual(errors,[]);
  }finally{reactRoot?.unmount();dom?.window.close();for(const [key,value]of Object.entries(previous))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
});
