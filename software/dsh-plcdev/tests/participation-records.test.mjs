import test from 'node:test';
import assert from 'node:assert/strict';
import {createParticipationRecords} from '../src/client/participation-records.mjs';

function source(value) {
  const listeners=new Set();
  return {getSnapshot:()=>value,snapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    set(next){value=next;for(const fn of [...listeners])fn();},listeners};
}
const binding=(id,enabled)=>({conversationId:id,projectId:enabled?'project-a':null,version:1,taskRefs:[],pendingRequests:[]});
const row=(id,mainView=0,other={})=>({id,retainedBy:{mainView,...other}});
function harness(initial=[]) {
  const list=source({byId:Object.fromEntries(initial.map(r=>[r.id,r]))}),host=source({list}),map=new Map();
  const state=(id,enabled=false)=>{if(!map.has(id))map.set(id,source({binding:binding(id,enabled)}));return map.get(id);};
  let registrations=0,removals=0,live=0;
  const manager=createParticipationRecords({sessions:{get:host.getSnapshot,subscribe:host.subscribe},contexts:{get:state},register(){registrations++;live++;return()=>{removals++;live--;};}});
  return {manager,list,host,state,map,count:()=>({registrations,removals,live}),rows(...rows){list.set({byId:Object.fromEntries(rows.map(r=>[r.id,r]))});}};
}

test('only the active engineering conversation contributes records; background retains do not',()=>{
  const h=harness([row('ordinary',1),row('engineering',0,{editor:1})]);
  h.state('engineering').set({binding:binding('engineering',true)});
  assert.equal(h.count().live,0);assert.equal(h.map.get('engineering').listeners.size,0);
  h.rows(row('ordinary'),row('engineering',1));assert.equal(h.manager.current(),'engineering');assert.equal(h.count().live,1);
  h.rows(row('ordinary',1),row('engineering',0,{editor:1}));assert.equal(h.count().live,0);
  assert.equal(h.map.get('engineering').listeners.size,0);h.manager.dispose();
});

test('binding activation and deactivation change the roster once, without a new global switch',()=>{
  const h=harness([row('chat',1)]),c=h.state('chat');
  c.set({binding:binding('chat',true)});c.set({binding:binding('chat',true)});
  assert.deepEqual(h.count(),{registrations:1,removals:0,live:1});
  c.set({binding:binding('chat',false),lastBinding:binding('chat',true),error:'stale action notice'});
  assert.deepEqual(h.count(),{registrations:1,removals:1,live:0});h.manager.dispose();
});

test('read failure keeps the known engineering tab but not a foreign or unknown identity',()=>{
  const h=harness([row('chat',1)]),c=h.state('chat');
  c.set({binding:binding('chat',true)});
  c.set({binding:null,lastBinding:binding('chat',true),bindingReadError:'offline'});assert.equal(h.count().live,1);
  c.set({binding:null,lastBinding:binding('other',true),bindingReadError:'offline'});assert.equal(h.count().live,0);
  c.set({binding:null,lastBinding:binding('chat',true),loading:true});assert.equal(h.count().live,0);
  c.set({binding:null,error:'offline'});assert.equal(h.count().live,0);h.manager.dispose();
});

test('retain-before-release transitions keep the current owner; ambiguous initial ownership waits',()=>{
  const h=harness([row('a',1),row('b',1)]);
  assert.equal(h.manager.current(),null);assert.equal(h.map.size,0);
  h.rows(row('a',1));h.state('a').set({binding:binding('a',true)});
  h.rows(row('a',1),row('b',1));assert.equal(h.manager.current(),'a');assert.equal(h.count().live,1);
  h.rows(row('a'),row('b',1));assert.equal(h.manager.current(),'b');assert.equal(h.count().live,0);
  h.state('a').set({binding:binding('a',true)});assert.equal(h.count().live,0);h.manager.dispose();
});

test('service replacement and disposal release each observer and view registration',()=>{
  const h=harness([row('a',1)]);h.state('a').set({binding:binding('a',true)});
  const next=source({byId:{b:row('b',1)}});h.host.set({list:next});
  assert.equal(h.list.listeners.size,0);assert.equal(h.state('a').listeners.size,0);assert.equal(h.manager.current(),'b');
  h.state('b').set({binding:binding('b',true)});assert.equal(h.count().live,1);
  h.manager.dispose();h.manager.dispose();
  assert.equal(next.listeners.size,0);assert.equal(h.host.listeners.size,0);assert.equal(h.state('b').listeners.size,0);
  assert.deepEqual(h.count(),{registrations:2,removals:2,live:0});
  next.set({byId:{a:row('a',1)}});h.host.set({list:h.list});assert.equal(h.count().live,0);
});

test('unavailable or empty host removes the roster and allows clean recovery',()=>{
  const h=harness([row('a',1)]);h.state('a').set({binding:binding('a',true)});
  h.host.set(null);assert.equal(h.count().live,0);assert.equal(h.manager.current(),null);
  h.host.set({list:h.list});assert.equal(h.count().live,1);
  h.rows();assert.equal(h.count().live,0);h.manager.dispose();
});
