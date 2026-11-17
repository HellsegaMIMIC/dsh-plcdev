import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),dir=fileURLToPath(new URL('../src/client/',import.meta.url)).replaceAll('\\','/');
const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationProjectPicker} from '${dir}ProjectList.tsx';import {createConversationContexts} from '${dir}conversation-context.mjs';
const contexts=createConversationContexts(),get=contexts.get;contexts.get=id=>{const c=get(id);if(!c.instrumented){c.instrumented=true;const subscribe=c.subscribeDirectory;c.subscribeDirectory=()=>{window.catalogSubscriptions++;const close=subscribe();return()=>{window.catalogClosures++;close()}}}return c};window.contexts=contexts;
const root=createRoot(document.getElementById('root'));window.render=(sessionId='chat-a')=>root.render(<ConversationProjectPicker contexts={contexts} sessionId={sessionId} snapshot={window.snapshot} connected={true} onReturn={()=>{window.returns.push(sessionId);root.render(null)}}/>);window.render();window.cleanup=()=>{root.unmount();contexts.dispose()};`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await wait();assert.ok(predicate(),'expected picker state');}
const binding=(conversationId,projectId=null,version=0)=>({conversationId,projectId,version,taskRefs:[],pendingRequests:[],participation:{enabled:!!projectId,locked:false}});
const snapshot={catalogOnly:true,project:{id:'catalog',name:'工程目录',kind:'catalog'},projects:[],session:{id:null,active:false},runtimeOwner:null,projectCatalog:{canCreate:true,canOpen:true,defaultParent:'F:/PLCdev-test'},capabilities:{}};
const newId='user-'+'c'.repeat(32);
const receipt=body=>({requestId:body.requestId,projectId:body.projectId,action:body.action,state:'confirmed',result:{ok:true,projectId:newId,project:{id:newId,name:'新建试用工程'}}});

async function fixture(operation){
  const requests=[],bindings=new Map([['chat-a',binding('chat-a')],['chat-b',binding('chat-b')]]),errors=[];
  const {JSDOM,VirtualConsole}=packages('jsdom'),vc=new VirtualConsole();vc.on('jsdomError',error=>{if(!error.message.includes('CSS'))errors.push(error.message);});
  const dom=new JSDOM(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.snapshot=snapshot;w.catalogSubscriptions=0;w.catalogClosures=0;w.returns=[];
    w.fetch=async(url,options={})=>{
      const u=new URL(url,'http://127.0.0.1:55119'),body=options.body?JSON.parse(options.body):null;requests.push({path:u.pathname,body});
      let value;
      if(u.pathname==='/api/plcdev/project-operations')return operation(body,requests);
      if(u.pathname==='/api/plcdev/conversations/bind'){assert.equal(body.expectedVersion,bindings.get(body.conversationId).version);value=binding(body.conversationId,body.projectId,body.expectedVersion+1);bindings.set(body.conversationId,value);}
      else if(u.pathname==='/api/plcdev/conversations')value=bindings.get(u.searchParams.get('conversationId'));
      else if(u.pathname==='/api/plcdev/status')value=snapshot;
      else throw new Error('Unexpected picker route '+u.pathname);
      return {ok:true,status:200,json:async()=>structuredClone(value)};
    };
  }});
  const d=dom.window.document,button=label=>[...d.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
  await until(()=>button('创建工程')&&!button('创建工程').disabled);
  async function submit(){
    d.querySelector('.pc-operations summary').click();const input=d.querySelector('.pc-operations input');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,'新建试用工程');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();button('创建工程').click();
    await until(()=>requests.some(request=>request.path==='/api/plcdev/project-operations'));
  }
  return {dom,d,requests,bindings,errors,button,submit,close(){dom.window.cleanup();dom.window.close();}};
}

test('picker creates through real project operation, binds exact new project to the existing conversation, and closes catalog subscription',async()=>{
  const f=await fixture(async body=>({ok:true,status:200,json:async()=>receipt(body)}));
  try{
    assert.equal(f.dom.window.catalogSubscriptions,1);await f.submit();await until(()=>f.dom.window.returns.length===1&&f.dom.window.catalogClosures===1&&!f.d.querySelector('.pc-project-picker'));
    const writes=f.requests.filter(request=>request.body);assert.equal(writes.length,2);assert.equal(writes[0].path,'/api/plcdev/project-operations');
    assert.deepEqual(writes[1],{path:'/api/plcdev/conversations/bind',body:{conversationId:'chat-a',projectId:newId,expectedVersion:0}});
    assert.deepEqual([...f.dom.window.returns],['chat-a']);assert.equal(f.bindings.get('chat-b').projectId,null);assert.equal(f.dom.window.catalogClosures,1);assert.equal(f.d.querySelector('.pc-project-picker'),null);
    assert.deepEqual(f.errors,[]);assert.equal(f.requests.some(request=>request.path.includes('sessions')),false,'no second host conversation is created');
  }finally{f.close();}
});

test('unknown creation outcome retains pending receipt without binding or returning',async()=>{
  const f=await fixture(async()=>({ok:false,status:503,json:async()=>({error:'lost receipt'})}));
  try{await f.submit();await until(()=>f.d.body.textContent.includes('操作结果尚未确认'));assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.equal(f.dom.window.returns.length,0);assert.ok(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));}
  finally{f.close();}
});

test('switching to another conversation while creation is pending never binds the late result to either conversation',async()=>{
  let release;const f=await fixture(async body=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>receipt(body)})));
  try{await f.submit();f.dom.window.render('chat-b');await wait();release();await wait();await wait();assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.equal(f.dom.window.returns.length,0);assert.equal(f.bindings.get('chat-b').projectId,null);assert.equal(f.dom.window.catalogClosures,1);}
  finally{f.close();}
});

test('a binding changed by another view during creation requires explicit project selection',async()=>{
  let release;const f=await fixture(async body=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>receipt(body)})));
  try{await f.submit();f.bindings.set('chat-a',binding('chat-a','project-other',1));f.dom.window.contexts.get('chat-a').refresh();await wait();release();await until(()=>f.d.body.textContent.includes('当前对话关联已变化'));assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.equal(f.dom.window.returns.length,0);assert.equal(f.bindings.get('chat-a').projectId,'project-other');}
  finally{f.close();}
});

test('leaving and returning to the same session does not revive a stale creation callback',async()=>{
  let release;const f=await fixture(async body=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>receipt(body)})));
  try{await f.submit();f.dom.window.render('chat-b');await wait();f.dom.window.render('chat-a');await wait();release();await wait();await wait();assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.equal(f.dom.window.returns.length,0);}
  finally{f.close();}
});

test('canceling the picker releases catalog reads and a later creation receipt never navigates or binds',async()=>{
  let release;const f=await fixture(async body=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>receipt(body)})));
  try{await f.submit();f.button('← 返回对话').click();await wait();assert.equal(f.dom.window.catalogClosures,1);release();await wait();await wait();assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.deepEqual([...f.dom.window.returns],['chat-a']);assert.ok(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'),'leaving the view cannot erase the outstanding receipt');}
  finally{f.close();}
});

test('recovering a receipt from another conversation confirms creation without attaching it to the current conversation',async()=>{
  let original;const f=await fixture(async body=>{
    if(body){original=body;return {ok:false,status:503,json:async()=>({error:'lost receipt'})};}
    return {ok:true,status:200,json:async()=>receipt(original)};
  });
  try{
    await f.submit();await until(()=>f.d.body.textContent.includes('操作结果尚未确认'));
    assert.equal(JSON.parse(f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1')).conversationId,'chat-a');
    f.dom.window.render('chat-b');await wait();f.button('核对原请求').click();await until(()=>!f.dom.window.localStorage.getItem('plcdev.dsh.project-operation.pending.v1'));
    assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.equal(f.dom.window.returns.length,0);assert.equal(f.bindings.get('chat-b').projectId,null);
  }finally{f.close();}
});

test('legacy catalog receipt without a conversation owner cannot activate a conversation',async()=>{
  let original;const f=await fixture(async body=>{
    if(body){original=body;return {ok:false,status:503,json:async()=>({error:'lost receipt'})};}
    return {ok:true,status:200,json:async()=>receipt(original)};
  });
  try{
    await f.submit();await until(()=>f.d.body.textContent.includes('操作结果尚未确认'));
    const key='plcdev.dsh.project-operation.pending.v1',pending=JSON.parse(f.dom.window.localStorage.getItem(key));delete pending.conversationId;f.dom.window.localStorage.setItem(key,JSON.stringify(pending));
    f.button('← 返回对话').click();await wait();f.dom.window.render('chat-a');await until(()=>f.button('核对原请求'));
    f.button('核对原请求').click();await until(()=>!f.dom.window.localStorage.getItem(key));assert.equal(f.requests.filter(request=>request.path.endsWith('/bind')).length,0);assert.deepEqual([...f.dom.window.returns],['chat-a']);
  }finally{f.close();}
});
