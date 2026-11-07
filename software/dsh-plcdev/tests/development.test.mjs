import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { validateCall, developmentRequest, createExecutionGate, PROVIDER, MODEL, TOOLS } from '../development/index.mjs';

const call=(name,args)=>({id:'call-1',type:'function',function:{name,arguments:JSON.stringify(args)}});
function cleanup(path){assert.equal(dirname(path),resolve(tmpdir()));assert.match(basename(path),/^plcdev-dev-test-/);rmSync(path,{recursive:true});}
test('development calls cannot escape staged files, execute arbitrary shell, install, or escalate',()=>{
  const workspace=mkdtempSync(resolve(tmpdir(),'plcdev-dev-test-'));
  try {
    const file=resolve(workspace,'source.tsx'),other=resolve(workspace,'private.json');writeFileSync(file,'component');writeFileSync(other,'private');
    const scope={workspace,readFiles:[file],writeFiles:[file],commands:['node build.mjs']};
    assert.equal(validateCall(call('edit',{file_path:'source.tsx',old_string:'component',new_string:'updated'}),scope).file_path,realpathSync.native(file));
    assert.equal(validateCall(call('pwsh',{command:'node build.mjs'}),scope).workdir,realpathSync.native(workspace));
    for(const value of [call('read',{file_path:other}),call('write',{file_path:'new.txt'}),call('pwsh',{command:'node build.mjs; Get-Content private.json'}),call('pwsh',{command:'node build.mjs',workdir:'..'}),call('edit',{file_path:file,sandbox_permissions:'danger-full-access'}),call('plugin_manager',{action:'install_bundle',target:'unreviewed'}),call('plcdev_propose_joint',{})])assert.throws(()=>validateCall(value,scope));
  } finally {cleanup(workspace);}
});
test('native creation route keeps only its own conversation/tool context and requires native tools',()=>{
  const execution={sessionId:'dev-session',createdAt:123,isSeeded:false,cwd:process.cwd()};
  const scope={workspace:process.cwd(),approvedSessionId:'dev-session',approvedSessionCreatedAt:123,externalModelApproved:true,readFiles:[],writeFiles:[],commands:[]};
  const options={provider:PROVIDER,model:MODEL,sessionId:'dev-session',tools:TOOLS.map(name=>({name,parameters:{}})),messages:[
    {role:'system',content:[{type:'text',text:'private host context'}]},
    {role:'user',content:[{type:'text',text:'inspect plugins'}]},
    {role:'assistant',source:{provider:PROVIDER},content:[{type:'tool-call',id:'call-1',name:'cordis_inspect_list',arguments:'{}'}]},
    {role:'tool',source:{callId:'call-1'},content:[{type:'text',text:'public API declarations'}]},
    {role:'tool',source:{callId:'different'},content:[{type:'text',text:'unrelated private result'}]}
  ]};
  const request=developmentRequest(options,scope,execution);
  assert.equal(request.messages.length,3);assert.ok(!JSON.stringify(request).includes('private'));
  assert.throws(()=>developmentRequest({...options,tools:[]},scope,execution),/creation/);
  assert.throws(()=>developmentRequest({...options,provider:'plcdev-deepseek'},scope));
  assert.throws(()=>developmentRequest({...options,messages:[{role:'user',content:[{type:'image'}]}]},scope,execution));
  assert.throws(()=>developmentRequest({...options,sessionId:'unrelated-review-session'},scope,execution));
  for(const change of [{sessionId:'old-session'},{createdAt:122},{isSeeded:true},{cwd:dirname(process.cwd())}])
    assert.throws(()=>developmentRequest(options,scope,{...execution,...change}));
  assert.throws(()=>developmentRequest(options,{...scope,externalModelApproved:false},execution));
});

test('native dispatch consumes normalized approved paths and rejects later workspace or authorization changes',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'plcdev-dev-test-'));
  try{
    const a=resolve(root,'a'),b=resolve(root,'b');mkdirSync(a);mkdirSync(b);
    writeFileSync(resolve(a,'source.tsx'),'A');writeFileSync(resolve(b,'source.tsx'),'B');
    let scope={workspace:a,approvedSessionId:'approved',approvedSessionCreatedAt:12,externalModelApproved:true,readFiles:[resolve(a,'source.tsx')],writeFiles:[resolve(a,'source.tsx')],commands:['node build.mjs']};
    let execution={sessionId:'approved',createdAt:12,isSeeded:false,cwd:a};
    const gate=createExecutionGate(()=>scope,id=>id===execution.sessionId?execution:null);
    const approved=gate.verify('approved');
    assert.throws(()=>gate.verify('unrelated-session'));
    const normalized=gate.admit('approved',call('edit',{file_path:'source.tsx',old_string:'A',new_string:'updated'}),approved.scopeDigest);
    const exec={agent:{session:{id:'approved'}},callId:'call-1',name:'edit',arguments:JSON.parse(normalized.function.arguments)};
    assert.equal(exec.arguments.file_path,realpathSync.native(resolve(a,'source.tsx')));
    assert.equal(gate.guard(exec),undefined);
    assert.match(gate.guard({...exec,arguments:{...exec.arguments,file_path:'source.tsx'}}),/not admitted/);
    execution={...execution,cwd:b};assert.match(gate.guard(exec),/directory changed/);
    assert.throws(()=>gate.admit('approved',call('pwsh',{command:'node build.mjs'}),approved.scopeDigest),/directory changed/);
    execution={...execution,cwd:a};scope={...scope,externalModelApproved:false};assert.match(gate.guard(exec),/not explicitly approved/);
    scope={...scope,externalModelApproved:true};gate.finish(exec);assert.match(gate.guard(exec),/not admitted/);
    const shell=gate.admit('approved',{...call('pwsh',{command:'node build.mjs'}),id:'shell'},approved.scopeDigest);
    assert.equal(JSON.parse(shell.function.arguments).workdir,realpathSync.native(a));
    scope={...scope,commands:[]};assert.throws(()=>gate.admit('approved',call('read',{file_path:'source.tsx'}),approved.scopeDigest),/authorization changed/);
    assert.equal(gate.guard({name:'unrelated-normal-tool'}),undefined);
  }finally{cleanup(root);}
});
