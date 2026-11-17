import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge.mjs';
import { createConversationRoutes } from '../src/conversations.mjs';

const A = 'user-' + 'a'.repeat(32), B = 'user-' + 'b'.repeat(32);
const TOKEN = 'test_capability_'.repeat(3);
const INSTANCE = 'd'.repeat(32), HASH = 'e'.repeat(64), TASK = 'task-' + 'f'.repeat(32);
const candidate = projectId => ({ projectId, taskId: TASK, candidateDigest: HASH, status: 'review' });
const runtimeEvents = projectId => ({ok:true,schemaVersion:1,projectId,observedAt:Date.now()/1000,currentSessionId:'session-A',projectRevision:null,
  events:[{id:'evt-'+'1'.repeat(32),projectId,source:'runtime',severity:'error',phase:'通信',summary:'采样失效',detail:'核对实例',raw:'',
    firstAt:Date.now()/1000-10,lastAt:Date.now()/1000-9,count:1,status:'active',sessionId:'session-A',projectRevision:null,programHash:HASH,
    origin:'runtime/state',variables:[{name:'Count',value:'2',quality:'historical'}]}],
  sources:['compiler','runtime','fuxa','oip','plcdev'].map(id=>({id,state:'partial',label:id,reason:'Structured observations only'}))});
const inspection = projectId => ({ok:true,schemaVersion:1,projectId,projectRevision:HASH,source:'saved-files-only',
  editorState:{state:'unknown',message:'Only saved files'},resources:[{id:'plc/project.json',kind:'plc',label:'project.json',path:'plc/project.json',sha256:HASH}],
  signals:[{id:'count',label:'Count',path:'INSTANCE0.Count',type:'INT',access:'read',source:{kind:'plc',path:'plc/project.json'},hmi:[],scene:[],status:'declared'}],
  readback:{state:'untracked',baselineRevision:null,observedRevision:HASH,capturedRevision:null,acknowledgedRevision:null,changes:[],layoutOnly:false,lastReview:null},
  capabilities:{canCapture:true,canAcknowledgeLayout:false},limitations:[]});
const taskBody = (projectId = A) => ({
  projectId, request: '将 Count 改为 BatchCount', expectedRevision: HASH,
  executionScope: 'proposal', sourceBasis: 'saved_revision', clientRequestId: 'dsh-test-0001',
});
const actionBody = (projectId = A, action = 'tool') => ({
  projectId, sessionId: 'session-A', action, client: 'dsh-test', sequence: 1,
  expires: Date.now() / 1000 + 10, ...(action === 'tool' ? { tool: 'plc' } : {}),
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plcdev-dsh-bridge-'));
  const controllerFile = path.join(root, 'controller.json');
  const calls = [];
  const state = { instance: INSTANCE, projectOverride: null, sessionOverride: null, tasks: [], beforeReply: null, fault: null };
  let descriptor;
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : null;
    calls.push({ method: req.method, url: req.url, body, headers: req.headers });
    const url = new URL(req.url, 'http://127.0.0.1');
    const project = url.searchParams.get('project') ?? A;
    let value, status = 200;
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { status = 403; value = { ok: false }; }
    else if (url.pathname === '/api/status') value = {
      service: 'plcdev-workbench', schemaVersion: 3, instance: state.instance,
      agentTaskInputVersion: 'saved-revision-v1', projectInspectionVersion:1, runtimeEventsVersion:1, projectCatalog:{canCreate:true,canOpen:true}, capabilities:{canConfigureProject:true,canConfigureInterface:true},
      project: { id: state.projectOverride ?? project }, projects: [{ id: A }, { id: B }],
      session: { id: project === A ? 'session-A' : null, active: project === A, projectId: state.sessionOverride ?? project },
      otherSessions: project === B ? [{ id: 'session-A', projectId: A, active: true }] : [],
    };
    else if (['/api/agent/tasks','/api/agent/task-records','/api/agent/task-state'].includes(url.pathname) && req.method === 'GET')
      value = { ok: true, projectId: project, ...(url.pathname.endsWith('/task-records')?{}:{projectRevision:HASH}), tasks: state.tasks.filter(item => item.projectId === project) };
    else if(url.pathname === '/api/project-inspection') value=inspection(body?.projectId??project);
    else if(url.pathname === '/api/runtime-events') value=runtimeEvents(project);
    else if(url.pathname === '/api/fuxa/recovery' && req.method === 'GET')
      value = {ok:true,projectId:project,state:'pending',reasonCode:'pending',message:'private fixture path',transactionId:'test-id'};
    else if (url.pathname === '/api/agent/tasks' && req.method === 'POST') {
      let task = state.tasks.find(item => item.projectId === body.projectId);
      if (!task) { task = candidate(body.projectId); state.tasks.push(task); }
      value = { ok: true, task };
    } else if (url.pathname === '/api/agent/tasks/review-receipt') value = {ok:true,projectId:body.projectId,taskId:body.taskId,candidateDigest:body.candidateDigest,clientRequestId:body.clientRequestId,state:'unknown',reasonCode:'receipt_unconfirmed',keptProjectId:null,manifestPath:null,revision:null};
    else if (['/api/agent/tasks/open', '/api/agent/tasks/review'].includes(url.pathname)) value = { ok: true, ...body };
    else if (url.pathname === '/api/editor/resource-open') value = { ok:true,...body,state:'opened',mode:body.target==='candidate'?'preview':'project' };
    else if (url.pathname === '/api/editor/resource-status') value = {ok:true,...body,observationRevision:HASH,toolSync:{oip:{state:'pending_confirmation',message:'请在 OIP 确认打开工程。'}}};
    else if (url.pathname === '/api/action') value = { ok: true };
    else { status = 404; value = { ok: false }; }
    if (state.beforeReply) await state.beforeReply(req, value);
    if (state.abortReply?.(req)) {req.socket.destroy();return;}
    if (state.rawReply) {const raw=state.rawReply(req,value);if(raw!==null){res.writeHead(200,{'Content-Type':'application/json'});res.end(raw);return;}}
    if (state.fault) ({ value, status } = state.fault(req, value, status));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  descriptor = { base: 'http://127.0.0.1:' + server.address().port, token: TOKEN, instance: INSTANCE, root, pid: process.pid };
  await writeFile(controllerFile, JSON.stringify(descriptor));
  const config = { projectRoot: root, controllerFile, timeoutMs: 1000 };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, controllerFile, server, calls, state, descriptor, config,
    bridge: createBridge(config),
    async save(change) { Object.assign(descriptor, change); await writeFile(controllerFile, JSON.stringify(descriptor)); },
  };
}

