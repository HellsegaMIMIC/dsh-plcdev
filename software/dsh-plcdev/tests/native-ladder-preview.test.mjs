import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
import {parseLadderSource,graphicalPreview,previewFiles} from '../src/client/ladder-preview.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const before=readFileSync(resolve(here,'fixtures/native-ladder.ld'),'utf8'),original=parseLadderSource(before);
const afterGraph=structuredClone(original);
afterGraph.rungs[0].nodes.find(n=>n.data?.variable?.name==='Ready').data.variant='negated';afterGraph.rungs.pop();
const header=before.slice(0,before.indexOf('{')),after=header+JSON.stringify(afterGraph)+'\nEND_PROGRAM\n';
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64);
const task={projectId,taskId,status:'awaiting_review',workflow:'project-edit-v1',candidate:{candidateDigest:digest}};
const file={path:'plc/pous/programs/main.ld',kind:'ld',beforeText:before,afterText:after,beforeSha256:'d'.repeat(64),afterSha256:'e'.repeat(64)};
test('bound native inputs reject unavailable baselines, malformed bodies, path tricks and dangling edges',()=>{
 assert.equal(original.rungs.length,3);assert.equal(graphicalPreview(file).after,after);
 for(const change of [{truncated:true},{beforeUnavailable:true},{beforeText:'PROGRAM main'},{path:'../private.ld'},{path:'/private.ld'},{afterText:'x'.repeat(524289)}])assert.ok(graphicalPreview({...file,...change}).error);
 const broken=structuredClone(afterGraph);broken.rungs[0].edges[0].target='missing';assert.equal(parseLadderSource(header+JSON.stringify(broken)+'\nEND_PROGRAM'),null);
 assert.equal(graphicalPreview({...file,beforeText:'',beforeSha256:null}).error,undefined);
 assert.equal(graphicalPreview({...file,afterText:'',afterSha256:null}).error,undefined);
 const all={files:[file,{path:'hmi/views.json',kind:'metadata'},{path:'oip/scene.json',kind:'metadata'},{path:'devices/private.json',kind:'metadata'}]};
 assert.deepEqual(previewFiles(all,'openplc'),[file]);assert.equal(previewFiles(all,'fuxa').length,1);assert.equal(previewFiles(all,'oip').length,1);
});
const tick=()=>new Promise(r=>setTimeout(r,90));
test('saved-version prefixed files use the same tool groups in cards and preview bubbles',()=>{
 const prefix='.plcdev/versions/v000002-123456abcdef/content/';
 const plc={path:prefix+'plc/project.json',kind:'metadata'},hmi={path:prefix+'hmi/main.fuxap',kind:'metadata'},oip={path:prefix+'oip/Main.tscn',kind:'metadata'};
 const all={files:[plc,hmi,oip,{path:prefix+'interface.json',kind:'metadata'}]};
 assert.deepEqual(previewFiles(all,'openplc'),[plc]);
 assert.deepEqual(previewFiles(all,'fuxa'),[hmi]);
 assert.deepEqual(previewFiles(all,'oip'),[oip]);
 assert.deepEqual(previewFiles({files:[{...hmi,path:hmi.path.replaceAll('/','\\')}]},'fuxa').length,1);
});
const component=resolve(root,'software/dsh-plcdev/src/client/ResultPreviewPopover.tsx').replaceAll('\\','/');
const native=resolve(root,'software/dsh-plcdev/src/client/native-ladder/generated.cjs').replaceAll('\\','/');
const contents="import React from 'react';import {createRoot} from 'react-dom/client';import {ResultPreviewButton} from "+JSON.stringify(component)+";import {computeGraphicalDiff} from "+JSON.stringify(native)+";window.computeDiff=computeGraphicalDiff;const root=createRoot(document.getElementById('root'));window.render=task=>root.render(<ResultPreviewButton conversationId='chat-a' task={task} tool='openplc'/>);window.render(window.task);window.stop=()=>root.unmount();";
const script=(await buildTools.build({stdin:{contents,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
async function environment(preview){
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],calls=[],vc=new VirtualConsole();
 vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',(...v)=>errors.push(v.join(' ')));
 const dom=new JSDOM('<div id="root"></div>',{url:'https://plcdev.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window;w.task=task;
 w.ResizeObserver=class{constructor(cb){this.cb=cb;this.targets=new Set()}observe(target){this.targets.add(target);setTimeout(()=>{if(this.targets.has(target))this.cb([{target,contentRect:target.getBoundingClientRect(),borderBoxSize:[{inlineSize:560,blockSize:300}]}])},0)}unobserve(t){this.targets.delete(t)}disconnect(){this.targets.clear()}};
 w.DOMMatrixReadOnly=class{constructor(){this.m22=1;this.m11=1}};
 Object.defineProperty(w.HTMLElement.prototype,'offsetWidth',{get(){return parseFloat(this.style.width)||560}});
 Object.defineProperty(w.HTMLElement.prototype,'offsetHeight',{get(){return parseFloat(this.style.height)||300}});
 Object.defineProperty(w.HTMLElement.prototype,'clientWidth',{get(){return this.classList.contains('pc-graph')?Math.min(566,w.innerWidth-50):this.offsetWidth}});
 Object.defineProperty(w.HTMLElement.prototype,'clientHeight',{get(){return this.offsetHeight}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){const left=parseFloat(this.style.left)||20,top=parseFloat(this.style.top)||30,width=this.offsetWidth,height=this.offsetHeight;return {left,top,width,height,x:left,y:top,right:left+width,bottom:top+height,toJSON(){return this}}};
 w.fetch=async(url,options={})=>{const u=new URL(url,'https://plcdev.test/');assert.ok(u.pathname.endsWith('/conversations/preview'));assert.equal(options.method,'GET');calls.push(u);return {ok:true,status:200,json:async()=>({...task,candidateDigest:digest,files:[preview],truncated:false})};};
 w.eval(script);await tick();
 const q=s=>{const e=w.document.querySelector(s);assert.ok(e,'Missing '+s);return e;};
 const click=async s=>{const e=q(s);e.focus();e.click();await tick();await tick();};
 return {w,dom,errors,calls,q,click,close(){w.stop();w.close();}};
}
test('real saved native content produces contact-type and network-removal changes in the original semantic diff',async()=>{
 const env=await environment(file);
 try{const diff=env.w.computeDiff(before,after,file.path);assert.deepEqual([...diff.changedIndexes],[0,2]);assert.equal(diff.flows[2].current,null);assert.equal(diff.nodeDiffMaps.current.get(afterGraph.rungs[0].nodes.find(n=>n.data?.variable?.name==='Ready').id),'modified');assert.deepEqual(env.errors,[]);}
 finally{env.close();}
});
test('header opens native nonmodal graph with one scroll owner, network paging and explicit enlargement',async()=>{
 const env=await environment(file),{w,q,click,calls,errors}=env;
 try{
  assert.equal(calls.length,0);await click('.pc-preview-launch');assert.equal(calls.length,1);assert.equal(calls[0].searchParams.get('candidateDigest'),digest);
  assert.equal(q('.pc-result-popover').getAttribute('aria-modal'),'false');q('[data-source="OpenPLC GraphicalDiffViewer"] .react-flow__node-contact');assert.match(q('.pc-result-popover').textContent,/Ready/);
  const body=w.getComputedStyle(q('.pc-result-popover-body'));assert.equal(body.overflowX,'hidden');assert.equal(body.overflowY,'auto');
  for(const el of w.document.querySelectorAll('.pc-native-ladder .overflow-x-auto,.pc-native-ladder .overflow-y-auto')){const s=w.getComputedStyle(el);assert.equal(s.overflowX||s.overflow,'visible');assert.equal(s.overflowY||s.overflow,'visible');}
  await click('[aria-label="下一个改动网络"]');assert.match(q('.pc-result-popover').textContent,/此网络已移除/);await click('[aria-label="上一个改动网络"]');
  Object.defineProperty(w,'innerWidth',{value:390,configurable:true});w.dispatchEvent(new w.Event('resize'));await tick();assert.ok(Number(q('.pc-native-ladder').style.getPropertyValue('--pc-graph-scale'))<.72);
  q('.pc-result-popover-foot button').click();await tick();q('.pc-result-overlay');assert.equal(q('.pc-result-popover').getAttribute('aria-modal'),'true');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();assert.equal(w.document.querySelector('.pc-result-popover'),null);assert.equal(w.document.activeElement,q('.pc-preview-launch'));assert.deepEqual(errors,[]);
 }finally{env.close();}
});
test('outside actions survive first click, status changes close old previews and malformed files show honest fallback',async()=>{
 const env=await environment({...file,afterText:'invalid'}),{w,q,click,errors}=env;
 try{
  await click('.pc-preview-launch');assert.match(q('.pc-result-popover').textContent,/无法解析/);assert.equal(w.document.querySelector('.react-flow'),null);
  const outside=w.document.createElement('button');let clicked=0;outside.onclick=()=>clicked++;w.document.body.appendChild(outside);outside.click();await tick();assert.equal(clicked,1);assert.equal(w.document.querySelector('.pc-result-popover'),null);
  await click('.pc-preview-launch');w.render({...task,status:'kept'});await tick();assert.equal(w.document.querySelector('.pc-result-popover'),null);assert.deepEqual(errors,[]);
 }finally{env.close();}
});
test('generated native adapter records source provenance and excludes demo config or editor stores',()=>{
 const evidence=JSON.parse(readFileSync(resolve(here,'../src/client/native-ladder/provenance.json'),'utf8'));
 assert.equal(evidence.sourceUnmodified,true);assert.equal(evidence.readOnly,true);assert.ok(evidence.sources.some(s=>s.path.endsWith('graphical-diff-viewer.tsx')));
 assert.ok(!readFileSync(resolve(here,'../src/client/native-ladder/generated.cjs'),'utf8').includes('PLCdevNativeLadderFiles'));
 assert.equal(evidence.sources.some(s=>/editor.store|ipc|runtime-service/.test(s.path)),false);
});

