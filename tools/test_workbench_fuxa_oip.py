"""Project/profile/session isolation and role mailbox fixtures; no applications run."""
from pathlib import Path
from unittest.mock import patch,Mock
import copy,json,socket,struct,tempfile,threading,time,unittest
import workbench_fuxa_oip as app
import fuxa_oip_session as session
from workbench_project_config import default_bindings
from test_fuxa_oip_adapter import adapter,FakeGuard,MANIFEST,CONFIG,fake_guard_init
from oip_batch_mcp import require_open_project
import windows_listener_owner as native_owner


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value),encoding='utf-8')


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.home=patch.object(app,'HOME',self.root/'machine');self.home.start();self.addCleanup(self.home.stop)

    def project(self,name='one',ident=None):
        root=self.root/name;ident=ident or 'user-'+('1' if name=='one' else '2')*32
        binding=default_bindings('User Scene '+name)
        manifest={'schemaVersion':2,'id':ident,'name':name,'application':{'provider':'openplc','path':'plc/project.json'},'target':{'provider':'openplc-runtime','mode':'local'},'hmi':{'provider':'fuxa','project':'hmi/main.fuxap'},'simulation':{'provider':'oip','project':'oip/project.json'},'bindings':{'provider':'batch-mailbox-v1','path':'bindings.json'}}
        write(root/'project.plcdev',manifest);write(root/'plc/project.json',{'meta':{'type':'plc-project'},'data':{}})
        write(root/'hmi/main.fuxap',{'name':'native page '+name})
        write(root/'oip/project.json',{'version':7,'name':'User Scene '+name,'scene':'scene.json','program':[],'packages':[]})
        write(root/'oip/scene.json',{'version':4,'parts':[],'plcs':[{'name':'OpenPLC','runsOn':'plc','protocol':'serve','connect':True}]})
        write(root/'bindings.json',binding)
        return {'id':ident,'kind':'user','name':name,'defaultMode':'fuxa-oip','plc':str(root/'plc/project.json'),'hmi':str(root/'hmi/main.fuxap'),'scene':str(root/'oip/project.json'),'bindingsPath':str(root/'bindings.json'),'manifestPath':str(root/'project.plcdev'),'projectRoot':str(root)}

    def manager(self,name='one'):return app.FuxaOipManager('test-controller',self.project(name))

    def test_two_uuid_projects_have_separate_stable_ports_profiles_and_session_pointers(self):
        one,two=self.project(),self.project('two')
        with patch.object(app,'open_port',return_value=False):
            first,first_ports=app.allocate(one);second,second_ports=app.allocate(two);again,again_ports=app.allocate(one)
        self.assertEqual(first_ports,again_ports);self.assertEqual(first,again)
        self.assertFalse(set(first_ports.values())&set(second_ports.values()))
        for key in ('fuxa','oip','session'):self.assertNotEqual(first[key],second[key])
        self.assertNotIn(18810,[*first_ports.values(),*second_ports.values()])

    def test_duplicate_uuid_in_other_folder_cannot_take_over_saved_screen(self):
        one=self.project();two=self.project('two',one['id'])
        with patch.object(app,'open_port',return_value=False):
            app.allocate(one)
            with self.assertRaisesRegex(ValueError,'UUID'):app.allocate(two)

    def test_stopped_project_move_preserves_ports_and_rebinds_owner(self):
        one=self.project();old=Path(one['manifestPath']);new=old.parent.with_name('moved')
        with patch.object(app,'open_port',return_value=False),patch.object(app,'owner',return_value=None):
            paths,ports=app.allocate(one);old.parent.rename(new)
            moved={**one,'manifestPath':str(new/old.name)}
            again,again_ports=app.allocate(moved)
        self.assertEqual(paths,again);self.assertEqual(ports,again_ports)
        self.assertEqual(app.read(paths['home']/'owner.json')['manifestPath'],moved['manifestPath'])

    def test_move_rejects_live_runtime_tool_or_port_without_changing_owner(self):
        one=self.project();old=Path(one['manifestPath']);new=old.parent.with_name('moved')
        with patch.object(app,'open_port',return_value=False):paths,ports=app.allocate(one)
        previous=(paths['home']/'owner.json').read_bytes();old.parent.rename(new)
        moved={**one,'manifestPath':str(new/old.name)}
        with patch.object(app,'owner',return_value={'sessionId':'active'}):
            with self.assertRaisesRegex(ValueError,'Runtime'):app.allocate(moved)
        write(paths['home']/'fuxa-test.started.json',{'child':{'pid':123}})
        with patch.object(app,'owner',return_value=None),patch.object(app,'same_process',return_value=True):
            with self.assertRaisesRegex(ValueError,'仍在运行'):app.allocate(moved)
        with patch.object(app,'owner',return_value=None),patch.object(app,'same_process',return_value=False),patch.object(app,'open_port',return_value=True):
            with self.assertRaisesRegex(ValueError,'端口'):app.allocate(moved)
        self.assertEqual(previous,(paths['home']/'owner.json').read_bytes())

    def test_controller_restart_does_not_inherit_old_runtime_pointer(self):
        project=self.project();old=app.FuxaOipManager('old-controller',project);new=app.FuxaOipManager('new-controller',project)
        write(old.paths['session'],{'sessionId':'previous-runtime'})
        with patch.object(app,'open_port',return_value=False):new.allocated()
        self.assertNotEqual(old.paths['session'],new.paths['session']);self.assertFalse(new.paths['session'].exists())
        self.assertEqual(json.loads(old.paths['session'].read_text())['sessionId'],'previous-runtime')

    def test_same_name_service_on_foreign_pid_is_rejected(self):
        manager=self.manager();manager.ports={'fuxa':19010,'mcp':19011,'modbus':19012}
        plan=self.root/'tool.json';write(plan.with_suffix('.started.json'),{'projectId':manager.project['id'],'child':{'pid':999}})
        manager.tools['oip']={'plan':plan}
        with patch.object(app,'listener_owned',return_value=False):
            with self.assertRaisesRegex(ValueError,'不属于'):manager.verify_tool_listener('oip')
        self.assertFalse(manager.tools['oip'].get('listenerVerified',False))

    def test_page_edit_does_not_invalidate_runtime_but_binding_or_scene_edit_does(self):
        project=self.project();original=app.fingerprint(project)
        write(Path(project['hmi']),{'name':'saved native edit'})
        self.assertEqual(app.fingerprint(project),original)
        bindings=json.loads(Path(project['bindingsPath']).read_text());bindings['plc']['target']['location']='%QW99';write(Path(project['bindingsPath']),bindings)
        self.assertNotEqual(app.fingerprint(project),original)
        bindings['plc']['target']['location']='%QW3';write(Path(project['bindingsPath']),bindings)
        write(Path(project['scene']).parent/'scene.json',{'version':4,'parts':[{'id':'new-part'}],'plcs':[{'name':'OpenPLC','runsOn':'plc','protocol':'serve','connect':True}]})
        self.assertNotEqual(app.fingerprint(project),original)

    def test_selecting_another_project_snapshot_never_mutates_processes_or_network(self):
        first,second=self.manager(),self.manager('two')
        with patch.object(app,'owner',return_value=None),patch('workbench_start_stop.owner',return_value=None),patch.object(app.subprocess,'Popen') as spawn,patch.object(app,'urlopen') as http:
            one=first.snapshot();two=second.snapshot();first.snapshot()
        spawn.assert_not_called();http.assert_not_called()
        self.assertEqual(one['project']['id'],first.project['id']);self.assertEqual(two['project']['id'],second.project['id'])
        self.assertFalse(two['session']['active']);self.assertEqual(two['state']['variables'],[])

    def test_wrong_project_old_session_or_expired_action_never_starts_component(self):
        manager=self.manager();manager.manifest={'sessionId':'current'}
        base={'action':'tool','tool':'fuxa','projectId':manager.project['id'],'sessionId':'current','expires':time.time()+5}
        with patch.object(manager,'tool') as tool:
            for change in ({'projectId':'user-'+'2'*32},{'sessionId':'old'},{'expires':time.time()-1}):
                with self.subTest(change=change),self.assertRaises(ValueError):manager.action({**base,**change})
        tool.assert_not_called()

    def test_open_tool_locks_configuration_and_can_end_without_runtime(self):
        manager=self.manager();manager.tools['fuxa']={'process':Mock(poll=Mock(return_value=None)),'verified':True}
        with patch('workbench_start_stop.owner',return_value=None):state=manager.snapshot()
        self.assertTrue(state['configurationLocked']);self.assertTrue(state['toolsOpen']);self.assertTrue(state['capabilities']['canEnd'])
        self.assertFalse(state['capabilities']['canConfigureProject']);self.assertFalse(state['session']['active'])

    def test_slow_tool_start_is_deduplicated_and_does_not_block_runtime_stop(self):
        manager=self.manager();entered=threading.Event();release=threading.Event()
        manager.child=Mock(poll=Mock(return_value=None));manager.phase='ready';manager.directory=self.root/'active'
        manager.manifest={'sessionId':'owned','programHash':'same-program'}
        write(manager.directory/'state.json',{'sessionId':'owned','programHash':'same-program','projectId':manager.project['id'],'configFingerprint':manager.config_hash,'observedAt':time.time(),'runtimeState':'RUNNING','telemetryFresh':True})
        def slow(*args):entered.set();release.wait(3)
        command={'projectId':manager.project['id'],'sessionId':'owned','expires':time.time()+5}
        try:
            with patch.object(manager,'open_fuxa',side_effect=slow) as launch,patch.object(manager,'request',return_value={'ok':True}) as stop,patch('workbench_start_stop.owner',return_value=None):
                before=time.monotonic();manager.action({**command,'action':'tool','tool':'fuxa'})
                self.assertLess(time.monotonic()-before,.5);self.assertTrue(entered.wait(.5))
                manager.action({**command,'action':'tool','tool':'fuxa'});self.assertEqual(launch.call_count,1)
                state=manager.snapshot();self.assertTrue(state['capabilities']['canStop']);self.assertFalse(state['capabilities']['canEnd']);self.assertTrue(state['configurationLocked'])
                manager.action({**command,'action':'runtime-stop'});stop.assert_called_once_with('stop')
                with self.assertRaisesRegex(ValueError,'正在打开'):manager.end()
        finally:release.set();manager.tool_workers['fuxa'].join(2)

    def test_cross_project_observation_is_invalidated_even_when_program_hash_matches(self):
        manager=self.manager();manager.child=Mock(poll=Mock(return_value=None));manager.phase='ready';manager.directory=self.root/'run';manager.manifest={'sessionId':'shared-sid','programHash':'same-program'}
        write(manager.directory/'state.json',{'sessionId':'shared-sid','programHash':'same-program','projectId':'user-'+'f'*32,'configFingerprint':manager.config_hash,'observedAt':time.time(),'runtimeState':'RUNNING','telemetryFresh':True,'hmiConnected':True,'values':{'INSTANCE0.Count':5}})
        with patch('workbench_start_stop.owner',return_value=None):state=manager.snapshot()
        self.assertFalse(state['observerFresh']);self.assertEqual(state['state']['runtimeState'],'UNKNOWN');self.assertEqual(state['state']['values'],{})
        self.assertNotEqual(state['links']['variables']['state'],'connected')

    def test_management_stop_uses_project_identity_and_independent_route(self):
        manager=self.manager();manager.child=Mock(poll=Mock(return_value=None));manager.phase='ready'
        manager.manifest={'sessionId':'owned','programHash':'compiled','batchHttpPort':50100}
        response=Mock();response.read.return_value=b'{"ok":true}';response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        with patch.object(app,'urlopen',return_value=response) as http:manager.request('stop')
        request=http.call_args.args[0];headers={key.lower():value for key,value in request.header_items()}
        self.assertTrue(request.full_url.endswith('/management'));self.assertEqual(json.loads(request.data)['kind'],10)
        self.assertEqual(headers['x-plcdev-project'],manager.project['id']);self.assertEqual(headers['x-plcdev-config'],manager.config_hash)

    def test_flush_failure_leaves_open_tools_and_runtime_intact(self):
        manager=self.manager();manager.child=Mock(poll=Mock(return_value=None));manager.directory=self.root/'run';manager.directory.mkdir()
        with patch.object(manager,'flush_tools',side_effect=ValueError('unsaved changes')):
            with self.assertRaises(ValueError):manager.end()
        self.assertFalse((manager.directory/'stop.request').exists());manager.child.wait.assert_not_called()

    def test_ending_tools_only_flushes_before_stopping_owned_tool(self):
        manager=self.manager();manager.paths['home'].mkdir(parents=True);marker=manager.paths['home']/'own.stop'
        child=Mock(poll=Mock(return_value=None));manager.tools['fuxa']={'process':child,'stop':marker}
        with patch.object(manager,'flush_tools') as flush:manager.end()
        flush.assert_called_once();self.assertTrue(marker.exists());child.wait.assert_called_once();self.assertEqual(manager.phase,'ended')

    def test_fuxa_environment_binds_exact_owned_file_identity_and_session(self):
        project=self.project();paths=app.local_paths(project);result=app.fuxa_environment(project,'a'*64,paths,{'fuxa':19010,'mcp':19011,'modbus':19012})
        self.assertEqual(result['PLCDEV_FUXA_PROJECT_FILE'],project['hmi']);self.assertEqual(result['PLCDEV_FUXA_PROJECT_ID'],project['id'])
        self.assertEqual(result['PLCDEV_FUXA_SESSION_FILE'],str(paths['session']));self.assertNotIn('outputs/fuxa/profile',str(result).replace('\\','/'))

    def test_prepared_mapping_pins_scene_directory_without_changing_portable_bindings(self):
        project=self.project();bindings=default_bindings('User Scene one')
        mapping=app.device_mapping(bindings,{'fuxa':19010,'mcp':19011,'modbus':19012},project['scene'])
        self.assertEqual(mapping['scene']['path'],str(Path(project['scene']).parent));self.assertNotIn('path',bindings['oip']['scene'])
        session.validate_device(mapping)
        mapping['scene']['path']='relative/other-scene'
        with self.assertRaisesRegex(ValueError,'absolute'):session.validate_device(mapping)

    def test_renamed_noncontiguous_plc_roles_validate_against_actual_compilation(self):
        project=self.project();bindings=default_bindings('User Scene one')
        for index,point in enumerate(bindings['plc'].values()):
            point['path']='INSTANCE0.UserVariable'+str(index)
            point['location']=('%'+point['location'][1]+'X'+str(index+10)+'.0') if point['type']=='BOOL' else '%'+point['location'][1]+'W'+str(index+30)
        generated=Path(project['plc']).parent/'build/OpenPLC Runtime v4/src'
        write(generated/'debug-map.json',{'leaves':[{'path':p['path'],'type':p['type']} for p in bindings['plc'].values()]})
        (generated/'program.st').write_text('\n'.join(p['path'].split('.')[-1]+' AT '+p['location']+' : '+p['type']+';' for p in bindings['plc'].values()))
        session.validate_compiled_roles(Path(project['plc']).parent,bindings)
        points=session.role_io_points(bindings);self.assertEqual(len(points),16)
        self.assertEqual({p['iec_location'] for p in points},{p['location'] for p in bindings['plc'].values()})
        bindings['plc']['count']['location']='%QW222'
        with self.assertRaisesRegex(ValueError,'count'):session.validate_compiled_roles(Path(project['plc']).parent,bindings)