test('result resource opener accepts only exact tool identity and fixed upstream route',async t=>{
 const f=await fixture(t),body={projectId:A,taskId:TASK,candidateDigest:HASH,target:'candidate',tool:'fuxa'};
 assert.equal((await f.bridge.resultResourceOpen(body)).state,'opened');
 const opens=()=>f.calls.filter(call=>call.url==='/api/editor/resource-open');assert.equal(opens().length,1);assert.deepEqual(opens()[0].body,body);
 for(const change of [{tool:'shell'},{target:'source'},{path:'C:/arbitrary'},{taskId:'../x'}])await assert.rejects(f.bridge.resultResourceOpen({...body,...change}));
 assert.equal(opens().length,1);
 for(const change of [{projectId:B},{candidateDigest:'b'.repeat(64)},{tool:'oip'},{target:'retained'}]){
  f.state.fault=(req,value,status)=>req.url==='/api/editor/resource-open'?{value:{...value,...change},status}:{value,status};
  await assert.rejects(f.bridge.resultResourceOpen(body),/归属/);
 }
});

test('OIP status uses only the fixed observation route and rejects changed response identity',async t=>{
 const f=await fixture(t),body={projectId:A,taskId:TASK,candidateDigest:HASH,target:'candidate',tool:'oip',launchId:'editor-'+'9'.repeat(32)};
 const observed=()=>f.calls.filter(call=>call.url==='/api/editor/resource-status');
 const result=await f.bridge.resultResourceStatus(body);assert.equal(result.toolSync.oip.state,'pending_confirmation');assert.equal(result.observationRevision,HASH);
 assert.equal(observed().length,1);assert.deepEqual(observed()[0].body,body);
 for(const change of [{tool:'shell'},{tool:'fuxa'},{target:'source'},{path:'F:/arbitrary'},{taskId:'../x'},{candidateDigest:'bad'},{launchId:'../x'},{launchId:'editor-short'},{conversationId:'unexpected'}])await assert.rejects(f.bridge.resultResourceStatus({...body,...change}));
 assert.equal(observed().length,1);
 for(const change of [{projectId:B},{taskId:'task-'+'a'.repeat(32)},{candidateDigest:'b'.repeat(64)},{tool:'fuxa'},{target:'retained'},{launchId:'editor-'+'a'.repeat(32)}]){
  f.state.fault=(req,value,status)=>req.url==='/api/editor/resource-status'?{value:{...value,...change},status}:{value,status};
  await assert.rejects(f.bridge.resultResourceStatus(body),/归属/);
 }
 assert.equal(f.calls.some(call=>call.url==='/api/editor/resource-open'||call.url==='/api/editor/prepare'||call.url==='/api/action'),false);
});

test('record and fresh-state reads use fixed GET endpoints without the planning route',async t=>{
 const f=await fixture(t);f.state.tasks=[candidate(A),candidate(B)];
 for(const route of ['task-records','task-state']){
  const result=await f.bridge.handle('GET','/api/plcdev/'+route+'?project='+A);
  assert.equal(result.status,200);assert.deepEqual(result.body.tasks,[candidate(A)]);
  assert.equal(Object.hasOwn(result.body,'projectRevision'),route==='task-state');
  assert.equal(f.calls.at(-1).url,'/api/agent/'+route+'?project='+A);assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.calls.at(-1).body,null);
 }
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(c=>c.method==='GET'&&!c.url.startsWith('/api/agent/tasks')&&!c.url.includes('inspect')));
 let revision=HASH;
 f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/agent/task-state')?{...value,projectRevision:revision}:value});
 assert.equal((await f.bridge.handle('GET','/api/plcdev/task-state?project='+A)).body.projectRevision,HASH);
 revision='1'.repeat(64);assert.equal((await f.bridge.handle('GET','/api/plcdev/task-state?project='+A)).body.projectRevision,revision);
 assert.equal(f.calls.filter(c=>c.url.startsWith('/api/agent/task-state')).length,3,'each completed state read reaches the controller again');
});

