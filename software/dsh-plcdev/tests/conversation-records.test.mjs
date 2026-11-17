import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const component=resolve(root,'software/dsh-plcdev/src/client/ConversationRecords.tsx').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64),revision='d'.repeat(64);
const task={projectId,taskId,request:'本轮修改',workflow:'project-edit-v1',status:'discarded',projectRevision:revision,candidate:{candidateDigest:digest,components:[{tool:'openplc',summary:'更新 main.st'}],changes:[{path:'plc/main.st',beforeSha256:revision,afterSha256:digest}]}};
let compiled;
async function fixture({offline=false,focus=null}={}){
 if(!compiled)compiled=(await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationRecords} from ${JSON.stringify(component)};const listeners=new Set();const controller={snapshot:()=>window.state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},refresh:()=>{}};const app=createRoot(document.getElementById('root'));window.render=()=>app.render(<ConversationRecords sessionId="chat-a" contexts={{get:()=>controller}} viewRequest={window.focus?{focus:window.focus}:null} completeViewRequest={()=>{window.completed++;window.focus=null;}} openView={id=>window.navigation.push(id)}/>);window.reconnect=()=>{window.offline=false;window.state={...window.state,backendDisconnected:false,error:''};listeners.forEach(fn=>fn());};window.stop=()=>app.unmount();window.render();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],requests=[];
 const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(`<div id="root"></div><script>${compiled.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
  w.offline=offline;w.focus=focus;w.completed=0;w.navigation=[];w.currentTask=structuredClone(task);
  w.state={binding:{conversationId:'chat-a',projectId,version:1,taskRefs:[{projectId,taskId}],pendingRequests:[]},backendDisconnected:offline,error:offline?'工程服务未连接':'',busy:false,pending:null,storageError:''};
  w.fetch=async(url,options={})=>{requests.push({url,method:options.method||'GET'});const u=new URL(url,w.location.href);
   if(w.offline)return {ok:false,status:503,json:async()=>({error:'工程服务未连接'})};
   const value=u.pathname.endsWith('/conversations')?w.state.binding:u.pathname.endsWith('/status')?{project:{id:projectId},projects:[{id:projectId}]}:{projectId,projectRevision:revision,tasks:[w.currentTask,{...task,taskId:'task-'+'f'.repeat(32),request:'另一会话的修改'}]};
   return {ok:true,status:200,json:async()=>value};
  };
 }});
 const wait=()=>new Promise(r=>setTimeout(r,120));await wait();await wait();
 return {dom,requests,errors,wait,close(){dom.window.stop();dom.window.close();}};
}

test('records show only this conversation, contextual entry expands once and returns through native view action',async()=>{
 const f=await fixture({focus:{projectId,taskId}});try{
  await f.wait();const d=f.dom.window.document;
  assert.equal(d.querySelectorAll('[data-record-task]').length,1);assert.doesNotMatch(d.getElementById('root').textContent,/另一会话的修改/);
  assert.equal(d.querySelector('[data-record-task]').dataset.focused,'true');assert.equal(d.querySelector('[aria-expanded]').getAttribute('aria-expanded'),'true');assert.equal(f.dom.window.completed,1);
  assert.doesNotMatch(d.getElementById('root').textContent,/查看调整记录/);assert.match(d.querySelector('.pc-result-card')?.textContent||'',/撤销/);
  [...d.querySelectorAll('button')].find(b=>b.textContent==='返回对话').click();assert.deepEqual(Array.from(f.dom.window.navigation),['chat']);
  assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('records recover after connection without duplicate unavailable rows or user mutations',async()=>{
 const f=await fixture({offline:true});try{
  assert.equal(f.dom.window.document.querySelectorAll('.pc-records-error').length,1);assert.equal(f.dom.window.document.querySelectorAll('[data-record-task]').length,0);
  f.dom.window.reconnect();await f.wait();await f.wait();
  assert.equal(f.dom.window.document.querySelectorAll('[data-record-task]').length,1);assert.equal(f.dom.window.document.querySelectorAll('.pc-records-error').length,0);
  assert.equal(f.dom.window.document.querySelector('[aria-expanded]').getAttribute('aria-expanded'),'false');assert.equal(f.dom.window.document.querySelector('.pc-result-card'),null);
  assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('folded records refresh owned review notifications without reopening rows or replaying actions',async()=>{
 const f=await fixture();try{
  const w=f.dom.window,d=w.document,row=()=>d.querySelector('[data-record-task]');
  assert.match(row().textContent,/已撤销/);const initial=f.requests.length;
  w.currentTask={...w.currentTask,status:'awaiting_review'};
  w.dispatchEvent(new w.CustomEvent('plcdev:review-changed',{detail:{key:'plcdev.dsh.d3.review.other.'+projectId+'.'+taskId}}));await f.wait();assert.equal(f.requests.length,initial);
  const key='plcdev.dsh.d3.review.chat-a.'+projectId+'.'+taskId;
  w.dispatchEvent(new w.CustomEvent('plcdev:review-changed',{detail:{key}}));await f.wait();await f.wait();
  assert.match(row().textContent,/待确认/);assert.equal(row().querySelector('button').getAttribute('aria-expanded'),'false');assert.equal(d.querySelector('.pc-result-card'),null);
  w.currentTask={...w.currentTask,status:'discarded'};w.dispatchEvent(new w.StorageEvent('storage',{key}));await f.wait();await f.wait();assert.match(row().textContent,/已撤销/);
  assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
