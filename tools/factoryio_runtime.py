"""Build and run an isolated OpenPLC Runtime for local Factory I/O.

Only the original Modbus master plugin is enabled, fixed to 127.0.0.1:1502
for Factory I/O, or 127.0.0.1:1503 for the explicit loopback test fixture.
The installed Runtime and existing user projects are never modified.
prepare does not start any runtime or open any network connection.
run --mode mock uses an eight-bit local test server; --mode factoryio connects
the real Runtime to the user's explicitly configured local Factory I/O server.
"""
from __future__ import annotations
import argparse
import ctypes
import errno
from datetime import datetime
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
from plcdev_environment import tool_path

ROOT = Path(__file__).resolve().parent.parent
FAMILY = ROOT / 'outputs/factoryio-integration'
RUNTIME = tool_path('runtime')
MSYS = tool_path('msys')
EDITOR = tool_path('editor').parent
SOURCE = ROOT / 'software/factoryio/LoopbackCheck.st'
TARGET = 'OpenPLC Runtime v4'
PLUGIN_CONF = ('modbus_master,./core/src/drivers/plugins/python/modbus_master/modbus_master_plugin.py,'
               '1,0,./factoryio-modbus.json,./venvs/modbus_master\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def store(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for _ in range(50):
        try:
            temporary.replace(path)
            return
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EBUSY, errno.EPERM}:
                raise
            time.sleep(0.02)
    raise RuntimeError('Cannot atomically update ' + path.name)


def clean_env(msys=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('OPENPLC_', 'PYTHON')) and k not in {'MSYSTEM', 'ELECTRON_RUN_AS_NODE'}}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    if msys:
        env['PATH'] = str(msys / 'usr/bin') + os.pathsep + env.get('PATH', '')
    return env