class ScopedMailboxTests(unittest.TestCase):
    def setUp(self):
        self.guard=FakeGuard();self.guard.exchange=Mock(return_value=b'')
        self.manifest={**MANIFEST,'projectId':'user-'+'1'*32,'configFingerprint':'a'*64,'plcBindings':default_bindings()['plc']}
        self.bridge=adapter.FuxaOIPBridge(self.manifest,self.guard)

    def test_http_requires_project_and_configuration_even_with_valid_session(self):
        headers={'X-PLCdev-Session':MANIFEST['sessionId'],'Host':'127.0.0.1:50100','X-PLCdev-Project':self.manifest['projectId'],'X-PLCdev-Config':'a'*64}
        self.assertTrue(adapter.valid_peer('127.0.0.1',headers,self.manifest))
        for changes in ({'X-PLCdev-Project':'other'},{'X-PLCdev-Config':'b'*64},{'X-PLCdev-Config':None}):self.assertFalse(adapter.valid_peer('127.0.0.1',{**headers,**changes},self.manifest))

    def test_scattered_command_reads_use_one_tuple_even_if_new_command_arrives(self):
        cycle={};self.bridge.input_regs=[5,1,3]
        first=self.bridge.role_pdu(struct.pack('>BHH',3,0,1),cycle)
        self.bridge.input_regs=[6,8,2]
        rest=[self.bridge.role_pdu(struct.pack('>BHH',3,index,1),cycle) for index in (1,2)]
        self.assertEqual([struct.unpack('>H',pdu[2:])[0] for pdu in [first,*rest]],[5,1,3])
        self.assertEqual(struct.unpack('>H',self.bridge.role_pdu(struct.pack('>BHH',3,0,1),cycle)[2:])[0],6)

    def test_telemetry_publishes_only_complete_ordered_cycle(self):
        cycle={}
        def pdu(index,value):return struct.pack('>BHHBH',16,index,1,2,value)
        for index in range(7):self.bridge.role_pdu(pdu(index,index+20),cycle)
        self.assertEqual(self.bridge.output_regs,[0]*8);self.assertEqual(self.bridge.plc_at,0)
        self.bridge.role_pdu(pdu(7,27),cycle);self.assertEqual(self.bridge.output_regs,list(range(20,28)))
        observed=self.bridge.plc_at;self.assertEqual(self.bridge.role_pdu(pdu(2,900),cycle),bytes([144,2]));self.assertEqual(self.bridge.plc_at,observed)

    def test_outputs_forward_together_and_never_when_browser_lease_expired(self):
        cycle={};self.bridge.runtime='RUNNING';self.bridge.enabled=True;self.bridge.heartbeat()
        def pdu(index):return struct.pack('>BHHBB',15,index,1,1,1)
        self.bridge.role_pdu(pdu(0),cycle);self.guard.exchange.assert_not_called()
        self.bridge.role_pdu(pdu(1),cycle);self.assertEqual(self.guard.exchange.call_args.args[0][-1],3)
        self.bridge.hmi_at-=2
        self.bridge.role_pdu(pdu(0),cycle);self.bridge.role_pdu(pdu(1),cycle);self.assertEqual(self.guard.exchange.call_args.args[0][-1],0)

    def test_variable_monitor_uses_case_insensitive_bound_paths_and_marks_history(self):
        self.bridge.values={'instance0.count':4}
        result=self.bridge.snapshot();count=next(x for x in result['variables'] if x['role']=='count')
        self.assertEqual(count['value'],4);self.assertEqual(count['quality'],'historical');self.assertFalse(count['fresh'])
        self.assertEqual(result['projectId'],self.manifest['projectId'])


