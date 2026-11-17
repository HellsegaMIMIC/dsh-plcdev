import test from 'node:test';
import assert from 'node:assert/strict';
import {activityFromSnapshot,activityTargets,activityLabel,createRuntimeActivity} from '../src/client/runtime-activity.mjs';

const snapshot=(id='source',extra={})=>({project:{id,name:id},projects:[{id:'source'},{id:'copy'}],session:{id:'s-'+id,projectId:id,active:true},phase:'ready',observerFresh:true,state:{runtimeState:'RUNNING',observedAt:10},...extra});
test('navigation activity only trusts fresh matching session evidence',()=>{
  const item=activityFromSnapshot(snapshot(),10500);
  assert.equal(item.state,'running');assert.equal(activityLabel(item,10500),'PLC 运行中');
  assert.equal(activityLabel(item,12000),'运行状态待核对');
  assert.equal(activityFromSnapshot(snapshot(),12500).state,'unknown');
  assert.equal(activityFromSnapshot(snapshot('source',{session:{id:'wrong',projectId:'copy',active:true}}),10500),null);
  assert.equal(activityFromSnapshot(snapshot('source',{session:{active:false}}),10500),null);
});
test('target selection stays within the authoritative project catalog',()=>{
  assert.deepEqual(activityTargets(snapshot('source',{otherSessions:[{active:true,projectId:'copy'},{active:true,projectId:'missing'}],runtimeOwner:{projectId:'../bad'}})),['source','copy']);
});
test('preparing is visible before a runtime session is created',()=>{
  const value=snapshot('source',{phase:'building',session:{projectId:'source',id:null,active:false}});
  assert.deepEqual(activityTargets(value),['source']);
  const item=activityFromSnapshot(value,10500);assert.equal(item.state,'preparing');assert.equal(item.sessionId,null);
});
test('controller reads owner project independently and never posts actions',async()=>{
  const calls=[],timers=[];
  const activity=createRuntimeActivity({now:()=>10500,setTimer:fn=>(timers.push(fn),timers.length),clearTimer:()=>{},api:async path=>{
    calls.push(path);if(path==='status')return snapshot('source',{session:{id:null,projectId:'source',active:false},otherSessions:[{projectId:'copy',active:true}]});
    return snapshot('copy');
  }});
  await activity.refresh();assert.deepEqual(calls,['status','status?project=copy']);
  assert.equal(activity.snapshot().items[0].projectId,'copy');assert.equal(activity.snapshot().items[0].state,'running');
  activity.dispose();
});
test('read loss preserves owner as unknown without claiming stopped or retrying writes',async()=>{
  let failure=false;
  const activity=createRuntimeActivity({now:()=>10500,api:async()=>{if(failure)throw Error('offline');return snapshot();}});
  await activity.refresh();failure=true;await activity.refresh();
  assert.equal(activity.snapshot().items[0].projectId,'source');assert.equal(activity.snapshot().items[0].state,'unknown');
  assert.equal(activity.snapshot().error,'offline');activity.dispose();
});
test('late responses after unsubscribe cannot restore a stale running badge',async()=>{
  let resolve;
  const activity=createRuntimeActivity({api:()=>new Promise(done=>{resolve=done;}),setTimer:()=>0,clearTimer:()=>{}});
  const off=activity.subscribe(()=>{});off();resolve(snapshot());await new Promise(done=>setImmediate(done));
  assert.deepEqual(activity.snapshot().items,[]);activity.dispose();
});
