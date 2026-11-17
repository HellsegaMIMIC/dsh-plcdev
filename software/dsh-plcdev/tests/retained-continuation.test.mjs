import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectSessionActions,prepareRetainedDraft} from '../src/client/conversation-flow.mjs';
import {fileURLToPath} from 'node:url';
import {packages,buildTools} from './dependencies.mjs';
const sourceProjectId='user-'+'a'.repeat(32),keptProjectId='user-'+'b'.repeat(32),taskId='task-'+'c'.repeat(32),revision='d'.repeat(64),candidateDigest='e'.repeat(64);
const request={sourceSessionId:'source-chat',sourceProjectId,keptProjectId,taskId,revision,candidateDigest};
function fixture(){
 const calls=[],drafts={'source-chat':'原会话未发出的需求'},bindings={'source-chat':{conversationId:'source-chat',projectId:sourceProjectId,version:1,taskRefs:[{projectId:sourceProjectId,taskId}],pendingRequests:[]}};
 const task={projectId:sourceProjectId,taskId,status:'compile_failed',workflow:'project-edit-v1',candidate:{candidateDigest},retention:{keptProjectId,revision},compilation:{sourceRevision:revision,status:'compile_failed',diagnostic:'main.st:8 Unknown variable Counter'}};
 const current={projectId:keptProjectId,projectRevision:revision,tasks:[]};
 const row={workspaceId:'copy-workspace',path:'C:/Projects/Copy',title:'修改副本',sessionIds:[]},rows={'source-chat':{}},draftListeners=new Set();
 const sessions={refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',ids:Object.keys(rows),byId:rows})},create:async options=>{calls.push(['create',options]);rows['new-chat']={};row.sessionIds.push('new-chat');bindings['new-chat']={conversationId:'new-chat',projectId:null,version:0,taskRefs:[],pendingRequests:[]};return 'new-chat';},retain(id){calls.push(['retain',id]);return {ready:Promise.resolve({sessionId:id,ctx:{sessionId:id}}),release(){calls.push(['release',id]);}};}};
 const workspaces={create:async value=>{calls.push(['workspace-create',value]);return row;},list:{getSnapshot:()=>({phase:'ready',items:[row],archivedSessionIds:[]}),subscribe:()=>()=>{}}};
 const workspace={openSession(){}},conversation={input:{requestDraftInitialization(binding,value){calls.push(['draft',binding.sessionId,value]);drafts[binding.sessionId]=value.prompt;draftListeners.forEach(fn=>fn());return 'applied';},for(ctx){return {state:{getSnapshot:()=>({draft:drafts[ctx.sessionId]}),subscribe:fn=>{draftListeners.add(fn);return()=>draftListeners.delete(fn);}}};}}};
 const api=async(path,body)=>{
  calls.push(['api',path,body]);
  if(path==='conversations/bind'){const b=bindings[body.conversationId];assert.equal(body.expectedVersion,b.version);return bindings[body.conversationId]={...b,projectId:body.projectId,version:b.version+1};}
  if(path.startsWith('conversations?'))return bindings[new URL('http://host/'+path).searchParams.get('conversationId')];
  if(path==='tasks?project='+sourceProjectId)return {projectId:sourceProjectId,projectRevision:'f'.repeat(64),tasks:[task]};
  if(path==='tasks?project='+keptProjectId)return current;
  if(path==='status?project='+keptProjectId){const project={id:keptProjectId,name:'修改副本',kind:'user',projectRoot:row.path,manifestPath:row.path+'/project.plcdev'};return {project,projects:[project]};}
  throw Error('Unexpected API '+path);
 };
 const actions=createProjectSessionActions({services:()=>({sessions,workspace,workspaces,conversation}),api,openSession:async target=>{calls.push(['open',target]);return {ok:true};},timeout:50});
 return {calls,drafts,bindings,task,current,sessions,api,actions};
}
test('compile failure continuation creates and binds only the kept copy and verifies an unsent diagnostic draft',async()=>{
 const f=fixture(),result=await f.actions.createFromRetained(request,{projectId:keptProjectId,view:'resources'});
 assert.equal(result.ok,true);assert.equal(result.draftVerified,true);assert.equal(f.bindings['new-chat'].projectId,keptProjectId);assert.equal(f.bindings['source-chat'].projectId,sourceProjectId);assert.equal(f.bindings['source-chat'].version,1);assert.equal(f.drafts['source-chat'],'原会话未发出的需求');
 assert.match(f.drafts['new-chat'],/main.st:8 Unknown variable Counter/);assert.match(f.drafts['new-chat'],new RegExp(keptProjectId));assert.match(f.drafts['new-chat'],/保留此前已有修改/);
 assert.deepEqual(f.calls.find(row=>row[0]==='create')[1],{workspaceId:'copy-workspace'});assert.equal(f.calls.filter(row=>row[0]==='draft').length,1);assert.equal(f.calls.filter(row=>row[1]==='conversations/bind').length,1);
});
test('foreign, changed or no longer kept candidate cannot create a new session',async()=>{
 for(const invalidate of [f=>f.bindings['source-chat'].taskRefs=[],f=>f.current.projectRevision='0'.repeat(64),f=>f.task.status='compiling',f=>f.task.retention.keptProjectId=sourceProjectId]){
  const f=fixture();invalidate(f);const result=await f.actions.createFromRetained(request);assert.equal(result.ok,false);assert.equal(f.calls.some(row=>row[0]==='create'||row[0]==='draft'),false);
 }
});
test('a changed compile result during retained draft preparation cannot inject stale diagnostics',async()=>{
 const f=fixture(),retain=f.sessions.retain;f.sessions.retain=id=>{f.task.status='compiled';return retain(id);};
 const result=await f.actions.createFromRetained(request);assert.equal(result.ok,false);assert.match(result.message,/编译状态已变化/);assert.equal(f.calls.filter(row=>row[0]==='create').length,1);assert.equal(f.calls.some(row=>row[0]==='draft'),false);assert.equal(f.calls.at(-1)[0],'release');
});
test('successful copy continuation asks for the next requirement and excludes stale diagnostics',async()=>{
 const f=fixture();f.task.status='compiled';f.task.compilation.sourceRevision='0'.repeat(64);
 const result=await prepareRetainedDraft(f.api,request,keptProjectId);assert.match(result.prompt,/我的下一步修改需求/);assert.doesNotMatch(result.prompt,/Unknown variable/);assert.equal(f.calls.some(row=>row[0]==='create'),false);
});
test('review exposes the retained-copy continuation with exact source ownership and duplicate-click protection',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),component=fileURLToPath(new URL('../src/client/Conversation.tsx',import.meta.url)).replaceAll('\\','/');
 const built=await buildTools.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationReview} from '${component}';const root=createRoot(document.getElementById('root'));root.render(<ConversationReview sessionId="source-chat" target={window.target} onContinueRetained={window.continueRetained}/>);window.cleanup=()=>root.unmount();`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',alias:{react:packages.resolve('react'),'react-dom/client':packages.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
 const {JSDOM,VirtualConsole}=packages('jsdom'),f=fixture(),calls=[],errors=[];let release;
 const vc=new VirtualConsole();vc.on('jsdomError',error=>{if(!error.message.includes('CSS'))errors.push(error.message);});
 const dom=new JSDOM('<div id="root"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>',{url:'http://127.0.0.1:55110',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.target={projectId:sourceProjectId,taskId};w.continueRetained=value=>{calls.push(value);return new Promise(resolve=>release=resolve);};
  w.fetch=async(url,options)=>{assert.equal(options.method,'GET');const route=url.replace('/api/plcdev/','');return {ok:true,json:async()=>route.startsWith('status?')?{project:{id:sourceProjectId,name:'原工程'},projects:[{id:sourceProjectId}]}:f.api(route)};};
 }});
 const button=()=>[...dom.window.document.querySelectorAll('button')].find(node=>node.textContent==='基于修改副本继续修改'),wait=()=>new Promise(resolve=>setTimeout(resolve,25));
 try{for(let i=0;i<80&&!button();i++)await wait();assert.ok(button());assert.equal(button().disabled,false);button().click();button().click();await wait();assert.equal(calls.length,1);assert.equal(button().disabled,true);assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),request);release({ok:false,message:'副本状态变化，未创建新会话。'});await wait();assert.match(dom.window.document.querySelector('#root').textContent,/副本状态变化/);assert.equal(button().disabled,false);assert.deepEqual(errors,[]);}
 finally{dom.window.cleanup();dom.window.close();}
});