def checked_run(out, label, argv, commands, timeout=240, cwd=ROOT):
    print(label + ': running', flush=True)
    record = dict(stage=label, argv=list(map(str, argv)), cwd=str(cwd))
    commands.append(record)
    with (out / (label + '.stdout.log')).open('wb') as stdout, (out / (label + '.stderr.log')).open('wb') as stderr:
        process = subprocess.Popen(record['argv'], cwd=cwd, env=clean_env(), stdout=stdout, stderr=stderr,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
            process.wait(timeout=5)
            record['timedOut'] = True
            raise RuntimeError(label + ' timed out; only owned process tree stopped')
    record['exitCode'] = process.returncode
    print(label + ': exit ' + str(process.returncode), flush=True)
    if process.returncode:
        raise RuntimeError(label + ' failed; see saved logs')
    return (out / (label + '.stdout.log')).read_text(encoding='utf-8-sig')


def private_directory(path):
    directory = path.resolve()
    if not directory.is_relative_to(FAMILY.resolve()) or directory == FAMILY.resolve():
        raise ValueError('Run directory must be a child of outputs/factoryio-integration')
    return directory


def prepare(args):
    out = private_directory(args.run_directory)
    if out.exists():
        raise ValueError('Prepare requires a new output directory')
    source = args.source.resolve()
    if not source.is_relative_to(ROOT) or not source.is_file():
        raise ValueError('Source must be an existing file inside this project')
    text = source.read_text(encoding='utf-8-sig')
    program = re.search(r'^\s*PROGRAM\s+([A-Za-z_]\w*)', text, re.I | re.M)
    if not program:
        raise ValueError('ST must define one named PROGRAM')
    located = re.findall(r'\bAT\s+(%\w+(?:\.\d+)?)', text, re.I)
    if not located or any(not re.fullmatch(r'%[IQ]X0\.[0-7]', address, re.I) for address in located):
        raise ValueError('Only virtual scene %IX0.0..7 / %QX0.0..7 mappings are allowed')
    if len(located) != len(set(address.upper() for address in located)):
        raise ValueError('Duplicate located addresses are not accepted')
    if re.search(r'\{\s*external|\b(VAR_EXTERNAL|EXTERNAL)\b', text, re.I):
        raise ValueError('External code not permitted in bounded scene fixture')
    out.mkdir(parents=True)
    is_mock = program[1] == 'LoopbackCheck'
    port = 1503 if is_mock else 1502
    input_count, output_count = (8, 8) if is_mock else (2, 1)
    if not is_mock and {address.upper() for address in located} != {'%IX0.0', '%IX0.1', '%QX0.0'}:
        raise ValueError('The reviewed From A to B scene accepts exactly Input 0/1 and Coil 0')
    report = dict(result='running', source=str(source), sourceSha256=sha(source), program=program[1],
                  commands=[], upstreamHashes={}, copiedDependencyHashes={}, pluginsConf=PLUGIN_CONF,
                  endpoint=dict(host='127.0.0.1', port=port, unitId=1), physicalHardware=False)
    report['toolHashes'] = {name: sha(ROOT / name) for name in
                            ['tools/factoryio_runtime.py', 'software/factoryio/runtime_monitor.py',
                             'software/factoryio/modbus_mock.py']}
    private = out / 'runtime'
    runtime = args.runtime_root.resolve()
    msys = args.msys_root.resolve()
    bash = msys / 'usr/bin/bash.exe'
    editor = args.editor_root.resolve() / 'OpenPLC Editor.exe'
    report['msysRoot'] = str(msys)
    report['upstreamRoot'] = str(runtime)
    try:
        def cli(label, *options):
            stdout = checked_run(out, label, [editor, '--cli', *options, '--user-data', out / 'editor-state', '--json'], report['commands'], 180)
            data = json.loads(stdout.strip())
            if not data.get('ok'):
                raise RuntimeError('Editor command did not report ok=true')
            return data

        cli('editor-version', '--version')
        cli('create-project', 'create', 'FactoryIOProject', '--path', out, '--language', 'st', '--time', 'T#20ms')
        project = out / 'FactoryIOProject'
        (project / 'pous/programs/main.st').write_bytes(source.read_bytes())
        metadata = json.loads((project / 'project.json').read_text(encoding='utf-8'))
        metadata['data']['configuration']['resource']['instances'][0]['program'] = program[1]
        store(project / 'project.json', metadata)
        compilation = cli('generate-program', 'compile', project, '--target', TARGET)
        if compilation.get('uploaded') is not False:
            raise RuntimeError('Expected compile-only without upload')
        generated = project / 'build' / TARGET / 'src'
        generated_map = json.loads((generated / 'debug-map.json').read_text())
        if any(leaf['type'] != 'BOOL' or leaf['size'] != 1 for leaf in generated_map['leaves']):
            raise ValueError('Only BOOL programs supported by this first scene monitor')
        report['debugMap'] = generated_map
        report['locatedAddresses'] = located
        report['editorAsarSha256'] = sha(args.editor_root / 'resources/app.asar')
        inputs = [runtime / 'CMakeLists.txt', runtime / 'scripts/Makefile.strucpp', runtime / 'core/src/CMakeLists.txt']
        for folder in ['core/src/plc_app', 'core/src/lib', 'core/strucpp_runtime']:
            inputs.extend(p for p in (runtime / folder).rglob('*') if p.is_file() and p.suffix in {'.c', '.cpp', '.h', '.hpp'})
        inputs.extend(p for p in (runtime / 'core/src/drivers').iterdir() if p.is_file() and p.suffix in {'.c', '.h'})
        for folder in ['modbus_master', 'shared']:
            inputs.extend(p for p in (runtime / 'core/src/drivers/plugins/python' / folder).rglob('*.py') if '__pycache__' not in p.parts)
        for source_path in inputs:
            relative = source_path.relative_to(runtime)
            destination = private / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, destination)
            report['upstreamHashes'][relative.as_posix()] = sha(source_path)
        patches = [
            ('core/src/plc_app/unix_socket.h', '/run/runtime/plc_runtime.socket', './plc_runtime.socket'),
            ('core/src/plc_app/utils/log.h', '/run/runtime/log_runtime.socket', './log_runtime.socket'),
            ('core/src/plc_app/task_policy.h', '/run/runtime/watchdog_fault', './watchdog_fault'),
        ]
        report['patches'] = []
        for relative, before, after in patches:
            path = private / relative
            original = path.read_bytes()
            if original.count(before.encode()) != 1:
                raise RuntimeError('Upstream private endpoint changed: ' + relative)
            path.write_bytes(original.replace(before.encode(), after.encode()))
            report['patches'].append(dict(file=relative, before=before, after=after, sha256=sha(path)))
        for relative, digest in report['upstreamHashes'].items():
            if (sha(private / relative) != digest) != (relative in {p[0] for p in patches}):
                raise RuntimeError('Unexpected source change: ' + relative)
        dependencies = runtime / 'venvs/modbus_master/lib/python3.12/site-packages'
        for folder in ['pymodbus', 'serial']:
            for path in (dependencies / folder).rglob('*'):
                if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                    relative = path.relative_to(dependencies)
                    destination = private / 'venvs/modbus_master/lib/python3.12/site-packages' / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, destination)
                    report['copiedDependencyHashes'][relative.as_posix()] = sha(path)
        shutil.copytree(generated, private / 'core/generated')
        configuration = [{'name': 'FactoryIO', 'protocol': 'MODBUS', 'config': {
            'transport': 'tcp', 'type': 'SLAVE', 'host': '127.0.0.1', 'port': port,
            'slave_id': 1, 'timeout_ms': 300, 'io_points': [
                {'fc': 2, 'offset': '0', 'iec_location': '%IX0.0', 'len': input_count, 'cycle_time_ms': 50, 'error_handling': 'set-to-zero'},
                {'fc': 15, 'offset': '0', 'iec_location': '%QX0.0', 'len': output_count, 'cycle_time_ms': 50}]} }]
        store(private / 'factoryio-modbus.json', configuration)
        (private / 'plugins.conf').write_text(PLUGIN_CONF, encoding='utf-8')
        (private / 'vpp_plugins.conf').write_text('# No uploaded plugins\n', encoding='utf-8')
        (private / 'retain.conf').write_text('enabled=false\n', encoding='utf-8')
        shutil.copyfile(ROOT / 'software/factoryio/runtime_monitor.py', out / 'runtime_monitor.py')
        script = ('set -eu\nexport PATH=/usr/bin:/bin\ncd "$(cygpath -u "$1")"\n'
                  'cmake -S . -B daemon-build -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Debug\n'
                  'cmake --build daemon-build --parallel 4\n')
        checked_run(out, 'build-runtime', [bash, '--noprofile', '--norc', '-c', script, '--', private], report['commands'])
        script = 'set -eu\nexport PATH=/usr/bin:/bin\ncd "$(cygpath -u "$1")"\nmake -f scripts/Makefile.strucpp -j4 CCACHE=\n'
        checked_run(out, 'build-program', [bash, '--noprofile', '--norc', '-c', script, '--', private], report['commands'])
        shutil.copyfile(private / 'build/new_libplc.so', private / 'build/libplc_factoryio.so')
        report['binaryHashes'] = {p.relative_to(out).as_posix(): sha(p) for p in [private / 'daemon-build/plc_main.exe', private / 'build/libplc_factoryio.so']}
        report['preparedFileHashes'] = {p.relative_to(out).as_posix(): sha(p) for p in
                                       [out / 'runtime_monitor.py', private / 'plugins.conf', private / 'vpp_plugins.conf', private / 'retain.conf', private / 'factoryio-modbus.json', private / 'core/generated/debug-map.json']}
        report['installedInputsUnchanged'] = all(sha(runtime / rel) == digest for rel, digest in report['upstreamHashes'].items())
        if not report['installedInputsUnchanged']:
            raise RuntimeError('Installed source changed during read-only build')
        report['result'] = 'prepared'
    except Exception as exc:
        report.update(result='failed', error=str(exc))
        raise
    finally:
        store(out / 'build.json', report)
        print(str(out / 'build.json'), flush=True)