class SceneIdentityTests(unittest.TestCase):
    def test_open_project_uses_absolute_path_not_name_and_requires_one_open_row(self):
        expected=r'C:\ExampleWorkspace\One\scene'
        listing={'projects':[{'name':'same name','path':r'C:\ExampleWorkspace\Two\scene','open':False},{'name':'same name','path':'c:/exampleworkspace/one/scene','open':True}]}
        self.assertEqual(require_open_project(listing,expected),'c:/exampleworkspace/one/scene')
        for bad in ({'projects':[{'name':'same name','path':r'C:\ExampleWorkspace\Two\scene','open':True}]},{'projects':[]},{'projects':[{'path':expected,'open':True},{'path':expected,'open':True}]},{'projects':[{'path':expected,'open':'true'}]}):
            with self.subTest(value=bad),self.assertRaises(ValueError):require_open_project(bad,expected)

    def test_guard_caches_path_for_one_second_then_disarms_on_same_name_other_folder(self):
        config=copy.deepcopy(CONFIG);config['scene']['path']=r'C:\ExampleWorkspace\One\scene'
        with patch.object(adapter.ModbusGuard,'__init__',fake_guard_init):guard=adapter.OIPGuard(config)
        listing={'projects':[{'name':config['scene']['project'],'path':config['scene']['path'],'open':True}]}
        calls=[]
        def mcp(name,**kwargs):
            calls.append(name)
            if name=='list_projects':return listing
            if name=='get_scene':return {'project':config['scene']['project'],'running':True}
            return {'running':True,'simTime':1}
        with patch.object(adapter,'call_oip',side_effect=mcp):
            self.assertTrue(guard.read_scene());guard.observe_scene(True);guard.armed=True
            self.assertTrue(guard.read_scene());self.assertEqual(calls.count('list_projects'),1)
            guard.project_identity_at-=1.1;listing['projects'][0]['path']=r'C:\ExampleWorkspace\Two\scene'
            try:guard.read_scene()
            except ValueError as exc:guard.observe_scene(None,str(exc))
            else:self.fail('A same-name foreign folder must be rejected')
        self.assertEqual(calls.count('list_projects'),2);self.assertFalse(guard.armed);self.assertTrue(guard.requires_rearm)
        self.assertIsNone(guard.open_project_path);self.assertFalse(guard.status()['projectIdentityFresh'])


