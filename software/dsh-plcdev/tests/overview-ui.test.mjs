import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const {JSDOM,VirtualConsole}=packages('jsdom');
const built=await buildTools.build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {App} from '"+dir+"/App.tsx';import {createProjectContexts} from '"+dir+"/project-context.mjs';const projectContexts=createProjectContexts();const root=createRoot(document.getElementById('test'));root.render(<App projectContexts={projectContexts} hostSessions={window.hostSessions} openSession={window.openSession} {...window.appProps}/>);window.cleanup=()=>{root.unmount();projectContexts.dispose();};",loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const taskId='task-'+'a'.repeat(32),oldTaskId='task-'+'e'.repeat(32),revision='b'.repeat(64);
const wait=()=>new Promise(r=>setTimeout(r,60));
async function waitFor(predicate){for(let i=0;i<50&&!predicate();i++)await wait();assert.ok(predicate(),'expected UI state did not arrive');}
// Restoring a page is scheduled after React renders the resource and then on
// the next animation frame. Resource presence alone does not prove scrolling
// has completed, especially while other UI suites share the event loop.
async function waitForScroll(f,expected){
  const deadline=Date.now()+2000;
  while(f.d.querySelector('.pd-workspace-content')?.scrollTop!==expected&&Date.now()<deadline)
    await new Promise(resolve=>f.dom.window.requestAnimationFrame(resolve));
  assert.equal(f.d.querySelector('.pd-workspace-content')?.scrollTop,expected,'workspace scroll restore did not complete within 2 seconds');
}
function fixture({pending,post,hmiAllowed=false,selection,getFailure,setup}={}){
  const requests=[],events=[],errors=[];let recovery={state:'pending',reasonCode:'pending'};
  const projects=[{id:'project-a',name:'工程 A',plc:'A/plc/project.json',target:'local',defaultMode:'fuxa-oip',configuration:{hmiFile:'A/hmi.json',sceneFile:'A/scene.json'}},{id:'project-b',name:'工程 B',plc:'B/plc/project.json',target:'local',defaultMode:'local',hmiExecutable:'B/hmi.exe'}];
  const snapshot=id=>({project:projects.find(p=>p.id===id),projects,phase:'idle',session:{projectId:id,id:null,active:false},runtimeOwner:null,components:{plc:{state:'available',label:'入口可用'},runtime:{state:'idle'}},links:{load:{state:'unloaded'},generate:{state:'current'},variables:{state:'inactive',details:{protocol:'本机 HTTP',endpoint:'http://127.0.0.1:19091/plcdev/tags'}},io:{state:'inactive',details:{protocol:'Modbus TCP',endpoint:'127.0.0.1:19093'}}},capabilities:{tools:{plc:true},canShowHmi:hmiAllowed},events:[]});
  const tasks=id=>({projectId:id,projectRevision:revision,capabilities:{savedRevisionCandidate:true},tasks:id==='project-a'?[{projectId:id,taskId,status:'awaiting_review',request:'A 的画面修改',workflow:'hmi-view-name-v1',candidate:{candidateDigest:'c'.repeat(64)}},{projectId:id,taskId:oldTaskId,status:'awaiting_review',request:'旧版改名记录',workflow:'count-rename-v1'}]:[]});
  const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});
  const dom=new JSDOM('<div id="test"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.ResizeObserver=class{observe(){}disconnect(){}};
    if(pending)w.localStorage.setItem('plcdev.dsh.d1.pending',JSON.stringify([[pending.projectId,pending]]));
    if(selection)w.localStorage.setItem('plcdev.dsh.d1.project',selection);
    const list={getSnapshot:()=>({phase:'ready',ids:['chat-a'],byId:{'chat-a':{title:'画面调整',origin:'user'}}}),subscribe:()=>()=>{}};
    w.hostSessions={get:()=>({list}),subscribe:()=>()=>{}};
    w.openSession=async target=>{events.push({name:'open-session',...target});return {ok:true};};
    w.fetch=async(url,options)=>{
      const record={url,method:options.method,body:options.body&&JSON.parse(options.body)};requests.push(record);
      if(options.method!=='GET'){assert.ok(post,'unexpected write');return post(record);}
      const u=new URL(url,'http://127.0.0.1:55110'),id=u.searchParams.get('project')||u.searchParams.get('projectId')||'project-a';
      const failure=getFailure?.(u,id);if(failure)return {ok:false,status:404,json:async()=>({error:failure})};
      return {ok:true,json:async()=>u.pathname.endsWith('/conversations/project')?{projectId:id,current:id==='project-a'?[{conversationId:'chat-a',currentProjectId:id,taskIds:[taskId]}]:[],historical:[],unavailable:[],countsComplete:true}:u.pathname.endsWith('/fuxa-recovery')?{ok:true,projectId:id,...recovery}:u.pathname.endsWith('/tasks')?tasks(id):snapshot(id)};
    };
    w.addEventListener('plcdev:open-conversation',e=>events.push({name:e.type,...e.detail}));
    setup?.(w,events);
  }});
  const d=dom.window.document;
  const button=label=>[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
  const click=async label=>{assert.ok(button(label),'button '+label);button(label).click();await wait();};
  return {dom,d,requests,events,errors,button,click,setRecovery:r=>recovery=r,setGetFailure:fn=>getFailure=fn,close:()=>{dom.window.cleanup();dom.window.close();}};
}

