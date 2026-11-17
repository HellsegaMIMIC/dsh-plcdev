import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('a late pre-keep poll cannot restore an actionable candidate or duplicate the request', {timeout:15000}, async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
 const bundle=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="chat-a" useTabInfo={()=>({tab:{navigation:{params:window.target}}})} onOverview={()=>{}}/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom'),projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64),revision='d'.repeat(64),kept='e'.repeat(64);
 const target={projectId,taskId},original={projectId,taskId,status:'awaiting_review',workflow:'joint-ai-v1',projectRevision:revision,candidate:{candidateDigest:digest}},completed={...original,status:'kept',retention:{revision:kept,keptProjectId:'user-'+'f'.repeat(32)}};
 let taskReads=0,releaseOld,signalPoll,posts=0,opens=0,current=original;
 const pollStarted=new Promise(resolve=>signalPoll=resolve);
 const response=value=>({ok:true,status:200,json:async()=>value});
 const dom=new JSDOM(`<div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  w.target=target;w.fetch=async(url,options={})=>{const p=new URL(url,'http://127.0.0.1:55119').pathname;
   if(p.endsWith('/editor-open')){opens++;const body=JSON.parse(options.body);assert.equal(body.target,'retained');return response({ok:true,sourceProjectId:projectId,taskId,targetProjectId:completed.retention.keptProjectId,launchId:'editor-race',nativeProjectPath:'D:/copy/plc/project.json',state:'loaded'});}
   if(options.body){posts++;const body=JSON.parse(options.body);assert.equal(body.action,'keep');current=completed;return response({ok:true,projectId,taskId,candidateDigest:digest,task:completed});}
   if(p.endsWith('/conversations'))return response({conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]});
   if(p.endsWith('/status'))return response({project:{id:projectId,name:'测试工程'},projects:[{id:projectId}]});
   if(++taskReads===2)return new Promise(resolve=>{releaseOld=()=>resolve(response({projectId,projectRevision:revision,tasks:[original]}));signalPoll();});
   return response({projectId,projectRevision:revision,tasks:[current]});
  };
 }});
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),button=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);
 try{
  await wait(150);assert.equal(button('保留本轮修改').disabled,false);
  await pollStarted;
  const keep=button('保留本轮修改');keep.click();keep.click();button('在 OpenPLC 预览').click();await wait(150);
  assert.equal(posts,1,'repeated clicks and a competing open must not dispatch another request');
  assert.equal(button('保留本轮修改'),undefined);assert.equal(opens,1,'the single confirmed keep opens the retained project once');
  releaseOld();await wait(150);
  assert.equal(button('保留本轮修改'),undefined,'an older in-flight poll must not restore the keep action');assert.equal(opens,1);
  assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='撤销本轮'),false);
 }finally{if(releaseOld)releaseOld();dom.window.closeReact();dom.window.close();}
});

test('returning to a candidate during its pending keep preserves the original request', {timeout:10000}, async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
 const bundle=await buildTools.build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};function App(){const [target,setTarget]=useState(window.targets[0]);window.go=i=>setTarget(window.targets[i]);return <ConversationReview sessionId="chat-a" useTabInfo={()=>({tab:{navigation:{params:target}}})} onOverview={()=>{}}/>}const root=createRoot(document.getElementById('root'));root.render(<App/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom'),revision='d'.repeat(64),digest='c'.repeat(64),kept='e'.repeat(64);
 const targets=['a','b'].map(letter=>({projectId:'user-'+letter.repeat(32),taskId:'task-'+letter.repeat(32)}));
 const tasks=targets.map((t,i)=>({...t,request:'候选 '+i,status:'awaiting_review',workflow:'hmi-view-name-v1',projectRevision:revision,candidate:{candidateDigest:digest}}));
 const completed={...tasks[0],status:'kept',retention:{revision:kept,keptProjectId:'user-'+'f'.repeat(32)}};
 let finishKeep,posts=0;
 const response=value=>({ok:true,status:200,json:async()=>value});
 const dom=new JSDOM(`<div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  w.targets=targets;w.fetch=async(url,options={})=>{const u=new URL(url,'http://127.0.0.1:55119');
   if(options.body){posts++;return new Promise(resolve=>{finishKeep=()=>resolve(response({ok:true,...targets[0],candidateDigest:digest,task:completed}));});}
   if(u.pathname.endsWith('/conversations'))return response({conversationId:'chat-a',projectId:targets[0].projectId,version:1,taskRefs:targets,pendingRequests:[]});
   const id=u.searchParams.get('project'),i=targets.findIndex(t=>t.projectId===id);
   if(u.pathname.endsWith('/status'))return response({project:{id,name:'工程 '+i},projects:[{id}]});
   return response({projectId:id,projectRevision:revision,tasks:[tasks[i]]});
  };
 }});
 const wait=()=>new Promise(resolve=>setTimeout(resolve,150)),button=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);
 try{
  await wait();button('保留本轮修改').click();await wait();assert.equal(posts,1);
  dom.window.go(1);await wait();assert.match(dom.window.document.body.textContent,/候选 1/);
  dom.window.go(0);await wait();finishKeep();await wait();
  assert.equal(posts,1);assert.equal(button('保留本轮修改'),undefined);
  assert.doesNotMatch(dom.window.document.body.textContent,/审阅请求待核对/);
  assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='撤销本轮'),false);
 }finally{dom.window.closeReact();dom.window.close();}
});

