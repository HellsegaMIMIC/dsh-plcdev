"""Prepare and own an independent FUXA/OpenPLC/OIP simulation session."""
from pathlib import Path
from types import SimpleNamespace
import argparse, json, re, shutil, socket, subprocess
from factoryio_runtime import ROOT, RUNTIME, MSYS, PLUGIN_CONF, sha, store
from hmi_batch_session import prepare as prepare_batch
from editor_runtime_session import run as run_editor, private_directory
from plcdev_environment import tool_path

SOURCE = ROOT/'software/fuxa-oip'
EDITOR = tool_path('editor')

# Stable protocol roles, independent of a user's PLC symbol names and addresses.
ROLE_POINTS={
    'sensorClear':(2,0),'sceneRunning':(2,1),'permit':(2,2),
    'commandSeq':(3,0),'commandKind':(3,1),'commandValue':(3,2),
    'entryConveyor':(15,0),'conveyor':(15,1),
    'ackSeq':(16,0),'ackCode':(16,1),'count':(16,2),'target':(16,3),
    'state':(16,4),'remainingMs':(16,5),'flags':(16,6),'batchId':(16,7)}


def role_io_points(bindings):
    from workbench_project_config import validate_bindings
    validate_bindings(bindings)
    points=[]
    for role,(fc,offset) in ROLE_POINTS.items():
        item={'fc':fc,'offset':str(offset),'iec_location':bindings['plc'][role]['location'],'len':1,'cycle_time_ms':50}
        if fc in (2,3):item['error_handling']='set-to-zero'
        points.append(item)
    return points


def validate_compiled_roles(project,bindings):
    """A declared role must exist in the compiled debug map and located ST."""
    role_io_points(bindings)
    generated=Path(project)/'build/OpenPLC Runtime v4/src'
    leaves={item['path'].upper():item['type'].upper() for item in json.loads((generated/'debug-map.json').read_text(encoding='utf-8-sig'))['leaves']}
    source=re.sub(r'\(\*.*?\*\)','',(generated/'program.st').read_text(encoding='utf-8-sig'),flags=re.S)
    located={(name.upper(),location.upper(),kind.upper()) for name,location,kind in re.findall(r'^\s*(\w+)\s+AT\s+(%[IQM][XBWDL]?[0-9.]+)\s*:\s*(\w+)',source,flags=re.M|re.I)}
    for role,point in bindings['plc'].items():
        path=point['path'].upper();kind=point['type'].upper()
        if leaves.get(path)!=kind or (path.rsplit('.',1)[-1],point['location'].upper(),kind) not in located:
            raise ValueError('编译程序与工程角色绑定不一致：'+role)


