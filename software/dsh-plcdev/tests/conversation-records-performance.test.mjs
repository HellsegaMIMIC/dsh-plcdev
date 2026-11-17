import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const client=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),otherProject='user-'+'b'.repeat(32),revision='d'.repeat(64),digest='e'.repeat(64);
const task=(n=1,project=projectId)=>({projectId:project,taskId:'task-'+n.toString(16).padStart(32,'0'),request:'修改 '+n,workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,candidate:{candidateDigest:digest,revisionSupported:true,components:[{tool:'openplc',summary:'更新 main.st'}],changes:[{path:'plc/main.st',beforeSha256:revision,afterSha256:digest}]}});
const binding=(session,tasks)=>({binding:{conversationId:session,projectId:tasks[0]?.projectId||null,version:1,taskRefs:tasks.map(({projectId,taskId})=>({projectId,taskId})),pendingRequests:[]},backendDisconnected:false,error:'',busy:false,pending:null,storageError:''});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function until(check){for(let n=0;n<80;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('UI condition did not settle');}
let compiled;
async function fixture({tasks=[task()],states,onFetch}={}){
 if(!compiled)compiled=(await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationRecords} from ${JSON.stringify(client+'/ConversationRecords.tsx')};import {CandidateResultCard} from ${JSON.stringify(client+'/CandidateResultCard.tsx')};import {taskReadsFor} from ${JSON.stringify(client+'/task-reads.mjs')};const controllers=new Map();const contexts={get(id){if(!controllers.has(id))controllers.set(id,{snapshot:()=>window.states[id],subscribe:()=>()=>{},refresh:()=>{}});return controllers.get(id)}};const app=createRoot(document.getElementById('root'));window.seed=id=>taskReadsFor(contexts).readRecords(id);window.showRecords=(sessionId='chat-a')=>app.render(<ConversationRecords contexts={contexts} sessionId={sessionId} openView={()=>{}}/>);window.showCards=()=>app.render(<>{window.tasks.map(task=><CandidateResultCard key={task.taskId} contexts={contexts} sessionId="chat-a" block={{content:[{type:'text',text:JSON.stringify({task})}]}}/>)}</>);window.hide=()=>app.render(null);window.stop=()=>{app.unmount();taskReadsFor(contexts).dispose();};`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],requests=[];
 const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(`<div id="root"></div><script>${compiled.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
  w.tasks=tasks;w.states=states||{'chat-a':binding('chat-a',tasks)};
  w.fetch=async(url,options={})=>{const u=new URL(url,w.location.href),entry={url:u.pathname,project:u.searchParams.get('project'),session:u.searchParams.get('conversationId'),method:options.method||'GET'};requests.push(entry);
   const supplied=await onFetch?.(entry);
   const value=supplied??(u.pathname.endsWith('/conversations')?w.states[entry.session].binding:{projectId:entry.project,projectRevision:revision,tasks:tasks.filter(t=>t.projectId===entry.project)});
   return {ok:true,status:200,json:async()=>value};
  };
 }});
 return {dom,requests,errors,get body(){return dom.window.document.body;},get rows(){return [...dom.window.document.querySelectorAll('[data-record-task]')];},get buttons(){return [...dom.window.document.querySelectorAll('button')];},close(){dom.window.stop();dom.window.close();}};
}

test('cold records render thirty owned changes with one lightweight request and no project inspection',async t=>{
 const tasks=Array.from({length:30},(_,n)=>task(n+1)),gate=deferred();
 const f=await fixture({tasks,onFetch:entry=>entry.url.endsWith('/task-records')?gate.promise:undefined});
 try{
  f.dom.window.showRecords();await until(()=>f.requests.length===1);assert.equal(f.rows.length,0);
  assert.equal(f.buttons.filter(b=>b.hasAttribute('aria-expanded')).length,0);
  const started=performance.now();gate.resolve({projectId,tasks:[...tasks,{...task(99),request:'另一会话的修改'}]});
  await until(()=>f.buttons.filter(b=>b.hasAttribute('aria-expanded')).length===30);
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].url.endsWith('/task-records'));assert.doesNotMatch(f.body.textContent,/另一会话的修改/);assert.deepEqual(f.errors,[]);
  t.diagnostic(`Cold render after lightweight response: ${(performance.now()-started).toFixed(1)} ms; 30 rows, 1 task-records request, 0 task-state/inspect requests (jsdom).`);
 }finally{f.close();}
});

