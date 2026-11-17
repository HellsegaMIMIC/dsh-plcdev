import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerifiedSessionNavigator} from '../src/client/session-navigation.mjs';
import {createConversationNavigation} from '../src/client/conversation-client.mjs';
const projectId='project-a',sessionId='chat-a',taskId='task-'+'a'.repeat(32);
function setup({listed=true,child=false,referenced=true}={}){
 const calls=[],navigation=createConversationNavigation();
 const sessions={refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',ids:listed?[sessionId]:[],byId:{[sessionId]:{origin:child?'subagent':undefined}}})}};
 const workspace={openSession:id=>calls.push(id)};
 const api=async()=>({projectId,current:[{conversationId:sessionId,currentProjectId:projectId,taskIds:referenced?[taskId]:[]}],historical:[],unavailable:[],countsComplete:true});
 return {calls,navigation,sessions,workspace,open:createVerifiedSessionNavigator({services:()=>({sessions,workspace}),navigation,api,timeout:30})};
}
test('only exact referenced main session can navigate and acknowledgement is required',async()=>{
 const x=setup();let intent; x.navigation.subscribe(()=>{const v=x.navigation.snapshot();if(v){intent=v;x.navigation.complete(v);}});
 const result=await x.open({projectId,sessionId,taskId});assert.equal(result.ok,true);assert.equal(result.dispatched,true);assert.deepEqual(x.calls,[sessionId]);assert.equal(intent.taskId,taskId);
 for(const opts of [{listed:false},{child:true},{referenced:false}]){const y=setup(opts);const denied=await y.open({projectId,sessionId,taskId});assert.equal(denied.ok,false);assert.equal(y.calls.length,0);}
});
test('unacknowledged navigation times out and cannot later open a stale request',async()=>{
 const x=setup();const result=await x.open({projectId,sessionId,taskId});assert.equal(result.ok,false);assert.equal(result.dispatched,true);assert.equal(x.navigation.snapshot(),null);
 const y=setup(),abort=new AbortController();abort.abort();const cancelled=await y.open({projectId,sessionId,taskId,signal:abort.signal});assert.equal(cancelled.ok,false);assert.deepEqual(y.calls,[]);
});
test('a session removed while association is read is never opened',async()=>{
 let listed=true;const calls=[];const sessions={refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',ids:listed?[sessionId]:[],byId:{[sessionId]:{}}})}},workspace={openSession:id=>calls.push(id)};
 const api=async()=>{listed=false;return {projectId,current:[{conversationId:sessionId,currentProjectId:projectId,taskIds:[taskId]}],historical:[],unavailable:[],countsComplete:true};};
 const open=createVerifiedSessionNavigator({services:()=>({sessions,workspace}),navigation:createConversationNavigation(),api,timeout:30});
 assert.equal((await open({projectId,sessionId,taskId})).ok,false);assert.deepEqual(calls,[]);
});
test('superseded verified navigation cannot acknowledge a later intent',async()=>{
 const n=createConversationNavigation();const first=n.requestVerified({projectId,sessionId,taskId},1000);const stale=n.snapshot();const second=n.requestVerified({projectId,sessionId},1000);const current=n.snapshot();n.complete(stale);assert.equal(n.snapshot(),current);n.complete(current);assert.equal((await first).ok,false);assert.equal((await second).ok,true);
});
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
test('only target mounted header with its own task reference acknowledges review',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const dir=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationHeader} from '${dir}/ConversationHeader.tsx';import {createConversationNavigation} from '${dir}/conversation-client.mjs';const nav=createConversationNavigation(),state={binding:null,projects:[],busy:false};const ctrl={snapshot:()=>state,subscribe:()=>()=>{}};const contexts={get:()=>ctrl};const root=createRoot(document.getElementById('root'));window.nav=nav;window.show=id=>root.render(<ConversationHeader sessionId={id} contexts={contexts} navigation={nav} onProject={()=>{}} onPicker={()=>{}} onReview={(sid,target)=>window.review={sid,...target}}/>);window.stop=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');let permit=true;
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.fetch=async(url)=>{const sid=new URL(url,'http://127.0.0.1:55119').searchParams.get('conversationId');return {ok:true,json:async()=>({conversationId:sid,projectId,version:1,pendingRequests:[],taskRefs:permit?[{projectId,taskId}]:[]})};};}});
 const wait=()=>new Promise(r=>setTimeout(r,80));
 try{dom.window.show('chat-other');await wait();const pending=dom.window.nav.requestVerified({projectId,sessionId,taskId},500);await wait();assert.equal(dom.window.review,undefined);dom.window.show(sessionId);await wait();assert.equal((await pending).ok,true);assert.equal(dom.window.review.sid,sessionId);dom.window.review=undefined;permit=false;const denied=await dom.window.nav.requestVerified({projectId,sessionId,taskId},500);assert.equal(denied.ok,false);assert.equal(dom.window.review,undefined);}finally{dom.window.stop();dom.window.close();}
});
