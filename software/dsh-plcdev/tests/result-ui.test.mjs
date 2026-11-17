import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const component=resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),copy='user-'+'c'.repeat(32),digest='d'.repeat(64),revision='e'.repeat(64);
const target={projectId,taskId};
const initial={...target,request:'新增 DoubleValue 并修改 main',status:'awaiting_review',workflow:'project-edit-v1',projectRevision:revision,candidate:{candidateDigest:digest,components:[{tool:'openplc',summary:'新增 DoubleValue 函数并更新 main 调用'}],changes:[{path:'plc/pous/functions/DoubleValue.st',beforeSha256:null,afterSha256:'f'.repeat(64)}]}};
const wait=()=>new Promise(r=>setTimeout(r,140));
const response=value=>({ok:true,status:200,json:async()=>value});
async function bundle(contents){return (await buildTools.build({stdin:{contents,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;}

test('readable result, keep and retry-open stay on one retained project after editor failure',async()=>{
 const built=await bundle(`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="chat-a" target={window.target} onContinueRetained={()=>{throw Error('Must reuse editor session')}} onOpenEditorSession={value=>{window.navigation.push(value);return Promise.resolve({ok:true});}}/>);window.stop=()=>root.unmount();`);
 const {JSDOM}=packages('jsdom');let current=initial;const keeps=[],opens=[],previews=[];
 const dom=new JSDOM(`<div id="root"></div><script>${built.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.target=target;w.navigation=[];w.fetch=async(url,options={})=>{
  const u=new URL(url,'http://127.0.0.1:55119');
  if(u.pathname.endsWith('/editor-open')){const body=JSON.parse(options.body);opens.push(body);return response({ok:true,sourceProjectId:projectId,taskId,targetProjectId:copy,sessionId:'shared-copy-session',nativeProjectPath:'D:/copy/plc/project.json',launchId:'editor-'+opens.length,state:opens.length===1?'failed':'loaded',message:opens.length===1?'编辑器暂不可用。':undefined});}
  if(u.pathname.endsWith('/review')){const body=JSON.parse(options.body);keeps.push(body);current={...current,status:'kept',retention:{keptProjectId:copy,revision,projectName:'工具试用 · AI副本'}};return response({ok:true,...target,candidateDigest:digest,task:current});}
  if(u.pathname.endsWith('/preview')){previews.push(u);return response({...target,candidateDigest:digest,files:[{path:'plc/pous/functions/DoubleValue.st',kind:'st',beforeText:'',beforeSha256:null,afterText:'FUNCTION DoubleValue : INT\nDoubleValue := Value * 2;\nEND_FUNCTION'},{path:'plc/pous/programs/main.ld',kind:'ld',beforeText:'PROGRAM main',afterText:'PROGRAM main\nVAR Running : BOOL; END_VAR',before:{rungs:[]},after:{rungs:[{comment:'启动自保持，Stop 复位',nodes:[{type:'contact',data:{variant:'negated',variable:{name:'Stop'}}},{type:'coil',data:{variable:{name:'Running'}}}],edges:[{}]}]}},{path:'devices/private.json',kind:'metadata',beforeText:null,afterText:null,unavailableReason:'设备配置不展开'}],truncated:false});}
  if(u.pathname.endsWith('/conversations'))return response({conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]});
  if(u.pathname.endsWith('/status'))return response({project:{id:projectId,name:'工具试用'},projects:[{id:projectId}]});
  return response({projectId,projectRevision:revision,tasks:[current]});
 };}});
 const button=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);
 try{
  await wait();await wait();assert.equal(previews.length,0);button('查看改动').click();await wait();assert.equal(previews.length,1);assert.equal(previews[0].searchParams.get('candidateDigest'),digest);
  assert.match(dom.window.document.body.textContent,/DoubleValue := Value \* 2/);assert.match(dom.window.document.querySelector('[aria-label="选择修改文件"]').textContent,/main.ld/);assert.doesNotMatch(dom.window.document.querySelector('[role=dialog]').textContent,/设备配置不展开/);
  const keep=button('保留本轮修改');keep.click();keep.click();await wait();
  assert.equal(keeps.length,1);assert.equal(opens.length,1);assert.equal(opens[0].target,'retained');
  assert.match(dom.window.document.body.textContent,/修改工程已保存。编辑器暂不可用/);
  assert.match(dom.window.document.body.textContent,/已保存到：工具试用 · AI副本/);
  assert.equal(button('在 OpenPLC 预览'),undefined);
  button('在 OpenPLC 查看').click();await wait();
  assert.equal(keeps.length,1);assert.equal(opens.length,2);assert.equal(opens[1].target,'retained');assert.equal(opens[1].taskId,taskId);
  assert.match(dom.window.document.body.textContent,/OpenPLC 已确认打开对应工程/);
  button('前往编辑器会话').click();await wait();assert.equal(dom.window.navigation.length,1);assert.equal(dom.window.navigation[0].sessionId,'shared-copy-session');assert.equal(dom.window.navigation[0].targetProjectId,copy);
 }finally{dom.window.stop();dom.window.close();}
});

test('reopening a saved review recovers the shared editor session without spawning or making another conversation',async()=>{
 const built=await bundle(`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="chat-a" target={window.target} onContinueRetained={()=>{throw Error('Must reuse editor session')}} onOpenEditorSession={value=>{window.navigation.push(value);return Promise.resolve({ok:true});}}/>);window.stop=()=>root.unmount();`);
 const {JSDOM}=packages('jsdom'),posts=[];
 const kept={...initial,status:'kept',retention:{keptProjectId:copy,revision}};
 const dom=new JSDOM(`<div id="root"></div><script>${built.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.target=target;w.navigation=[];w.fetch=async(url,options={})=>{
  const u=new URL(url,'http://127.0.0.1:55119');if(options.body){posts.push({path:u.pathname,body:JSON.parse(options.body)});return response({ok:true,sourceProjectId:projectId,taskId,candidateDigest:digest,targetProjectId:copy,sessionId:'shared-copy-session'});}
  if(u.pathname.endsWith('/conversations'))return response({conversationId:'chat-a',projectId,version:1,taskRefs:[target],pendingRequests:[]});
  if(u.pathname.endsWith('/status'))return response({project:{id:projectId,name:'工具试用'},projects:[{id:projectId}]});
  if(u.pathname.endsWith('/preview'))return response({...target,candidateDigest:digest,files:[]});
  return response({projectId,projectRevision:revision,tasks:[kept]});
 };}});
 try{await wait();await wait();const button=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='基于修改副本继续修改');button.click();button.click();await wait();assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/editor-session'));assert.equal(posts[0].body.target,'retained');assert.equal(dom.window.navigation.length,1);assert.equal(dom.window.navigation[0].sessionId,'shared-copy-session');assert.equal(dom.window.navigation[0].targetProjectId,copy);}
 finally{dom.window.stop();dom.window.close();}
});

test('two visible turn cards preserve their own task and do not borrow the next turn result',async()=>{
 const built=await bundle(`import React from 'react';import {createRoot} from 'react-dom/client';import {TurnResultCards} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));root.render(<>{[1,2].map(turn=><TurnResultCards key={turn} turn={{turn}} sessionId="chat-a" usePlcdevTurnTools={key=>window.turns[key]} onReviewTask={value=>window.reviews.push(value)}/>)}</>);window.stop=()=>root.unmount();`);
 const {JSDOM}=packages('jsdom');const second={...initial,taskId:'task-'+'f'.repeat(32),request:'第二轮独立修改',candidate:{...initial.candidate,components:[{tool:'openplc',summary:'第二轮修改 DoubleValue'}]}};
 const node=t=>({root:{kind:'result',call:{name:'plcdev_propose_project_edit'},content:[{type:'text',text:JSON.stringify({task:t,projectName:'工具试用'})}],subCalls:[]}});
 const dom=new JSDOM(`<div id="root"></div><script>${built.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.turns={1:[node(initial)],2:[node(second)]};w.reviews=[];w.fetch=async url=>{const u=new URL(url,'http://127.0.0.1:55119');if(u.pathname.endsWith('/conversations'))return response({conversationId:'chat-a',projectId,version:1,taskRefs:[target,{projectId,taskId:second.taskId}],pendingRequests:[]});return response(u.pathname.endsWith('/preview')?{projectId,taskId:u.searchParams.get('taskId'),candidateDigest:digest,files:[{path:'plc/pous/functions/DoubleValue.st',kind:'st',beforeText:'',afterText:u.searchParams.get('taskId')===taskId?'DoubleValue := Value * 2;':'DoubleValue := Value * 3;'}]}:{projectId,projectRevision:revision,tasks:[initial,second]});};}});
 try{
  await wait();await wait();const cards=[...dom.window.document.querySelectorAll('[data-plcdev-turn-results]')];assert.equal(cards.length,2);
  for(const card of cards){const toggle=card.querySelector('.pc-operation-toggle');assert.equal(toggle.getAttribute('aria-expanded'),'false');toggle.click();}
  await wait();assert.match(cards[0].textContent,/新增 DoubleValue/);assert.doesNotMatch(cards[0].textContent,/第二轮修改|FUXA|OIP/);assert.match(cards[1].textContent,/第二轮修改 DoubleValue/);
  cards[0].querySelector('.pc-preview-launch').click();await wait();assert.match(dom.window.document.querySelector('.pc-result-popover').textContent,/DoubleValue := Value \* 2/);
  dom.window.document.querySelector('.pc-result-popover [aria-label="关闭修改详情"]').click();await wait();
  cards[1].querySelector('.pc-preview-launch').click();await wait();assert.match(dom.window.document.querySelector('.pc-result-popover').textContent,/DoubleValue := Value \* 3/);
  dom.window.document.querySelector('.pc-result-popover [aria-label="关闭修改详情"]').click();await wait();
  cards[0].querySelector('.pc-result-details').click();cards[1].querySelector('.pc-result-details').click();assert.deepEqual(dom.window.reviews.map(x=>x.taskId),[taskId,second.taskId]);
 }
 finally{dom.window.stop();dom.window.close();}
});