def run(args):
    out = private_directory(args.run_directory)
    build = json.loads((out / 'build.json').read_text(encoding='utf-8'))
    if build['result'] != 'prepared':
        raise RuntimeError('Build must be prepared')
    if (out / 'process-owner.json').exists():
        raise RuntimeError('Each prepared run directory may run only once')
    for relative, digest in {**build['binaryHashes'], **build['preparedFileHashes']}.items():
        if sha(out / relative) != digest:
            raise RuntimeError('Prepared file changed: ' + relative)
    changed_sources = {patch['file']: patch['sha256'] for patch in build['patches']}
    for relative, digest in build['upstreamHashes'].items():
        if sha(out / 'runtime' / relative) != changed_sources.get(relative, digest):
            raise RuntimeError('Private Runtime or plugin source changed: ' + relative)
    for relative, digest in build['copiedDependencyHashes'].items():
        if sha(out / 'runtime/venvs/modbus_master/lib/python3.12/site-packages' / relative) != digest:
            raise RuntimeError('Private plugin dependency changed: ' + relative)
    if args.mode == 'mock' and build['program'] != 'LoopbackCheck':
        raise ValueError('Mock run requires the separate LoopbackCheck fixture')
    if build['endpoint'] != dict(host='127.0.0.1', port=1503 if args.mode == 'mock' else 1502, unitId=1):
        raise ValueError('Prepared endpoint does not match selected mode')
    report = dict(result='running', mode=args.mode, endpoint=build['endpoint'], commands=[], mockChecks=[], physicalHardware=False,
                  scope='Private Runtime lifecycle and observer; Factory I/O scene actions require separate GUI evidence',
                  factoryIOSceneAcceptance='not-evaluated-by-this-runner')
    private = out / 'runtime'
    msys = Path(build['msysRoot'])
    mock = monitor = daemon = None
    if args.mode == 'mock':
        sys.path.insert(0, str(ROOT / 'software/factoryio'))
        from modbus_mock import LoopbackServer
        mock = LoopbackServer()
        mock.start()
    try:
        bash = msys / 'usr/bin/bash.exe'
        script = ('set -eu\nexport PATH=/usr/bin:/bin\nmonitor=$(cygpath -u "$1")\n'
                  'cd "$(cygpath -u "$2")"\nexec python3 "$monitor"')
        argv = [str(bash), '--noprofile', '--norc', '-c', script, '--', str(out / 'runtime_monitor.py'), str(private)]
        with (out / 'monitor.stdout.log').open('wb') as mon_out, (out / 'monitor.stderr.log').open('wb') as mon_err, \
                (out / 'runtime.stdout.log').open('wb') as daemon_out, (out / 'runtime.stderr.log').open('wb') as daemon_err:
            monitor = subprocess.Popen(argv, cwd=ROOT, env=clean_env(), stdout=mon_out, stderr=mon_err, creationflags=subprocess.CREATE_NO_WINDOW)
            report['commands'].append(dict(stage='monitor', argv=argv))
            deadline = time.monotonic() + 15
            while not (out / 'client-ready').exists():
                if monitor.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Private Runtime monitor did not prepare')
                time.sleep(0.05)
            argv = [str(private / 'daemon-build/plc_main.exe'), '--safe-mode', '--print-logs']
            daemon = subprocess.Popen(argv, cwd=private, env=clean_env(msys), stdout=daemon_out, stderr=daemon_err, creationflags=subprocess.CREATE_NO_WINDOW)
            store(out / 'process-owner.json', dict(windowsPid=daemon.pid, executable=argv[0], durationSeconds=args.duration, ownerPid=os.getpid()))
            report['commands'].append(dict(stage='runtime', argv=argv, cwd=str(private)))
            print(f'Private Runtime PID {daemon.pid}; {args.mode}; state: {out / "state.json"}', flush=True)
            deadline = time.monotonic() + args.duration + 30
            pattern_index = 0
            pattern_began = time.monotonic()
            patterns = [0, 1, 128, 85, 170, 255, 0]
            while monitor.poll() is None:
                if daemon.poll() is not None:
                    raise RuntimeError('Private Runtime exited before monitor')
                if time.monotonic() > deadline:
                    raise RuntimeError('Run exceeded bounded duration')
                if mock:
                    if mock.failure:
                        raise RuntimeError('Mock server failed: ' + mock.failure)
                    if pattern_index < len(patterns):
                        mock.inputs = patterns[pattern_index]
                        if time.monotonic() - pattern_began > 1.0:
                            expected = patterns[pattern_index]
                            writes = [e for e in mock.events if e['at'] >= pattern_began and e['fc'] == 15 and e['outputs'] == expected]
                            if len(writes) >= 3:
                                report['mockChecks'].append(dict(inputs=expected, outputs=mock.outputs, matchingWrites=len(writes)))
                                print(f'Mock pattern {expected}: passed', flush=True)
                                pattern_index += 1
                                pattern_began = time.monotonic()
                            elif time.monotonic() - pattern_began > 10:
                                raise RuntimeError('Mock outputs failed to follow inputs')
                    elif not (out / 'stop.request').exists():
                        (out / 'stop.request').write_text('mock-complete\n')
                time.sleep(0.05)
            daemon.wait(timeout=20)
            result = json.loads((out / 'monitor-result.json').read_text(encoding='utf-8'))
            if monitor.returncode or daemon.returncode or result['result'] != 'passed':
                raise RuntimeError('Monitor or Runtime exited with failure; see logs')
            cancelled = result.get('reason') == 'cancelled-before-start'
            if mock and not cancelled and len(report['mockChecks']) != len(patterns):
                raise RuntimeError('Mock sequence incomplete')
            report.update(result='cancelled' if cancelled else 'passed', runtimeExitCode=daemon.returncode, monitorExitCode=monitor.returncode,
                          monitorResult=result, ownedProcessesExited=True)
            if mock:
                report['mockRequests'] = mock.events
    except Exception as exc:
        report.update(result='failed', error=str(exc))
        raise
    finally:
        for process in [monitor, daemon]:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
                report['forcedCleanup'] = True
        if mock:
            mock.close()
        store(out / 'run-result.json', report)


