"""Project-declared local HMI interface; no batch semantics or external device I/O."""
from __future__ import annotations
import hashlib, json, os, secrets, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

from factoryio_runtime import ROOT, store
from workbench_start_stop import read, env, NO_WINDOW
from workbench_user_project import UserProjectManager
from workbench_fuxa_oip import FuxaOipManager, local_paths, allocate, FUXA_PACKAGE
from launch_fuxa_oip import identity, open_port


def fingerprint(project):
    from project_interface import validate_interface
    manifest = read(Path(project['manifestPath']))
    if not isinstance(manifest, dict) or manifest.get('id') != project['id']:
        raise ValueError('工程身份已改变，请重新打开工程')
    definition = validate_interface(read(Path(project['interfacePath'])))
    content = {'projectId': project['id'], 'application': manifest.get('application'),
               'target': manifest.get('target'), 'hmi': manifest.get('hmi'),
               'interface': manifest.get('interface'), 'definition': definition,
               'manifest':manifest}
    if project.get('modelBindingsPath'):
        from workbench_project_config import model_simulation_definition, validate_oip
        root=Path(project['projectRoot']).resolve()
        model=model_simulation_definition(manifest['simulation'],root,definition)
        content['modelBindingHash']=model['modelBindingHash']
        if model.get('scene'):
            content['sceneFiles']={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in validate_oip(model['scene'])['files']}
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


