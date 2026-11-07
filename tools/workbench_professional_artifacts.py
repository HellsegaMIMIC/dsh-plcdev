"""P3 local professional artifacts for the existing joint candidate boundary.

These are separately callable deterministic native-file operations, not agents.
The caller owns the TaskService task and supplies its identity. This module has
no task engine, model client, Runtime control, source apply or permission editor.
Only the explicit saved revision is read; unsaved editor buffers are excluded.
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import uuid

from plcdev_runtime_owner import FileLease
from workbench_agent_adapters import (
    AdapterError, _candidate_project_lease, _digest, _file_hash, _files,
    _manifest_project, _snapshot,
)
from workbench_joint_changes import _atomic
from workbench_project_config import plain, read_json, relative, validate_fuxa, validate_oip
from workbench_projects import read_user_project
from workbench_hmi_permissions import permission_contract, inherit_permissions

ROLES = ('plc', 'hmi', 'oip')
CONTRACT = 'professional-native-artifacts-v4'


def reject(message, code='invalid_request'):
    raise AdapterError(code, message)


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        reject('专业产物包含未知字段或缺少必需字段。')


def identifier(task_id):
    if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', task_id):
        reject('任务身份无效。')


def serialized(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'


def content_hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _native_contract(project, before):
    """Verify declared PLC paths against actual native types and locations."""
    manifest = read_json(project['manifestPath'])
    if manifest['schemaVersion'] != 2:
        reject('本批专业能力仅支持声明 batch-mailbox-v1 的三端工程。', 'not_ready')
    root = Path(project['projectRoot'])
    plc_path = Path(project['plc'])
    plc = read_json(plc_path)
    instances = plc['data']['configuration']['resource']['instances']
    bindings = project['configuration']['bindings']
    paths = {}
    for role, item in bindings['plc'].items():
        pieces = item['path'].split('.')
        if len(pieces) != 2:
            reject('本批接口只支持明确的实例局部变量。', 'not_ready')
        matches = [i for i in instances if i['name'].lower() == pieces[0].lower()]
        if len(matches) != 1 or not re.fullmatch(r'[A-Za-z_]\w*', matches[0]['program'], re.ASCII):
            reject('PLC 实例不存在或不唯一。')
        program = matches[0]['program']
        candidates = [plc_path.parent / 'pous/programs' / (program + suffix) for suffix in ('.ld', '.st')]
        candidates = [p for p in candidates if p.is_file()]
        if len(candidates) != 1:
            reject('原生程序文件不存在或不唯一。')
        path = candidates[0]
        plain(path, root)
        # LD declarations precede its JSON graph. Strip comments before checking
        # exact declarations; mentions in comments cannot prove an interface.
        text = path.read_text(encoding='utf-8').partition('\n{')[0]
        text = re.sub(r'\(\*.*?\*\)|//[^\n]*', '', text, flags=re.S)
        declarations = re.findall(r'^\s*' + re.escape(pieces[1]) + r'\s*:\s*(\w+)\s+AT\s+(%[IQ][XW][\d.]+)\b', text, re.M | re.I)
        if declarations != [(item['type'], item['location'])]:
            reject('PLC 声明与工程变量／类型／地址不一致：' + role, 'conflict')
        paths[role] = path.relative_to(root).as_posix()
    scene = validate_oip(project['scene'])
    parts = scene['scene']['parts']
    part_ids = [p.get('id') for p in parts]
    if any(not isinstance(x, str) for x in part_ids) or len(set(part_ids)) != len(part_ids):
        reject('OIP 部件身份缺失或重复。')
    def bit(space, address):
        return '%' + space + str(address // 8) + '.' + str(address % 8)
    def match_part(package, key, tag):
        found = [p for p in parts if p.get('packageId') == package and p.get('params', {}).get(key) == tag]
        if len(found) != 1:
            reject('OIP 场景部件与工程绑定不一致。', 'conflict')
        return found[0]
    conveyor = match_part('oip.belt-conveyor', 'runTag', bit('QX', bindings['oip']['outputs']['conveyor']['address']))
    match_part('oip.box-spawner', 'runTag', bit('QX', bindings['oip']['outputs']['entryConveyor']['address']))
    match_part('oip.diffuse-sensor', 'tag', bit('IX', bindings['oip']['inputs']['sensorOccupied']['address']))
    hmi = validate_fuxa(project['hmi'])
    return {'schemaVersion': 1, 'contract': CONTRACT, 'projectId': project['id'],
            'baselineRevision': before['projectRevision'], 'bindings': bindings,
            'plcPrograms': paths,
            'hmiTags': {key: {field: tag[field] for field in ('id', 'name', 'address', 'type', 'access')}
                        for key, tag in hmi['devices']['d_plcdev_batch']['tags'].items()},
            'hmiActions': sorted(s['id'] for s in hmi.get('scripts', [])),
            'hmiPermissions': permission_contract(hmi),
            'sceneFile': (scene['root'] / scene['project']['scene']).relative_to(root).as_posix(),
            'conveyorId': conveyor['id'],
            'permissions': {'directPlcWrite': False, 'sensorFeedbackWrite': False,
                            'hmiWrites': 'existing batch mailbox actions and local drafts only'},
            'operations': {'plc': 'batch-default-target', 'hmi': 'native-page', 'oip': 'conveyor-speed'},
            'sourceBasis': 'saved_revision', 'unsavedEditsIncluded': False}


def inspect_contract(project, expected_revision):
    project = _manifest_project(project)
    before = _snapshot(project)
    if before['projectRevision'] != expected_revision:
        reject('源版本已变化。', 'conflict')
    result = _native_contract(project, before)
    if _snapshot(project) != before:
        reject('读取专业契约期间源版本已变化。', 'conflict')
    return result


def _component(project, before, contract, task_id, role, proposal):
    root = Path(project['projectRoot'])
    if role == 'plc':
        exact(proposal, ('operation', 'value'))
        if proposal['operation'] != 'batch-default-target' or type(proposal['value']) is not int or not 1 <= proposal['value'] <= 1000:
            reject('PLC 只允许在现有 1–1000 约束内修改初始目标件数。')
        path = Path(project['plc']).parent / 'pous/function-blocks/BatchConveyor.st'
        plain(path, root)
        text = path.read_bytes().decode('utf-8')
        # Edit the existing native FB, preserving every other byte, including
        # its command range, interlocks, counting, recovery and LD invocation.
        pattern = r'(IF NOT Initialized THEN\s+Target := )(\d+)(;)'
        found = list(re.finditer(pattern, text))
        if (len(found) != 1 or not re.search(r'^FUNCTION_BLOCK BatchConveyor\s', text)
                or 'CommandValue < 1 OR CommandValue > 1000 THEN AckCode := 2;' not in text):
            reject('当前原生 FB 没有支持的初始化／范围校验形态。', 'not_ready')
        value = str(proposal['value'])
        if found[0][2] == value:
            reject('PLC 产物没有实际变化。')
        new = text[:found[0].start(2)] + value + text[found[0].end(2):]
        summary = '初始目标 ' + found[0][2] + ' → ' + value + '；保留 1–1000 校验及其余控制逻辑'
    elif role == 'hmi':
        exact(proposal, ('operation', 'spec', 'defaultTarget'))
        if (proposal['operation'] != 'native-page' or type(proposal['defaultTarget']) is not int
                or not 1 <= proposal['defaultTarget'] <= 1000):
            reject('HMI 仅支持现有原生画面转换器。')
        from workbench_joint_candidate import _compile_hmi
        native = _compile_hmi(proposal['spec'], default_target=proposal['defaultTarget'])
        native = inherit_permissions(validate_fuxa(project['hmi']), native)
        from workbench_hmi_native_gate import verify_native_permissions
        native_audit = verify_native_permissions(validate_fuxa(project['hmi']), native)
        tags = native['devices']['d_plcdev_batch']['tags']
        if (any(k not in contract['hmiTags'] or any(v.get(field) != contract['hmiTags'][k].get(field)
                for field in ('id', 'name', 'address', 'type', 'access')) for k, v in tags.items())
                or not set(s['id'] for s in native['scripts']).issubset(contract['hmiActions'])):
            reject('HMI 产物扩大了当前工程声明的标签／操作权限。')
        widgets = proposal['spec']['widgets']
        if not (any(w['type'] == 'input' and w.get('tag') == 'targetDraft' for w in widgets)
                and any(w['type'] == 'button' and w.get('action') == 'target' for w in widgets)
                and any(w['type'] == 'value' and w.get('tag') == 'commandResult' for w in widgets)):
            reject('画面必须包含目标草稿、显式应用和实际命令回执。')
        path, new = Path(project['hmi']), serialized(native)
        summary = proposal['spec']['title']
    elif role == 'oip':
        exact(proposal, ('operation', 'partId', 'value'))
        value = proposal['value']
        if (proposal['operation'] != 'conveyor-speed' or proposal['partId'] != contract['conveyorId']
                or type(value) not in (int, float) or not math.isfinite(value) or not 0.1 <= value <= 3):
            reject('场景仅允许声明输送带的 0.1–3 m/s 正向速度候选。')
        path = relative(root, contract['sceneFile'])
        scene = read_json(path)
        part = next(p for p in scene['parts'] if p['id'] == proposal['partId'])
        params = part['params']
        package = path.parent / 'parts/oip.belt-conveyor/manifest.json'
        plain(package, root)
        if (package.relative_to(root).as_posix() not in before['files']
                or read_json(package).get('id') != 'oip.belt-conveyor'
                or read_json(package).get('conveyor', {}).get('speedParam') != 'speed'
                or params.get('fpmUnits', False) is not False or params.get('speedTag') or params.get('speedFpmTag')):
            reject('该部件没有未绑定的 m/s 原生速度参数。', 'not_ready')
        old = params.get('speed')
        if type(old) not in (int, float) or old == value:
            reject('场景速度缺失或没有实际变化。')
        params['speed'] = value
        new, summary = serialized(scene), '输送带速度 ' + str(old) + ' → ' + str(value) + ' m/s；点位不变'
    else:
        reject('专业角色无效。')
    name = path.relative_to(root).as_posix()
    if name not in before['files'] or content_hash(new) == before['files'][name]:
        reject('产物必须修改本工程已有的专业资源。')
    return {'schemaVersion': 1, 'contract': CONTRACT, 'taskId': task_id, 'projectId': project['id'],
            'baselineRevision': before['projectRevision'], 'contractDigest': _digest(contract),
            'role': role, 'proposal': deepcopy(proposal), 'summary': summary,
            **({'permissionAudit': native_audit} if role == 'hmi' else {}),
            'files': {name: {'beforeSha256': before['files'][name], 'afterSha256': content_hash(new), 'content': new}}}


def generate_component(project, *, task_id, expected_revision, role, proposal):
    """One professional operation; returns data, never writes source or invokes AI."""
    identifier(task_id)
    project = _manifest_project(project)
    before = _snapshot(project)
    contract = inspect_contract(project, expected_revision)
    value = _component(project, before, contract, task_id, role, proposal)
    if _snapshot(project) != before:
        reject('专业生成期间源文件变化，未接受产物。', 'conflict')
    return value


def candidate_result(request, candidate_id, manifest, candidate_digest, components, merged):
    """One canonical result schema for construction and recovery verification."""
    target = Path(manifest).parent
    artifacts = [{'tool': {'plc': 'openplc', 'hmi': 'fuxa', 'oip': 'oip'}[value['role']],
                  'summary': value['summary'], 'artifactDigest': _digest(value),
                  'nativeArtifact': str(target / next(iter(value['files']))),
                  'source': 'local-professional-operation'} for value in components]
    return {'status': 'ok', **request, 'candidateId': candidate_id,
            'candidateManifest': str(manifest), 'candidateDigest': candidate_digest,
            'source': 'saved-files-only', 'sourceBasis': 'saved_revision', 'unsavedEditsIncluded': False,
            'tool': 'joint', 'operation': CONTRACT, 'generation': 'local-professional-artifacts',
            'components': artifacts, 'toolChanges': artifacts, 'changedFiles': sorted(merged),
            'changes': [{'path': p, **{k: v for k, v in c.items() if k != 'content'}} for p, c in merged.items()],
            'summary': {'before': '固定原生工程', 'after': '三端专业产物待审阅'},
            'validation': 'native-structure-types-addresses-permission-nonexpansion',
            'checks': ['exact source revision', 'role-scoped native resources', 'PLC declarations and bindings',
                       'unchanged HMI permissions and OIP mapping',
                       'exact native SVG permission targets and contained HTML controls',
                       'pinned native filter and actual DOM capability nonexpansion', 'source hashes unchanged'],
            'compilation': 'not_tested', 'runtime': 'not_tested', 'modelCalled': False,
            'authoritativeSourceModified': False, 'applySupported': False}


class ProfessionalCandidates:
    def __init__(self, state_root):
        self.state_root = Path(state_root).absolute()

    @contextmanager
    def _lease(self, project_id, task_id):
        with _candidate_project_lease(self.state_root, project_id):
            path = self.state_root / '.project-locks' / ('task-' + task_id + '.lock')
            plain(path, self.state_root)
            with FileLease(path):
                yield

    def verify_result(self, result, *, request, components):
        """Verify a complete result against independently accepted inputs.

        No source, ledger or candidate is written here. Reconstructing the
        baseline hashes from the actual candidate plus accepted changes binds
        the whole tree to the fixed source version without trusting its claims.
        """
        try:
            keys = {'taskId', 'projectId', 'baselineRevision', 'contractDigest', 'artifactDigest'}
            if type(request) is not dict or set(request) != keys:
                raise ValueError('incomplete expected request')
            identifier(request['taskId'])
            if not isinstance(request['projectId'], str) or not re.fullmatch(r'user-[0-9a-f]{32}', request['projectId']):
                raise ValueError('invalid project identity')
            for key in ('baselineRevision', 'contractDigest', 'artifactDigest'):
                if not isinstance(request[key], str) or not re.fullmatch(r'[0-9a-f]{64}', request[key]):
                    raise ValueError('invalid expected digest')
            if (type(result) is not dict or result.get('status') != 'ok'
                    or any(result.get(key) != request[key] for key in keys)
                    or not isinstance(result.get('candidateId'), str)
                    or not re.fullmatch(r'candidate-[0-9a-f]{32}', result['candidateId'])
                    or not isinstance(result.get('candidateDigest'), str)
                    or not re.fullmatch(r'[0-9a-f]{64}', result['candidateDigest'])
                    or not isinstance(result.get('candidateManifest'), str)):
                raise ValueError('result status, identity or digest mismatch')
            if type(components) is not list or len(components) != len(ROLES):
                raise ValueError('incomplete accepted components')
            by_role = {}
            for value in components:
                if (type(value) is not dict or value.get('role') not in ROLES or value['role'] in by_role
                        or value.get('contract') != CONTRACT
                        or any(value.get(key) != request[key] for key in keys - {'artifactDigest'})):
                    raise ValueError('component identity mismatch')
                by_role[value['role']] = value
            components = [by_role[role] for role in ROLES]
            if _digest(components) != request['artifactDigest']:
                raise ValueError('accepted artifact digest mismatch')
            merged = {}
            for value in components:
                if type(value.get('files')) is not dict or not value['files']:
                    raise ValueError('missing component files')
                for name, change in value['files'].items():
                    if (not isinstance(name, str) or name in merged or type(change) is not dict
                            or set(change) != {'beforeSha256', 'afterSha256', 'content'}
                            or not isinstance(change['content'], str)):
                        raise ValueError('invalid component change')
                    for key in ('beforeSha256', 'afterSha256'):
                        if not isinstance(change[key], str) or not re.fullmatch(r'[0-9a-f]{64}', change[key]):
                            raise ValueError('invalid file digest')
                    if content_hash(change['content']) != change['afterSha256'] or change['beforeSha256'] == change['afterSha256']:
                        raise ValueError('component content mismatch')
                    merged[name] = change
            folder = self.state_root / request['taskId'] / result['candidateId']
            plain(folder, self.state_root)
            target = folder / 'project'
            manifest = Path(result['candidateManifest'])
            plain(manifest, target)
            if manifest.parent != target:
                raise ValueError('candidate manifest outside owned tree')
            actual = self._verify_tree(manifest, result['candidateDigest'])
            if actual['projectId'] != request['projectId']:
                raise ValueError('candidate project mismatch')
            baseline_files = dict(actual['files'])
            for name, change in merged.items():
                relative(target, name)
                if actual['files'].get(name) != change['afterSha256']:
                    raise ValueError('candidate does not contain the accepted artifact')
                baseline_files[name] = change['beforeSha256']
            if _digest({'projectId': request['projectId'], 'files': baseline_files}) != request['baselineRevision']:
                raise ValueError('candidate does not reconstruct the fixed source')
            expected = candidate_result(request, result['candidateId'], manifest, actual['projectRevision'], components, merged)
            # Canonical JSON hashing is type-sensitive (False is not 0), rejects
            # nonfinite values, and checks every required field and no extras.
            if set(result) != set(expected) or _digest(result) != _digest(expected):
                raise ValueError('incomplete or inconsistent result schema')
            for path, value in [(folder / 'candidate.json', expected),
                                *((folder / (c['role'] + '.json'), c) for c in components)]:
                plain(path, folder)
                if _digest(read_json(path)) != _digest(value):
                    raise ValueError('durable candidate or component receipt mismatch')
            expected_paths = {'candidate.json', *(role + '.json' for role in ROLES),
                              *('project/' + name for name in actual['files'])}
            seen = set()
            for path in folder.rglob('*'):
                plain(path, folder)
                if path.is_file(): seen.add(path.relative_to(folder).as_posix())
            if seen != expected_paths:
                raise ValueError('unexpected or missing candidate bundle file')
            return expected
        except (AdapterError, OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
            reject('组装完成结果的结构、身份、状态或产物证据无法完整核实；保持未知，不重新执行。', 'unknown_outcome')

    def assemble(self, project, *, task_id, expected_revision, components):
        identifier(task_id)
        project = _manifest_project(project)
        source_root = Path(project['projectRoot']).resolve()
        if source_root.is_relative_to(self.state_root.resolve()) or self.state_root.resolve().is_relative_to(source_root):
            reject('任务目录不得与源工程互相包含。')
        # Validate all independent outputs before producing any candidate tree.
        before = _snapshot(project)
        contract = inspect_contract(project, expected_revision)
        if not isinstance(components, list) or len(components) != 3:
            reject('统一候选须包含 PLC、HMI、OIP 各一份完整产物。')
        by_role = {}
        for value in components:
            if not isinstance(value, dict) or value.get('role') not in ROLES or value['role'] in by_role:
                reject('专业角色缺失、重复或未知。')
            expected = _component(project, before, contract, task_id, value['role'], value.get('proposal'))
            if value != expected:
                reject('专业产物身份、版本、契约或内容不一致。', 'conflict')
            by_role[value['role']] = value
        components = [by_role[r] for r in ROLES]
        if by_role['plc']['proposal']['value'] != by_role['hmi']['proposal']['defaultTarget']:
            reject('PLC 初始目标与 HMI 草稿初值不一致，未组装。', 'conflict')
        merged = {}
        for value in components:
            if set(merged) & set(value['files']):
                reject('专业产物写入范围重叠。', 'conflict')
            merged.update(value['files'])
        request = {'taskId': task_id, 'projectId': project['id'], 'baselineRevision': expected_revision,
                   'contractDigest': _digest(contract), 'artifactDigest': _digest(components)}
        with self._lease(project['id'], task_id):
            folder = self.state_root / task_id
            plain(folder, self.state_root)
            folder.mkdir(exist_ok=True)
            ledger = folder / 'professional-assembly.json'
            plain(ledger, self.state_root)
            if ledger.exists():
                try:
                    old = read_json(ledger)
                    if type(old) is not dict or set(old) != {'request', 'state', 'result'}:
                        raise ValueError('incomplete confirmed ledger')
                except (OSError, ValueError, TypeError, RecursionError):
                    reject('原组装账本不完整或损坏，保留未知结果。', 'unknown_outcome')
                if old.get('request') != request:
                    reject('同一任务已有不同专业产物，未覆盖。', 'conflict')
                if old.get('state') != 'confirmed':
                    reject('原候选组装结果未知，保留证据且不重复执行。', 'unknown_outcome')
                result = self.verify_result(old['result'], request=request, components=components)
                if _snapshot(project) != before:
                    reject('源版本已变化。', 'conflict')
                return result
            if any(folder.iterdir()):
                reject('原任务目录已有其他生成记录，未创建第二份候选。', 'conflict')
            if _snapshot(project) != before:
                reject('组装前源版本已变化。', 'conflict')
            candidate_id = 'candidate-' + uuid.uuid4().hex
            destination = folder / candidate_id
            _atomic(ledger, {'request': request, 'state': 'prepared', 'candidateId': candidate_id})
            destination.mkdir()
            target = destination / 'project'
            target.mkdir()
            root, files = _files(project)
            for source in files:
                path = target / source.relative_to(root)
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, path)
                with path.open('r+b') as stream:
                    stream.flush(); os.fsync(stream.fileno())
                if _file_hash(path) != before['files'][source.relative_to(root).as_posix()]:
                    reject('复制期间源工程变化，未发布候选。', 'conflict')
            manifest = target / Path(project['manifestPath']).relative_to(root)
            if _snapshot(read_user_project(manifest)) != before:
                reject('隔离副本不等于指定源版本。', 'conflict')
            for path, change in merged.items():
                with relative(target, path).open('wb') as stream:
                    stream.write(change['content'].encode('utf-8'))
                    stream.flush(); os.fsync(stream.fileno())
            proposed = read_user_project(manifest)
            after = _snapshot(proposed)
            expected_files = dict(before['files'])
            expected_files.update({p: c['afterSha256'] for p, c in merged.items()})
            if after['files'] != expected_files or _native_contract(proposed, before) != contract:
                reject('统一候选超出专业资源／接口契约。', 'conflict')
            if _snapshot(project) != before:
                reject('组装期间源文件变化，未发布候选。', 'conflict')
            for value in components:
                _atomic(destination / (value['role'] + '.json'), value)
            result = candidate_result(request, candidate_id, manifest, after['projectRevision'], components, merged)
            # This is the sole publication point. Failed/partial trees retain no
            # successful candidate receipt and are never retained automatically.
            _atomic(destination / 'candidate.json', result)
            _atomic(ledger, {'request': request, 'state': 'confirmed', 'result': result})
            return self.verify_result(result, request=request, components=components)

    @staticmethod
    def _verify_tree(manifest, digest):
        project = read_user_project(manifest)
        actual = _snapshot(project)
        root = Path(project['projectRoot'])
        seen = set()
        for path in root.rglob('*'):
            plain(path, root)
            if path.is_file():
                seen.add(path.relative_to(root).as_posix())
        if actual['projectRevision'] != digest or seen != set(actual['files']):
            reject('原候选文件已改变，未重新生成。', 'conflict')
        return actual
