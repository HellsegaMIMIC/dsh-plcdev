import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedProjectContext,readProjectContext,contextValueAt,CONTEXT_MAX_BYTES} from '../src/project-context-read.mjs';
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
const fixture=()=>({ok:true,projectId:'p',projectName:'当前工程',projectRevision:'a'.repeat(64),contextToken:'b'.repeat(64),
 workflowRoute:{proposalTool:'plcdev_propose_project_edit'},editingInput:{operations:['oip-create-scene'],
  plcConfiguration:{instances:[{name:'instance0',program:'main'}]},oipCreation:{
   tools:[{name:'add_part',input_schema:{type:'object',required:['package','params'],properties:{package:{type:'string'},params:{type:'object'}}}}],
   packages:Array.from({length:40},(_,i)=>({id:'pkg-'+i,name:'部件'+i,paramSchema:{type:'object',required:['mode'],properties:{mode:{enum:Array.from({length:500},(_,n)=>'模式'+n)}}}})),
  }}});
function restore(full,path,seen=[]){
 let offset=0,out;
 for(;;){const page=readProjectContext(full,{path,offset});assert.ok(bytes(page)<=CONTEXT_MAX_BYTES);seen.push(bytes(page));
  if(Object.hasOwn(page,'value'))return page.value;
  if(Object.hasOwn(page,'text'))out=(out??'')+page.text;
  else{out??=page.type==='array'?[]:{};for(const row of page.entries){
    const key=typeof row.key==='string'?row.key:restore(full,row.key._plcdevRead.path,seen);
    Object.defineProperty(out,key,{value:row._plcdevRead?restore(full,row._plcdevRead.path,seen):row.value,enumerable:true,writable:true,configurable:true});
  }}
  if(page.nextOffset===null)return out;assert.ok(page.nextOffset>offset);offset=page.nextOffset;
 }
}
test('large native catalogs become indexed reads; every required/enum/schema value round trips intact',()=>{
 const full=fixture(),copy=structuredClone(full),summary=boundedProjectContext(full);
 assert.ok(bytes(full)>100000);assert.ok(bytes(summary)<=CONTEXT_MAX_BYTES);assert.deepEqual(full,copy);
 assert.equal(summary.editingInput.plcConfiguration.instances[0].program,'main');
 const ref=summary.editingInput.oipCreation.packages._plcdevRead;assert.equal(ref.path,'/editingInput/oipCreation/packages');
 assert.equal(summary.editingInput.oipCreation.packages.index[0].id,'pkg-0');
 assert.deepEqual(restore(full,ref.path),full.editingInput.oipCreation.packages);
 assert.deepEqual(restore(full,'/editingInput/oipCreation/packages/0/paramSchema'),full.editingInput.oipCreation.packages[0].paramSchema);
});
test('small context is unchanged; large source text is explicitly paged without losing unicode or escaping',()=>{
 const small={ok:true,editingInput:{value:'a'}};assert.equal(boundedProjectContext(small),small);
 const full={...fixture(),source:'"\\\n中文😀'.repeat(7000)};
 const summary=boundedProjectContext(full);assert.ok(bytes(summary)<=CONTEXT_MAX_BYTES);
 assert.deepEqual(restore(full,'/source'),full.source);
 for(const offset of [-1,NaN,1.5,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>readProjectContext(full,{path:'/source',offset}));
});
test('JSON pointers are own-data only, with escaped keys; giant keys get scoped opaque references',()=>{
 const huge='很长的字段😀'.repeat(1000),full={...fixture(),['a/b~c']:{literal:3},[huge]:'raw'.repeat(9000)};
 assert.equal(contextValueAt(full,'/a~1b~0c/literal'),3);
 for(const path of ['/__proto__','/constructor/prototype','/editingInput/oipCreation/packages/-1','/editingInput/oipCreation/packages/01','../outside','/a~2b','/'+huge,'@'+'f'.repeat(64)])assert.throws(()=>contextValueAt(full,path));
 const rebuilt=restore(full,'');assert.deepEqual(rebuilt,full);
 const first=readProjectContext(full,{path:'',offset:0});
 const keyRow=first.entries?.find(r=>typeof r.key!=='string');
 // Giant key may be on a later page; round-trip above follows every scoped ref.
 if(keyRow)assert.throws(()=>readProjectContext({...full},{path:keyRow.key._plcdevRead.path,offset:0}),/不属于本轮/);
});
