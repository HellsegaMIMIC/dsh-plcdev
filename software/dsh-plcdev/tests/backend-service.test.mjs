import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBackendService} from '../src/backend-service.mjs';

const ROUTE='/api/plcdev/backend/connect';
const ready={status:200,body:{ok:true,connected:true,service:'plcdev-workbench',instance:'a'.repeat(32)}};
const unavailable={status:503,body:{ok:false,connected:false,code:'upstream_unavailable'}};
async function fixture(t,{health=unavailable,launch,environment={},python=process.execPath}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'plcdev-backend-connect-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'config'));await mkdir(path.join(root,'tools'));
 await writeFile(path.join(root,'config/environment.defaults.json'),JSON.stringify({schemaVersion:1,tools:{python}}));
 await writeFile(path.join(root,'tools/plcdev_workbench.py'),'# fixture only; never executed');
 const probes=[],launches=[];let current=health;
 const bridge={async handle(...args){probes.push(args);return current;}};
 const service=createBackendService({projectRoot:root,controllerFile:path.join(root,'state/controller.json'),bridge},{environment,
  launch:async(...args)=>{launches.push(args);if(launch)await launch(...args);current=ready;}});
 return {root,service,probes,launches,setHealth:value=>{current=value;}};
}

test('registration and invalid requests never start services',async t=>{
 const f=await fixture(t);assert.equal(f.launches.length,0);assert.equal(f.probes.length,0);
 for(const [method,url,body] of [['GET',ROUTE,{}],['POST',ROUTE+'?start=true',{}],['POST',ROUTE,{action:'start'}],['POST',ROUTE,{python:'evil'}],['POST',ROUTE,null]]){
  assert.equal((await f.service.handle(method,url,body)).status,400);
 }
 assert.equal(f.launches.length,0);assert.equal(f.probes.length,0);
});

test('healthy existing service is reused without launching Python or changing Runtime',async t=>{
 const f=await fixture(t,{health:ready});assert.deepEqual(await f.service.handle('POST',ROUTE,{}),ready);
 assert.equal(f.launches.length,0);assert.deepEqual(f.probes,[['GET','/api/plcdev/health']]);
});

test('explicit recovery launches only fixed ensure with the matching descriptor home',async t=>{
 const f=await fixture(t,{environment:{NODE_OPTIONS:'bad',ELECTRON_RUN_AS_NODE:'1',PYTHONPATH:'bad',OPENPLC_TEST:'bad',PLCDEV_AGENT_HOME:'preserved-agent',PLCDEV_PROJECT_INDEX:'preserved-index'}});
 assert.deepEqual(await f.service.handle('POST',ROUTE,{}),ready);
 assert.equal(f.launches.length,1);
 const [python,args,options]=f.launches[0];assert.equal(python.toLowerCase(),process.execPath.toLowerCase());
 assert.deepEqual(args.slice(0,3),['-B','-X','utf8']);assert.equal(args[3].toLowerCase(),path.join(f.root,'tools/plcdev_workbench.py').toLowerCase());assert.deepEqual(args.slice(4),['ensure']);
 assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.timeout,35000);
 assert.equal(options.env.PLCDEV_WORKBENCH_HOME,path.join(f.root,'state'));
 assert.equal(options.env.PLCDEV_AGENT_HOME,'preserved-agent');assert.equal(options.env.PLCDEV_PROJECT_INDEX,'preserved-index');
 for(const key of ['NODE_OPTIONS','ELECTRON_RUN_AS_NODE','PYTHONPATH','OPENPLC_TEST'])assert.equal(options.env[key],undefined);
 assert.ok(f.probes.every(([method,url])=>method==='GET'&&url==='/api/plcdev/health'));
});

test('foreign, incompatible and unverified descriptors are not replaced',async t=>{
 for(const code of ['root_mismatch','invalid_controller','instance_mismatch','project_mismatch','invalid_root']){
  const health={status:409,body:{ok:false,code}},f=await fixture(t,{health});
  assert.deepEqual(await f.service.handle('POST',ROUTE,{}),health);assert.equal(f.launches.length,0);
 }
});

test('concurrent recovery clicks share one ensure operation',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=await fixture(t,{launch:()=>pending});
 const first=f.service.handle('POST',ROUTE,{}),second=f.service.handle('POST',ROUTE,{});
 release();assert.deepEqual(await Promise.all([first,second]),[ready,ready]);assert.equal(f.launches.length,1);
});

test('missing Python and authoritative invalid overrides fail without PATH fallback',async t=>{
 for(const [options,code] of [[{python:null},'python_not_configured'],[{python:'missing-python.exe'},'python_unavailable'],[{environment:{PLCDEV_ENVIRONMENT_CONFIG:'missing.json'}},'backend_environment_invalid']]){
  const f=await fixture(t,options),result=await f.service.handle('POST',ROUTE,{});
  assert.equal(result.body.code,code);assert.equal(f.launches.length,0);
 }
});

test('spawn failures and timeouts expose no child output or capability',async t=>{
 for(const [extra,code] of [[{},'backend_launch_failed'],[{killed:true},'backend_connect_timeout']]){
  const f=await fixture(t,{launch:async()=>{throw Object.assign(new Error('secret-token-in-child-output'),extra,{stdout:'secret-token',stderr:'secret-token'});}});
  const result=await f.service.handle('POST',ROUTE,{});assert.equal(result.body.code,code);
  assert.equal(JSON.stringify(result).includes('secret-token'),false);assert.equal(f.probes.length,1);
 }
});

test('successful child exit still requires an authenticated matching backend',async t=>{
 const f=await fixture(t);let probes=0;
 const mismatch={status:409,body:{ok:false,code:'instance_mismatch'}};
 const service=createBackendService({projectRoot:f.root,controllerFile:path.join(f.root,'controller.json'),bridge:{async handle(){return ++probes===1?unavailable:mismatch;}}},{environment:{},launch:async()=>{}});
 assert.deepEqual(await service.handle('POST',ROUTE,{}),mismatch);assert.equal(probes,2);
});
