import test from 'node:test';
import assert from 'node:assert/strict';
import {projectResourceState} from '../src/client/project-resource-state.mjs';

const projectId='user-'+'a'.repeat(32),otherProject='user-'+'b'.repeat(32),sessionId='chat-a';
const revision='a'.repeat(64),digest='b'.repeat(64);
const taskId=index=>'task-'+String(index).padStart(32,'0');
const change=(path,before=revision,after=digest)=>({path,beforeSha256:before,afterSha256:after});
const proposal=(index,changes,extra={})=>({projectId,taskId:taskId(index),workflow:'project-edit-v1',status:'awaiting_review',projectRevision:revision,request:'修改 '+index,candidate:{candidateDigest:digest,changes},...extra});
const snapshot={project:{id:projectId,plc:'plc/project.json',defaultMode:'fuxa-local'},capabilities:{tools:{plc:true,fuxa:false,oip:false}}};
function input(taskList=[],extra={}){return {projectId,sessionId,snapshot,binding:{conversationId:sessionId,projectId,version:1,taskRefs:taskList.map(task=>({projectId,taskId:task.taskId})),pendingRequests:[]},tasks:{projectId,projectRevision:revision,tasks:taskList},...extra};}

test('new HMI and OIP appear as pending resources alongside saved PLC without borrowing saved capability',()=>{
  const task=proposal(1,[change('plc/pous/programs/main.st'),change('integration/r1/hmi/main.fuxap',null),change('integration/r1/simulation/oip/project.json',null),change('project.plcdev')]);
  const value=projectResourceState(input([task]));
  assert.deepEqual(value.saved.map(row=>row.tool),['plc']);
  assert.deepEqual(value.pending.map(row=>[row.tool,row.kind,row.label,row.disabledReason]),[
    ['openplc','modified','本轮修改 · 待保留',''],['fuxa','added','本轮新增 · 待保留',''],['oip','added','本轮新增 · 待保留',''],
  ]);
  assert.equal(value.pending[1].task,task);
  assert.equal(value.pending.some(row=>row.tool==='project'),false);
});

test('a new POU, HMI asset or OIP part modifies an existing tool rather than adding another tool',()=>{
  const existing={...snapshot,project:{...snapshot.project,hmi:'hmi/main.fuxap',scene:'oip/project.json'}};
  const task=proposal(1,[change('plc/pous/functions/Scale.st',null),change('hmi/images/new.svg',null),change('oip/parts/new.json',null)]);
  const value=projectResourceState(input([task],{snapshot:existing}));
  assert.deepEqual(value.saved.map(row=>row.tool),['plc','fuxa','oip']);
  assert.deepEqual(value.pending.map(row=>row.kind),['modified','modified','modified']);
});

test('independent pending tasks stay separate and retain exact task identity',()=>{
  const first=proposal(1,[change('hmi/main.fuxap',null)]),second=proposal(2,[change('hmi/main.fuxap',null)]);
  const value=projectResourceState(input([second,first]));
  assert.deepEqual(value.pending.map(row=>row.task.taskId),[second.taskId,first.taskId]);
  assert.equal(new Set(value.pending.map(row=>row.key)).size,2);
  assert.deepEqual(value.pending.map(row=>row.taskLabel),['修改 2','修改 1']);
});

test('keep, undo, supersede and no-change never leave pending resource rows',()=>{
  const task=proposal(1,[change('hmi/main.fuxap',null)]);
  for(const status of ['kept','compiled','compile_failed','discarded','superseded','no_change','keeping','discarding','unknown_outcome']){
    assert.deepEqual(projectResourceState(input([{...task,status}])).pending,[],status);
  }
  assert.deepEqual(projectResourceState(input([{...task,supersededBy:taskId(2)}])).pending,[]);
  const saved={...snapshot,project:{...snapshot.project,hmi:'hmi/main.fuxap'}};
  const kept=projectResourceState(input([{...task,status:'kept'}],{snapshot:saved}));
  assert.deepEqual(kept.saved.map(row=>row.tool),['plc','fuxa']);assert.deepEqual(kept.pending,[]);
  assert.deepEqual(projectResourceState(input([{...task,status:'discarded'}])).saved.map(row=>row.tool),['plc']);
});

