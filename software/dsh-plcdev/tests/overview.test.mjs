import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewLinks,overviewResources,monitoredVariables,overviewConnection} from '../src/client/overview-model.mjs';

const local = {project:{id:'A',plc:'A/plc/project.json',target:'local'},links:{load:{state:'unloaded'}}};
test('resource menus include real project assets only; no invented HMI or scene',()=>{
  assert.equal(overviewResources(null,null).flatMap(g=>g.items).length,0);
  const groups=overviewResources(local,null);
  assert.deepEqual(groups.map(g=>[g.id,g.items.length]),[['plc',1],['hmi',0],['scene',0],['bindings',0],['tasks',0]]);
  assert.equal(groups[0].items[0].path,'A/plc/project.json');
  assert.deepEqual(overviewLinks(local).map(l=>l.nodes),[['plc','runtime']]);
});
test('unassociated scene cannot produce a topology connection, even if stale link metadata exists',()=>{
  assert.equal(overviewLinks({...local,links:{...local.links,io:{details:{protocol:'Modbus TCP'}}}}).some(x=>x.key==='io'),false);
});
test('candidate resource menu rejects different-project response and individual foreign tasks',()=>{
  assert.equal(overviewResources(local,{projectId:'B',tasks:[{projectId:'B',taskId:'b'}]})[4].items.length,0);
  const tasks=overviewResources(local,{projectId:'A',tasks:[{projectId:'B',taskId:'b'},{projectId:'A',taskId:'a',request:'改名'}]})[4].items;
  assert.deepEqual(tasks.map(t=>t.taskId),['a']);
});
test('variables expire between status polls and retain no stale values while disconnected',()=>{
  const s={session:{active:true},observerFresh:true,state:{observedAt:10,runtimeState:'RUNNING',dataQuality:'live',telemetryFresh:true,variables:[{path:'INSTANCE0.Count',type:'INT',value:3}]}};
  assert.equal(monitoredVariables(s,true,11000)[0].value,'3');
  assert.equal(monitoredVariables(s,true,13000)[0].value,'—');
  assert.equal(monitoredVariables(s,false,11000)[0].value,'—');
  assert.equal(monitoredVariables({...s,session:{active:false}},true,11000)[0].value,'—');
  assert.equal(monitoredVariables({...s,state:{...s.state,telemetryFresh:false}},true,11000)[0].value,'—');
  assert.equal(monitoredVariables({...s,state:{...s.state,runtimeState:'STOPPED',dataQuality:'historical'}},true,11000)[0].quality,'停止时采样');
});
test('unknown links remain unknown and runtime wording uses instance terminology',()=>{
  assert.equal(overviewConnection(local,'variables',false).label,'状态未知');
  assert.equal(overviewConnection(local,'variables',true).label,'无运行实例');
});

test('one FUXA file remains one HMI resource with editor and runtime instance references',()=>{
  const s={project:{id:'A',plc:'A/plc/project.json',target:'local',defaultMode:'fuxa-oip',configuration:{hmiFile:'A/main.fuxap',sceneFile:'A/scene.json'}}};
  const items=overviewResources(s,null).find(g=>g.id==='hmi').items;
  assert.equal(items.length,1);assert.equal(items[0].id,'designer');assert.deepEqual(items[0].nodes,['designer','hmi']);assert.equal(items[0].title,'main.fuxap');
});