import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const component=fileURLToPath(new URL('../src/client/ProjectOperations.tsx',import.meta.url)).replaceAll('\\','/');
const nodePaths=[...new Set(['react','react-dom'].map(name=>dirname(dirname(packages.resolve(name+'/package.json')))))];
const wait=()=>new Promise(r=>setTimeout(r,100));
async function fixture(handler){
 const {outputFiles}=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectOperations} from '${component}';const root=createRoot(document.getElementById('root'));window.snapshot={project:{id:'user-aaaa',name:'A',defaultMode:'fuxa-oip',configuration:{revision:'1111111111111111'}},session:{id:null},projectCatalog:{canCreate:true,canOpen:true,defaultParent:'C:\\\\projects'},capabilities:{canConfigureProject:true}};window.render=(mode='catalog')=>root.render(<ProjectOperations mode={mode} snapshot={window.snapshot} connected={true} onChanged={v=>window.changed=v}/>);window.render();window.cleanup=()=>root.unmount();`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',nodePaths});
 const {JSDOM}=packages('jsdom');const requests=[];
 const dom=new JSDOM(`<div id="root"></div><script>${outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.fetch=async(url,options)=>{requests.push({url,options,body:options.body?JSON.parse(options.body):null});return handler(url,options,requests);};}});
 await wait();return {dom,d:dom.window.document,requests};
}
function input(dom,node,value){const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
function button(d,label){return [...d.querySelectorAll('button')].find(b=>b.textContent===label);}

test('create intent survives timeout and blocks repeat until original receipt is confirmed',async()=>{
 let receipt=false;
 const f=await fixture(async(url,options)=>options.method==='POST'?new Promise((_,reject)=>setTimeout(()=>reject(Error('lost')),10)):{ok:true,json:async()=>receipt?{ok:true,requestId:JSON.parse(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1')).requestId,projectId:'user-aaaa',action:'project-create',state:'confirmed',result:{ok:true,projectId:'user-bbbb',project:{id:'user-bbbb'}}}:{ok:true,requestId:'bad',state:'unknown'}});
 try{f.d.querySelector('summary').click();const fields=f.d.querySelectorAll('input');input(f.dom,fields[0],'测试工程');await wait();button(f.d,'创建工程').click();await wait();
 assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);assert.equal(f.requests.find(r=>r.options.method==='POST').body.language,'st');assert.equal(button(f.d,'创建工程').disabled,true);assert.match(f.d.body.textContent,/结果尚未确认/);const saved=JSON.parse(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));assert.equal(saved.projectId,'user-aaaa');assert.match(saved.target,/测试工程/);
 button(f.d,'创建工程').click();await wait();assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);
 f.dom.window.render('configuration');await wait();assert.match(f.d.body.textContent,/工程操作待核对/);assert.ok(f.d.querySelector('[data-tone=warning]'));receipt=true;button(f.d,'核对原请求').click();await wait();assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'),null);assert.equal(f.dom.window.changed.projectId,'user-bbbb');assert.match(f.d.querySelector('[data-tone=neutral]').textContent,/操作结果已确认/);assert.equal(f.d.querySelector('[role=alert]'),null);
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});

test('a failed recovery write prevents project dispatch',async()=>{
 const f=await fixture(async()=>({ok:true,json:async()=>({})}));
 try{f.d.querySelector('summary').click();input(f.dom,f.d.querySelector('input'),'测试工程');await wait();Object.defineProperty(f.dom.window.Storage.prototype,'setItem',{configurable:true,value:()=>{throw Error('blocked');}});button(f.d,'创建工程').click();await wait();assert.equal(f.requests.length,0);assert.match(f.d.body.textContent,/无法保存恢复记录/);}finally{f.dom.window.cleanup();f.dom.window.close();}
});

test('foreign project or action receipt never clears pending or changes view',async()=>{
 let phase='submit';const f=await fixture(async(url,options,requests)=>{
  const saved=options.method==='POST'?requests.at(-1).body:JSON.parse(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));
  const receipt={ok:true,requestId:saved.requestId,projectId:saved.projectId,action:saved.action,state:'confirmed',result:{ok:true,projectId:'user-bbbb',project:{id:'user-bbbb'}}};
  if(phase==='submit')receipt.projectId='user-foreign';else if(phase==='lookup')receipt.action='project-open';
  return {ok:true,json:async()=>receipt};
 });
 try{f.d.querySelector('summary').click();input(f.dom,f.d.querySelector('input'),'测试工程');await wait();button(f.d,'创建工程').click();await wait();assert.ok(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));assert.equal(f.dom.window.changed,undefined);
 phase='lookup';button(f.d,'核对原请求').click();await wait();assert.ok(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));assert.equal(f.dom.window.changed,undefined);
 phase='correct';button(f.d,'核对原请求').click();await wait();assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'),null);assert.equal(f.dom.window.changed.projectId,'user-bbbb');
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});

test('configuration receipt cannot claim a different resulting project',async()=>{
 const f=await fixture(async(url,options,requests)=>{const body=requests.at(-1).body;return {ok:true,json:async()=>({ok:true,requestId:body.requestId,projectId:body.projectId,action:body.action,state:'confirmed',result:{ok:true,projectId:'user-bbbb',project:{id:'user-bbbb'}}})};});
 try{f.dom.window.render('configuration');await wait();assert.equal(f.d.querySelector('details').open,true);const fields=f.d.querySelectorAll('input');input(f.dom,fields[2],'C:\\projects\\bindings.json');await wait();button(f.d,'保存画面、场景与绑定').click();await wait();assert.ok(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));assert.equal(f.dom.window.changed,undefined);assert.match(f.d.body.textContent,/结果尚未确认/);
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});


test('configuration version change blocks stale input and project switch clears source paths',async()=>{
 const f=await fixture(async()=>{throw Error('unexpected dispatch');});
 try{f.dom.window.render('configuration');await wait();assert.equal(f.d.querySelector('details').open,true);input(f.dom,f.d.querySelectorAll('input')[2],'C:\\old\\bindings.json');await wait();
 f.dom.window.snapshot={...f.dom.window.snapshot,project:{...f.dom.window.snapshot.project,configuration:{revision:'2222222222222222'}}};f.dom.window.render('configuration');await wait();
 assert.equal(button(f.d,'保存画面、场景与绑定').disabled,true);assert.match(f.d.body.textContent,/工程配置版本已变化/);assert.match(f.d.querySelectorAll('input')[2].value,/old/);
 button(f.d,'放弃旧输入并重新载入当前配置').click();await wait();assert.equal(f.d.querySelectorAll('input')[2].value,'');assert.equal(button(f.d,'保存画面、场景与绑定').disabled,false);assert.match(f.d.querySelector('[data-tone=neutral]').textContent,/已载入当前工程配置/);
 input(f.dom,f.d.querySelectorAll('input')[2],'C:\\old\\bindings.json');await wait();f.dom.window.snapshot={...f.dom.window.snapshot,project:{...f.dom.window.snapshot.project,id:'user-bbbb'}};f.dom.window.render('configuration');await wait();assert.equal(f.d.querySelectorAll('input')[2].value,'');assert.equal(f.requests.length,0);
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});

test('a rejected pre-dispatch request releases pending and presents the error',async()=>{
 const f=await fixture(async()=>({ok:false,status:400,json:async()=>({error:'工程名称无效'})}));
 try{f.d.querySelector('summary').click();input(f.dom,f.d.querySelector('input'),'测试工程');await wait();button(f.d,'创建工程').click();await wait();assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'),null);assert.match(f.d.body.textContent,/工程名称无效/);assert.equal(button(f.d,'创建工程').disabled,false);}
 finally{f.dom.window.cleanup();f.dom.window.close();}
});

test('catalog-disabled reasons do not borrow unrelated configuration restrictions',async()=>{
 const f=await fixture(async()=>{throw Error('unexpected dispatch');});
 try{
  f.dom.window.snapshot={...f.dom.window.snapshot,projectCatalog:{canCreate:false,canOpen:false},capabilities:{reasons:{canConfigureInterface:'本工程工具或运行会话已打开'}}};
  f.dom.window.render();await wait();f.d.querySelector('summary').click();
  assert.equal(button(f.d,'创建工程').disabled,true);assert.match(f.d.body.textContent,/后台未确认支持创建工程/);assert.doesNotMatch(f.d.body.textContent,/本工程工具或运行会话已打开/);
  const select=f.d.querySelector('select');select.value='project-open';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await wait();
  assert.equal(button(f.d,'登记并打开工程').disabled,true);assert.match(f.d.body.textContent,/后台未确认支持登记并打开工程/);assert.equal(f.requests.length,0);
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});
test('ordinary project settings associate an OIP scene with a scoped recoverable operation',async()=>{
 const f=await fixture(async(url,options,requests)=>{const body=requests.at(-1).body;return {ok:true,json:async()=>({requestId:body.requestId,projectId:body.projectId,action:body.action,state:'confirmed',result:{ok:true,projectId:body.projectId,project:{id:body.projectId}}})};});
 try{
  f.dom.window.snapshot={...f.dom.window.snapshot,project:{...f.dom.window.snapshot.project,schemaVersion:3,defaultMode:'fuxa-local'},capabilities:{canConfigureInterface:true,canConfigureOip:true}};
  f.dom.window.render('configuration');await wait();button(f.d,'关联 OIP 场景').click();await wait();
  assert.equal(f.d.querySelectorAll('input').length,1);assert.equal(f.d.querySelector('textarea'),null);
  input(f.dom,f.d.querySelector('input'),'F:\\工厂\\project.json');await wait();button(f.d,'保存场景关联').click();await wait();
  assert.equal(f.requests.length,1);const body=f.requests[0].body;assert.equal(body.action,'project-oip-configure');assert.equal(body.source,'F:\\工厂\\project.json');assert.equal(body.configurationRevision,'1111111111111111');assert.equal(body.projectId,'user-aaaa');assert.equal(body.sessionId,null);assert.equal(f.dom.window.changed.projectId,'user-aaaa');assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'),null);
 }finally{f.dom.window.cleanup();f.dom.window.close();}
});
