"""MSYS-side private Runtime observer. No Modbus writes or debug forcing.

Launched only by tools/factoryio_runtime.py from a freshly built private cwd.
Commands use request-<sequence>.json; telemetry is read-only debug protocol.
"""
from __future__ import annotations
import json
import errno
import os
from pathlib import Path
import signal
import socket
import struct
import threading
import time
import traceback

HERE = Path.cwd().resolve()
OUT = HERE.parent


def write_json(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for _ in range(100):
        try:
            temporary.replace(path)
            return
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EBUSY, errno.EPERM}:
                raise
            time.sleep(0.01)
    raise RuntimeError('Could not update telemetry file')


class Control:
    def __init__(self):
        self.sock = None

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(2)
        self.sock.connect('./plc_runtime.socket')

    def command(self, command):
        self.sock.sendall(command.encode('ascii') + b'\n')
        data = bytearray()
        while not data.endswith(b'\n'):
            part = self.sock.recv(1)
            if not part or len(data) >= 65536:
                raise RuntimeError('Invalid control reply')
            data.extend(part)
        return data.decode('ascii').strip()

    def debug(self, data):
        reply = self.command('DEBUG:' + bytes(data).hex(' '))
        if not reply.startswith('DEBUG:'):
            raise RuntimeError('Invalid debug reply')
        return bytes.fromhex(reply[6:])

    def wait(self, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = self.command('STATUS')
            if status == 'STATUS:' + expected:
                return
            if status in {'STATUS:ERROR', 'STATUS:EMPTY'}:
                raise RuntimeError(status)
            time.sleep(0.05)
        raise RuntimeError('State timeout: ' + expected)

    def change(self, name):
        reply = self.command(name)
        if reply != name + ':OK':
            raise RuntimeError(reply)
        self.wait('RUNNING' if name == 'START' else 'STOPPED')

    def read(self, leaves):
        values = {}
        ticks = []
        for array in sorted({v['arrayIdx'] for v in leaves}):
            group = sorted((v for v in leaves if v['arrayIdx'] == array), key=lambda v: v['elemIdx'])
            first, last = group[0]['elemIdx'], group[-1]['elemIdx']
            if [v['elemIdx'] for v in group] != list(range(first, last + 1)):
                raise RuntimeError('Non-contiguous debug map')
            request = bytes([0x43, array]) + struct.pack('>HH', first, last)
            reply = self.debug(request)
            if len(reply) != 10 + len(group) or reply[:2] != b'\x43\x7e':
                raise RuntimeError('Invalid BOOL telemetry length')
            actual_last, tick, size = struct.unpack('>HIH', reply[2:10])
            if actual_last != last or size != len(group) or any(v not in (0, 1) for v in reply[10:]):
                raise RuntimeError('Invalid BOOL telemetry content')
            values.update((leaf['path'], bool(value)) for leaf, value in zip(group, reply[10:]))
            ticks.append(tick)
        return ticks, values


def main():
    client = Control()
    server = peer = None
    owned_pid = None
    result = {'result': 'running', 'events': []}
    began = time.monotonic()
    try:
        if HERE.name != 'runtime' or 'factoryio-integration' not in HERE.parts:
            raise RuntimeError('Private Factory I/O runtime cwd required')
        manifest = json.loads((OUT / 'build.json').read_text())
        if (HERE / 'plugins.conf').read_text() != manifest['pluginsConf']:
            raise RuntimeError('Plugin configuration differs from reviewed build')
        for endpoint in ['plc_runtime.socket', 'log_runtime.socket', 'watchdog_fault']:
            if (HERE / endpoint).exists():
                raise RuntimeError('Fresh private endpoints required: ' + endpoint)
        debug_map = json.loads((HERE / 'core/generated/debug-map.json').read_text())
        leaves = debug_map['leaves']
        if not leaves or any(v['type'] != 'BOOL' or v['size'] != 1 for v in leaves):
            raise RuntimeError('This bounded monitor accepts BOOL programs only')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind('./log_runtime.socket')
        server.listen(1)

        def drain_logs():
            nonlocal peer
            try:
                peer, _ = server.accept()
                with (OUT / 'runtime-socket.log').open('wb') as stream:
                    while True:
                        chunk = peer.recv(65536)
                        if not chunk:
                            break
                        stream.write(chunk)
                        stream.flush()
            except OSError:
                pass

        threading.Thread(target=drain_logs, daemon=True).start()
        (OUT / 'client-ready').write_text('ready\n')
        deadline = time.monotonic() + 15
        while not (OUT / 'process-owner.json').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Owner did not start Runtime')
            time.sleep(0.025)
        owner = json.loads((OUT / 'process-owner.json').read_text())
        while owned_pid is None and time.monotonic() < deadline:
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    if int((proc / 'winpid').read_text()) == owner['windowsPid']:
                        actual = str((proc / 'exe').resolve()).removesuffix('.exe')
                        expected = str((HERE / 'daemon-build/plc_main.exe').resolve()).removesuffix('.exe')
                        if actual != expected:
                            raise RuntimeError('Owned Runtime executable mismatch')
                        owned_pid = int(proc.name)
                        break
                except (FileNotFoundError, PermissionError, ProcessLookupError):
                    continue
            time.sleep(0.025)
        if owned_pid is None:
            raise RuntimeError('Cannot identify private Runtime PID')
        while time.monotonic() < deadline:
            try:
                client.connect()
                break
            except OSError:
                if client.sock:
                    client.sock.close()
                time.sleep(0.05)
        client.wait('STOPPED')
        if (OUT / 'stop.request').exists():
            # A stop pressed while the launcher was still preparing is honored
            # before START, so a cancelled launch never enables the Modbus plugin.
            if client.command('STATUS') != 'STATUS:STOPPED':
                raise RuntimeError('Cancelled startup did not remain STOPPED')
            result.update(result='passed', reason='cancelled-before-start')
            write_json(OUT / 'state.json', dict(runtimeState='STOPPED', values=None,
                                             scanTicks=[], observedAt=time.time()))
            return 0
        client.change('START')
        identity = client.debug([0x45, 0, 0])
        if identity != b'\x45\x7e' + debug_map['md5'].encode() + b'\xad\xde':
            raise RuntimeError('Program identity mismatch')
        result['programMd5'] = debug_map['md5']
        last_request = 0
        previous_values = None
        previous_state = None
        deadline = time.monotonic() + owner['durationSeconds']
        with (OUT / 'observations.jsonl').open('w', encoding='utf-8') as observations:
            while time.monotonic() < deadline:
                if (OUT / 'stop.request').exists():
                    result['reason'] = 'stop-request'
                    break
                request = OUT / f'request-{last_request + 1}.json'
                if request.exists():
                    data = json.loads(request.read_text())
                    if data.get('command') not in {'START', 'STOP'}:
                        raise RuntimeError('Unsupported control request')
                    client.change(data['command'])
                    last_request += 1
                    write_json(OUT / f'ack-{last_request}.json', {'command': data['command'], 'ok': True})
                state = client.command('STATUS').removeprefix('STATUS:')
                if state not in {'RUNNING', 'STOPPED'}:
                    raise RuntimeError('Unexpected live Runtime state: ' + state)
                ticks, values = client.read(leaves) if state == 'RUNNING' else ([], None)
                current = dict(seconds=round(time.monotonic() - began, 3), runtimeState=state,
                               scanTicks=ticks, values=values, observedAt=time.time(), programMd5=debug_map['md5'])
                write_json(OUT / 'state.json', current)
                if values != previous_values or state != previous_state:
                    observations.write(json.dumps(current, ensure_ascii=False) + '\n')
                    observations.flush()
                    result['events'].append(current)
                    previous_values, previous_state = values, state
                time.sleep(0.1)
        result.setdefault('reason', 'duration-ended')
        final_state = client.command('STATUS')
        if final_state == 'STATUS:RUNNING':
            client.change('STOP')
        elif final_state != 'STATUS:STOPPED':
            raise RuntimeError('Unexpected final Runtime state: ' + final_state)
        # A successful command acknowledgement is not proof of the final state.
        client.wait('STOPPED')
        if client.command('STATUS') != 'STATUS:STOPPED':
            raise RuntimeError('Runtime did not remain STOPPED at shutdown')
        write_json(OUT / 'state.json', dict(runtimeState='STOPPED', values=None, scanTicks=[], observedAt=time.time()))
        result['result'] = 'passed'
    except Exception:
        result['result'] = 'failed'
        result['error'] = traceback.format_exc()
        write_json(OUT / 'state.json', dict(runtimeState='UNAVAILABLE', values=None, scanTicks=[],
                                         observedAt=time.time(), error='Monitor could not verify Runtime state'))
    finally:
        if client.sock:
            client.sock.close()
        if owned_pid:
            try:
                os.kill(owned_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for endpoint in [peer, server]:
            if endpoint:
                endpoint.close()
        write_json(OUT / 'monitor-result.json', result)
    return 0 if result['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
