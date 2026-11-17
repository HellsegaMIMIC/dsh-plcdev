import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';

// Match the production bootstrap's existing base interpreter, without changing
// Windows integrity labels. A downloaded venv launcher may itself be Low.
export function fixturePython(root){
  if(process.env.PLCDEV_DSH_TEST_PYTHON)return process.env.PLCDEV_DSH_TEST_PYTHON;
  const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const defaults=read(path.join(root,'config/environment.defaults.json'));
  const explicit=process.env.PLCDEV_ENVIRONMENT_CONFIG;
  const local=path.resolve(root,explicit||'outputs/local/environment.json');
  const tools={...defaults.tools,...(explicit||existsSync(local)?read(local).tools:{})};
  const resolve=value=>path.resolve(root,value.replace(/\$\{([^}]+)\}|%([^%]+)%/g,(match,a,b)=>process.env[a||b]||match));
  if(typeof tools.python==='string')return resolve(tools.python);
  const venv=resolve(tools.pythonEnvironment),config=path.join(venv,'pyvenv.cfg');
  const base=existsSync(config)?readFileSync(config,'utf8').split(/\r?\n/).find(line=>/^executable\s*=/.test(line))?.replace(/^executable\s*=\s*/,'').trim():null;
  return base?resolve(base):path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
}
