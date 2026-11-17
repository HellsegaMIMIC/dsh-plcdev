import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewLinks,overviewResources,monitoredVariables} from '../src/client/overview-model.mjs';

const local = {project:{id:'A',plc:'A/plc/project.json',target:'local'},links:{load:{state:'unloaded'}}};
test('resource menus include real project assets only; no invented HMI or scene',()=>{
  assert.equal(overviewResources(null,null).flatMap(g=>g.items).length,0);
  const groups=overviewResources(local,null);
  assert.deepEqual(groups.map(g=>[g.id,g.items.length]),[['plc',1],['hmi',0],['scene',0],['bindings',0]]);
  assert.equal(groups[0].items[0].path,'A/plc/project.json');
  assert.deepEqual(overviewLinks(local).map(l=>l.nodes),[['plc','runtime']]);
});
test('unassociated scene cannot produce a topology connection, even if stale link metadata exists',()=>{
  assert.equal(overviewLinks({...local,links:{...local.links,io:{details:{protocol:'Modbus TCP'}}}}).some(x=>x.key==='io'),false);
});
test('project resources never mix in candidate records, including foreign tasks',()=>{
  const groups=overviewResources(local,{projectId:'A',tasks:[{projectId:'B',taskId:'b'},{projectId:'A',taskId:'a',request:'改名'}]});
  assert.equal(groups.some(g=>g.id==='tasks'),false);
  assert.equal(groups.flatMap(g=>g.items).some(item=>item.taskId),false);
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
test('one FUXA file remains one HMI resource with editor and runtime instance references',()=>{
  const s={project:{id:'A',plc:'A/plc/project.json',target:'local',defaultMode:'fuxa-oip',configuration:{hmiFile:'A/main.fuxap',sceneFile:'A/scene.json'}}};
  const items=overviewResources(s,null).find(g=>g.id==='hmi').items;
  assert.equal(items.length,1);assert.equal(items[0].id,'designer');assert.deepEqual(items[0].nodes,['designer','hmi']);assert.equal(items[0].title,'main.fuxap');
});
test('ordinary local projects expose their exact associated OIP scene without inventing a communication link',()=>{
 const s={project:{...local.project,defaultMode:'fuxa-local',scene:'F:/engineering/oip/project.json'},components:{oip:{installed:true}}};
 const items=overviewResources(s,null).find(g=>g.id==='scene').items;
 assert.equal(items.length,1);assert.equal(items[0].path,'F:/engineering/oip/project.json');assert.match(items[0].description,/Open Industry Project/);
 assert.equal(overviewLinks(s).some(link=>link.key==='io'),false);
});
