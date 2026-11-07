"""Local-only HMI mailbox and Factory I/O adapter for the isolated batch Runtime.

PLC commands use normal Modbus input registers; telemetry uses output registers.
The PLC owns the state machine. No debug forcing, remote host or hardware writes.
"""
from __future__ import annotations
from collections import deque
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
import json,os,re,signal,socket,struct,threading,time
from runtime_monitor import Control,write_json
from editor_runtime_guard import ModbusGuard,receive
from telemetry_reader import read_values

HERE=Path.cwd().resolve();OUT=HERE.parent
PHASES=['待新批次／可设置目标','启动延时中','输送中','已停止，计数保留','故障锁存','批次完成','数量待核对，等待恢复']
ACKS=['PLC 已接受','本批目标已冻结，停止后也不能修改','参数范围错误','故障尚未解除或未复位','连接或数量状态未确认','批次已完成，请新建批次','光电处仍有箱子，请核对现场']

class BatchBridge:
    def __init__(self,manifest):
        self.manifest=manifest;self.lock=threading.RLock();self.halt=threading.Event()
        self.guard=ModbusGuard(1502 if manifest['batchMode']=='factoryio' else 1503)
        self.input_regs=[0]*3;self.output_regs=[0]*8;self.plc_at=0.;self.hmi_at=0.
        self.last_inputs=0;self.raw_inputs=0;self.scene_at=0.;self.runtime='STOPPED';self.ready=False
        self.message='请先运行 Factory I/O 场景，再运行 Runtime';self.sequence=0;self.clients={};self.pending=False
        self.manual_rearm=False;self.was_online=False;self.enabled=False;self.events=deque();self.event_log=[]
        self.values={};self.ticks=[]
        self.history=None;self.restore_pending=False
    def hmi_fresh(self):return time.monotonic()-self.hmi_at<1.5
    def telemetry_fresh(self):return self.runtime=='RUNNING' and time.monotonic()-self.plc_at<1.0
    def snapshot(self):
        with self.lock:
            regs=list(self.output_regs);guard=self.guard.status();fresh=self.telemetry_fresh()
            if (self.runtime!='RUNNING' or self.restore_pending) and self.history:regs=list(self.history)
            if self.restore_pending:regs[4]=6;regs[6]=(regs[6]|8)&~16
            scene_known=guard['connected'] and time.monotonic()-self.scene_at<1
            return {'schemaVersion':1,'sessionId':self.manifest['sessionId'],'programHash':self.manifest['programHash'],
                'mode':self.manifest['mode'],'ready':self.ready,'observedAt':time.time(),'phase':'running' if self.runtime=='RUNNING' else 'stopped',
                'runtimeState':self.runtime,'telemetryFresh':fresh,'values':self.values,'scanTicks':self.ticks,
                'communication':guard,'hmiConnected':self.hmi_fresh(),'sceneRunning':bool(self.last_inputs&2) if scene_known else None,
                'requiresManualRecovery':self.manual_rearm or bool(regs[6]&8) or self.restore_pending,
                'count':regs[2],'target':regs[3],'batchState':regs[4],'remainingMs':regs[5],'flags':regs[6],'batchId':regs[7],
                'countKnown':fresh and bool(regs[6]&16),'targetLocked':bool(regs[6]&1),'lastCommand':self.message,
                'ackSequence':regs[0],'ackCode':regs[1],'pending':self.pending,'physicalHardware':False,
                'factoryRawInputs':self.raw_inputs,'factoryInputMap':self.manifest.get('factoryInputMap',{'sensorClear':0,'sceneRunning':1})}
    def native(self):
        with self.lock:self.hmi_at=time.monotonic()
        s=self.snapshot();fresh=s['telemetryFresh'];known=s['countKnown'];state=s['batchState']
        lines={
            'hmi':'HMI—PLC：通道在线'+('，数据实时' if fresh else '，数据已过期'),
            'factory':'PLC—Factory I/O：'+('已连接，场景运行' if s['sceneRunning'] else '已连接，场景停止' if s['sceneRunning'] is False else '失联，场景状态未知'),
            'runtime':'Runtime：'+('运行中' if s['runtimeState']=='RUNNING' else '已停止'),
            'count':(str(s['count'])+(' 件' if known else ' 件（历史值／数量待核对）')) if fresh or self.history else '尚未读取 PLC 计数',
            'target':(str(s['target'])+(' 件（本批冻结）' if s['targetLocked'] else ' 件（可提交修改）')) if fresh or self.history else '尚未读取 PLC 目标',
            'phase':('连接待确认，请核对数量后恢复' if s['requiresManualRecovery'] else PHASES[state] if 0<=state<len(PHASES) else '状态未知') if fresh else ('历史值；Runtime 已停止' if s['runtimeState']!='RUNNING' else '变量更新中断；等待通信恢复'),
            'countdown':('倒计时：%.1f 秒'%(max(0,s['remainingMs'])/1000)) if fresh and state==1 else '延时启动：3 秒',
            'result':'待应用：等待 PLC 确认' if s['pending'] else s['lastCommand'],
            'rule':'新批次且计数为零时可改目标' if not s['targetLocked'] else '本批目标已冻结；复位保留计数',
            'can_command':int(fresh),'can_target':int(fresh and not s['targetLocked'] and s['count']==0),
            'can_start':int(fresh and known and s['count']<s['target'] and not s['requiresManualRecovery'] and not(s['flags']&4) and s['sceneRunning'] is True),
            'count_number':s['count'],'needs_recovery':int(s['requiresManualRecovery'])}
        return ''.join(str(k)+'='+str(v).replace('\n',' ')+'\n' for k,v in lines.items())
    def authorize(self,request,client):
        if request.get('program')!=self.manifest['programHash']:raise ValueError('程序版本不匹配，旧请求已拒绝')
        seq=int(request['sequence']);now=time.time();expiry=float(request['expires'])
        if seq<=self.clients.get(client,0):raise ValueError('重复或过期序号，未重放')
        self.clients[client]=seq
        if not now<=expiry<=now+5:raise ValueError('请求过期，未执行')
        kind=int(request['kind']);value=int(request['value'])
        if kind not in range(1,11) or not 0<=value<=32767:raise ValueError('不支持的命令或值')
        if not self.hmi_fresh():raise ValueError('HMI 心跳已失效，未执行')
        return kind,value,expiry
    def command(self,request,client):
        with self.lock:
            kind,value,expiry=self.authorize(request,client)
            if self.pending:raise ValueError('已有命令待确认，未执行新命令')
            if kind<9 and not self.telemetry_fresh():raise ValueError('Runtime 已停止或数据过期，未执行')
            self.pending=True
            event={'kind':kind,'value':value,'expiry':expiry,'done':threading.Event(),'ok':False}
            self.events.append(event)
        try:
            if not event['done'].wait(max(0,expiry-time.time())):raise TimeoutError('请求超时；结果未知，请核对 PLC')
            if not event['ok']:raise ValueError(event.get('error','命令拒绝'))
            return {'ok':True,'applied':True,'kind':kind,'value':value,'ackSequence':event.get('plcSequence')}
        finally:
            # The monitor checks the deadline again before publishing the mailbox.
            with self.lock:self.pending=False
    def start(self):
        self.guard.start()
        def sample_factory():
            while not self.halt.is_set():
                try:
                    reply=self.guard.exchange(b'\x02\0\0\0\x08')
                    mapping=self.manifest.get('factoryInputMap',{'sensorClear':0,'sceneRunning':1})
                    raw=reply[2]
                    normalized=((raw>>mapping['sensorClear'])&1)|(((raw>>mapping['sceneRunning'])&1)<<1)
                    with self.lock:self.raw_inputs=raw;self.last_inputs=normalized;self.scene_at=time.monotonic()
                except (OSError,RuntimeError):pass
                self.halt.wait(.03)
        threading.Thread(target=sample_factory,daemon=True).start()
        listener=socket.socket();listener.bind(('127.0.0.1',self.manifest['batchModbusPort']));listener.listen(8);listener.settimeout(.2);self.listener=listener
        threading.Thread(target=self.serve_modbus,daemon=True).start()
        bridge=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def valid(self):
                return (self.client_address[0]=='127.0.0.1' and self.headers.get('X-PLCdev-Session')==bridge.manifest['sessionId']
                        and not self.headers.get('Origin') and self.headers.get('Host')=='127.0.0.1:'+str(bridge.manifest['batchHttpPort']))
            def reply(self,code,body,content='application/json; charset=utf-8'):
                raw=body.encode('utf-8');self.send_response(code);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers()
                try:self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            def do_GET(self):
                if not self.valid():self.reply(403,'{}');return
                if self.path=='/native':self.reply(200,bridge.native(),'text/plain; charset=utf-8')
                elif self.path=='/state':self.reply(200,json.dumps(bridge.snapshot(),ensure_ascii=False))
                else:self.reply(404,'{}')
            def do_POST(self):
                if not self.valid():self.reply(403,'{}');return
                if self.path!='/command':self.reply(404,'{}');return
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<length<=1000:raise ValueError('请求长度错误')
                    fields={k:v[0] for k,v in parse_qs(self.rfile.read(length).decode('utf-8'),strict_parsing=True).items()}
                    client=self.headers.get('X-PLCdev-Client','desktop')
                    if not re.fullmatch('[a-z0-9-]{1,32}',client):raise ValueError('客户端标识无效')
                    result=bridge.command(fields,client);self.reply(200,json.dumps(result,ensure_ascii=False))
                except (ValueError,KeyError,TimeoutError) as exc:
                    with bridge.lock:bridge.message=str(exc)
                    self.reply(409,json.dumps({'ok':False,'error':str(exc)},ensure_ascii=False))
        self.http=ThreadingHTTPServer(('127.0.0.1',self.manifest['batchHttpPort']),Handler)
        self.http.daemon_threads=True;threading.Thread(target=self.http.serve_forever,daemon=True).start()
    def serve_modbus(self):
        while not self.halt.is_set():
            try:peer,_=self.listener.accept()
            except socket.timeout:continue
            except OSError:return
            threading.Thread(target=self.modbus_peer,args=(peer,),daemon=True).start()
    def modbus_peer(self,peer):
        try:
            with peer:
                peer.settimeout(1)
                while not self.halt.is_set():
                    header=receive(peer,7);tid,proto,length,unit=struct.unpack('>HHHB',header)
                    if proto or unit!=1 or not 2<=length<=254:raise ValueError('Invalid Modbus header')
                    pdu=receive(peer,length-1);fc=pdu[0]
                    if fc==2 and pdu==b'\x02\0\0\0\x08':
                        with self.lock:
                            fresh_scene=time.monotonic()-self.scene_at<.5
                            mask=self.last_inputs&3 if fresh_scene else 0
                            if fresh_scene and self.hmi_fresh() and self.guard.status()['armed'] and self.enabled:mask|=4
                        response=bytes([2,1,mask])
                    elif fc==3 and pdu==b'\x03\0\0\0\x03':
                        with self.lock:response=bytes([3,6])+struct.pack('>3H',*self.input_regs)
                    elif fc==15 and len(pdu)==7 and pdu[1:6]==b'\0\0\0\x08\x01':
                        with self.lock:allowed=self.hmi_fresh() and self.runtime=='RUNNING' and self.enabled
                        try:self.guard.exchange(pdu if allowed else pdu[:6]+b'\0')
                        except (OSError,RuntimeError):pass
                        response=pdu[:5] # mailbox delivery ACK; external-device ACK is a separate status
                    elif fc==16 and len(pdu)==22 and pdu[1:6]==b'\0\0\0\x08\x10':
                        with self.lock:self.output_regs=list(struct.unpack('>8H',pdu[6:]));self.plc_at=time.monotonic()
                        response=pdu[:5]
                    else:response=bytes([fc|128,2])
                    peer.sendall(struct.pack('>HHHB',tid,0,len(response)+1,1)+response)
        except (OSError,ValueError):pass
    def step(self,control):
        if self.was_online and not self.hmi_fresh():
            self.enabled=False;self.manual_rearm=True;self.guard.disarm()
        if self.hmi_fresh():self.was_online=True
        if self.guard.status()['requiresRearm']:self.enabled=False;self.manual_rearm=True
        with self.lock:event=self.events.popleft() if self.events else None
        if event is None:return
        try:
            kind,value,expiry=event['kind'],event['value'],event['expiry']
            if time.time()>expiry:raise ValueError('请求过期，未执行')
            if kind==9:
                if self.runtime!='STOPPED':raise ValueError('Runtime 已运行')
                self.enabled=False;self.guard.disarm();control.change('START');self.runtime='RUNNING'
                if control.debug([0x45,0,0])!=b'\x45\x7e'+self.manifest['programMd5'].encode()+b'\xad\xde':raise RuntimeError('Loaded PLC identity mismatch')
                time.sleep(.15)
                if self.history:self.restore_pending=True;self.manual_rearm=True
                if not self.manual_rearm:self.guard.arm();self.enabled=True
                self.message='Runtime 已运行；批次仍等待新的启动请求'
            elif kind==10:
                if self.telemetry_fresh():self.history=list(self.output_regs)
                self.restore_pending=self.history is not None
                self.enabled=False;self.guard.disarm()
                if self.runtime=='RUNNING':
                    # Give the PLC a scan with Permit=FALSE before stopping the engine.
                    time.sleep(.15);control.change('STOP')
                self.runtime='STOPPED';self.manual_rearm=True;self.message='Runtime 已停止；显示历史值，恢复前需核对数量'
            else:
                if self.runtime!='RUNNING' or not self.telemetry_fresh():raise ValueError('Runtime 已停止或数据过期')
                if self.restore_pending and kind not in (3,4,5,6,8):raise ValueError('Runtime 重启后须先核对已通过数量并恢复')
                if kind==8:
                    if not self.guard.status()['connected']:raise ValueError('Factory I/O 尚未连接，场景状态未知')
                    self.guard.arm(rearm=True);self.enabled=True
                    time.sleep(.1)
                    if self.restore_pending and self.history:
                        # New Runtime START reloads non-retentive variables. Restore
                        # the frozen target through the ordinary PLC mailbox, then
                        # apply the operator-confirmed count; never invent a count.
                        self.sequence+=1
                        with self.lock:self.input_regs=[self.sequence,1,self.history[3]]
                        while time.time()<expiry:
                            with self.lock:target_ack,target_code=self.output_regs[:2]
                            if target_ack==self.sequence:
                                if target_code:raise ValueError('PLC 拒绝恢复原批次目标')
                                break
                            time.sleep(.02)
                        else:raise TimeoutError('恢复目标确认超时')
                self.sequence+=1
                if self.sequence>30000:raise RuntimeError('Mailbox sequence exhausted; start a fresh session')
                with self.lock:self.input_regs=[self.sequence,kind,value]
                event['plcSequence']=self.sequence
                while time.time()<=expiry:
                    with self.lock:ack,code=self.output_regs[:2]
                    if ack==self.sequence:
                        if code:raise ValueError(ACKS[code] if code<len(ACKS) else 'PLC 拒绝请求')
                        if kind==8:self.manual_rearm=False;self.restore_pending=False;self.history=None
                        self.message=ACKS[0]+('：目标 '+str(value) if kind==1 else '：计数已核对，仍需另行启动' if kind==8 else '，计数保留' if kind in (3,6) else '')
                        break
                    time.sleep(.02)
                else:raise TimeoutError('PLC 应用结果超时，未自动重试')
            event['ok']=True
        except (OSError,RuntimeError,ValueError,TimeoutError) as exc:
            event['error']=str(exc);self.message=str(exc)
            # Withdraw an unacknowledged mailbox action before any reconnect.
            # If it was already applied, the result remains explicitly unknown.
            if kind<9:
                with self.lock:self.input_regs=[self.sequence,0,0]
        finally:
            self.event_log.append({k:v for k,v in event.items() if k!='done'});event['done'].set()
    def close(self):
        self.enabled=False;self.guard.disarm();self.halt.set();self.http.shutdown();self.listener.close();self.guard.close()

