"""Declaration boundaries, compiler symbols and typed local operations; no live process."""
from copy import deepcopy
import json
from pathlib import Path
import struct
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from project_interface import ai_context, bind_interface, interface_hash, operation_value, validate_interface
from project_interface_inputs import counter_input_paths, input_leaves, validate_input_request, write_bool_input, clear_local_inputs
from workbench_projects import ProjectCatalog, read_user_project
from workbench_project_config import configure_interface_project
from workbench_user_project import UserProjectManager


def contract():
    return {'schemaVersion':1, 'protocol':'project-interface-v1', 'title':'风机',
        'variables':[
            {'id':'start', 'label':'启动', 'path':'Fan.StartRequest', 'type':'BOOL', 'access':'readwrite', 'aiVisible':True},
            {'id':'setpoint', 'label':'设定', 'path':'Fan.Speed', 'type':'INT', 'access':'readwrite', 'aiVisible':True, 'min':0, 'max':100},
            {'id':'gain', 'label':'增益', 'path':'Fan.Gain', 'type':'REAL', 'access':'readwrite', 'aiVisible':True, 'min':0.0, 'max':10.0},
            {'id':'actual', 'label':'实际值', 'path':'Fan.Actual', 'type':'REAL', 'access':'read', 'aiVisible':True},
            {'id':'service', 'label':'检修', 'path':'Fan.Service', 'type':'BOOL', 'access':'readwrite', 'aiVisible':False}],
        'operations':[
            {'id':'start_fan', 'label':'启动', 'kind':'pulse', 'variable':'start', 'value':True, 'durationMs':100, 'enabled':True, 'aiVisible':True},
            {'id':'apply_speed', 'label':'应用速度', 'kind':'write', 'variable':'setpoint', 'valueFrom':'input', 'enabled':True, 'aiVisible':True},
            {'id':'apply_gain', 'label':'应用增益', 'kind':'write', 'variable':'gain', 'valueFrom':'input', 'enabled':True, 'aiVisible':True},
            {'id':'service_on', 'label':'检修开启', 'kind':'write', 'variable':'service', 'value':True, 'enabled':True, 'aiVisible':True}]}


def leaves():
    return [dict(path=v['path'].upper(), type=v['type'], size={'BOOL':1,'INT':2,'REAL':4}[v['type']], arrayIdx=i, elemIdx=0)
            for i,v in enumerate(contract()['variables'])]


def manifest():
    definition=contract()
    return dict(mode='local', physicalHardware=False, locatedAddresses=[], projectInterface=definition,
                projectInterfaceHash=interface_hash(definition), localInputPaths=[v['path'].upper() for v in definition['variables'] if v['access']=='readwrite'])