test('new lightweight routes reject writes, extra parameters and arbitrary destinations before connecting',async t=>{
 const f=await fixture(t);
 for(const route of ['task-records','task-state','runtime-events']){
  const endpoint='/api/plcdev/'+route;
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await f.bridge.handle(method,endpoint,{projectId:A,action:'keep'})).status,404);
  for(const raw of [endpoint,endpoint+'?project='+A+'&url=http://evil.test',endpoint+'?project='+A+'&project='+B,endpoint+'/review?project='+A,endpoint+'?project=../secret'])assert.ok((await f.bridge.handle('GET',raw)).status>=400);
  assert.equal((await f.bridge.handle('GET',endpoint+'?project='+A,{action:'keep'})).status,400);
 }
 assert.equal(f.calls.length,0);
});

test('runtime events use a read-only project route and bounded selected fields',async t=>{
 const f=await fixture(t);
 f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/runtime-events')?
   {...value,internalPath:'private-server-path',events:value.events.map(e=>({...e,raw:'redact '+TOKEN,planningInput:'private-model-source'}))}:value});
 const result=await f.bridge.handle('GET','/api/plcdev/runtime-events?project='+A);
 assert.equal(result.status,200);assert.equal(result.body.projectId,A);
 assert.equal(result.body.events[0].raw,'redact [redacted]');
 assert.equal(JSON.stringify(result).includes('private-'),false);
 assert.deepEqual(f.calls.map(c=>[c.method,c.url]),[['GET','/api/status?project='+A],['GET','/api/runtime-events?project='+A]]);
 assert.equal(result.body.events[0].sessionId,'session-A');
});

test('runtime events reject cross-project, malformed, oversized and incompatible evidence',async t=>{
 const f=await fixture(t),endpoint='/api/plcdev/runtime-events?project='+A;
 for(const mutate of [v=>({...v,projectId:B}),v=>({...v,events:v.events.map(e=>({...e,projectId:B}))}),
   v=>({...v,events:v.events.map(e=>({...e,count:0}))}),v=>({...v,events:v.events.map(e=>({...e,source:'shell'}))}),
   v=>({...v,events:v.events.map(e=>({...e,firstAt:Date.now()}))}),v=>({...v,events:v.events.map(e=>({...e,projectRevision:'bad'}))}),
   v=>({...v,events:v.events.map(e=>({...e,raw:'x'.repeat(32769)}))}),v=>({...v,events:Array(301).fill(v.events[0])}),
   v=>({...v,sources:[{id:'runtime',state:'available',label:'runtime'}]}),v=>({...v,events:v.events.map(e=>({...e,resolvedAt:Date.now()/1000}))})]){
   f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/runtime-events')?mutate(value):value});
   const result=await f.bridge.handle('GET',endpoint);
   assert.equal(result.status,503);assert.equal(result.body.code,'runtime_events_mismatch');assert.equal(JSON.stringify(result).includes(B),false);
 }
 f.calls.length=0;
 f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/status')?{...value,runtimeEventsVersion:undefined}:value});
 assert.equal((await f.bridge.handle('GET',endpoint)).body.code,'version_mismatch');
 assert.equal(f.calls.length,1,'incompatible controller does not receive the event read');
});

