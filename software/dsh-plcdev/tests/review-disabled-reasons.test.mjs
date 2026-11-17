import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDisabledReason,revisionDisabledReason} from '../src/client/review-ui-state.mjs';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64),source='d'.repeat(64);
const target={projectId,taskId},task={projectId,taskId,status:'awaiting_review',workflow:'hmi-static-text-v1',projectRevision:source,candidate:{candidateDigest:digest}};
const input={sessionId:'chat-a',task,target,busy:false,pendingAction:null,revision:{same:true},retainedProjectId:null};
test('review action explanations follow the actual source, effect and task state',()=>{
 assert.equal(reviewDisabledReason({...input,action:'keep'}),'');
 assert.match(reviewDisabledReason({...input,action:'compile'}),/先保留修改/);
 assert.match(reviewDisabledReason({...input,action:'keep',revision:{same:false}}),/保存版本已变化.*继续修改/);
 assert.match(reviewDisabledReason({...input,action:'keep',revision:{same:null}}),/版本尚未确认/);
 assert.match(reviewDisabledReason({...input,action:'undo',pendingAction:{action:'keep'}}),/结果待核对/);
 assert.match(reviewDisabledReason({...input,action:'keep',busy:true}),/正在处理/);
 assert.match(reviewDisabledReason({...input,action:'compile',task:{...task,status:'unknown_outcome'}}),/结果未知.*不要重复提交/);
 assert.match(reviewDisabledReason({...input,action:'compile',task:{...task,status:'keeping'}}),/正在保留.*等待/);
 assert.match(reviewDisabledReason({...input,action:'undo',task:{...task,supersededBy:'new'}}),/被新候选替代/);
 assert.equal(reviewDisabledReason({...input,action:'compile',retainedProjectId:'user-copy',task:{...task,status:'kept',retention:{revision:'e'.repeat(64)}}}), '');
});

test('revision explains missing binding, pending delivery and existing revision',()=>{
 const state={busy:false,pending:null,storageError:'',binding:{projectId,pendingRequests:[]}};
 assert.equal(revisionDisabledReason(state,task),'');
 assert.match(revisionDisabledReason({...state,binding:null},task),/工程尚未确认/);
 assert.match(revisionDisabledReason({...state,binding:{...state.binding,pendingRequests:[{}]}},task),/先核对原请求/);
 assert.match(revisionDisabledReason({...state,binding:{...state.binding,revisionContext:{state:'armed'}}},task),/已有修订上下文/);
 assert.equal(revisionDisabledReason({...state,binding:{...state.binding,revisionContext:{state:'submitted'}}},task),'');
 assert.match(revisionDisabledReason({...state,binding:{...state.binding,projectId:'other',submissionConflicts:[{}]}},task),/不同任务身份.*不能设置新修订/);
 assert.match(revisionDisabledReason({...state,binding:{...state.binding,submissionInFlight:[{state:'active_or_unknown'}]}},task),/仍在途.*不能设置新修订/);
});

test('disabled actions expose their nearby explanation to assistive technology',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="chat-a" useTabInfo={()=>({tab:{navigation:{params:window.target}}})} onOverview={()=>{}}/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.target=target;w.fetch=async url=>{const p=new URL(url,'http://127.0.0.1:55119').pathname;
   if(p.endsWith('/conversations'))return {ok:true,json:async()=>({conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]})};
   if(p.endsWith('/status'))return {ok:true,json:async()=>({project:{id:projectId,name:'测试工程'},projects:[{id:projectId}]})};
   return {ok:true,json:async()=>({projectId,projectRevision:'f'.repeat(64),tasks:[{...task,request:'修改名称'}]})};};}});
 try{await new Promise(r=>setTimeout(r,150));const buttons=[...dom.window.document.querySelectorAll('button')],find=label=>buttons.find(b=>b.textContent===label);
  const keep=find('保留本轮修改'),compile=find('编译保留版本');assert.ok(keep?.disabled&&compile?.disabled);
  for(const [button,pattern] of [[keep,/保存版本已变化/],[compile,/先保留修改/]]){const id=button.getAttribute('aria-describedby');assert.ok(id);assert.match(dom.window.document.getElementById(id).textContent,pattern);}
  assert.match(dom.window.document.body.textContent,/不能保留或继续修改/);
 }finally{dom.window.cleanup();dom.window.close();}
});

test('revision button explains missing session binding next to the action',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const state={binding:null,busy:false,pending:null,storageError:''};const controller={snapshot:()=>state,subscribe:()=>()=>{},revise:()=>window.writes++};const root=createRoot(document.getElementById('root'));window.writes=0;root.render(<ConversationReview sessionId="chat-a" contexts={{get:()=>controller}} useTabInfo={()=>({tab:{navigation:{params:window.target}}})} onOverview={()=>{}}/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.target=target;w.fetch=async url=>{const p=new URL(url,'http://127.0.0.1:55119').pathname;
   if(p.endsWith('/conversations'))return {ok:true,json:async()=>({conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]})};
   if(p.endsWith('/status'))return {ok:true,json:async()=>({project:{id:projectId,name:'测试工程'},projects:[{id:projectId}]})};
   return {ok:true,json:async()=>({projectId,projectRevision:source,tasks:[{...task,request:'修改文字',candidate:{...task.candidate,revisionSupported:true}}]})};};}});
 try{await new Promise(resolve=>setTimeout(resolve,150));const button=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='切回此工程继续修改');assert.ok(button?.disabled);const id=button.getAttribute('aria-describedby');assert.ok(id);assert.match(dom.window.document.getElementById(id).textContent,/会话工程尚未确认/);button.click();assert.equal(dom.window.writes,0);
 }finally{dom.window.cleanup();dom.window.close();}
});
