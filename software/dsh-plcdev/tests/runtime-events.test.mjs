import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeEvents,filterRuntimeEvents,runtimeEventIssues,createRuntimeEventReader} from '../src/client/runtime-events.mjs';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const project='user-example',stamp=1794900000,revision='a'.repeat(64);
const event=(extra={})=>({id:'event-1',source:'fuxa',severity:'warning',phase:'通信',summary:'画面数据读取超时',detail:'PLC 独立采样仍有效。',raw:'read: ETIMEDOUT',firstAt:stamp,lastAt:stamp+8,count:8,status:'active',sessionId:'run-1',projectRevision:revision,programHash:'b'.repeat(64),variables:[{name:'BatchCount',value:24,quality:'过期'}],...extra});
const payload=(extra={})=>({schemaVersion:1,projectId:project,projectRevision:revision,observedAt:stamp+10,currentSessionId:'run-1',events:[event()],sources:[{id:'fuxa',state:'partial',label:'FUXA',reason:'已接入通信状态'}],...extra});
const pause=()=>new Promise(r=>setTimeout(r,20));
const until=async(check)=>{for(let i=0;i<100;i++){if(check())return;await pause();}assert.ok(check(),'UI did not settle');};
test('validates project ownership, bounded fields and unique event identities',()=>{
 assert.equal(validateRuntimeEvents(payload(),project).events.length,1);
 for(const invalid of [payload({projectId:'another'}),payload({observedAt:'now'}),payload({events:[event(),event()]}),payload({events:[event({raw:'x'.repeat(33000)})]}),payload({events:[event({source:'unknown'})]}),payload({events:[event({lastAt:stamp-1})]}),payload({sources:[{id:'fuxa',state:'normal',label:'FUXA'}]})])assert.throws(()=>validateRuntimeEvents(invalid,project));
});
test('current instance filtering preserves unassigned engineering checks, excludes old Runtime and counts only active issues',()=>{
 const value=payload({events:[event(),event({id:'old',sessionId:'run-old'}),event({id:'compile',sessionId:null,source:'compiler',status:'resolved',resolvedAt:stamp+9}),event({id:'info',severity:'info',status:'recorded'})]});
 assert.deepEqual(filterRuntimeEvents(value).map(e=>e.id).sort(),['compile','event-1','info']);
 assert.equal(filterRuntimeEvents(value,{scope:'all'}).length,4);assert.equal(filterRuntimeEvents(value,{source:'fuxa',issuesOnly:true}).length,1);
 assert.equal(runtimeEventIssues(value).fuxa,1);assert.equal(runtimeEventIssues(value).compiler,0);
 assert.deepEqual(filterRuntimeEvents({...value,currentSessionId:null}).map(e=>e.id),['compile']);
});
test('current checks exclude known other saved revisions while unknown attribution remains explicit',()=>{
 const value=payload({events:[event({id:'old-check',source:'oip',sessionId:null,projectRevision:'c'.repeat(64)}),event({id:'current-check',source:'compiler',sessionId:null}),event({id:'unknown-check',source:'compiler',sessionId:null,projectRevision:null}),event({id:'current-run',projectRevision:'d'.repeat(64)})]});
 assert.deepEqual(filterRuntimeEvents(value).map(e=>e.id).sort(),['current-check','current-run','unknown-check']);
 assert.equal(filterRuntimeEvents(value,{scope:'all'}).length,4);assert.equal(runtimeEventIssues(value).oip,0);
 assert.equal(filterRuntimeEvents({...value,projectRevision:null}).length,4);
 assert.equal(runtimeEventIssues({...value,projectRevision:null}).oip,0);assert.equal(runtimeEventIssues({...value,projectRevision:null}).compiler,1);assert.equal(runtimeEventIssues({...value,projectRevision:null}).fuxa,1);
});
test('reader is single flight, keeps past data on failure and ignores disposed response',async()=>{
 const pending=[];let requests=0;
 const reader=createRuntimeEventReader(project,{api:()=>{requests++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));},setTimer:()=>0,clearTimer:()=>{}});
 const stop=reader.subscribe(()=>{});const first=reader.refresh();assert.equal(requests,1);pending[0].resolve(payload());await first;
 const saved=reader.snapshot().value;assert.ok(saved);
 const second=reader.refresh();pending[1].reject(Error('offline'));await second;assert.equal(reader.snapshot().value,saved);assert.match(reader.snapshot().error,/offline/);
 const third=reader.refresh();reader.dispose();pending[2].resolve(payload({events:[]}));await third;assert.equal(reader.snapshot().value,saved);stop();
});
test('bad project response never replaces previously verified events',async()=>{
 let next=payload();const reader=createRuntimeEventReader(project,{api:async()=>next,setTimer:()=>0,clearTimer:()=>{}});
 await reader.refresh();next=payload({projectId:'other'});await reader.refresh();assert.equal(reader.snapshot().value.projectId,project);assert.ok(reader.snapshot().error);reader.dispose();
});
test('unsubscribe/remount retires prior request and can resume in React strict lifecycle',async()=>{
 const pending=[];const reader=createRuntimeEventReader(project,{api:()=>new Promise(resolve=>pending.push(resolve)),setTimer:()=>0,clearTimer:()=>{}});
 const first=reader.subscribe(()=>{});first();const second=reader.subscribe(()=>{});
 pending[0](payload({events:[event({summary:'retired'})]}));await pause();assert.equal(reader.snapshot().value,null);
 pending[1](payload({events:[event({summary:'current'})]}));await pause();assert.equal(reader.snapshot().value.events[0].summary,'current');second();reader.dispose();
});

