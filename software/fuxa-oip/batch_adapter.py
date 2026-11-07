"""Session-owned FUXA / OIP adapter; the existing PLC owns batch behavior.

FUXA reads do not renew the visible-browser lease. OIP is a loopback Modbus
server, and its actual running state is independently read through local MCP.
This guard is for a computer simulation, never a personnel-safety function.
"""
from __future__ import annotations
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json, math, re, socket, struct, threading, time
from urllib.parse import parse_qs

import legacy_batch_monitor as legacy
from editor_runtime_guard import ModbusGuard, receive
from oip_batch_mcp import call as call_oip, project_path, require_open_project


def validate_device_config(value):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or value.get('provider') != 'oip':
        raise ValueError('Expected an OIP device mapping, schemaVersion 1')
    config = json.loads(json.dumps(value))
    for key in ('modbus', 'mcp'):
        section = config.get(key, {})
        if section.get('host') != '127.0.0.1' or type(section.get('port')) is not int or not 1024 <= section['port'] <= 65535:
            raise ValueError('OIP endpoints must use explicit 127.0.0.1 non-system ports')
    if config['modbus'].get('unitId') != 1 or config['mcp'].get('path') != '/mcp':
        raise ValueError('This adapter supports OIP unit 1 and the local /mcp endpoint')
    if not isinstance(config.get('scene',{}).get('project'),str) or not config['scene']['project'].strip():
        raise ValueError('OIP mapping must declare the expected scene project name')
    if 'path' in config['scene']:project_path(config['scene']['path'])
    for section, names in (('inputs', ('sensorOccupied',)), ('outputs', ('conveyor', 'entryConveyor'))):
        for name in names:
            address = config.get(section, {}).get(name, {}).get('address')
            if type(address) is not int or not 0 <= address <= 65535:
                raise ValueError('Invalid OIP point address: ' + name)
    if type(config['inputs']['sensorOccupied'].get('activeHigh')) is not bool:
        raise ValueError('sensorOccupied must declare activeHigh polarity')
    if abs(config['outputs']['conveyor']['address'] - config['outputs']['entryConveyor']['address']) != 1:
        raise ValueError('The two OIP output coils must be adjacent for atomic reconnect clearing')
    return config


