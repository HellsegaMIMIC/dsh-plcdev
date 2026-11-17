import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
import {isBackendDisconnected,backendReadError} from '../src/client/backend-state.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),dir=fileURLToPath(new URL('../src/client/',import.meta.url)).replaceAll('\\','/');
const {JSDOM,VirtualConsole}=packages('jsdom');
const build=contents=>buildTools.build({stdin:{contents,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const component=await build(`import React from 'react';import {createRoot} from 'react-dom/client';import {BackendConnection} from '${dir}BackendConnection.tsx';const root=createRoot(document.getElementById('root'));window.reads=0;root.render(<BackendConnection onConnected={()=>window.reads++}/>);window.cleanup=()=>root.unmount();`);
const app=await build(`import React from 'react';import {createRoot} from 'react-dom/client';import {App} from '${dir}App.tsx';const root=createRoot(document.getElementById('root'));root.render(<App/>);window.cleanup=()=>root.unmount();`);
const wait=()=>new Promise(r=>setTimeout(r,30));
async function until(predicate){for(let i=0;i<60&&!predicate();i++)await wait();assert.ok(predicate(),'expected UI state');}
function mount(built,setup){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});
 const dom=new JSDOM('<div id="root"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.ResizeObserver=class{observe(){}disconnect(){}};setup(w);}});
 return {dom,d:dom.window.document,errors,close(){dom.window.cleanup();dom.window.close();}};
}
test('service recovery distinguishes disconnection from identity and validation failures',()=>{
 for(const code of ['controller_unavailable','upstream_unavailable']){assert.equal(isBackendDisconnected({code}),true);assert.match(backendReadError({code}),/请连接工程服务/);}
 for(const code of ['root_mismatch','instance_mismatch','project_mismatch','invalid_controller','invalid_root','version_mismatch','invalid_response',undefined]){assert.equal(isBackendDisconnected({code}),false);assert.equal(backendReadError({code,message:'保留核验失败原因'}),'保留核验失败原因');}
});
test('connection is explicit, suppresses duplicate clicks and refreshes only after confirmed service identity',async()=>{
 const requests=[];let release;const f=mount(component,w=>{w.fetch=(url,o)=>{requests.push({url,method:o.method,body:JSON.parse(o.body)});return new Promise(r=>release=r);};});
 try{await until(()=>f.d.querySelector('button'));assert.equal(requests.length,0);const button=f.d.querySelector('button');button.click();button.click();await until(()=>release);assert.deepEqual(requests,[{url:'/api/plcdev/backend/connect',method:'POST',body:{}}]);assert.equal(button.disabled,true);assert.equal(f.dom.window.reads,0);release({ok:true,json:async()=>({ok:true,connected:true,service:'plcdev-workbench',instance:'test-instance'})});await until(()=>f.dom.window.reads===1);assert.equal(requests.length,1);assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('failed or unconfirmed connection does not refresh or retry automatically',async()=>{
 for(const response of [{ok:false,status:503,json:async()=>({code:'python_not_configured',error:'Python 路径尚未配置。'})},{ok:true,json:async()=>({ok:true,connected:true,service:'different-service',instance:'other'})}]){
  let calls=0;const f=mount(component,w=>{w.fetch=async()=>{calls++;return response;};});
  try{await until(()=>f.d.querySelector('button'));f.d.querySelector('button').click();await until(()=>f.d.querySelector('[role="alert"]'));assert.equal(f.dom.window.reads,0);assert.equal(calls,1);assert.equal(f.d.querySelector('button').disabled,false);assert.deepEqual(f.errors,[]);}finally{f.close();}
 }
});
for(const code of ['upstream_unavailable','root_mismatch'])test('project page '+code+' preserves project and pending work through recovery',async()=>{
 const requests=[],pending=JSON.stringify([['project-a',{projectId:'project-a',clientRequestId:'old-request',request:'已有需求',expectedRevision:'a'.repeat(64),executionScope:'proposal',sourceBasis:'saved_revision'}]]);let online=false;
 const f=mount(app,w=>{
  w.localStorage.setItem('plcdev.dsh.d1.project','project-a');w.localStorage.setItem('plcdev.dsh.d1.pending',pending);
  w.fetch=async(url,o)=>{
   requests.push({url,method:o.method,body:o.body});
   if(o.method==='POST'){assert.equal(url,'/api/plcdev/backend/connect');assert.equal(o.body,'{}');online=true;return {ok:true,json:async()=>({ok:true,connected:true,service:'plcdev-workbench',instance:'test-instance'})};}
   if(!online)return {ok:false,status:503,json:async()=>({code,error:'原始失败原因'})};
   if(url.includes('/tasks'))return {ok:true,json:async()=>({projectId:'project-a',projectRevision:'b'.repeat(64),tasks:[]})};
   const project={id:'project-a',name:'原工程',target:'local',defaultMode:'local',plc:'A/project.json'};
   return {ok:true,json:async()=>({project,projects:[project],session:{id:null,active:false},runtimeOwner:null,capabilities:{},events:[]})};
  };
 });
 try{
  await until(()=>f.d.querySelector('[role="alert"]'));const find=label=>[...f.d.querySelectorAll('button')].find(b=>b.textContent===label);
  if(code==='root_mismatch'){assert.equal(find('连接工程服务'),undefined);assert.match(f.d.querySelector('[role="alert"]').textContent,/原始失败原因/);}
  else{assert.match(f.d.querySelector('[role="alert"]').textContent,/工程服务未连接/);assert.equal(requests.some(r=>r.method==='POST'),false);find('连接工程服务').click();await until(()=>!f.d.querySelector('.pc-backend-connection'));assert.equal(requests.filter(r=>r.method==='POST').length,1);}
  assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.project'),'project-a');assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.pending'),pending);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
