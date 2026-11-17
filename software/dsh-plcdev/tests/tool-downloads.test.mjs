import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateToolEnvironment} from '../src/client/tool-distributions.mjs';
import {buildToolInstallPrompt} from '../src/client/tool-install-prompt.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const {JSDOM,VirtualConsole}=packages('jsdom');
const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ToolDownloads} from '${dir}/ToolDownloads.tsx';const root=createRoot(document.getElementById('test'));root.render(<ToolDownloads embedded={window.embedded} onClose={()=>window.closedCount++} onChecked={()=>window.checkedCount++}/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const data=(states=['missing','missing','missing'])=>({ok:true,schemaVersion:1,checkedAt:new Date().toISOString(),configPath:'F:/PLCdev/outputs/local/environment.json',tools:[['openplc','editor'],['fuxa','fuxaPackage'],['oip','oipExecutable']].map(([id,key],i)=>({id,key,state:states[i],path:'F:/tools/'+id}))});
const wait=()=>new Promise(r=>setTimeout(r,30));
async function until(fn){for(let i=0;i<50&&!fn();i++)await wait();assert.ok(fn());}
async function reread(f){const button=()=>[...f.d.querySelectorAll('button')].find(b=>b.textContent==='重新检测'&&!b.disabled);await until(button);button().click();}
function fixture({embedded=false,clipboard}={}){let value=data(),respond;const requests=[],errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});
 const dom=new JSDOM('<button id="opener">open</button><div id="test"></div><script>document.getElementById("opener").focus();'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.embedded=embedded;if(clipboard)Object.defineProperty(w.navigator,'clipboard',{value:clipboard});w.checkedCount=0;w.closedCount=0;w.fetch=async(url,options)=>{requests.push({url,method:options.method});if(respond)return respond();return {ok:true,json:async()=>value};};}});
 return {dom,d:dom.window.document,requests,errors,setValue:v=>value=v,setRespond:fn=>respond=fn,close:()=>{dom.window.cleanup();dom.window.close();}};
}
test('tool downloads detect independently with GET only and preserve truthful package labels',async()=>{
 const f=fixture();try{await until(()=>f.dom.window.checkedCount===1);assert.deepEqual(f.requests,[{url:'/api/plcdev/tool-environment',method:'GET'}]);assert.equal(f.d.querySelectorAll('[data-state=missing]').length,3);assert.equal(f.d.querySelectorAll('[data-state=unchecked]').length,2);for(const label of ['编辑预览包','联网安装包','汉化补丁','Runtime 与编译依赖','编译依赖：未检测','官方下载','先正常结束运行会话及已打开的工程工具'])assert.ok(f.d.body.textContent.includes(label));assert.ok(!f.d.body.textContent.includes('一键安装'));
 for(const [name,note] of [['OpenPLC','不含完整编译工具链'],['Open Industry Project','需匹配原版']]){f.d.querySelector(`button[aria-label="${name} 详情"]`).click();await until(()=>f.d.querySelector('.pd-tools-detail').textContent.includes(note));}
 for(const a of f.d.querySelectorAll('a')){assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');assert.ok(['github.com','www.openindustryproject.org','autonomylogic.com'].includes(new URL(a.href).hostname));}assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('reread updates real states; failed or malformed read clears former found states',async()=>{
 const f=fixture();try{await until(()=>f.dom.window.checkedCount===1);f.setValue(data(['found','missing','unchecked']));await reread(f);await until(()=>f.dom.window.checkedCount===2);assert.equal(f.d.querySelectorAll('[data-state=found]').length,1);assert.equal(f.d.querySelectorAll('[data-state=unchecked]').length,3);f.setValue({ok:true,tools:[]});await reread(f);await until(()=>f.d.querySelector('[role=alert]'));assert.equal(f.d.querySelectorAll('[data-state=found]').length,0);assert.equal(f.d.querySelectorAll('[data-state=unchecked]').length,5);assert.ok(f.requests.every(r=>r.method==='GET'));}finally{f.close();}
});

test('legacy host normalizes runtime dependencies as unknown, full response validates each identity',()=>{
 const old=data(),normalized=validateToolEnvironment(old);assert.equal(old.tools.length,3);assert.equal(normalized.tools.length,5);assert.ok(normalized.tools.slice(3).every(x=>x.state==='unchecked'));
 const full={...old,tools:[...old.tools,{id:'runtime',key:'runtime',state:'found',version:'v4.3.0',checks:[{entry:'VERSION',state:'found'}]},{id:'msys',key:'msys',state:'missing',checks:[{entry:'usr/bin/g++.exe',state:'missing'}]}]};
 assert.equal(validateToolEnvironment(full).tools[3].version,'v4.3.0');
 for(const bad of [{...full,tools:[...old.tools,full.tools[3],full.tools[3]]},{...full,tools:[...old.tools,{...full.tools[3],key:'other'}]},{...full,tools:[...old.tools,{...full.tools[3],checks:[{entry:'VERSION',state:'ready'}]}]}])assert.throws(()=>validateToolEnvironment(bad));
});
test('runtime missing dependency details and detected version are rendered without claiming runtime readiness',async()=>{
 const f=fixture();try{await until(()=>f.dom.window.checkedCount===1);f.setValue({...data(),tools:[...data().tools,{id:'runtime',key:'runtime',state:'found',path:'F:/Runtime/openplc-runtime',version:'v4.3.0'},{id:'msys',key:'msys',state:'missing',path:'F:/Runtime/msys64',checks:[{entry:'usr/bin/g++.exe',state:'missing'}]}]});await reread(f);await until(()=>f.dom.window.checkedCount===2);const runtime=f.d.querySelector('.pd-tools-group');assert.equal(runtime.querySelector('[data-tool=runtime]').textContent,'Runtime：已找到');assert.equal(runtime.querySelector('[data-tool=msys]').textContent,'编译依赖：待补齐');f.d.querySelector('button[aria-label="Runtime 与编译依赖 详情"]').click();await until(()=>f.d.body.textContent.includes('v4.3.0'));assert.ok(f.d.body.textContent.includes('待补齐或核对：usr/bin/g++.exe'));assert.ok(f.d.body.textContent.includes('tools.runtime'));assert.ok(f.d.body.textContent.includes('tools.msys'));assert.ok(f.d.body.textContent.includes('已找到仅表示安装入口存在'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('compact tiles share one detail pane, preserve selection during detection and return focus on collapse',async()=>{
 const f=fixture({embedded:true});try{
  await until(()=>f.dom.window.checkedCount===1);const panel=f.d.querySelector('.pd-tools-detail'),open=f.d.querySelector('button[aria-label="OpenPLC 详情"]'),fuxa=f.d.querySelector('button[aria-label="FUXA 详情"]');
  assert.equal(panel.hidden,true);assert.equal(f.d.querySelectorAll('.pd-tools-row').length,4);
  open.click();await until(()=>!panel.hidden);assert.equal(open.getAttribute('aria-controls'),panel.id);assert.ok(panel.textContent.includes('F:/tools/openplc'));
  fuxa.click();await until(()=>fuxa.getAttribute('aria-expanded')==='true');assert.equal(open.getAttribute('aria-expanded'),'false');assert.ok(panel.textContent.includes('F:/tools/fuxa'));assert.equal(f.requests.length,1);
  f.setValue(data(['found','found','missing']));await reread(f);await until(()=>f.dom.window.checkedCount===2);assert.equal(fuxa.getAttribute('aria-expanded'),'true');assert.equal(fuxa.closest('.pd-tools-row').querySelector('[data-state]').getAttribute('data-state'),'found');
  panel.querySelector('button').click();await until(()=>panel.hidden);assert.equal(f.d.activeElement,fuxa);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('closing during detection ignores late responses and Escape requests close',async()=>{
 const f=fixture();try{await until(()=>f.dom.window.checkedCount===1&&[...f.d.querySelectorAll('button')].some(b=>b.textContent==='重新检测'));let finish;f.setRespond(()=>new Promise(r=>finish=r));await reread(f);await until(()=>finish);f.d.querySelector('[role=dialog]').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.dom.window.closedCount,1);f.dom.window.cleanup();finish({ok:true,json:async()=>data(['found','found','found'])});await wait();assert.equal(f.dom.window.checkedCount,1);}finally{f.dom.window.close();}
});

test('modal portal escapes the page container and retains dismissal and focus return',async()=>{
 const f=fixture();try{
  await until(()=>f.dom.window.checkedCount===1);const backdrop=f.d.querySelector('.pd-tools-backdrop'),dialog=f.d.querySelector('[role=dialog]');
  assert.equal(backdrop.parentElement,f.d.body);assert.equal(f.d.querySelector('#test').contains(dialog),false);assert.equal(f.d.activeElement.getAttribute('aria-label'),'关闭工具下载');
  dialog.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{bubbles:true}));assert.equal(f.dom.window.closedCount,0);
  backdrop.dispatchEvent(new f.dom.window.MouseEvent('mousedown',{bubbles:true}));assert.equal(f.dom.window.closedCount,1);
  f.dom.window.cleanup();assert.equal(f.d.querySelector('.pd-tools-backdrop'),null);assert.equal(f.d.activeElement.id,'opener');assert.deepEqual(f.errors,[]);
 }finally{f.dom.window.close();}
});

test('embedded tool setup copies the selected instructions without starting installation',async()=>{
 const copied=[],f=fixture({embedded:true,clipboard:{writeText:async text=>copied.push(text)}});
 try{
  await until(()=>f.dom.window.checkedCount===1);assert.equal(f.d.querySelector('[role=dialog]'),null);assert.equal(f.d.querySelector('.pd-tools-backdrop'),null);assert.equal(f.d.querySelector('.pd-tools-prompt').open,false);
  const copy=()=>[...f.d.querySelectorAll('button')].find(b=>b.textContent==='复制安装提示词');
  copy().click();await until(()=>f.d.querySelector('[role=status]')?.textContent.includes('已复制'));assert.deepEqual(copied,[buildToolInstallPrompt('all')]);
  const select=f.d.querySelector('select');select.value='runtime';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await wait();assert.equal(f.d.querySelector('[role=status]'),null);
  assert.equal(select.querySelector('option[value=msys]'),null);assert.equal(select.selectedOptions[0].textContent,'Runtime 与编译依赖');
  copy().click();await until(()=>copied.length===2);assert.equal(copied[1],buildToolInstallPrompt('runtime'));assert.ok(f.requests.every(r=>r.method==='GET'));assert.equal(f.requests.length,1);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('clipboard denial reveals selectable instructions and does not claim success',async()=>{
 const f=fixture({clipboard:{writeText:async()=>{throw Error('permission denied');}}});
 try{
  await until(()=>f.dom.window.checkedCount===1);[...f.d.querySelectorAll('button')].find(b=>b.textContent==='复制安装提示词').click();
  await until(()=>f.d.querySelector('[role=status]')?.textContent.includes('无法自动复制'));
  assert.equal(f.d.querySelector('.pd-tools-prompt').open,true);const field=f.d.querySelector('textarea');assert.equal(field.readOnly,true);assert.equal(field.value,buildToolInstallPrompt('all'));assert.equal(f.d.activeElement,field);assert.equal(field.selectionEnd,field.value.length);assert.equal(f.requests.length,1);
 }finally{f.close();}
});
