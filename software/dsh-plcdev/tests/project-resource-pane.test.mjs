import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const source=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),taskId='task-'+'b'.repeat(32),digest='c'.repeat(64);
const revision='d'.repeat(64),savedRevision='e'.repeat(64),sessionId='chat-a';
const response=value=>({ok:true,status:200,json:async()=>value});
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
async function until(check,message='UI did not settle'){
  for(let attempt=0;attempt<120;attempt++){if(check())return;await tick();}
  assert.ok(check(),message);
}
const proposal=()=>({projectId,taskId,request:'修改 PLC 并新增 HMI 和 OIP',workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,candidate:{candidateDigest:digest,revisionSupported:true,
  components:[{tool:'openplc',summary:'修改 main'},{tool:'fuxa',summary:'创建操作画面'},{tool:'oip',summary:'创建场景'}],
  changes:[{path:'plc/pous/programs/main.st',beforeSha256:revision,afterSha256:digest},{path:'hmi/main.fuxap',beforeSha256:null,afterSha256:digest},{path:'integration/abc/oip/project.json',beforeSha256:null,afterSha256:digest}]}});
let compiled;
async function fixture({tasks=[proposal()],refs=tasks.map(({projectId,taskId})=>({projectId,taskId})),allSaved=false,slowEditor=false}={}){
  if(!compiled)compiled=(await buildTools.build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ProjectPane} from '${source}/ProjectPane.tsx';
    import {createConversationContexts} from '${source}/conversation-context.mjs';
    import {createProjectContexts} from '${source}/project-context.mjs';
    import {taskReadsFor} from '${source}/task-reads.mjs';
    import {notifyReviewChange} from '${source}/review-mutation.mjs';
    const contexts=createConversationContexts(),projectContexts=createProjectContexts(),app=createRoot(document.getElementById('root'));
    window.refreshBinding=()=>contexts.get('chat-a').refresh();
    window.refreshProject=()=>projectContexts.get('${projectId}').refresh();
    window.changed=()=>notifyReviewChange('plcdev.dsh.d3.review.chat-a.${projectId}.${taskId}');
    app.render(<ProjectPane sessionId="chat-a" contexts={contexts} projectContexts={projectContexts}
      useTabInfo={()=>({tab:{navigation:{params:{projectId:'${projectId}'}}}})}
      onProject={()=>{}} onRetainedProject={()=>{}} onOpenRuntime={()=>{}}
      onOpenResultResource={async request=>{window.resourceOpens.push(request);return {ok:true,...request,message:'已打开对应候选'};}}/>);
    window.cleanup=()=>{app.unmount();contexts.dispose();projectContexts.dispose();taskReadsFor(contexts).dispose();};
  `,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
  const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],posts=[],reads=[];
  const state={tasks:structuredClone(tasks),refs:structuredClone(refs),revision,allSaved,failTasks:false,holdTask:null,failStatus:false,holdStatus:null,boundProject:projectId,bindingVersion:1,editorReads:0};
  const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const snapshot=()=>({project:{id:projectId,name:'当前工程',plc:'plc/project.json',defaultMode:'fuxa-local',revision:state.revision,...(state.allSaved?{hmi:'hmi/main.fuxap',scene:'oip/project.json'}:{})},
    projects:[{id:projectId,name:'当前工程'}],projectRevision:state.revision,session:{id:null,active:false},runtimeOwner:null,
    capabilities:{tools:{plc:true,fuxa:state.allSaved,oip:state.allSaved}}});
  const listing=()=>({projectId,projectRevision:state.revision,tasks:structuredClone(state.tasks)});
  const editorReceipt=()=>({ok:true,sourceProjectId:projectId,taskId,targetProjectId:projectId,launchId:'editor-test',nativeProjectPath:'F:/fixture/plc/project.json',state:'requested',sessionId,mode:'preview',revision,candidateDigest:digest});
  const dom=new JSDOM(`<div id="root"></div><script>${compiled.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
    if(slowEditor){const original=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>original(fn,delay===1200?20:delay===15000?10:delay,...args);}
    w.resourceOpens=[];w.fetch=async(url,options={})=>{
      const u=new URL(url,'http://127.0.0.1:55119');reads.push(u.pathname+u.search);
      if(u.pathname.endsWith('/conversations'))return response({conversationId:sessionId,projectId:state.boundProject,version:state.bindingVersion,taskRefs:state.refs,pendingRequests:[]});
      if(u.pathname.endsWith('/status')){
        if(u.searchParams.get('project')===projectId){
          if(state.failStatus)throw Error('工程状态暂时离线');
          if(state.holdStatus){const held=state.holdStatus;state.holdStatus=null;const value=snapshot();return new Promise(resolve=>held(()=>resolve(response(value))));}
        }
        return response(snapshot());
      }
      if(u.pathname.endsWith('/task-state')||u.pathname.endsWith('/task-records')){
        if(state.failTasks)throw Error('任务状态暂时离线');
        const value=listing();if(state.holdTask){const held=state.holdTask;state.holdTask=null;return new Promise(resolve=>held(()=>resolve(response(value))));}
        return response(value);
      }
      if(u.pathname.endsWith('/editor-open')){
        const body=JSON.parse(options.body);posts.push({path:u.pathname,body});
        if(slowEditor)return response(editorReceipt());
        return response({ok:true,sourceProjectId:projectId,taskId:body.taskId??null,targetProjectId:projectId,launchId:'editor-test',nativeProjectPath:'F:/fixture/plc/project.json',state:'loaded',sessionId});
      }
      if(u.pathname.endsWith('/editor-status')&&slowEditor){
        assert.equal(u.searchParams.get('launchId'),'editor-test');assert.equal(u.searchParams.get('taskId'),taskId);
        if(++state.editorReads===1)return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new w.DOMException('signal is aborted without reason','AbortError')),{once:true}));
        return response({...editorReceipt(),state:'loaded',editor:{observation:{state:'clean',loaded:true,dirty:false,revisionMatches:true,observedAt:new Date().toISOString()}}});
      }
      if(u.pathname.endsWith('/action')){posts.push({path:u.pathname,body:JSON.parse(options.body)});return response({ok:true});}
      throw Error('Unexpected endpoint '+u.pathname);
    };
  }});
  const d=dom.window.document;
  const rows=(kind,tool)=>[...d.querySelectorAll(`[data-resource-state="${kind}"]${tool?`[data-resource-tool="${tool}"]`:''}`)];
  await until(()=>rows('saved','openplc').length===1,'Saved PLC must be available');
  return {dom,d,state,posts,reads,errors,rows,snapshot,listing,
    async settle(){await tick();await tick();},
    async changed(){dom.window.changed();await tick();await tick();},
    close(){dom.window.cleanup();dom.window.close();}};
}