def main():
    manifest=json.loads((OUT/'session.json').read_text(encoding='utf-8'))
    if HERE.name!='runtime' or 'editor-runtime' not in HERE.parts or not manifest.get('batchExample'):raise RuntimeError('Owned batch Runtime required')
    bridge=BatchBridge(manifest);client=Control();server=peer=None;owned=None;drained=threading.Event();result={'result':'running'}
    try:
        bridge.start();server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind('./log_runtime.socket');server.listen(1)
        def drain():
            nonlocal peer
            try:
                peer,_=server.accept()
                with (OUT/'runtime-socket.log').open('wb') as stream:
                    while chunk:=peer.recv(65536):stream.write(chunk);stream.flush()
            except OSError:pass
            finally:drained.set()
        threading.Thread(target=drain,daemon=True).start();(OUT/'client-ready').write_text('ready\n')
        deadline=time.monotonic()+20
        while not (OUT/'process-owner.json').exists() and time.monotonic()<deadline:time.sleep(.025)
        owner=json.loads((OUT/'process-owner.json').read_text(encoding='utf-8'))
        while owned is None and time.monotonic()<deadline:
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit():continue
                try:
                    if int((proc/'winpid').read_text())==owner['windowsPid']:
                        if str((proc/'exe').resolve()).removesuffix('.exe')!=str((HERE/'daemon-build/plc_main.exe').resolve()).removesuffix('.exe'):raise RuntimeError('Owned executable mismatch')
                        owned=int(proc.name);break
                except (OSError,ValueError):pass
            time.sleep(.025)
        if owned is None:raise RuntimeError('Owned Runtime not found')
        while time.monotonic()<deadline:
            try:client.connect();break
            except OSError:time.sleep(.05)
        client.wait('STOPPED');bridge.ready=True
        leaves=json.loads((HERE/'core/generated/debug-map.json').read_text(encoding='utf-8'))['leaves']
        deadline=time.monotonic()+manifest['durationSeconds'];last_tick=None;changed=time.monotonic()
        while not (OUT/'stop.request').exists() and time.monotonic()<deadline:
            previous_runtime=bridge.runtime
            bridge.runtime=client.command('STATUS').removeprefix('STATUS:')
            if previous_runtime=='RUNNING' and bridge.runtime=='STOPPED':
                bridge.enabled=False;bridge.manual_rearm=True;bridge.restore_pending=bridge.history is not None
            bridge.step(client)
            if bridge.runtime=='RUNNING':
                ticks,values=read_values(client,leaves);bridge.values=values;bridge.ticks=ticks
                if ticks!=last_tick:changed=time.monotonic();last_tick=ticks
                if time.monotonic()-changed>1.5:raise RuntimeError('PLC scan frozen; data invalid')
                if bridge.telemetry_fresh() and not bridge.restore_pending:bridge.history=list(bridge.output_regs)
            write_json(OUT/'state.json',bridge.snapshot());time.sleep(.06)
        bridge.enabled=False;bridge.guard.disarm()
        if client.command('STATUS')=='STATUS:RUNNING':client.change('STOP')
        bridge.runtime='STOPPED';bridge.ready=False;write_json(OUT/'state.json',bridge.snapshot());result['result']='passed'
    except Exception as exc:
        result.update(result='failed',error=str(exc));bridge.enabled=False;bridge.ready=False;bridge.runtime='UNAVAILABLE';write_json(OUT/'state.json',bridge.snapshot())
    finally:
        if client.sock:client.sock.close()
        if owned:
            try:os.kill(owned,signal.SIGTERM)
            except ProcessLookupError:pass
            drained.wait(5)
        bridge.close()
        for endpoint in [peer,server]:
            if endpoint:endpoint.close()
        write_json(OUT/'batch-command-log.json',bridge.event_log);write_json(OUT/'monitor-result.json',result)
    return 0 if result['result']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
