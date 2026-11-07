import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {build}=buildTools;

const {JSDOM,VirtualConsole}=packages('jsdom');

test('D2 real React overview navigation keeps project scope and never emits Runtime actions',async()=>{
  const component=resolve(root,'software/dsh-plcdev/src/client/App.tsx').replaceAll('\\','/');
  const built=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {App} from ${JSON.stringify(component)};createRoot(document.getElementById('test')).render(React.createElement(App));`,loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
  const requests=[],events=[],errors=[];
  const projects=[{id:'A',name:'工程 A',plc:'A/plc/project.json',target:'local',defaultMode:'fuxa-oip',configuration:{hmiFile:'A/hmi.json',sceneFile:'A/scene.json'}},{id:'B',name:'工程 B',plc:'B/plc/project.json',target:'local',defaultMode:'local'}];
  const snapshot=id=>({project:projects.find(p=>p.id===id),projects,phase:'idle',session:{projectId:id,id:null,active:false},components:{plc:{state:'available',label:'入口可用'},runtime:{state:'idle'}},links:{load:{state:'unloaded'},generate:{state:'current'},variables:{state:'inactive'},io:{state:'inactive',details:{protocol:'Modbus TCP'}}},capabilities:{tools:{plc:true}},events:[]});
  const taskId='task-'+'a'.repeat(32);
  const tasks=id=>({projectId:id,projectRevision:'b'.repeat(64),capabilities:{savedRevisionCandidate:true},tasks:id==='A'?[{projectId:'A',taskId,status:'awaiting_review',request:'A 的候选',candidate:{candidateDigest:'c'.repeat(64)}}]:[]});
  const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});
  const dom=new JSDOM(`<div id="test"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.ResizeObserver=class{observe(){}disconnect(){}};
    w.fetch=async(url,options)=>{requests.push({url,method:options.method,body:options.body});assert.equal(options.method,'GET');const u=new URL(url,'http://127.0.0.1:55110'),id=u.searchParams.get('project')||'A';return{ok:true,json:async()=>u.pathname.endsWith('/tasks')?tasks(id):snapshot(id)};};
    w.addEventListener('plcdev:open-conversation',e=>events.push({name:e.type,...e.detail}));w.addEventListener('plcdev:review-task',e=>events.push({name:e.type,...e.detail}));
  }});
  const wait=()=>new Promise(r=>setTimeout(r,80)),d=dom.window.document;
  const click=async(label)=>{const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim()===label||x.getAttribute('aria-label')===label)||[...d.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith(label));assert.ok(b,'button '+label);b.click();await wait();};
  try{
    await wait();await wait();assert.deepEqual(errors,[]);
    assert.equal(d.querySelector('select[aria-label="选择工程"]').value,'A');assert.ok(d.querySelector('.pd-info.collapsed'));assert.equal(d.querySelectorAll('[data-node]').length,5);
    await click('PLC 程序');d.querySelector('[data-resource="plc"]').click();await wait();assert.ok(d.querySelector('[data-node="plc"].pd-selected'));assert.ok(d.querySelector('.pd-info-content').textContent.includes('A/plc/project.json'));
    d.querySelector('[data-edge="io"]').click();await wait();assert.equal(d.querySelectorAll('.pd-related').length,2);assert.ok(d.querySelector('.pd-info-content').textContent.includes('Modbus TCP'));
    await click('收起信息区');assert.ok(d.querySelector('.pd-info.collapsed'));
    await click('工程对话 ↗');assert.deepEqual(events.at(-1),{name:'plcdev:open-conversation',projectId:'A'});
    await click('候选任务');d.querySelector('[data-resource="task:'+taskId+'"]').click();await wait();await click('查看任务详情');assert.deepEqual(events.at(-1),{name:'plcdev:review-task',projectId:'A',taskId});
    const select=d.querySelector('select');select.value='B';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait();await wait();assert.deepEqual(errors,[]);
    assert.equal(d.querySelectorAll('[data-node]').length,2);assert.equal(d.querySelector('[data-edge="io"]'),null);assert.ok(d.querySelector('.pd-info.collapsed'));assert.ok(!d.querySelector('.pd-root').textContent.includes('A 的候选'));
    await click('仿真场景');assert.ok(d.querySelector('.pd-resource-menu').textContent.includes('未关联'));await click('变量监视');assert.ok(d.querySelector('.pd-info-content').textContent.includes('尚未提供'));
    assert.ok(requests.every(r=>r.method==='GET'));assert.equal(requests.some(r=>r.url.endsWith('/action')),false);assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