test('lightweight reads reject foreign records and incompatible current-revision evidence',async t=>{
 const f=await fixture(t);
 for(const route of ['task-records','task-state']){
  for(const changed of [{projectId:B},{tasks:[candidate(B)]},{tasks:[null]},{tasks:null}]){
   f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/agent/'+route)?{...value,...changed}:value});
   const result=await f.bridge.handle('GET','/api/plcdev/'+route+'?project='+A);
   assert.equal(result.status,503);assert.equal(result.body.code,'task_project_mismatch');assert.equal(JSON.stringify(result).includes(B),false);
  }
 }
 for(const projectRevision of [undefined,null,'not-a-revision']){
  f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/agent/task-state')?{...value,projectRevision}:value});
  assert.equal((await f.bridge.handle('GET','/api/plcdev/task-state?project='+A)).body.code,'task_revision_mismatch');
 }
 for(const projectRevision of [HASH,null]){
  f.state.fault=(req,value,status)=>({status,value:req.url.startsWith('/api/agent/task-records')?{...value,projectRevision}:value});
  assert.equal((await f.bridge.handle('GET','/api/plcdev/task-records?project='+A)).body.code,'task_records_mismatch');
 }
 assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('keep receipt uses a fixed read-only gateway and rejects mismatched or malformed evidence',async t=>{
 const f=await fixture(t),body={projectId:A,taskId:TASK,candidateDigest:HASH,expectedRevision:HASH,action:'keep',clientRequestId:'review-1'};
 const result=await f.bridge.reviewReceipt(body);
 assert.equal(result.state,'unknown');assert.equal(result.keptProjectId,null);
 assert.equal(f.calls.at(-1).url,'/api/agent/tasks/review-receipt');assert.deepEqual(f.calls.at(-1).body,body);
 assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review-receipt',body)).status,404,'no public general receipt proxy');
 for(const bad of [{...body,action:'undo'},{...body,taskId:'../x'},{...body,other:true}])await assert.rejects(f.bridge.reviewReceipt(bad));
 for(const changes of [{projectId:B},{candidateDigest:'b'.repeat(64)},{clientRequestId:'other'}, {state:'unknown',keptProjectId:B}, {reasonCode:'arbitrary'}, {extra:'secret'}, {state:'confirmed_registered',reasonCode:'none',keptProjectId:B,manifestPath:'relative/path',revision:HASH}]){
   f.state.fault=(req,value,status)=>req.url==='/api/agent/tasks/review-receipt'?{value:{...value,...changes},status}:{value,status};
   await assert.rejects(f.bridge.reviewReceipt(body));
 }
 f.state.fault=(req,value,status)=>req.url==='/api/agent/tasks/review-receipt'?{value:{...value,state:'confirmed_registered',reasonCode:'none',keptProjectId:B,manifestPath:path.join(f.root,'project.plcdev'),revision:HASH},status}:{value,status};
 assert.equal((await f.bridge.reviewReceipt(body)).state,'confirmed_registered');
 assert.ok(f.calls.every(call=>!['/api/action','/api/agent/tasks/review'].includes(call.url)));
});

test('editor handoff uses fixed controller routes, pins reply identity and never exposes connection tokens',async t=>{
 const f=await fixture(t),launchId='editor-'+'a'.repeat(32),nativeProjectPath=path.join(f.root,'retained','project.json'),editorToken='b'.repeat(64);
 f.state.fault=(req,value,status)=>{
  if(req.url==='/api/editor/prepare')return {status:200,value:{ok:true,launchId,sourceProjectId:A,projectId:B,revision:HASH,mode:'project',nativeProjectPath,projectName:'Saved copy'}};
  if(req.url==='/api/editor/open')return {status:200,value:{ok:true,launchId,projectId:B,nativeProjectPath,state:'failed',debug:editorToken}};
  if(req.url.startsWith('/api/agent/tasks/preview?'))return {status:200,value:{ok:true,projectId:A,taskId:TASK,candidateDigest:HASH,files:[]}};
  return {status,value};
 };
 const prepared=await f.bridge.editorPrepare({projectId:A,target:'retained',taskId:TASK,candidateDigest:HASH});assert.equal(prepared.projectId,B);
 const connection={schemaVersion:1,launchId,projectId:B,revision:HASH,sessionId:'chat',nativeProjectPath,token:editorToken,baseUrl:'http://127.0.0.1:3200/api/plcdev/editor-bridge',mode:'project',canSend:true};
 const opened=await f.bridge.editorOpen({launchId,connection});assert.equal(opened.state,'failed');assert.equal(JSON.stringify(opened).includes(editorToken),false);
 const preview=await f.bridge.candidatePreview({projectId:A,taskId:TASK,candidateDigest:HASH});assert.equal(preview.taskId,TASK);
 const count=f.calls.length;await assert.rejects(f.bridge.editorPrepare({projectId:A,target:'project',taskId:TASK}));assert.equal(f.calls.length,count);
 const fault=f.state.fault;f.state.fault=(req,value,status)=>{const r=fault(req,value,status);if(req.url==='/api/editor/prepare')r.value.sourceProjectId=B;return r;};
 await assert.rejects(f.bridge.editorPrepare({projectId:A,target:'retained',taskId:TASK,candidateDigest:HASH}));
 assert.ok(f.calls.every(c=>!['/api/action','/api/agent/tasks/review'].includes(c.url)));
});

test('project edit forwards a typed saved plan and parent while rejecting arbitrary operations',async t=>{
 const f=await fixture(t),plan={schemaVersion:1,changes:[{kind:'plc-source',path:'plc/pous/programs/main.st',expectedHash:HASH,content:'PROGRAM main\nEND_PROGRAM'}]};
 const body={...taskBody(),workflow:'project-edit-v1',planSubmission:{schemaVersion:1,plan,route:{provider:'deepseek-account',model:'deepseek-flash'}},revisionParent:{taskId:TASK,candidateDigest:HASH}};
 const response=await f.bridge.handle('POST','/api/plcdev/tasks',body);assert.equal(response.status,200,JSON.stringify(response.body));
 const sent=f.calls.find(c=>c.url==='/api/agent/tasks'&&c.method==='POST');assert.deepEqual(sent.body,body);
 const before=f.calls.length;
 for(const bad of [{...body,sourceBasis:'editor_current'},{...body,planSubmission:{...body.planSubmission,plan:{schemaVersion:1,changes:[{kind:'shell',command:'x'}]}}},{...body,planSubmission:{...body.planSubmission,plan:{...plan,extra:true}}}])assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',bad)).status,400);
 assert.equal(f.calls.length,before);
});

test('project edit transports the shared OpenPLC batch through the existing candidate endpoint',async t=>{
 const f=await fixture(t),plan={schemaVersion:1,changes:[{kind:'openplc-tools',calls:[{name:'create_pou',input:{name:'Pump',type:'function-block',language:'st'}},{name:'create_variable',input:{pouName:'Pump',name:'Run',type:'BOOL'}}]}]};
 const body={...taskBody(),workflow:'project-edit-v1',planSubmission:{schemaVersion:1,plan,route:{provider:'deepseek-account',model:'deepseek-flash'}}};
 const response=await f.bridge.handle('POST','/api/plcdev/tasks',body);assert.equal(response.status,200,JSON.stringify(response.body));
 assert.deepEqual(f.calls.find(c=>c.url==='/api/agent/tasks'&&c.method==='POST').body,body);
 const before=f.calls.length;
 const bad={...body,planSubmission:{...body.planSubmission,plan:{schemaVersion:1,changes:[{kind:'openplc-tools',calls:[{name:'create_pou',input:{},path:'outside'}]}]}}};
 assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',bad)).status,400);assert.equal(f.calls.length,before);
});

test('project inspection reads declared evidence through a fixed project-scoped endpoint',async t=>{
 const f=await fixture(t),r=await f.bridge.handle('GET','/api/plcdev/project-inspection?project='+B);
 assert.equal(r.status,200);assert.equal(r.body.projectId,B);assert.equal(r.body.editorState.state,'unknown');
 assert.equal(f.calls.at(-1).url,'/api/project-inspection?project='+B);assert.ok(f.calls.every(call=>call.method==='GET'));
 for(const suffix of ['', '?project='+B+'&path=elsewhere','?project='+B+'&project='+A]){
   assert.equal((await f.bridge.handle('GET','/api/plcdev/project-inspection'+suffix)).status,400);
 }
});

test('project readback validates exact actions and expected versions before forwarding',async t=>{
 const f=await fixture(t),body={projectId:B,action:'capture',expectedRevision:HASH,expectedBaseline:null};
 assert.equal((await f.bridge.handle('POST','/api/plcdev/project-inspection',body)).status,200);
 assert.equal(f.calls.at(-1).url,'/api/project-inspection');assert.deepEqual(f.calls.at(-1).body,body);
 for(const patch of [{action:'save'},{action:'discard'},{expectedRevision:'now'},{expectedBaseline:'none'},{path:'x'}]){
   const count=f.calls.length;
   assert.equal((await f.bridge.handle('POST','/api/plcdev/project-inspection',{...body,...patch})).status,400);
   assert.equal(f.calls.length,count);
 }
 assert.equal((await f.bridge.handle('POST','/api/plcdev/project-inspection',{...body,action:'acknowledge',expectedBaseline:HASH})).status,200);
 assert.ok(f.calls.every(call=>!['/api/action','/api/agent/tasks'].includes(call.url)));
});

test('project inspection refuses unverified controller versions and cross-project evidence',async t=>{
 const f=await fixture(t);
 f.state.fault=(req,value,status)=>req.url.startsWith('/api/status')?{value:{...value,projectInspectionVersion:undefined},status}:{value,status};
 assert.equal((await f.bridge.handle('GET','/api/plcdev/project-inspection?project='+A)).body.code,'version_mismatch');
 assert.equal(f.calls.length,1);
 for(const patch of [{projectId:B},{source:'editor-buffers'},{editorState:{state:'clean'}},{resources:[{path:'../outside',sha256:HASH}]}, {readback:{...inspection(A).readback,observedRevision:'b'.repeat(64)}}, {capabilities:{canCapture:true,canAcknowledgeLayout:true}}, {readback:{...inspection(A).readback,state:'current'}}]){
   f.state.fault=(req,value,status)=>req.url.startsWith('/api/project-inspection')?{value:{...value,...patch},status}:{value,status};
   assert.equal((await f.bridge.handle('GET','/api/plcdev/project-inspection?project='+A)).body.code,'inspection_mismatch');
 }
});

test('readonly numeric HMI candidate accepts an exact declared target and never a revision parent',async t=>{
 const f=await fixture(t),body={...taskBody(),workflow:'hmi-readonly-value-v1',request:'在画面 ID“v-a”添加信号 ID“count”的只读数值显示。',planSubmission:{schemaVersion:1,plan:{viewId:'v-a',signalId:'count'},route:{provider:'offline',model:'fixture'}}};
 assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
 assert.deepEqual(f.calls.at(-1).body.planSubmission.plan,body.planSubmission.plan);
 for(const changed of [{...body,revisionParent:{taskId:TASK,candidateDigest:HASH}}, {...body,request:body.request+'然后启动PLC。'}, {...body,planSubmission:{...body.planSubmission,plan:{viewId:'v-a',signalId:'target'}}}, {...body,planSubmission:{...body.planSubmission,plan:{viewId:'v-a',signalId:'count',write:true}}}]){
   const count=f.calls.length;
   assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',changed)).status,400);assert.equal(f.calls.length,count);
 }
});

test('health authenticates fixed localhost controller without exposing capability or file', async t => {
  const f = await fixture(t);
  const r = await f.bridge.handle('GET', '/api/plcdev/health');
  assert.equal(r.status, 200); assert.equal(r.body.connected, true); assert.equal(r.body.instance, INSTANCE);
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes(f.controllerFile), false);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(f.calls[0].headers['content-type'], 'application/json');
});

test('legacy FUXA recovery is project-scoped, read-only and strips private upstream details',async t=>{
  const f=await fixture(t),result=await f.bridge.handle('GET','/api/plcdev/fuxa-recovery?project='+A);
  assert.deepEqual(result.body,{ok:true,projectId:A,state:'pending',reasonCode:'pending'});
  assert.equal(f.calls.at(-1).url,'/api/fuxa/recovery?project='+A);assert.ok(f.calls.every(call=>call.method==='GET'));
  assert.equal((await f.bridge.handle('GET','/api/plcdev/fuxa-recovery')).status,400);
  assert.equal((await f.bridge.handle('GET','/api/plcdev/fuxa-recovery?project='+A+'&path=x')).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/fuxa-recovery',{projectId:A})).status,404);
  for(const reasonCode of ['write_outcome_unknown','undo_outcome_unknown','transaction_outcome_unknown','native_write_unknown']){
    f.state.fault=(req,value,status)=>req.url.startsWith('/api/fuxa/recovery')?{status,value:{ok:true,projectId:A,state:'conflict',reasonCode}}:{status,value};
    assert.equal((await f.bridge.handle('GET','/api/plcdev/fuxa-recovery?project='+A)).body.reasonCode,reasonCode);
  }
  f.state.fault=(req,value,status)=>req.url.startsWith('/api/fuxa/recovery')?{status,value:{ok:true,projectId:B,state:'pending'}}:{status,value};
  assert.equal((await f.bridge.handle('GET','/api/plcdev/fuxa-recovery?project='+A)).body.code,'recovery_mismatch');
});

test('HMI revision forwards only a pinned supported parent and complete original intent',async t=>{
 const f=await fixture(t),body={...taskBody(),workflow:'hmi-static-text-v1',request:'把静态文字“第一版”改为“第二版”',revisionParent:{taskId:TASK,candidateDigest:HASH},planSubmission:{schemaVersion:1,plan:{viewId:'v-a',elementId:'PLCD_tTitle',text:'第二版'},route:{provider:'offline',model:'fixture'}}};
 assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
 assert.deepEqual(f.calls.at(-1).body.revisionParent,body.revisionParent);
 const n=f.calls.length;
 for(const invalid of [{...body,revisionParent:{...body.revisionParent,extra:true}},{...body,planSubmission:{...body.planSubmission,plan:{...body.planSubmission.plan,text:'截断'}}},{...body,workflow:'unknown'}])assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',invalid)).status,400);
 assert.equal(f.calls.length,n);
});

test('switching projects is a read, and preserves other project Runtime and task ownership', async t => {
  const f = await fixture(t);
  f.state.tasks = [candidate(A)];
  const first = await f.bridge.handle('GET', '/api/plcdev/status?project=' + A);
  const second = await f.bridge.handle('GET', '/api/plcdev/status?project=' + B);
  const tasksA = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + A);
  const tasksB = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + B);
  assert.equal(first.body.session.active, true);
  assert.deepEqual(second.body.otherSessions, [{ id: 'session-A', projectId: A, active: true }]);
  assert.equal(tasksA.body.tasks[0].projectId, A); assert.deepEqual(tasksB.body.tasks, []);
  assert.equal(f.calls.every(c => c.method === 'GET'), true);
});

