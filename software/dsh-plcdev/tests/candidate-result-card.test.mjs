import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64),revision='d'.repeat(64),savedRevision='e'.repeat(64);
const task={projectId,taskId,request:'只改此工程',workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,candidate:{candidateDigest:digest,revisionSupported:true,components:[{tool:'openplc',summary:'更新 ST 程序：main.st'},{tool:'fuxa',summary:'修改画面文字：main'}],changes:[{path:'plc/pous/programs/main.st',beforeSha256:revision,afterSha256:digest},{path:'hmi/main.fuxap',beforeSha256:revision,afterSha256:digest}]}};
const target={projectId,taskId},pendingKey='plcdev.dsh.d3.review.chat-a.'+projectId+'.'+taskId;
const response=value=>({ok:true,status:200,json:async()=>value});
const wait=()=>new Promise(r=>setTimeout(r,90));
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(check(),'UI did not settle');}
let compiled;
async function fixture({both=false,reviewOnly=false,onReview,onEditorOpen,onTaskRead,owned=true,sourceRevision=revision,hideRecordsLink=false,initialTask=task,resourceResult={message:'已请求打开对应画面'},syncSnapshot,resourceObservation,fastPolling=false,storedPending=null}={}){
 if(!compiled)compiled=(await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {TurnResultCards,ConversationReview} from ${JSON.stringify(component)};import {CandidateResultCard} from ${JSON.stringify(component.replace('Conversation.tsx','CandidateResultCard.tsx'))};const controller={snapshot:()=>window.binding,subscribe:()=>()=>{},refresh:()=>window.refreshes++,revise:task=>{window.revisions.push(task);window.binding.binding.revisionContext={state:'armed',parent:{taskId:task.taskId,candidateDigest:task.candidate.candidateDigest}};return Promise.resolve()}};const props={sessionId:'chat-a',onContinueRetained:()=>window.legacy++,onContinueCurrent:value=>window.continues.push(value),onOpenEditorSession:()=>window.legacy++,onReviewTask:value=>window.records.push(value),onOpenResultResource:value=>{window.resources.push(value);return Promise.resolve(window.resourceResult)},contexts:{get:()=>controller}};const app=createRoot(document.getElementById('root'));app.render(<>{window.reviewOnly?null:window.hideRecordsLink?<CandidateResultCard block={window.nodes[0].root} hideRecordsLink {...props}/>:<TurnResultCards turn={{turn:1}} usePlcdevTurnTools={()=>window.nodes} {...props}/>}{(window.both||window.reviewOnly)&&<ConversationReview target={window.target} {...props}/>}</>);window.stop=()=>app.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],posts=[],opens=[],previews=[];let current=structuredClone(initialTask),currentRevision=sourceRevision;
 const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(`<div id="root"></div><script>${compiled.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
  if(fastPolling){const schedule=w.setTimeout.bind(w);w.setTimeout=(callback,delay,...args)=>schedule(callback,delay===4000?40:delay,...args);}
  if(storedPending)w.localStorage.setItem(pendingKey,JSON.stringify(storedPending));
  w.both=both;w.reviewOnly=reviewOnly;w.hideRecordsLink=hideRecordsLink;w.target=target;w.legacy=0;w.refreshes=0;w.revisions=[];w.continues=[];w.records=[];w.resources=[];w.resourceResult=resourceResult;
  w.binding={binding:{conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]},busy:false,pending:null,storageError:''};
  w.nodes=[{root:{kind:'result',call:{name:'plcdev_propose_project_edit'},content:[{type:'text',text:JSON.stringify({task:current,projectName:'输送工程'})}],subCalls:[]}}];
  w.fetch=async(url,options={})=>{
   const u=new URL(url,'http://127.0.0.1:55119');
   if(u.pathname.endsWith('/conversations'))return response({...w.binding.binding,taskRefs:owned?[target]:[]});
   if(u.pathname.endsWith('/status'))return response({project:{id:projectId,name:'输送工程'},projects:[{id:projectId}],...(syncSnapshot?{oipSync:syncSnapshot}:{})});
   if(u.pathname.endsWith('/result-resource-status')){const {conversationId,...body}=JSON.parse(options.body);return response({ok:true,...body,observationRevision:resourceResult.observationRevision,toolSync:{oip:resourceObservation||{state:'unknown'}}});}
   if(u.pathname.endsWith('/preview')){previews.push(u);return response({...target,candidateDigest:digest,files:[{path:'plc/pous/programs/main.st',kind:'st',beforeText:'Count := 1;',afterText:'Count := 2;'}]});}
   if(u.pathname.endsWith('/editor-open')){const body=JSON.parse(options.body);opens.push(body);if(onEditorOpen)return onEditorOpen({body,count:opens.length});return response({ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-'+opens.length,nativeProjectPath:'D:/current/plc/project.json',state:'loaded',sessionId:'chat-a'});}
   if(u.pathname.endsWith('/review')){const body=JSON.parse(options.body);posts.push(body);if(onReview){const value=await onReview({body,count:posts.length,setTask:value=>{current=value;},setRevision:value=>{currentRevision=value;}});return response(value);}
    current=body.action==='undo'?{...current,status:'discarded'}:body.action==='compile'?{...current,status:'compiled',compilation:{status:'compiled',revision:savedRevision}}:{...current,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};if(body.action==='keep')currentRevision=savedRevision;return response({ok:true,...target,candidateDigest:digest,task:current});}
   const listing={projectId,projectRevision:currentRevision,tasks:[structuredClone(current)]};
   if(u.pathname.endsWith('/task-state')&&onTaskRead)return onTaskRead(listing);
   return response(listing);
  };
 }});
 await wait();await wait();
 const button=(label,scope='.pc-result-card')=>[...dom.window.document.querySelectorAll(scope+' button')].find(button=>button.textContent===label);
 return {dom,button,posts,opens,previews,errors,setTask(value){current=value;},setRevision(value){currentRevision=value;},get task(){return current;},close(){dom.window.stop();dom.window.close();}};
}

test('same-task saved revision refresh clears only the failed progress query after keep, without reopening',async()=>{
 let held=false;const pendingReads=[];
 const failure={ok:false,status:503,json:async()=>({code:'tasks_unavailable',error:'工程修改进度暂不可读取。'})};
 const f=await fixture({fastPolling:true,onReview:async({setTask,setRevision})=>{
  const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
  held=true;setTask(kept);setRevision(savedRevision);return {ok:true,...target,candidateDigest:digest,task:kept};
 },onEditorOpen:async()=>failure,onTaskRead:listing=>held?new Promise(resolve=>pendingReads.push(()=>resolve(response(listing)))):response(listing)});
 try{
  f.button('保留本轮修改').click();
  await until(()=>f.dom.window.document.body.textContent.includes('工程修改进度暂不可读取'));
  assert.equal(f.task.status,'kept');assert.equal(f.posts.length,1);assert.equal(f.opens.length,1);
  assert.equal(f.dom.window.localStorage.getItem(pendingKey),null);
  held=false;pendingReads.splice(0).forEach(resolve=>resolve());
  await until(()=>!f.dom.window.document.body.textContent.includes('工程修改进度暂不可读取'));
  assert.equal(f.dom.window.document.querySelector('[data-result-status]').textContent,'已保留');
  assert.equal(f.posts.length,1);assert.equal(f.opens.length,1,'Recovery is a read, not another editor-open');
  assert.doesNotMatch(f.dom.window.document.body.textContent,/已加载对应版本|已确认打开对应工程/);
  assert.deepEqual(f.errors,[]);
 }finally{held=false;pendingReads.splice(0).forEach(resolve=>resolve());f.close();}
});

for(const mismatch of ['digest','revision','binding','unknown'])test(`progress recovery does not clear ${mismatch} evidence`,async()=>{
 let fail=false;
 const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const f=await fixture({fastPolling:true,initialTask:kept,sourceRevision:savedRevision,
  onEditorOpen:async()=>{fail=true;return {ok:false,status:503,json:async()=>({code:'tasks_unavailable',error:'工程修改进度暂不可读取。'})};},
  onTaskRead:listing=>{
   if(fail){if(mismatch==='digest')listing.tasks[0].candidate.candidateDigest='f'.repeat(64);
    if(mismatch==='revision')listing.projectRevision='f'.repeat(64);
    if(mismatch==='unknown')listing.tasks[0].status='unknown_outcome';}
   return response(listing);
  }});
 try{
  if(mismatch==='binding')f.dom.window.binding.binding.version=2;
  f.button('在 OpenPLC 查看').click();await wait();await wait();
  assert.match(f.dom.window.document.body.textContent,/工程修改进度暂不可读取/);
  assert.equal(f.opens.length,1);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('successful task reads preserve a different operation error even with the same displayed text',async()=>{
 const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const f=await fixture({fastPolling:true,initialTask:kept,sourceRevision:savedRevision,
  onEditorOpen:async()=>({ok:false,status:409,json:async()=>({code:'outcome_unknown',error:'工程修改进度暂不可读取。'})})});
 try{
  f.button('在 OpenPLC 查看').click();await wait();await wait();
  assert.match(f.dom.window.document.body.textContent,/工程修改进度暂不可读取/);assert.equal(f.opens.length,1);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('a late pre-error shared task read cannot clear the notice before a fresh read succeeds',async()=>{
 let held=false;const pendingReads=[];
 const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const f=await fixture({fastPolling:true,initialTask:kept,sourceRevision:savedRevision,
  onEditorOpen:async()=>({ok:false,status:503,json:async()=>({code:'tasks_unavailable',error:'工程修改进度暂不可读取。'})}),
  onTaskRead:listing=>held?new Promise(resolve=>pendingReads.push(()=>resolve(response(listing)))):response(listing)});
 try{
  held=true;await until(()=>pendingReads.length===1);
  f.button('在 OpenPLC 查看').click();
  await until(()=>f.dom.window.document.body.textContent.includes('工程修改进度暂不可读取'));
  await until(()=>pendingReads.length===2);
  pendingReads[0]();await wait();
  assert.match(f.dom.window.document.body.textContent,/工程修改进度暂不可读取/,'the old transport response is not recovery evidence');
  held=false;pendingReads[1]();
  await until(()=>!f.dom.window.document.body.textContent.includes('工程修改进度暂不可读取'));
  assert.equal(f.opens.length,1);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
 }finally{held=false;pendingReads.forEach(resolve=>resolve());f.close();}
});

test('fresh matching reads cannot clear a progress notice while another review request remains unresolved',async()=>{
 const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 let f;
 const pending={conversationId:'chat-a',...target,candidateDigest:digest,expectedRevision:savedRevision,action:'compile',clientRequestId:'pending-compile'};
 f=await fixture({fastPolling:true,initialTask:kept,sourceRevision:savedRevision,
  onEditorOpen:async()=>{f.dom.window.localStorage.setItem(pendingKey,JSON.stringify(pending));
   return {ok:false,status:503,json:async()=>({code:'tasks_unavailable',error:'工程修改进度暂不可读取。'})};}});
 try{
  f.button('在 OpenPLC 查看').click();await wait();await wait();
  assert.match(f.dom.window.document.body.textContent,/工程修改进度暂不可读取/);
  assert.equal(JSON.parse(f.dom.window.localStorage.getItem(pendingKey)).clientRequestId,'pending-compile');
  assert.equal(f.opens.length,1);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

for(const view of ['card','review','both'])for(const action of ['keep','undo'])test(`${view} automatically settles an asynchronous ${action} without resubmitting`,async()=>{
 let submitted;
 const f=await fixture({both:view==='both',reviewOnly:view==='review',fastPolling:true,onReview:async({body,setTask})=>{
  submitted=body;const accepted={...task,status:action==='keep'?'keeping':'discarding'};setTask(accepted);
  return {ok:true,...target,candidateDigest:digest,task:accepted};
 }}),scope=view==='review'?'.pc-review':'.pc-result-card';
 try{
  f.button(action==='keep'?'保留本轮修改':'撤销本轮',scope).click();await wait();
  assert.ok(f.dom.window.localStorage.getItem(pendingKey),'acceptance alone stays pending');
  assert.equal(f.opens.length,0);assert.equal(f.posts.length,1);
  const {conversationId,...completion}=submitted;
  f.setTask({...task,status:action==='keep'?'kept':'discarded',reviewCompletions:[completion],...(action==='keep'?{retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}}:{})});
  await wait();await wait();await wait();
  assert.equal(f.dom.window.localStorage.getItem(pendingKey),null,'a matching confirmed effect settles on the next status poll');
  assert.equal(f.posts.length,1,'polling must never repeat the review POST');
  assert.equal(f.opens.length,action==='keep'?1:0,'only the settling view opens the kept project');
  assert.ok(f.dom.window.refreshes>0,'refresh the shared conversation and resource state');
  assert.doesNotMatch(f.dom.window.document.querySelector(scope).textContent,/上次操作结果待核对|核对原操作/);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

for(const reviewOnly of [false,true])test(`${reviewOnly?'review':'card'} settles a reloaded exact completion but preserves unrelated and unknown receipts`,async()=>{
 const pending={conversationId:'chat-a',...target,candidateDigest:digest,expectedRevision:revision,action:'undo',clientRequestId:'reload-operation'};
 const {conversationId,...completion}=pending;
 const f=await fixture({reviewOnly,fastPolling:true,storedPending:pending,initialTask:{...task,status:'discarded',reviewCompletions:[{...completion,clientRequestId:'old-operation'}]}});
 try{
  assert.ok(f.dom.window.localStorage.getItem(pendingKey));assert.equal(f.posts.length,0);
  f.setTask({...task,status:'unknown_outcome',reviewCompletions:[completion]});await wait();await wait();
  assert.ok(f.dom.window.localStorage.getItem(pendingKey),'an unknown task cannot be released by an old completion');
  f.setTask({...task,status:'discarded',reviewCompletions:[completion]});await wait();await wait();
  assert.equal(f.dom.window.localStorage.getItem(pendingKey),null);assert.equal(f.posts.length,0);assert.equal(f.opens.length,0);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('each tool result is compact, expands independently and keeps direct exact-target entries',async()=>{
 const f=await fixture();try{
  const cards=[...f.dom.window.document.querySelectorAll('[data-result-tool]')];assert.equal(cards.length,2);assert.equal(f.previews.length,0);
  assert.equal(cards[0].querySelector('[role=region]').hidden,true);cards[0].querySelector('.pc-operation-toggle').click();await wait();
  assert.equal(cards[0].querySelector('[role=region]').hidden,false);assert.equal(cards[1].querySelector('[role=region]').hidden,true);
  assert.match(cards[0].textContent,/1 个文件变化/);assert.doesNotMatch(cards[0].textContent,/1 次编辑/);
  f.button('在 FUXA 查看').click();await wait();assert.deepEqual(JSON.parse(JSON.stringify(f.dom.window.resources[0])),{conversationId:'chat-a',...target,candidateDigest:digest,tool:'fuxa',target:'candidate'});
  f.button('查看调整记录').click();assert.equal(f.dom.window.records[0].taskId,taskId);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
const oipTask={...task,candidate:{...task.candidate,components:[{tool:'oip',summary:'修改输送带',operations:[{name:'update_part',summary:'输送带速度调整为 1.5'}],checks:[{id:'scene',label:'场景结构',status:'passed'},{id:'plc',label:'PLC 接线',status:'warning',summary:'外部 PLC 未连接'}]}],changes:[{path:'oip/project.json',beforeSha256:revision,afterSha256:digest}]}};

test('first scene result shows native creation, opens its candidate and keeps in the same conversation',async()=>{
 const created={...oipTask,candidate:{...oipTask.candidate,components:[{tool:'oip',summary:'创建输送场景',operations:[{name:'new_project',summary:'创建原生 OIP 场景'},{name:'add_part',summary:'添加输送带'}],checks:[{id:'scene',label:'场景结构',status:'passed'}]}],changes:[{path:'integration/revision/oip/project.json',beforeSha256:null,afterSha256:digest},{path:'project.plcdev',beforeSha256:revision,afterSha256:digest}]}};
 const f=await fixture({initialTask:created,resourceResult:{toolSync:{oip:{state:'synced',revision:savedRevision}}},syncSnapshot:{state:'synced',revision:savedRevision}});
 try{
  const card=f.dom.window.document.querySelector('[data-result-tool=oip]');assert.ok(card);card.querySelector('.pc-operation-toggle').click();await wait();assert.match(card.textContent,/创建原生 OIP 场景/);assert.match(card.textContent,/添加输送带/);
  f.button('在 OIP 查看').click();await wait();assert.equal(f.dom.window.resources[0].target,'candidate');
  f.button('保留本轮修改').click();await wait();await wait();await wait();assert.equal(f.posts[0].action,'keep');assert.equal(f.dom.window.resources[1].target,'retained');assert.equal(f.dom.window.resources[1].projectId,projectId);
  f.button('继续修改').click();await wait();assert.equal(f.dom.window.continues[0].sessionId,'chat-a');assert.equal(f.dom.window.legacy,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('OIP-only keep opens the exact retained scene and shows native checks separately',async()=>{
 const f=await fixture({initialTask:oipTask,resourceResult:{message:'场景已打开',toolSync:{oip:{state:'synced',revision:savedRevision}}},syncSnapshot:{state:'synced',revision:savedRevision}});
 try{
  assert.equal(f.button('在 OpenPLC 查看'),undefined);
  const card=f.dom.window.document.querySelector('[data-result-tool=oip]');assert.match(card.textContent,/原生检查需注意/);
  card.querySelector('.pc-operation-toggle').click();await wait();assert.match(card.textContent,/输送带速度调整为 1.5/);assert.match(card.textContent,/PLC 接线：需注意/);
  f.button('保留本轮修改').click();await wait();await wait();await wait();
  assert.equal(f.posts.length,1);assert.equal(f.opens.length,0);assert.equal(f.dom.window.resources.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.dom.window.resources[0])),{conversationId:'chat-a',...target,candidateDigest:digest,tool:'oip',target:'retained'});
  assert.equal(card.querySelector('[data-tool-sync]').textContent,'已同步保留版本');
  f.button('继续修改').click();await wait();assert.equal(f.dom.window.continues[0].sessionId,'chat-a');assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('OIP open waits for confirmation and blocks duplicate opens without claiming synchronization',async()=>{
 const initialTask={...oipTask,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const sync={state:'pending_confirmation',message:'请在 OIP 确认打开工程。'};
 const f=await fixture({initialTask,sourceRevision:savedRevision,resourceResult:{toolSync:{oip:sync}},syncSnapshot:sync});
 try{assert.equal(f.button('在 OIP 查看').disabled,true);f.button('在 OIP 查看').click();assert.equal(f.dom.window.resources.length,0);assert.match(f.dom.window.document.body.textContent,/等待 OIP 确认/);assert.doesNotMatch(f.dom.window.document.body.textContent,/已同步保留版本/);assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('OIP review and old result cards never borrow a different saved revision sync',async()=>{
 const initialTask={...oipTask,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const f=await fixture({both:true,initialTask,sourceRevision:savedRevision,syncSnapshot:{state:'synced',revision:digest}});
 try{assert.equal(f.button('在 OpenPLC 查看','.pc-review'),undefined);assert.ok(f.button('在 OIP 查看','.pc-review'));assert.match(f.dom.window.document.body.textContent,/OIP 显示其他版本/);assert.doesNotMatch(f.dom.window.document.body.textContent,/已同步保留版本/);assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('an OIP candidate popup resolves through its exact launch observation without opening a second window',async()=>{
 const observationRevision='f'.repeat(64),f=await fixture({initialTask:oipTask,resourceResult:{launchId:'editor-'+'9'.repeat(32),observationRevision,toolSync:{oip:{state:'pending_confirmation',message:'请在 OIP 确认打开工程。'}}},resourceObservation:{state:'synced',revision:observationRevision}});
 try{
  f.button('在 OIP 查看').click();await wait();assert.equal(f.dom.window.resources.length,1);assert.equal(f.button('在 OIP 查看').disabled,true);
  await new Promise(resolve=>setTimeout(resolve,1150));
  assert.equal(f.dom.window.resources.length,1);assert.equal(f.button('在 OIP 查看').disabled,false);assert.match(f.dom.window.document.body.textContent,/候选预览已载入/);assert.doesNotMatch(f.dom.window.document.body.textContent,/已同步保留版本/);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('card and review cannot double-submit; keep opens the same saved project and continues the same session',async()=>{
 let release;const result=new Promise(resolve=>{release=resolve;});
 const f=await fixture({both:true,onReview:async({setTask,setRevision})=>{await result;const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};setTask(kept);setRevision(savedRevision);return {ok:true,...target,candidateDigest:digest,task:kept};}});
 try{
  const keep=f.button('保留本轮修改');keep.click();keep.click();f.button('保留本轮修改','.pc-review').click();await wait();assert.equal(f.posts.length,1);
  assert.equal(JSON.parse(f.dom.window.localStorage.getItem(pendingKey)).clientRequestId,f.posts[0].clientRequestId);
  release();await wait();await wait();await wait();
  assert.equal(f.dom.window.localStorage.getItem(pendingKey),null);assert.equal(f.opens.length,1);assert.equal(f.opens[0].target,'retained');assert.equal(f.opens[0].projectId,projectId);
  assert.match(f.dom.window.document.querySelector('[data-result-status]').textContent,/已保留/);
  f.button('继续修改').click();await wait();assert.equal(f.dom.window.continues.length,1);assert.equal(f.dom.window.continues[0].sessionId,'chat-a');assert.equal(f.dom.window.legacy,0);
  assert.equal(f.button('保留本轮修改'),undefined);assert.equal(f.button('撤销本轮'),undefined);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('same-project review identifies its retained version without claiming a separate copy',async()=>{
 const kept={...task,status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}};
 const f=await fixture({reviewOnly:true,initialTask:kept,sourceRevision:savedRevision});
 try{
  assert.equal(f.dom.window.document.querySelector('.pc-review-state').textContent,'已保留到当前工程');
  assert.doesNotMatch(f.dom.window.document.querySelector('.pc-review').textContent,/已保留为独立工程/);
  assert.equal(f.posts.length,0);assert.equal(f.opens.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

for(const status of ['compile_failed','conflict','unknown_outcome'])test(`compact ${status} result identifies an old successful compile as historical`,async()=>{
 const current={...task,status,retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'},compilation:{status:'compiled',revision,diagnostic:'旧编译成功'}};
 const f=await fixture({initialTask:current,sourceRevision:savedRevision});
 try{
  const details=[...f.dom.window.document.querySelectorAll('.pc-result-card details')].find(d=>d.querySelector('summary')?.textContent==='PLC 编译详情');
  assert.ok(details);assert.match(details.textContent,/历史编译通过（旧版本回执），不代表本次操作成功/);
  assert.doesNotMatch(details.textContent,/编译通过；未执行运行验收/);
  assert.equal(f.posts.length,0);assert.equal(f.opens.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('unknown review outcome retains its request and only explicit reconciliation reuses that identity',async()=>{
 const f=await fixture({onReview:async({body,count,setTask})=>{
  if(count===1)throw new Error('connection lost');
  const discarded={...task,status:'discarded'};setTask(discarded);return {ok:true,...target,candidateDigest:digest,task:discarded};
 }});
 try{
  f.button('撤销本轮').click();await wait();await wait();assert.equal(f.posts.length,1);assert.equal(f.opens.length,0);
  const saved=JSON.parse(f.dom.window.localStorage.getItem(pendingKey));assert.equal(saved.action,'undo');assert.ok(f.button('保留本轮修改').disabled);
  f.button('核对原操作').click();await wait();await wait();assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.dom.window.localStorage.getItem(pendingKey),null);
  assert.match(f.dom.window.document.querySelector('[data-result-status]').textContent,/已撤销/);assert.equal(f.opens.length,0);assert.equal(f.button('保留本轮修改'),undefined);
 }finally{f.close();}
});

test('missing ownership and changed source version block direct writes; pending revision uses existing controller',async()=>{
 const missing=await fixture({owned:false});try{assert.equal(missing.button('保留本轮修改'),undefined);assert.match(missing.dom.window.document.body.textContent,/不属于当前会话/);assert.equal(missing.posts.length,0);}finally{missing.close();}
 const stale=await fixture({sourceRevision:savedRevision});try{assert.equal(stale.button('保留本轮修改').disabled,true);assert.equal(stale.button('继续修改').disabled,true);assert.equal(stale.posts.length,0);}finally{stale.close();}
 const fresh=await fixture();try{fresh.button('继续修改').click();await wait();assert.equal(fresh.dom.window.revisions.length,1);assert.equal(fresh.dom.window.revisions[0].taskId,taskId);assert.equal(fresh.posts.length,0);assert.equal(fresh.dom.window.continues.length,1);assert.equal(fresh.dom.window.continues[0].sessionId,'chat-a');assert.equal(fresh.dom.window.continues.length,1);assert.equal(fresh.dom.window.continues[0].sessionId,'chat-a');}finally{fresh.close();}
});

test('record detail has no self-navigation and verifies the exact retained version without opening another window',async()=>{
 const f=await fixture({hideRecordsLink:true});try{
  assert.equal(f.button('查看调整记录'),undefined);assert.equal(f.button('验证 PLC'),undefined);
  f.button('保留本轮修改').click();await wait();await wait();await wait();
  assert.equal(f.opens.length,1);assert.equal(f.button('验证 PLC').disabled,false);
  f.button('验证 PLC').click();await wait();await wait();
  assert.equal(f.posts.length,2);assert.equal(f.posts[1].action,'compile');assert.equal(f.posts[1].expectedRevision,savedRevision);
  assert.equal(f.opens.length,1);assert.match(f.dom.window.document.querySelector('[data-result-status]').textContent,/编译通过/);
  assert.match(f.dom.window.document.body.textContent,/编译验证通过/);assert.doesNotMatch(f.dom.window.document.body.textContent,/本轮候选已撤销/);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('undo after preview marks the old editor view as historical instead of claiming it restored the current project',async()=>{
 const f=await fixture();try{
  f.button('在 OpenPLC 查看').click();await wait();await wait();assert.equal(f.opens.length,1);
  f.button('撤销本轮').click();await wait();await wait();
  assert.equal(f.opens.length,1);assert.match(f.dom.window.document.body.textContent,/原 OpenPLC 预览不代表当前工程/);
  assert.equal(f.button('在 OpenPLC 查看').disabled,true);assert.equal(f.task.status,'discarded');assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

for(const reviewOnly of [false,true])for(const lostResponse of [false,true])test(`${reviewOnly?'full review':'compact card'} recovers a proven unpublished rejection${lostResponse?' from a task refresh after a lost response':''}`,async()=>{
 const reason='工程正在使用，未保存本次修改。';
 const f=await fixture({reviewOnly,onReview:async({body,count,setTask})=>{
  if(count===1){const rejected={...task,reason,reviewReceiptRequest:body,reviewRejection:{effectId:body.clientRequestId,code:'busy',reason,published:false}};setTask(rejected);
   if(lostResponse)throw new Error('response lost');return {ok:true,...target,candidateDigest:digest,task:rejected};}
  return {ok:true,...target,candidateDigest:digest,task};
 }}),scope=reviewOnly?'.pc-review':'.pc-result-card';
 try{
  f.button('保留本轮修改',scope).click();await wait();await wait();
  if(reviewOnly&&lostResponse){f.button('刷新',scope).click();await wait();await wait();}
  assert.equal(f.posts.length,1,'refresh recovery must not submit');assert.equal(f.opens.length,0);
  assert.equal(f.dom.window.localStorage.getItem(pendingKey),null);
  assert.equal(f.button('保留本轮修改',scope).disabled,false);
  assert.equal(f.button('只读核对原保存回执',scope),undefined,'a proven refusal should not be offered as an unknown keep receipt');
  assert.match(f.dom.window.document.querySelector(scope).textContent,/工程正在使用/);
  assert.doesNotMatch(f.dom.window.document.querySelector(scope).textContent,/修改已保留|正在确认修改工程的保存结果/);
  f.button('保留本轮修改',scope).click();await wait();await wait();
  assert.equal(f.posts.length,2);assert.notEqual(f.posts[1].clientRequestId,f.posts[0].clientRequestId);
  assert.equal(f.dom.window.localStorage.getItem(pendingKey)!==null,true,'awaiting_review alone is not a rejection receipt');
  assert.equal(f.opens.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

for(const reviewOnly of [false,true])test(`${reviewOnly?'full review':'compact card'} preserves unknown accepted outcomes and ignores a rejection for another effect`,async()=>{
 const f=await fixture({reviewOnly,onReview:async({body,setTask})=>{
  const unresolved={...task,status:'unknown_outcome',reviewRejection:{effectId:'another-attempt',code:'busy',reason:'旧请求被拒绝',published:false}};
  setTask(unresolved);return {ok:true,...target,candidateDigest:digest,task:unresolved};
 }}),scope=reviewOnly?'.pc-review':'.pc-result-card';
 try{
  f.button('保留本轮修改',scope).click();await wait();await wait();
  assert.equal(f.posts.length,1);assert.equal(f.opens.length,0);
  assert.equal(JSON.parse(f.dom.window.localStorage.getItem(pendingKey)).clientRequestId,f.posts[0].clientRequestId);
  assert.match(f.dom.window.document.querySelector(scope).textContent,/待核对/);
  assert.doesNotMatch(f.dom.window.document.querySelector(scope).textContent,/修改已保留|正在确认修改工程的保存结果/);
 }finally{f.close();}
});
