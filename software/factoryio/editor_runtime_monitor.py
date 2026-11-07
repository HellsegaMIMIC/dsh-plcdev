"""MSYS control-socket observer for editor-owned, loopback-only sessions."""
from __future__ import annotations
import json
import math
import os
from pathlib import Path
import signal
import socket
import struct
import threading
import time

from runtime_monitor import Control, write_json
from editor_runtime_guard import ModbusGuard
from editor_runtime_inputs import counter_input_paths, input_leaves, validate_input_request, write_bool_input, clear_local_inputs

HERE = Path.cwd().resolve()
OUT = HERE.parent
FORMATS = {'SINT': 'b', 'USINT': 'B', 'INT': 'h', 'UINT': 'H', 'DINT': 'i', 'UDINT': 'I',
           'LINT': 'q', 'ULINT': 'Q', 'REAL': 'f', 'LREAL': 'd', 'BYTE': 'B', 'WORD': 'H',
           'DWORD': 'I', 'LWORD': 'Q', 'TIME': 'q', 'LTIME': 'q', 'DATE': 'q', 'TOD': 'q', 'DT': 'q'}


def decode(leaf, data):
    kind = leaf['type'].upper()
    if kind == 'BOOL':
        if data not in (b'\0', b'\1'):
            raise RuntimeError('Invalid BOOL telemetry')
        return bool(data[0])
    fmt = FORMATS.get(kind)
    if fmt and struct.calcsize(fmt) == len(data):
        value = struct.unpack('<' + fmt, data)[0]
        if isinstance(value, float) and not math.isfinite(value):
            return str(value)
        # JSON numbers cannot represent every 64-bit integer exactly.
        return str(value) if isinstance(value, int) and abs(value) > 2 ** 53 - 1 else value
    return '0x' + data.hex()


def read_values(client, leaves):
    result, ticks = {}, []
    for array in sorted({leaf['arrayIdx'] for leaf in leaves}):
        group = sorted([v for v in leaves if v['arrayIdx'] == array], key=lambda v: v['elemIdx'])
        # Per-variable reads bound response sizes and support non-contiguous maps.
        for leaf in group:
            idx = leaf['elemIdx']
            response = client.debug(bytes([0x43, array]) + struct.pack('>HH', idx, idx))
            if len(response) < 10 or response[:2] != b'\x43\x7e':
                raise RuntimeError('Invalid debug telemetry response')
            last, tick, size = struct.unpack('>HIH', response[2:10])
            if last != idx or size != leaf['size'] or len(response) != 10 + size:
                raise RuntimeError('Debug map differs from loaded program')
            result[leaf['path']] = decode(leaf, response[10:])
            ticks.append(tick)
    return ticks, result


def validate_request(request, manifest, last_sequence, now):
    if request.get('sessionId') != manifest['sessionId']:
        raise ValueError('Request belongs to a different session')
    if request.get('expectedProgramHash') != manifest['programHash']:
        raise ValueError('Request program version differs from this session')
    sequence = request.get('sequence')
    if type(sequence) is not int or sequence <= last_sequence:
        raise ValueError('Request sequence is stale')
    expiry = request.get('expiresAt')
    if not isinstance(expiry, (int, float)) or not now <= expiry <= now + 60:
        raise ValueError('Request expired or expiry is outside the bounded window')
    if request.get('action') not in {'start', 'stop', 'rearm', 'shutdown', 'set-input'}:
        raise ValueError('Unsupported session action')
    return sequence