test('candidate create/open forwards original proposal and saved revision unchanged', async t => {
  const f = await fixture(t), body = taskBody();
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', body);
  assert.equal(r.status, 200); assert.equal(r.body.task.projectId, A);
  assert.deepEqual(f.calls.find(c => c.method === 'POST').body, body);
  const open = { projectId: A, taskId: TASK, candidateDigest: HASH };
  assert.equal((await f.bridge.handle('POST', '/api/plcdev/tasks/open', open)).status, 200);
  assert.deepEqual(f.calls.at(-1).body, open);
});

test('joint review accepts only explicit keep undo compile with pinned identities', async t => {
  const f=await fixture(t);
  const body={projectId:A,taskId:TASK,candidateDigest:HASH,expectedRevision:HASH,action:'keep',clientRequestId:'review-1'};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',body)).status,200);
  assert.deepEqual(f.calls.at(-1).body,body);
  for(const action of ['run','end','tool'])assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',{...body,action})).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',{...body,sessionId:'forbidden'})).status,400);
  assert.equal(f.calls.some(c=>c.url==='/api/action'),false);
  const wrong=f.state.fault=(_req,value,status)=>({status,value:{...value,taskId:'task-'+'0'.repeat(32)}});
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks/review',body)).body.code,'candidate_mismatch');
});