for(const mode of ['choose','current','create','standalone'])test('OpenPLC resource entry uses an explicit conversation: '+mode,async()=>{
  const created=[];
  const f=fixture({
    setup(w){w.appProps={contexts:{activeSession:()=>mode==='current'?'chat-a':null,get:()=>({snapshot:()=>({binding:{projectId:'project-a'}})})},onCreateSession:async id=>{created.push(id);return {ok:true,projectId:id,sessionId:'chat-new'};}};},
    post:record=>({ok:true,status:200,json:async()=>record.url.endsWith('/editor-open')?{ok:true,sourceProjectId:record.body.projectId,targetProjectId:record.body.projectId,launchId:'editor-project-1',state:'loaded',nativeProjectPath:'A/plc/project.json'}:{ok:true}}),
  });
  try{
    await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.button('打开 OpenPLC'));await f.click('打开 OpenPLC');
    if(mode!=='current'){
      await waitFor(()=>f.d.querySelector('[aria-label="关联 DSH 会话"]'));
      assert.equal(f.requests.filter(r=>r.method==='POST').length,0,'listing sessions never chooses or opens one');
      assert.equal(f.button('连接会话并打开').disabled,true);
      if(mode==='choose'){
        const select=f.d.querySelector('[aria-label="关联 DSH 会话"]');assert.equal(select.value,'');select.value='chat-a';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await wait();await f.click('连接会话并打开');
      }else await f.click(mode==='create'?'新建会话并打开':'仅打开编辑器');
    }
    await waitFor(()=>f.requests.some(r=>r.method==='POST'));
    const writes=f.requests.filter(r=>r.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].body.projectId,'project-a');
    if(mode==='standalone'){assert.equal(writes[0].body.action,'tool');assert.equal(writes[0].body.tool,'plc');assert.ok(writes[0].url.endsWith('/action'));}
    else {assert.ok(writes[0].url.endsWith('/editor-open'));assert.equal(writes[0].body.target,'project');assert.equal(writes[0].body.conversationId,mode==='create'?'chat-new':'chat-a');}
    assert.deepEqual(created,mode==='create'?['project-a']:[]);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('a stale remembered project can load the catalog without replacing its identity or pending work',async()=>{
  const pending={projectId:'project-removed',request:'旧工程的修改',expectedRevision:'d'.repeat(64),executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'original-request'};
  const f=fixture({selection:pending.projectId,pending,getFailure:(_url,id)=>id===pending.projectId?'工程不存在；请选择工程后重试':null});
  try{
    await waitFor(()=>f.button('打开工程'));
    assert.match(f.d.querySelector('[role="alert"]').textContent,/工程不存在/);
    assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.project'),pending.projectId);
    const saved=f.dom.window.localStorage.getItem('plcdev.dsh.d1.pending');assert.deepEqual(JSON.parse(saved),[[pending.projectId,pending]]);
    assert.equal(f.d.querySelector('.pd-connection.good'),null);assert.equal(f.d.querySelector('.pd-workspace-content'),null);
    assert.ok(f.requests.some(r=>r.url.endsWith('/status')));
    assert.ok(f.requests.filter(r=>r.url.includes('/tasks')).every(r=>r.url.includes('project-removed')));
    const card=[...f.d.querySelectorAll('article')].find(c=>c.textContent.includes('工程 B'));card.querySelector('button').click();
    await waitFor(()=>f.button('切换查看工程')?.textContent.includes('工程 B')&&f.d.querySelector('.pd-connection.good'));
    assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.project'),'project-b');
    assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.pending'),saved);
    assert.equal(f.d.querySelector('[role="alert"]'),null);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.events,[]);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('project tabs, picker cancel and explicit project back preserve the visible origin without writes',async()=>{
  const f=fixture();try{
    await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.d.querySelector('[data-resource="plc"]'));
    f.d.querySelector('[data-resource="plc"]').click();await wait();f.d.querySelector('.pd-workspace-content').scrollTop=317;
    await f.click('工程设置');assert.equal(f.d.querySelector('[aria-label="资源详情"]'),null);
    await f.click('工程资源');assert.match(f.d.querySelector('[aria-label="资源详情"]').textContent,/A\/plc\/project.json/);await waitForScroll(f,317);
    await f.click('切换查看工程');assert.ok(f.d.querySelector('.pd-catalog'));f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait();
    assert.equal(f.d.querySelector('.pd-catalog'),null);await waitForScroll(f,317);assert.ok(f.d.querySelector('[aria-label="资源详情"]'));
    await f.click('切换查看工程');const card=[...f.d.querySelectorAll('article')].find(c=>c.textContent.includes('工程 B'));card.querySelector('button').click();await waitFor(()=>f.button('切换查看工程')?.textContent.includes('工程 B'));
    assert.equal(f.d.querySelector('[aria-label="资源详情"]'),null);await f.click('← 返回工程 A');await waitFor(()=>f.d.querySelector('[aria-label="资源详情"]')?.textContent.includes('A/plc/project.json'));
    await waitForScroll(f,317);assert.equal(f.d.querySelector('[aria-current="page"]').textContent,'工程资源');assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.events,[]);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('queued workspace intent restores the source tab and object after the host panel mounts',async()=>{
  let intent={projectId:'project-b',view:'resources',selected:'plc',scroll:186,restore:true,returnTo:{sessionId:'chat-b'}};const returned=[];
  const f=fixture({setup(w){w.appProps={getWorkspaceIntent:()=>intent,clearWorkspaceIntent:target=>{if(target===intent)intent=null;},onReturnToSession:id=>returned.push(id)};}});
  try{await waitFor(()=>f.d.querySelector('[aria-label="资源详情"]')?.textContent.includes('B/plc/project.json'));assert.equal(intent,null);assert.equal(f.d.querySelector('.pd-catalog'),null);await waitFor(()=>f.d.querySelector('.pd-workspace-content').scrollTop===186);await f.click('返回来源会话');assert.deepEqual(returned,['chat-b']);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('closing a detail restores the content position and keyboard focus captured before opening',async()=>{
  const f=fixture();try{await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.d.querySelector('[data-resource="plc"]'));const trigger=f.d.querySelector('[data-resource="plc"]'),content=f.d.querySelector('.pd-workspace-content');content.scrollTop=426;trigger.focus();trigger.click();await waitFor(()=>f.button('关闭资源详情'));content.scrollTop=900;await f.click('关闭资源详情');await waitFor(()=>content.scrollTop===426);assert.equal(f.d.activeElement,trigger);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

for(const interrupt of [false,true])test('saved signal origin waits for delayed inspection'+(interrupt?' and respects subsequent user scrolling':''),async()=>{
  let release,intent={projectId:'project-b',view:'resources',selected:'signal:count',scroll:426,restore:true};
  const f=fixture({setup(w){
    let ready=false;const positions=new WeakMap();Object.defineProperty(w.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return positions.get(this)||0;},set(value){positions.set(this,this.classList?.contains('pd-workspace-content')&&!ready?0:value);}});
    w.appProps={getWorkspaceIntent:()=>intent,clearWorkspaceIntent:target=>{if(target===intent)intent=null;}};
    const original=w.fetch;w.fetch=(url,options)=>String(url).includes('/project-inspection')?new Promise(resolve=>release=()=>{ready=true;resolve({ok:true,json:async()=>({ok:true,schemaVersion:1,projectId:'project-b',projectRevision:revision,source:'saved-files-only',editorState:{state:'unknown',message:'仅读取保存文件'},resources:[],signals:[{id:'count',label:'数量',path:'MAIN.Count',type:'INT',access:'read',source:{kind:'plc',path:'plc/main.st'},hmi:[],scene:[]}],readback:{state:'untracked',baselineRevision:null,observedRevision:revision,capturedRevision:null,acknowledgedRevision:null,changes:[],layoutOnly:false,lastReview:null},capabilities:{canCapture:true,canAcknowledgeLayout:false}})});}):original(url,options);
  }});
  try{await waitFor(()=>release&&f.d.querySelector('.pd-connection.good'));await wait();const content=f.d.querySelector('.pd-workspace-content');assert.equal(content.scrollTop,0);assert.equal(JSON.parse(f.dom.window.localStorage.getItem('plcdev.dsh.workspace.v2')).current.scroll,426);if(interrupt)content.dispatchEvent(new f.dom.window.WheelEvent('wheel',{deltaY:1,bubbles:true}));release();await waitFor(()=>f.d.querySelector('[data-resource="signal:count"]'));await waitFor(()=>content.scrollTop===(interrupt?0:426));assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('opening a real associated conversation records the exact engineering origin first',async()=>{
  const order=[];const f=fixture({setup(w){w.addEventListener('plcdev:workspace-origin',e=>order.push({kind:'origin',...e.detail}));const open=w.openSession;w.openSession=async target=>{order.push({kind:'open',...target});return open(target);};}});
  try{await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await f.click('关联会话');await waitFor(()=>f.button('打开会话'));await f.click('打开会话');assert.equal(order[0].kind,'origin');assert.equal(order[0].view,'sessions');assert.equal(order[0].projectId,'project-a');assert.equal(order[0].sessionId,'chat-a');assert.equal(order[1].kind,'open');assert.equal(order[1].sessionId,'chat-a');assert.deepEqual(f.errors,[]);}finally{f.close();}
});

test('catalog fallback does not turn a disconnected project into a connected one or enable writes',async()=>{
  const f=fixture({hmiAllowed:true});
  try{
    await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.d.querySelector('.pd-connection.good'));
    f.setGetFailure(()=> '工程后台暂不可用');await f.click('刷新工程状态');
    await waitFor(()=>f.d.querySelector('[role="alert"]')?.textContent.includes('工程后台暂不可用'));
    assert.equal(f.d.querySelector('.pd-connection.good'),null);assert.equal(f.button('打开运行画面'),undefined);
    await f.click('运行与监视');assert.equal(f.button('停止 PLC').disabled,true);
    await f.click('切换查看工程');assert.ok(f.button('打开工程'));assert.match(f.d.querySelector('[role="alert"]').textContent,/后台暂不可用/);
    assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.project'),'project-a');assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(f.events,[]);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('integrated workspace has one resource and monitoring flow; session review keeps its owner',async()=>{
  const f=fixture();const {d,click,button,requests,events}=f;
  try{
    await waitFor(()=>button('打开工程'));await click('打开工程');await waitFor(()=>d.querySelector('[data-resource="plc"]'));
    assert.match(button('切换查看工程').textContent,/工程 A/);assert.equal(d.querySelector('.pd-info'),null);assert.equal(d.querySelector('.pd-footer'),null);
    assert.equal(d.querySelector('[data-resource^="task:"]'),null);assert.doesNotMatch(d.querySelector('.pd-workspace-content').textContent,/创建候选|M1|变量监视|旧版改名记录/);
    assert.equal(d.querySelectorAll('[aria-label="主要工作区"] button').length,2);assert.equal(d.querySelectorAll('[aria-label="工程管理"] button').length,2);
    assert.equal(d.querySelector('.pd-topology-details'),null);assert.equal(d.querySelector('[data-edge]'),null);assert.equal(button('打开运行画面').disabled,true);
    const connections=[...d.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent.trim()==='连接配置');
    assert.ok(connections);assert.ok(connections.closest('[aria-label="工程信号与绑定"]'));assert.equal(connections.open,false);
    assert.deepEqual([...connections.querySelectorAll('[data-resource]')].map(item=>item.dataset.resource).sort(),['link:io','link:variables']);
    assert.equal(d.querySelector('[data-resource="link:generate"]'),null);assert.equal(button('画面交付'),undefined);
    await waitFor(()=>d.body.textContent.includes('发现原 FUXA 待处理预览'));assert.equal(button('打开 FUXA 检查').disabled,true);
    f.setRecovery({state:'conflict',reasonCode:'native_write_unknown'});await click('刷新工程状态');await waitFor(()=>d.body.textContent.includes('FUXA 原生保存结果待核对'));assert.match(d.body.textContent,/核对原生画面、设备设置和工程文件/);
    d.querySelector('[data-resource="plc"]').click();await wait();assert.match(d.querySelector('[aria-label="资源详情"]').textContent,/A\/plc\/project.json/);await click('关闭资源详情');
    connections.querySelector('summary').click();await wait();assert.equal(connections.open,true);
    const content=d.querySelector('.pd-workspace-content'),ioTrigger=d.querySelector('[data-resource="link:io"]');
    content.scrollTop=426;ioTrigger.focus();ioTrigger.click();await waitFor(()=>d.querySelector('[aria-label="资源详情"]')?.textContent.includes('Modbus TCP'));
    assert.match(d.querySelector('[aria-label="资源详情"]').textContent,/127\.0\.0\.1:19093/);assert.equal(d.querySelectorAll('[aria-label="资源详情"]').length,1);
    content.scrollTop=900;await click('关闭资源详情');await waitForScroll(f,426);assert.equal(d.activeElement,ioTrigger);assert.equal(connections.open,true);
    d.querySelector('[data-resource="link:variables"]').click();await wait();assert.match(d.querySelector('[aria-label="资源详情"]').textContent,/本机 HTTP/);assert.match(d.querySelector('[aria-label="资源详情"]').textContent,/http:\/\/127\.0\.0\.1:19091\/plcdev\/tags/);
    d.querySelector('[data-resource="scene"]').click();await wait();assert.equal(d.querySelectorAll('[aria-label="资源详情"]').length,1);assert.ok(d.querySelector('.pd-workspace-aside [aria-label="资源详情"]'));assert.equal(d.querySelector('[data-resource="scene"]').closest('.pd-resource-row').querySelector('[aria-label="资源详情"]'),null);
    d.querySelector('[data-resource="designer"]').click();await wait();const hmiDetail=d.querySelector('[aria-label="资源详情"]');assert.match(hmiDetail.textContent,/画面交付/);assert.match(hmiDetail.textContent,/编辑器与运行画面使用同一文件/);assert.match(hmiDetail.textContent,/交付方式/);assert.equal(hmiDetail.textContent.match(/A\/hmi\.json/g)?.length,1,'a shared editing/runtime file is listed only once');assert.equal(d.querySelectorAll('[aria-label="资源详情"]').length,1);await click('关闭资源详情');
    await click('选择关联会话');assert.deepEqual(events,[]);
    await waitFor(()=>button('审阅修改'));assert.match(d.body.textContent,/画面调整/);await click('审阅修改');assert.equal(events.length,0);assert.equal(d.querySelector('.pd-workspace-aside [aria-label="PLCdev 原生候选审阅"]').dataset.projectId,'project-a');await click('前往来源会话');assert.equal(events.at(-1).sessionId,'chat-a');assert.equal(events.at(-1).taskId,taskId);await click('关闭审阅');
    await click('运行与监视');await waitFor(()=>button('停止 PLC'));assert.equal(button('停止 PLC').disabled,true);assert.equal(d.querySelectorAll('[aria-label="运行状态与监视"]').length,1);
    await click('工程设置');assert.match(d.body.textContent,/旧版请求与兼容记录/);assert.match(d.body.textContent,/旧版改名记录/);assert.doesNotMatch(d.body.textContent,/M1 · 规则改名|生成独立候选/);assert.equal(d.querySelector('.pd-events'),null);assert.match(d.body.textContent,/运行报错与历史事件统一在/);
    await click('切换查看工程');const card=[...d.querySelectorAll('article')].find(c=>c.textContent.includes('工程 B'));card.querySelector('button').click();await waitFor(()=>button('切换查看工程')?.textContent.includes('工程 B'));
    assert.equal(d.querySelector('[data-resource="link:io"]'),null);assert.equal(d.querySelector('[aria-label="资源详情"]'),null);assert.equal(d.querySelector('[data-edge]'),null);assert.doesNotMatch(d.querySelector('.pd-workspace-content').textContent,/A 的画面修改|旧版改名记录|FUXA 原生保存结果待核对|A\/hmi.json|127\.0\.0\.1:19093/);
    assert.ok(requests.every(r=>r.method==='GET'));assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('removing the legacy composer preserves recovery identity and never creates a replacement request',async()=>{
  const pending={projectId:'project-a',request:'把 Count 改为 BatchCount',expectedRevision:'d'.repeat(64),executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'original-request'};
  let release;const f=fixture({pending,post:()=>new Promise(r=>release=r)});
  try{
    await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.button('查看恢复记录'));
    assert.equal(f.requests.some(r=>r.method==='POST'),false);await f.click('查看恢复记录');await waitFor(()=>f.button('按原编号恢复请求')&&!f.button('按原编号恢复请求').disabled);
    const saved=f.dom.window.localStorage.getItem('plcdev.dsh.d1.pending');assert.ok(saved);
    f.button('按原编号恢复请求').click();f.button('按原编号恢复请求')?.click();await wait();
    const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.deepEqual(posts[0].body,pending);assert.equal(f.button('正在核对…').disabled,true);
    release({ok:false,status:408,json:async()=>({error:'timeout'})});await waitFor(()=>f.d.body.textContent.includes('旧请求尚未核对完成'));
    assert.equal(f.dom.window.localStorage.getItem('plcdev.dsh.d1.pending'),saved);
    await f.click('工程资源');assert.ok(f.button('查看恢复记录'));assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});


test('resource list opens FUXA and standalone HMI directly with the original capability gates',async()=>{
  const f=fixture({hmiAllowed:true,post:()=>({ok:true,json:async()=>({ok:true})})});
  try{
    await waitFor(()=>f.button('打开工程'));await f.click('打开工程');await waitFor(()=>f.button('打开运行画面'));
    assert.equal(f.d.querySelector('.pd-topology-details'),null);assert.equal([...f.d.querySelectorAll('button')].filter(b=>b.textContent==='打开运行画面').length,1);assert.equal(f.requests.some(r=>r.method==='POST'),false);
    await f.click('打开运行画面');const first=f.requests.filter(r=>r.method==='POST');assert.equal(first.length,1);assert.equal(first[0].body.action,'open-hmi');assert.equal(first[0].body.projectId,'project-a');
    await f.click('切换查看工程');const card=[...f.d.querySelectorAll('article')].find(c=>c.textContent.includes('工程 B'));card.querySelector('button').click();await waitFor(()=>f.d.querySelector('[data-resource="hmi"]'));
    f.d.querySelector('[data-resource="hmi"]').click();await wait();assert.match(f.d.querySelector('[aria-label="资源详情"]').textContent,/B\/hmi.exe/);assert.equal(f.d.querySelector('[aria-label="资源详情"] .pd-resource-delivery'),null,'a standalone HMI executable has no verified editing source or delivery relation');await f.click('关闭资源详情');
    assert.equal(f.button('打开运行画面').disabled,false);await f.click('打开运行画面');const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[1].body.action,'show-hmi');assert.equal(posts[1].body.projectId,'project-b');assert.equal(posts.some(r=>['start','runtime-start','runtime-stop','end'].includes(r.body.action)),false);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