def owned_runtime_is_alive(out):
    """Inspect only the recorded child PID, and compare its exact executable."""
    owner_path = out / 'process-owner.json'
    if not owner_path.exists():
        return False
    owner = json.loads(owner_path.read_text(encoding='utf-8'))
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000, False, owner['windowsPid'])
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:
            return False
        raise OSError(error, 'Cannot verify recorded private Runtime PID')
    try:
        code = ctypes.c_ulong()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        if code.value != 259:
            return False
        size = ctypes.c_ulong(32768)
        value = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, value, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        expected = (out / 'runtime/daemon-build/plc_main.exe').resolve()
        if Path(value.value).resolve() != expected:
            return False  # PID has been reused; do not touch that process.
        return True
    finally:
        kernel.CloseHandle(handle)


DEFAULT_TEMPLATE = FAMILY / 'from-a-to-b-20261022-02'
ACTIVE_RECORD = FAMILY / 'active-session.json'


def active_directory(include_starting=False):
    if ACTIVE_RECORD.exists():
        record = json.loads(ACTIVE_RECORD.read_text())
        candidate = private_directory(Path(record['runDirectory']))
        if owned_runtime_is_alive(candidate):
            return candidate
        if (include_starting and record.get('phase') == 'starting' and candidate.is_dir()
                and not (candidate / 'process-owner.json').exists()
                and not (candidate / 'run-result.json').exists()
                and 0 <= time.time() - record.get('startedAt', 0) < 120):
            return candidate
    if DEFAULT_TEMPLATE.exists() and owned_runtime_is_alive(DEFAULT_TEMPLATE):
        return DEFAULT_TEMPLATE
    return None


