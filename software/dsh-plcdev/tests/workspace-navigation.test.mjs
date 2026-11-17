import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKSPACE_KEY,workspaceLocation,readWorkspace,rememberWorkspace,projectLocationFor} from '../src/client/workspace-navigation.mjs';

test('display bookmarks retain the last tab of each project and its selected object',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};let state=readWorkspace(storage);
  for(const current of [{projectId:'project-a',view:'resources',selected:'signal:count',scroll:128},{projectId:'project-a',view:'settings'},{projectId:'project-a',view:'resources',selected:'signal:count',scroll:256},{projectId:'project-b',view:'runtime',scroll:12}])state=rememberWorkspace(storage,state,current,false);
  const read=readWorkspace(storage);assert.deepEqual(projectLocationFor(read,'project-a'),{projectId:'project-a',view:'resources',selected:'signal:count',review:null,scroll:256});assert.equal(projectLocationFor(read,'project-b').view,'runtime');assert.equal(projectLocationFor(read,'project-a','settings').selected,null);assert.equal(projectLocationFor(read,'missing','resources').projectId,'missing');assert.ok(values.has(WORKSPACE_KEY));
});

test('stale or malformed bookmarks do not grant review or project identity',()=>{
  assert.equal(workspaceLocation({projectId:'../escape'}),null);const valid=workspaceLocation({projectId:'project-a',view:'unknown',review:{projectId:'project-b',sessionId:'chat-a',taskId:'task-'+'a'.repeat(32)},scroll:-1});assert.equal(valid.view,'resources');assert.equal(valid.review,null);assert.equal(valid.scroll,0);
  const invalid=readWorkspace({getItem:()=>'{bad'});assert.equal(invalid.catalog,true);assert.equal(invalid.current,null);
  const previous=readWorkspace({getItem:()=>null});assert.doesNotThrow(()=>rememberWorkspace({setItem:()=>{throw Error('denied');}},previous,{projectId:'a',view:'sessions'},false));
});