class NativeOwnershipTests(unittest.TestCase):
    def test_tcp_table_matches_only_requested_loopback_listener(self):
        loopback=struct.unpack('<I',socket.inet_aton('127.0.0.1'))[0]
        def row(state,address,port,pid):return struct.pack('<6I',state,address,socket.htons(port),0,0,pid)
        raw=struct.pack('<I',4)+row(2,loopback,19010,10)+row(5,loopback,19010,11)+row(2,0,19010,12)+row(2,loopback,19011,13)
        self.assertEqual(native_owner.parse_listeners(raw,19010),{10})
        with self.assertRaises(ValueError):native_owner.parse_listeners(raw[:-1],19010)

    def test_process_snapshot_requires_all_listeners_to_descend_from_owned_root(self):
        parents={1:0,2:1,3:2,4:3,8:1,9:10,10:9}
        self.assertTrue(native_owner.all_descend_from({3,4},parents,2))
        for listeners,root in [({4,8},2),({9},2),({4},99),(set(),2)]:
            self.assertFalse(native_owner.all_descend_from(listeners,parents,root))

    def test_pid_reuse_and_native_query_error_never_leak_implementation_to_user(self):
        with patch.object(app,'same_process',side_effect=[True,False]),patch.object(native_owner,'listener_descends_from',return_value=True):
            self.assertFalse(app.listener_owned(19010,{'pid':2}))
        with patch.object(app,'same_process',return_value=True),patch.object(native_owner,'listener_descends_from',side_effect=OSError('SECRET command implementation')):
            with self.assertRaises(ValueError) as error:app.listener_owned(19010,{'pid':2})
        self.assertNotIn('SECRET',str(error.exception));self.assertIn('端口归属',str(error.exception))


if __name__=='__main__':
    import sys
    suite=unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]);result=unittest.TestResult();suite.run(result)
    print(json.dumps({'passed':result.wasSuccessful(),'count':result.testsRun,'scope':'temporary projects and mocked processes/transports; no Runtime, OIP, FUXA or AI request','failures':[{'case':str(c),'error':e} for c,e in result.failures+result.errors]},ensure_ascii=False,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
