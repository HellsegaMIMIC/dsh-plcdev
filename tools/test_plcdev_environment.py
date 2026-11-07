"""Configuration isolation and dependency drift checks; no tool/service starts."""
import json,os,tempfile,unittest,subprocess,sys
from pathlib import Path
from unittest.mock import patch
import plcdev_environment as app

class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.original_environment=dict(os.environ)
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);(self.root/'config').mkdir()
        self.defaults={'schemaVersion':1,'tools':{'editor':'tools space/editor.exe','node':None,'python':None},'state':{'runtimeOwnerDirectory':'state'}}
        self.write(self.root/'config/environment.defaults.json',self.defaults)
        self.env=patch.dict(os.environ,{},clear=True);self.env.start()
    def tearDown(self):self.env.stop();self.temp.cleanup()
    def write(self,path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value),encoding='utf-8')
    def test_relative_paths_use_workspace_not_caller_or_config_location(self):
        with patch.object(app.shutil,'which',return_value=str(self.root/'node.exe')):
            paths=app.paths(root=self.root)
        self.assertEqual(paths['editor'],self.root/'tools space/editor.exe')
    def test_explicit_config_overrides_only_named_tool(self):
        config=self.root/'separate/config.json';self.write(config,{'schemaVersion':1,'tools':{'editor':'new/editor.exe'}})
        value,_=app.configuration(config,self.root)
        self.assertEqual(value['tools']['editor'],'new/editor.exe');self.assertIsNone(value['tools']['python'])
    def test_missing_explicit_config_never_uses_defaults(self):
        with self.assertRaises(FileNotFoundError):app.configuration(self.root/'missing.json',self.root)
    def test_environment_selection_is_inherited(self):
        selected=self.root/'custom.json';self.write(selected,{'schemaVersion':1,'state':{'runtimeOwnerDirectory':'shared-lock'}})
        os.environ['PLCDEV_ENVIRONMENT_CONFIG']=str(selected)
        value,path=app.configuration(root=self.root);self.assertEqual(path,selected);self.assertEqual(value['state']['runtimeOwnerDirectory'],'shared-lock')
    def test_unknown_keys_and_invalid_schema_fail(self):
        for value in ({'schemaVersion':True},{'schemaVersion':2},{'schemaVersion':1,'token':'secret'},{'schemaVersion':1,'tools':{'edtor':'x'}}):
            with self.subTest(value=value),self.assertRaises(ValueError):app.validate(value)
    def test_unresolved_variable_and_nul_are_rejected(self):
        with self.assertRaises(ValueError):app.resolve('${NO_SUCH_TOOL}/x','editor',self.root)
        with self.assertRaises(ValueError):app.validate({'schemaVersion':1,'tools':{'editor':'x\0y'}})
    def test_lock_is_location_independent_but_detects_byte_and_version_drift(self):
        before={'platform':'win32','pluginVersion':'0.5.0','tools':{'editor':{'files':{'exe':{'path':'old','sha256':'a'}},'version':'1'}}}
        after=json.loads(json.dumps(before));after['tools']['editor']['files']['exe']['path']='new'
        self.assertEqual(app.compare(before,after),[])
        after['tools']['editor']['files']['exe']['sha256']='b';after['tools']['editor']['version']='2'
        self.assertEqual(len(app.compare(before,after)),2)

    def test_consumers_use_selected_config_in_fresh_process(self):
        config=self.root/'selected.json'
        self.write(config,{'schemaVersion':1,'tools':{'editor':'alternate/editor.exe','runtime':'alternate/runtime','msys':'alternate/msys','pythonEnvironment':'alternate/python-env'},'state':{'runtimeOwnerDirectory':'alternate/machine-lock'}})
        code="""import sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'tools'))
import factoryio_runtime as runtime,workbench_start_stop as local,workbench_projects as catalog,plcdev_workbench as controller,fuxa_oip_session as session
import plcdev_runtime_owner as owner,workbench_agent_bootstrap as bootstrap
root=Path.cwd()
assert all(m.EDITOR==root/'alternate/editor.exe' for m in (local,catalog,controller,session))
assert runtime.RUNTIME==root/'alternate/runtime' and runtime.MSYS==root/'alternate/msys'
assert owner.LOCK==root/'alternate/machine-lock/runtime.lock'
assert bootstrap.VENV==root/'alternate/python-env'
"""
        environment=dict(os.environ,PLCDEV_ENVIRONMENT_CONFIG=str(config))
        # Keep process bootstrap variables, including LOCALAPPDATA for OIP.
        environment.update({k:v for k,v in self.original_environment.items() if k not in environment})
        result=subprocess.run([sys.executable,'-B','-c',code],cwd=app.ROOT,env=environment,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
