import test from 'node:test';
import assert from 'node:assert/strict';
import {revisionGroups,validateProjectConversations,hostSessionTitle} from '../src/client/project-sessions.mjs';
const id=n=>'task-'+n.repeat(32), project='project-a';
const digest='a'.repeat(64), revision='b'.repeat(64);
const task=(n,parent)=>({taskId:id(n),projectId:project,projectRevision:revision,candidate:{candidateDigest:digest},...(parent?{parentTaskId:id(parent),parentCandidateDigest:digest}:{})});
test('explicit unbranched revisions collapse without merging independent requirements',()=>{
 const tasks=[task('a'),task('b','a'),task('c','b'),task('d')];
 assert.deepEqual(revisionGroups(tasks.map(t=>t.taskId),tasks,project).map(g=>g.map(t=>t.taskId)),[[id('a'),id('b'),id('c')],[id('d')]]);
 assert.deepEqual(revisionGroups([id('a'),id('c')],tasks,project).map(g=>g.length),[1,1]);
 const conflicting=[tasks[0],{...tasks[1],parentCandidateDigest:'f'.repeat(64)}];assert.deepEqual(revisionGroups(conflicting.map(t=>t.taskId),conflicting,project).map(g=>g.length),[1,1]);
});
test('branches, cycles and foreign or unreferenced tasks never collapse or leak',()=>{
 const tasks=[task('a'),task('b','a'),task('c','a'),task('d','e'),task('e','d'),{...task('f'),projectId:'project-b'},task('1')];
 const groups=revisionGroups([id('a'),id('b'),id('c'),id('d'),id('e'),id('f')],tasks,project);
 assert.equal(groups.length,5);assert.ok(groups.every(g=>g.length===1));assert.equal(groups.flat().some(t=>['f','1'].includes(t.taskId[5])),false);
});
test('association payload enforces exact project and separates current from history',()=>{
 const value={projectId:project,current:[{conversationId:'chat-a',currentProjectId:project,taskIds:[id('a')]}],historical:[{conversationId:'chat-b',currentProjectId:'project-b',taskIds:[id('b')]}],unavailable:[],countsComplete:true};
 assert.equal(validateProjectConversations(value,project),value);
 assert.throws(()=>validateProjectConversations({...value,projectId:'project-b'},project));
 assert.throws(()=>validateProjectConversations({...value,unavailable:[{conversationId:'missing'}]},project));
 assert.throws(()=>validateProjectConversations({...value,historical:value.current},project));
 assert.throws(()=>validateProjectConversations({...value,current:[{...value.current[0],currentProjectId:'project-b'}]},project));
});
test('session title is sourced only from listed host main sessions',()=>{
 const s={ids:['a','b'],byId:{a:{title:'主会话'},b:{title:'团队成员',origin:'subagent'},c:{title:'未列出'}}};
 assert.equal(hostSessionTitle(s,'a'),'主会话');assert.equal(hostSessionTitle(s,'b'),null);assert.equal(hostSessionTitle(s,'c'),null);
});
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
test('project session UI ignores a late response after project switch and shows host title',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/ProjectSessions.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectSessions} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));window.show=(projectId,tasks)=>root.render(<ProjectSessions projectId={projectId} tasks={tasks} hostSessions={window.hostSessions}/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');let releaseA;
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
   const list={getSnapshot:()=>({ids:['chat-b'],byId:{'chat-b':{title:'宿主标题'}}}),subscribe:()=>()=>{}};w.hostSessions={get:()=>({list}),subscribe:()=>()=>{}};
   w.fetch=(url)=>{const p=new URL(url,'http://127.0.0.1:55119').searchParams.get('projectId');return new Promise(resolve=>{const send=()=>resolve({ok:true,json:async()=>({projectId:p,current:[{conversationId:p==='project-a'?'chat-a':'chat-b',currentProjectId:p,taskIds:[]}],historical:[],unavailable:[],countsComplete:true})});if(p==='project-a')releaseA=send;else send();});};
 }});
 const wait=()=>new Promise(r=>setTimeout(r,80));
 try{dom.window.show('project-a',{projectId:'project-a',tasks:[]});await wait();dom.window.show('project-b',{projectId:'project-b',tasks:[]});await wait();assert.match(dom.window.document.body.textContent,/宿主标题/);releaseA();await wait();assert.match(dom.window.document.body.textContent,/宿主标题/);assert.doesNotMatch(dom.window.document.body.textContent,/chat-a/);const card=dom.window.document.querySelector('article');assert.match(card.querySelector('[data-session-summary]').textContent,/宿主标题.*暂无修改/);assert.doesNotMatch(card.querySelector('[data-session-summary]').textContent,/chat-b/);const identity=card.querySelector('.pc-session-identity');assert.equal(identity.open,false);assert.match(identity.textContent,/chat-b/);assert.doesNotMatch(card.textContent,/查看修改方案/);}finally{dom.window.closeReact();dom.window.close();}
});

