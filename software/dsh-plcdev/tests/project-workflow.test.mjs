import test from 'node:test';
import assert from 'node:assert/strict';
import {projectWorkflowRoute} from '../src/project-workflow.mjs';

test('ordinary project route prefers shared editing and does not advertise unavailable operations',()=>{
 const route=projectWorkflowRoute({capabilities:{projectEditCandidate:true,jointAiCandidate:true}});
 assert.equal(route.proposalTool,'plcdev_propose_project_edit');assert.deepEqual(route.alternatives,[]);
 assert.deepEqual(route.argumentKeys,['contextToken','planJson']);
 assert.match(route.nextAction,/若本轮要求修改工程/);
 const unsupported=projectWorkflowRoute({capabilities:{projectEditCandidate:false}});
 assert.equal(unsupported.proposalTool,null);assert.deepEqual(unsupported.alternatives,[]);
 assert.match(unsupported.nextAction,/说明具体限制/);
 const hmi=projectWorkflowRoute({capabilities:{hmiViewNameCandidate:true,hmiStaticTextCandidate:true}});
 assert.equal(hmi.proposalTool,null);
 assert.deepEqual(hmi.alternatives,['plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text']);
});

test('selected old revision stays in its supported workflow even when new project editing is available',()=>{
 const listing={capabilities:{projectEditCandidate:true,jointAiCandidate:true,hmiViewNameCandidate:true,hmiStaticTextCandidate:true}};
 for(const [workflow,tool] of [
  ['project-edit-v1','plcdev_propose_project_edit'],['joint-ai-v1','plcdev_propose_joint'],
  [undefined,'plcdev_propose_joint'],['hmi-view-name-v1','plcdev_propose_hmi_view_name'],
  ['hmi-static-text-v1','plcdev_propose_hmi_static_text'],
  ['hmi-readonly-value-v1',null],['unknown',null],
 ]){
  const route=projectWorkflowRoute(listing,{workflow});
  assert.equal(route.proposalTool,tool,workflow);assert.deepEqual(route.alternatives,[]);
 }
 assert.equal(projectWorkflowRoute({capabilities:{}},{workflow:'hmi-static-text-v1'}).proposalTool,null);
});
