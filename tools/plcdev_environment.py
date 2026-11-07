"""Machine-local tool paths and read-only dependency fingerprints.

Relative paths resolve against the workspace, never the caller's cwd. An
explicit config is authoritative: invalid/missing files never silently fall
back to another installation. This module never starts a PLC or reads secrets.
"""
from __future__ import annotations
import argparse,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DEFAULTS=ROOT/'config/environment.defaults.json'
LOCAL=ROOT/'outputs/local/environment.json'
KEYS={'schemaVersion','tools','state'}
TOOLS={'editor','runtime','msys','node','python','pythonEnvironment','dshCli','fuxaPackage','oipExecutable'}

def read_object(path):
    value=json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(value,dict):raise ValueError('Environment config must be an object')
    return value

def validate(value):
    if set(value)-KEYS or type(value.get('schemaVersion')) is not int or value['schemaVersion']!=1:
        raise ValueError('Unsupported environment config schema or keys')
    for group,keys in (('tools',TOOLS),('state',{'runtimeOwnerDirectory'})):
        entries=value.get(group,{})
        if not isinstance(entries,dict) or set(entries)-keys:raise ValueError('Unknown '+group+' configuration key')
        for key,item in entries.items():
            if item is None and group=='tools' and key in ('node','python'):continue
            if not isinstance(item,str) or not item.strip() or '\0' in item or len(item)>32767:
                raise ValueError('Invalid environment path: '+key)

def configuration(config=None,root=ROOT):
    root=Path(root).resolve();base=read_object(root/'config/environment.defaults.json');validate(base)
    selected=Path(config or os.environ.get('PLCDEV_ENVIRONMENT_CONFIG') or root/'outputs/local/environment.json')
    if not selected.is_absolute():selected=root/selected
    explicit=config is not None or bool(os.environ.get('PLCDEV_ENVIRONMENT_CONFIG'))
    if explicit or selected.exists():
        override=read_object(selected);validate(override)
        for group in ('tools','state'):base.setdefault(group,{}).update(override.get(group,{}))
    return base,selected.resolve()

def resolve(value,name,root):
    if value is None:
        value=sys.executable if name=='python' else shutil.which('node')
        if not value:raise ValueError('Node.js not found; configure tools.node')
    expanded=os.path.expandvars(value)
    if '${' in expanded or '%' in expanded:raise ValueError('Unresolved environment variable in '+name)
    path=Path(expanded)
    return (path if path.is_absolute() else Path(root)/path).resolve()

def paths(config=None,root=ROOT):
    value,_=configuration(config,root)
    return {key:resolve(item,key,root) for key,item in value['tools'].items()}

def tool_path(name):
    if name not in TOOLS:raise ValueError('Unknown tool '+name)
    return paths()[name]

def runtime_owner_directory():
    value,_=configuration()
    return resolve(value['state']['runtimeOwnerDirectory'],'runtimeOwnerDirectory',ROOT)

def effective(config=None,root=ROOT):
    value,source=configuration(config,root)
    return {'schemaVersion':1,'tools':{k:str(p) for k,p in paths(config,root).items()},
            'state':{k:str(resolve(p,k,root)) for k,p in value['state'].items()}},source

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def command_version(argv):
    r=subprocess.run(list(map(str,argv)),capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=20,
                     creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if r.returncode:raise ValueError('Version command failed: '+str(argv[0]))
    return (r.stdout or r.stderr).strip().splitlines()[0]

def snapshot(config=None):
    p=paths(config);records={}
    probes={
      'editor':{'executable':p['editor'],'archive':p['editor'].parent/'resources/app.asar'},
      'runtime':{'version':p['runtime']/'VERSION','core':p['runtime']/'core/src/CMakeLists.txt','programBuild':p['runtime']/'scripts/compile.sh'},
      'msys':{'bash':p['msys']/'usr/bin/bash.exe','g++':p['msys']/'usr/bin/g++.exe','cmake':p['msys']/'usr/bin/cmake.exe'},
      'node':{'executable':p['node']},'python':{'executable':p['python']},
      'pythonEnvironment':{},
      'dshCli':{'entry':p['dshCli'],'manifest':p['dshCli'].parent.parent/'package.json'},
      'fuxaPackage':{'manifest':p['fuxaPackage']/'package.json','server':p['fuxaPackage']/'main.js','client':p['fuxaPackage']/'dist/index.html'},
      'oipExecutable':{'executable':p['oipExecutable'],'archive':p['oipExecutable'].parent/'resources/app.asar'}}
    for name,files in probes.items():
        records[name]={'files':{key:{'path':str(file),'sha256':sha(file)} for key,file in files.items()}}
    records['node']['version']=command_version([p['node'],'--version'])
    records['runtime']['version']=(p['runtime']/'VERSION').read_text(encoding='utf-8').strip()
    records['python']['version']=command_version([p['python'],'--version'])
    site=p['pythonEnvironment']/'Lib/site-packages'
    venv_config=dict(line.split('=',1) for line in (p['pythonEnvironment']/'pyvenv.cfg').read_text(encoding='utf-8').splitlines() if '=' in line)
    records['pythonEnvironment']['pythonVersion']=next(value.strip() for key,value in venv_config.items() if key.strip()=='version')
    records['pythonEnvironment']['packages']={f.parent.name:sha(f) for f in sorted(site.glob('*.dist-info/METADATA'))}
    if not records['pythonEnvironment']['packages']:raise ValueError('Python dependencies are missing')
    for name in ('dshCli','fuxaPackage'):
        records[name]['version']=read_object(probes[name]['manifest'])['version']
    records['msys']['compilerVersion']=command_version([p['msys']/'usr/bin/g++.exe','--version'])
    records['msys']['cmakeVersion']=command_version([p['msys']/'usr/bin/cmake.exe','--version'])
    records['editor']['sourceVersion']=read_object(ROOT/'software/openplc-editor-zh/package.json')['version']
    return {'schemaVersion':1,'platform':sys.platform,'tools':records,'pluginVersion':read_object(ROOT/'software/dsh-plcdev/package.json')['version']}

def compare(expected,actual):
    problems=[]
    if expected.get('platform')!=actual.get('platform'):problems.append('platform differs')
    if expected.get('pluginVersion')!=actual.get('pluginVersion'):problems.append('PLCdev plugin version differs')
    for name,record in expected['tools'].items():
        current=actual['tools'].get(name,{})
        for key,value in record.items():
            if key=='files':
                for label,f in value.items():
                    if f['sha256']!=current.get('files',{}).get(label,{}).get('sha256'):problems.append(name+'/'+label+' hash differs')
            elif value!=current.get(key):problems.append(name+'/'+key+' differs')
    return problems

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('verb',choices=['show','init','snapshot','check'])
    parser.add_argument('--config',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--lock',type=Path)
    a=parser.parse_args()
    if a.verb in ('show','init'):
        value,_=effective(a.config)
        if a.verb=='init':
            target=a.output or LOCAL
            if target.exists():raise ValueError('Do not overwrite existing local config')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
        else:print(json.dumps(value,indent=2))
    else:
        value=snapshot(a.config)
        if a.verb=='check':
            if not a.lock:parser.error('--lock is required')
            problems=compare(read_object(a.lock),value);value={'passed':not problems,'problems':problems}
        if a.output:
            a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(value if a.verb=='check' else {'snapshotWritten':str(a.output),'tools':len(value['tools'])}))
        if value.get('passed') is False:return 1
    return 0

if __name__=='__main__':sys.exit(main())