class OIPGuard(ModbusGuard):
    """Map the reviewed eight-bit PLC mailbox to declared OIP coils/sensor."""
    def __init__(self, config):
        self.config = validate_device_config(config)
        self.scene_at = 0.0
        self.scene_running = None
        self.scene_error = None
        self.raw_occupied = None
        self.scene_seen = False
        self.peer = None
        self.ever_connected = False
        self.last_exchange_at = None
        self.last_written_zero = False
        self.sim_time = None
        self.sim_advanced_at = None
        self.project_identity_at = 0.0
        self.open_project_path = None
        self.io_lock = threading.RLock()
        self.retry_at = 0.0
        super().__init__(self.config['modbus']['port'], timeout=.35)

    def scene_state(self):
        with self.lock:
            fresh = self.scene_at > 0 and time.monotonic() - self.scene_at < 1.5
            if not fresh and self.scene_seen and (self.armed or self.scene_running is True):
                self.requires_rearm=True;self.armed=False;self.generation+=1
                self.scene_running=None;self.scene_error='OIP scene observation expired';self.remote_outputs_zero=False
            return self.scene_running if fresh else None

    def status(self):
        result = super().status()
        running = self.scene_state()
        result.update(provider='oip', endpoint='127.0.0.1:' + str(self.target_port),
                      sceneRunning=running, sceneFresh=running is not None,
                      sceneError=self.scene_error, sensorOccupied=self.raw_occupied,
                      projectPath=self.open_project_path,
                      projectIdentityFresh=bool(self.project_identity_at and time.monotonic()-self.project_identity_at<1.5))
        return result

    def observe_scene(self, running, error=None):
        with self.lock:
            previous = self.scene_running
            if type(running) is bool:
                self.scene_running = running
                self.scene_at = time.monotonic()
                self.scene_error = None
                self.scene_seen = True
            else:
                self.scene_running = None
                self.scene_at = 0.0
                self.scene_error = error or 'OIP scene state is unknown'
            if running is not True and (self.armed or previous is True):
                self.requires_rearm = True
                self.armed = False
                self.generation += 1
                self.remote_outputs_zero = False

    def read_scene(self):
        options={'port':self.config['mcp']['port'],'timeout':.7}
        expected=self.config['scene'].get('path')
        if expected and (not self.project_identity_at or time.monotonic()-self.project_identity_at>=1):
            # Invalidate before I/O: timeout/malformed results cannot retain an
            # earlier permission to use a same-name scene from another folder.
            self.project_identity_at=0.;self.open_project_path=None
            self.open_project_path=require_open_project(call_oip('list_projects',**options),expected)
            self.project_identity_at=time.monotonic()
        scene=call_oip('get_scene',**options)
        if not isinstance(scene,dict) or scene.get('project')!=self.config['scene']['project']:
            raise ValueError('OIP scene identity differs from this project mapping')
        if type(scene.get('running')) is not bool:
            raise ValueError('OIP scene did not provide a boolean running state')
        if not scene['running']:
            self.sim_time=None;self.sim_advanced_at=None
            return False
        cargo=call_oip('get_cargo',**options)
        if not isinstance(cargo,dict) or type(cargo.get('running')) is not bool:
            raise ValueError('OIP cargo observation is invalid')
        if not cargo['running']:return False
        clock=cargo.get('simTime');now=time.monotonic()
        if type(clock) not in (int,float) or not math.isfinite(clock) or clock<0:
            raise ValueError('OIP simulation clock is invalid')
        if self.sim_time is not None and clock<self.sim_time:
            self.sim_time=clock;self.sim_advanced_at=now
            raise ValueError('OIP simulation clock restarted; manual recovery required')
        if self.sim_time is None or clock>self.sim_time:
            self.sim_time=clock;self.sim_advanced_at=now
        elif now-self.sim_advanced_at>1.5:
            raise ValueError('OIP simulation clock has stopped advancing')
        return True

    def _poll_scene(self):
        while not self.halt.is_set():
            try:
                self.observe_scene(self.read_scene())
            except (OSError, RuntimeError, ValueError, KeyError, TypeError) as exc:
                self.observe_scene(None, str(exc))
            self.halt.wait(.3)

    def start(self):
        threading.Thread(target=self._poll_scene, daemon=True).start()
        # BatchBridge's sampler already polls the real device. A second probe
        # would compete for the same timed-out socket while OIP is stopped.
        self.thread.start()

    def arm(self, rearm=False):
        with self.lock:
            if self.scene_state() is not True:
                raise RuntimeError('OIP 场景尚未运行或运行状态未知')
            super().arm(rearm=rearm)

    def disarm(self):
        # State readers must not wait for an unavailable device. Network work
        # is serialized separately, with no status lock held across a socket.
        with self.lock:
            self.armed=False
            connected=self.connected
        if connected:
            try:self.exchange(b'\x0f\0\0\0\x08\x01\0')
            except (OSError,RuntimeError):pass

    def _transact(self, pdu, transaction):
        self.peer.sendall(struct.pack('>HHHB', transaction, 0, len(pdu) + 1, 1) + pdu)
        tid, protocol, length, unit = struct.unpack('>HHHB', receive(self.peer, 7))
        if (tid, protocol, unit) != (transaction, 0, 1) or not 2 <= length <= 254:
            raise RuntimeError('Invalid OIP Modbus response header')
        reply = receive(self.peer, length - 1)
        if pdu[0] == 2:
            if len(reply) != 3 or reply[:2] != b'\x02\x01':
                raise RuntimeError('Invalid OIP discrete-input response')
        elif reply != pdu[:5]:
            raise RuntimeError('OIP did not acknowledge the requested coil write')
        self.last_exchange_at=time.monotonic()
        if pdu[0]==15:self.last_written_zero=pdu[-1]==0
        return reply

    def _coil_pdu(self, bits):
        outputs=self.config['outputs'];first=min(outputs[name]['address'] for name in ('conveyor','entryConveyor'))
        mapped=0
        for bit,name in ((0,'entryConveyor'),(1,'conveyor')):
            if bits & (1<<bit):mapped |= 1<<(outputs[name]['address']-first)
        return struct.pack('>BHHBB',15,first,2,1,mapped)

    def _request(self, pdu, transaction):
        if self.peer is None:
            with self.lock:self.remote_outputs_zero=False
            self.peer=socket.create_connection(('127.0.0.1',self.target_port),self.timeout)
            self.peer.settimeout(self.timeout)
            # OIP retains its coil image after master loss. The FIRST transaction
            # must clear both outputs atomically; even a read can revive old bits.
            self._transact(self._coil_pdu(0),transaction)
            with self.lock:
                self.last_zero_ack=time.time();self.remote_outputs_zero=True
                if self.ever_connected:
                    self.requires_rearm=True;self.armed=False;self.generation+=1
            self.ever_connected=True
        elif self.last_exchange_at is not None and time.monotonic()-self.last_exchange_at>.8:
            # OIP also keeps coil images after its one-second request watchdog.
            # A suspended adapter must clear them before its first resumed read.
            with self.lock:self.requires_rearm=True;self.armed=False;self.generation+=1;self.remote_outputs_zero=False
            self._transact(self._coil_pdu(0),transaction)
            with self.lock:self.last_zero_ack=time.time();self.remote_outputs_zero=True
        with self.lock:
            if pdu[0]==15 and not self.armed:pdu=self._coil_pdu(0)
        return self._transact(pdu,transaction)

    def _failed(self, exc):
        with self.io_lock:
            if self.peer is not None:
                self.peer.close();self.peer=None
            self.retry_at=time.monotonic()+.4
            super()._failed(exc)

    def close(self):
        super().close()
        with self.io_lock:
            if self.peer is not None:self.peer.close();self.peer=None

    def exchange(self, pdu, transaction=0):
        read = pdu == b'\x02\0\0\0\x08'
        write = len(pdu) == 7 and pdu[:6] == b'\x0f\0\0\0\x08\x01'
        if not read and not write:
            raise ValueError('Only the reviewed batch simulation input/output mailbox is supported')
        if write and pdu[-1] & ~3:
            raise ValueError('Unmapped PLC output bits are not permitted')
        with self.io_lock:
            if time.monotonic()<self.retry_at:raise RuntimeError('OIP reconnect backoff')
            try:
                if read:
                    point = self.config['inputs']['sensorOccupied']
                    reply = self._request(struct.pack('>BHH', 2, point['address'], 1), transaction)
                    occupied = bool(reply[2] & 1) == point['activeHigh']
                    with self.lock:self.raw_occupied = occupied
                    response = bytes([2, 1, int(not occupied) | (2 if self.scene_state() is True else 0)])
                else:
                    with self.lock:bits = pdu[-1] if self.armed and self.scene_state() is True else 0
                    self._request(self._coil_pdu(bits), transaction)
                    with self.lock:
                        self.remote_outputs_zero = self.last_written_zero
                        if self.remote_outputs_zero:self.last_zero_ack = time.time()
                    response = pdu[:5]
                with self.lock:
                    self.connected = True
                    self.last_success = time.time()
                    self.error = None
                return response
            except (OSError, RuntimeError) as exc:
                self._failed(exc)
                raise


