import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const source=resolve(root,'software/dsh-plcdev/src/client').replaceAll('\\','/');
const projectId='user-'+'a'.repeat(32),sessionId='chat-sidebar',revision='d'.repeat(64);
const taskId='task-'+'b'.repeat(32),digest='c'.repeat(64);
const response=value=>({ok:true,status:200,json:async()=>value});
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check,message='UI did not settle'){
 for(let n=0;n<150;n++){if(check())return;await tick();}assert.ok(check(),message);
}
let compiled;
async function fixture({pending=false,mirror=false}={}){
 if(!compiled)compiled=(await buildTools.build({stdin:{contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {ProjectPane} from '${source}/ProjectPane.tsx';import {RuntimePane} from '${source}/RuntimePane.tsx';
  import {createConversationContexts} from '${source}/conversation-context.mjs';
  import {createProjectContexts} from '${source}/project-context.mjs';import {taskReadsFor} from '${source}/task-reads.mjs';
  const contexts=createConversationContexts(),projectContexts=createProjectContexts(),app=createRoot(document.getElementById('root'));
  window.refreshProject=()=>projectContexts.get('${projectId}').refresh();
  const navigate=(...args)=>window.navigations.push(args);
  app.render(<><div id="sidebar" style={{width:340}}><ProjectPane sessionId="${sessionId}" contexts={contexts} projectContexts={projectContexts}
   useTabInfo={()=>({tab:{navigation:{params:{projectId:'${projectId}'}}}})} onProject={navigate} onRetainedProject={navigate} onOpenRuntime={navigate}/></div>
   {window.mirror&&<div id="workspace"><RuntimePane projectId="${projectId}" projectContexts={projectContexts} onProject={navigate} sessionId={null} projectRevision="${revision}"/></div>}</>);
  window.cleanup=()=>{app.unmount();contexts.dispose();projectContexts.dispose();taskReadsFor(contexts).dispose();};
 `,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',target:'es2022',alias:{react:packages.resolve('react')},define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const {JSDOM,VirtualConsole}=packages('jsdom'),errors=[],posts=[],reads=[];
 const state={active:false,instance:null,runtimeState:'STOPPED',phase:'idle',value:3,revision,failStatus:false,
  capabilities:{canPrepare:true,canRun:false,canStop:false,canEnd:false,canShowHmi:true,tools:{plc:true,fuxa:true,oip:true},reasons:{oipRuntime:'OIP 场景编辑可用；通用 OIP 与 PLC 联动运行尚未接通。'}},onAction:null};
 const console=new VirtualConsole();console.on('jsdomError',error=>{
  // jsdom 22 has no container-query parser or layout engine. Geometry is checked
  // separately in a real browser; genuine script/React errors must still fail.
  if(error.type==='css parsing'&&String(error.detail).includes('@container'))return;
  errors.push(error.message);
 });
 // Current status omits the saved revision; task and event responses provide it.
 const snapshot=()=>({project:{id:projectId,name:'侧栏联调工程',plc:'plc/project.json',hmi:'hmi/main.fuxap',scene:'oip/project.json',sceneProvider:'oip',defaultMode:'fuxa-local'},
  projects:[{id:projectId,name:'侧栏联调工程'}],phase:state.phase,
  session:{id:state.instance,active:state.active,programHash:state.active?'saved-program-hash':null},runtimeOwner:state.instance?{projectId,sessionId:state.instance}:null,
  observerFresh:state.active,state:{observedAt:Date.now()/1000,runtimeState:state.runtimeState,telemetryFresh:state.active,dataQuality:'live',variables:[{path:'TrialCount',type:'INT',value:state.value}]},
  links:{load:{state:state.active?'current':'inactive',label:'当前已保存的 PLC 程序'},variables:{source:'hmi',state:'inactive'},io:{state:'inactive'}},capabilities:structuredClone(state.capabilities)});
 const tasks=pending?[{projectId,taskId,request:'本轮待保留修改',workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,
  candidate:{candidateDigest:digest,components:[{tool:'openplc',summary:'修改主程序'}],changes:[{path:'plc/pous/programs/main.st',beforeSha256:revision,afterSha256:digest}]}}]:[];
 const dom=new JSDOM(`<div id="root"></div><script>${compiled.replaceAll('</script','<\\/script')}</script>`,{url:'http://127.0.0.1:55119',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
  w.mirror=mirror;w.navigations=[];w.fetch=async(url,options={})=>{
   const u=new URL(url,'http://127.0.0.1:55119');reads.push(u.pathname+u.search);
   if(u.pathname.endsWith('/conversations'))return response({conversationId:sessionId,projectId,version:1,taskRefs:tasks.map(({projectId,taskId})=>({projectId,taskId})),pendingRequests:[]});
   if(u.pathname.endsWith('/status')){if(state.failStatus&&u.searchParams.has('project'))throw Error('状态连接中断');return response(snapshot());}
   if(u.pathname.endsWith('/task-state')||u.pathname.endsWith('/task-records'))return response({projectId,projectRevision:state.revision,tasks});
   if(u.pathname.endsWith('/tool-environment'))return response({ok:true,schemaVersion:1,configPath:'F:/fixture/environment.json',checkedAt:new Date().toISOString(),
    tools:[{id:'openplc',key:'editor',state:'found'},{id:'fuxa',key:'fuxaPackage',state:'found'},{id:'oip',key:'oipExecutable',state:'found'}]});
   if(u.pathname.endsWith('/runtime-events'))return response({schemaVersion:1,projectId,projectRevision:state.revision,observedAt:Date.now()/1000,currentSessionId:state.instance,sources:[],
    events:[{id:'compile-check',source:'compiler',severity:'info',status:'recorded',phase:'编译',summary:'当前保存版本检查',count:1,firstAt:1,lastAt:1,projectRevision:state.revision}]});
   if(u.pathname.endsWith('/action')){const body=JSON.parse(options.body);posts.push({path:u.pathname,body});if(state.onAction)await state.onAction(body);return response({ok:true});}
   throw Error('Unexpected endpoint '+u.pathname);
  };
 }});
 const d=dom.window.document,sidebar=()=>d.querySelector('#sidebar'),button=(label,within=sidebar())=>[...(within?.querySelectorAll('button')||[])].find(b=>b.textContent===label);
 try{await until(()=>button('编译并准备')&&!button('编译并准备').disabled);
  await until(()=>d.querySelector('[data-resource-state="saved"]'));
 }catch(error){dom.window.cleanup?.();dom.window.close();throw error;}
 return {dom,d,state,posts,reads,errors,sidebar,button,snapshot,
  async refresh(){await dom.window.refreshProject();await tick();},
  async settle(){await tick();await tick();},
  close(){dom.window.cleanup();dom.window.close();}};
}

test('sidebar shows direct runtime controls on entry and tab navigation sends no commands',async()=>{
 const f=await fixture();try{
  for(const label of ['编译并准备','运行 PLC','停止 PLC','结束运行实例']){
   assert.ok(f.button(label));assert.equal(f.button(label).closest('[hidden]'),null,`${label} must be available without opening a full workspace`);
  }
  assert.equal(f.button('工程资源').getAttribute('aria-pressed'),'true');
  assert.equal(f.d.querySelector('[data-runtime-content]').hidden,true);
  f.button('运行与监视').click();await f.settle();assert.equal(f.d.querySelector('[data-runtime-content]').hidden,false);
  assert.ok(f.button('打开运行画面'));assert.ok(f.button('打开仿真场景'));assert.match(f.d.querySelector('[aria-label="联调工具"]').textContent,/通用 OIP 与 PLC 联动运行尚未接通/);
  f.button('工程资源').click();await f.settle();assert.equal(f.d.querySelector('[data-runtime-content]').hidden,true);
  assert.equal(f.posts.length,0);assert.equal(f.dom.window.navigations.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('compile uses the saved project and current runtime identity and reveals inline events instead of navigation',async()=>{
 const f=await fixture({pending:true});try{
  await until(()=>f.d.querySelector('[data-resource-state="pending"]'));
  f.state.instance='stopped-saved-instance';await f.refresh();
  f.state.onAction=body=>{assert.equal(body.action,'start');f.state.phase='building';f.state.capabilities.canPrepare=false;};
  f.button('编译并准备').click();await until(()=>f.posts.length===1);await f.settle();
  const request=f.posts[0];assert.equal(request.path,'/api/plcdev/action');assert.equal(request.body.projectId,projectId);assert.equal(request.body.sessionId,'stopped-saved-instance');
  assert.equal(request.body.taskId,undefined);assert.equal(request.body.candidateDigest,undefined);assert.equal(request.body.action,'start');
  assert.equal(f.button('运行与监视').getAttribute('aria-pressed'),'true');assert.equal(f.d.querySelector('[data-tab="events"]').getAttribute('aria-pressed'),'true');
  assert.equal(f.d.querySelector('.pc-events-wrap').hidden,false);assert.equal(f.d.querySelector('[data-runtime-content]').hidden,false);
  assert.match(f.sidebar().textContent,/编译使用已保存版本/);assert.ok(f.d.querySelector('[data-resource-state="pending"]'),'pending resource remains available for review');
  assert.equal(f.dom.window.navigations.length,0);assert.equal(f.posts.length,1);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('sidebar and full runtime page observe the same controller transitions and samples',async()=>{
 const f=await fixture({mirror:true});try{
  const workspace=f.d.querySelector('#workspace');assert.equal(f.button('编译并准备',workspace).disabled,false);
  f.state.active=true;f.state.instance='run-saved';f.state.phase='ready';f.state.runtimeState='RUNNING';f.state.value=37;
  f.state.capabilities={...f.state.capabilities,canPrepare:false,canRun:false,canStop:true,canEnd:true};await f.refresh();
  await until(()=>[...f.d.querySelectorAll('.pc-runtime-state')].every(n=>n.textContent==='运行中'));
  assert.equal(f.button('停止 PLC').disabled,false);assert.equal(f.button('停止 PLC',workspace).disabled,false);
  assert.equal(f.d.querySelector('#sidebar tbody td:nth-child(3)').textContent,'37');assert.equal(workspace.querySelector('tbody td:nth-child(3)').textContent,'37');
  f.state.onAction=body=>{assert.equal(body.action,'runtime-stop');f.state.runtimeState='STOPPED';f.state.capabilities.canStop=false;f.state.capabilities.canRun=true;};
  f.button('停止 PLC',workspace).click();await until(()=>f.posts.length===1&&f.button('运行 PLC').disabled===false);
  assert.equal(f.button('运行 PLC',workspace).disabled,false);assert.equal(f.button('停止 PLC').disabled,true);
  assert.equal(f.posts[0].body.projectId,projectId);assert.equal(f.posts[0].body.sessionId,'run-saved');assert.equal(f.posts.length,1);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('joint-tool entries use explicit HMI and OIP actions and cannot implicitly run either target',async()=>{
 const f=await fixture();try{
  f.button('运行与监视').click();await f.settle();f.button('打开运行画面').click();await until(()=>f.posts.length===1);await until(()=>!f.button('打开仿真场景').disabled);
  f.button('打开仿真场景').click();await until(()=>f.posts.length===2);await f.settle();
  assert.deepEqual(f.posts.map(({path,body})=>({path,projectId:body.projectId,sessionId:body.sessionId,action:body.action,tool:body.tool})),[
   {path:'/api/plcdev/action',projectId,sessionId:null,action:'open-hmi',tool:undefined},
   {path:'/api/plcdev/action',projectId,sessionId:null,action:'tool',tool:'oip'}]);
  assert.equal(f.dom.window.navigations.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('compact section keeps event filters and relation disclosure across resource navigation and disables unknown state',async()=>{
 const f=await fixture();try{
  f.button('运行与监视').click();await f.settle();f.d.querySelector('[data-tab="events"]').click();await f.settle();
  const select=f.d.querySelector('[aria-label="事件来源"]');select.value='oip';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
  const relation=f.d.querySelector('.pc-runtime-relation-toggle');relation.open=true;relation.dispatchEvent(new f.dom.window.Event('toggle'));await f.settle();
  const rows=[...f.d.querySelectorAll('[data-resource-state="saved"]')];f.button('工程资源').click();await f.settle();f.button('运行与监视').click();await f.settle();
  assert.equal(f.d.querySelector('[aria-label="事件来源"]'),select);assert.equal(select.value,'oip');assert.equal(relation.open,true);
  assert.equal(f.d.querySelector('[data-tab="events"]').getAttribute('aria-pressed'),'true');assert.deepEqual([...f.d.querySelectorAll('[data-resource-state="saved"]')],rows);
  f.state.capabilities.canShowHmi=false;f.state.capabilities.reasons.canShowHmi='画面版本待核对';await f.refresh();
  assert.equal(f.button('打开运行画面').disabled,true);assert.equal(f.button('打开运行画面').title,'画面版本待核对');f.button('打开运行画面').click();assert.equal(f.posts.length,0);
  f.state.failStatus=true;await f.refresh();assert.equal(f.button('编译并准备').disabled,true);assert.equal(f.button('运行 PLC').disabled,true);assert.equal(f.button('停止 PLC').disabled,true);
  f.button('编译并准备').click();assert.equal(f.posts.length,0);assert.match(f.d.querySelector('.pc-runtime-state').textContent,/无法确认/);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('missing compile dependencies have a visible reason and an installation entry without leaving the sidebar',async()=>{
 const f=await fixture();try{
  f.state.capabilities.canPrepare=false;
  f.state.capabilities.reasons.canPrepare='缺少依赖：OpenPLC Runtime、PLC 编译环境';await f.refresh();
  const entry=f.button('检查运行环境');assert.ok(entry);assert.equal(entry.closest('[hidden]'),null);
  assert.match(entry.closest('.pc-runtime-notice').textContent,/缺少依赖：OpenPLC Runtime、PLC 编译环境/);
  assert.equal(f.button('编译并准备').disabled,true);f.button('编译并准备').click();assert.equal(f.posts.length,0);
  entry.click();await until(()=>f.d.querySelector('[role="dialog"]'));
  assert.match(f.d.querySelector('[role="dialog"]').textContent,/工具下载与安装/);
  f.d.querySelector('[aria-label="关闭工具下载"]').click();await until(()=>!f.d.querySelector('[role="dialog"]'));
  assert.equal(f.button('工程资源').getAttribute('aria-pressed'),'true');assert.equal(f.dom.window.navigations.length,0);
  assert.equal(f.posts.length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
