import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

for (const workflow of ['joint-ai-v1','team-generation-v1']) test(`${workflow} receipt is checked with original identity without dispatching a second keep`,async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
 const bundle=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="chat-a" useTabInfo={()=>({tab:{navigation:{params:window.target}}})} onOverview={()=>{}} onRetainedProject={(id,session)=>window.opened={session,id}}/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom'),projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),candidateDigest='c'.repeat(64),expectedRevision='d'.repeat(64),keptProjectId='user-'+'e'.repeat(32),revision='f'.repeat(64),posts=[];
 const original={projectId,taskId,candidateDigest,expectedRevision,action:'keep',clientRequestId:'original-effect'};
 let state='unknown';
 const dom=new JSDOM(`<div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  w.target={projectId,taskId};w.fetch=async(url,options={})=>{const p=new URL(url,'http://127.0.0.1:55119').pathname;
   if(options.body){const body=JSON.parse(options.body);posts.push({path:p,body});return {ok:true,json:async()=>({ok:true,...original,state,reasonCode:'fixture',keptProjectId:state==='unknown'?null:keptProjectId,manifestPath:state==='unknown'?null:'D:/fixture/project.plcdev',revision:state==='unknown'?null:revision})};}
   if(p.endsWith('/conversations'))return {ok:true,json:async()=>({conversationId:'chat-a',projectId,version:1,taskRefs:[{projectId,taskId}],pendingRequests:[]})};
   if(p.endsWith('/status'))return {ok:true,json:async()=>({project:{id:projectId,name:'测试工程'},projects:[{id:projectId}]})};
   return {ok:true,json:async()=>({projectId,projectRevision:expectedRevision,tasks:[{projectId,taskId,projectRevision:expectedRevision,status:'unknown_outcome',workflow,request:'联合修改',candidate:{candidateDigest},reviewReceiptRequest:original}]})};
  };
 }});
 const button=text=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===text);
 const waitFor=async(predicate,label)=>{const deadline=Date.now()+10000;while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(predicate(),label+'\n'+dom.window.document.body.textContent);};
 const receiptReady=()=>button('只读核对原保存回执')&&!button('只读核对原保存回执').disabled;
 try{await waitFor(receiptReady,'review receipt control must be mounted and actionable');button('只读核对原保存回执').click();await waitFor(()=>receiptReady()&&/保存结果仍未知/.test(dom.window.document.body.textContent),'unknown receipt must finish');assert.match(dom.window.document.body.textContent,/保存结果仍未知/);
  state='confirmed_unregistered';button('只读核对原保存回执').click();await waitFor(()=>receiptReady()&&/工程清单尚未确认登记/.test(dom.window.document.body.textContent),'unregistered receipt must finish');assert.match(dom.window.document.body.textContent,/工程清单尚未确认登记/);assert.equal(button('查看已保存工程'),undefined);
  state='confirmed_registered';button('只读核对原保存回执').click();await waitFor(()=>receiptReady()&&button('查看已保存工程'),'registered receipt must finish');assert.match(dom.window.document.body.textContent,/已核对保存文件与工程清单/);button('查看已保存工程').click();assert.equal(dom.window.opened.id,keptProjectId);
  assert.equal(posts.length,3);for(const post of posts){assert.equal(post.path,'/api/plcdev/conversations/review-receipt');assert.deepEqual(post.body,{conversationId:'chat-a',...original});}
 }finally{dom.window.closeReact();dom.window.close();}
});