def prepare_roles(project,out,bindings):
    from editor_runtime_session import prepare as prepare_editor
    validate_compiled_roles(project,bindings)
    prepare_editor(SimpleNamespace(run_directory=out,project_directory=project,mode='local',runtime_root=RUNTIME,msys_root=MSYS,duration=3600))
    private=out/'runtime';manifest=json.loads((out/'session.json').read_text(encoding='utf-8'))
    def free_port():
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
    http_port=free_port();modbus_port=free_port()
    while modbus_port==http_port:modbus_port=free_port()
    manifest.update(mode='fuxa-oip',batchMode='oip',batchExample=True,batchHttpPort=http_port,batchModbusPort=modbus_port,localInputPaths=[],plcBindings=bindings['plc'])
    for folder in ('modbus_master','shared'):
        shutil.copytree(RUNTIME/'core/src/drivers/plugins/python'/folder,private/'core/src/drivers/plugins/python'/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc'),dirs_exist_ok=True)
    for folder in ('pymodbus','serial'):
        shutil.copytree(RUNTIME/'venvs/modbus_master/lib/python3.12/site-packages'/folder,private/'venvs/modbus_master/lib/python3.12/site-packages'/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc'),dirs_exist_ok=True)
    config=[{'name':'ProjectRoleMailbox','protocol':'MODBUS','config':{'transport':'tcp','type':'SLAVE','host':'127.0.0.1','port':modbus_port,'slave_id':1,'timeout_ms':300,'io_points':role_io_points(bindings)}}]
    store(private/'factoryio-modbus.json',config);(private/'plugins.conf').write_text(PLUGIN_CONF,encoding='utf-8')
    shutil.copy2(out/'editor_runtime_monitor.py',out/'telemetry_reader.py')
    for path in [out/'telemetry_reader.py',private/'plugins.conf',private/'factoryio-modbus.json',*(private/'core/src/drivers/plugins/python').rglob('*.py')]:
        manifest['preparedHashes'][path.relative_to(out).as_posix()]=sha(path)
    return manifest


def validate_device(value):
    # Validate the project declaration before compilation or any socket is opened.
    if not isinstance(value,dict) or value.get('schemaVersion')!=1 or value.get('provider')!='oip':
        raise ValueError('OIP device mapping schemaVersion 1 required')
    for key in ('modbus','mcp'):
        endpoint=value.get(key,{})
        if endpoint.get('host')!='127.0.0.1' or type(endpoint.get('port')) is not int or not 1024<=endpoint['port']<=65535:
            raise ValueError('Only explicit loopback OIP endpoints are supported')
    if value['modbus'].get('unitId')!=1 or value['mcp'].get('path')!='/mcp':
        raise ValueError('OIP unit 1 and /mcp required')
    if not isinstance(value.get('scene',{}).get('project'),str) or not value['scene']['project'].strip():raise ValueError('Expected OIP scene project identity required')
    if 'path' in value['scene']:
        from oip_batch_mcp import project_path
        project_path(value['scene']['path'])
    for group,names in (('inputs',('sensorOccupied',)),('outputs',('conveyor','entryConveyor'))):
        for name in names:
            address=value.get(group,{}).get(name,{}).get('address')
            if type(address) is not int or not 0<=address<=65535:raise ValueError('Invalid OIP point: '+name)
    if type(value['inputs']['sensorOccupied'].get('activeHigh')) is not bool:raise ValueError('Sensor polarity required')
    if abs(value['outputs']['conveyor']['address']-value['outputs']['entryConveyor']['address'])!=1:raise ValueError('Output coils must be adjacent for atomic reconnect clearing')
    return value


def prepare(args):
    out=private_directory(args.run_directory)
    if out.exists():raise ValueError('Preparation requires a fresh session directory')
    project=args.project_directory.resolve();mapping_path=args.device_config.resolve()
    mapping=validate_device(json.loads(mapping_path.read_text(encoding='utf-8-sig')))
    if project==(ROOT/'software/hmi-batch/plc/project').resolve():
        raise ValueError('Use an independent copy of the existing batch PLC project')
    if args.compile:
        compile_home=out.parent/(out.name+'-compile');compile_home.mkdir(parents=True,exist_ok=False)
        with (compile_home/'compile.log').open('wb') as log:
            result=subprocess.run([str(args.editor.resolve()),'--cli','compile',str(project),'--target','OpenPLC Runtime v4',
                                   '--user-data',str(compile_home/'profile'),'--json'],cwd=ROOT,
                                  stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=180)
        if result.returncode:raise RuntimeError('PLC compilation failed; see '+str(compile_home/'compile.log'))
    bindings=getattr(args,'bindings',None)
    if bindings is not None and not mapping['scene'].get('path'):raise ValueError('Configured user project requires an absolute OIP scene directory')
    manifest=prepare_roles(project,out,bindings) if bindings is not None else prepare_batch(SimpleNamespace(project_directory=project,run_directory=out,mode='mock'))
    manifest.pop('factoryInputMap',None)
    manifest.update(mode='fuxa-oip',batchMode='oip',hmiProvider='fuxa',simulationProvider='oip',oipDevice=mapping,
                    projectId=args.project_id,projectName=args.project_name,
                    mappingSource=str(mapping_path),mappingSha256=sha(mapping_path),browserLeaseSeconds=1.5)
    if bindings is not None:
        fingerprint=getattr(args,'config_hash',None)
        if not isinstance(fingerprint,str) or not re.fullmatch(r'[0-9a-f]{64}',fingerprint):raise ValueError('Project configuration fingerprint required')
        manifest.update(configFingerprint=fingerprint,projectManifest=str(getattr(args,'manifest_path','')),bindingProtocol='batch-mailbox-v1')
        store(out/'bindings.json',bindings);manifest['preparedHashes']['bindings.json']=sha(out/'bindings.json')
    shutil.copy2(ROOT/'software/hmi-batch/batch_runtime_monitor.py',out/'legacy_batch_monitor.py')
    shutil.copy2(SOURCE/'batch_adapter.py',out/'editor_runtime_monitor.py')
    shutil.copy2(ROOT/'tools/oip_batch_mcp.py',out/'oip_batch_mcp.py')
    for path in (out/'legacy_batch_monitor.py',out/'editor_runtime_monitor.py',out/'oip_batch_mcp.py'):
        manifest['preparedHashes'][path.relative_to(out).as_posix()]=sha(path)
    store(out/'oip-device.json',mapping)
    manifest['preparedHashes']['oip-device.json']=sha(out/'oip-device.json')
    store(out/'session.json',manifest)
    state=json.loads((out/'state.json').read_text(encoding='utf-8'))
    state.update(mode='fuxa-oip',hmiProvider='fuxa',simulationProvider='oip',projectId=args.project_id,configFingerprint=manifest.get('configFingerprint'))
    store(out/'state.json',state)
    return {'ok':True,'runDirectory':str(out),'httpPort':manifest['batchHttpPort'],
            'projectId':manifest['projectId'],'simulationProvider':'oip','prepared':True,'started':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='verb',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('--run-directory',type=Path,required=True)
    prep.add_argument('--project-directory',type=Path,required=True);prep.add_argument('--device-config',type=Path,required=True)
    prep.add_argument('--project-id',default='fuxa-oip-batch');prep.add_argument('--project-name',default='FUXA / OIP 批次计数')
    prep.add_argument('--compile',action='store_true');prep.add_argument('--editor',type=Path,default=EDITOR)
    run=sub.add_parser('run');run.add_argument('--run-directory',type=Path,required=True);run.add_argument('--parent-pid',type=int)
    args=parser.parse_args()
    if args.verb=='prepare':result=prepare(args)
    else:
        manifest=json.loads((private_directory(args.run_directory)/'session.json').read_text(encoding='utf-8'))
        if manifest.get('mode')!='fuxa-oip' or manifest.get('simulationProvider')!='oip':raise ValueError('An independent prepared FUXA/OIP session is required')
        result=run_editor(args)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    main()