def write(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')


class DeclarationTests(unittest.TestCase):
    def test_declaration_roundtrip_is_detached_and_hash_stable(self):
        original=contract(); validated=validate_interface(original)
        self.assertEqual(validated,original);validated['variables'][0]['label']='Changed'
        self.assertNotEqual(validated,original)
        self.assertEqual(interface_hash(original),interface_hash(json.loads(json.dumps(original,sort_keys=True))))

    def test_unknown_fields_and_missing_permissions_fail_closed(self):
        mutations=[lambda d:d.update(endpoint='http://remote'),lambda d:d['variables'][0].update(password='secret'),
                   lambda d:d['operations'][0].update(script='run()'),lambda d:d['variables'][0].pop('aiVisible'),
                   lambda d:d['operations'][0].pop('enabled'),lambda d:d.update(schemaVersion=True)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                d=contract();mutate(d)
                with self.assertRaises(ValueError):validate_interface(d)

    def test_duplicate_ids_paths_and_reserved_names_rejected(self):
        mutations=[lambda d:d['variables'][1].update(id='START'),lambda d:d['variables'][1].update(path='fan.startrequest'),
                   lambda d:d['operations'][1].update(id='START_FAN'),lambda d:d['variables'][0].update(id='constructor'),
                   lambda d:d['variables'][0].update(path='Start'),lambda d:d['variables'][0].update(id='中文')]
        for mutate in mutations:
            d=contract();mutate(d)
            with self.assertRaises(ValueError):validate_interface(d)

    def test_numeric_ranges_match_wire_types(self):
        mutations=[lambda d:d['variables'][1].update(max=32768),lambda d:d['variables'][1].update(min=True),
                   lambda d:d['variables'][1].pop('min'),lambda d:d['variables'][2].update(max=float('nan')),
                   lambda d:d['variables'][2].update(max=1e80),lambda d:d['variables'][2].update(min=11),
                   lambda d:d['variables'][0].update(min=0,max=1)]
        for mutate in mutations:
            d=contract();mutate(d)
            with self.assertRaises(ValueError):validate_interface(d)

    def test_operation_permissions_and_modes_rejected(self):
        mutations=[lambda d:d['operations'][1].update(variable='actual'),lambda d:d['operations'][1].update(variable='missing'),
                   lambda d:d['operations'][1].update(value=9),lambda d:d['operations'][1].update(valueFrom='script'),
                   lambda d:d['operations'][0].update(durationMs=99),lambda d:d['operations'][0].update(durationMs=2001),
                   lambda d:d['operations'][0].update(value=False),lambda d:d['operations'][0].update(variable='setpoint'),
                   lambda d:d['operations'][0].update(enabled=1),lambda d:d['variables'][0].update(aiVisible=1)]
        for mutate in mutations:
            d=contract();mutate(d)
            with self.assertRaises(ValueError):validate_interface(d)

    def test_ai_projection_excludes_hidden_and_disabled_capabilities(self):
        d=contract();d['operations'][1]['enabled']=False
        context=ai_context(d)
        self.assertNotIn('service',{v['id'] for v in context['variables']})
        self.assertEqual({op['id'] for op in context['operations']},{'start_fan','apply_gain'})
        self.assertTrue(operation_value(d,'service_on')[2])

    def test_input_values_fixed_values_and_disabled_operations(self):
        self.assertEqual(operation_value(contract(),'apply_speed',25)[2],25)
        self.assertEqual(operation_value(contract(),'apply_gain',1.5)[2],1.5)
        for value in (-1,101,True,4.2,'25',None):
            with self.assertRaises(ValueError):operation_value(contract(),'apply_speed',value)
        with self.assertRaises(ValueError):operation_value(contract(),'start_fan',False)
        d=contract();d['operations'][0]['enabled']=False
        with self.assertRaises(ValueError):operation_value(d,'start_fan')
        with self.assertRaises(ValueError):operation_value(d,'missing')

    def test_compiler_mapping_uses_real_case_insensitive_paths_and_types(self):
        bound=bind_interface(contract(),leaves())
        self.assertEqual(bound['setpoint']['path'],'FAN.SPEED')
        for mutate in (lambda d:d.pop(), lambda d:d[1].update(type='REAL',size=4),lambda d:d[0].update(size=2),
                       lambda d:d[1].update(path='FAN.STARTREQUEST'),lambda d:d[1].update(arrayIdx=0),lambda d:d[0].update(arrayIdx=256)):
            data=leaves();mutate(data)
            with self.assertRaises(ValueError):bind_interface(contract(),data)


class RuntimeInputTests(unittest.TestCase):
    def request(self, **changes):
        return dict(operationId='apply_speed', projectInterfaceHash=interface_hash(contract()),inputPath='FAN.SPEED',value=25,**changes)

    def test_runtime_revalidates_permissions_type_path_contract_and_freshness(self):
        request=self.request()
        self.assertEqual(validate_input_request(request,manifest(),leaves(),'RUNNING',True)['type'],'INT')
        for patch_value in ({'value':101},{'operationId':'service_on'},{'inputPath':'FAN.ACTUAL'}, {'projectInterfaceHash':'stale'}, {'operationPhase':'release'}):
            with self.assertRaises(ValueError):validate_input_request(dict(request,**patch_value),manifest(),leaves(),'RUNNING',True)
        for state,fresh in [('STOPPED',True),('RUNNING',False)]:
            with self.assertRaises(ValueError):validate_input_request(request,manifest(),leaves(),state,fresh)

    def test_manifest_permissions_cannot_expand_or_change_mode(self):
        for update in ({'mode':'factoryio'},{'physicalHardware':True},{'localInputPaths':['FAN.ACTUAL']},{'projectInterfaceHash':'bad'},{'locatedAddresses':['%IX0.0']}):
            self.assertEqual(input_leaves(dict(manifest(),**update),leaves()),{})

    def test_typed_debug_packets_and_release(self):
        client=Mock();client.debug.return_value=b'\x42\x7e'
        for index,value,expected in [(0,True,b'\x01'),(1,42,struct.pack('<h',42)),(2,1.5,struct.pack('<f',1.5))]:
            leaf=leaves()[index];write_bool_input(client,leaf,value)
            packet=client.debug.call_args.args[0]
            self.assertEqual(packet[:5],bytes([0x42,index,0,0,1]));self.assertEqual(packet[5:7],struct.pack('>H',len(expected)))
            self.assertEqual(packet[7:],expected)
        write_bool_input(client,leaves()[1],None)
        self.assertEqual(client.debug.call_args.args[0],b'\x42\x01\x00\x00\x00\x00\x00')

    def test_packet_bad_type_and_runtime_rejection(self):
        client=Mock();client.debug.return_value=b'error'
        with self.assertRaises(RuntimeError):write_bool_input(client,leaves()[0],True)
        with self.assertRaises(ValueError):write_bool_input(client,leaves()[1],True)
        with self.assertRaises(ValueError):write_bool_input(client,leaves()[2],float('nan'))

    def test_cleanup_releases_numeric_force_without_inventing_a_value(self):
        client=Mock();client.debug.return_value=b'\x42\x7e'
        clear_local_inputs(client,input_leaves(manifest(),leaves()))
        numeric=[call.args[0] for call in client.debug.call_args_list if call.args[0][1] in (1,2)]
        self.assertEqual(len(numeric),2);self.assertTrue(all(packet[4:]==b'\x00\x00\x00' for packet in numeric))

    def test_prepare_boundary_rejects_locations_plugins_and_mismatched_symbols(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);write(root/'project.json',{'data':{}});write(root/'project-interface.json',contract())
            self.assertEqual(counter_input_paths(root,'local','PROGRAM main END_PROGRAM',leaves()),manifest()['localInputPaths'])
            for mode,program in [('factoryio',''),('local','x AT %IX0.0 : BOOL;'),('local','{external x}')]:
                self.assertEqual(counter_input_paths(root,mode,program,leaves()),[])
            write(root/'devices/pin-mapping.json',{'pin':1})
            self.assertEqual(counter_input_paths(root,'local','',leaves()),[])


class ProjectIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='project-interface-');self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();source=self.base/'source'
        write(source/'project.json',{'meta':{'type':'plc-project','name':'Fan'},'data':{}})
        self.catalog=ProjectCatalog(index_path=self.base/'machine/index.json',editor_path=self.base/'missing.exe')
        self.project=self.catalog.create('Fan',str(self.base/'projects'),source=str(source))

    @staticmethod
    def cli(command, contract_path, project=None, output=None):
        if command=='reference':
            write(output,{'version':'1.01','devices':{'d_plcdev_project':{'property':{'getTags':'/plcdev/tags'}}},
                          'hmi':{'views':[{'svgcontent':'<svg xmlns="http://www.w3.org/2000/svg"/>'}]}})
        elif command!='validate-project':
            raise ValueError('unexpected command')

    def configure(self):
        with patch('workbench_project_config._interface_cli',self.cli):
            return self.catalog.configure_interface(self.project['id'],contract())

    def test_schema3_configuration_is_portable_and_preserves_original_program(self):
        original=Path(self.project['plc']).read_bytes();configured=self.configure()
        raw=json.loads(Path(configured['manifestPath']).read_text(encoding='utf-8'))
        self.assertEqual(raw['schemaVersion'],3);self.assertEqual(configured['defaultMode'],'fuxa-local')
        self.assertEqual(configured['interfaceDefinition'],contract());self.assertEqual(original,Path(configured['plc']).read_bytes())
        self.assertNotIn(str(self.base),json.dumps(raw));self.assertEqual(configured['id'],self.project['id'])

    def test_failed_declaration_or_hmi_never_publishes_manifest(self):
        path=Path(self.project['manifestPath']);before=path.read_bytes()
        d=contract();d['operations'][0]['variable']='actual'
        with self.assertRaises(ValueError):self.catalog.configure_interface(self.project['id'],d)
        with patch('workbench_project_config._interface_cli',side_effect=ValueError('HMI invalid')):
            with self.assertRaises(ValueError):self.catalog.configure_interface(self.project['id'],contract())
        self.assertEqual(before,path.read_bytes())

    def test_reconfiguration_creates_revision_and_keeps_prior_screen(self):
        one=self.configure();old_hmi=Path(one['hmi']).read_bytes();old_contract=Path(one['interfacePath']).read_bytes()
        two=self.configure()
        self.assertNotEqual(one['configuration']['revision'],two['configuration']['revision'])
        self.assertEqual(Path(one['hmi']).read_bytes(),old_hmi);self.assertEqual(Path(one['interfacePath']).read_bytes(),old_contract)

    def test_schema3_can_move_and_reopen_without_local_absolute_references(self):
        one=self.configure();moved=self.base/'moved';Path(one['projectRoot']).rename(moved)
        with patch('workbench_project_config._interface_cli',self.cli):
            two=read_user_project(moved/'project.plcdev')
        for key in ('plc','interfacePath','hmi'):
            self.assertTrue(Path(two[key]).is_relative_to(moved))
        self.assertEqual(one['id'],two['id'])

    def test_batch_schema2_is_not_silently_converted(self):
        path=Path(self.project['manifestPath']);raw=json.loads(path.read_text(encoding='utf-8'));raw['schemaVersion']=2;write(path,raw)
        before=path.read_bytes()
        with self.assertRaisesRegex(ValueError,'批次'):configure_interface_project(path,contract())
        self.assertEqual(path.read_bytes(),before)

    def test_schema3_unknown_fields_and_reference_traversal_rejected(self):
        one=self.configure();path=Path(one['manifestPath']);original=json.loads(path.read_text(encoding='utf-8'))
        for alter in (lambda d:d.update(password='secret'),lambda d:d['interface'].update(path='../outside.json'),
                      lambda d:d.update(simulation={'provider':'oip','project':None}),lambda d:d['interface'].update(provider='batch-mailbox-v1')):
            data=deepcopy(original);alter(data);write(path,data)
            with patch('workbench_project_config._interface_cli',self.cli):
                with self.assertRaises(ValueError):read_user_project(path)

    def test_schema3_without_hmi_uses_common_local_manager(self):
        configured=self.configure();path=Path(configured['manifestPath'])
        raw=json.loads(path.read_text(encoding='utf-8'));raw.pop('hmi');write(path,raw)
        local=read_user_project(path)
        self.assertEqual(local['defaultMode'],'local');self.assertIsNone(local['hmi'])
        self.assertEqual(local['interfaceDefinition'],contract())
        manager=UserProjectManager('local-no-hmi',local)
        self.assertEqual({entry['id'] for entry in manager.dependencies()},{'editor','runtime','msys','project'})

    def manager(self):
        configured=self.configure();manager=UserProjectManager('test',configured)
        manager.manifest=manifest();manager._interface_bindings=bind_interface(contract(),leaves())
        manager._operation_snapshot=Mock(return_value={'capabilities':{'canInput':True}})
        manager.request=Mock(return_value={'ok':True})
        return manager

    def test_manager_keeps_hidden_operation_user_access_and_checks_changed_contract(self):
        manager=self.manager();self.assertTrue(manager.perform_operation('service_on')['ok'])
        changed=contract();changed['variables'][1]['max']=99;write(Path(manager.project['interfacePath']),changed)
        with self.assertRaisesRegex(ValueError,'改变'):manager.perform_operation('apply_speed',20)

    def test_pulse_has_apply_and_release_and_failure_requests_stop(self):
        manager=self.manager()
        with patch('workbench_user_project.time.sleep'):
            result=manager.perform_operation('start_fan')
        self.assertTrue(result['released'])
        self.assertEqual([call.kwargs['value'] for call in manager.request.call_args_list],[True,False])
        manager.request.reset_mock();manager.request.side_effect=[{'ok':True},ValueError('release failed'),{'ok':True}]
        with patch('workbench_user_project.time.sleep'):
            with self.assertRaisesRegex(ValueError,'release failed'):manager.perform_operation('start_fan')
        self.assertEqual(manager.request.call_args.args,('stop',))

    def test_operation_rechecks_identity_expiry_and_bridge_guard_under_action_lock(self):
        manager=self.manager();manager.manifest['sessionId']='current'
        for kwargs in ({'session_id':'old'}, {'expires':time.time()-1}, {'expires':time.time()+60}, {'expires':float('nan')}):
            with self.assertRaises(ValueError):manager.perform_operation('apply_speed',20,**kwargs)
        manager.request.assert_not_called()
        def stale():
            self.assertTrue(manager.action_lock.locked())
            raise ValueError('heartbeat expired in queue')
        with self.assertRaisesRegex(ValueError,'heartbeat'):manager.perform_operation('apply_speed',20,guard=stale)
        manager.request.assert_not_called()
        guard=Mock()
        manager.perform_operation('apply_speed',20,session_id='current',expires=time.time()+4,guard=guard)
        guard.assert_called_once_with();manager.request.assert_called_once()

    def test_manager_compile_hook_checks_every_declared_symbol_and_freezes_contract(self):
        manager=self.manager();run=self.base/'session';compiled=self.base/'compiled'
        write(compiled/'project.json',{'data':{}})
        write(run/'runtime/core/generated/debug-map.json',{'leaves':leaves()})
        (run/'runtime/core/generated/program.st').write_text('PROGRAM fan END_PROGRAM',encoding='utf-8')
        for name in ('plugins.conf','vpp_plugins.conf'):(run/'runtime'/name).write_text('# none\n',encoding='utf-8')
        session=manifest();session.update(preparedHashes={},patches=[])
        manager.configure_inputs(run,session,compiled)
        self.assertTrue((run/'project_interface.py').is_file());self.assertEqual(session['projectInterfaceHash'],interface_hash(contract()))
        self.assertEqual(json.loads((compiled/'project-interface.json').read_text(encoding='utf-8')),contract())
        bad=leaves();bad[3]['type']='INT';bad[3]['size']=2;write(run/'runtime/core/generated/debug-map.json',{'leaves':bad})
        with self.assertRaisesRegex(ValueError,'不匹配'):manager.configure_inputs(run,session,compiled)


if __name__=='__main__':unittest.main(verbosity=2)