test('joint workflow is explicitly forwarded while unknown workflows and browser model access are rejected', async t=>{
  const f=await fixture(t),body={...taskBody(),workflow:'joint-ai-v1'};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
  assert.equal(f.calls.at(-1).body.workflow,'joint-ai-v1');
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',{...body,workflow:'arbitrary'})).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/model',{})).status,404);
});

test('bridge reopen recovers upstream candidates and performs no Runtime actions', async t => {
  const f = await fixture(t);
  await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  const reopened = createBridge(f.config);
  const r = await reopened.handle('GET', '/api/plcdev/tasks?project=' + A);
  assert.deepEqual(r.body.tasks, [candidate(A)]);
  assert.equal(f.calls.some(c => c.url === '/api/action'), false);
});

test('stale instance blocks mutation before any task or Runtime dispatch', async t => {
  const f = await fixture(t); f.state.instance = '0'.repeat(32);
  const r = await f.bridge.handle('POST', '/api/plcdev/action', actionBody(A, 'end'));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'instance_mismatch');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
});

test('wrong project root and nonloopback descriptor fail without network access', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'); await mkdir(other);
  await f.save({ root: other });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'root_mismatch');
  await f.save({ root: f.root, base: 'http://example.org:1234' });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_controller');
  assert.equal(f.calls.length, 0);
});

test('descriptor replacement during probe cannot redirect pending write to new instance', async t => {
  const f = await fixture(t);
  f.state.beforeReply = async req => { if (req.url.startsWith('/api/status')) await f.save({ instance: '0'.repeat(32) }); };
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 409); assert.equal(r.body.code, 'controller_changed');
  assert.equal(f.calls.length, 1);
});

