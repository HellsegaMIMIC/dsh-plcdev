"""Offline event ledger tests. No tool, model, or Runtime is started."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from workbench_runtime_events import RuntimeEventStore, MAX_EVENTS, MAX_FILE, existing_task_records, runtime_events

PROJECT = 'user-events-fixture'
REVISION = 'a' * 64
PROGRAM = 'b' * 64
TASK = 'task-' + 'c' * 32


class RuntimeEventTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / 'outputs' / 'runtime-events-20261117'
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='fixture-', dir=root)
        self.home = Path(self.temporary.name).resolve()
        assert self.home.is_relative_to(root.resolve())
        self.addCleanup(self.temporary.cleanup)
        self.now = 1800000000.0
        self.reader = Mock(return_value=[])
        self.store = RuntimeEventStore(self.home, clock=lambda: self.now, task_reader=self.reader)
        self.snapshot = {'project': {'id': PROJECT}, 'mode': 'fuxa-local', 'phase': 'idle', 'error': None,
            'session': {'id': None, 'active': False, 'programHash': None}, 'observerFresh': False,
            'state': {'observedAt': None, 'runtimeState': 'UNKNOWN', 'variables': []}, 'links': {},
            'dependencies': [{'id': 'runtime', 'available': True}, {'id': 'msys', 'available': True}],
            'events': [], 'components': {}, 'toolErrors': {}}

    def read(self, tasks=None):
        return self.store.collect(PROJECT, self.snapshot, tasks=[] if tasks is None else tasks)

    def active_runtime(self, session='session-1'):
        self.snapshot.update(phase='ready', observerFresh=True)
        self.snapshot['session'] = {'id': session, 'active': True, 'programHash': PROGRAM}
        self.snapshot['state'].update(observedAt=self.now, runtimeState='RUNNING')

    def task(self, **extra):
        return {'projectId': PROJECT, 'taskId': TASK, 'projectRevision': REVISION,
                'createdAt': self.now - 10, 'updatedAt': self.now, 'status': 'awaiting_review', **extra}

    def test_polls_do_not_append_count_or_write_and_service_reads_are_cached(self):
        self.active_runtime()
        first = self.store.collect(PROJECT, self.snapshot)
        path = self.home / (PROJECT + '.json')
        raw, modified = path.read_bytes(), path.stat().st_mtime_ns
        self.now += 1
        self.snapshot['state']['observedAt'] = self.now
        second = self.store.collect(PROJECT, self.snapshot)
        self.assertEqual(first['events'], second['events'])
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(path.stat().st_mtime_ns, modified)
        self.assertEqual(self.reader.call_count, 1)
        self.now += 10
        self.store.collect(PROJECT, self.snapshot)
        self.assertEqual(self.reader.call_count, 2)

    def test_runtime_recovery_requires_fresh_identity_and_recurrence_preserves_history(self):
        self.active_runtime()
        self.snapshot['observerFresh'] = False
        failed = self.read()['events'][0]
        self.assertEqual(failed['status'], 'active')
        self.assertEqual(failed['sessionId'], 'session-1')
        self.assertEqual(failed['programHash'], PROGRAM)
        self.now += 5
        self.assertEqual(self.read()['events'][0]['count'], 1)
        self.active_runtime()
        recovered = next(e for e in self.read()['events'] if e['severity'] == 'error')
        self.assertEqual(recovered['status'], 'resolved')
        self.now += 5
        self.snapshot['observerFresh'] = False
        events = [e for e in self.read()['events'] if e['severity'] == 'error']
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['id'], failed['id'])
        self.assertEqual(events[0]['status'], 'resolved')
        self.assertIn('resolvedAt', events[0])
        recurring = events[1]
        self.assertNotEqual(recurring['id'], failed['id'])
        self.assertEqual(recurring['count'], 1)
        self.assertNotIn('resolvedAt', recurring)

    def test_new_runtime_does_not_resolve_previous_instance_fault(self):
        self.active_runtime('old-session')
        self.snapshot['observerFresh'] = False
        self.read()
        self.now += 1
        self.active_runtime('new-session')
        result = self.read()
        self.assertEqual(result['currentSessionId'], 'new-session')
        old = next(e for e in result['events'] if e['sessionId'] == 'old-session')
        self.assertEqual(old['status'], 'active')

    def test_runtime_lifecycle_is_recorded_and_changes_only_on_transition(self):
        self.active_runtime()
        self.read()
        self.now += 1
        self.snapshot['state'].update(observedAt=self.now, runtimeState='STOPPED')
        events = self.read()['events']
        self.assertEqual(len(events), 2)
        self.assertTrue(all(e['status'] == 'recorded' and e['severity'] == 'info' for e in events))

    def test_fuxa_communication_does_not_claim_plc_stopped(self):
        self.active_runtime()
        self.snapshot.update(hmiOpen=True)
        self.snapshot['links']['variables'] = {'state': 'disconnected'}
        event = next(e for e in self.read()['events'] if e['source'] == 'fuxa')
        self.assertEqual(event['status'], 'active')
        self.assertEqual(self.snapshot['state']['runtimeState'], 'RUNNING')
        self.now += 1
        self.snapshot['links']['variables']['state'] = 'unknown'
        self.assertEqual(next(e for e in self.read()['events'] if e['source'] == 'fuxa')['status'], 'active')
        self.snapshot['links']['variables']['state'] = 'connected'
        self.assertEqual(next(e for e in self.read()['events'] if e['source'] == 'fuxa')['status'], 'active')
        self.snapshot['links']['variables']['channelConnected'] = True
        self.assertEqual(next(e for e in self.read()['events'] if e['source'] == 'fuxa')['status'], 'resolved')

    def test_fuxa_data_recovery_needs_fresh_values_not_just_channel_or_stopped_state(self):
        self.active_runtime()
        self.snapshot['links']['variables'] = {'state': 'connected', 'channelConnected': True, 'dataFresh': False}
        self.read()
        self.snapshot['state']['runtimeState'] = 'STOPPED'
        self.assertEqual(next(e for e in self.read()['events'] if e['origin'] == 'fuxa/data')['status'], 'active')
        self.snapshot['links']['variables']['dataFresh'] = True
        self.snapshot['observerFresh'] = False
        self.assertEqual(next(e for e in self.read()['events'] if e['origin'] == 'fuxa/data')['status'], 'active')
        self.snapshot['observerFresh'] = True
        self.assertEqual(next(e for e in self.read()['events'] if e['origin'] == 'fuxa/data')['status'], 'resolved')

    def test_missing_dependencies_require_proven_availability_to_resolve(self):
        self.snapshot['dependencies'][0]['available'] = False
        self.read()
        self.snapshot['dependencies'][0]['available'] = None
        self.assertEqual(self.read()['events'][0]['status'], 'active')
        self.snapshot['dependencies'][0]['available'] = True
        self.assertEqual(self.read()['events'][0]['status'], 'resolved')

    def test_launch_error_only_resolves_after_verified_project_open(self):
        self.active_runtime()
        self.snapshot['toolErrors']['oip'] = 'Open failed'
        event = next(e for e in self.read()['events'] if e['source'] == 'oip')
        self.assertIsNone(event['sessionId'])
        self.snapshot['toolErrors'] = {}
        self.snapshot['components']['factory'] = {'state': 'process-alive', 'projectOpenVerified': False}
        self.assertEqual(next(e for e in self.read()['events'] if e['source'] == 'oip')['status'], 'active')
        self.snapshot['components']['factory']['projectOpenVerified'] = True
        self.assertEqual(next(e for e in self.read()['events'] if e['source'] == 'oip')['status'], 'resolved')

    def test_native_check_and_compile_use_real_versions_never_current_session(self):
        self.active_runtime()
        task = self.task(compilation={'status': 'compile_failed', 'sourceRevision': REVISION, 'diagnostic': 'line 3: invalid type'},
            candidate={'candidateDigest': REVISION, 'components': [{'tool': 'oip', 'checks': [
                {'id': 'wiring', 'label': '场景与信号检查', 'status': 'warning', 'summary': '1 个提醒'},
                {'id': 'external-runtime', 'label': '外部运行', 'status': 'skipped'}]}]})
        events = self.read([task])['events']
        checks = [e for e in events if e['source'] in ('compiler', 'oip')]
        self.assertEqual(len(checks), 2)
        self.assertTrue(all(e['projectRevision'] == REVISION and e['sessionId'] is None for e in checks))
        self.assertEqual(next(e for e in checks if e['source'] == 'oip')['phase'], '候选检查')
        task['compilation']['status'] = 'compiled'
        task['updatedAt'] += 1
        self.now += 1
        events = self.read([task])['events']
        self.assertEqual(next(e for e in events if e['source'] == 'compiler' and e['severity'] == 'error')['status'], 'resolved')
        self.assertTrue(any(e['source'] == 'compiler' and e['severity'] == 'info' for e in events))

    def test_discarded_native_check_is_historical_not_falsely_repaired(self):
        task = self.task(candidate={'components': [{'tool': 'oip', 'checks': [{'id': 'check', 'label': '检查', 'status': 'failed'}]}]})
        self.read([task])
        task['status'] = 'discarded'
        event = self.read([task])['events'][0]
        self.assertEqual(event['status'], 'recorded')
        self.assertNotIn('resolvedAt', event)
        self.assertEqual(len(self.read([task])['events']), 1)

    def test_real_repeated_messages_merge_and_legacy_ownership_stays_unknown(self):
        self.active_runtime()
        self.snapshot['events'] = [{'at': self.now-2, 'message': 'check failed'}, {'at': self.now-1, 'message': 'check failed'}]
        event = next(e for e in self.read()['events'] if e['origin'] == 'controller/events')
        self.assertEqual(event['count'], 2)
        self.assertIsNone(event['sessionId'])
        self.assertEqual(event['severity'], 'info')
        self.assertEqual(next(e for e in self.read()['events'] if e['origin'] == 'controller/events')['count'], 2)

    def test_credentials_are_removed_and_only_selected_task_fields_are_returned(self):
        task = self.task(compilation={'status': 'compile_failed', 'diagnostic': 'password=not-public\n{"apiKey":"not-public-either"}\nBearer fake-secret'},
                         planningInput={'sensitive': 'private-source-catalog'})
        encoded = json.dumps(self.read([task]))
        for secret in ('not-public', 'fake-secret', 'private-source-catalog'):
            self.assertNotIn(secret, encoded)
        self.assertIn('[redacted]', encoded)

    def test_unavailable_tasks_preserve_failure_without_service_start(self):
        task = self.task(status='failed', reason='Inspect task')
        self.read([task])
        self.reader.side_effect = OSError('fixture service unavailable')
        result = self.store.collect(PROJECT, self.snapshot)
        self.assertEqual(result['events'][0]['status'], 'active')
        self.assertEqual(next(s for s in result['sources'] if s['id'] == 'compiler')['state'], 'unavailable')
        with patch('agent_task_service.DESCRIPTOR', self.home/'absent.json'), patch('agent_task_service.ensure') as start:
            with self.assertRaises(OSError): existing_task_records(PROJECT)
            start.assert_not_called()

    def test_persistent_bounded_ledger_and_project_isolation(self):
        for index in range(MAX_EVENTS + 20):
            self.snapshot['events'] = [{'at': self.now, 'message': 'operation ' + str(index)}]
            self.now += 1
            self.read()
        saved = self.home/(PROJECT+'.json')
        self.assertLessEqual(saved.stat().st_size, MAX_FILE)
        restored = RuntimeEventStore(self.home, clock=lambda: self.now)
        result = restored.collect(PROJECT, self.snapshot, tasks=[])
        self.assertEqual(len(result['events']), MAX_EVENTS)
        with self.assertRaises(ValueError): restored.collect('../other', self.snapshot, tasks=[])
        with self.assertRaises(ValueError): restored.collect(PROJECT, {'project': {'id':'other'}}, tasks=[])
        with self.assertRaises(ValueError): restored.collect(PROJECT, self.snapshot, tasks=[self.task(projectId='other')])

    def test_invalid_ledger_is_preserved_instead_of_overwritten(self):
        path = self.home/(PROJECT+'.json')
        path.write_text('{"schemaVersion":1,"projectId":"other"}', encoding='utf8')
        before = path.read_bytes()
        with self.assertRaises(ValueError): self.read()
        self.assertEqual(path.read_bytes(), before)

    def test_endpoint_resolves_registered_project_before_snapshot(self):
        manager = Mock()
        manager.resolve.side_effect = ValueError('Unregistered')
        with self.assertRaises(ValueError): runtime_events(manager, PROJECT, home=self.home)
        manager.snapshot.assert_not_called()


if __name__ == '__main__':
    unittest.main()