test('ordinary background refresh preserves all saved resource rows and enabled buttons while status is in flight',async()=>{
 const f=await fixture({tasks:[],allSaved:true});
 try{
  await f.settle();const before=f.rows('saved');assert.equal(before.length,3);
  const samples=[],section=f.d.querySelector('.pc-project-resources');
  const observer=new f.dom.window.MutationObserver(()=>samples.push({loading:/正在读取工程资源/.test(section.textContent),disabled:f.rows('saved').some(row=>row.querySelector('button').disabled)}));
  observer.observe(section,{subtree:true,childList:true,characterData:true,attributes:true});
  try{
   for(let round=0;round<3;round++){
    let release;f.state.holdStatus=resume=>{release=resume;};f.dom.window.refreshProject();await until(()=>typeof release==='function');await f.settle();
    assert.deepEqual(f.rows('saved'),before,'rows must not be replaced during a normal refresh');
    assert.ok(before.every(row=>!row.querySelector('button').disabled),'view actions must not blink disabled');
    assert.doesNotMatch(section.textContent,/正在读取工程资源/);release();await f.settle();
   }
   assert.ok(samples.every(sample=>!sample.loading&&!sample.disabled),'no intermediate render flashes loading or disables saved resources');
   assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
  }finally{observer.disconnect();}
 }finally{f.close();}
});

