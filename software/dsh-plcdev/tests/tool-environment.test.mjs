import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createToolEnvironment} from '../src/tool-environment.mjs';

const route='/api/plcdev/tool-environment',root=path.resolve('fixture-only');
const missing=()=>Object.assign(new Error('not present'),{code:'ENOENT'});
function fixture({base={schemaVersion:1,tools:{editor:'editor.exe',fuxaPackage:'fuxa',oipExecutable:'oip.exe'}},override,environment={},platform=process.platform,files=[]}={}){
  const reads=[],probes=[];let present=new Set(files.map(value=>path.resolve(root,value)));
  const service=createToolEnvironment({projectRoot:root},{environment,platform,read:async file=>{reads.push(file);if(file===path.join(root,'config/environment.defaults.json'))return typeof base==='string'?base:JSON.stringify(base);if(override===undefined)throw missing();return typeof override==='string'?override:JSON.stringify(override);},inspect:async file=>{probes.push(file);if(!present.has(file))throw missing();return {isFile:()=>true};}});
  return {service,reads,probes,setFiles:values=>{present=new Set(values.map(value=>path.resolve(root,value)));},check:()=>service.handle('GET',route)};
}
test('no project or running service required; configured entries only, unknown runtime stays unchecked',async()=>{
  const f=fixture({files:['editor.exe','fuxa/main.js']});const r=await f.check();
  assert.equal(r.status,200);assert.deepEqual(r.body.tools.map(x=>[x.id,x.state]),[['openplc','found'],['fuxa','found'],['oip','missing'],['runtime','unchecked'],['msys','unchecked']]);
  assert.deepEqual(f.probes,[path.join(root,'editor.exe'),path.join(root,'fuxa','main.js'),path.join(root,'oip.exe')]);
});
test('reread observes newly installed or removed entry without caching success',async()=>{
  const f=fixture();assert.ok((await f.check()).body.tools.slice(0,3).every(x=>x.state==='missing'));
  f.setFiles(['editor.exe']);assert.equal((await f.check()).body.tools[0].state,'found');
  f.setFiles([]);assert.equal((await f.check()).body.tools[0].state,'missing');
});
test('local overrides and environment expansion use the same fixed configuration source',async()=>{
  const home=path.join(root,'local');const f=fixture({override:{schemaVersion:1,tools:{editor:'${TOOLS}/editor.exe'}},environment:{TOOLS:home},files:['local/editor.exe']});
  const r=await f.check();assert.equal(r.body.tools[0].state,'found');assert.equal(r.body.tools[0].path,path.join(home,'editor.exe'));assert.equal(r.body.configPath,path.join(root,'outputs/local/environment.json'));
});
test('malformed or explicitly missing config leaves state unchecked and never probes fallback tools',async()=>{
  for(const config of [{override:'{'},{environment:{PLCDEV_ENVIRONMENT_CONFIG:'missing.json'}},{base:{schemaVersion:1,tools:{editor:'editor.exe',secret:'never disclose'}}}]){
    const f=fixture(config),r=await f.check();assert.ok(r.body.configError);assert.ok(r.body.tools.every(x=>x.state==='unchecked'));assert.equal(f.probes.length,0);assert.equal(JSON.stringify(r).includes('never disclose'),false);
  }
});
test('unconfigured and unresolved paths are not reported missing or guessed through PATH',async()=>{
  const f=fixture({base:{schemaVersion:1,tools:{editor:'${ABSENT}/editor.exe'}}});const r=await f.check();assert.ok(r.body.tools.every(x=>x.state==='unchecked'));assert.equal(f.probes.length,0);
});
test('parameters and mutations rejected before any filesystem reads',async()=>{
  const f=fixture();for(const [method,url] of [['POST',route],['GET',route+'?path=C:/other'],['GET',route+'/extra']])assert.equal((await f.service.handle(method,url)).status,400);assert.equal(f.reads.length,0);assert.equal(f.probes.length,0);
});

test('explicit null groups match Python rejection instead of using empty defaults',async()=>{
  for(const group of ['tools','state'])for(const source of ['base','override']){
    const f=fixture({[source]:{schemaVersion:1,[group]:null},files:['editor.exe','fuxa/main.js','oip.exe']});
    const r=await f.check();assert.ok(r.body.configError);assert.ok(r.body.tools.every(tool=>tool.state==='unchecked'));assert.equal(f.probes.length,0);
  }
});

