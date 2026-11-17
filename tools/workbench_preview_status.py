"""Per-window native preview lifecycle; no project writes or Runtime controls.

Only native main/server processes receive the random launch capability. Browser
origins cannot call this service. A port alone never establishes its identity.
"""
import hmac
import json
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_DESCRIPTORS = {}
_DESCRIPTORS_LOCK = threading.RLock()


def preview_environment(project):
    with _DESCRIPTORS_LOCK:
        context = _DESCRIPTORS.get(project.get('_nativePreview'))
    return {'PLCDEV_NATIVE_PREVIEW': json.dumps(context)} if context else {}


class PreviewStatusService:
    def __init__(self, status, open_current):
        self.status = status
        self.open_current = open_current
        self.instance = secrets.token_hex(32)
        self.tokens = {}
        self.lock = threading.RLock()
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def reply(self, code, body, launch=None):
                raw = json.dumps({'version': 1, 'instance': service.instance,
                    'launchId': launch, **body}, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try: self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError): pass

            def dispatch(self, mutate):
                match = re.fullmatch(r'/v1/previews/(editor-[0-9a-f]{32})/(current|status)', self.path)
                host = '127.0.0.1:' + str(service.server.server_port)
                if (not match or self.client_address[0] != '127.0.0.1'
                        or self.headers.get('Host') != host or self.headers.get('Origin')
                        or self.headers.get('Sec-Fetch-Site')):
                    return self.reply(403, {'ok': False, 'error': 'Native access only'})
                launch, route = match.groups()
                with service.lock: token = service.tokens.get(launch)
                if not token or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    return self.reply(403, {'ok': False, 'error': 'Preview identity rejected'})
                if mutate != (route == 'current'):
                    return self.reply(405, {'ok': False, 'error': 'Method rejected'}, launch)
                try:
                    if mutate:
                        if self.headers.get('Content-Type') != 'application/json' or self.headers.get('Transfer-Encoding'):
                            raise ValueError('请求无效。')
                        length = int(self.headers.get('Content-Length', '0'))
                        if not 0 < length < 1024: raise ValueError('请求无效。')
                        body = json.loads(self.rfile.read(length))
                        if (not isinstance(body, dict) or set(body) != {'revision'}
                                or not re.fullmatch('[0-9a-f]{64}', str(body['revision']))):
                            raise ValueError('工程版本未确认，请刷新状态。')
                        result = service.open_current(launch, body['revision'])
                    else:
                        result = service.status(launch)
                    self.reply(200, {'ok': True, **result}, launch)
                except Exception:
                    # Never return paths, task payloads, capabilities or native
                    # launch diagnostics to a renderer.
                    self.reply(409, {'ok': False, 'error': '工程状态无法核对；原预览已保留，请回到 DSH 核对。'}, launch)

            def do_GET(self): self.dispatch(False)
            def do_POST(self): self.dispatch(True)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def register(self, launch):
        if not re.fullmatch(r'editor-[0-9a-f]{32}', launch): raise ValueError('Invalid preview launch')
        with self.lock:
            token = self.tokens.setdefault(launch, secrets.token_hex(32))
        descriptor = {'version': 1, 'instance': self.instance, 'launchId': launch,
                      'base': 'http://127.0.0.1:' + str(self.server.server_port), 'token': token}
        with _DESCRIPTORS_LOCK: _DESCRIPTORS[launch] = descriptor
        return descriptor

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        with _DESCRIPTORS_LOCK:
            for launch in self.tokens: _DESCRIPTORS.pop(launch, None)
