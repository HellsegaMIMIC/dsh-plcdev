"""Bounded transport and lifecycle checks; fake peers only, no running applications."""
from pathlib import Path
import importlib.util, json, socket, struct, sys, threading, time, types, unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'software/factoryio'))
reader=types.ModuleType('telemetry_reader');reader.read_values=lambda *args: ([],{})
sys.modules['telemetry_reader']=reader
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module
legacy=load('legacy_batch_monitor',ROOT/'software/hmi-batch/batch_runtime_monitor.py')
adapter=load('fuxa_oip_adapter',ROOT/'software/fuxa-oip/batch_adapter.py')
CONFIG={'schemaVersion':1,'provider':'oip','modbus':{'host':'127.0.0.1','port':5020,'unitId':1},'mcp':{'host':'127.0.0.1','port':15190,'path':'/mcp'},'inputs':{'sensorOccupied':{'address':0,'activeHigh':True}},'outputs':{'conveyor':{'address':0},'entryConveyor':{'address':1}},'scene':{'project':'PLCdev Continuous Batch External'}}
MANIFEST={'sessionId':'test-session','programHash':'test-program','programMd5':'a'*32,'mode':'fuxa-oip','batchMode':'oip','batchHttpPort':50100,'oipDevice':CONFIG}


class FakeGuard:
    def __init__(self):self.armed=False;self.rearm=False;self.running=True;self.disarms=0
    def status(self):return {'connected':True,'armed':self.armed,'requiresRearm':self.rearm,'remoteOutputsKnownZero':not self.armed,'sceneRunning':self.running,'sensorOccupied':False}
    def disarm(self):self.armed=False;self.disarms+=1
    def arm(self,rearm=False):
        if self.rearm and not rearm:raise RuntimeError('explicit rearm needed')
        self.rearm=False;self.armed=True


class FakeControl:
    def __init__(self):self.actions=[]
    def change(self,action):self.actions.append(action)
    def debug(self,*args):return b'\x45\x7e'+MANIFEST['programMd5'].encode()+b'\xad\xde'


class FakePeer:
    def __init__(self,occupied=True):self.messages=[];self.buffer=b'';self.closed=False;self.occupied=occupied
    def settimeout(self,value):pass
    def sendall(self,raw):
        tid,protocol,length,unit=struct.unpack('>HHHB',raw[:7]);pdu=raw[7:];self.messages.append(pdu)
        reply=bytes([2,1,int(self.occupied)]) if pdu[0]==2 else pdu[:5]
        self.buffer=struct.pack('>HHHB',tid,0,len(reply)+1,unit)+reply
    def recv(self,size):result,self.buffer=self.buffer[:size],self.buffer[size:];return result
    def close(self):self.closed=True


def fake_guard_init(self,port,timeout=.3):
    self.target_port=port;self.timeout=timeout;self.lock=threading.RLock();self.halt=threading.Event()
    self.connected=False;self.last_success=None;self.requires_rearm=False;self.armed=False;self.error=None
    self.last_zero_ack=None;self.remote_outputs_zero=False;self.generation=0