test('Windows environment names are case insensitive while other platforms preserve case',async()=>{
  const environment={LocalAppData:path.join(root,'local'),plcdev_environment_config:'custom.json'};
  const override={schemaVersion:1,tools:{editor:'%localappdata%/editor.exe',fuxaPackage:'${LOCALAPPDATA}/fuxa',oipExecutable:'$localappdata/oip.exe'}};
  const f=fixture({platform:'win32',environment,override,files:['local/editor.exe','local/fuxa/main.js','local/oip.exe']});
  const r=await f.check();assert.ok(r.body.tools.slice(0,3).every(tool=>tool.state==='found'));assert.equal(r.body.configPath,path.join(root,'custom.json'));
  const unix=fixture({platform:'linux',environment,override});const u=await unix.check();
  assert.ok(u.body.tools.every(tool=>tool.state==='unchecked'));assert.equal(unix.probes.length,0);assert.equal(u.body.configPath,path.join(root,'outputs/local/environment.json'));
});

const runtimeEntries=['VERSION','CMakeLists.txt','core/src/CMakeLists.txt','scripts/compile.sh','scripts/Makefile.strucpp'];
const msysEntries=['usr/bin/bash.exe','usr/bin/g++.exe','usr/bin/cmake.exe','usr/bin/make.exe'];
test('runtime and compiler probes require actual fixed entry files, not just existing directories',async()=>{
  const base={schemaVersion:1,tools:{runtime:'runtime',msys:'msys'}};
  const f=fixture({base,files:['runtime','msys']});let r=await f.check();
  assert.equal(r.body.tools.find(x=>x.id==='runtime').state,'missing');assert.equal(r.body.tools.find(x=>x.id==='msys').state,'missing');
  f.setFiles([...runtimeEntries.map(x=>'runtime/'+x),...msysEntries.map(x=>'msys/'+x)]);r=await f.check();
  assert.equal(r.body.tools.find(x=>x.id==='runtime').state,'found');assert.equal(r.body.tools.find(x=>x.id==='msys').state,'found');
  f.setFiles([...runtimeEntries.map(x=>'runtime/'+x),...msysEntries.filter(x=>!x.includes('g++')).map(x=>'msys/'+x)]);r=await f.check();
  const msys=r.body.tools.find(x=>x.id==='msys');assert.equal(msys.state,'missing');assert.deepEqual(msys.checks.filter(x=>x.state==='missing'),[{entry:'usr/bin/g++.exe',state:'missing'}]);
  assert.ok(f.probes.every(x=>[...runtimeEntries.map(x=>path.join(root,'runtime',x)),...msysEntries.map(x=>path.join(root,'msys',x))].includes(x)));
});
test('version is read only from a small fixed runtime VERSION file and is not compatibility acceptance',async()=>{
  let content='v4.3.0',size=6;const reads=[];
  const service=createToolEnvironment({projectRoot:root},{environment:{},read:async file=>{reads.push(file);if(file===path.join(root,'config/environment.defaults.json'))return JSON.stringify({schemaVersion:1,tools:{runtime:'runtime'}});if(file===path.join(root,'runtime/VERSION'))return content;throw missing();},inspect:async()=>({isFile:()=>true,size})});
  let r=await service.handle('GET',route),runtime=r.body.tools.find(x=>x.id==='runtime');assert.equal(runtime.version,'v4.3.0');assert.equal(runtime.state,'found');assert.equal(runtime.compatible,undefined);
  content='secret=do-not-echo';r=await service.handle('GET',route);assert.equal(r.body.tools.find(x=>x.id==='runtime').version,undefined);assert.equal(JSON.stringify(r).includes('do-not-echo'),false);
  size=4096;reads.length=0;await service.handle('GET',route);assert.ok(!reads.includes(path.join(root,'runtime/VERSION')));
});
test('unreadable runtime dependency remains unchecked without exposing filesystem errors',async()=>{
  const service=createToolEnvironment({projectRoot:root},{environment:{},read:async file=>{if(file===path.join(root,'config/environment.defaults.json'))return JSON.stringify({schemaVersion:1,tools:{runtime:'runtime'}});throw missing();},inspect:async()=>{throw Object.assign(new Error('private filesystem message'),{code:'EACCES'});}});
  const r=await service.handle('GET',route);assert.equal(r.body.tools.find(x=>x.id==='runtime').state,'unchecked');assert.equal(JSON.stringify(r).includes('private filesystem'),false);
});