test('cached records appear while refresh is pending, but expanded actions await fresh state and ownership',async t=>{
 const light=deferred(),fresh=deferred();let calls=0;
 const f=await fixture({onFetch:entry=>entry.url.endsWith('/task-records')&&++calls>1?light.promise:entry.url.endsWith('/task-state')?fresh.promise:undefined});
 try{
  await f.dom.window.seed(projectId);const started=performance.now();f.dom.window.showRecords();
  await until(()=>f.buttons.some(b=>b.hasAttribute('aria-expanded'))&&calls===2);
  t.diagnostic(`Cached list visible in ${(performance.now()-started).toFixed(1)} ms while the new task-records response remains unresolved (jsdom).`);
  assert.match(f.body.textContent,/正在更新/);f.buttons.find(b=>b.hasAttribute('aria-expanded')).click();
  await until(()=>f.requests.some(r=>r.url.endsWith('/task-state')));
  assert.equal(f.buttons.find(b=>b.textContent==='在 OpenPLC 查看').disabled,true);
  assert.ok(f.buttons.filter(b=>['保留本轮修改','撤销本轮'].includes(b.textContent)).every(b=>b.disabled));
  fresh.resolve({projectId,projectRevision:revision,tasks:[task()]});
  await until(()=>f.buttons.some(b=>b.textContent==='保留本轮修改'&&!b.disabled));
  light.resolve({projectId,tasks:[task()]});await until(()=>!f.body.textContent.includes('正在更新'));
  assert.equal(f.requests.filter(r=>r.url.endsWith('/task-state')).length,1);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
 }finally{light.resolve({projectId,tasks:[]});fresh.resolve({projectId,projectRevision:revision,tasks:[]});f.close();}
});

test('one slow project cannot hide another project and session switching never shows cached foreign records',async()=>{
 const first=task(1),second=task(2,otherProject),gate=deferred();
 const f=await fixture({tasks:[first,second],states:{'chat-a':binding('chat-a',[first,second]),'chat-b':binding('chat-b',[second])},onFetch:entry=>entry.project===otherProject&&entry.url.endsWith('/task-records')?gate.promise:undefined});
 try{
  f.dom.window.showRecords();await until(()=>f.buttons.some(b=>b.textContent.includes(first.request)));
  assert.match(f.body.textContent,/正在更新/);assert.equal(f.buttons.filter(b=>b.hasAttribute('aria-expanded')).length,1);
  f.dom.window.showRecords('chat-b');await until(()=>f.rows.length===0);
  assert.doesNotMatch(f.body.textContent,/修改 1/);gate.resolve({projectId:otherProject,tasks:[second]});
  await until(()=>f.buttons.some(b=>b.textContent.includes(second.request)));
  assert.doesNotMatch(f.body.textContent,/修改 1/);assert.equal(f.requests.filter(r=>r.project===otherProject).length,1);assert.deepEqual(f.errors,[]);
 }finally{gate.resolve({projectId:otherProject,tasks:[second]});f.close();}
});

test('a failed background record refresh retains the list and can recover without leaving the page',async()=>{
 let calls=0;
 const f=await fixture({onFetch:entry=>{if(!entry.url.endsWith('/task-records'))return;if(++calls===2)throw new Error('temporary disconnect');if(calls>2)return {projectId,tasks:[{...task(),status:'discarded'}]};}});
 try{
  await f.dom.window.seed(projectId);f.dom.window.showRecords();await until(()=>f.buttons.some(b=>b.textContent==='重试'));
  assert.equal(f.rows.length,1);assert.match(f.rows[0].textContent,/修改 1/);
  f.buttons.find(b=>b.textContent==='重试').click();await until(()=>f.rows[0]?.textContent.includes('已撤销'));
  assert.equal(f.buttons.some(b=>b.textContent==='重试'),false);assert.equal(calls,3);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('twenty real mounted result cards share two fresh network reads instead of forty',async t=>{
 const tasks=Array.from({length:20},(_,n)=>task(n+1)),gate=deferred();
 const f=await fixture({tasks,onFetch:()=>gate.promise});
 try{
  f.dom.window.showCards();await until(()=>f.requests.length>=2);
  assert.equal(f.requests.length,2);assert.equal(f.requests.filter(r=>r.url.endsWith('/task-state')).length,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/conversations')).length,1);
  gate.resolve();await until(()=>f.buttons.filter(b=>b.textContent==='保留本轮修改'&&!b.disabled).length===20);
  assert.equal(f.requests.length,2);assert.deepEqual(f.errors,[]);
  t.diagnostic('20 actual CandidateResultCard instances: 1 fresh task-state + 1 fresh conversation binding request.');
 }finally{gate.resolve();f.close();}
});