test('switching project ignores an old navigation failure and permits a new attempt',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/ProjectSessions.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectSessions} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));window.show=projectId=>root.render(<ProjectSessions projectId={projectId} tasks={{projectId,tasks:[]}} hostSessions={window.hostSessions} openSession={window.openSession}/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom');let finishOld,oldSignal;
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  const list={getSnapshot:()=>({phase:'ready',ids:['chat-a','chat-b'],byId:{'chat-a':{title:'会话 A'},'chat-b':{title:'会话 B'}}}),subscribe:()=>()=>{}};w.hostSessions={get:()=>({list}),subscribe:()=>()=>{}};
  w.fetch=async url=>{const p=new URL(url,'http://127.0.0.1:55119').searchParams.get('projectId');return {ok:true,json:async()=>({projectId:p,current:[{conversationId:p==='project-a'?'chat-a':'chat-b',currentProjectId:p,taskIds:[]}],historical:[],unavailable:[],countsComplete:true})};};
  w.openSession=({projectId,signal})=>projectId==='project-a'?new Promise(resolve=>{oldSignal=signal;finishOld=resolve;}):Promise.reject(Error('当前会话服务不可用'));
 }});
 const wait=()=>new Promise(r=>setTimeout(r,80));
 try{
  dom.window.show('project-a');await wait();dom.window.document.querySelector('article button').click();await wait();assert.equal(oldSignal.aborted,false);
  dom.window.show('project-b');await wait();assert.equal(oldSignal.aborted,true);finishOld({ok:false,message:'旧工程跳转失败'});await wait();
  assert.doesNotMatch(dom.window.document.body.textContent,/旧工程跳转失败/);
  const next=dom.window.document.querySelector('article button');assert.equal(next.disabled,false);next.click();await wait();
  assert.match(dom.window.document.body.textContent,/当前会话服务不可用/);assert.equal(next.disabled,false);
 }finally{dom.window.closeReact();dom.window.close();}
});

test('session summary hides identifiers while review still targets the latest owned revision',async()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const component=resolve(root,'software/dsh-plcdev/src/client/ProjectSessions.tsx').replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectSessions} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ProjectSessions projectId="project-a" tasks={window.tasks} hostSessions={window.hostSessions} openSession={window.openSession}/>);window.closeReact=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM}=packages('jsdom'),opened=[];
 const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){
  const list={getSnapshot:()=>({phase:'ready',ids:['chat-a','chat-b'],byId:{'chat-a':{title:'计数画面调整'},'chat-b':{title:'旧会话'}}}),subscribe:()=>()=>{}};w.hostSessions={get:()=>({list}),subscribe:()=>()=>{}};
  w.tasks={projectId:project,tasks:[{...task('a'),status:'superseded',request:'把标题改为生产计数',updatedAt:10},{...task('b','a'),status:'awaiting_review',request:'继续改成批次计数',updatedAt:20},{...task('d'),status:'kept',request:'旧修改',updatedAt:5}]};
  w.fetch=async()=>({ok:true,json:async()=>({projectId:project,current:[{conversationId:'chat-a',currentProjectId:project,taskIds:[id('a'),id('b')]}],historical:[{conversationId:'chat-b',currentProjectId:'project-b',taskIds:[id('d')]}],unavailable:[],countsComplete:true})});
  w.openSession=async value=>{opened.push(value);return {ok:true};};
 }});
 const wait=()=>new Promise(r=>setTimeout(r,90));
 try{
  await wait();await wait();const d=dom.window.document,card=d.querySelector('article'),summary=card.querySelector('[data-session-summary]');
  assert.match(summary.textContent,/计数画面调整.*待审阅 1 项/);assert.doesNotMatch(summary.textContent,/chat-a|task-/);
  assert.match(card.querySelector('.pc-session-latest').textContent,/继续改成批次计数/);
  const proposals=[...card.querySelectorAll('details')].find(e=>e.querySelector('summary')?.textContent==='查看修改方案（1）');assert.equal(proposals.open,false);proposals.open=true;
  [...proposals.querySelectorAll('button')].find(b=>b.textContent==='在所属会话审阅').click();await wait();
  assert.equal(opened.length,1);assert.equal(opened[0].sessionId,'chat-a');assert.equal(opened[0].projectId,project);assert.equal(opened[0].taskId,id('b'));
  const history=[...d.querySelectorAll('details')].find(e=>e.querySelector('summary')?.textContent.startsWith('曾产生本工程任务的会话'));assert.equal(history.open,false);assert.match(history.textContent,/旧会话/);assert.match(history.textContent,/已保留/);assert.doesNotMatch(history.textContent,/已保留为独立工程/);assert.ok([...history.querySelectorAll('button')].some(b=>b.textContent==='在所属会话查看'));assert.match(history.querySelector('.pc-session-identity').textContent,/当前已切换工程.*chat-b.*project-b/);
 }finally{dom.window.closeReact();dom.window.close();}
});