def main():
    client, guard, server, peer = Control(), None, None, None
    owned_pid = None
    manifest = json.loads((OUT / 'session.json').read_text(encoding='utf-8'))
    leaves = json.loads((HERE / 'core/generated/debug-map.json').read_text(encoding='utf-8'))['leaves']
    base = {key: manifest[key] for key in ['sessionId', 'programHash', 'programMd5', 'mode', 'projectDirectory']}
    base['schemaVersion'] = 1
    base['ready'] = False
    allowed_inputs = input_leaves(manifest, leaves)
    if allowed_inputs:
        # Recheck the prepared program and zero-plugin boundary in the owning
        # process before exposing any write capability, not just in prepare.
        plugin_lines = []
        for name in ['plugins.conf', 'vpp_plugins.conf']:
            plugin_lines.extend(line.strip() for line in (HERE / name).read_text(encoding='utf-8').splitlines()
                                if line.strip() and not line.lstrip().startswith('#'))
        checked = counter_input_paths(manifest['projectDirectory'], manifest['mode'],
                                      (HERE / 'core/generated/program.st').read_text(encoding='utf-8-sig'), leaves)
        if plugin_lines or checked != list(allowed_inputs):
            allowed_inputs = {}
    # All command checks use the revalidated capability, even if a manifest was edited.
    manifest = dict(manifest, localInputPaths=list(allowed_inputs))
    base['localInputPaths'] = list(allowed_inputs)
    last_values, last_ticks, last_request = {}, [], None
    last_sequence, last_tick_change, previous_ticks, revision = 0, time.monotonic(), None, 0
    last_sample_at = None
    logger_finished = threading.Event()
    result = dict(result='running', physicalHardware=False)

    def publish(phase, runtime='STOPPED', error=None, fresh=False):
        nonlocal revision
        revision += 1
        communication = guard.status() if guard else dict(connected=True, requiresRearm=False,
                                                          remoteOutputsKnownZero=False, lastSuccessAt=None)
        communication['mode'] = manifest['mode']
        state = dict(**base, revision=revision, phase=phase, runtimeState=runtime, observedAt=time.time(),
                     telemetryFresh=fresh, values=last_values, scanTicks=last_ticks,
                     variables=[dict(path=v['path'], type=v['type'], value=last_values.get(v['path']), fresh=fresh) for v in leaves],
                     communication=communication, lastRequest=last_request, error=error)
        write_json(OUT / 'state.json', state)

    try:
        if HERE.name != 'runtime' or 'editor-runtime' not in HERE.parts:
            raise RuntimeError('Fresh private editor Runtime cwd required')
        for endpoint in ['plc_runtime.socket', 'log_runtime.socket', 'watchdog_fault']:
            if (HERE / endpoint).exists():
                raise RuntimeError('Fresh session endpoint required')
        if manifest['mode'] != 'local':
            guard = ModbusGuard(1502 if manifest['mode'] == 'factoryio' else 1503)
            guard.start()
            configuration = json.loads((HERE / 'factoryio-modbus.json').read_text(encoding='utf-8'))
            configuration[0]['config']['port'] = guard.port
            write_json(HERE / 'factoryio-modbus.json', configuration)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind('./log_runtime.socket')
        server.listen(1)

        def drain():
            nonlocal peer
            try:
                peer, _ = server.accept()
                with (OUT / 'runtime-socket.log').open('wb') as stream:
                    while True:
                        data = peer.recv(65536)
                        if not data:
                            break
                        stream.write(data)
                        stream.flush()
            except OSError:
                pass
            finally:
                logger_finished.set()
        threading.Thread(target=drain, daemon=True).start()
        publish('stopped')
        (OUT / 'client-ready').write_text('ready\n')
        deadline = time.monotonic() + 20
        while not (OUT / 'process-owner.json').exists() and time.monotonic() < deadline:
            time.sleep(0.025)
        owner = json.loads((OUT / 'process-owner.json').read_text(encoding='utf-8'))
        while owned_pid is None and time.monotonic() < deadline:
            for path in Path('/proc').iterdir():
                if not path.name.isdigit():
                    continue
                try:
                    if int((path / 'winpid').read_text(encoding='utf-8')) == owner['windowsPid']:
                        if str((path / 'exe').resolve()).removesuffix('.exe') != str((HERE / 'daemon-build/plc_main.exe').resolve()).removesuffix('.exe'):
                            raise RuntimeError('Owned Runtime executable mismatch')
                        owned_pid = int(path.name)
                        break
                except (FileNotFoundError, PermissionError, ProcessLookupError):
                    continue
            time.sleep(0.025)
        if owned_pid is None:
            raise RuntimeError('Cannot identify owned Runtime PID')
        while time.monotonic() < deadline:
            try:
                client.connect()
                break
            except OSError:
                if client.sock:
                    client.sock.close()
                time.sleep(0.05)
        client.wait('STOPPED')
        base['ready'] = True
        deadline = time.monotonic() + manifest['durationSeconds']
        stopped_by_loss = False
        while time.monotonic() < deadline and not (OUT / 'stop.request').exists():
            state = client.command('STATUS').removeprefix('STATUS:')
            if state not in {'RUNNING', 'STOPPED'}:
                raise RuntimeError('Unexpected Runtime state: ' + state)
            communication = guard.status() if guard else None
            if communication and communication['requiresRearm'] and state == 'RUNNING':
                guard.disarm()
                client.change('STOP')
                state, stopped_by_loss = 'STOPPED', True
            for path in sorted((OUT / 'requests').glob('*.json')):
                ack = OUT / 'acks' / path.name
                if ack.exists():
                    continue
                request = json.loads(path.read_text(encoding='utf-8'))
                response = dict(action=request.get('action'), sequence=request.get('sequence'), ok=False)
                attempted_start = False
                try:
                    sequence = validate_request(request, manifest, last_sequence, time.time())
                    # Consume accepted sequence even if action fails: retries get new ids.
                    last_sequence = sequence
                    action = request['action']
                    if action in {'stop', 'shutdown'}:
                        if guard:
                            guard.disarm()
                        if state == 'RUNNING':
                            try:
                                clear_local_inputs(client, allowed_inputs)
                            finally:
                                client.change('STOP')
                                state, last_sample_at = 'STOPPED', None
                        state = 'STOPPED'
                        if action == 'shutdown':
                            (OUT / 'stop.request').write_text('shutdown\n')
                    elif action == 'set-input':
                        fresh = last_sample_at is not None and time.monotonic() - last_sample_at < 2 and time.monotonic() - last_tick_change < 2
                        leaf = validate_input_request(request, manifest, leaves, state, fresh)
                        write_bool_input(client, leaf, request['value'])
                        response.update(inputPath=request['inputPath'], value=request['value'])
                    else:
                        if state == 'RUNNING':
                            raise ValueError('Runtime already running')
                        if guard:
                            guard.arm(rearm=action == 'rearm')
                        attempted_start = True
                        client.change('START')
                        identity = client.debug([0x45, 0, 0])
                        if identity != b'\x45\x7e' + manifest['programMd5'].encode() + b'\xad\xde':
                            raise RuntimeError('Loaded program identity mismatch')
                        clear_local_inputs(client, allowed_inputs)
                        state, stopped_by_loss = 'RUNNING', False
                        last_sample_at = None
                        last_tick_change, previous_ticks = time.monotonic(), None
                    response['ok'] = True
                except (ValueError, RuntimeError, OSError) as exc:
                    response['error'] = str(exc)
                    if attempted_start:
                        if guard:
                            guard.disarm()
                        client.change('STOP')
                        state = 'STOPPED'
                last_request = response
                write_json(ack, response)
            if state == 'RUNNING':
                last_ticks, last_values = read_values(client, leaves)
                last_sample_at = time.monotonic()
                if last_ticks != previous_ticks:
                    last_tick_change, previous_ticks = time.monotonic(), last_ticks
                if time.monotonic() - last_tick_change > 2:
                    raise RuntimeError('Runtime scan counter is frozen; values are stale')
            communication = guard.status() if guard else None
            phase = state.lower()
            if communication and not communication['connected']:
                phase = 'disconnected'
            elif communication and (communication['requiresRearm'] or stopped_by_loss):
                phase = 'reconnect_pending'
            publish(phase, state, fresh=state == 'RUNNING' and phase == 'running')
            time.sleep(0.15)
        if guard:
            guard.disarm()
        if client.command('STATUS') == 'STATUS:RUNNING':
            try:
                clear_local_inputs(client, allowed_inputs)
            finally:
                client.change('STOP')
        client.wait('STOPPED')
        base['ready'] = False
        publish('stopped')
        result['result'] = 'passed'
    except Exception as exc:
        result.update(result='failed', error=str(exc))
        if guard:
            guard.disarm()
        base['ready'] = False
        publish('fault', 'UNAVAILABLE', str(exc))
    finally:
        if client.sock:
            client.sock.close()
        if owned_pid:
            try:
                os.kill(owned_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            # Keep the log peer open while the owned Runtime drains shutdown
            # messages; closing it immediately can turn normal SIGTERM into EPIPE.
            logger_finished.wait(timeout=5)
        if guard:
            guard.close()
        for endpoint in [peer, server]:
            if endpoint:
                endpoint.close()
        write_json(OUT / 'monitor-result.json', result)
    return 0 if result['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
