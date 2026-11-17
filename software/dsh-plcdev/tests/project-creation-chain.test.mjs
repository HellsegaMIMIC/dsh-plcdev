import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=fileURLToPath(new URL('../src/client/',import.meta.url)).replaceAll('\\','/');
const {JSDOM,VirtualConsole}=packages('jsdom');
const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {App} from '${dir}App.tsx';const root=createRoot(document.getElementById('root'));root.render(<App onCreateSession={window.createSession}/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await wait();assert.ok(predicate(),'expected creation state');}
test('empty catalog creates ST project then starts AI session for the new project only',async()=>{
 const requests=[],sessions=[],errors=[];let created=false;
 const id='user-'+'c'.repeat(32),revision='a'.repeat(64);
 const project={id,name:'测试新工程',kind:'user',defaultMode:'local',plc:'C:/Projects/New/plc/project.json',manifestPath:'C:/Projects/New/project.plcdev',projectRoot:'C:/Projects/New'};
 const catalog={canCreate:true,canOpen:true,defaultParent:'C:/Projects'};
 const empty={catalogOnly:true,project:{id:'catalog',kind:'catalog',name:'工程目录'},projects:[],session:{id:null,projectId:'catalog',active:false},projectCatalog:catalog,capabilities:{}};
 const vc=new VirtualConsole();vc.on('jsdomError',error=>{if(!error.message.includes('CSS'))errors.push(error.message);});
 const dom=new JSDOM('<div id="root"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.ResizeObserver=class{observe(){}disconnect(){}};w.createSession=async current=>{sessions.push(current);return {ok:true};};
  w.fetch=async(url,options)=>{
   const request={url,method:options.method,body:options.body?JSON.parse(options.body):null};requests.push(request);
   if(request.method==='POST'){
    assert.equal(url,'/api/plcdev/project-operations');assert.equal(request.body.projectId,'catalog');assert.equal(request.body.sessionId,null);assert.equal(request.body.language,'st');
    created=true;return {ok:true,json:async()=>({requestId:request.body.requestId,projectId:'catalog',action:'project-create',state:'confirmed',result:{ok:true,projectId:id,project}})};
   }
   if(url.includes('/tasks'))return {ok:true,json:async()=>({projectId:id,projectRevision:revision,tasks:[],capabilities:{}})};
   if(url.includes('/project-inspection'))return {ok:true,json:async()=>({ok:true,schemaVersion:1,projectId:id,projectRevision:revision,source:'saved-files-only',resources:[],signals:[],readback:{state:'untracked',observedRevision:revision,baselineRevision:null,capturedRevision:null,acknowledgedRevision:null,changes:[]},editorState:{state:'unknown'},capabilities:{canCapture:true,canAcknowledgeLayout:false}})};
   if(url.includes('/conversations'))return {ok:true,json:async()=>({projects:[],countsComplete:true})};
   return {ok:true,json:async()=>created?{project,projects:[project],session:{id:null,projectId:id,active:false},phase:'idle',projectCatalog:catalog,capabilities:{},events:[]}:empty};
  };
 }});
 const d=dom.window.document,button=label=>[...d.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
 try{
  await until(()=>button('创建工程')&&!button('创建工程').disabled);
  assert.ok(d.querySelector('.pd-catalog'));assert.equal(requests.some(row=>row.url.includes('tasks')||row.url.includes('project-inspection')),false);
  d.querySelector('summary').click();const field=d.querySelector('.pc-operations input');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(field,'测试新工程');field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();button('创建工程').click();
  try{await until(()=>button('描述需求，开始 AI 修改'));}catch(error){throw Error(JSON.stringify({requests,errors,ui:d.querySelector('#root').textContent.slice(-2500)}));}
  assert.equal(d.querySelector('.pd-catalog'),null);assert.match(d.querySelector('.pd-project-switch').textContent,/测试新工程/);assert.equal(dom.window.localStorage.getItem('plcdev.dsh.d1.project'),id);
  button('描述需求，开始 AI 修改').click();await until(()=>sessions.length===1);assert.deepEqual(sessions,[id]);assert.equal(requests.filter(row=>row.method==='POST').length,1);assert.deepEqual(errors,[]);
 }finally{dom.window.cleanup();dom.window.close();}
});