test('unknown route, arbitrary path/URL and unsafe actions are rejected before connecting', async t => {
  const f = await fixture(t);
  for (const raw of ['http://evil.test', '/api/plcdev/../action', '/api/plcdev/status?project=' + A + '&url=http://evil.test', '/api/plcdev/tasks?project=' + A + '&project=' + B])
    assert.ok((await f.bridge.handle('GET', raw)).status >= 400);
  for (const body of [{ ...actionBody(), action: 'kill' }, { ...actionBody(), tool: 'http://evil.test' },
    { ...actionBody(), path: 'C:/secret' }, { ...taskBody(), executionScope: 'local_validation' }])
    assert.ok((await f.bridge.handle('POST', body.request ? '/api/plcdev/tasks' : '/api/plcdev/action', body)).status >= 400);
  assert.equal(f.calls.length, 0);
});

test('session-changing and expired actions are not sent', async t => {
  const f = await fixture(t);
  const wrong = await f.bridge.handle('POST', '/api/plcdev/action', { ...actionBody(), sessionId: 'session-old' });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.code, 'session_mismatch');
  const expired = await f.bridge.handle('POST', '/api/plcdev/action', { ...actionBody(), expires: Date.now() / 1000 - 1 });
  assert.equal(expired.status, 409); assert.equal(expired.body.code, 'expired');
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('explicit tool/start/run/stop/end retain all ownership and replay fields', async t => {
  const f = await fixture(t);
  for (const action of ['tool', 'start', 'runtime-start', 'runtime-stop', 'end']) {
    const body = actionBody(A, action);
    const r = await f.bridge.handle('POST', '/api/plcdev/action', body);
    assert.equal(r.status, 200); assert.deepEqual(f.calls.at(-1).body, body);
  }
});

test('response project and session mismatches never become visible data', async t => {
  const f = await fixture(t);
  f.state.projectOverride = B;
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status?project=' + A)).body.code, 'project_mismatch');
  f.state.projectOverride = null; f.state.sessionOverride = B;
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status?project=' + A)).body.code, 'session_mismatch');
});

test('cross-project task contamination is rejected', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({ status, value: req.url.startsWith('/api/agent/tasks') ? { ok: true, projectId: A, tasks: [candidate(B)] } : value });
  const r = await f.bridge.handle('GET', '/api/plcdev/tasks?project=' + A);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'task_project_mismatch');
  assert.equal(JSON.stringify(r).includes(B), false);
});

test('backend errors and nested secrets are scrubbed, mutations never automatically retried', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({
    status: req.method === 'POST' ? 503 : status,
    value: req.method === 'POST' ? { ok: false, error: 'Bearer ' + TOKEN, nested: { token: TOKEN, apiKey: 'secret-key', safe: 'ok' } } : value,
  });
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 503); assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes('secret-key'), false); assert.equal(r.body.nested.safe, 'ok');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('offline or missing controller is a bounded failure, without process ownership or cleanup', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  const r = await f.bridge.handle('GET', '/api/plcdev/status');
  assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream_unavailable');
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  const missing = createBridge({ ...f.config, controllerFile: path.join(f.root, 'missing.json') });
  assert.equal((await missing.handle('GET', '/api/plcdev/health')).body.code, 'controller_unavailable');
});

test('caller mutation during health cannot switch original project identity', async t => {
  const f = await fixture(t), body = taskBody();
  f.state.beforeReply = async () => { body.projectId = B; };
  const r = await f.bridge.handle('POST', '/api/plcdev/tasks', body);
  assert.equal(r.status, 200); assert.equal(r.body.task.projectId, A);
  assert.equal(f.calls.at(-1).body.projectId, A);
});

test('incompatible task version refuses generation but keeps readonly status available', async t => {
  const f = await fixture(t);
  f.state.fault = (req, value, status) => ({ status, value: { ...value, agentTaskInputVersion: 'old' } });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/status')).status, 200);
  assert.equal((await f.bridge.handle('POST', '/api/plcdev/tasks', taskBody())).body.code, 'version_mismatch');
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});


test('request timeout is bounded and an uncertain mutation is not resent', async t => {
  const f = await fixture(t);
  f.state.beforeReply = async req => {
    if (req.method === 'POST') await new Promise(resolve => setTimeout(resolve, 180));
  };
  const bridge = createBridge({ ...f.config, timeoutMs: 60 });
  const r = await bridge.handle('POST', '/api/plcdev/tasks', taskBody());
  assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('deep reply redaction failure after dispatch remains unknown in the actual SQLite conversation outbox',async t=>{
  const f=await fixture(t),routes=createConversationRoutes({controllerFile:f.controllerFile,bridge:f.bridge});
  const bind=await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:'chat-a',projectId:A,expectedVersion:0});assert.equal(bind.status,200);
  // The workbench fixture has already recorded the task before its deeply
  // nested response overflows the bridge redactor. JSON parsing itself works.
  f.state.rawReply=(req,value)=>req.method==='POST'&&req.url==='/api/agent/tasks'
    ?'{"ok":true,"task":'+JSON.stringify(value.task)+',"nested":'+'{"x":'.repeat(18000)+'null'+'}'.repeat(18000)+'}':null;
  const request={...taskBody(),conversationId:'chat-a',expectedVersion:1};
  const result=await routes.handle('POST','/api/plcdev/conversations/tasks',request);
  assert.equal(result.status,503);assert.equal(result.body.code,'mutation_unknown');
  assert.equal(f.state.tasks.length,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/api/agent/tasks').length,1);
  const snapshot=routes.snapshot('chat-a');assert.equal(snapshot.pendingRequests.length,1);assert.equal(snapshot.pendingRequests[0].clientRequestId,request.clientRequestId);
  assert.equal((await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:'chat-a',projectId:B,expectedVersion:1})).body.code,'submission_unknown');
  assert.equal(JSON.stringify(result).includes(TOKEN),false);
});

