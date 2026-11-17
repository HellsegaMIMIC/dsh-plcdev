import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
import {conversationParticipation,validateBinding,bindRequest} from '../src/client/conversation-client.mjs';
import {createConversationContexts} from '../src/client/conversation-context.mjs';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
const binding=(projectId=null,locked=false)=>({conversationId:'chat',projectId,version:1,taskRefs:[],pendingRequests:[],participation:{enabled:projectId!==null||locked,locked}});
const status={project:{id:'project-a'},projects:[{id:'project-a',name:'试用工程'}],session:{id:null,active:false},runtimeOwner:null,capabilities:{canPrepare:true}};

test('legacy bindings keep engineering identity and incomplete participation cannot unlock history',()=>{
  const plain={...binding(),participation:undefined};
  assert.deepEqual(conversationParticipation(plain),{enabled:false,locked:false});
  assert.deepEqual(conversationParticipation({...plain,projectId:'project-a'}),{enabled:true,locked:false});
  const history={...plain,taskRefs:[{projectId:'project-a',taskId:'task-'+'a'.repeat(32)}]};
  assert.deepEqual(conversationParticipation(history),{enabled:true,locked:true});
  assert.throws(()=>bindRequest(history,null),/已有工程操作/);
  assert.throws(()=>validateBinding({...history,participation:{enabled:false,locked:false}},'chat'),/状态无法核对/);
  assert.throws(()=>validateBinding({...binding(),participation:{enabled:true,locked:'false'}},'chat'),/状态无法核对/);
  assert.equal(validateBinding(binding('project-a',true),'chat').participation.locked,true);
});

test('ordinary session reads no engineering directory until picker explicitly subscribes, then stops on cancel',async()=>{
  const reads=[];const contexts=createConversationContexts({api:async path=>{reads.push(path);return path==='status'?status:binding();},storage:memory,interval:10});
  const controller=contexts.get('chat'),off=controller.subscribe(()=>{});
  try{
    await new Promise(resolve=>setTimeout(resolve,35));assert.equal(reads.includes('status'),false);
    const closePicker=controller.subscribeDirectory();await flush();assert.equal(controller.snapshot().projects[0].name,'试用工程');
    closePicker();await flush();const count=reads.filter(path=>path==='status').length;
    await new Promise(resolve=>setTimeout(resolve,35));assert.equal(reads.filter(path=>path==='status').length,count);assert.equal(controller.snapshot().projects.length,0);
  }finally{off();contexts.dispose();}
});

test('start selection enables tools identity, disable clears only an unused binding and locked sessions reject locally',async()=>{
  let current=binding();const writes=[];
  const contexts=createConversationContexts({storage:memory,api:async(path,body)=>{
    if(body){writes.push(body);current={...binding(body.projectId),version:current.version+1};return current;}
    return path==='status'?status:current;
  }}),controller=contexts.get('chat'),off=controller.subscribe(()=>{});
  try{
    await flush();await controller.bind('project-a');await flush();assert.equal(controller.snapshot().binding.participation.enabled,true);
    await controller.bind(null);await flush();assert.equal(controller.snapshot().binding.projectId,null);assert.equal(writes.length,2);assert.equal(writes[1].projectId,null);
    current=binding('project-a',true);controller.refresh();await flush();await controller.bind(null);
    assert.equal(writes.length,2);assert.match(controller.snapshot().error,/已有工程操作/);assert.equal(controller.snapshot().binding.projectId,'project-a');
  }finally{off();contexts.dispose();}
});

test('stale in-flight catalog reply cannot repopulate ordinary session after canceling picker',async()=>{
  let release;const contexts=createConversationContexts({storage:memory,api:async path=>path==='status'?new Promise(resolve=>release=resolve):binding()});
  const controller=contexts.get('chat'),off=controller.subscribe(()=>{});await flush();const closePicker=controller.subscribeDirectory();
  try{closePicker();release(status);await flush();assert.equal(controller.snapshot().projects.length,0);assert.equal(controller.snapshot().directoryError,'');}
  finally{off();contexts.dispose();}
});

test('start chip toggles through project choice, preserves composer, and locks into the compact engineering header',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),component=resolve(root,'software/dsh-plcdev/src/client/SessionParticipation.tsx').replaceAll('\\','/');
  const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {SessionParticipation} from '${component}';
  let state={binding:window.initial,projects:[{id:'project-a',name:'试用工程'}],busy:false},listeners=new Set();
  const controller={snapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},bind:projectId=>{window.writes.push(projectId);window.update({binding:{...state.binding,projectId,participation:{enabled:!!projectId,locked:false}}})},refresh:()=>window.refreshes++};
  window.update=patch=>{state={...state,...patch};listeners.forEach(fn=>fn())};
  const contexts={get:()=>controller},navigation={snapshot:()=>null,subscribe:()=>()=>{}};const root=createRoot(document.getElementById('root'));
  root.render(<SessionParticipation sessionId="chat" contexts={contexts} navigation={navigation} onPicker={id=>window.pickers.push(id)} onProject={()=>window.projects++} onReview={()=>{}}/>);window.stop=()=>root.unmount();`;
  const built=await buildTools.build({stdin:{contents:source,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
  const {JSDOM}=packages('jsdom'),dom=new JSDOM(`<textarea id="composer">尚未发送的需求</textarea><div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',beforeParse(w){w.initial=binding();w.writes=[];w.pickers=[];w.projects=0;w.refreshes=0;}});
  const wait=()=>new Promise(resolve=>setTimeout(resolve,60)),d=dom.window.document;
  try{
    await wait();const toggle=d.querySelector('[role=switch]');assert.equal(toggle.getAttribute('aria-checked'),'false');toggle.click();await wait();assert.deepEqual([...dom.window.pickers],['chat']);assert.equal(dom.window.writes.length,0,'opening chooser is not activation');
    dom.window.update({binding:binding('project-a')});await wait();assert.equal(d.querySelector('[role=switch]').getAttribute('aria-checked'),'true');assert.match(d.querySelector('#root').textContent,/试用工程/);
    d.querySelector('[role=switch]').click();await wait();assert.deepEqual([...dom.window.writes],[null]);assert.equal(d.querySelector('[role=switch]').getAttribute('aria-checked'),'false');
    dom.window.update({binding:binding('project-a',true)});await wait();assert.equal(d.querySelector('[role=switch]'),null);assert.match(d.querySelector('.pc-context-entry').textContent,/工程：试用工程/);
    d.querySelector('[aria-label="工程详情与恢复"]').click();await wait();assert.equal([...d.querySelectorAll('button')].some(button=>button.textContent==='退出工程模式'),false);assert.equal(d.querySelector('#composer').value,'尚未发送的需求');
    dom.window.update({binding:binding()});await wait();assert.ok(d.querySelector('[role=switch]'));
  }finally{dom.window.stop();dom.window.close();}
});