for(const compact of [true,false])test(`${compact?'card':'review'} late keep response after a session switch cannot release or open the new session`,async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),source=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
 const bundle=await buildTools.build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from '${source}/Conversation.tsx';import {CandidateResultCard} from '${source}/CandidateResultCard.tsx';const contexts={get:sessionId=>({snapshot:()=>({binding:window.binding(sessionId)}),subscribe:()=>()=>{},refresh:()=>{}})};function App(){const [sessionId,setSession]=useState('chat-a');window.go=setSession;const props={sessionId,contexts,target:window.target};return ${compact?'<CandidateResultCard block={window.block} {...props}/>':'<ConversationReview {...props}/>'};}const root=createRoot(document.getElementById('root'));root.render(<App/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom'),projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64),revision='d'.repeat(64);
 const target={projectId,taskId},original={...target,workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,candidate:{candidateDigest:digest,components:[{tool:'openplc',summary:'更新 main'}],changes:[{path:'plc/main.st',beforeSha256:revision,afterSha256:digest}]}};
 const newRequest={conversationId:'chat-b',...target,candidateDigest:digest,expectedRevision:revision,action:'keep',clientRequestId:'new-session-request'};
 const key=session=>'plcdev.dsh.d3.review.'+session+'.'+projectId+'.'+taskId;
 let release,current=original,posts=0,opens=0;
 const response=value=>({ok:true,status:200,json:async()=>value});
 const dom=new JSDOM(`<div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  w.target=target;w.block={content:[{type:'text',text:JSON.stringify({task:original})}]};
  w.binding=conversationId=>({conversationId,projectId,version:1,taskRefs:[target],pendingRequests:[]});
  w.fetch=async(url,options={})=>{const u=new URL(url,'http://127.0.0.1:55119');
   if(u.pathname.endsWith('/review')){posts++;const {conversationId,...completion}=JSON.parse(options.body);return new Promise(resolve=>{release=()=>{current={...original,status:'kept',reviewCompletions:[completion],retention:{revision:'e'.repeat(64),keptProjectId:projectId,completionScope:'saved-project-version'}};resolve(response({ok:true,...target,candidateDigest:digest,task:current}));};});}
   if(u.pathname.endsWith('/editor-open')){opens++;throw Error('A background completion must not open a tool');}
   if(u.pathname.endsWith('/conversations'))return response(w.binding(u.searchParams.get('conversationId')));
   if(u.pathname.endsWith('/status'))return response({project:{id:projectId,name:'测试工程'},projects:[{id:projectId}]});
   return response({projectId,projectRevision:revision,tasks:[current]});
  };
 }});
 const wait=()=>new Promise(resolve=>setTimeout(resolve,150));
 try{
  await wait();await wait();[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='保留本轮修改').click();await wait();assert.equal(posts,1);
  dom.window.localStorage.setItem(key('chat-b'),JSON.stringify(newRequest));dom.window.go('chat-b');await wait();
  release();await wait();await wait();
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(key('chat-b'))),newRequest);
  assert.equal(dom.window.localStorage.getItem(key('chat-a')),null,'only the submitted session request may be released');
  assert.equal(posts,1);assert.equal(opens,0);
 }finally{dom.window.cleanup();dom.window.close();}
});
