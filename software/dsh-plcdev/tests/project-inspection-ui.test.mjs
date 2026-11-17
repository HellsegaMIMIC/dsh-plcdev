import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProjectInspection,inspectionRequest,signalReference,readonlyValueTargets} from '../src/client/project-inspection.mjs';

const revision='a'.repeat(64),nextRevision='b'.repeat(64);
const sample=(id='project-a',extra={})=>({ok:true,schemaVersion:1,projectId:id,projectRevision:revision,source:'saved-files-only',editorState:{state:'unknown',message:'未保存内容无法确认'},resources:[{id:'plc/main.st',kind:'plc',path:'plc/main.st',sha256:revision}],signals:[{id:'count',label:'累计数量',path:'MAIN.Count',type:'INT',access:'read',source:{kind:'plc',path:'plc/project.json'},hmi:[{viewId:'overview',viewName:'总览',elementId:'count-label',label:'数量',tagId:'plcdev_count'}],scene:[]}],readback:{state:'untracked',baselineRevision:null,observedRevision:revision,capturedRevision:null,acknowledgedRevision:null,changes:[],layoutOnly:false,lastReview:null},capabilities:{canCapture:true,canAcknowledgeLayout:false},...extra});

test('inspection identity and nested display fields are validated before producing a reference',()=>{
  const value=sample();assert.equal(validateProjectInspection(value,'project-a'),value);assert.deepEqual(signalReference(value,'count'),{projectId:'project-a',signalKey:'count',savedRevision:revision});assert.equal(signalReference(value,'missing'),null);
  for(const change of [{projectId:'project-b'},{projectRevision:'bad'},{source:'unsaved-editor'},{signals:[{...value.signals[0],hmi:[{...value.signals[0].hmi[0],label:{bad:true}}]}]},{signals:[{...value.signals[0],source:{kind:'plc',path:{bad:true}}}]}])assert.throws(()=>validateProjectInspection({...value,...change},'project-a'));
  assert.deepEqual(inspectionRequest(value,'capture'),{projectId:'project-a',action:'capture',expectedRevision:revision,expectedBaseline:null});assert.equal(inspectionRequest(value,'acknowledge'),null);assert.equal(inspectionRequest(value,'run'),null);
});

test('readonly display targets require the exact project revision and a declared path/type match',()=>{
  const value=sample(),target={viewId:'overview',viewName:'总览',signalId:'alias-count',path:'MAIN.Count',type:'INT'};
  const listing={projectId:'project-a',projectRevision:revision,capabilities:{hmiReadonlyValueCandidate:true},hmiValueTargets:[target,{...target,signalId:'other',path:'MAIN.Other'},target]};
  assert.deepEqual(readonlyValueTargets(value,'count',listing),[target]);assert.deepEqual(readonlyValueTargets(value,'count',{...listing,projectRevision:nextRevision}),[]);assert.deepEqual(readonlyValueTargets(value,'count',{...listing,capabilities:{}}),[]);assert.deepEqual(readonlyValueTargets(value,'missing',listing),[]);
});

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),dir=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const {JSDOM,VirtualConsole}=packages('jsdom');
const built=await buildTools.build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useProjectInspection,ProjectSignalList,ProjectSignalDetail,ProjectReadback} from '${dir}/ProjectSignals.tsx';function Harness(){const [id,setId]=useState('project-a'),[selected,setSelected]=useState('signal:count');window.selectProject=setId;const inspection=useProjectInspection(id,true);return <div><ProjectSignalList inspection={inspection} selected={selected} onSelect={setSelected}/><ProjectReadback inspection={inspection}/><ProjectSignalDetail inspection={inspection} signalId={selected.slice(7)} onClose={()=>setSelected('')} onCarryReference={window.carry}/></div>;}const root=createRoot(document.getElementById('test'));root.render(<Harness/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const pause=()=>new Promise(r=>setTimeout(r,35));async function until(predicate){for(let i=0;i<60&&!predicate();i++)await pause();assert.ok(predicate(),'expected inspection state');}
function fixture(handler){const requests=[],carried=[],errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});const dom=new JSDOM('<div id="test"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.carry=async(...args)=>{carried.push(JSON.parse(JSON.stringify(args)));return {ok:true};};w.fetch=async(url,options)=>{const request={url,method:options.method,body:options.body&&JSON.parse(options.body)};requests.push(request);const u=new URL(url,'http://127.0.0.1:55110'),id=u.searchParams.get('project')||'project-a';const out=await handler(request,id,u);return out?.json?out:{ok:true,json:async()=>out};};}});const d=dom.window.document,button=label=>[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===label);return {dom,d,button,requests,carried,errors,close:()=>{dom.window.cleanup();dom.window.close();}};}

test('signal detail carries only verified references and waits for a target choice when multiple views exist',async()=>{
  const targets=['view-a','view-b'].map(viewId=>({viewId,viewName:viewId,signalId:'alias-count',path:'MAIN.Count',type:'INT'}));
  const f=fixture((_request,id,u)=>u.pathname.endsWith('/tasks')?{projectId:id,projectRevision:revision,capabilities:{hmiReadonlyValueCandidate:true},hmiValueTargets:targets}:sample(id));
  try{await until(()=>f.button('添加只读数值显示'));assert.equal(f.button('添加只读数值显示').disabled,true);assert.match(f.d.body.textContent,/PLC 来源/);assert.match(f.d.body.textContent,/总览 \/ 数量/);f.button('带入新工程会话').click();await pause();assert.deepEqual(f.carried[0],['project-a',{projectId:'project-a',signalKey:'count',savedRevision:revision}]);const select=f.d.querySelector('select');select.value='1';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await pause();f.button('添加只读数值显示').click();await pause();assert.deepEqual(f.carried[1],['project-a',{projectId:'project-a',signalKey:'count',savedRevision:revision,intent:'readonly-value',viewId:'view-b',signalId:'alias-count'}]);assert.ok(f.requests.every(request=>request.method==='GET'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('a capture reply for the previous project cannot replace the new project or announce success there',async()=>{
  let release;const f=fixture((request,id,u)=>request.method==='POST'?new Promise(resolve=>release=resolve):u.pathname.endsWith('/tasks')?{}:sample(id));
  try{await until(()=>f.button('记录当前保存版本'));f.button('记录当前保存版本').click();f.button('记录当前保存版本').click();await until(()=>release);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);f.dom.window.selectProject('project-b');await until(()=>f.d.body.textContent.includes('project-b'));release(sample('project-a',{readback:{...sample().readback,state:'current',baselineRevision:revision,capturedRevision:revision}}));await pause();assert.match(f.d.body.textContent,/project-b/);assert.doesNotMatch(f.d.body.textContent,/已读取并记录当前保存版本/);assert.ok(f.button('记录当前保存版本'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('an unknown capture result stays visible and does not automatically resend the operation',async()=>{
  const f=fixture((request,id,u)=>request.method==='POST'?{ok:false,status:504,json:async()=>({error:'timeout'})}:u.pathname.endsWith('/tasks')?{}:sample(id));
  try{await until(()=>f.button('记录当前保存版本'));f.button('记录当前保存版本').click();await until(()=>f.d.body.textContent.includes('不会自动重发'));assert.equal(f.button('记录当前保存版本'),undefined);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.deepEqual(f.errors,[]);}finally{f.close();}
});

