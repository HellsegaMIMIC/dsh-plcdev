"""First-scene planning and receipt boundaries; native execution has separate evidence."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import workbench_oip_tools as tools
from workbench_agent_adapters import AdapterError


class Creation(unittest.TestCase):
    def setUp(self):
        parent = tools.ROOT / 'outputs/oip-create-20261116/unit'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('base', 'candidate'):
            folder = self.root / name; folder.mkdir()
            (folder / 'project.plcdev').write_text(json.dumps({'simulation': {'provider': 'none', 'project': None}}), encoding='utf8')
        self.base = {'projectRoot': str(self.root / 'base'), 'manifestPath': str(self.root / 'base/project.plcdev'),
                     'simulation': {'provider': 'none', 'project': None}, 'scene': None}
        self.candidate = {**self.base, 'projectRoot': str(self.root / 'candidate'),
                          'manifestPath': str(self.root / 'candidate/project.plcdev')}
        records = patch.object(tools, 'RECEIPTS', self.root / 'receipts')
        records.start(); self.addCleanup(records.stop)

    def create_receipt_fixture(self):
        # A minimal schema fixture tests authenticity/path binding, not OIP's
        # creation algorithm. Production scenes only come from new_project.
        scene = self.root / 'candidate/integration/test/simulation/oip'
        scene.mkdir(parents=True)
        (scene / 'project.json').write_text(json.dumps({'version': 7, 'name': 'Fixture', 'scene': 'scene.json'}), encoding='utf8')
        (scene / 'scene.json').write_text(json.dumps({'version': 4, 'parts': []}), encoding='utf8')
        self.candidate['scene'] = str(scene / 'project.json')
        payload = {'id': 'd' * 32, 'phase': 'complete', 'operation': 'create',
            'identity': tools.identity(), 'calls': [], 'before': {}, 'after': tools._snapshot(self.candidate),
            'candidateRoot': str(self.root / 'candidate'),
            'creation': {'name': 'Fixture', 'scenePath': 'integration/test/simulation/oip/project.json'},
            'component': {'tool': 'oip', 'summary': 'native creation', 'operations': [], 'checks': [], 'nativeVersion': '2026.11.9'}}
        return tools._seal(payload)

    def test_creation_metadata_is_pure_read_and_keeps_existing_identity(self):
        files = sorted(self.root.rglob('*'))
        existing_identity = tools.identity()
        with patch.object(tools.subprocess, 'run', side_effect=AssertionError('must not launch')):
            first = tools.inspect_creation(self.base)
            second = tools.inspect_creation(self.base)
        self.assertEqual(first, second)
        self.assertEqual(files, sorted(self.root.rglob('*')))
        self.assertEqual({k: first[k] for k in existing_identity}, existing_identity)
        self.assertEqual(first['parts'], [])
        self.assertEqual(first['creation']['nativeTool']['name'], 'new_project')
        self.assertEqual(len(first['packages']), 37)

    def test_empty_calls_only_for_creation(self):
        self.assertEqual(tools.validate_calls([], allow_empty=True), [])
        with self.assertRaises(AdapterError): tools.validate_calls([])
        with self.assertRaises(AdapterError): tools.validate_calls([{'name': 'new_project', 'input': {'name': 'Nested'}}], allow_empty=True)
        with self.assertRaises(AdapterError): tools.validate_calls([{'name': 'get_scene', 'input': {}}] * 65, allow_empty=True)

    def test_native_name_validation(self):
        self.assertEqual(tools.validate_name('  首个场景  '), '首个场景')
        for name in ('', '   ', 'x' * 81, 'bad\nname', '<scene>', None):
            with self.subTest(name=name), self.assertRaises(AdapterError): tools.validate_name(name)

    def test_none_and_unattached_oip_intents_allowed(self):
        for intent in (None, {'provider': 'none', 'project': None}, {'provider': 'oip', 'project': None}):
            self.base['simulation'] = intent
            Path(self.base['manifestPath']).write_text(json.dumps({'simulation': intent}), encoding='utf8')
            self.assertTrue(tools.inspect_creation(self.base)['canCreate'])

    def test_existing_scene_and_other_simulation_are_never_overwritten(self):
        for intent in ({'provider': 'local-model', 'project': None}, {'provider': 'factoryio', 'project': 'world.factoryio'},
                       {'provider': 'oip', 'project': 'existing/project.json'}, {'provider': 'none', 'project': None, 'extra': 'keep me'}):
            self.base['simulation'] = intent
            with self.subTest(intent=intent), self.assertRaises(AdapterError): tools.inspect_creation(self.base)
        self.base['simulation'] = None; self.base['scene'] = 'existing/project.json'
        with self.assertRaises(AdapterError): tools.create_scene(self.base, 'Other', [])

    def test_actual_manifest_blocks_stale_descriptor(self):
        self.base.pop('simulation')
        Path(self.base['manifestPath']).write_text(json.dumps({'simulation': {'provider': 'local-model', 'model': {'saved': True}}}), encoding='utf8')
        with patch.object(tools.subprocess, 'run', side_effect=AssertionError('must not launch')):
            with self.assertRaises(AdapterError): tools.create_scene(self.base, 'Other', [])

    def test_create_receipt_is_read_only_and_binds_name_and_scene_path(self):
        receipt = self.create_receipt_fixture()
        with patch.object(tools.subprocess, 'run', side_effect=AssertionError('must not replay')):
            verified = tools.verify_receipt(self.base, self.candidate, [], receipt, creation_name='Fixture')
        self.assertEqual(verified['scenePath'], 'integration/test/simulation/oip/project.json')
        self.assertEqual(len(verified['files']), 2)
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, [], receipt, creation_name='Different')
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, [], receipt)

    def test_create_receipt_rejects_new_source_scene_or_changed_file(self):
        receipt = self.create_receipt_fixture()
        original = copy.deepcopy(self.base)
        self.base['scene'] = self.candidate['scene']
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, [], receipt, creation_name='Fixture')
        scene = Path(self.candidate['scene']).parent / 'scene.json'
        scene.write_bytes(scene.read_bytes() + b'\n')
        with self.assertRaises(AdapterError): tools.verify_receipt(original, self.candidate, [], receipt, creation_name='Fixture')

    def test_creation_operation_or_path_cannot_be_forged_by_rehashing(self):
        receipt = self.create_receipt_fixture()
        path = tools.RECEIPTS / (receipt['id'] + '.json')
        record = json.loads(path.read_text('utf8'))
        record['payload']['creation']['scenePath'] = 'another/project.json'
        receipt['digest'] = tools._digest(record['payload'])
        path.write_text(json.dumps(record), encoding='utf8')
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, [], receipt, creation_name='Fixture')


if __name__ == '__main__':
    unittest.main()
