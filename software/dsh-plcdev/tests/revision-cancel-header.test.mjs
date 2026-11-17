import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('header explains why a delivered revision cannot be cancelled',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/ConversationHeader.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationHeader} from ${JSON.stringify(component)};let state={binding:{projectId:'a',taskRefs:[],pendingRequests:[{projectId:'a',clientRequestId:'req',state:'unknown'}],revisionContext:{intentId:'i',state:'submitting'}},projects:[],busy:false};let listener=()=>{};const ctrl={snapshot:()=>state,subscribe:fn=>{listener=fn;return ()=>{}},cancelRevision:()=>window.cancelled++};const nav={snapshot:()=>null,subscribe:()=>()=>{}};const root=createRoot(document.getElementById('root'));window.cancelled=0;window.acceptedInFlight=()=>{state={...state,binding:{...state.binding,pendingRequests:[],submissionInFlight:[{projectId:'a',clientRequestId:'req',state:'active_or_unknown'}]}};listener()};window.settle=()=>{state={...state,binding:{...state.binding,pendingRequests:[],submissionInFlight:[]}};listener()};root.render(<ConversationHeader sessionId="chat" contexts={{get:()=>ctrl}} navigation={nav} onProject={()=>{}} onPicker={()=>{}} onReview={()=>{}}/>);window.stop=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously'});
 const wait=()=>new Promise(resolve=>setTimeout(resolve,100)),button=()=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='取消修订');
 try{
  await wait();assert.match(dom.window.document.body.textContent,/待核对/);assert.equal(button(),undefined,'the compact toolbar keeps revision actions inside its details');
  dom.window.document.querySelector('[aria-label="工程详情与恢复"]').click();await wait();assert.equal(button().disabled,true);assert.match(dom.window.document.querySelector('.pc-context-menu').textContent,/修订已投递或结果未知/);button().click();assert.equal(dom.window.cancelled,0);
  dom.window.acceptedInFlight();await wait();assert.equal(button().disabled,true);assert.match(dom.window.document.body.textContent,/不能取消修订/);button().click();assert.equal(dom.window.cancelled,0);
  dom.window.settle();await wait();assert.equal(button().disabled,false);button().click();assert.equal(dom.window.cancelled,1);
 }finally{dom.window.stop();dom.window.close();}
});
