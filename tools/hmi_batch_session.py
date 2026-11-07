"""Own and launch the PC-only EEZ / OpenPLC / Factory I/O teaching example."""
from pathlib import Path
import argparse,os,json,re,shutil,socket,subprocess,sys,time
from types import SimpleNamespace
from editor_runtime_session import prepare as prepare_editor,run as run_editor
from factoryio_runtime import ROOT,RUNTIME,MSYS,PLUGIN_CONF,store,sha
SOURCE=ROOT/'software/hmi-batch';FAMILY=ROOT/'outputs/editor-runtime'
def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def validate_batch_project(project):
    """Only this declared mailbox layout can use the batch adapter's fixed registers."""
    generated=Path(project)/'build/OpenPLC Runtime v4/src'
    if not (generated/'debug-map.json').exists():raise ValueError('Compile the editable LD project first')
    expected={
        'SENSORCLEAR':('%IX0.0','BOOL'),'SCENERUNNING':('%IX0.1','BOOL'),'PERMIT':('%IX0.2','BOOL'),
        'COMMANDSEQ':('%IW0','INT'),'COMMANDKIND':('%IW1','INT'),'COMMANDVALUE':('%IW2','INT'),
        'CONVEYOR':('%QX0.1','BOOL'),'ENTRYCONVEYOR':('%QX0.0','BOOL'),
        'ACKSEQ':('%QW0','INT'),'ACKCODE':('%QW1','INT'),'COUNT':('%QW2','INT'),'TARGET':('%QW3','INT'),
        'STATE':('%QW4','INT'),'REMAININGMS':('%QW5','INT'),'FLAGS':('%QW6','INT'),'BATCHID':('%QW7','INT')}
    source=(generated/'program.st').read_text(encoding='utf-8-sig')
    source=re.sub(r'\(\*.*?\*\)','',source,flags=re.S)
    bindings={name.upper():(address.upper(),kind.upper()) for name,address,kind in
        re.findall(r'^\s*(\w+)\s+AT\s+(%[IQM][XBWDL]?[0-9.]+)\s*:\s*(\w+)',source,flags=re.M|re.I)}
    leaves={item['path'].upper():item['type'].upper() for item in json.loads((generated/'debug-map.json').read_text(encoding='utf-8-sig'))['leaves']}
    if bindings!=expected or any(leaves.get('INSTANCE0.'+name)!=kind for name,(_,kind) in expected.items()):
        raise ValueError('PLC 工程与批次通信映射不匹配；未准备或连接 Runtime')

