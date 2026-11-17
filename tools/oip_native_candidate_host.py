"""One-shot, owned native OIP candidate editor process (never Runtime).

The supervisor lives in a Windows kill-on-close job. Its native children die
before apply_tools publishes output. Requests are trusted private staging files,
not shell commands or renderer JavaScript supplied by a model.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

from oip_batch_mcp import call, initialize, require_open_project, rpc
from oip_editor_bridge import ensure_runtime
from oip_project_bootstrap import read_asar, asar_entry
from launch_fuxa_oip import OwnedJob, identity as process_identity, same_process
from windows_listener_owner import listener_descends_from
from workbench_oip_tools import (ALLOWED, CREATION_TOOL, MUTATIONS, RUNS, _atomic, _catalog, _digest,
                                identity, resolve_input, validate_calls, validate_name)
from workbench_project_config import plain, validate_oip


LABELS = {'add_part': '添加部件', 'update_part': '调整部件', 'delete_parts': '删除部件',
          'duplicate_parts': '复制部件', 'snap_part': '吸附定位', 'get_scene': '查看场景',
          'get_part': '查看部件', 'get_package': '查看部件参数', 'list_catalog': '查看部件目录',
          'get_io_list': '核对信号', 'list_controllers': '查看控制器',
          'get_problems': '检查场景', 'check_part': '检查部件'}


def file_hashes(loaded):
    return {p.relative_to(loaded['root']).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in loaded['files']}


def execute(request_path):
    request_path = Path(request_path).resolve()
    plain(request_path, RUNS.resolve())
    if request_path.name != 'request.json' or request_path.parent.parent != RUNS.resolve():
        raise ValueError('A private OIP candidate request is required')
    run = request_path.parent
    request = json.loads(request_path.read_text(encoding='utf-8'))
    if request.get('identity') != identity() or request.get('contractVersion') != 1:
        raise ValueError('OIP native request identity changed')
    creating = request.get('operation') == 'create'
    if request.get('operation', 'edit') not in ('edit', 'create'):
        raise ValueError('Unknown OIP native operation')
    if creating:
        creation_name = validate_name(request.get('name'))
        if request.get('project') is not None or request.get('sourceFiles') != {}:
            raise ValueError('Native creation requires an empty source')
        project, loaded = None, None
        projects_root = run / 'projects'; projects_root.mkdir(exist_ok=False)
    else:
        project = Path(request['project']).resolve()
        if project != run / 'project':
            raise ValueError('Native editing is restricted to the private scene copy')
        loaded = validate_oip(project, editing=True)
        if file_hashes(loaded) != request['sourceFiles']:
            raise ValueError('OIP staged source changed before execution')
        projects_root = run
    calls = validate_calls(request['calls'], allow_empty=creating)
    exe = ensure_runtime()
    catalog = _catalog()
    header, packed = read_asar(exe.parent / 'resources/app.asar')
    for name, expected_hash in catalog['nativeFiles'].items():
        if name in ('main.cjs', 'preload.cjs'):
            continue  # ensure_runtime verifies the exact reviewed bridge patches.
        if hashlib.sha256(asar_entry(header, packed, name)).hexdigest() != expected_hash:
            raise RuntimeError('OIP native package changed: ' + name)
    renderer = exe.parent / 'resources/dist/assets' / catalog['rendererFile']
    if hashlib.sha256(renderer.read_bytes()).hexdigest() != catalog['rendererSha256']:
        raise RuntimeError('OIP native editing implementation changed')
    # Keep the job alive until process exit; never put the shared backend in it.
    owned_job = OwnedJob()
    profile = run / 'profile'; profile.mkdir(exist_ok=False)
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
    nonce = secrets.token_hex(32)
    environment = os.environ.copy()
    for key in ('ELECTRON_RUN_AS_NODE', 'OIP_PLCDEV_BOOTSTRAP'):
        environment.pop(key, None)
    environment.update(OIP_MCP_PORT=str(port), OIP_PROJECTS_DIR=str(projects_root),
                       PLCDEV_OIP_EDITOR_NONCE=nonce, PLCDEV_OIP_PROFILE=str(profile))
    with (run / 'native.log').open('wb') as log:
        # The public Agent open_project path preserves the fresh project's
        # autosave. CLI initial-folder uses a human-facing replacement dialog.
        process = subprocess.Popen([str(exe), '--user-data-dir=' + str(profile)],
            env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        owner = process_identity(process.pid)
        if not owner or Path(owner['executable']) != Path(exe).resolve():
            raise RuntimeError('OIP process identity could not be verified')
        _atomic(run / 'process.json', {'process': owner, 'port': port, 'profile': str(profile),
                                     'project': str(project) if project else None, 'operation': 'create' if creating else 'edit'})
        events = []

        def native(name, args=None, timeout=35):
            if not same_process(owner) or not listener_descends_from(port, process.pid):
                raise RuntimeError('OIP owned endpoint is no longer available')
            answer = call(name, args or {}, port=port, timeout=timeout)
            if not same_process(owner):
                raise RuntimeError('OIP process changed during native operation')
            if isinstance(answer, dict) and (answer.get('error') or answer.get('ok') is False):
                raise RuntimeError('OIP native tool rejected the call: ' + json.dumps(answer, ensure_ascii=False)[:1500])
            return answer

        def loaded_state():
            require_open_project(native('list_projects'), project)
            state = native('plcdev_editor_state', {'nonce': nonce, 'action': 'observe', 'compact': True})
            if Path(state.get('folderPath') or '').resolve() != project:
                raise RuntimeError('OIP renderer has not loaded the requested scene')
            if state.get('pendingConfirmation'):
                raise RuntimeError('OIP 正在等待原生工程打开确认；尚未执行修改。')
            if state.get('running') is not False or state.get('readOnly') or state.get('folderConflict') or state.get('folderError') or state.get('folderPaused'):
                raise RuntimeError('OIP 场景当前不能安全编辑。')
            return state

        try:
            deadline = time.monotonic() + 80
            last_error = 'OIP 尚未完成载入'
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('OIP candidate editor exited before loading')
                try:
                    if listener_descends_from(port, process.pid):
                        initialize(port=port, timeout=4)
                        context = native('get_context', timeout=4)
                        if context.get('running') is not False:
                            raise RuntimeError('OIP fresh editor was not stopped')
                        break
                except Exception as exc:
                    last_error = str(exc)
                time.sleep(.35)
            else:
                raise RuntimeError('OIP 工程未确认载入：' + last_error[:500])
            listed = rpc('tools/list', {}, port=port, timeout=15)['result']['tools']
            actual = {tool['name']: tool for tool in listed if tool['name'] in ALLOWED}
            expected = {tool['name']: tool for tool in _catalog()['tools'] if tool['name'] in ALLOWED}
            if actual != expected:
                raise RuntimeError('OIP native tool schemas differ from the reviewed catalogue')
            if creating:
                creation_definition = next((tool for tool in listed if tool.get('name') == 'new_project'), None)
                if not creation_definition or creation_definition.get('inputSchema') != CREATION_TOOL['inputSchema']:
                    raise RuntimeError('OIP native project creation schema changed')
                event = {'name': 'new_project', 'input': {'name': creation_name}, 'phase': 'dispatched'}
                _atomic(run / 'creation.json', event)
                result = native('new_project', {'name': creation_name}, timeout=45)
                event.update(phase='returned', result=result); _atomic(run / 'creation.json', event)
            else:
                listing = native('list_projects')
                if not any(Path(item.get('path') or '').resolve() == project for item in listing.get('projects', [])):
                    raise RuntimeError('OIP 原生项目列表没有找到私有候选；未请求访问其他目录。')
                native('open_project', {'project': str(project)}, timeout=45)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                try:
                    if creating and project is None:
                        opened = [item for item in native('list_projects').get('projects', []) if item.get('open') is True]
                        if len(opened) != 1:
                            raise RuntimeError('OIP 新工程尚未确认载入。')
                        proposed = Path(opened[0].get('path') or '').resolve()
                        plain(proposed, projects_root)
                        if proposed == projects_root:
                            raise RuntimeError('OIP 未生成独立的场景目录。')
                        bootstrap = validate_oip(proposed, editing=True)
                        if bootstrap['project']['name'] != creation_name:
                            raise RuntimeError('OIP 创建结果不是本次命名的新场景。')
                        project = proposed
                    loaded_state()
                    break
                except Exception as exc:
                    last_error = str(exc)
                    time.sleep(.3)
            else:
                raise RuntimeError('OIP 候选打开未完成：' + last_error[:500])
            if creating:
                loaded = validate_oip(project, editing=True)
                baseline_files = file_hashes(loaded)
                _atomic(run / 'native-empty-project.json', {'files': baseline_files,
                    'project': loaded['project'], 'scene': loaded['scene']})
                _atomic(run / 'process.json', {'process': owner, 'port': port, 'profile': str(profile),
                                             'project': str(project), 'operation': 'create'})
            else:
                baseline_files = request['sourceFiles']
            if loaded_state().get('reviewPending'):
                raise RuntimeError('A fresh candidate host unexpectedly contains pending edits')
            results = []
            operations = [{'name': 'new_project', 'summary': '新建场景 · ' + creation_name}] if creating else []
            for index, item in enumerate(calls):
                loaded_state()
                args = resolve_input(item['input'], results)
                # Recheck resolved data against the actual native envelope.
                validate_calls([{'name': item['name'], 'input': args}])
                package_id = args.get('package') if item['name'] == 'add_part' else None
                if item['name'] == 'update_part' and 'params' in args:
                    part = native('get_part', {'id': args['id']}).get('part', {})
                    package_id = part.get('packageId') if part.get('type') == 'part' else None
                if package_id:
                    declaration = native('get_package', {'id': package_id})
                    reviewed = next((p for p in catalog['packages'] if p['id'] == package_id), None)
                    if not reviewed or declaration.get('params') != reviewed.get('params'):
                        raise RuntimeError('OIP 部件参数定义与规划目录不一致，请先核对部件：' + package_id)
                event = {'index': index, 'name': item['name'], 'input': args, 'phase': 'dispatched'}
                events.append(event); _atomic(run / 'execution.json', events)
                result = native(item['name'], args)
                results.append(result)
                event.update(phase='returned', result=result)
                _atomic(run / 'execution.json', events)
                detail = args.get('name') or args.get('id') or args.get('package') or ''
                operations.append({'name': item['name'], 'summary': LABELS[item['name']] + (' · ' + detail if isinstance(detail, str) and detail else '')})
            problems = native('get_problems')
            io_list = native('get_io_list')
            flush = native('sync_folder', timeout=45)
            if flush.get('conflict') or flush.get('folderError') or flush.get('stoppedRun'):
                raise RuntimeError('OIP 保存时发现外部变化或运行状态变化。')
            state = loaded_state()
            if state.get('persistPending'):
                raise RuntimeError('OIP 原生保存尚未完成。')
            final = validate_oip(project, editing=True)
            files = file_hashes(final)
            # No tool in the exposed surface edits OIP's internal PLC program.
            # Do not let migrations or an accidental endpoint change do so.
            for name in loaded['project'].get('program', []):
                if files.get(name) != baseline_files.get(name):
                    raise RuntimeError('OIP 原生执行意外改变了内部程序；候选未发布。')
            if final['project'].get('program', []) != loaded['project'].get('program', []):
                raise RuntimeError('OIP 原生执行意外改变了内部程序引用。')
            if final['scene'].get('plcs', []) != loaded['scene'].get('plcs', []):
                raise RuntimeError('OIP 原生执行意外改变了控制器连接；候选未发布。')
            errors, warnings = problems.get('errors', 0), problems.get('warnings', 0)
            details = []
            for issue in problems.get('problems', [])[:3]:
                if isinstance(issue, dict) and isinstance(issue.get('message'), str):
                    subject = str(issue.get('subject') or '').strip()
                    details.append((subject + '：' if subject else '') + issue['message'][:400])
            summary = f'{errors} 个错误，{warnings} 个提醒；接线检查依据 OIP 内部程序。'
            if details: summary += '\n' + '\n'.join(details)
            checks = [{'id': 'oip-native-problems', 'label': 'OIP 场景与信号检查',
                       'status': 'failed' if errors else 'warning' if warnings else 'passed',
                       'summary': summary},
                      {'id': 'oip-native-save', 'label': '场景保存与文件核对', 'status': 'passed'},
                      {'id': 'oip-external-runtime', 'label': '外部 PLC 运行验证', 'status': 'skipped', 'summary': '本轮未启动仿真或 PLC Runtime。'}]
            for index, item in enumerate(calls):
                if item['name'] == 'check_part':
                    result = results[index]
                    failed = isinstance(result, dict) and (result.get('errors') or result.get('ok') is False or result.get('valid') is False)
                    checks.append({'id': 'oip-native-part-' + str(index), 'label': '部件定义检查',
                                   'status': 'failed' if failed else 'passed', 'summary': 'OIP 原生定义检查与确定性构建。'})
            summary = ('已新建 OIP 场景 · ' + creation_name if creating else
                       '已通过 OIP 原生工具处理 ' + str(sum(c['name'] in MUTATIONS for c in calls)) + ' 项部件修改')
            component = {'tool': 'oip', 'summary': summary,
                         'operations': operations, 'checks': checks, 'nativeVersion': identity()['nativeVersion']}
            _atomic(run / 'checks.json', {'problems': problems, 'ioList': io_list})
            return {'ok': True, 'identity': identity(), 'files': files, 'component': component, 'project': str(project)}
        finally:
            if process.poll() is None and same_process(owner):
                process.terminate()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=8)


if __name__ == '__main__':
    request = Path(sys.argv[1])
    try:
        result = execute(request)
        _atomic(request.parent / 'result.json', result)
    except BaseException as error:
        _atomic(request.parent / 'result.json', {'ok': False, 'error': str(error)[:2000]})
        raise