test('candidate version mismatch remains visible but explicitly cannot be opened',()=>{
  const task=proposal(1,[change('hmi/main.fuxap',null)]);
  const value=projectResourceState(input([task],{tasks:{projectId,projectRevision:'c'.repeat(64),tasks:[task]}}));
  assert.equal(value.pending.length,1);assert.match(value.pending[0].disabledReason,/旧版本/);
  for(const state of [input([task],{tasks:{projectId,tasks:[task]}}),input([{...task,projectRevision:'bad'}])]){
    const row=projectResourceState(state).pending[0];assert.ok(row);assert.match(row.disabledReason,/尚未核对/);
  }
});

test('only exact conversation binding and its own task references may project pending resources',()=>{
  const first=proposal(1,[change('hmi/main.fuxap',null)]),other=proposal(2,[change('oip/project.json',null)]);
  const args=input([first,other]);args.binding.taskRefs=[{projectId,taskId:first.taskId}];
  assert.deepEqual(projectResourceState(args).pending.map(row=>row.tool),['fuxa']);
  const wrongSession=projectResourceState({...args,binding:{...args.binding,conversationId:'chat-other'}});
  assert.deepEqual(wrongSession.pending,[]);assert.match(wrongSession.error,/归属/);
  const otherBound=projectResourceState({...args,binding:{...args.binding,projectId:otherProject}});
  assert.deepEqual(otherBound.pending,[]);assert.deepEqual(otherBound.saved.map(row=>row.tool),['plc']);
  const wrongRef=projectResourceState({...args,binding:{...args.binding,taskRefs:[{projectId:otherProject,taskId:first.taskId}]}});
  assert.deepEqual(wrongRef.pending,[]);
});

test('cross-project responses and malformed candidate identity never produce a candidate open target',()=>{
  const task=proposal(1,[change('hmi/main.fuxap',null)]);
  for(const args of [input([task],{snapshot:{project:{id:otherProject}}}),input([task],{tasks:{projectId:otherProject,projectRevision:revision,tasks:[task]}}),input([task],{tasks:{projectId,projectRevision:revision,tasks:[{...task,projectId:otherProject}]}})]){
    const value=projectResourceState(args);assert.deepEqual(value.pending,[]);assert.ok(value.error);
  }
  for(const candidate of [{candidateDigest:'invalid',changes:task.candidate.changes},null]){
    const value=projectResourceState(input([{...task,candidate}]));assert.deepEqual(value.pending,[]);assert.match(value.error,/身份/);
  }
  const duplicate=projectResourceState(input([task,{...task,candidate:{...task.candidate,candidateDigest:'c'.repeat(64)}}]));
  assert.deepEqual(duplicate.pending,[]);assert.match(duplicate.error,/重复/);
});

test('only deletion of the saved resource entry removes a tool; ordinary file deletions remain modifications',()=>{
  const saved={...snapshot,project:{...snapshot.project,hmi:'hmi/main.fuxap',scene:'oip/project.json'}};
  const removed=projectResourceState(input([proposal(1,[change('hmi/main.fuxap',revision,null),change('oip/project.json',revision,null),change('plc/pous/programs/extra.st',revision,null)])],{snapshot:saved}));
  assert.deepEqual(removed.pending.map(row=>[row.tool,row.kind]),[['openplc','modified'],['fuxa','removed'],['oip','removed']]);
  assert.ok(removed.pending.filter(row=>row.kind==='removed').every(row=>row.disabledReason.includes('已移除')));
});

test('missing snapshots keep candidate evidence visible but not actionable',()=>{
  const value=projectResourceState(input([proposal(1,[change('hmi/main.fuxap',null)])],{snapshot:null}));
  assert.equal(value.pending.length,1);assert.deepEqual(value.saved,[]);assert.match(value.pending[0].disabledReason,/已保存资源尚未读取/);
});

test('old team analysis and unowned historical data do not invent resources from prose',()=>{
  const analysis=proposal(1,[],{workflow:'team-analysis-v1',candidate:{candidateDigest:digest,components:[{tool:'oip',summary:'应该新建场景'}]}});
  const empty=proposal(2,[]);
  const value=projectResourceState(input([analysis,empty]));assert.deepEqual(value.pending,[]);
});

test('a bound project with no owned task references needs no task request or pending error',()=>{
  const empty=projectResourceState(input([],{tasks:null}));
  assert.deepEqual(empty.pending,[]);assert.equal(empty.error,undefined);
  assert.deepEqual(empty.saved.map(row=>row.tool),['plc']);
  const foreignOnly=input([],{tasks:null});foreignOnly.binding.taskRefs=[{projectId:otherProject,taskId:taskId(8)}];
  assert.equal(projectResourceState(foreignOnly).error,undefined);
});
