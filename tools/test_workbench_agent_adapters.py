"""M1 adapter tests: snapshots and native candidates do not touch project sources."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from factoryio_runtime import ROOT
from workbench_agent_adapters import AgentAdapters, AdapterError, _candidate_project_lease
from workbench_projects import read_user_project
from workbench_project_config import default_bindings, validate_oip


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


class AdapterTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'outputs').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='agent-adapter-test-')
        self.home = Path(self.temp.name)
        self.project_dir = self.home/'engineering'
        self.project_dir.mkdir()
        shutil.copytree(ROOT/'software/fuxa-oip/plc/project', self.project_dir/'plc')
        source = ROOT/'software/oip-batch/ContinuousBatch'
        scene = validate_oip(source)
        for file in scene['files']:
            destination = self.project_dir/'oip'/file.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)
        (self.project_dir/'hmi').mkdir()
        shutil.copyfile(ROOT/'software/fuxa-oip/hmi/batch-ai.fuxap', self.project_dir/'hmi/main.fuxap')
        dump(self.project_dir/'bindings.json', default_bindings(scene['name']))
        self.manifest = self.project_dir/'project.plcdev'
        dump(self.manifest, {'schemaVersion':2,'id':'user-'+'a'*32,'name':'Test batch',
            'application':{'provider':'openplc','path':'plc/project.json'},
            'target':{'provider':'openplc-runtime','mode':'local'},
            'hmi':{'provider':'fuxa','project':'hmi/main.fuxap'},
            'simulation':{'provider':'oip','project':'oip/project.json'},
            'bindings':{'provider':'batch-mailbox-v1','path':'bindings.json'},
            'configurationRevision':'0123456789abcdef'})
        self.project = read_user_project(self.manifest)
        self.state = {'openplc':{'verified':True,'editState':'closed'},
                      'fuxa':{'verified':True,'editState':'clean'},
                      'oip':{'verified':True,'editState':'closed'}}
        self.adapter = AgentAdapters(state_root=self.home/'candidates', observer=lambda p:self.state)

    def tearDown(self):
        self.temp.cleanup()

    def proposal(self, operation, *, source_basis='editor_current'):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        return self.adapter.propose_candidate(self.project,task_id='task1',expected_revision=revision,
                                             operation=operation,source_basis=source_basis)

    def test_batch_snapshot_exposes_real_binding_and_unknown_runtime(self):
        snap=self.adapter.inspect_project(self.project)
        self.assertEqual('batch-mailbox-v1',snap['protocol'])
        self.assertEqual('INSTANCE0.Count',snap['interface']['plcRoles']['count']['path'])
        self.assertEqual('%QW2',snap['interface']['plcRoles']['count']['location'])
        self.assertEqual('unknown',snap['runtime']['state'])
        self.assertTrue(snap['tools']['oip']['available'])

    def test_candidate_readiness_never_follows_unverified_state(self):
        snap = AgentAdapters(state_root=self.home/'no-observer').inspect_project(self.project)
        self.assertTrue(snap['capabilities']['deterministicCandidateImplemented'])
        self.assertFalse(snap['capabilities']['deterministicCandidate'])
        self.assertEqual(set(snap['capabilities']['candidateToolsReady'].values()), {False})
        self.assertFalse(snap['capabilities']['modelGeneration'])
        self.assertTrue(snap['capabilities']['savedRevisionCandidate'])
        self.assertEqual('unknown',snap['editorStates']['openplc']['editState'])

    def test_schema_one_does_not_invent_batch_capabilities(self):
        dump(self.manifest, {'schemaVersion':1,'id':'user-'+'a'*32,'name':'Plain',
           'application':{'provider':'openplc','path':'plc/project.json'},
           'target':{'provider':'openplc-runtime','mode':'local'},
           'simulation':{'provider':'none','project':None}})
        snap=self.adapter.inspect_project(read_user_project(self.manifest))
        self.assertIsNone(snap['protocol']);self.assertIsNone(snap['interface'])
        self.assertFalse(snap['tools']['oip']['available']);self.assertFalse(snap['tools']['fuxa']['available'])
        self.assertFalse(snap['capabilities']['savedRevisionCandidate'])

    def test_schema_three_declared_interface(self):
        project=read_user_project((ROOT/'software/project-interface-demo/project.plcdev').resolve())
        snap=self.adapter.inspect_project(project)
        self.assertEqual('project-interface-v1',snap['protocol']);self.assertIsNotNone(snap['interface'])
        self.assertFalse(snap['tools']['oip']['available']);json.dumps(snap,allow_nan=False)

    def test_schema_three_model_context_filters_hidden_declarations(self):
        folder = self.home/'declaration'
        shutil.copytree(ROOT/'software/project-interface-demo', folder)
        manifest_path = folder/'project.plcdev'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest.pop('hmi', None)
        dump(manifest_path, manifest)
        interface_path = folder/manifest['interface']['path']
        declaration = json.loads(interface_path.read_text(encoding='utf-8'))
        hidden = declaration['variables'][0]['id']
        declaration['variables'][0]['aiVisible'] = False
        dump(interface_path, declaration)
        snap = self.adapter.inspect_project(read_user_project(manifest_path))
        self.assertIn(hidden, [item['id'] for item in snap['interface']['variables']])
        self.assertNotIn(hidden, [item['id'] for item in snap['aiContext']['variables']])
        self.assertNotIn(hidden, [item['variable'] for item in snap['aiContext']['operations']])

    def test_openplc_candidate_changes_copy_only(self):
        original=self.adapter.inspect_project(self.project)
        candidate=self.proposal({'tool':'openplc','kind':'project-name','value':'Candidate PLC'})
        self.assertEqual(original['projectRevision'],self.adapter.inspect_project(self.project)['projectRevision'])
        self.assertNotEqual(original['projectRevision'],candidate['candidateDigest'])
        self.assertEqual('Candidate PLC',json.loads(Path(candidate['nativeArtifact']).read_text(encoding='utf-8'))['meta']['name'])
        self.assertFalse(candidate['modelCalled']);self.assertFalse(candidate['applySupported'])
        self.assertEqual('native-structure-only',candidate['validation'])

    def test_candidate_lease_blocks_other_process_for_same_project(self):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        script=('import sys;sys.path.insert(0,sys.argv[1]);'
                'from workbench_agent_adapters import _candidate_project_lease;'
                'ctx=_candidate_project_lease(sys.argv[2],sys.argv[3]);ctx.__enter__();'
                'print("locked",flush=True);sys.stdin.readline();ctx.__exit__(None,None,None)')
        process=subprocess.Popen([sys.executable,'-B','-c',script,str(ROOT/'tools'),
                                  str(self.home/'candidates'),self.project['id']],
                                 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(),'locked')
            with self.assertRaises(AdapterError) as blocked:
                self.adapter.propose_candidate(self.project,task_id='concurrent',expected_revision=revision,
                    operation={'tool':'openplc','kind':'project-name','value':'Candidate'})
            self.assertEqual(blocked.exception.code,'conflict')
            self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))
            # Another project is not serialized by this project lock.
            with _candidate_project_lease(self.home/'candidates','user-'+'b'*32): pass
        finally:
            process.stdin.write('\n');process.stdin.flush()
            _,error=process.communicate(timeout=10)
        self.assertEqual(process.returncode,0,error)
        result=self.adapter.propose_candidate(self.project,task_id='after-release',expected_revision=revision,
                    operation={'tool':'openplc','kind':'project-name','value':'Candidate'})
        self.assertEqual(result['status'],'ok')

    def test_candidate_lease_never_creates_lock_inside_source(self):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        inside=AgentAdapters(state_root=self.project_dir/'unsafe',observer=lambda p:self.state)
        with self.assertRaises(AdapterError):
            inside.propose_candidate(self.project,task_id='unsafe',expected_revision=revision,
                operation={'tool':'openplc','kind':'project-name','value':'Candidate'})
        self.assertFalse((self.project_dir/'unsafe').exists())

    def test_openplc_cli_renames_actual_variable_and_preserves_fb_pin(self):
        original=self.adapter.inspect_project(self.project)
        self.adapter.observer=None
        result=self.proposal({'tool':'openplc','kind':'batch-count-rename','value':'BatchCount'},source_basis='saved_revision')
        root=Path(result['candidateManifest']).parent
        ld=(root/'plc/pous/programs/main.ld').read_text(encoding='utf-8')
        self.assertIn('BatchCount : INT AT %QW2',ld)
        self.assertIn('"handleId": "Count"',ld)
        self.assertIn('"name": "BatchCount"',ld)
        self.assertIn('"name": "Count"',ld)
        self.assertEqual(json.loads((root/'bindings.json').read_text(encoding='utf-8'))['plc']['count']['path'],'INSTANCE0.BatchCount')
        self.assertEqual(original['projectRevision'],self.adapter.inspect_project(self.project)['projectRevision'])
        self.assertEqual(len(result['changedFiles']),3)
        self.assertEqual('saved_revision',result['sourceBasis'])
        self.assertEqual('saved-files-only',result['source'])
        self.assertEqual('unknown',result['editorState']['editState'])
        self.assertFalse(result['editorState']['verified'])
        self.assertFalse(result['unsavedEditsIncluded'])

    def test_saved_revision_keeps_unknown_or_unsaved_editor_state_truthful(self):
        original=self.adapter.inspect_project(self.project)
        for index,state in enumerate(('unknown','unsaved','pending','busy')):
            self.state['openplc']={'verified':state!='unknown','editState':state}
            result=self.adapter.propose_candidate(self.project,task_id='saved-'+str(index),
                expected_revision=original['projectRevision'],source_basis='saved_revision',
                operation={'tool':'openplc','kind':'project-name','value':'Saved copy'})
            self.assertEqual(state,result['editorState']['editState'])
            self.assertEqual('saved_revision',result['sourceBasis'])
            self.assertFalse(result['authoritativeSourceModified'])
            self.assertFalse(result['unsavedEditsIncluded'])
            self.assertEqual(original['files'],self.adapter.inspect_project(self.project)['files'])

    def test_unknown_source_basis_rejected_before_creating_candidate(self):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        with self.assertRaises(AdapterError) as raised:
            self.adapter.propose_candidate(self.project,task_id='invalid-basis',expected_revision=revision,
                source_basis='trust-me',operation={'tool':'openplc','kind':'project-name','value':'Bad'})
        self.assertEqual('invalid_request',raised.exception.code)
        self.assertFalse((self.home/'candidates').exists())

    def test_openplc_rename_blocks_unverified_or_unsaved_editor(self):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        for state in ('unknown','unsaved','pending','busy'):
            self.state['openplc']={'verified':True,'editState':state}
            with self.assertRaises(AdapterError) as raised:
                self.adapter.propose_candidate(self.project,task_id='blocked-'+state,expected_revision=revision,
                    operation={'tool':'openplc','kind':'batch-count-rename','value':'BatchCount'})
            self.assertEqual(raised.exception.code,'not_ready')
        self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))

    def test_openplc_rename_uses_the_actual_instance_and_count_address(self):
        plc=self.project_dir/'plc/project.json';project=json.loads(plc.read_text(encoding='utf-8'))
        project['data']['configuration']['resource']['instances'][0]['name']='LineB';dump(plc,project)
        bindings=self.project_dir/'bindings.json';data=json.loads(bindings.read_text(encoding='utf-8'))
        data['plc']['count']['path']='LineB.Count';data['plc']['count']['location']='%QW19';dump(bindings,data)
        ld=self.project_dir/'plc/pous/programs/main.ld';ld.write_text(ld.read_text(encoding='utf-8').replace('Count : INT AT %QW2','Count : INT AT %QW19'),encoding='utf-8')
        result=self.proposal({'tool':'openplc','kind':'batch-count-rename','value':'BatchCount'})
        root=Path(result['candidateManifest']).parent
        self.assertEqual(json.loads((root/'bindings.json').read_text(encoding='utf-8'))['plc']['count']['path'],'LineB.BatchCount')
        self.assertIn('BatchCount : INT AT %QW19',(root/'plc/pous/programs/main.ld').read_text(encoding='utf-8'))

    def test_fuxa_candidate_changes_copy_only(self):
        original=self.adapter.inspect_project(self.project)
        candidate=self.proposal({'tool':'fuxa','kind':'view-name','viewId':'v_plcdev_batch','value':'Candidate screen'})
        raw=json.loads(Path(candidate['nativeArtifact']).read_text(encoding='utf-8'))
        self.assertEqual('Candidate screen',raw['hmi']['views'][0]['name'])
        self.assertEqual(original['projectRevision'],self.adapter.inspect_project(self.project)['projectRevision'])

    def test_oip_candidate_changes_copy_only(self):
        original=self.adapter.inspect_project(self.project)
        candidate=self.proposal({'tool':'oip','kind':'part-name','partId':'bld_1','value':'Candidate building'})
        raw=json.loads(Path(candidate['nativeArtifact']).read_text(encoding='utf-8'))
        self.assertEqual('Candidate building',raw['parts'][0]['name'])
        self.assertEqual(original['projectRevision'],self.adapter.inspect_project(self.project)['projectRevision'])

    def test_unknown_unsaved_pending_block_without_copy(self):
        for state in ('unknown','unsaved','pending','busy'):
            self.state['fuxa']={'verified':True,'editState':state}
            with self.assertRaises(AdapterError) as raised:
                self.proposal({'tool':'fuxa','kind':'view-name','viewId':'v_plcdev_batch','value':'x'})
            self.assertEqual('not_ready',raised.exception.code)
        self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))

    def test_unverified_claim_is_not_authority(self):
        self.state['fuxa']={'verified':False,'editState':'closed'}
        self.assertEqual('unknown',self.adapter.inspect_project(self.project)['editorStates']['fuxa']['editState'])
        with self.assertRaises(AdapterError):self.proposal({'tool':'fuxa','kind':'view-name','viewId':'v_plcdev_batch','value':'x'})

    def test_stale_baseline_rejected(self):
        old=self.adapter.inspect_project(self.project)['projectRevision']
        data=json.loads((self.project_dir/'plc/project.json').read_text(encoding='utf-8'))
        data['meta']['name']='Changed by user';dump(self.project_dir/'plc/project.json',data)
        with self.assertRaises(AdapterError) as raised:
            self.adapter.propose_candidate(self.project,task_id='task1',expected_revision=old,
                source_basis='saved_revision',operation={'tool':'openplc','kind':'project-name','value':'x'})
        self.assertEqual('conflict',raised.exception.code)

    def test_invalid_and_path_escape_block(self):
        rev=self.adapter.inspect_project(self.project)['projectRevision']
        for task in ('../bad','x/y',''):
            with self.assertRaises(AdapterError):self.adapter.propose_candidate(self.project,task_id=task,expected_revision=rev,operation={'tool':'openplc','kind':'project-name','value':'x'})
        inside=AgentAdapters(state_root=self.project_dir/'candidate',observer=lambda p:self.state)
        with self.assertRaises(AdapterError):inside.propose_candidate(self.project,task_id='task',expected_revision=rev,operation={'tool':'openplc','kind':'project-name','value':'x'})

    def test_source_change_during_copy_not_published(self):
        rev=self.adapter.inspect_project(self.project)['projectRevision']
        actual_copy=shutil.copyfile;count=[0]
        def concurrent(a,b):
            result=actual_copy(a,b);count[0]+=1
            if count[0]==1:
                path=self.project_dir/'plc/project.json';data=json.loads(path.read_text(encoding='utf-8'));data['meta']['name']='User edit';dump(path,data)
            return result
        with patch('workbench_agent_adapters.shutil.copyfile',side_effect=concurrent):
            with self.assertRaises(AdapterError) as raised:
                self.adapter.propose_candidate(self.project,task_id='race',expected_revision=rev,operation={'tool':'openplc','kind':'project-name','value':'x'})
        self.assertEqual('conflict',raised.exception.code)
        self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))
        self.assertEqual('User edit',json.loads((self.project_dir/'plc/project.json').read_text(encoding='utf-8'))['meta']['name'])

    def test_saved_revision_copy_race_never_publishes_mixed_version(self):
        revision=self.adapter.inspect_project(self.project)['projectRevision']
        self.adapter.observer=None
        original_copy=shutil.copyfile
        changed=[False]
        def concurrent(source,target):
            result=original_copy(source,target)
            if not changed[0]:
                changed[0]=True
                path=self.project_dir/'plc/project.json'
                value=json.loads(path.read_text(encoding='utf-8'))
                value['meta']['name']='Concurrent saved edit'
                dump(path,value)
            return result
        with patch('workbench_agent_adapters.shutil.copyfile',side_effect=concurrent):
            with self.assertRaises(AdapterError) as raised:
                self.adapter.propose_candidate(self.project,task_id='saved-race',expected_revision=revision,
                    source_basis='saved_revision',operation={'tool':'openplc','kind':'project-name','value':'Candidate'})
        self.assertEqual('conflict',raised.exception.code)
        self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))
        self.assertEqual('Concurrent saved edit',json.loads((self.project_dir/'plc/project.json').read_text(encoding='utf-8'))['meta']['name'])

    def test_editor_becomes_dirty_during_copy_not_published(self):
        old = self.adapter.inspect_project(self.project)['projectRevision']
        actual_copy = shutil.copyfile
        def concurrent(a, b):
            result = actual_copy(a, b)
            self.state['fuxa'] = {'verified': True, 'editState': 'unsaved'}
            return result
        with patch('workbench_agent_adapters.shutil.copyfile', side_effect=concurrent):
            with self.assertRaises(AdapterError) as raised:
                self.adapter.propose_candidate(self.project, task_id='race', expected_revision=old,
                    operation={'tool':'fuxa', 'kind':'view-name', 'viewId':'v_plcdev_batch', 'value':'x'})
        self.assertEqual('conflict', raised.exception.code)
        self.assertFalse(list((self.home/'candidates').rglob('candidate.json')))

    def test_task_directory_link_is_never_followed(self):
        target = self.home/'candidates';target.mkdir()
        try:
            (target/'linked').symlink_to(self.project_dir, target_is_directory=True)
        except OSError:
            self.skipTest('Creating symlinks is not permitted on this host')
        with self.assertRaises(ValueError):
            self.adapter.propose_candidate(
                self.project, task_id='linked', expected_revision=self.adapter.inspect_project(self.project)['projectRevision'],
                operation={'tool':'openplc','kind':'project-name','value':'x'})

if __name__=='__main__':unittest.main(verbosity=2)
