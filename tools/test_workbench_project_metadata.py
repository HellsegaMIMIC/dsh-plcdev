"""Offline catalog modification-time tests; write only generated test sources."""
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
import argparse
import io
import json
import os
import tempfile
import types
import unittest

import workbench_project_metadata as metadata

args = types.SimpleNamespace(temp_root=Path(__file__).resolve().parents[1] / 'outputs/test-project-metadata')

class MetadataContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        args.temp_root.mkdir(parents=True, exist_ok=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=args.temp_root)
        self.root = Path(self.temp.name)
        self.project = {'id': 'test', 'plc': str(self.root / 'plc/project.json'),
                        'manifestPath': str(self.root / 'project.plcdev'),
                        'hmi': str(self.root / 'hmi/main.fuxap'),
                        'scene': str(self.root / 'oip/project.json'),
                        'configuration': {'interfaceFile': 'interface.json'}}
        self.write('plc/project.json', '{}')
        self.write('plc/pous/programs/main.st', 'PROGRAM main END_PROGRAM')
        self.write('project.plcdev', '{}')
        self.write('hmi/main.fuxap', '{}')
        self.write('interface.json', '{}')
        self.write('oip/project.json', json.dumps({'scene': 'scene.json', 'program': ['main.st'],
                                                  'tests': ['test.json'], 'packages': ['parts']}))
        self.write('oip/scene.json', '{}')
        self.write('oip/main.st', 'PROGRAM main END_PROGRAM')
        self.write('oip/test.json', '{}')
        self.write('oip/parts/manifest.json', '{}')
        self.write('oip/parts/asset.json', '{}')
        self.old = 1700000000
        self.set_all_times(self.old)

    def tearDown(self):
        self.root.resolve().relative_to(args.temp_root.resolve())
        self.temp.cleanup()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def set_all_times(self, value):
        for path in self.root.rglob('*'):
            os.utime(path, (value, value))

    def iso(self, value):
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def test_each_saved_tool_source_can_advance_project_modification(self):
        for name in ('project.plcdev', 'plc/pous/programs/main.st', 'hmi/main.fuxap',
                     'interface.json', 'oip/scene.json', 'oip/main.st', 'oip/test.json',
                     'oip/parts/asset.json'):
            with self.subTest(source=name):
                self.set_all_times(self.old)
                os.utime(self.root / name, (self.old + 100, self.old + 100))
                self.assertEqual(metadata.saved_project_modified_at(self.project), self.iso(self.old + 100))

    def test_runtime_build_index_and_hidden_state_are_not_modifications(self):
        paths = ['index.json', 'runtime/log.txt', 'plc/build/program.exe', 'plc/.state.json',
                 'plc/pous/.cache/item', 'oip/.godot/cache', 'oip/parts/build/generated.json']
        for name in paths:
            self.write(name, 'unrelated')
        self.set_all_times(self.old)
        for name in paths:
            os.utime(self.root / name, (self.old + 100, self.old + 100))
        self.assertEqual(metadata.saved_project_modified_at(self.project), self.iso(self.old))

    def test_missing_required_source_returns_unknown_not_partial_latest(self):
        (self.root / 'hmi/main.fuxap').unlink()
        self.assertIsNone(metadata.saved_project_modified_at(self.project))

    def test_basic_plc_project_needs_no_hmi_or_scene(self):
        self.assertEqual(metadata.saved_project_modified_at({'plc': self.project['plc']}), self.iso(self.old))

    def test_large_tree_fails_closed_including_ignored_entries(self):
        self.assertIsNone(metadata.saved_project_modified_at(self.project, limit=2))
        for index in range(20):
            self.write('plc/pous/.ignored-' + str(index), '')
        self.assertIsNone(metadata.saved_project_modified_at({'plc': self.project['plc']}, limit=10))

    def test_oip_references_cannot_escape_or_expand_to_project_root(self):
        for value in ('../outside.json', '.', 'C:/outside.json', '/outside.json'):
            with self.subTest(reference=value):
                self.write('oip/project.json', json.dumps({'scene': value}))
                self.assertIsNone(metadata.saved_project_modified_at(self.project))

    def test_invalid_and_oversize_oip_metadata_are_unknown(self):
        for content in ('[]', '{broken', json.dumps({'scene': 'scene.json', 'program': {}})):
            self.write('oip/project.json', content)
            self.assertIsNone(metadata.saved_project_modified_at(self.project))
        self.write('oip/project.json', ' ' * (metadata.MAX_PROJECT_JSON + 1))
        self.assertIsNone(metadata.saved_project_modified_at(self.project))

    def test_unreadable_and_reparse_sources_return_unknown(self):
        with patch.object(metadata.Path, 'lstat', side_effect=PermissionError('blocked')):
            self.assertIsNone(metadata.saved_project_modified_at(self.project))
        with patch.object(metadata.Path, 'lstat', return_value=types.SimpleNamespace(st_mode=0, st_file_attributes=0x400)):
            self.assertIsNone(metadata.saved_project_modified_at(self.project))

    def test_legacy_bindings_are_saved_sources(self):
        path = self.write('bindings.json', '{}')
        os.utime(path, (self.old + 200, self.old + 200))
        project = {**self.project, 'bindingsPath': str(path)}
        self.assertEqual(metadata.saved_project_modified_at(project), self.iso(self.old + 200))

    def test_cache_reuses_metadata_then_refreshes_and_keeps_unknown(self):
        cache = metadata.ProjectModificationCache(ttl=5)
        with patch.object(metadata.time, 'monotonic', side_effect=[10, 11, 16, 17]), \
                patch.object(metadata, 'saved_project_modified_at', side_effect=['old', None]) as read:
            self.assertEqual(cache.get(self.project), 'old')
            self.assertEqual(cache.get(self.project), 'old')
            self.assertIsNone(cache.get(self.project))
            self.assertIsNone(cache.get(self.project))
            self.assertEqual(read.call_count, 2)

    def test_cache_invalidates_when_saved_version_paths_change(self):
        cache = metadata.ProjectModificationCache()
        with patch.object(metadata, 'saved_project_modified_at', side_effect=['old', 'new']) as read:
            self.assertEqual(cache.get(self.project), 'old')
            self.assertEqual(cache.get({**self.project, 'hmi': str(self.root / 'new-hmi.fuxap')}), 'new')
            self.assertEqual(read.call_count, 2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--temp-root', type=Path, default=Path(__file__).resolve().parents[1] / 'outputs/ui-catalog-filter-20261118/test-temp')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    args.temp_root.mkdir(parents=True, exist_ok=True)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(MetadataContract))
    report = {'passed': result.wasSuccessful(), 'tests': result.testsRun, 'failures': len(result.failures),
              'errors': len(result.errors), 'scope': 'generated files only; no Runtime, GUI, network or project writes',
              'details': stream.getvalue()}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'details'}, ensure_ascii=False))
    if not result.wasSuccessful():
        print(stream.getvalue())
    raise SystemExit(0 if result.wasSuccessful() else 1)
