"""Build and manage an editor-owned local Runtime from its real compiled project.

No source substitution, upload, hardware endpoints, installed-source changes,
global process termination or automatic reconnection restart. Each build and
run owns a fresh outputs/editor-runtime directory and native control sockets.
"""
from __future__ import annotations
import argparse
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from factoryio_runtime import ROOT, RUNTIME, MSYS, TARGET, PLUGIN_CONF, sha, store, clean_env, checked_run

sys.path.insert(0, str(ROOT / 'software/factoryio'))
from editor_runtime_inputs import counter_input_paths, validate_input_request

FAMILY = ROOT / 'outputs/editor-runtime'


def private_directory(path):
    path = Path(path).resolve()
    if not path.is_relative_to(FAMILY.resolve()) or path == FAMILY.resolve():
        raise ValueError('Session must be a child of outputs/editor-runtime')
    return path


def tree_hashes(path):
    return {p.relative_to(path).as_posix(): sha(p) for p in sorted(path.rglob('*')) if p.is_file()}


def program_hash(hashes):
    return hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def initial_state(manifest, phase, error=None):
    return dict(schemaVersion=1, revision=0, ready=False, sessionId=manifest['sessionId'], programHash=manifest['programHash'],
                programMd5=manifest['programMd5'], projectDirectory=manifest['projectDirectory'], mode=manifest['mode'],
                phase=phase, runtimeState='STOPPED', observedAt=time.time(), telemetryFresh=False, values={}, variables=[],
                scanTicks=[], localInputPaths=manifest.get('localInputPaths', []), communication=dict(mode=manifest['mode'], connected=manifest['mode'] == 'local',
                                                 requiresRearm=False, remoteOutputsKnownZero=False, lastSuccessAt=None), error=error)