class BridgeTests(unittest.TestCase):
    def setUp(self):self.guard=FakeGuard();self.bridge=adapter.FuxaOIPBridge(dict(MANIFEST),self.guard)
    def request(self,seq=1,kind=2,**changes):
        data={'program':'test-program','sequence':seq,'expires':time.time()+4,'kind':kind,'value':0};data.update(changes);return data
    def test_read_polling_never_renews_browser_lease(self):
        for _ in range(4):self.bridge.snapshot();self.bridge.native()
        self.assertEqual(self.bridge.hmi_at,0);self.assertFalse(self.bridge.hmi_fresh())
        self.bridge.heartbeat();self.assertTrue(self.bridge.hmi_fresh());self.bridge.hmi_at-=2
        self.bridge.snapshot();self.assertFalse(self.bridge.hmi_fresh())
    def test_management_authorization_is_independent_of_hmi(self):
        self.assertEqual(self.bridge.authorize(self.request(kind=10),'management:operator')[0],10)
        with self.assertRaisesRegex(ValueError,'心跳'):self.bridge.authorize(self.request(),'browser:operator')
    def test_management_and_business_cannot_use_each_others_route(self):
        self.bridge.heartbeat()
        with self.assertRaisesRegex(ValueError,'各自入口'):self.bridge.authorize(self.request(kind=9),'browser:operator')
        with self.assertRaisesRegex(ValueError,'各自入口'):self.bridge.authorize(self.request(kind=2),'management:operator')
    def test_expired_duplicate_and_wrong_program_never_enter_mailbox(self):
        self.bridge.heartbeat()
        with self.assertRaisesRegex(ValueError,'过期'):self.bridge.authorize(self.request(expires=time.time()-1),'browser:operator')
        with self.assertRaisesRegex(ValueError,'序号'):self.bridge.authorize(self.request(),'browser:operator')
        with self.assertRaisesRegex(ValueError,'版本'):self.bridge.authorize(self.request(seq=2,program='old'),'browser:operator')
        self.assertEqual(self.bridge.input_regs,[0,0,0]);self.assertFalse(self.bridge.events)
    def test_pending_recovery_rejects_start_even_with_fresh_browser(self):
        self.bridge.heartbeat();self.bridge.manual_rearm=True
        with self.assertRaisesRegex(ValueError,'核对数量'):self.bridge.authorize(self.request(),'browser:operator')
    def test_session_and_host_gate_reject_old_or_browser_origin_requests(self):
        headers={'X-PLCdev-Session':'test-session','Host':'127.0.0.1:50100'}
        self.assertTrue(adapter.valid_peer('127.0.0.1',headers,MANIFEST))
        for changed in ({'X-PLCdev-Session':'old-session'},{'Host':'example.test'},{'Origin':'http://127.0.0.1:1881'}):
            self.assertFalse(adapter.valid_peer('127.0.0.1',{**headers,**changed},MANIFEST))
        self.assertFalse(adapter.valid_peer('192.168.1.2',headers,MANIFEST))
    def apply_management(self,kind):
        event={'kind':kind,'value':0,'expiry':time.time()+4,'done':threading.Event(),'ok':False}
        self.bridge.events.append(event);control=FakeControl()
        with patch.object(adapter.time,'sleep',lambda duration:None):self.bridge.step(control)
        self.assertTrue(event['ok'],event);return control
    def test_management_run_without_hmi_does_not_arm_process_outputs(self):
        control=self.apply_management(9)
        self.assertEqual(control.actions,['START']);self.assertEqual(self.bridge.runtime,'RUNNING')
        self.assertFalse(self.guard.armed);self.assertFalse(self.bridge.enabled);self.assertTrue(self.bridge.manual_rearm)
    def test_management_stop_with_expired_hmi_preserves_history(self):
        self.bridge.runtime='RUNNING';self.bridge.output_regs=[4,0,2,5,2,0,17,1];self.bridge.plc_at=time.monotonic()
        control=self.apply_management(10)
        self.assertEqual(control.actions,['STOP']);self.assertEqual(self.bridge.history[2:4],[2,5])
        self.assertEqual(self.bridge.runtime,'STOPPED');self.assertFalse(self.bridge.enabled);self.assertTrue(self.bridge.restore_pending)
    def test_browser_loss_latches_manual_recovery_without_runtime_stop(self):
        self.bridge.runtime='RUNNING';self.bridge.was_online=True;self.bridge.enabled=True;self.guard.armed=True
        self.bridge.step(FakeControl())
        self.assertFalse(self.guard.armed);self.assertFalse(self.bridge.enabled);self.assertTrue(self.bridge.manual_rearm)
        self.assertEqual(self.bridge.runtime,'RUNNING')


