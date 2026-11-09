"""Joint native candidate checks; a supplied model stub never contacts a provider."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_workbench_agent_adapters as fixtures
from workbench_joint_candidate import JointCandidateAdapters, AdapterError, FUXA
from workbench_agent_adapters import _snapshot
from workbench_projects import read_user_project
from workbench_project_config import validate_oip


class JointTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.AdapterTests()
        self.fixture.setUp()
        self.project = self.fixture.project
        self.home = self.fixture.home
        self.calls = []
        spec = json.loads(subprocess.check_output(
            ['node', '-e', "process.stdout.write(JSON.stringify(require(process.argv[1]).reference()))",
             str(FUXA / 'native-project.cjs')]))
        spec['title'] = 'AI 计数工作站（测试模型）'
        parts = validate_oip(self.project['scene'])['scene']['parts']
        conveyor = next(p for p in parts if 'conveyor' in str(p.get('name', '')).lower())
        self.plan = {'schemaVersion': 1,
                     'plc': {'operation': 'batch-count-rename', 'value': 'BatchCount'},
                     'hmi': spec,
                     'oip': {'operation': 'part-name', 'partId': conveyor['id'], 'value': '批次主输送带'}}
        def model(messages):
            self.calls.append(messages)
            return {'plan': copy.deepcopy(self.plan), 'model': 'offline-test-model',
                    'providerHost': 'offline', 'usage': {}, 'modelCalled': False}
        self.adapter = JointCandidateAdapters(self.home / 'joint', model_request=model, allow_model=True)
        self.baseline = _snapshot(self.project)

    def tearDown(self):
        self.fixture.tearDown()

    def propose(self, task='joint-test'):
        return self.adapter.propose_joint_candidate(self.project, task_id=task,
            expected_revision=self.baseline['projectRevision'], request='生成批次计数联合候选，保留原控制逻辑')

    def test_native_triplet_and_exact_source_preservation(self):
        result = self.propose()
        self.assertEqual(_snapshot(self.project), self.baseline)
        self.assertFalse(result['modelCalled'])
        self.assertEqual([c['tool'] for c in result['components']], ['openplc', 'fuxa', 'oip'])
        self.assertEqual(len(result['changedFiles']), 5)
        candidate = read_user_project(result['candidateManifest'])
        self.assertEqual(candidate['configuration']['bindings']['plc']['count']['path'], 'INSTANCE0.BatchCount')
        hmi = json.loads(Path(candidate['hmi']).read_text(encoding='utf-8'))
        self.assertEqual(hmi['name'], self.plan['hmi']['title'])
        self.assertEqual(hmi['devices']['d_plcdev_batch']['property']['getTags'], '/plcdev/tags')
        scene = validate_oip(candidate['scene'])['scene']
        source_scene = validate_oip(self.project['scene'])['scene']
        expected_scene = copy.deepcopy(source_scene)
        next(p for p in expected_scene['parts'] if p['id'] == self.plan['oip']['partId'])['name'] = '批次主输送带'
        self.assertEqual(scene, expected_scene)
        self.assertEqual(result['candidateDigest'], _snapshot(candidate)['projectRevision'])
        self.assertEqual(result['modelEvidence']['status'], 'completed')
        self.assertEqual(len(self.calls), 1)

    def test_extra_plc_instruction_rejected_before_native_edit(self):
        self.plan['plc']['code'] = 'malicious generated code'
        with self.assertRaises(AdapterError): self.propose()
        self.assertEqual(_snapshot(self.project), self.baseline)
        self.assertFalse(list((self.home/'joint').rglob('candidate.json')))

    def test_title_revision_preserves_previous_native_specs(self):
        self.plan['hmi']['title'] = '5'
        parent = self.propose('revision-parent')
        previous = copy.deepcopy(parent['acceptedPlan'])
        self.plan['hmi']['title'] = '6'
        self.plan['oip']['value'] = 'unrequested regression'
        child = self.adapter.propose_joint_candidate(self.project, task_id='revision-child',
            expected_revision=self.baseline['projectRevision'], request='根据上一版候选，标题改成 6',
            revision_plan=previous, revision_request='标题改成 6')
        expected = copy.deepcopy(previous)
        expected['hmi']['title'] = '6'
        self.assertEqual(child['acceptedPlan'], expected)
        self.assertEqual(parent['acceptedPlan'], previous)
        old = read_user_project(parent['candidateManifest'])
        new = read_user_project(child['candidateManifest'])
        self.assertEqual(validate_oip(old['scene'])['scene'], validate_oip(new['scene'])['scene'])
        self.assertEqual(json.loads(Path(new['hmi']).read_text(encoding='utf-8'))['name'], '6')
        self.assertEqual(_snapshot(self.project), self.baseline)

    def test_title_revision_rejects_mismatch_and_unsupported_request(self):
        from workbench_joint_candidate import preserve_title_revision
        for request, proposed in [('件数改成 6', self.plan), ('标题改成 6', {'hmi':None}),
                                  ('标题改成 6', {'hmi':{'title':'7'}})]:
            with self.assertRaises(AdapterError):
                preserve_title_revision(self.plan, proposed, request)

    def test_host_plan_generation_never_calls_provider_even_when_disabled(self):
        def forbidden(_):
            self.fail('Hidden provider dispatch')
        adapter=JointCandidateAdapters(self.home/'host-plan',model_request=forbidden,allow_model=False)
        public=adapter.planning_input(self.project)
        self.assertEqual(public['schemaVersion'],1)
        self.assertNotIn('acceptedPlan',public)
        parent=adapter.propose_joint_candidate(self.project,task_id='model-a',
            expected_revision=self.baseline['projectRevision'],request='生成候选',supplied_plan=self.plan,
            selected_route={'provider':'offline-a','model':'a'})
        proposed=copy.deepcopy(self.plan);proposed['hmi']['title']='6';proposed['oip']['value']='unrequested'
        child=adapter.propose_joint_candidate(self.project,task_id='model-b',
            expected_revision=self.baseline['projectRevision'],request='标题改成 6',supplied_plan=proposed,
            selected_route={'provider':'offline-b','model':'b'},revision_plan=parent['acceptedPlan'],revision_request='标题改成 6')
        self.assertEqual(child['acceptedPlan']['oip'],parent['acceptedPlan']['oip'])
        self.assertEqual(child['modelEvidence']['selectedRoute'],{'provider':'offline-b','model':'b'})
        self.assertFalse(child['modelCalled'])
        self.assertEqual(_snapshot(self.project),self.baseline)
        self.assertFalse(list((self.home/'host-plan').rglob('model-request.json')))

    def test_unknown_oip_identity_rejected(self):
        self.plan['oip']['partId'] = 'another-project-part'
        with self.assertRaises(AdapterError): self.propose()
        self.assertEqual(_snapshot(self.project), self.baseline)

    def test_hmi_unknown_script_or_tag_rejected(self):
        self.plan['hmi']['widgets'][1]['tag'] = 'write_runtime'
        with self.assertRaises(AdapterError): self.propose()
        self.assertFalse(list((self.home/'joint').rglob('candidate.json')))

    def test_completed_or_unknown_call_never_automatically_rebilled(self):
        def uncertain(messages):
            self.calls.append(messages)
            raise AdapterError('unknown_outcome', 'Provider response lost')
        self.adapter.model_request = uncertain
        for _ in range(2):
            with self.assertRaises(AdapterError) as error: self.propose()
            self.assertEqual(error.exception.code, 'unknown_outcome')
        self.assertEqual(len(self.calls), 1)
        receipt = json.loads((self.home/'joint/joint-test/model-request.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['status'], 'unknown_outcome')
        self.assertNotIn('Provider response lost', json.dumps(receipt))

    def test_source_change_during_model_is_not_overwritten(self):
        original = self.adapter.model_request
        def edited(messages):
            manifest = json.loads(self.fixture.manifest.read_text(encoding='utf-8'))
            manifest['name'] = 'User edit while model worked'
            fixtures.dump(self.fixture.manifest, manifest)
            return original(messages)
        self.adapter.model_request = edited
        with self.assertRaises(AdapterError) as error: self.propose()
        self.assertEqual(error.exception.code, 'conflict')
        self.assertEqual(json.loads(self.fixture.manifest.read_text(encoding='utf-8'))['name'], 'User edit while model worked')
        self.assertFalse(list((self.home/'joint').rglob('candidate.json')))

    def test_disabled_model_never_calls_or_creates_receipt(self):
        self.adapter.allow_model = False
        with self.assertRaises(AdapterError): self.propose()
        self.assertFalse(self.calls)
        self.assertFalse((self.home/'joint').exists())


if __name__ == '__main__': unittest.main()
