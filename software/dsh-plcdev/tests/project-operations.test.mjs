import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectOperations,validateProjectOperation} from '../src/project-operations.mjs';

const projectId='user-'+ 'a'.repeat(32);
const otherId='user-'+ 'b'.repeat(32);
const parent=path.resolve('projects');
const request=(requestId='request1')=>({requestId,projectId,sessionId:null,action:'project-create',name:'工程',parent,language:'ld',simulation:'none'});
const endpoint='/api/plcdev/project-operations';
const success={status:200,body:{ok:true,projectId:otherId,project:{id:otherId,name:'工程'}}};
async function fixture(bridge){const dir=await mkdtemp(path.join(tmpdir(),'dsh-project-'));return {dir,routes:createProjectOperations({controllerFile:path.join(dir,'controller.json'),bridge}),close:()=>rm(dir,{recursive:true,force:true})};}

test('catalog operation accepts only explicit bounded fields and declared kinds',()=>{
 assert.equal(validateProjectOperation(request()),true);
 for(const bad of [{...request(),action:'tool'},{...request(),proxy:'http://example.com'},{...request(),parent:'relative'},{...request(),name:''},{...request(),name:'CON.txt'},{...request(),name:'a/b'},{...request(),name:'x'.repeat(81)},{...request(),simulation:'arbitrary'}, {...request(),sessionId:'../foreign'}])assert.equal(validateProjectOperation(bad),false);
 const configure={requestId:'r',projectId,sessionId:null,action:'project-configure',configurationRevision:'a'.repeat(16),hmiSource:path.resolve('hmi.fuxap'),bindingsSource:path.resolve('bindings.json')};
 assert.equal(validateProjectOperation(configure),true);assert.equal(validateProjectOperation({...configure,configurationRevision:'a'.repeat(64)}),false);
 const definition={schemaVersion:1,protocol:'project-interface-v1',variables:[{id:'Run',label:'Run',path:'INSTANCE0.Run',type:'BOOL',access:'read',aiVisible:false}],operations:[]};
 assert.equal(validateProjectOperation({requestId:'r',projectId,sessionId:null,action:'project-interface-configure',configurationRevision:null,definition}),true);
 assert.equal(validateProjectOperation({requestId:'r',projectId,sessionId:null,action:'project-interface-configure',configurationRevision:null,definition:{...definition,proxy:'unsafe'}}),false);
});

test('confirmed receipt survives new service instance and exact duplicate never repeats dispatch',async()=>{
 let calls=0;const f=await fixture({projectOperation:async b=>{calls++;assert.equal(b.projectId,projectId);assert.equal(b.action,'project-create');assert.match(b.client,/^dsh-catalog-/);return success;}});
 try{const first=await f.routes.handle('POST',endpoint,request());assert.equal(first.body.state,'confirmed');assert.equal(first.body.result.projectId,otherId);
 const reopened=createProjectOperations({controllerFile:path.join(f.dir,'controller.json'),bridge:{projectOperation:()=>{throw Error('unexpected replay');}}});
 const second=await reopened.handle('POST',endpoint,{...request(),name:'工程'});assert.equal(second.body.duplicate,true);assert.equal(second.body.state,'confirmed');assert.equal(calls,1);
 assert.equal((await reopened.handle('GET',endpoint+'?requestId=request1')).body.state,'confirmed');
 assert.equal((await reopened.handle('POST',endpoint,{...request(),name:'other'})).status,409);
 }finally{await f.close();}
});

test('concurrent duplicate, dropped response and mismatched identity remain unknown without resend',async()=>{
 let calls=0,release;const f=await fixture({projectOperation:async()=>{calls++;return new Promise(r=>release=r);}});
 try{const first=f.routes.handle('POST',endpoint,request());await new Promise(r=>setTimeout(r,10));const duplicate=await f.routes.handle('POST',endpoint,request());assert.equal(duplicate.body.state,'unknown');assert.equal(calls,1);release({status:200,body:{ok:true,projectId:otherId,project:{id:projectId}}});assert.equal((await first).body.state,'unknown');assert.equal((await f.routes.handle('POST',endpoint,request())).body.state,'unknown');assert.equal(calls,1);
 const lost=await fixture({projectOperation:async()=>{throw Error('response lost');}});try{assert.equal((await lost.routes.handle('POST',endpoint,request('lost'))).status,503);assert.equal((await lost.routes.handle('GET',endpoint+'?requestId=lost')).body.state,'unknown');}finally{await lost.close();}
 }finally{await f.close();}
});

test('configuration receipt requires same project identity and request lookup rejects unknown fields',async()=>{
 const f=await fixture({projectOperation:async()=>success});try{
 const body={requestId:'config',projectId,sessionId:null,action:'project-configure',configurationRevision:null,hmiSource:path.resolve('hmi.fuxap'),bindingsSource:path.resolve('bindings.json')};
 assert.equal((await f.routes.handle('POST',endpoint,body)).body.state,'unknown');
 assert.equal((await f.routes.handle('GET',endpoint+'?requestId=config&extra=1')).status,400);
 assert.equal((await f.routes.handle('POST',endpoint,{...body,action:'project-open',manifestPath:path.resolve('x'),hmiSource:'x'})).status,400);
 }finally{await f.close();}
});

test('OIP association is bounded, durable and keeps the same project identity',async()=>{
 const body={requestId:'oip-config',projectId,sessionId:null,action:'project-oip-configure',configurationRevision:null,source:path.resolve('scene/project.json')};
 assert.equal(validateProjectOperation(body),true);
 for(const patch of [{source:'relative'},{configurationRevision:'old'},{command:'run'},{bindings:{}}])assert.equal(validateProjectOperation({...body,...patch}),false);
 let calls=0;const f=await fixture({projectOperation:async b=>{calls++;assert.equal(b.source,body.source);return {status:200,body:{ok:true,projectId,project:{id:projectId}}};}});
 try{assert.equal((await f.routes.handle('POST',endpoint,body)).body.state,'confirmed');assert.equal((await f.routes.handle('POST',endpoint,body)).body.duplicate,true);assert.equal(calls,1);}finally{await f.close();}
 const wrong=await fixture({projectOperation:async()=>success});try{assert.equal((await wrong.routes.handle('POST',endpoint,body)).body.state,'unknown');}finally{await wrong.close();}
});