def launch(args):
    """Reuse verified binaries in a fresh session; preserve every old run."""
    import msvcrt
    FAMILY.mkdir(parents=True, exist_ok=True)
    with (FAMILY / 'launcher.lock').open('a+b') as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print('The Factory I/O Runtime launcher is already active. Use Status or Stop.')
            return
        try:
            existing = active_directory()
            if existing:
                store(ACTIVE_RECORD, dict(runDirectory=str(existing)))
                print('Private Runtime already running: ' + str(existing))
                return
            template = private_directory(args.template)
            build = json.loads((template / 'build.json').read_text(encoding='utf-8'))
            if build['result'] != 'prepared' or build['program'] != 'FromAToB':
                raise RuntimeError('A prepared FromAToB template is required')
            source = ROOT / 'software/factoryio/FromAToB.st'
            if sha(source) != build['sourceSha256']:
                raise RuntimeError('FromAToB.st has changed. Run prepare to build a new template first.')
            stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
            session = FAMILY / ('session-' + stamp)
            session.mkdir()
            # Record startup before copying. Stop can now leave a cancellation
            # request even before the daemon has a PID or a control socket.
            store(ACTIVE_RECORD, dict(runDirectory=str(session), template=str(template),
                                     phase='starting', startedAt=time.time()))
            # Socket files and fault markers describe the previous process,
            # and must never be inherited by a new process.
            shutil.copytree(template / 'runtime', session / 'runtime',
                            ignore=shutil.ignore_patterns('plc_runtime.socket', 'log_runtime.socket',
                                                        'watchdog_fault', '__pycache__', '*.pyc'))
            shutil.copyfile(ROOT / 'software/factoryio/runtime_monitor.py', session / 'runtime_monitor.py')
            build['reusedBuildFrom'] = str(template)
            build['preparedFileHashes']['runtime_monitor.py'] = sha(session / 'runtime_monitor.py')
            build['launcherSha256'] = sha(Path(__file__))
            build['sessionToolHashes'] = {name: sha(ROOT / name) for name in
                                         ['tools/factoryio_runtime.py', 'software/factoryio/runtime_monitor.py',
                                          'software/factoryio/modbus_mock.py']}
            store(session / 'build.json', build)
            print('Reusing compiled program; new local session: ' + str(session), flush=True)
            run(argparse.Namespace(run_directory=session, mode='factoryio', duration=args.duration))
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def active_action(action):
    directory = active_directory(include_starting=True)
    if not directory:
        print('No private Factory I/O Runtime is running.')
        return
    if action == 'stop-active':
        (directory / 'stop.request').write_text('launcher-stop\n')
        print('Stop requested. Waiting for this private Runtime to exit...', flush=True)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (directory / 'run-result.json').exists():
                break
            if (directory / 'process-owner.json').exists() and not owned_runtime_is_alive(directory):
                break
            time.sleep(0.1)
        if owned_runtime_is_alive(directory) or not (directory / 'process-owner.json').exists():
            raise RuntimeError('Runtime has not exited. See its logs; no unrelated process was stopped.')
        print('Private Runtime has exited.')
    else:
        state_path = directory / 'state.json'
        print(state_path.read_text(encoding='utf-8') if state_path.exists() else 'Runtime starting; no telemetry yet.')
        print('Evidence: ' + str(directory))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--source', type=Path, default=SOURCE)
    prep.add_argument('--run-directory', type=Path, required=True)
    prep.add_argument('--runtime-root', type=Path, default=RUNTIME)
    prep.add_argument('--msys-root', type=Path, default=MSYS)
    prep.add_argument('--editor-root', type=Path, default=EDITOR)
    running = sub.add_parser('run')
    running.add_argument('--run-directory', type=Path, required=True)
    running.add_argument('--mode', choices=['mock', 'factoryio'], default='mock')
    running.add_argument('--duration', type=int, default=300)
    launcher = sub.add_parser('launch')
    launcher.add_argument('--template', type=Path, default=DEFAULT_TEMPLATE)
    launcher.add_argument('--duration', type=int, default=3600)
    sub.add_parser('stop-active')
    sub.add_parser('status-active')
    for action in ['status', 'stop', 'plc-start', 'plc-stop']:
        item = sub.add_parser(action)
        item.add_argument('--run-directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args)
        elif args.command == 'run':
            if not 10 <= args.duration <= 3600:
                raise ValueError('Duration must be between 10 and 3600 seconds')
            run(args)
        elif args.command == 'launch':
            if not 10 <= args.duration <= 3600:
                raise ValueError('Duration must be between 10 and 3600 seconds')
            launch(args)
        elif args.command in {'stop-active', 'status-active'}:
            active_action(args.command)
        else:
            out = private_directory(args.run_directory)
            if not (out / 'process-owner.json').exists():
                raise ValueError('Run has not been started')
            if args.command == 'status':
                print((out / 'state.json').read_text(encoding='utf-8'))
            elif args.command == 'stop':
                (out / 'stop.request').write_text('user-request\n')
                print('Requested graceful stop of this private Runtime')
            else:
                sequence = 1
                while (out / f'request-{sequence}.json').exists():
                    sequence += 1
                store(out / f'request-{sequence}.json', dict(command='START' if args.command == 'plc-start' else 'STOP'))
                print(f'Created request {sequence}; verify ack-{sequence}.json and state.json')
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
