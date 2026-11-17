import test from 'node:test';
import assert from 'node:assert/strict';
import {turnCandidateResults,editorOpenRequest,openResultInEditor,validateResultPreview,textDiff,ladderSummary,editorOpenNotice,readEditorObservation} from '../src/client/result-flow.mjs';
import {conversationApi} from '../src/client/conversation-client.mjs';

const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),keptProjectId='user-'+'c'.repeat(32),candidateDigest='d'.repeat(64);
const task={projectId,taskId,workflow:'project-edit-v1',status:'awaiting_review',candidate:{candidateDigest}};
const call=(name,task,extra={})=>({kind:'result',call:{name},callId:name,content:[{type:'text',text:JSON.stringify({task})}],subCalls:[],...extra});

test('result cards use only this turn and deduplicate an explicitly reread task',()=>{
 const old=call('plcdev_propose_project_edit',task),latest=call('plcdev_task_status',{...task,status:'kept'});
 const other={...task,taskId:'task-'+'e'.repeat(32)};
 const first=turnCandidateResults([{root:old},{root:latest},{root:call('unrelated_tool',other)}]);
 assert.equal(first.length,1);assert.equal(first[0].block,latest);
 assert.equal(turnCandidateResults([{root:call('plcdev_propose_project_edit',other)}])[0].target.taskId,other.taskId);
 assert.equal(turnCandidateResults([]).length,0);
 assert.equal(turnCandidateResults([{root:call('plcdev_propose_project_edit',task,{isError:true})}]).length,0);
 assert.equal(turnCandidateResults([{root:{phase:'preparing',name:'plcdev_propose_project_edit',subCalls:[old]}}]).length,1);
 assert.equal(turnCandidateResults([{root:call('plcdev_propose_project_edit',{...task,status:'queued',candidate:undefined})}]).length,1,'async generation remains visible while waiting for its candidate');
});

test('saved-result opening always names the retention target and checks every receipt',async()=>{
 const kept={...task,status:'compiled',retention:{keptProjectId}},states=[],requests=[];
 const base={ok:true,sourceProjectId:projectId,taskId,targetProjectId:keptProjectId,launchId:'editor-1',nativeProjectPath:'D:/kept/plc/project.json'};
 const result=await openResultInEditor({conversationId:'chat-a',task:kept,wait:async()=>{},onState:r=>states.push(r.state),api:async(path,body)=>{requests.push({path,body});return {...base,state:body?'requested':'loaded'};}});
 assert.equal(result.state,'loaded');assert.equal(requests.length,2);assert.equal(requests[0].body.target,'retained');
 assert.deepEqual(states,['requested','loaded']);assert.ok(requests[1].path.includes('launchId=editor-1'));assert.equal(new URL(requests[1].path,'http://local').searchParams.get('taskId'),taskId);
 await assert.rejects(openResultInEditor({conversationId:'chat-a',task:kept,api:async()=>({...base,state:'loaded',targetProjectId:projectId})}),/目标工程不一致/);
 await assert.rejects(openResultInEditor({conversationId:'chat-a',task:kept,wait:async()=>{},api:async(path,body)=>({...base,state:'requested',launchId:body?'editor-1':'other'})}),/原打开目标不一致/);
});

test('opening observes the same native window after one timeout, and bounds repeated timeouts without relaunching',async()=>{
 const receipt={ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-slow',nativeProjectPath:'D:/preview/plc/project.json',state:'requested'};
 const timeout=()=>Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'});
 let opens=0,reads=0;const notices=[];
 const result=await openResultInEditor({conversationId:'chat-a',task,wait:async()=>{},onState:value=>notices.push(editorOpenNotice(value)),api:async(path,body)=>{
  if(body){opens++;return receipt;}
  assert.equal(new URL(path,'http://local').searchParams.get('launchId'),receipt.launchId);
  if(++reads===1)throw timeout();
  return {...receipt,state:'loaded'};
 }});
 assert.equal(result.state,'loaded');assert.equal(opens,1);assert.equal(reads,2);assert.match(notices[1],/等待.*窗口确认/);assert.match(notices.at(-1),/已确认打开/);
 assert.doesNotMatch(notices.join(' '),/aborted|未能打开/);
 opens=0;reads=0;
 const pending=await openResultInEditor({conversationId:'chat-a',task,wait:async()=>{},api:async(path,body)=>{if(body){opens++;return receipt;}reads++;throw timeout();}});
 assert.equal(opens,1);assert.equal(reads,3);assert.equal(pending.state,'requested');assert.equal(pending.openingStatus,'unconfirmed');assert.match(editorOpenNotice(pending),/打开结果待核对/);
 let calls=0;
 await assert.rejects(openResultInEditor({conversationId:'chat-a',task,api:async()=>{calls++;throw timeout();}}),error=>error.code==='editor_open_unconfirmed'&&/结果待核对/.test(error.message));
 assert.equal(calls,1,'A missing opening receipt must not trigger a second mutation');
 let attempts=0;
 await assert.rejects(openResultInEditor({conversationId:'chat-a',task,wait:async()=>{},api:async(path,body)=>{if(body)return receipt;attempts++;throw Object.assign(Error('会话归属不匹配'),{httpStatus:403,code:'upstream_unavailable'});}}),/归属不匹配/);
 assert.equal(attempts,1,'Authorization errors are never retried');
});

test('a timed-out browser request exposes a typed Chinese uncertainty instead of raw AbortError',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('signal is aborted without reason','AbortError')),{once:true}));
 try{await assert.rejects(conversationApi('conversations/editor-status',undefined,5),error=>error.code==='request_timeout'&&/响应超时.*结果尚未确认/.test(error.message));}
 finally{globalThis.fetch=previous;}
});

