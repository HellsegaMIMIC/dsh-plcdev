"""Boundaries of OIP's native candidate adapter; no editor is launched here."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import workbench_oip_tools as tools
from workbench_agent_adapters import AdapterError


class Calls(unittest.TestCase):
    def test_native_allowed_and_previous_id_reference(self):
        calls = [{'name': 'add_part', 'input': {'package': 'oip.box', 'position': [1, 2, 3]}},
                 {'name': 'snap_part', 'input': {'id': {'$result': 0, 'path': 'id'}, 'onto': 'pt_1'}}]
        self.assertEqual(tools.validate_calls(calls), calls)
        self.assertEqual(tools.resolve_input(calls[1]['input'], [{'id': 'native_204'}]), {'id': 'native_204', 'onto': 'pt_1'})

    def test_reject_runtime_code_io_assignment_and_unknown_fields(self):
        cases = [
            {'name': 'run', 'input': {}}, {'name': 'assign_io', 'input': {'list': 'anything'}},
            {'name': 'open_project', 'input': {'path': 'C:/user'}},
            {'name': 'check_part', 'input': {'id': 'oip.box', 'behavior': 'code'}},
            {'name': 'update_part', 'input': {'id': 'pt_1', 'plcs': []}},
            {'name': 'add_part', 'input': {'package': 'oip.box', 'position': [1, 2]}},
            {'name': 'update_part', 'input': {'id': 'pt_1', 'rotationY': float('nan')}},
            {'name': 'update_part', 'input': {'id': {'$result': 0, 'path': 'id'}, 'name': 'future'}},
        ]
        for item in cases:
            with self.subTest(item=item), self.assertRaises(AdapterError):
                tools.validate_calls([item])

    def test_check_only_accepts_existing_definition(self):
        self.assertEqual(tools.validate_calls([{'name': 'check_part', 'input': {'id': 'oip.box'}}])[0]['input']['id'], 'oip.box')


class Receipt(unittest.TestCase):
    def setUp(self):
        evidence = Path(os.environ.get('PLCDEV_RELEASE_TEST_ROOT', tools.ROOT / 'outputs/oip-native-20261116/unit'))
        evidence.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=evidence)
        self.root = Path(self.temporary.name)
        for name in ('base', 'candidate'):
            # Test receipt authenticity with self-contained schema fixtures.
            # No teaching scene, native assets or external editor are required.
            scene = self.root / name / 'scene'
            scene.mkdir(parents=True)
            (scene / 'project.json').write_text(json.dumps({'version': 7, 'name': 'Receipt fixture', 'scene': 'scene.json'}), encoding='utf8')
            part = {'id': 'pt_1', 'name': 'Candidate' if name == 'candidate' else 'Source',
                    'package': 'oip.belt-conveyor', 'position': [0, 0, 0], 'params': {'speed': 1}}
            (scene / 'scene.json').write_text(json.dumps({'version': 4, 'parts': [part]}), encoding='utf8')
        self.base = {'projectRoot': str(self.root / 'base'), 'scene': str(self.root / 'base/scene')}
        self.candidate = {'projectRoot': str(self.root / 'candidate'), 'scene': str(self.root / 'candidate/scene')}
        self.calls = [{'name': 'update_part', 'input': {'id': 'pt_1', 'name': 'Candidate'}}]
        self.record_patch = patch.object(tools, 'RECEIPTS', self.root / 'receipt-state')
        self.record_patch.start()
        self.addCleanup(self.record_patch.stop)
        self.addCleanup(self.temporary.cleanup)

    def seal(self):
        payload = {'id': 'a' * 32, 'phase': 'complete', 'identity': tools.identity(), 'calls': self.calls,
                   'before': tools._snapshot(self.base), 'after': tools._snapshot(self.candidate),
                   'candidateRoot': str(Path(self.candidate['projectRoot']).resolve()),
                   'component': {'tool': 'oip', 'summary': 'native', 'operations': [], 'checks': [], 'nativeVersion': '2026.11.9'}}
        return tools._seal(payload)

    def test_verify_is_read_only_and_does_not_replay(self):
        receipt = self.seal()
        with patch.object(tools.subprocess, 'run', side_effect=AssertionError('must not execute')):
            first = tools.verify_receipt(self.base, self.candidate, self.calls, receipt)
            second = tools.verify_receipt(self.base, self.candidate, self.calls, receipt)
        self.assertEqual(first, second)
        self.assertIn('scene/scene.json', first['files'])

    def test_changed_calls_source_or_candidate_are_rejected(self):
        receipt = self.seal()
        alternate = copy.deepcopy(self.calls); alternate[0]['input']['name'] = 'Other'
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, alternate, receipt)
        scene = self.root / 'candidate/scene/scene.json'
        scene.write_bytes(scene.read_bytes() + b'\n')
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, self.calls, receipt)

    def test_component_forgery_even_with_rehashed_receipt_is_rejected(self):
        receipt = self.seal()
        file = tools.RECEIPTS / (receipt['id'] + '.json')
        record = json.loads(file.read_text('utf8'))
        record['payload']['component']['checks'] = [{'id': 'invented', 'status': 'passed'}]
        file.write_text(json.dumps(record), encoding='utf8')
        receipt['digest'] = tools._digest(record['payload'])
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, self.calls, receipt)

    def test_incomplete_receipt_and_wrong_directory_rejected(self):
        receipt = self.seal()
        copied = copy.deepcopy(self.candidate); copied['projectRoot'] = str(self.root / 'base'); copied['scene'] = self.base['scene']
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, copied, self.calls, receipt)
        with self.assertRaises(AdapterError): tools.verify_receipt(self.base, self.candidate, self.calls, {'id': '../a'})

    def test_inspection_is_stable_without_renderer(self):
        with patch.object(tools.subprocess, 'run', side_effect=AssertionError('must not execute')):
            first = tools.inspect_tools(self.base)
            second = tools.inspect_tools(self.base)
        self.assertEqual(first, second)
        self.assertEqual(first['nativeVersion'], '2026.11.9')
        conveyor = next(p for p in first['packages'] if p['id'] == 'oip.belt-conveyor')
        self.assertEqual(conveyor['tagParams']['runTag']['dir'], 'in')
        self.assertEqual(conveyor['tagParams']['runTag']['stType'], 'BOOL')
        self.assertNotIn('assign_io', [t['name'] for t in first['tools']])


if __name__ == '__main__':
    unittest.main()