for(const fault of ['timeout','disconnect','invalid-json'])test(`${fault} after task dispatch remains unknown through the HTTP bridge and SQLite`,async t=>{
  const f=await fixture(t),bridge=createBridge({...f.config,timeoutMs:200}),routes=createConversationRoutes({controllerFile:f.controllerFile,bridge});
  assert.equal((await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:'chat-a',projectId:A,expectedVersion:0})).status,200);
  if(fault==='timeout')f.state.beforeReply=async req=>{if(req.method==='POST')await new Promise(resolve=>setTimeout(resolve,600));};
  if(fault==='disconnect')f.state.abortReply=req=>req.method==='POST';
  if(fault==='invalid-json')f.state.rawReply=req=>req.method==='POST'?'{"malformed"':null;
  const request={...taskBody(),conversationId:'chat-a',expectedVersion:1};
  const result=await routes.handle('POST','/api/plcdev/conversations/tasks',request);
  assert.equal(result.status,503);assert.equal(f.state.tasks.length,1);assert.equal(routes.snapshot('chat-a').pendingRequests.length,1);
  assert.equal((await routes.handle('POST','/api/plcdev/conversations/bind',{conversationId:'chat-a',projectId:B,expectedVersion:1})).body.code,'submission_unknown');
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/api/agent/tasks').length,1);
});

test('pre-dispatch request validation still rejects without sending a mutation',async t=>{
  const f=await fixture(t),result=await f.bridge.handle('POST','/api/plcdev/tasks',{...taskBody(),unexpected:true});
  assert.equal(result.status,400);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('redirect or invalid JSON is never treated as healthy or followed', async t => {
  const f = await fixture(t);
  f.state.fault = () => ({ status: 302, value: { location: 'http://example.org' } });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_response');
  assert.equal(f.calls.length, 1);
  f.state.fault = () => ({ status: 200, value: null });
  assert.equal((await f.bridge.handle('GET', '/api/plcdev/health')).body.code, 'invalid_response');
  assert.equal(f.calls.length, 2);
});


test('catalog dispatch is fixed, checks session and capability, and never proxies arbitrary actions',async t=>{
  const f=await fixture(t);const base={projectId:B,sessionId:null,action:'project-open',manifestPath:path.join(f.root,'project.plcdev'),client:'dsh-catalog-11111111-1111-4111-8111-111111111111',sequence:1,expires:Date.now()/1000+10};
  const result=await f.bridge.projectOperation(base);assert.equal(result.status,200);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.at(-1).url,'/api/action');
  await assert.rejects(()=>f.bridge.projectOperation({...base,sessionId:'session-A'}));
  await assert.rejects(()=>f.bridge.projectOperation({...base,action:'runtime-start'}));
  f.state.fault=(req,value,status)=>req.url.startsWith('/api/status')?{value:{...value,projectCatalog:{canOpen:false}},status}:{value,status};
  await assert.rejects(()=>f.bridge.projectOperation(base));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('HMI-only request accepts one bounded view name and rejects extra operations',async t=>{
  const f=await fixture(t),body={...taskBody(),request:'把画面名称“旧画面”改为“画面”',workflow:'hmi-view-name-v1',planSubmission:{schemaVersion:1,
    plan:{viewId:'v_existing',name:'画面'},route:{provider:'offline',model:'fixture'}}};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
  assert.deepEqual(f.calls.find(c=>c.method==='POST').body,body);
  const count=f.calls.length;
  const extra={...body,planSubmission:{...body.planSubmission,plan:{...body.planSubmission.plan,plc:'write'}}};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',extra)).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',{...body,sourceBasis:'editor_current'})).status,400);
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',{...body,request:'请修改名称'})).status,400);
  assert.equal(f.calls.length,count);
});
test('static HMI text accepts only the requested text and exact bounded target',async t=>{
  const f=await fixture(t),body={...taskBody(),request:'把静态文字“原标题”改为“设备演示”',workflow:'hmi-static-text-v1',planSubmission:{schemaVersion:1,
    plan:{viewId:'v_existing',elementId:'PLCD_tTitle',text:'设备演示'},route:{provider:'offline',model:'fixture'}}};
  assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',body)).status,200);
  const count=f.calls.length;
  for(const plan of [{...body.planSubmission.plan,elementId:'value_live'},{...body.planSubmission.plan,text:'未请求'}, {...body.planSubmission.plan,plc:'write'}])
    assert.equal((await f.bridge.handle('POST','/api/plcdev/tasks',{...body,planSubmission:{...body.planSubmission,plan}})).status,400);
  assert.equal(f.calls.length,count);
});