class InterfaceBridge:
    """Private loopback bridge; FUXA has no direct Runtime write capability."""
    def __init__(self, manager):
        self.manager = manager
        self.token = secrets.token_urlsafe(32)
        self.clients = {}
        self.lock = threading.RLock()
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, code, data):
                raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                try: self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError): pass
            def authenticated(self):
                m = bridge.manager
                manifest = m.manifest or {}
                expected_host = '127.0.0.1:' + str(bridge.server.server_port)
                if (self.client_address[0] != '127.0.0.1' or self.headers.get('Host') != expected_host
                    or self.headers.get('Origin') is not None
                    or not secrets.compare_digest(self.headers.get('X-PLCdev-Bridge', ''), bridge.token)
                    or self.headers.get('X-PLCdev-Project') != m.project['id']
                    or self.headers.get('X-PLCdev-Config') != m.config_hash
                    or not manifest.get('sessionId')
                    or self.headers.get('X-PLCdev-Session') != manifest['sessionId']):
                    raise PermissionError('工程接口身份或会话不匹配')
                if not m.current_configuration():
                    raise ValueError('工程声明已改变，旧会话操作已拒绝')
            def do_GET(self):
                try:
                    self.authenticated()
                    if self.path != '/state': self.reply(404, {'ok':False}); return
                    self.reply(200, bridge.state())
                except PermissionError as exc: self.reply(403, {'ok':False, 'error':str(exc)})
                except (ValueError, RuntimeError, OSError) as exc: self.reply(409, {'ok':False, 'error':str(exc)})
            def do_POST(self):
                try:
                    self.authenticated()
                    if self.path not in ('/heartbeat', '/command', '/management'):
                        self.reply(404, {'ok':False}); return
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 8192: raise ValueError('接口请求大小无效')
                    raw = self.rfile.read(length).decode('utf-8')
                    if self.headers.get('Content-Type', '').split(';')[0] == 'application/x-www-form-urlencoded':
                        parsed = parse_qs(raw, keep_blank_values=True, strict_parsing=True)
                        if any(len(v) != 1 for v in parsed.values()): raise ValueError('重复请求字段')
                        body = {k:v[0] for k,v in parsed.items()}
                        for key in ('kind','sequence'): 
                            if key in body: body[key] = int(body[key])
                        if 'expires' in body: body['expires'] = float(body['expires'])
                    elif self.headers.get('Content-Type', '').split(';')[0] == 'application/json': body = json.loads(raw)
                    else: raise ValueError('不支持的请求类型')
                    if not isinstance(body, dict): raise ValueError('请求必须为对象')
                    client = self.headers.get('X-PLCdev-Client', '')
                    self.reply(200, bridge.handle(self.path, client, body))
                except PermissionError as exc: self.reply(403, {'ok':False, 'error':str(exc)})
                except (ValueError, RuntimeError, OSError, KeyError) as exc:
                    self.reply(409, {'ok':False, 'error':str(exc)})
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def state(self):
        m = self.manager
        snap = m.snapshot()
        state = snap['state']
        available = {v['path'].upper():v for v in state.get('variables', [])}
        live = state.get('telemetryFresh') is True
        values = {}
        for declaration in m.interface['variables']:
            item = available.get(declaration['path'].upper())
            values[declaration['id']] = item.get('value') if item and live and item.get('fresh') is True else None
        return {'ok':True, 'projectId':m.project['id'], 'configFingerprint':m.config_hash,
                'sessionId':(m.manifest or {}).get('sessionId'), 'values':values,
                'telemetryFresh':live, 'runtimeState':state.get('runtimeState', 'UNKNOWN')}

    def handle(self, route, client, body):
        if not isinstance(client, str) or not 1 <= len(client) <= 64:
            raise ValueError('无效接口客户端')
        with self.lock:
            if client not in self.clients and len(self.clients) >= 256:
                raise ValueError('接口客户端数已达上限')
            state = self.clients.setdefault(client, {'command':0, 'management':0, 'heartbeat':0})
            if route == '/heartbeat':
                if body: raise ValueError('心跳不接受额外字段')
                state['heartbeat'] = time.monotonic()
                return {'ok':True}
            allowed = {'action','value','program','sequence','expires'} if route == '/command' else {'action','kind','value','program','sequence','expires'}
            if set(body) - allowed: raise ValueError('未知接口请求字段')
            expiry, sequence = body.get('expires'), body.get('sequence')
            if type(expiry) not in (int,float) or not time.time() <= expiry <= time.time()+5:
                raise ValueError('操作请求已过期')
            lane = 'command' if route == '/command' else 'management'
            if type(sequence) is not int or not 0 < sequence <= 2**53-1 or sequence <= state[lane]:
                raise ValueError('重复或过期操作序号')
            m = self.manager
            manifest = m.manifest or {}
            if not manifest.get('programHash') or body.get('program') != manifest['programHash']:
                raise ValueError('程序快照已改变')
            if not m.current_configuration(): raise ValueError('工程接口声明已改变')
            state[lane] = sequence
            if lane == 'command' and time.monotonic()-state['heartbeat'] > 1.5:
                raise ValueError('当前 HMI 心跳已失效，未执行操作')
        # Do not hold the heartbeat lock while waiting for a Runtime acknowledgement.
        if lane == 'command':
            def guard():
                with self.lock:
                    if state[lane] != sequence or time.monotonic()-state['heartbeat'] > 1.5:
                        raise ValueError('排队操作已被更新或 HMI 心跳已失效')
                    if (m.manifest or {}).get('sessionId') != manifest['sessionId']:
                        raise ValueError('排队期间会话已更换')
            if 'value' in body: result = m.perform_operation(body.get('action'), body['value'], expires=expiry, session_id=manifest['sessionId'], guard=guard)
            else: result = m.perform_operation(body.get('action'), expires=expiry, session_id=manifest['sessionId'], guard=guard)
            return {'ok':True, 'applied':True, 'action':body['action'], 'result':result}
        action = body.get('action') or {9:'run', 10:'stop'}.get(body.get('kind'))
        if action not in ('run','stop'): raise ValueError('无效 Runtime 管理操作')
        m.action({'action':'runtime-start' if action=='run' else 'runtime-stop',
                  'projectId':m.project['id'], 'sessionId':manifest['sessionId'], 'expires':body['expires']})
        return {'ok':True, 'applied':True, 'kind':9 if action=='run' else 10, 'value':0}


