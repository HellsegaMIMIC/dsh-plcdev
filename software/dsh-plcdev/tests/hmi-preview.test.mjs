import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
import {validateResultPreview} from '../src/client/result-flow.mjs';
import {validHmiSnapshot,hmiViewPairs,svgImageUrl} from '../src/client/hmi-preview.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64);
const task={projectId,taskId,status:'awaiting_review',workflow:'project-edit-v1',candidate:{candidateDigest:digest}};
const svg=text=>`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#eef3fa"/><text x="24" y="48" font-size="24">${text}</text><rect x="24" y="100" width="120" height="42" fill="#356ae6"/><text x="84" y="127" text-anchor="middle" fill="#fff">启动</text></svg>`;
const view=(id,text,extra={})=>({id,name:text,width:800,height:500,background:'#eef3fa',svg:svg(text),partial:false,...extra});
const snapshot=(...views)=>({views,partial:false});
const file={path:'integration/b077e731cf0b46ba/hmi/main.fuxap',kind:'hmi',beforeText:null,afterText:null,beforeSha256:'d'.repeat(64),afterSha256:'e'.repeat(64),beforeHmi:snapshot(view('main','原计数画面')),afterHmi:snapshot(view('main','输送计数画面'))};
const response=preview=>({projectId,taskId,candidateDigest:digest,files:[preview],truncated:false});

test('preview DTO accepts bounded static views and rejects raw projects, bad dimensions and unbounded inputs',()=>{
  assert.equal(validateResultPreview(response(file),task).files[0],file);
  assert.equal(validHmiSnapshot(null),true);
  for(const extra of [{width:Infinity},{width:0},{height:16385},{id:''},{id:'x'.repeat(257)},{name:'x'.repeat(257)},{svg:'x'.repeat(262145)},{svg:'<!DOCTYPE svg><svg/>'},{background:'url(https://outside.test)'},{partial:'yes'},{devices:{}}])
    assert.equal(validHmiSnapshot(snapshot(view('main','Title',extra))),false,JSON.stringify(extra).slice(0,90));
  assert.equal(validHmiSnapshot(snapshot(view('same','A'),view('same','B'))),false);
  assert.equal(validHmiSnapshot(snapshot(...Array.from({length:17},(_,i)=>view(String(i),'A')))),false);
  assert.equal(validHmiSnapshot({views:[],devices:{secret:'not drawing data'}}),false);
  assert.throws(()=>validateResultPreview(response({...file,beforeHmi:undefined}),task),/HMI/);
  assert.throws(()=>validateResultPreview(response({...file,afterText:'raw project'}),task),/HMI/);
  assert.equal(svgImageUrl('\ud800'),'');
});

test('native IDs pair reordered views and prefer changed pages without inventing semantic summaries',()=>{
  const a=view('a','A'),b=view('b','B'),c=view('c','C');
  const pairs=hmiViewPairs({...file,beforeHmi:snapshot(a,b,c),afterHmi:snapshot(b,{...a,svg:svg('A changed')},view('new','New'))});
  assert.deepEqual(pairs.map(p=>p.id),['a','new','c','b']);
  assert.equal(pairs[0].before.id,pairs[0].after.id);
  assert.equal(pairs[1].before,null);assert.equal(pairs[2].after,null);assert.equal(pairs[3].changed,false);
});