def valid_peer(address, headers, manifest):
    return (address == '127.0.0.1'
            and headers.get('X-PLCdev-Session') == manifest['sessionId']
            and (not manifest.get('configFingerprint') or (headers.get('X-PLCdev-Project') == manifest.get('projectId') and headers.get('X-PLCdev-Config') == manifest['configFingerprint']))
            and not headers.get('Origin')
            and headers.get('Host') == '127.0.0.1:' + str(manifest['batchHttpPort']))


class FuxaOIPBridge(legacy.BatchBridge):
    def __init__(self, manifest, guard=None):
        # Keep the legacy PLC mailbox/state machine, substituting only transport
        # and presentation. No legacy guard is constructed against a FIO port.
        self.manifest=manifest;self.lock=threading.RLock();self.halt=threading.Event()
        self.guard = guard if guard is not None else OIPGuard(manifest['oipDevice'])
        self.input_regs=[0]*3;self.output_regs=[0]*8;self.plc_at=0.;self.hmi_at=0.
        self.last_inputs=0;self.raw_inputs=0;self.scene_at=0.;self.runtime='STOPPED';self.ready=False
        self.message='先运行 OIP 场景，再运行 Runtime；批次须另行启动';self.sequence=0;self.clients={};self.pending=False
        self.manual_rearm=False;self.was_online=False;self.enabled=False;self.events=deque();self.event_log=[]
        self.values={};self.ticks=[];self.history=None;self.restore_pending=False

    def snapshot(self):
        result = super().snapshot()
        result.pop('factoryRawInputs', None);result.pop('factoryInputMap', None)
        result.update(provider='fuxa-oip', hmiProvider='fuxa', simulationProvider='oip',
                      sceneRunning=self.guard.status().get('sceneRunning'),
                      oipInputs={'sensorOccupied':self.guard.status().get('sensorOccupied')},
                      browserLeaseSeconds=1.5)
        result.update(projectId=self.manifest.get('projectId'),configFingerprint=self.manifest.get('configFingerprint'))
        known=result['telemetryFresh'] or self.runtime=='STOPPED';values={key.upper():value for key,value in self.values.items()}
        result['variables']=[{'path':point['path'],'type':point['type'],'role':role,'value':values.get(point['path'].upper()) if known else None,'fresh':bool(result['telemetryFresh']),'quality':'live' if result['telemetryFresh'] else 'historical' if known and point['path'].upper() in values else 'unknown'} for role,point in self.manifest.get('plcBindings',{}).items()]
        result['lastCommand'] = result['lastCommand'].replace('Factory I/O', 'OIP')
        return result

    def native(self):
        # Deliberately read-only: server polling is not evidence of a visible HMI.
        state = self.snapshot()
        return ''.join(str(k)+'='+str(v)+'\n' for k,v in {
            'runtime':state['runtimeState'], 'count':state['count'], 'target':state['target'],
            'hmi_connected':int(state['hmiConnected']), 'scene_running':state['sceneRunning'],
            'needs_recovery':int(state['requiresManualRecovery'])}.items())

    def heartbeat(self):
        with self.lock:
            self.hmi_at = time.monotonic()
        return {'ok':True,'leaseSeconds':1.5}

    def role_pdu(self,pdu,cycle):
        """Gather scatter-address I/O into one stable logical mailbox cycle.

        The stock driver batches all IEC buffer writes/reads under its mutex.
        Freeze read tuples and publish output tuples only after every role has
        arrived, so arbitrary user IEC addresses retain the mailbox semantics.
        """
        fc=pdu[0]
        if len(pdu)<5:return bytes([fc|128,2])
        first,count=struct.unpack('>HH',pdu[1:5])
        if fc in (2,3) and len(pdu)==5 and count>=1 and first+count<=3:
            key='inputs' if fc==2 else 'commands'
            if first==0:
                with self.lock:
                    if fc==2:
                        scene_fresh=time.monotonic()-self.scene_at<.5
                        mask=self.last_inputs&3 if scene_fresh else 0
                        if scene_fresh and self.hmi_fresh() and self.guard.status()['armed'] and self.enabled:mask|=4
                        cycle[key]=[(mask>>bit)&1 for bit in range(3)]
                    else:cycle[key]=list(self.input_regs)
            if key not in cycle:return bytes([fc|128,2])
            values=cycle[key][first:first+count]
            return bytes([2,1,sum(bit<<index for index,bit in enumerate(values))]) if fc==2 else bytes([3,2*count])+struct.pack('>'+str(count)+'H',*values)
        if fc in (15,16):
            limit=2 if fc==15 else 8;size=(count+7)//8 if fc==15 else count*2
            if not 1<=count<=limit or first+count>limit or len(pdu)!=6+size or pdu[5]!=size:return bytes([fc|128,2])
            key='coils' if fc==15 else 'registers'
            if first==0:cycle[key]=[]
            if key not in cycle or len(cycle[key])!=first:return bytes([fc|128,2])
            cycle[key].extend([(pdu[6+i//8]>>(i%8))&1 for i in range(count)] if fc==15 else struct.unpack('>'+str(count)+'H',pdu[6:]))
            if len(cycle[key])==limit:
                if fc==16:
                    with self.lock:self.output_regs=list(cycle[key]);self.plc_at=time.monotonic()
                else:
                    with self.lock:allowed=self.hmi_fresh() and self.runtime=='RUNNING' and self.enabled
                    bits=sum(bit<<index for index,bit in enumerate(cycle[key])) if allowed else 0
                    try:self.guard.exchange(b'\x0f\0\0\0\x08\x01'+bytes([bits]))
                    except (OSError,RuntimeError):pass
                del cycle[key]
            return pdu[:5]
        return bytes([fc|128,2])

    def modbus_peer(self,peer):
        if not self.manifest.get('configFingerprint'):return super().modbus_peer(peer)
        cycle={}
        try:
            with peer:
                peer.settimeout(1)
                while not self.halt.is_set():
                    header=receive(peer,7);tid,proto,length,unit=struct.unpack('>HHHB',header)
                    if proto or unit!=1 or not 2<=length<=254:raise ValueError('Invalid Modbus header')
                    response=self.role_pdu(receive(peer,length-1),cycle)
                    peer.sendall(struct.pack('>HHHB',tid,0,len(response)+1,1)+response)
        except (OSError,ValueError):pass

    def authorize(self, request, client):
        if request.get('program') != self.manifest['programHash']:
            raise ValueError('程序版本不匹配，旧请求已拒绝')
        seq = int(request['sequence']);expiry = float(request['expires']);now = time.time()
        if seq <= self.clients.get(client,0) or seq > 2147483647:
            raise ValueError('重复或过期序号，未重放')
        self.clients[client] = seq
        if not math.isfinite(expiry) or not now <= expiry <= now + 5:
            raise ValueError('请求过期，未执行')
        kind = int(request['kind']);value = int(request['value'])
        management = client.startswith('management:')
        allowed=(9,10) if management else range(1,9)
        if kind not in allowed:
            raise ValueError('运行管理与批次业务必须使用各自入口')
        if not 0 <= value <= 32767:
            raise ValueError('不支持的命令值')
        if not management and not self.hmi_fresh():
            raise ValueError('浏览器 HMI 心跳已失效，未执行')
        if kind==2 and (self.manual_rearm or self.restore_pending):
            raise ValueError('连接或 Runtime 恢复后须先核对数量，再发出新的启动请求')
        return kind,value,expiry

    def step(self, control):
        with self.lock:
            event = self.events.popleft() if self.events and self.events[0]['kind'] in (9,10) else None
        if event is None:
            super().step(control)
            self.message = self.message.replace('Factory I/O','OIP')
            return
        try:
            if time.time() > event['expiry']:
                raise ValueError('请求过期，未执行')
            self.enabled=False;self.guard.disarm()
            if event['kind'] == 9:
                if self.runtime != 'STOPPED':
                    raise ValueError('Runtime 已运行')
                control.change('START');self.runtime='RUNNING'
                if control.debug([0x45,0,0]) != b'\x45\x7e'+self.manifest['programMd5'].encode()+b'\xad\xde':
                    raise RuntimeError('Loaded PLC identity mismatch')
                time.sleep(.15)
                if self.history:
                    self.restore_pending=True;self.manual_rearm=True
                if not self.manual_rearm and self.hmi_fresh() and self.guard.status().get('sceneRunning') is True:
                    self.guard.arm();self.enabled=True
                else:
                    self.manual_rearm=True
                self.message='Runtime 已运行；批次仍需画面在线、数量确认和新的启动请求'
            else:
                if self.telemetry_fresh():
                    self.history=list(self.output_regs)
                self.restore_pending=self.history is not None
                if self.runtime == 'RUNNING':
                    time.sleep(.15);control.change('STOP')
                self.runtime='STOPPED';self.manual_rearm=True
                self.message='Runtime 已停止；历史数量保留，画面离线不影响管理停止'
            event['ok']=True
        except (OSError,RuntimeError,ValueError,TimeoutError) as exc:
            event['error']=str(exc);self.message=str(exc)
        finally:
            self.event_log.append({k:v for k,v in event.items() if k!='done'});event['done'].set()

    def start(self):
        self.guard.start()
        def sample_oip():
            while not self.halt.is_set():
                try:
                    reply=self.guard.exchange(b'\x02\0\0\0\x08')
                    with self.lock:
                        self.raw_inputs=reply[2];self.last_inputs=reply[2]&3;self.scene_at=time.monotonic()
                except (OSError,RuntimeError):
                    pass
                self.halt.wait(.03)
        threading.Thread(target=sample_oip,daemon=True).start()
        listener=socket.socket();listener.bind(('127.0.0.1',self.manifest['batchModbusPort']));listener.listen(8);listener.settimeout(.2);self.listener=listener
        threading.Thread(target=self.serve_modbus,daemon=True).start()
        bridge=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,code,value):
                raw=json.dumps(value,ensure_ascii=False).encode('utf-8');self.send_response(code)
                self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(raw)))
                self.send_header('Cache-Control','no-store');self.end_headers()
                try:self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            def do_GET(self):
                if not valid_peer(self.client_address[0],self.headers,bridge.manifest):self.reply(403,{'ok':False});return
                if self.path in ('/state','/native'):self.reply(200,bridge.snapshot())
                else:self.reply(404,{'ok':False})
            def do_POST(self):
                if not valid_peer(self.client_address[0],self.headers,bridge.manifest):self.reply(403,{'ok':False});return
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<=length<=2000:raise ValueError('请求长度错误')
                    raw=self.rfile.read(length).decode('utf-8')
                    fields=json.loads(raw or '{}') if self.headers.get('Content-Type','').startswith('application/json') else {k:v[0] for k,v in parse_qs(raw,strict_parsing=True).items()}
                    if not isinstance(fields,dict):raise ValueError('Expected a request object')
                    client=self.headers.get('X-PLCdev-Client','browser')
                    if not re.fullmatch('[a-z0-9-]{1,32}',client):raise ValueError('客户端标识无效')
                    if self.path=='/heartbeat':self.reply(200,bridge.heartbeat());return
                    if self.path not in ('/command','/management'):self.reply(404,{'ok':False});return
                    result=bridge.command(fields,('management:' if self.path=='/management' else 'browser:')+client)
                    self.reply(200,result)
                except (ValueError,KeyError,TypeError,TimeoutError) as exc:
                    with bridge.lock:bridge.message=str(exc).replace('Factory I/O','OIP')
                    self.reply(409,{'ok':False,'error':bridge.message})
        self.http=ThreadingHTTPServer(('127.0.0.1',self.manifest['batchHttpPort']),Handler)
        self.http.daemon_threads=True;threading.Thread(target=self.http.serve_forever,daemon=True).start()


def main():
    legacy.BatchBridge = FuxaOIPBridge
    return legacy.main()


if __name__=='__main__':
    raise SystemExit(main())
