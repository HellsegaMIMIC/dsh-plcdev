import test from 'node:test';
import assert from 'node:assert/strict';
import { projectIdentity, revisionBasis, reviewStages, stageLabel, artifactRows } from '../src/client/conversation-client.mjs';

const source='user-'+'a'.repeat(32), kept='user-'+'b'.repeat(32), revision='c'.repeat(64);
test('real keep receipt uses keptProjectId, never its source projectId as the new identity',()=>{
  const result=reviewStages({projectId:source,status:'compiled',candidate:{validation:'joint-native-structure-and-bindings'},retention:{projectId:source,keptProjectId:kept},compilation:{status:'compiled',runtimeStarted:false}});
  assert.equal(result.retainedProjectId,kept);assert.equal(result.retention,'kept');
  assert.equal(result.validation,'recorded');assert.equal(result.compilation,'passed');
  assert.equal(result.runtime,'untested');assert.match(stageLabel('runtime',result.runtime),/无运行验收/);
  assert.equal(reviewStages({projectId:source,status:'kept',retention:{projectId:source}}).retention,'unknown');
});
test('unknown and in-flight recompilation cannot borrow success from an earlier receipt',()=>{
  for(const [status,expected]of [['compiling','running'],['unknown_outcome','unknown'],['conflict','conflict'],['compile_failed','failed']]){
    const stage=reviewStages({status,compilation:{status:'compiled'}});
    assert.equal(stage.compilation,expected);assert.equal(stage.historicalCompilation,true);
  }
  for(const [status,expected]of [['pending','running'],['failed','failed'],['unexpected','unknown']])assert.equal(reviewStages({status:'awaiting_review',compilation:{status}}).compilation,expected);
  assert.equal(reviewStages({status:'queued'}).compilation,'untested');
  assert.equal(reviewStages({status:'discarded'}).retention,'discarded');
});
test('project name and version metadata are accepted only for the exact target',()=>{
  assert.equal(projectIdentity({project:{id:kept,name:'Other'}},source),null);
  assert.deepEqual(projectIdentity({project:{id:source},projects:[{id:kept,name:'Other'}]},source),{id:source,name:null});
  assert.equal(projectIdentity({project:{id:source,name:'Source'}},source).name,'Source');
  assert.equal(revisionBasis(revision,'d'.repeat(64)).same,false);
  assert.equal(revisionBasis(revision,revision).same,true);
  assert.equal(revisionBasis(revision,undefined).same,null);
  assert.equal(artifactRows({candidate:{components:[{tool:'fuxa',summary:'Actual screen',widgets:31}]}})[1].widgets,31);
  assert.equal(artifactRows({candidate:{components:[]}})[0].component,null);
});