const popover=resolve(root,'software/dsh-plcdev/src/client/ResultPreviewPopover.tsx').replaceAll('\\','/');
const preview=resolve(root,'software/dsh-plcdev/src/client/ResultPreview.tsx').replaceAll('\\','/');
const contents=`import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {ResultPreviewButton} from ${JSON.stringify(popover)};import {ResultPreview} from ${JSON.stringify(preview)};const root=createRoot(document.getElementById('root'));function View({task,mode}){useEffect(()=>{window.mounted=true},[]);return mode==='popover'?<ResultPreviewButton conversationId='chat-a' task={task} tool='fuxa'/>:<ResultPreview conversationId='chat-a' task={task} compact={mode==='compact'}/>;}window.render=(task,mode='popover')=>root.render(<View task={task} mode={mode}/>);window.render(window.task,window.mode);window.stop=()=>root.unmount();`;
const script=(await buildTools.build({stdin:{contents,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const tick=()=>new Promise(resolve=>setTimeout(resolve,65));
async function until(check,message){const deadline=Date.now()+4000;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(check(),message);}
async function environment(preview,{mode='popover',currentTask=task,earlyImageError=false}={}){
  const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],requests=[],vc=new VirtualConsole();
  vc.on('jsdomError',error=>errors.push(error.message));vc.on('error',(...args)=>errors.push(args.join(' ')));
  const dom=new JSDOM('<div id="root"></div>',{url:'https://plcdev.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window;
  w.task=currentTask;w.mode=mode;
  w.ResizeObserver=class{observe(){}disconnect(){}};
  w.HTMLElement.prototype.getBoundingClientRect=function(){return {left:20,top:30,right:580,bottom:65,width:560,height:35,toJSON(){return this;}}};
  w.fetch=async(url,options={})=>{
    assert.ok(new URL(url,'https://plcdev.test').pathname.endsWith('/conversations/preview'));assert.equal(options.method,'GET');requests.push(url);
    return {ok:true,status:200,json:async()=>response(preview)};
  };
  let earlyObserver;
  if(earlyImageError){earlyObserver=new w.MutationObserver(()=>{const img=w.document.querySelector('.pc-hmi-frame img');if(img){earlyObserver.disconnect();img.dispatchEvent(new w.Event('error'));}});earlyObserver.observe(w.document.getElementById('root'),{childList:true,subtree:true});}
  w.eval(script);await until(()=>w.mounted&&w.document.querySelector(mode==='popover'?'.pc-preview-launch':'.pc-hmi-preview'),'Preview did not finish mounting');
  const q=selector=>{const found=w.document.querySelector(selector);assert.ok(found,'Missing '+selector);return found;};
  const click=async selector=>{
    q(selector).click();
    await until(()=>{const body=w.document.querySelector('.pc-result-popover-body');return body&&!body.textContent.includes('正在读取修改…');},'Preview content did not finish loading');
    if(selector==='.pc-result-popover-foot button')await until(()=>!!w.document.querySelector('.pc-result-overlay'),'Enlarged preview did not render');
  };
  const select=async id=>{q('[aria-label="选择 HMI 画面"]').value=id;q('[aria-label="选择 HMI 画面"]').dispatchEvent(new w.Event('change',{bubbles:true}));await tick();};
  return {w,dom,q,click,select,errors,requests,close(){earlyObserver?.disconnect();w.stop();w.close();}};
}

test('bubble displays both native drawings as isolated images with one scroll owner and explicit enlargement',async()=>{
  const env=await environment(file),{w,q,click,requests,errors}=env;
  try{
    assert.equal(requests.length,0);await click('.pc-preview-launch');assert.equal(requests.length,1);
    const images=[...w.document.querySelectorAll('.pc-hmi-frame img')];assert.equal(images.length,2);
    assert.deepEqual(images.map(img=>Buffer.from(img.src.split(',')[1],'base64').toString('utf8')),[file.beforeHmi.views[0].svg,file.afterHmi.views[0].svg]);
    assert.equal(q('.pc-hmi-preview').querySelector('svg,script,foreignObject,iframe,button,input'),null);
    assert.match(q('.pc-hmi-static').textContent,/静态画面/);
    assert.equal(w.getComputedStyle(q('.pc-result-popover-body')).overflowY,'auto');
    assert.equal(w.getComputedStyle(q('.pc-result-popover-body')).overflowX,'hidden');
    for(const element of w.document.querySelectorAll('.pc-hmi-preview *'))assert.ok(!['auto','scroll'].includes(w.getComputedStyle(element).overflowY));
    assert.equal(w.getComputedStyle(images[0]).width,'100%');
    await click('.pc-result-popover-foot button');q('.pc-result-overlay');assert.equal(q('.pc-result-popover').getAttribute('aria-modal'),'true');
    const css=q('.pc-hmi-preview style').textContent;assert.match(css,/@media\(max-width:600px\).*grid-template-columns:minmax\(0,1fr\)/s);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>!w.document.querySelector('.pc-result-popover'),'Escape did not close the preview');assert.equal(w.document.querySelector('.pc-result-popover'),null);
    assert.equal(w.document.activeElement,q('.pc-preview-launch'));assert.deepEqual(errors,[]);
  }finally{env.close();}
});

test('view selection preserves identity and labels removed pages, partial renderings and unchanged appearance',async()=>{
  const same=view('same','相同画面'),old=view('old','旧画面'),changed=view('main','修改画面',{partial:true});
  const env=await environment({...file,beforeHmi:snapshot(same,file.beforeHmi.views[0],old),afterHmi:snapshot(changed,same)}),{w,q,click,select}=env;
  try{
    await click('.pc-preview-launch');assert.equal(q('[aria-label="选择 HMI 画面"]').value,'main');assert.match(q('.pc-hmi-preview').textContent,/部分元素未展示/);
    await select('old');assert.match(q('.pc-hmi-preview').textContent,/此画面已移除/);assert.equal(w.document.querySelectorAll('.pc-hmi-frame img').length,1);
    await select('same');assert.match(q('.pc-hmi-preview').textContent,/画面外观未变化/);assert.doesNotMatch(q('.pc-hmi-preview').textContent,/没有修改/);
    w.render({...task,status:'kept'});await until(()=>!w.document.querySelector('.pc-result-popover'),'Changed task status did not close the preview');assert.equal(w.document.querySelector('.pc-result-popover'),null);
    await click('.pc-preview-launch');assert.equal(requestsAreReadOnly(env.requests),true);assert.deepEqual(env.errors,[]);
  }finally{env.close();}
});
function requestsAreReadOnly(requests){return requests.length>=1&&requests.every(url=>String(url).includes('/conversations/preview?'));}

test('missing baselines and omitted pages are never presented as confirmed additions or deletions',async()=>{
  for(const [extra,expected,unexpected] of [
    [{beforeHmi:null,beforeUnavailable:true},/旧基线不可用/,/此前没有此画面/],
    [{beforeHmi:null,beforeSha256:null},/此前没有此画面/,/旧基线不可用/],
    [{afterHmi:null,afterUnavailable:true,unavailableReason:'修改后画面无法解析'},/此版本暂不能预览/,/此画面已移除/],
    [{afterHmi:null,afterSha256:null},/此文件已移除/,/暂不能预览/],
    [{afterHmi:{views:[],partial:true}},/此画面未提供预览/,/此画面已移除/],
  ]){
    const env=await environment({...file,...extra});
    try{await env.click('.pc-preview-launch');const text=env.q('.pc-hmi-preview').textContent;assert.match(text,expected);assert.doesNotMatch(text,unexpected);assert.deepEqual(env.errors,[]);}
    finally{env.close();}
  }
});

test('discarded results remain historical and metadata has no meaningless enlarge action',async()=>{
  const historical=await environment(file,{currentTask:{...task,status:'discarded'}});
  try{await historical.click('.pc-preview-launch');assert.match(historical.q('.pc-result-popover').textContent,/已撤销 · 历史/);assert.match(historical.q('.pc-hmi-pair').textContent,/撤销前/);}
  finally{historical.close();}
  const unavailable=await environment({...file,kind:'metadata',unavailableReason:'请在 FUXA 查看'});
  try{await unavailable.click('.pc-preview-launch');assert.equal(unavailable.w.document.querySelector('.pc-result-popover-foot button'),null);assert.match(unavailable.q('.pc-result-popover-body').textContent,/FUXA/);}
  finally{unavailable.close();}
});

test('full and compact result views use the same image renderer and image decoding failure is explicit',async()=>{
  for(const mode of ['full','compact']){
    const env=await environment(file,{mode});
    try{
      assert.equal(env.w.document.querySelectorAll('.pc-hmi-frame img').length,2);
      env.q('.pc-hmi-frame img').dispatchEvent(new env.w.Event('error'));await until(()=>/画面未能显示/.test(env.w.document.querySelector('.pc-hmi-preview')?.textContent||''),'Image error did not become visible');assert.match(env.q('.pc-hmi-preview').textContent,/画面未能显示/);assert.deepEqual(env.errors,[]);
    }finally{env.close();}
  }
});

test('an image decode error immediately after mount is not cleared by a later passive effect',async()=>{
  const env=await environment(file,{mode:'full',earlyImageError:true});
  try{
    await until(()=>/画面未能显示/.test(env.w.document.querySelector('.pc-hmi-preview')?.textContent||''),'Early image error was lost');
    assert.match(env.q('.pc-hmi-preview').textContent,/画面未能显示/);assert.equal(env.w.document.querySelectorAll('.pc-hmi-frame img').length,1);assert.deepEqual(env.errors,[]);
  }finally{env.close();}
});

test('image data is never promoted into host markup or active controls even if a server regresses',async()=>{
  const hostile='<svg xmlns="http://www.w3.org/2000/svg" onload="window.hmiRan=true"><script>window.hmiRan=true</script><foreignObject><button xmlns="http://www.w3.org/1999/xhtml">Danger</button></foreignObject></svg>';
  const env=await environment({...file,afterHmi:snapshot(view('main','Untrusted',{svg:hostile}))});
  try{
    await env.click('.pc-preview-launch');const panel=env.q('.pc-hmi-preview');
    assert.equal(panel.querySelector('svg,script,foreignObject,button,iframe'),null);assert.equal(env.w.hmiRan,undefined);
    assert.ok([...panel.querySelectorAll('img')].every(image=>image.src.startsWith('data:image/svg+xml;base64,')));
    assert.deepEqual(env.errors,[]);
  }finally{env.close();}
});
