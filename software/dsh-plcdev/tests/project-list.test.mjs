import test from 'node:test';
import assert from 'node:assert/strict';
import {filterProjects,projectLocation} from '../src/client/project-list.mjs';
import {packages,buildTools} from './dependencies.mjs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

test('same-name projects are searchable by their real paths; missing locations stay unknown',()=>{
  const projects=[{id:'a',name:'相同',manifestPath:'D:\\one\\project.plcdev'},{id:'b',name:'相同',manifestPath:'D:\\two\\project.plcdev'},{id:'c',name:'第三'}];
  assert.deepEqual(filterProjects(projects,'TWO').map(p=>p.id),['b']);
  assert.deepEqual(filterProjects(projects,'相同').map(p=>p.id),['a','b']);
  assert.equal(projectLocation(projects[0]),'D:\\one');assert.equal(projectLocation(projects[2]),'目录未提供');
});

test('project cards paginate, search by path and selection alone invokes the requested action',async()=>{
 const {build}=buildTools,{JSDOM}=packages('jsdom');const component=fileURLToPath(new URL('../src/client/ProjectList.tsx',import.meta.url)).replaceAll('\\','/');
 const {outputFiles}=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectList} from ${JSON.stringify(component)};const projects=Array.from({length:7},(_,i)=>({id:'p'+i,name:'同名',manifestPath:'D:/folder'+i+'/project.plcdev',toolchain:[{role:'PLC',name:'OpenPLC'}],runtimeStatus:'RUNNING'}));createRoot(document.getElementById('root')).render(<ProjectList projects={projects} currentId="p0" action="用于当前对话" onChoose={id=>window.selected=id}/>);`,loader:'tsx',resolveDir:dirname(fileURLToPath(import.meta.url))},bundle:true,write:false,platform:'browser',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')}});
 const dom=new JSDOM(`<div id="root"></div><script>${outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.fetch=async()=>({ok:true,json:async()=>({countsComplete:false})});}});
 const d=dom.window.document;const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok(predicate(),'project list did not reach expected visible state');};try{await wait(()=>d.querySelectorAll('article').length===5);assert.equal(d.querySelectorAll('article').length,5);assert.match(d.querySelector('article').textContent,/上次运行状态：运行中/);assert.equal(d.querySelector('[data-running=true]'),null);assert.equal(dom.window.selected,undefined);[...d.querySelectorAll('button')].find(b=>b.textContent==='下一页').click();await wait(()=>d.querySelectorAll('article').length===2);assert.equal(d.querySelectorAll('article').length,2);assert.equal(dom.window.selected,undefined);const input=d.querySelector('input');const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;setter.call(input,'folder6');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait(()=>d.querySelectorAll('article').length===1);assert.equal(d.querySelectorAll('article').length,1);assert.match(d.querySelector('article').textContent,/folder6/);assert.match(d.querySelector('article').textContent,/OpenPLC/);d.querySelector('article button').click();assert.equal(dom.window.selected,'p6');}finally{dom.window.close();}
});