test('a real fetch network failure only retries reading its existing launch and never reopens',async()=>{
 const previous=globalThis.fetch,receipt={ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-network',nativeProjectPath:'F:/preview/plc/project.json',state:'requested'};
 let opens=0,reads=0;
 globalThis.fetch=async(url,options)=>{
  if(options.method==='POST'){opens++;return {ok:true,status:200,json:async()=>receipt};}
  assert.equal(new URL(url,'http://local').searchParams.get('launchId'),receipt.launchId);
  if(++reads===1)throw new TypeError('Failed to fetch');
  return {ok:true,status:200,json:async()=>({...receipt,state:'loaded'})};
 };
 try{
  const result=await openResultInEditor({conversationId:'chat-a',task,api:conversationApi,wait:async()=>{}});
  assert.equal(result.state,'loaded');assert.equal(opens,1);assert.equal(reads,2);
  let failedOpens=0;globalThis.fetch=async()=>{failedOpens++;throw new TypeError('Failed to fetch');};
  await assert.rejects(openResultInEditor({conversationId:'chat-a',task,api:conversationApi}),error=>error.code==='editor_open_unconfirmed');
  assert.equal(failedOpens,1);
 }finally{globalThis.fetch=previous;}
});

test('an unconfirmed editor launch is polled without resubmitting or retaining again',async()=>{
 let mutations=0,reads=0;
 const result=await openResultInEditor({conversationId:'chat-a',task,wait:async()=>{},polls:3,api:async(path,body)=>{
  if(body)mutations++;else reads++;
  return {ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-2',nativeProjectPath:'D:/preview/plc/project.json',state:'requested'};
 }});
 assert.equal(mutations,1);assert.equal(reads,3);assert.equal(result.state,'requested');
 assert.throws(()=>editorOpenRequest('chat-a',task,'retained'),/尚未保留/);
});

test('readable previews reject wrong candidates and retain missing-baseline metadata',()=>{
 const preview={projectId,taskId,candidateDigest,files:[{path:'plc/pous/main.st',kind:'st',beforeText:null,afterText:'Count := 2;',beforeUnavailable:true},{path:'devices/private.json',kind:'metadata',beforeText:null,afterText:null,unavailableReason:'不展开连接配置'}]};
 assert.equal(validateResultPreview(preview,task),preview);
 assert.throws(()=>validateResultPreview({...preview,taskId:'task-'+'e'.repeat(32)},task),/当前候选不一致/);
 assert.deepEqual(textDiff('Count := 1;','Count := 2;').lines.map(r=>[r.kind,r.text]),[['add','Count := 2;'],['remove','Count := 1;']]);
 assert.equal(textDiff('','new').lines.length,1);
 assert.equal(textDiff('a\nb','c',1).large,true);
 const summary=ladderSummary({rungs:[{comment:'真实网络注释',nodes:[{type:'contact',data:{variant:'negated',variable:{name:'Stop'}}},{type:'block',data:{variant:{name:'DoubleValue'},connectedVariables:[{handleId:'Value',variable:{name:'SourceValue'}}]}}],edges:[{source:'a',target:'b'}]}]});
 assert.equal(summary[0].nodes[0].name,'Stop');assert.equal(summary[0].nodes[0].variant,'negated');assert.equal(summary[0].nodes[1].bindings[0].variable,'SourceValue');assert.equal(summary[0].connectionCount,1);
});

test('fresh editor observation outranks an old loaded handshake without reopening the editor',async()=>{
 const receipt={ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-observe',nativeProjectPath:'D:/project/plc/project.json',sessionId:'chat-a',state:'loaded'};
 const observation={state:'clean',loaded:true,dirty:false,revisionMatches:true,observedAt:new Date().toISOString()};
 assert.match(editorOpenNotice({...receipt,observation}),/对应版本，无未保存调整/);
 assert.match(editorOpenNotice({...receipt,observation:{...observation,dirty:true,state:'dirty'}}),/有未保存调整/);
 assert.match(editorOpenNotice({...receipt,observation:{...observation,revisionMatches:false}}),/仍是旧版本/);
 assert.match(editorOpenNotice({...receipt,editor:{observation:{...observation,dirty:true,state:'dirty'}}}),/有未保存调整/);
 assert.match(editorOpenNotice({...receipt,editor:{observation:{...observation,revisionMatches:false}}}),/仍是旧版本/);
 assert.match(editorOpenNotice({...receipt,observation:{state:'unknown'},editor:{observation}}),/当前内容尚未确认/,'A failed fresh poll overrides an earlier nested observation');
 assert.doesNotMatch(editorOpenNotice({...receipt,observation:{...observation,observedAt:new Date(Date.now()-10000).toISOString()}}),/已确认打开|已加载对应版本/);
 const calls=[];const value=await readEditorObservation(async(path,body)=>{calls.push({path,body});return {...receipt,observation};},'chat-a',receipt);
 assert.equal(value.observation.state,'clean');assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);assert.match(calls[0].path,/editor-status/);assert.equal(new URL(calls[0].path,'http://local').searchParams.get('taskId'),taskId);
 await assert.rejects(readEditorObservation(async()=>({...receipt,targetProjectId:keptProjectId}),'chat-a',receipt),/原打开目标不一致/);
});

test('a verified same-launch sync follows its new path while forged targets and preview retargeting stay rejected',async()=>{
 const receipt={ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-sync',nativeProjectPath:'D:/project/plc/project.json',sessionId:'chat-a',state:'loaded',mode:'project',revision:'a'.repeat(64)};
 const value={...receipt,nativeProjectPath:'D:/project/.plcdev/versions/v2/plc/project.json',revision:'b'.repeat(64),editor:{synchronizedFrom:[{revision:receipt.revision,nativeProjectPath:receipt.nativeProjectPath}],observation:{state:'clean',loaded:true,dirty:false,revisionMatches:true,observedAt:new Date().toISOString()}}};
 assert.equal((await readEditorObservation(async()=>value,'chat-a',receipt)).revision,value.revision);
 assert.match(editorOpenNotice(value),/已同步到当前保存版本/);
 for(const changed of [{editor:{...value.editor,synchronizedFrom:[]}},{mode:'preview'},{launchId:'other'},{targetProjectId:keptProjectId}])await assert.rejects(readEditorObservation(async()=>({...value,...changed}),'chat-a',receipt),/原打开目标不一致/);
 assert.match(editorOpenNotice({...value,editor:{...value.editor,sync:{state:'pending'},observation:{...value.editor.observation,revisionMatches:false}}}),/正在同步/);
 assert.match(editorOpenNotice({...value,editor:{...value.editor,sync:{state:'blocked',reason:'请核对本地保存的改动后再切换工程。'},observation:{...value.editor.observation,revisionMatches:false}}}),/核对本地保存/);
});

test('shared launch observation selects each result identity and rejects another registered digest',async()=>{
 const base={ok:true,sourceProjectId:projectId,targetProjectId:projectId,launchId:'editor-shared',nativeProjectPath:'D:/project/plc/project.json',sessionId:'chat-a',state:'loaded',mode:'project',revision:'a'.repeat(64)};
 const receipts=[{...base,taskId,candidateDigest},{...base,taskId:'task-'+'e'.repeat(32),candidateDigest:'f'.repeat(64)}];
 const calls=[];
 for(const receipt of receipts){
  const result=await readEditorObservation(async route=>{const id=new URL(route,'http://local').searchParams.get('taskId');calls.push(id);return receipts.find(r=>r.taskId===id);},'chat-a',receipt);
  assert.equal(result,receipt);
 }
 assert.deepEqual(calls,receipts.map(r=>r.taskId));
 await assert.rejects(readEditorObservation(async()=>({...receipts[0],candidateDigest:receipts[1].candidateDigest}),'chat-a',receipts[0]),/原打开目标不一致/);
 const plain=await readEditorObservation(async route=>{assert.equal(new URL(route,'http://local').searchParams.has('taskId'),false);return base;},'chat-a',base);
 assert.equal(plain.taskId,undefined);
});