let bundle;
async function mount(){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),source=resolve(root,'software/dsh-plcdev/src/client/RuntimeEvents.tsx').replaceAll('\\','/');
 if(!bundle)bundle=(await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {RuntimeEvents} from '${source}';const app=createRoot(document.getElementById('root'));window.setProject=id=>app.render(<RuntimeEvents projectId={id} onNode={source=>window.nodes.push(source)} onEvents={(value,meta)=>window.states.push({value,meta})}/>);window.setProject('${project}');window.cleanup=()=>app.unmount();`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',write:false,target:'es2022',alias:{react:packages.resolve('react')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],requests=[],state={response:payload(),fail:false,hold:null};
 // jsdom 22 cannot parse @container; layout is checked in Chromium separately.
 const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>{if(e.type!=='css parsing')errors.push(e.message);});
 const dom=new JSDOM('<div id="root"></div><script>'+bundle.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(w){w.nodes=[];w.states=[];w.fetch=async(url)=>{requests.push(String(url));if(state.hold)return new Promise(resolve=>state.hold(resolve));if(state.fail)throw Error('offline');return {ok:true,status:200,json:async()=>structuredClone(state.response)};};}});
 await until(()=>dom.window.document.querySelector('.pc-event-row'));
 const doc=dom.window.document,click=text=>{const node=[...doc.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(node,text);node.click();};
 return {dom,doc,state,click,errors,requests,close(){dom.window.cleanup();dom.window.close();}};
}
test('React refresh preserves expanded detail/raw logs and marks failed reads historical without false recovery',async()=>{
 const f=await mount();try{
  f.doc.querySelector('.pc-event-row').click();await until(()=>f.doc.querySelector('.pc-event-detail'));
  f.doc.querySelector('.pc-event-raw').open=true;f.state.response=payload({events:[event({count:9,lastAt:stamp+12})]});f.click('刷新事件');
  await until(()=>f.doc.querySelector('.pc-event-repeat')?.textContent==='×9');assert.equal(f.doc.querySelector('.pc-event-raw').open,true);
  f.click('查看运行节点');assert.deepEqual(Array.from(f.dom.window.nodes),['fuxa']);
  f.state.fail=true;f.click('刷新事件');await until(()=>f.doc.querySelector('.pc-events-error'));
  assert.match(f.doc.querySelector('.pc-events-error').textContent,/历史记录/);assert.match(f.doc.querySelector('.pc-event-meta').textContent,/上次待处理/);
  assert.equal(f.doc.querySelector('.pc-event-raw').open,true);assert.equal(f.dom.window.states.at(-1).meta.stale,true);
  assert.deepEqual(f.errors,[]);assert.ok(f.requests.every(url=>url.includes('/runtime-events?project=')));
 }finally{f.close();}
});
test('React project switch drops old events immediately; a delayed previous project read cannot leak',async()=>{
 const f=await mount();try{
  let resolveOld;f.state.hold=resolve=>{resolveOld=resolve;};f.click('刷新事件');await until(()=>!!resolveOld);
  f.state.hold=null;f.state.response=payload({projectId:'user-new',events:[event({id:'new',summary:'新工程检查'})]});f.dom.window.setProject('user-new');
  await until(()=>f.doc.querySelector('.pc-event-summary')?.textContent==='新工程检查');
  resolveOld({ok:true,status:200,json:async()=>payload()});await pause();assert.equal(f.doc.querySelector('.pc-event-summary').textContent,'新工程检查');
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
