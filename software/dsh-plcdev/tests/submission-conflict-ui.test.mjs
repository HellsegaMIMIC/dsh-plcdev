import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBinding} from '../src/client/conversation-client.mjs';

const projectId='user-'+'a'.repeat(32),accepted='task-'+'b'.repeat(32),observed='task-'+'c'.repeat(32),clientRequestId='request-original';
const conflict={projectId,clientRequestId,acceptedTaskId:accepted,observedTaskIds:[observed]};
const binding={conversationId:'chat-a',projectId,version:1,taskRefs:[{projectId,taskId:accepted,clientRequestId}],pendingRequests:[],submissionConflicts:[conflict]};

test('identity-conflict display accepts only bounded evidence tied to the original task reference',()=>{
 assert.equal(validateBinding(binding,'chat-a'),binding);
 for(const invalid of [
  {...conflict,acceptedTaskId:observed},
  {...conflict,projectId:'wrong-project'},
  {...conflict,observedTaskIds:[accepted]},
  {...conflict,observedTaskIds:[observed,observed]},
  {...conflict,observedTaskIds:Array.from({length:17},(_,i)=>'task-'+i.toString(16).padStart(32,'0'))},
  {...conflict,extra:'not allowed'},
 ])assert.throws(()=>validateBinding({...binding,submissionConflicts:[invalid]},'chat-a'),/冲突/);
 assert.throws(()=>validateBinding({...binding,submissionConflicts:[conflict,conflict]},'chat-a'),/冲突/);
 assert.throws(()=>validateBinding({...binding,taskRefs:[]},'chat-a'),/冲突/);
});

test('in-flight entries must be bounded and tied to a pending request or recorded task',()=>{
 const flight={projectId,clientRequestId,state:'active_or_unknown'};
 assert.equal(validateBinding({...binding,submissionInFlight:[flight]},'chat-a').submissionInFlight[0],flight);
 for(const bad of [{...flight,state:'gone'}, {...flight,clientRequestId:'other'}, {...flight,projectId:'different'}, {...flight,pid:1}])
  assert.throws(()=>validateBinding({...binding,submissionInFlight:[bad]},'chat-a'),/在途/);
 assert.throws(()=>validateBinding({...binding,submissionInFlight:[flight,flight]},'chat-a'),/在途/);
 const legacy={projectId,clientRequestId:'legacy',state:'legacy_unknown'};
 assert.doesNotThrow(()=>validateBinding({...binding,pendingRequests:[{projectId,clientRequestId:'legacy',state:'unknown'}],submissionInFlight:[legacy]},'chat-a'));
 assert.doesNotThrow(()=>validateBinding({...binding,submissionInFlight:[{...flight,state:'evidence_conflict'}]},'chat-a'));
});

test('header keeps identity conflict visible and never treats an observed task as owned',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),component=resolve(root,'software/dsh-plcdev/src/client/ConversationHeader.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationHeader} from ${JSON.stringify(component)};const state={binding:window.binding,projects:[],busy:false,pending:{projectId:window.binding.projectId,clientRequestId:'request-original'}};const ctrl={snapshot:()=>state,subscribe:()=>()=>{},checkReceipt:value=>window.checked=value,retryPending:()=>window.retries++};const nav={snapshot:()=>null,subscribe:()=>()=>{}};const root=createRoot(document.getElementById('root'));window.retries=0;root.render(<ConversationHeader sessionId="chat-a" contexts={{get:()=>ctrl}} navigation={nav} onProject={()=>{}} onPicker={()=>{}} onReview={()=>{}}/>);window.stop=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.binding={...binding,submissionInFlight:[{projectId,clientRequestId,state:'active_or_unknown'}]};}});
 try{await new Promise(resolve=>setTimeout(resolve,150));const d=dom.window.document,indicator=d.querySelector('[aria-label="身份冲突，查看详情"]');assert.ok(indicator);assert.match(indicator.textContent,/身份冲突/);assert.doesNotMatch(d.querySelector('#root').textContent,new RegExp(accepted));assert.doesNotMatch(d.querySelector('#root').textContent,new RegExp(observed));assert.equal(d.querySelectorAll('.pc-context-status').length,0);assert.equal(d.querySelector('.pc-context-menu'),null);
  indicator.click();await new Promise(resolve=>setTimeout(resolve,80));const menu=d.querySelector('.pc-context-menu');assert.match(menu.querySelector('[role="alert"]').textContent,/原请求身份冲突.*不能切换工程/);const identities=[...menu.querySelectorAll('details')].find(e=>e.querySelector('summary')?.textContent.startsWith('查看身份冲突'));assert.ok(identities);assert.equal(identities.open,false);assert.match(identities.textContent,new RegExp(accepted));assert.match(identities.textContent,new RegExp(observed));assert.equal(identities.querySelector('button'),null);
  const flight=menu.querySelector('[aria-label="待核对请求"]');assert.match(flight.textContent,/即使查到任务也需等待投递收束/);flight.querySelector('button').click();assert.equal(dom.window.checked.clientRequestId,clientRequestId);
  const retry=[...d.querySelectorAll('button')].find(b=>b.textContent==='以原请求编号核对／重试');assert.ok(retry?.disabled);retry.click();assert.equal(dom.window.retries,0);assert.equal([...d.querySelectorAll('button')].filter(b=>b.textContent==='只读核对原任务').length,1);
  d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,50));assert.equal(d.querySelector('.pc-context-menu'),null);assert.match(d.querySelector('[aria-label="身份冲突，查看详情"]').textContent,/身份冲突/);assert.equal(d.activeElement,indicator);
 }finally{dom.window.stop();dom.window.close();}
});