test('failed resource reads keep a stable unavailable state during retries and recover without clearing saved rows',async()=>{
 const f=await fixture({tasks:[],allSaved:true});
 try{
  await f.settle();const before=f.rows('saved');f.state.failStatus=true;f.dom.window.refreshProject();
  await until(()=>/工程资源暂时无法读取/.test(f.d.body.textContent));
  assert.equal(f.rows('saved').length,3);assert.ok(f.rows('saved').every(row=>row.querySelector('button').disabled));
  for(let attempt=0;attempt<2;attempt++){f.dom.window.refreshProject();await f.settle();assert.doesNotMatch(f.d.body.textContent,/正在读取工程资源/);}
  f.state.failStatus=false;let release;f.state.holdStatus=resume=>{release=resume;};f.dom.window.refreshProject();await until(()=>typeof release==='function');await f.settle();
  assert.deepEqual(f.rows('saved'),before);assert.doesNotMatch(f.d.body.textContent,/正在读取工程资源/);
  assert.ok(f.rows('saved').every(row=>row.querySelector('button').disabled),'unconfirmed recovery does not restore permission');
  release();await until(()=>f.rows('saved').every(row=>!row.querySelector('button').disabled));
  assert.doesNotMatch(f.d.body.textContent,/工程资源暂时无法读取|正在读取工程资源/);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('sidebar recovers one real fetch abort after native opening without another open or a stale error',async()=>{
  const f=await fixture({slowEditor:true});try{
    await until(()=>f.rows('pending').length===3);f.rows('pending','openplc')[0].querySelector('button').click();
    await until(()=>f.state.editorReads===2&&/已加载候选预览/.test(f.d.body.textContent),'The same native window should recover its loaded confirmation');
    assert.equal(f.posts.filter(item=>item.path.endsWith('/editor-open')).length,1);
    assert.doesNotMatch(f.d.body.textContent,/signal is aborted|响应超时|未能打开/);
    assert.equal(f.rows('pending').length,3);assert.equal(f.rows('saved').length,1);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('sidebar separates saved resources from same-chat pending additions and opens exact PLC/HMI/OIP targets',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);
    assert.equal(f.rows('saved').length,1);
    assert.match(f.rows('pending','openplc')[0].textContent,/修改.*待保留/);
    for(const tool of ['fuxa','oip'])assert.match(f.rows('pending',tool)[0].textContent,/新增.*待保留/);
    for(const tool of ['fuxa','oip']){f.rows('pending',tool)[0].querySelector('button').click();await f.settle();}
    assert.deepEqual(JSON.parse(JSON.stringify(f.dom.window.resourceOpens)),['fuxa','oip'].map(tool=>({conversationId:sessionId,projectId,taskId,candidateDigest:digest,tool,target:'candidate'})));
    f.rows('pending','openplc')[0].querySelector('button').click();await f.settle();
    assert.deepEqual(f.posts[0].body,{conversationId:sessionId,projectId,taskId,candidateDigest:digest,target:'candidate'});
    f.rows('saved','openplc')[0].querySelector('button').click();await f.settle();
    assert.deepEqual(f.posts[1].body,{conversationId:sessionId,projectId,target:'project'});
    assert.equal(f.posts.filter(p=>p.path.endsWith('/action')||p.path.endsWith('/review')).length,0);
    assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('keep and later undo refresh the open sidebar without promoting unkept resources',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);
    f.state.tasks=[{...proposal(),status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}}];
    f.state.revision=savedRevision;f.state.allSaved=true;
    await f.changed();await until(()=>f.rows('pending').length===0&&f.rows('saved').length===3,'Kept resources should move to saved rows');
    const next={...proposal(),taskId:'task-'+'f'.repeat(32),projectRevision:savedRevision};
    f.state.tasks.push(next);f.state.refs.push({projectId,taskId:next.taskId});
    await f.changed();await until(()=>f.rows('pending').length===3);
    for(const row of f.rows('pending'))assert.match(row.textContent,/修改.*待保留/);
    f.state.tasks[1]={...next,status:'discarded'};
    await f.changed();await until(()=>f.rows('pending').length===0);
    assert.equal(f.rows('saved').length,3);assert.equal(f.dom.window.resourceOpens.length,0);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('foreign-session candidates and superseded parents do not appear as current pending resources',async()=>{
  const foreign={...proposal(),taskId:'task-'+'1'.repeat(32),request:'另一个会话的修改'};
  const replaced={...proposal(),taskId:'task-'+'2'.repeat(32),supersededBy:'task-'+'3'.repeat(32)};
  const f=await fixture({tasks:[foreign,replaced],refs:[{projectId,taskId:replaced.taskId}]});
  try{await until(()=>f.reads.some(url=>url.includes('/task-state')));await f.settle();assert.equal(f.rows('pending').length,0);assert.equal(f.rows('saved').length,1);assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('a failed task refresh cannot leave a pending resource opener authorized',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);f.state.failTasks=true;await f.changed();
    await until(()=>f.rows('pending').length===0||f.rows('pending').every(row=>[...row.querySelectorAll('button')].every(button=>button.disabled)));
    for(const row of f.rows('pending'))row.querySelector('button')?.click();await f.settle();
    assert.equal(f.dom.window.resourceOpens.length,0);assert.equal(f.posts.length,0);assert.equal(f.rows('saved').length,1);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('switching the chat binding keeps saved resources but removes this sidebar candidate actions',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);
    f.state.boundProject='user-'+'9'.repeat(32);f.dom.window.refreshBinding();
    await until(()=>f.rows('pending').length===0);
    assert.equal(f.rows('saved').length,1);assert.equal(f.dom.window.resourceOpens.length,0);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('an obsolete in-flight candidate read cannot restore pending rows after keep',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);let release;
    f.state.holdTask=resume=>{release=resume;};f.dom.window.changed();await until(()=>typeof release==='function');
    f.state.tasks=[{...proposal(),status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}}];
    f.state.revision=savedRevision;f.state.allSaved=true;f.dom.window.changed();
    await until(()=>f.rows('saved').length===3&&f.rows('pending').length===0);
    release();await f.settle();
    assert.equal(f.rows('pending').length,0);assert.equal(f.rows('saved').length,3);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('a candidate-open preflight superseded by keep neither launches nor restores pending resources',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);let release;
    f.state.holdTask=resume=>{release=resume;};f.rows('pending','fuxa')[0].querySelector('button').click();
    await until(()=>typeof release==='function');
    f.state.tasks=[{...proposal(),status:'kept',retention:{keptProjectId:projectId,revision:savedRevision,completionScope:'saved-project-version'}}];
    f.state.revision=savedRevision;f.state.allSaved=true;f.dom.window.changed();
    await until(()=>f.rows('saved').length===3&&f.rows('pending').length===0);
    release();await f.settle();
    assert.equal(f.dom.window.resourceOpens.length,0);assert.equal(f.rows('pending').length,0);assert.equal(f.rows('saved').length,3);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('a chat binding away-and-back cannot revive an old candidate-open preflight',async()=>{
  const f=await fixture();try{
    await until(()=>f.rows('pending').length===3);let release;
    f.state.holdTask=resume=>{release=resume;};f.rows('pending','fuxa')[0].querySelector('button').click();
    await until(()=>typeof release==='function');
    f.state.boundProject='user-'+'9'.repeat(32);f.state.bindingVersion=2;f.dom.window.refreshBinding();
    await until(()=>f.rows('pending').length===0);
    f.state.boundProject=projectId;f.state.bindingVersion=3;f.dom.window.refreshBinding();await f.settle();
    release();await until(()=>f.rows('pending').length===3);await f.settle();
    assert.equal(f.dom.window.resourceOpens.length,0);assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});