def prepare(args):
    out = private_directory(args.run_directory)
    if out.exists():
        raise ValueError('Prepare requires a new session directory')
    project = args.project_directory.resolve()
    generated = project / 'build' / TARGET / 'src'
    if not (project / 'project.json').is_file() or not (generated / 'debug-map.json').is_file():
        raise ValueError('Current disk project must first be compiled for OpenPLC Runtime v4')
    debug_map = json.loads((generated / 'debug-map.json').read_text(encoding='utf-8'))
    if not re.fullmatch('[0-9a-fA-F]{32}', debug_map['md5']) or not debug_map['leaves'] or len(debug_map['leaves']) > 512:
        raise ValueError('Expected a valid debug map with 1..512 observable values')
    for leaf in debug_map['leaves']:
        if not (0 <= leaf['arrayIdx'] <= 255 and 0 <= leaf['elemIdx'] <= 65535 and 1 <= leaf['size'] <= 4096):
            raise ValueError('Debug map exceeds the local monitor bounds')
    text = (generated / 'program.st').read_text(encoding='utf-8-sig')
    locations = re.findall(r'\bAT\s+(%\w+(?:\.\d+)*)', text, re.I)
    if args.mode != 'local' and (not locations or any(not re.fullmatch(r'%[IQ]X0\.[0-7]', item, re.I) for item in locations)):
        raise ValueError('Factory I/O mode requires only %IX0.0..7 / %QX0.0..7 virtual addresses')
    source_hashes = tree_hashes(generated)
    out.mkdir(parents=True)
    (out / 'requests').mkdir()
    (out / 'acks').mkdir()
    runtime, msys, private = args.runtime_root.resolve(), args.msys_root.resolve(), out / 'runtime'
    manifest = dict(schemaVersion=1, sessionId=uuid.uuid4().hex, programHash=program_hash(source_hashes),
                    programMd5=debug_map['md5'], projectDirectory=str(project), generatedHashes=source_hashes,
                    mode=args.mode, locatedAddresses=locations, durationSeconds=args.duration,
                    msysRoot=str(msys), runtimeRoot=str(runtime), physicalHardware=False,
                    commands=[], upstreamHashes={}, result='building')
    manifest['localInputPaths'] = counter_input_paths(project, args.mode, text, debug_map['leaves'])
    store(out / 'session.json', manifest)
    store(out / 'state.json', initial_state(manifest, 'building'))
    try:
        inputs = [runtime / 'CMakeLists.txt', runtime / 'scripts/Makefile.strucpp', runtime / 'core/src/CMakeLists.txt']
        for folder in ['core/src/plc_app', 'core/src/lib', 'core/strucpp_runtime']:
            inputs.extend(p for p in (runtime / folder).rglob('*') if p.is_file() and p.suffix in {'.c', '.cpp', '.h', '.hpp'})
        inputs.extend(p for p in (runtime / 'core/src/drivers').iterdir() if p.is_file() and p.suffix in {'.c', '.h'})
        if args.mode != 'local':
            for folder in ['modbus_master', 'shared']:
                inputs.extend(p for p in (runtime / 'core/src/drivers/plugins/python' / folder).rglob('*.py') if '__pycache__' not in p.parts)
        for source in inputs:
            relative = source.relative_to(runtime)
            destination = private / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            manifest['upstreamHashes'][relative.as_posix()] = sha(source)
        manifest['patches'] = []
        for relative, before, after in [
            ('core/src/plc_app/unix_socket.h', '/run/runtime/plc_runtime.socket', './plc_runtime.socket'),
            ('core/src/plc_app/utils/log.h', '/run/runtime/log_runtime.socket', './log_runtime.socket'),
            ('core/src/plc_app/task_policy.h', '/run/runtime/watchdog_fault', './watchdog_fault')]:
            path = private / relative
            data = path.read_bytes()
            if data.count(before.encode()) != 1:
                raise RuntimeError('Upstream private endpoint changed: ' + relative)
            path.write_bytes(data.replace(before.encode(), after.encode()))
            manifest['patches'].append(dict(file=relative, before=before, after=after))
        if args.mode != 'local':
            dependencies = runtime / 'venvs/modbus_master/lib/python3.12/site-packages'
            for folder in ['pymodbus', 'serial']:
                shutil.copytree(dependencies / folder, private / 'venvs/modbus_master/lib/python3.12/site-packages' / folder,
                                ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            configuration = [{'name': 'EditorSimulation', 'protocol': 'MODBUS', 'config': {
                'transport': 'tcp', 'type': 'SLAVE', 'host': '127.0.0.1', 'port': 1,
                'slave_id': 1, 'timeout_ms': 300, 'io_points': [
                    {'fc': 2, 'offset': '0', 'iec_location': '%IX0.0', 'len': 8, 'cycle_time_ms': 50, 'error_handling': 'set-to-zero'},
                    {'fc': 15, 'offset': '0', 'iec_location': '%QX0.0', 'len': 8, 'cycle_time_ms': 50}]} }]
            store(private / 'factoryio-modbus.json', configuration)
        shutil.copytree(generated, private / 'core/generated')
        (private / 'plugins.conf').write_text(PLUGIN_CONF if args.mode != 'local' else '# No device plugins\n', encoding='utf-8')
        (private / 'vpp_plugins.conf').write_text('# No uploaded plugins\n', encoding='utf-8')
        (private / 'retain.conf').write_text('enabled=false\n', encoding='utf-8')
        for name in ['runtime_monitor.py', 'editor_runtime_monitor.py', 'editor_runtime_guard.py', 'editor_runtime_inputs.py']:
            shutil.copyfile(ROOT / 'software/factoryio' / name, out / name)
        bash = msys / 'usr/bin/bash.exe'
        prefix = 'set -eu\nexport PATH=/usr/bin:/bin\ncd "$(cygpath -u "$1")"\n'
        # CLI stdout remains one JSON record; detailed build commands/logs are durable evidence.
        with contextlib.redirect_stdout(sys.stderr):
            checked_run(out, 'build-runtime', [bash, '--noprofile', '--norc', '-c', prefix +
                        'cmake -S . -B daemon-build -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Debug\ncmake --build daemon-build --parallel 4\n',
                        '--', private], manifest['commands'])
            checked_run(out, 'build-program', [bash, '--noprofile', '--norc', '-c', prefix +
                        'make -f scripts/Makefile.strucpp -j4 CCACHE=\n', '--', private], manifest['commands'])
        shutil.copyfile(private / 'build/new_libplc.so', private / 'build/libplc_editor.so')
        if tree_hashes(generated) != source_hashes:
            raise RuntimeError('Compiled project changed during preparation; rebuild a fresh snapshot')
        if any(sha(runtime / rel) != digest for rel, digest in manifest['upstreamHashes'].items()):
            raise RuntimeError('Installed Runtime sources changed during preparation')
        manifest['preparedHashes'] = {p.relative_to(out).as_posix(): sha(p) for p in [
            private / 'daemon-build/plc_main.exe', private / 'build/libplc_editor.so', private / 'plugins.conf',
            private / 'vpp_plugins.conf', private / 'retain.conf', private / 'core/generated/debug-map.json',
            private / 'core/generated/program.st',
            out / 'runtime_monitor.py', out / 'editor_runtime_monitor.py', out / 'editor_runtime_guard.py', out / 'editor_runtime_inputs.py']}
        manifest['result'] = 'prepared'
        store(out / 'state.json', initial_state(manifest, 'stopped'))
    except Exception as exc:
        manifest.update(result='failed', error=str(exc))
        store(out / 'state.json', initial_state(manifest, 'fault', str(exc)))
        raise
    finally:
        store(out / 'session.json', manifest)
    return dict(ok=True, runDirectory=str(out), **initial_state(manifest, 'stopped'))


def run(args):
    from plcdev_runtime_owner import RuntimeLease
    with RuntimeLease(private_directory(args.run_directory)):
        return _run_owned(args)


def _run_owned(args):
    out = private_directory(args.run_directory)
    manifest = json.loads((out / 'session.json').read_text(encoding='utf-8'))
    if manifest['result'] != 'prepared':
        raise ValueError('Session must be prepared')
    for relative, digest in manifest['preparedHashes'].items():
        if sha(out / relative) != digest:
            raise ValueError('Prepared session changed: ' + relative)
    # Exclusive claim; never reuse stale sockets or a previous process identity.
    with (out / 'run.claim').open('x') as claim:
        claim.write(str(os.getpid()))
    private, msys = out / 'runtime', Path(manifest['msysRoot'])
    monitor = daemon = None
    parent_handle = None
    result = dict(result='running', physicalHardware=False)
    try:
        if args.parent_pid:
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            parent_handle = kernel.OpenProcess(0x00100000, False, args.parent_pid)
            if not parent_handle:
                raise RuntimeError('Cannot observe the owning editor process')
        with (out / 'monitor.stdout.log').open('wb') as mon_out, (out / 'monitor.stderr.log').open('wb') as mon_err, \
                (out / 'runtime.stdout.log').open('wb') as run_out, (out / 'runtime.stderr.log').open('wb') as run_err:
            script = 'set -eu\nexport PATH=/usr/bin:/bin\nm=$(cygpath -u "$1")\ncd "$(cygpath -u "$2")"\nexec python3 "$m"'
            monitor = subprocess.Popen([str(msys / 'usr/bin/bash.exe'), '--noprofile', '--norc', '-c', script, '--',
                                        str(out / 'editor_runtime_monitor.py'), str(private)], env=clean_env(), cwd=ROOT,
                                       stdout=mon_out, stderr=mon_err, creationflags=subprocess.CREATE_NO_WINDOW)
            deadline = time.monotonic() + 20
            while not (out / 'client-ready').exists():
                if monitor.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Session observer did not become ready')
                time.sleep(0.05)
            daemon = subprocess.Popen([str(private / 'daemon-build/plc_main.exe'), '--safe-mode', '--print-logs'],
                                      cwd=private, env=clean_env(msys), stdout=run_out, stderr=run_err,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
            store(out / 'process-owner.json', dict(windowsPid=daemon.pid, executable=str(private / 'daemon-build/plc_main.exe'),
                                                  ownerPid=os.getpid(), monitorWindowsPid=monitor.pid))
            deadline = time.monotonic() + manifest['durationSeconds'] + 45
            parent_ended_at = None
            while monitor.poll() is None:
                if parent_handle and kernel.WaitForSingleObject(parent_handle, 0) == 0:
                    if parent_ended_at is None:
                        (out / 'stop.request').write_text('owning-editor-exited\n')
                        parent_ended_at = time.monotonic()
                    elif time.monotonic() - parent_ended_at > 15:
                        raise RuntimeError('Owning editor exited; owned session shutdown timed out')
                if daemon.poll() is not None:
                    # The observer sends SIGTERM before draining its guard/log
                    # threads and publishing its result. The daemon may thus
                    # exit first during a completely normal shutdown. Wait for
                    # that bounded finalization, then validate BOTH exit codes
                    # and the observer result below; do not kill it mid-cleanup.
                    try:
                        monitor.wait(timeout=10)
                    except subprocess.TimeoutExpired as exc:
                        raise RuntimeError('Owned Runtime exited but its observer did not finish within 10 seconds') from exc
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError('Owned session duration exceeded')
                time.sleep(0.1)
            daemon.wait(timeout=15)
            observed = json.loads((out / 'monitor-result.json').read_text(encoding='utf-8'))
            if monitor.returncode or daemon.returncode or observed['result'] != 'passed':
                raise RuntimeError(observed.get('error', 'Owned Runtime session failed; see logs'))
            result.update(result='passed', runtimeExitCode=daemon.returncode, monitorExitCode=monitor.returncode)
    except Exception as exc:
        result.update(result='failed', error=str(exc))
        old = json.loads((out / 'state.json').read_text(encoding='utf-8'))
        old.update(phase='fault', runtimeState='UNAVAILABLE', telemetryFresh=False, ready=False,
                   error=str(exc), observedAt=time.time(), revision=old.get('revision', 0) + 1)
        old['communication'].update(connected=False, remoteOutputsKnownZero=False)
        for variable in old.get('variables', []):
            variable['fresh'] = False
        store(out / 'state.json', old)
        raise
    finally:
        for process in [monitor, daemon]:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
                result['forcedOwnedCleanup'] = True
        result['ownedProcessesExited'] = all(p is None or p.poll() is not None for p in [monitor, daemon])
        if parent_handle:
            kernel.CloseHandle(parent_handle)
        store(out / 'run-result.json', result)
    return result


def status(args):
    out = private_directory(args.run_directory)
    value = json.loads((out / 'state.json').read_text(encoding='utf-8'))
    age = time.time() - value['observedAt']
    value['ageSeconds'] = max(0, age)
    if age > 2 or age < -1:
        value['telemetryFresh'] = False
        for variable in value.get('variables', []):
            variable['fresh'] = False
        if value['phase'] in {'running', 'disconnected', 'reconnect_pending'}:
            value.update(phase='disconnected', error='Observer status is stale; live Runtime state is unverified')
    return value


def command(args):
    out = private_directory(args.run_directory)
    request = dict(action=args.action, sessionId=args.session_id, sequence=args.sequence,
                   expectedProgramHash=args.expected_program_hash, expiresAt=args.expires_at)
    if args.action == 'set-input':
        raw_value = getattr(args, 'value', None)
        request.update(inputPath=getattr(args, 'input_path', None), value=True if raw_value == 'true' else False if raw_value == 'false' else raw_value)
    # Validate in the monitor too; only the owning process may authorize START.
    manifest = json.loads((out / 'session.json').read_text(encoding='utf-8'))
    if request['sessionId'] != manifest['sessionId'] or request['expectedProgramHash'] != manifest['programHash']:
        raise ValueError('Session or program identity mismatch')
    if type(request['sequence']) is not int or request['sequence'] < 1 or not time.time() <= request['expiresAt'] <= time.time() + 60:
        raise ValueError('Request sequence or expiry is invalid')
    if args.action == 'set-input':
        snapshot = status(args)
        leaves = json.loads((out / 'runtime/core/generated/debug-map.json').read_text(encoding='utf-8'))['leaves']
        validate_input_request(request, manifest, leaves, snapshot.get('runtimeState'),
                               snapshot.get('telemetryFresh') is True and snapshot.get('phase') == 'running')
    path = out / 'requests' / f'{args.sequence:012d}.json'
    if path.exists():
        raise ValueError('Request sequence already exists')
    store(path, request)
    deadline = time.monotonic() + 15
    ack = out / 'acks' / path.name
    while time.monotonic() < deadline:
        if ack.exists():
            return json.loads(ack.read_text(encoding='utf-8'))
        if (out / 'run-result.json').exists():
            raise RuntimeError('Session has ended')
        time.sleep(0.05)
    raise RuntimeError('No request acknowledgement; inspect session state before retrying')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='verb', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--project-directory', type=Path, required=True)
    prep.add_argument('--mode', choices=['local', 'factoryio', 'mock'], default='local')
    prep.add_argument('--runtime-root', type=Path, default=RUNTIME)
    prep.add_argument('--msys-root', type=Path, default=MSYS)
    prep.add_argument('--duration', type=int, default=3600)
    for name in ['run', 'status', 'command']:
        sub.add_parser(name)
    sub.choices['run'].add_argument('--parent-pid', type=int)
    for item in sub.choices.values():
        item.add_argument('--run-directory', type=Path, required=True)
    cmd = sub.choices['command']
    cmd.add_argument('--action', choices=['start', 'stop', 'rearm', 'shutdown', 'set-input'], required=True)
    cmd.add_argument('--input-path')
    cmd.add_argument('--value', choices=['true', 'false'])
    cmd.add_argument('--session-id', required=True)
    cmd.add_argument('--expected-program-hash', required=True)
    cmd.add_argument('--sequence', type=int, required=True)
    cmd.add_argument('--expires-at', type=float, required=True)
    args = parser.parse_args()
    try:
        if args.verb == 'prepare' and not 10 <= args.duration <= 3600:
            raise ValueError('Duration must be 10..3600 seconds')
        result = globals()[args.verb](args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get('ok', True) else 1
    except Exception as exc:
        print(json.dumps(dict(ok=False, error=str(exc)), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