class FuxaLocalManager(UserProjectManager):
    """One project, one local Runtime, and its editable FUXA engineering file."""
    run_prefix = 'workbench-interface'
    allocated = FuxaOipManager.allocated
    tools_open = FuxaOipManager.tools_open
    tools_starting = FuxaOipManager.tools_starting
    fuxa_context = FuxaOipManager.fuxa_context
    open_fuxa = FuxaOipManager.open_fuxa
    verify_tool_listener = FuxaOipManager.verify_tool_listener
    flush_tools = FuxaOipManager.flush_tools
    queue_tool = FuxaOipManager.queue_tool

    def __init__(self, instance, project_config):
        super().__init__(instance, project_config)
        from project_interface import validate_interface
        self.mode = 'fuxa-local'
        self.interface = validate_interface(read(Path(self.project['interfacePath'])))
        self.config_hash = fingerprint(self.project)
        self.paths = local_paths(self.project)
        self.paths['session'] = self.paths['home']/('interface-session-'+hashlib.sha256(str(instance).encode()).hexdigest()[:16]+'.json')
        self.ports = None
        self.allocation_lock = threading.Lock()
        self.bridge_lock = threading.Lock()
        self.tools, self.tool_workers, self.tool_errors = {}, {}, {}
        self.bridge = None
        self.message = '本工程变量和操作已声明；打开 FUXA 编辑画面，编译后显式运行。'

    def current_configuration(self):
        try: return fingerprint(self.project) == self.config_hash
        except (ValueError, OSError, KeyError): return False

    def dependencies(self):
        return super().dependencies()+[
            {'id':'fuxa', 'label':'FUXA 本机编辑器', 'path':str(FUXA_PACKAGE/'main.js'), 'available':(FUXA_PACKAGE/'main.js').is_file()},
            {'id':'hmi-project', 'label':'本工程原生画面', 'path':str(self.project['hmi']), 'available':Path(self.project['hmi']).is_file()}]

    def ensure_bridge(self):
        self.allocated()
        with self.bridge_lock:
            if self.bridge is None: self.bridge = InterfaceBridge(self)
        self.publish_session()

    def publish_session(self):
        if self.bridge and self.manifest:
            store(self.paths['session'], {'projectId':self.project['id'], 'configFingerprint':self.config_hash,
                  'sessionId':self.manifest['sessionId'], 'programHash':self.manifest['programHash'],
                  'batchHttpPort':self.bridge.server.server_port, 'bridgeToken':self.bridge.token})

    def start(self, mode='fuxa-local'):
        if mode not in ('local','fuxa-local'): raise ValueError('当前工程只支持本机 Runtime')
        if not self.current_configuration(): raise ValueError('声明已改变，请重新打开工程')
        super().start('local')

    def build(self):
        super().build()
        if self.phase == 'ready':
            try: self.ensure_bridge()
            except Exception as exc:
                self.failure = str(exc)
                self.phase = 'fault'
                self.event('工程接口准备失败：'+str(exc))

    def snapshot(self):
        result = super().snapshot()
        changed = not self.current_configuration()
        opened, starting = self.tools_open(), self.tools_starting()
        active = result['session']['active']
        locked = opened or active or bool(starting) or result['phase'] in ('building','stopping')
        result.update(mode='fuxa-local', toolsOpen=opened, toolsStarting=starting,
                      toolErrors=dict(self.tool_errors), configurationLocked=locked,
                      configFingerprint=self.config_hash, projectChanged=result['projectChanged'] or changed)
        result['session'].update(mode='fuxa-local', configFingerprint=self.config_hash)
        item = self.tools.get('fuxa')
        alive = bool(item and item['process'].poll() is None)
        verified = bool(alive and item.get('verified') and not changed)
        result['hmiOpen'] = alive
        available = (FUXA_PACKAGE/'main.js').is_file()
        for key, label in (('eez','FUXA 编辑器'),('hmi','FUXA 运行画面')):
            result['components'][key] = {'available':available, 'state':'process-alive' if alive else 'available' if available else 'unavailable',
                'label':self.tool_errors.get('fuxa') or ('正在打开本工程画面' if starting else '本工程入口已启动' if alive else label+' · 尚未打开'),
                'path':str(FUXA_PACKAGE/'main.js'), 'projectFile':self.project['hmi'], 'projectId':self.project['id'],
                'windowVerified':False, 'projectOpenVerified':verified}
        result['components']['fuxa'] = dict(result['components']['eez'])
        caps = result['capabilities']
        caps.update(canOpenHmi=available and not starting and not changed, canShowHmi=available and not starting and not changed,
                    canEnd=(active or opened or self.bridge is not None) and not starting and result['phase']!='building',
                    canConfigureInterface=not locked, canInput=False)
        caps['tools'].update(eez=available and not starting and not changed, fuxa=available and not starting and not changed, factory=False, oip=False)
        if active: caps['canPrepare'] = False
        if changed:
            caps.update(canPrepare=False, canRun=False)
            caps['reasons']['canPrepare'] = '工程声明已改变；结束所属会话并重新打开工程。'
            caps['reasons']['canRun'] = caps['reasons']['canPrepare']
        live = result['state'].get('telemetryFresh') is True
        heartbeat = False
        if self.bridge:
            with self.bridge.lock:
                heartbeat = any(time.monotonic()-v['heartbeat'] < 1.5 for v in self.bridge.clients.values())
        result['links']['generate'] = {'source':'eez','target':'hmi','state':'current' if verified else 'unloaded',
                                      'label':'工程画面 · 原生可编辑', 'details':{'projectFile':self.project['hmi'], 'provider':'fuxa'}}
        result['links']['variables'] = {'source':'hmi','target':'runtime','state':'connected' if verified and live and heartbeat else 'inactive' if not active else 'disconnected',
            'label':'声明变量实时' if verified and live and heartbeat else '等待本工程画面／实时变量',
            'channelConnected':bool(verified and heartbeat), 'observedAt':result['state'].get('observedAt') if result['observerFresh'] else None,
            'dataFresh':bool(verified and live and heartbeat), 'dataQuality':'live' if verified and live and heartbeat else 'unknown',
            'details':{'protocol':'工程声明 · 本机 Runtime','projectId':self.project['id'],'sessionId':result['sessionId']}}
        return result

    def spawn_tool(self, kind):
        if kind != 'fuxa': raise ValueError('本工程未配置该工具')
        self.allocated()
        old = self.tools.get(kind)
        if old and old['process'].poll() is None: return old
        if not self.current_configuration(): raise ValueError('工程声明已改变，请重新打开')
        port = self.ports['fuxa']
        if open_port(port): raise ValueError('FUXA 端口被其他进程占用，未接管')
        self.ensure_bridge()
        ticket = secrets.token_hex(12)
        plan_path = self.paths['home']/('fuxa-'+ticket+'.json')
        plan = {'version':1,'kind':'fuxa','ticket':ticket,'projectId':self.project['id'],
            'parent':identity(os.getpid()),'home':str(self.paths['home']),'port':port,
            'argv':[sys.executable,'-B','-X','utf8',str(ROOT/'tools/run_fuxa.py'),'--profile',str(self.paths['fuxa']),
                    '--session-file',str(self.paths['session']),'--port',str(port)],
            'environment':{'PLCDEV_FUXA_PROJECT_FILE':self.project['hmi'],'PLCDEV_FUXA_PROJECT_ID':self.project['id'],
                'PLCDEV_FUXA_CONFIG_HASH':self.config_hash,'PLCDEV_FUXA_SESSION_FILE':str(self.paths['session']),
                'PLCDEV_FUXA_INTERFACE_FILE':self.project['interfacePath']}}
        store(plan_path, plan)
        with (self.paths['home']/'fuxa.log').open('ab') as log:
            child = subprocess.Popen([sys.executable,'-B','-X','utf8',str(ROOT/'tools/workbench_fuxa_oip.py'),'_tool','--plan',str(plan_path)],
                cwd=ROOT,env=env(),stdout=log,stderr=subprocess.STDOUT,creationflags=NO_WINDOW)
        item = {'process':child,'plan':plan_path,'stop':plan_path.with_suffix('.stop'),'verified':False}
        self.tools[kind] = item
        return item

    def tool(self, name):
        if name in ('fuxa','eez'): return self.queue_tool('fuxa','editor')
        return super().tool(name)

    def end(self):
        if self.worker and self.worker.is_alive(): raise ValueError('正在准备，请稍后结束')
        if self.tools_starting(): raise ValueError('工具仍在打开，请等待收束')
        self.flush_tools()
        super().end()
        for item in self.tools.values():
            if item['process'].poll() is None:
                item['stop'].write_text('owner ended project tools\n',encoding='utf-8')
                try: item['process'].wait(8)
                except subprocess.TimeoutExpired: raise ValueError('本工程工具尚未退出，配置继续锁定') from None
        if self.bridge:
            self.bridge.close()
            self.bridge = None
        if self.paths['session'].exists(): self.paths['session'].unlink()
        self.phase = 'ended'
        self.event('本工程画面已保存，工具与运行会话已结束。')

    def action(self, body):
        if body.get('action') in ('open-hmi','show-hmi'):
            with self.action_lock:
                if body.get('projectId') != self.project['id'] or body.get('sessionId') != (self.manifest or {}).get('sessionId'):
                    raise ValueError('工程或会话已更换')
                expiry = body.get('expires')
                if type(expiry) not in (int,float) or not time.time() <= expiry <= time.time()+15:
                    raise ValueError('请求已过期')
                self.queue_tool('fuxa','home')
                return {'ok':True}
        return super().action(body)
