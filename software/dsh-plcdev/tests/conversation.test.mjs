import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('native dock UI binds explicitly, isolates sessions, restores candidates and retries original outbox',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const deps=packages;
  const {build}=buildTools;
  const React=deps('react'),{JSDOM,VirtualConsole}=deps('jsdom');
  const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:55112',pretendToBeVisual:true,virtualConsole:vc});
  const previous={window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator,fetch:globalThis.fetch};
  Object.defineProperty(globalThis,'window',{configurable:true,writable:true,value:dom.window});Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:dom.window.document});Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:dom.window.navigator});
  const {createRoot}=deps('react-dom/client');
  const binds=new Map([['chat-a',binding('chat-a',null,0)],['chat-b',binding('chat-b',null,0)]]),taskLists=new Map([['project-a',[]],['project-b',[]]]),posts=[];
  let dropNext=false,lastPending=null,created=0;
  const response=value=>({ok:true,status:200,json:async()=>value});
  globalThis.fetch=async(url,options={})=>{
    const u=new URL(url,'http://127.0.0.1:55112'),body=options.body?JSON.parse(options.body):null;
    if(body)posts.push({path:u.pathname,body});
    if(u.pathname==='/api/plcdev/conversations')return response(structuredClone(binds.get(u.searchParams.get('conversationId'))));
    if(u.pathname==='/api/plcdev/status'){const p=u.searchParams.get('project')||'project-a';return response({project:{id:p,name:p},projects:[{id:'project-a',name:'工程 A'},{id:'project-b',name:'工程 B'}],session:{active:false},observerFresh:false});}
    if(u.pathname==='/api/plcdev/tasks'){const p=u.searchParams.get('project');return response({projectId:p,projectRevision:hash,tasks:taskLists.get(p),capabilities:{savedRevisionCandidate:true}});}
    if(u.pathname==='/api/plcdev/conversations/bind'){const b=binds.get(body.conversationId);assert.equal(body.expectedVersion,b.version);b.projectId=body.projectId;b.version++;return response(structuredClone(b));}
    if(u.pathname==='/api/plcdev/conversations/tasks'){
      const b=binds.get(body.conversationId);
      if(dropNext){dropNext=false;lastPending=body;b.pendingRequests=[{...body,state:'unknown'}];throw new Error('lost response');}
      if(lastPending){assert.deepEqual(body,lastPending);lastPending=null;}
      const id='task-'+String(++created).padStart(32,'0'),t={projectId:body.projectId,taskId:id,request:body.request,status:'awaiting_review',candidate:{candidateDigest:hash}};
      taskLists.get(body.projectId).push(t);b.taskRefs.push({projectId:body.projectId,taskId:id,clientRequestId:body.clientRequestId});b.pendingRequests=[];
      return response({conversationId:body.conversationId,task:t});
    }
    throw new Error('Unexpected route '+u.pathname);
  };
  const bundle=await build({entryPoints:[resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx')],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(deps,module,module.exports);
  const {ConversationDock}=module.exports,reactRoot=createRoot(dom.window.document.getElementById('root')),nav=createConversationNavigation(),reviews=[];
  const wait=(ms=90)=>new Promise(done=>setTimeout(done,ms));
  const render=id=>reactRoot.render(React.createElement(ConversationDock,{key:id,sessionId:id,onOverview:()=>{},onReview:(session,t)=>reviews.push({session,...t}),navigation:nav}));
  const doc=()=>dom.window.document;
  const button=text=>{const b=[...doc().querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,'Button '+text);assert.equal(b.disabled,false,'Enabled '+text);return b;};
  const click=async text=>{button(text).click();await wait();};
  const choose=async id=>{const select=doc().querySelector('select');select.value=id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait();};
  const input=async()=>{const area=doc().querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(area,'rename Count to BatchCount');area.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();doc().querySelector('input[type="checkbox"]').click();await wait();};
  try{
    render('chat-a');await wait();assert.equal(posts.length,0);await click('工程与任务');await choose('project-a');assert.equal(posts.length,0);await click('关联工程');assert.equal(binds.get('chat-a').projectId,'project-a');
    await input();await click('创建规则候选');assert.equal(created,1);await click('审阅');assert.equal(reviews[0].session,'chat-a');assert.equal(reviews[0].projectId,'project-a');
    render('chat-b');await wait();assert.ok(doc().body.textContent.includes('尚未关联工程'));assert.ok(!doc().body.textContent.includes('待审阅'));assert.equal(binds.get('chat-b').projectId,null);
    render('chat-a');await wait();await click('工程与任务');assert.ok(doc().body.textContent.includes('待审阅'));assert.equal(created,1);
    dropNext=true;await input();await click('创建规则候选');assert.ok(doc().body.textContent.includes('提交结果待核对'));
    const original=lastPending;binds.get('chat-a').projectId='project-b';binds.get('chat-a').version++;
    render('chat-b');await wait();render('chat-a');await wait();await click('工程与任务');await click('以原请求编号核对／重试');
    assert.equal(created,2);assert.equal(posts.filter(x=>x.path.endsWith('/conversations/tasks')).at(-1).body.projectId,'project-a');assert.equal(original.expectedVersion,1);assert.ok(doc().body.textContent.includes('之前工程：工程 A'));
    assert.equal(posts.some(x=>x.path.includes('/action')),false);assert.deepEqual(errors,[]);
  }finally{
    reactRoot.unmount();dom.window.close();
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
  const ctx={slots:{inject:(_name,fn)=>fn(),register:(definition,component)=>{registrations.push({definition,component});return()=>{};}},layout:{selectPanel:id=>navigation.push(id)},sidebarRight:{openTabIn:(...args)=>tabs.push(args)},sidebarRightTabs:{register:def=>{assert.equal(def.kind,'plcdev-candidate-review');return()=>{};}},effect:fn=>effects.push(fn())};
  try{
    module.exports.apply(ctx);
    const names=registrations.map(r=>r.definition.name);
    assert.ok(names.includes('conversation.input.dock'));assert.ok(names.includes('conversation.session.header.utilities'));assert.ok(names.includes('sidebar.right.pane.tab'));
    const dock=registrations.find(r=>r.definition.name==='conversation.input.dock').definition.inject('chat-a');
    listeners.get('plcdev:open-conversation')({detail:{projectId:'project-a'}});assert.deepEqual(navigation,[null]);
    assert.equal(dock.navigation.snapshot().projectId,'project-a');
    dock.onReview('chat-a',{projectId:'project-a',taskId});assert.deepEqual(tabs,[['chat-a','plcdev-candidate-review',{params:{projectId:'project-a',taskId}}]]);
    const tool=registrations.find(r=>r.definition.name==='tool.call.toolview'&&r.definition.key==='plcdev_propose_joint').definition.inject('chat-tool-owner');
    tool.onReviewTask({projectId:'project-a',taskId});assert.deepEqual(tabs.at(-1),['chat-tool-owner','plcdev-candidate-review',{params:{projectId:'project-a',taskId}}]);
    dock.onOverview();assert.equal(navigation.at(-1),'plcdev-workbench');
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