class OIPTransportTests(unittest.TestCase):
    def setUp(self):
        with patch.object(adapter.ModbusGuard,'__init__',fake_guard_init):self.guard=adapter.OIPGuard(CONFIG)
    def test_mapping_rejects_remote_targets_and_nonatomic_output_layout(self):
        for section,key,value in [('modbus','host','192.168.1.10'),('mcp','host','localhost')]:
            changed=json.loads(json.dumps(CONFIG));changed[section][key]=value
            with self.assertRaises(ValueError):adapter.validate_device_config(changed)
        changed=json.loads(json.dumps(CONFIG));changed['outputs']['entryConveyor']['address']=4
        with self.assertRaises(ValueError):adapter.validate_device_config(changed)
    def test_first_transaction_clears_outputs_before_read_and_keeps_connection(self):
        peer=FakePeer()
        with patch.object(adapter.socket,'create_connection',return_value=peer) as connect:
            reply=self.guard.exchange(b'\x02\0\0\0\x08');self.guard.exchange(b'\x02\0\0\0\x08')
        self.assertEqual(connect.call_count,1);self.assertFalse(peer.closed)
        self.assertEqual(peer.messages[0],b'\x0f\0\0\0\x02\x01\0')
        self.assertEqual([p[0] for p in peer.messages],[15,2,2]);self.assertEqual(reply,b'\x02\x01\0')
    def test_sensor_polarity_and_output_bit_mapping(self):
        peer=FakePeer(occupied=False);self.guard.observe_scene(True)
        with patch.object(adapter.socket,'create_connection',return_value=peer):
            reply=self.guard.exchange(b'\x02\0\0\0\x08');self.guard.arm()
            self.guard.exchange(b'\x0f\0\0\0\x08\x01\x01')
        self.assertEqual(reply,b'\x02\x01\x03')
        self.assertEqual(peer.messages[-1],b'\x0f\0\0\0\x02\x01\x02')
        self.assertFalse(self.guard.status()['remoteOutputsKnownZero'])
    def test_reconnect_clears_before_read_and_requires_new_manual_arm(self):
        first,second=FakePeer(),FakePeer();self.guard.observe_scene(True)
        with patch.object(adapter.socket,'create_connection',side_effect=[first,second]):
            self.guard.exchange(b'\x02\0\0\0\x08');self.guard.arm();self.guard._failed(ConnectionError('lost'))
            self.assertFalse(self.guard.status()['remoteOutputsKnownZero'])
            time.sleep(max(0,self.guard.retry_at-time.monotonic())+.01)
            self.guard.exchange(b'\x02\0\0\0\x08')
            with self.assertRaisesRegex(RuntimeError,'rearm'):self.guard.arm()
            self.guard.exchange(b'\x0f\0\0\0\x08\x01\x03')
        self.assertTrue(first.closed);self.assertEqual([p[0] for p in second.messages[:2]],[15,2])
        self.assertTrue(self.guard.requires_rearm);self.assertFalse(self.guard.armed)
        self.assertEqual(second.messages[-1][-1],0);self.assertTrue(self.guard.status()['remoteOutputsKnownZero'])
    def test_stopped_or_expired_scene_is_not_inferred_from_modbus_connection(self):
        self.guard.connected=True;self.guard.observe_scene(True);self.guard.armed=True;self.guard.scene_at-=2
        self.assertIsNone(self.guard.status()['sceneRunning']);self.assertTrue(self.guard.requires_rearm);self.assertFalse(self.guard.armed)
        self.guard.observe_scene(True);self.assertFalse(self.guard.armed)
        self.guard.observe_scene(False);self.assertIs(self.guard.status()['sceneRunning'],False)
    def test_watchdog_gap_clears_before_first_resumed_read_without_socket_change(self):
        peer=FakePeer();self.guard.observe_scene(True)
        with patch.object(adapter.socket,'create_connection',return_value=peer) as connect:
            self.guard.exchange(b'\x02\0\0\0\x08');self.guard.arm()
            self.guard.exchange(b'\x0f\0\0\0\x08\x01\x03')
            self.guard.last_exchange_at-=1.2;start=len(peer.messages)
            self.guard.exchange(b'\x02\0\0\0\x08')
        self.assertEqual(connect.call_count,1);self.assertEqual(peer.messages[start:], [b'\x0f\0\0\0\x02\x01\0',b'\x02\0\0\0\x01'])
        self.assertTrue(self.guard.requires_rearm);self.assertFalse(self.guard.armed)
    def test_unknown_points_cannot_be_written(self):
        with self.assertRaises(ValueError):self.guard.exchange(b'\x0f\0\0\0\x08\x01\x04')
    def test_status_remains_responsive_while_device_connection_waits(self):
        entered=threading.Event();release=threading.Event();peer=FakePeer();failures=[]
        def connect(*args):entered.set();release.wait(2);return peer
        def read():
            try:self.guard.exchange(b'\x02\0\0\0\x08')
            except Exception as exc:failures.append(str(exc))
        with patch.object(adapter.socket,'create_connection',side_effect=connect):
            thread=threading.Thread(target=read);thread.start();self.assertTrue(entered.wait(1))
            try:
                start=time.monotonic();state=self.guard.status();elapsed=time.monotonic()-start
                self.assertFalse(state['connected']);self.assertLess(elapsed,.1)
            finally:release.set();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(failures,[])
    def test_scene_identity_and_advancing_clock_are_both_required(self):
        scene={'project':CONFIG['scene']['project'],'running':True};cargo={'running':True,'simTime':4.5}
        with patch.object(adapter,'call_oip',side_effect=lambda name,**kwargs:scene if name=='get_scene' else cargo):
            self.assertTrue(self.guard.read_scene());self.guard.sim_advanced_at-=2
            with self.assertRaisesRegex(ValueError,'stopped advancing'):self.guard.read_scene()
            cargo['simTime']=5;self.assertTrue(self.guard.read_scene())
            cargo['simTime']=0
            with self.assertRaisesRegex(ValueError,'restarted'):self.guard.read_scene()
            scene['project']='another project'
            with self.assertRaisesRegex(ValueError,'identity'):self.guard.read_scene()


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result=unittest.TestResult();suite.run(result)
    output={'passed':result.wasSuccessful(),'count':result.testsRun,'scope':'offline fake peers/control; no Runtime, GUI or network connections',
            'failures':[{'case':str(case),'error':error} for case,error in result.failures+result.errors]}
    print(json.dumps(output,ensure_ascii=False,indent=2));raise SystemExit(0 if result.wasSuccessful() else 1)