def prepare(args):
    project=Path(getattr(args,'project_directory',SOURCE/'plc/project')).resolve()
    validate_batch_project(project)
    prepare_editor(SimpleNamespace(run_directory=args.run_directory,project_directory=project,mode='local',runtime_root=RUNTIME,msys_root=MSYS,duration=3600))
    out=args.run_directory.resolve();private=out/'runtime';manifest=json.loads((out/'session.json').read_text(encoding='utf-8'))
    manifest.update(mode='batch-'+args.mode,batchMode=args.mode,batchExample=True,batchHttpPort=free_port(),batchModbusPort=free_port(),localInputPaths=[])
    # Preserve the stock Queue of Items driver mapping in the independent scene.
    # The PLC mailbox uses normalized bit 0=clear, bit 1=scene running.
    manifest['factoryInputMap']={'sensorClear':2,'sceneRunning':3} if args.mode=='factoryio' else {'sensorClear':0,'sceneRunning':1}
    if manifest['batchModbusPort']==manifest['batchHttpPort']:manifest['batchModbusPort']=free_port()
    for folder in ['modbus_master','shared']:
        src=RUNTIME/'core/src/drivers/plugins/python'/folder;dst=private/'core/src/drivers/plugins/python'/folder
        shutil.copytree(src,dst,ignore=shutil.ignore_patterns('__pycache__','*.pyc'),dirs_exist_ok=True)
    for folder in ['pymodbus','serial']:
        shutil.copytree(RUNTIME/'venvs/modbus_master/lib/python3.12/site-packages'/folder,private/'venvs/modbus_master/lib/python3.12/site-packages'/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc'),dirs_exist_ok=True)
    config=[{'name':'BatchLocalMailbox','protocol':'MODBUS','config':{'transport':'tcp','type':'SLAVE','host':'127.0.0.1','port':manifest['batchModbusPort'],'slave_id':1,'timeout_ms':300,'io_points':[
        {'fc':2,'offset':'0','iec_location':'%IX0.0','len':8,'cycle_time_ms':50,'error_handling':'set-to-zero'},
        {'fc':3,'offset':'0','iec_location':'%IW0','len':3,'cycle_time_ms':50,'error_handling':'set-to-zero'},
        {'fc':15,'offset':'0','iec_location':'%QX0.0','len':8,'cycle_time_ms':50},
        {'fc':16,'offset':'0','iec_location':'%QW0','len':8,'cycle_time_ms':50}]} }]
    store(private/'factoryio-modbus.json',config);(private/'plugins.conf').write_text(PLUGIN_CONF,encoding='utf-8')
    shutil.copy2(out/'editor_runtime_monitor.py',out/'telemetry_reader.py')
    shutil.copy2(SOURCE/'batch_runtime_monitor.py',out/'editor_runtime_monitor.py')
    for p in [out/'editor_runtime_monitor.py',out/'telemetry_reader.py',private/'plugins.conf',private/'factoryio-modbus.json']:
        manifest['preparedHashes'][p.relative_to(out).as_posix()]=sha(p)
    for p in (private/'core/src/drivers/plugins/python').rglob('*.py'):manifest['preparedHashes'][p.relative_to(out).as_posix()]=sha(p)
    store(out/'session.json',manifest);return manifest
def launch(args):
    if not getattr(args,'run_directory',None):
        from plcdev_workbench import ensure,controller_call
        import secrets,webbrowser
        descriptor=ensure()
        status=controller_call(descriptor,'/api/status?project=batch-conveyor')
        controller_call(descriptor,'/api/action',{'action':'start','projectId':'batch-conveyor','sessionId':status['session']['id'],'mode':args.mode,'client':'batch-launcher-'+secrets.token_hex(6),'sequence':1,'expires':time.time()+12})
        webbrowser.open(descriptor['base']+'/?project=batch-conveyor#'+descriptor['token'])
        return {'ok':True,'managedBy':'PLCdev workbench'}
    exe=ROOT/'outputs/hmi-batch/desktop-build/BatchHMI.exe'
    if not exe.exists():raise ValueError('Run python tools/build_batch_hmi.py first')
    run_dir=getattr(args,'run_directory',None)
    if run_dir:
        run_dir=run_dir.resolve();manifest=json.loads((run_dir/'session.json').read_text(encoding='utf-8'))
        if not manifest.get('batchExample') or manifest.get('batchMode')!=args.mode or (run_dir/'run.claim').exists():raise ValueError('Fresh prepared batch session required')
    else:
        run_dir=FAMILY/('hmi-batch-'+args.mode+'-'+time.strftime('%Y%m%d-%H%M%S'))
        manifest=prepare(SimpleNamespace(run_directory=run_dir,mode=args.mode))
    store(ROOT/'outputs/hmi-batch/latest-session.json',{'runDirectory':str(run_dir),'httpPort':manifest['batchHttpPort'],'mode':args.mode})
    child=hmi=None
    with (run_dir/'launcher.stdout.log').open('wb') as log:
        try:
            child=subprocess.Popen([sys.executable,str(Path(__file__)),'run','--run-directory',str(run_dir),'--parent-pid',str(os.getpid())],stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
            end=time.monotonic()+25
            while time.monotonic()<end:
                if child.poll() is not None:raise RuntimeError('Batch Runtime exited; inspect '+str(run_dir))
                data=json.loads((run_dir/'state.json').read_text(encoding='utf-8'))
                if data.get('ready'):break
                time.sleep(.1)
            else:raise RuntimeError('Batch bridge startup timed out')
            hmi=subprocess.Popen([str(exe),str(manifest['batchHttpPort']),manifest['sessionId'],manifest['programHash']],cwd=exe.parent,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
            hmi.wait()
        finally:
            (run_dir/'stop.request').write_text('HMI window closed\n')
            if child:
                try:child.wait(20)
                except subprocess.TimeoutExpired:raise RuntimeError('Owned Runtime cleanup timed out; inspect '+str(run_dir))
    return {'ok':child.returncode==0,'runDirectory':str(run_dir)}
def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='verb',required=True)
    p=sub.add_parser('prepare');p.add_argument('--mode',choices=['mock','factoryio'],default='factoryio');p.add_argument('--run-directory',type=Path,required=True)
    p=sub.add_parser('run');p.add_argument('--run-directory',type=Path,required=True);p.add_argument('--parent-pid',type=int)
    p=sub.add_parser('launch');p.add_argument('--mode',choices=['mock','factoryio'],default='factoryio');p.add_argument('--run-directory',type=Path)
    args=parser.parse_args()
    result=prepare(args) if args.verb=='prepare' else run_editor(args) if args.verb=='run' else launch(args)
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
