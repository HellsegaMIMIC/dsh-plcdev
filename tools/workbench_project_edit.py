"""Saved-project editing shared by ordinary DSH models.

The model supplies data, never commands. Edits are staged in a verified copy;
publication, retention and native compilation remain separate task operations.
"""
from __future__ import annotations
import copy
import json
import math
from pathlib import Path
import re
import shutil
import uuid

from workbench_agent_adapters import (AgentAdapters, AdapterError, _candidate_project_lease,
    _manifest_project, _snapshot, _files, _file_hash)
from workbench_projects import read_user_project
from workbench_project_config import (plain, read_json, validate_oip, validate_interface_fuxa,
    configure_interface_project)
from project_interface import ai_context, validate_interface
from workbench_hmi_text import saved_target_catalog, replace_static_text
from workbench_hmi_value import value_targets, append_value

MAX_PLAN = 512 * 1024
MAX_SOURCE = 128 * 1024
FIELDS = {
    'openplc-tools': {'kind', 'calls'},
    'oip-tools': {'kind', 'calls'},
    'oip-create-scene': {'kind', 'name', 'calls'},
    'plc-source': {'kind', 'path', 'expectedHash', 'content'},
    'interface': {'kind', 'definition'},
    'hmi-view-name': {'kind', 'viewId', 'name'},
    'hmi-static-text': {'kind', 'viewId', 'elementId', 'text'},
    'hmi-readonly-value': {'kind', 'viewId', 'signalId'},
    'oip-part-name': {'kind', 'partId', 'name'},
    'oip-conveyor-speed': {'kind', 'partId', 'value'},
}


def reject(message, code='invalid_request'):
    raise AdapterError(code, message)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def validate_plan(plan):
    if (not isinstance(plan, dict) or set(plan) != {'schemaVersion', 'changes'}
            or type(plan['schemaVersion']) is not int or plan['schemaVersion'] != 1
            or not isinstance(plan['changes'], list) or not 1 <= len(plan['changes']) <= 32):
        reject('工程修改需要 schemaVersion=1 和 1–32 项 changes。')
    try:
        if len(json.dumps(plan, ensure_ascii=False, allow_nan=False).encode()) > MAX_PLAN:
            reject('修改计划超过 512 KiB。')
    except (ValueError, TypeError):
        reject('修改计划必须为有限 JSON 数据。')
    targets = set()
    kinds = {item.get('kind') for item in plan['changes'] if isinstance(item, dict) and isinstance(item.get('kind'), str)}
    if ('oip-tools' in kinds and kinds.intersection({'oip-part-name', 'oip-conveyor-speed'})
            or 'oip-create-scene' in kinds and kinds.intersection({'oip-tools', 'oip-part-name', 'oip-conveyor-speed'})):
        reject('同一候选的 OIP 修改请统一使用原生编辑工具，不能与旧场景修改混用。')
    if any(item.get('kind') == 'openplc-tools' for item in plan['changes'] if isinstance(item, dict)) and any(
            item.get('kind') == 'plc-source' for item in plan['changes'] if isinstance(item, dict)):
        reject('同一候选的 PLC 修改请统一使用 OpenPLC 编辑工具；不能与旧整文件替换混用。')
    for item in plan['changes']:
        if not isinstance(item, dict) or item.get('kind') not in FIELDS or set(item) != FIELDS[item['kind']]:
            reject('修改类型或字段不受支持。')
        kind = item['kind']
        key = (kind, item.get('path'), item.get('viewId'), item.get('elementId'), item.get('signalId'), item.get('partId'))
        try:
            if key in targets: reject('同一计划重复修改同一目标。')
            targets.add(key)
        except TypeError: reject('修改目标必须为文本身份。')
        for field in ('path', 'viewId', 'elementId', 'signalId', 'partId'):
            if field in item and (not isinstance(item[field], str) or not item[field] or len(item[field]) > 500
                                  or any(ord(c) < 32 for c in item[field])):
                reject('修改目标身份无效。')
        for field in ('name', 'text'):
            value = item.get(field)
            if field in item and (not isinstance(value, str) or not value.strip() or len(value) > (160 if field == 'text' else 80)
                                  or any(ord(c) < 32 or c in '<>' for c in value)):
                reject('画面或部件文字无效。')
        if kind == 'plc-source':
            if not isinstance(item['expectedHash'], str) or not re.fullmatch('[0-9a-f]{64}', item['expectedHash']):
                reject('PLC 修改需要当前文件 sha256。')
            if not isinstance(item['content'], str) or not item['content'].strip() or len(item['content'].encode()) > MAX_SOURCE:
                reject('PLC 源文件须为 1–128 KiB 的完整 ST 文件。')
        if kind == 'openplc-tools':
            from workbench_openplc_tools import validate_calls
            validate_calls(item['calls'])
        if kind in ('oip-tools', 'oip-create-scene'):
            from workbench_oip_tools import validate_calls
            validate_calls(item['calls'], allow_empty=kind == 'oip-create-scene')
        if kind == 'interface': validate_interface(item['definition'])
        if kind == 'oip-conveyor-speed' and (type(item['value']) not in (int, float)
                or not math.isfinite(item['value']) or not 0.1 <= item['value'] <= 3):
            reject('输送带静态速度须为 0.1–3 m/s。')
    return copy.deepcopy(plan)


def st_code(source):
    # Remove only IEC comments/string literals. Escape blocks remain visible.
    # Unterminated/nested comments are left for the real IEC compiler to reject.
    return re.sub(r"\(\*.*?\*\)|//[^\r\n]*|'(?:\$[\s\S]|''|[^'])*'|\"(?:\$[\s\S]|[^\"])*\"", ' ', source, flags=re.S)


def validate_st(old, new):
    code = st_code(new)
    if '\x00' in new or any(c in code for c in '{}') or re.search(r'(?im)^\s*#|\bAT\s+%|\bVAR_EXTERNAL\b', code):
        reject('仅支持本机 PLC 的 IEC ST；不能加入宿主代码、外部变量或物理 I/O 地址。')
    declarations = r'(?im)^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_][A-Za-z_0-9]*)\b'
    previous = [(a.upper(), b.lower()) for a, b in re.findall(declarations, st_code(old))]
    current = [(a.upper(), b.lower()) for a, b in re.findall(declarations, code)]
    if len(previous) != 1 or current != previous:
        reject('旧整文件替换须保留原 ST 的 POU 类型和名称；新增 POU 请使用 OpenPLC 共享编辑工具。')


def editable_sources(project):
    root, paths = _files(project)
    pou_root = Path(project['plc']).parent / 'pous'
    result, total = [], 0
    for path in paths:
        if path.suffix.lower() != '.st' or not path.is_relative_to(pou_root): continue
        if path.stat().st_size > MAX_SOURCE: continue
        content = path.read_text(encoding='utf-8-sig')
        try: validate_st(content, content)
        except AdapterError: continue
        total += len(content.encode())
        if total > 256 * 1024: break
        result.append({'path': path.relative_to(root).as_posix(), 'sha256': _file_hash(path), 'content': content})
    return result


def oip_targets(project):
    if not project.get('scene'): return []
    scene = validate_oip(project['scene'], editing=True)
    result = []
    packages = [read_json(scene['root'] / path / 'manifest.json') for path in scene['project'].get('packages', [])]
    belt = any(p.get('id') == 'oip.belt-conveyor' and p.get('conveyor', {}).get('speedParam') == 'speed' for p in packages)
    for part in scene['scene']['parts']:
        if not isinstance(part, dict) or not isinstance(part.get('id'), str): continue
        params = part.get('params', {})
        speed = (belt and part.get('type') == 'oip.belt-conveyor' and isinstance(params, dict)
                 and type(params.get('speed')) in (int, float) and params.get('fpmUnits', False) is False
                 and not params.get('speedTag') and not params.get('speedFpmTag'))
        result.append({'id': part['id'], 'name': part.get('name'), 'type': part.get('type'),
                       'operations': ['oip-part-name'] + (['oip-conveyor-speed'] if speed else []),
                       **({'speed': params['speed']} if speed else {})})
    return result


def _preserve_interface_permissions(previous, current):
    for group in ('variables', 'operations'):
        after = {item['id']: item for item in current[group]}
        for before in previous[group]:
            item = after.get(before['id'])
            if before.get('aiVisible') is not True and item != before:
                reject('不可修改或移除未向 AI 开放的接口声明。')
            if item is not None and (before.get('access') == 'read' and item.get('access') != 'read'
                    or before.get('enabled') is False and item.get('enabled') is not False):
                reject('此接口修改不能扩大既有读写或操作权限。')


def merge_interface(previous, submitted):
    """Keep declarations deliberately omitted from the model's public context."""
    previous=validate_interface(previous);submitted=validate_interface(submitted)
    visible=ai_context(previous);merged=copy.deepcopy(submitted)
    for group in ('variables','operations'):
        public_ids={item['id'] for item in visible[group]}
        proposed={item['id']:item for item in submitted[group]}
        old_ids={item['id'] for item in previous[group]}
        entries=[]
        for old in previous[group]:
            if old['id'] not in public_ids:
                if old['id'] in proposed and proposed[old['id']]!=old:
                    reject('不可修改未向 AI 开放或已禁用的接口声明。')
                entries.append(copy.deepcopy(old))
            elif old['id'] in proposed:entries.append(proposed[old['id']])
        entries.extend(item for item in submitted[group] if item['id'] not in old_ids)
        merged[group]=entries
    merged=validate_interface(merged)
    _preserve_interface_permissions(previous,merged)
    return merged


def apply_change(project, change, receipts=None):
    kind = change['kind']; root = Path(project['projectRoot'])
    if kind == 'oip-create-scene':
        from workbench_oip_tools import create_scene
        if receipts is None: reject('原生场景创建缺少回执存储。')
        result = create_scene(project, change['name'], change['calls'])
        scene = Path(result['scene']).resolve()
        if not scene.is_relative_to(root.resolve()) or scene.name != 'project.json':
            reject('原生创建结果不属于本轮候选。', 'conflict')
        manifest = read_json(project['manifestPath'])
        manifest['simulation'] = {'provider': 'oip', 'project': scene.relative_to(root.resolve()).as_posix()}
        write_json(project['manifestPath'], manifest)
        receipts['oip'] = result['receipt']
        return result['component']
    if kind == 'oip-tools':
        from workbench_oip_tools import apply_tools
        result = apply_tools(project, change['calls'])
        if receipts is None: reject('原生场景修改缺少回执存储。')
        receipts['oip'] = result['receipt']
        return result['component']
    if kind == 'openplc-tools':
        from workbench_openplc_tools import apply_tools, component
        apply_tools(project, change['calls'])
        return component(change['calls'])
    if kind == 'plc-source':
        available = {s['path']: s for s in editable_sources(project)}
        source = available.get(change['path'])
        if source is None: reject('只能修改上下文列出的现存 ST 文件。')
        if source['sha256'] != change['expectedHash']: reject('PLC 文件已变化；请重新读取当前候选。', 'conflict')
        validate_st(source['content'], change['content'])
        (root / change['path']).write_bytes(change['content'].encode('utf-8'))
        return {'tool': 'openplc', 'summary': '更新 ST 程序：' + change['path']}
    if kind == 'interface':
        definition = validate_interface(change['definition'])
        if project.get('interfacePath'):
            definition=merge_interface(read_json(project['interfacePath']),definition)
            # Retain the exact native screen, permissions and external references.
            # Incompatible tag/action changes fail instead of rebuilding a user's HMI.
            write_json(project['interfacePath'], definition)
            if project.get('hmi'): validate_interface_fuxa(project['hmi'], project['interfacePath'])
        else:
            configure_interface_project(project['manifestPath'], definition)
        return {'tool': 'fuxa', 'summary': '配置工程变量与操作；现有画面保留，首次配置生成原生 HMI'}
    if kind.startswith('hmi-'):
        if not project.get('hmi'): reject('当前工程尚无 HMI；请先声明接口。', 'not_ready')
        payload = read_json(project['hmi'])
        matches = [v for v in payload.get('hmi', {}).get('views', []) if v.get('id') == change['viewId']]
        if len(matches) != 1: reject('HMI 画面身份不唯一或不存在。')
        view = matches[0]
        if kind == 'hmi-view-name': view['name'] = change['name'].strip()
        elif kind == 'hmi-static-text': replace_static_text(view, change['elementId'], change['text'])
        else: append_value(project, payload, change['viewId'], change['signalId'])
        write_json(project['hmi'], payload)
        validate_interface_fuxa(project['hmi'], project['interfacePath'])
        return {'tool': 'fuxa', 'summary': {'hmi-view-name': '修改画面名称', 'hmi-static-text': '修改画面文字',
                                          'hmi-readonly-value': '添加只读显示'}[kind] + '：' + change['viewId']}
    targets = [p for p in oip_targets(project) if p['id'] == change['partId']]
    if len(targets) != 1 or kind not in targets[0]['operations']:
        reject('该 OIP 对象不支持此项修改。', 'not_ready')
    scene = validate_oip(project['scene'], editing=True)
    part = next(p for p in scene['scene']['parts'] if p['id'] == change['partId'])
    if kind == 'oip-part-name': part['name'] = change['name'].strip()
    else: part['params']['speed'] = change['value']
    write_json(scene['root'] / scene['project']['scene'], scene['scene'])
    return {'tool': 'oip', 'summary': '修改场景部件：' + change['partId']}


def _verify_plan_effects(base, candidate, plan, native_receipts=None):
    """Replay supported data edits in memory and fence every other source file.

    Creating an interface may allocate a fresh resource directory. Its native
    HMI has already passed read_user_project's existing FUXA validator; its
    manifest, declaration and additional paths are still checked here. An
    existing screen is compared against an exact in-memory replay instead.
    """
    base_root=Path(base['projectRoot']);candidate_root=Path(candidate['projectRoot'])
    before=_snapshot(base);after=_snapshot(candidate)
    base_manifest=read_json(base['manifestPath']);actual_manifest=read_json(candidate['manifestPath'])
    manifest_path=Path(base['manifestPath']).relative_to(base_root).as_posix()
    if Path(candidate['manifestPath']).relative_to(candidate_root).as_posix()!=manifest_path:
        reject('候选清单位置已变化。','conflict')
    sources={item['path']:item for item in editable_sources(base)}
    allowed=set();expected_json={};expected_bytes={};components=[]
    current=copy.deepcopy(base)
    hmi_path=Path(base['hmi']).relative_to(base_root).as_posix() if base.get('hmi') else None
    hmi=read_json(base['hmi']) if hmi_path else None
    scene=validate_oip(base['scene'], editing=True) if base.get('scene') else None
    scene_path=(scene['root']/scene['project']['scene']).relative_to(base_root).as_posix() if scene else None
    scene_data=copy.deepcopy(scene['scene']) if scene else None
    parts={item['id']:item for item in oip_targets(base)}
    expected_manifest=copy.deepcopy(base_manifest)
    receipts = native_receipts or {}
    expected_receipts = {'oip'} if any(item['kind'] in ('oip-tools', 'oip-create-scene') for item in plan['changes']) else set()
    if not isinstance(receipts, dict) or set(receipts) != expected_receipts:
        reject('原生场景工具回执缺失或含额外内容。', 'conflict')
    for item in plan['changes']:
        kind=item['kind']
        if kind in ('oip-tools', 'oip-create-scene'):
            from workbench_oip_tools import verify_receipt
            creation = kind == 'oip-create-scene'
            result = verify_receipt(base, candidate, item['calls'], receipts['oip'],
                                    **({'creation_name': item['name']} if creation else {}))
            if creation:
                entry = result['scenePath']
                if (base.get('scene') or not isinstance(entry, str)
                        or not re.fullmatch(r'integration/[0-9a-f]{32}/simulation/oip/project\.json', entry)):
                    reject('首次场景创建的资源归属无效。', 'conflict')
                expected_manifest['simulation'] = {'provider': 'oip', 'project': entry}
                scene_root = Path(entry).parent
                allowed.add(manifest_path)
            else:
                scene_root = Path(base['scene']).parent.relative_to(base_root)
            for path, digest in result['files'].items():
                relative = Path(path)
                if relative.is_absolute() or '..' in relative.parts or not relative.is_relative_to(scene_root):
                    reject('OIP 回执试图修改场景目录外资源。', 'conflict')
                if after['files'].get(path) != digest or path not in set(before['files']) | set(after['files']):
                    reject('OIP 文件与原生执行回执不一致。', 'conflict')
                allowed.add(path)
            components.append(result['component'])
        elif kind=='openplc-tools':
            from workbench_openplc_tools import replay_tools, component
            # This invokes the same OpenPLC executor and native serializer as
            # generation, without writing the source or candidate. New/deleted
            # POU files are verified along with project metadata.
            replay=replay_tools(base,item['calls'])
            for path,content in replay.items():
                expected_bytes[path]=content;allowed.add(path)
            components.append(component(item['calls']))
        elif kind=='plc-source':
            old=sources.get(item['path'])
            if old is None or old['sha256']!=item['expectedHash']:
                reject('计划 PLC 目标或原文件摘要不属于本轮来源。','conflict')
            validate_st(old['content'],item['content'])
            expected_bytes[item['path']]=item['content'].encode('utf-8');allowed.add(item['path'])
            components.append({'tool':'openplc','summary':'更新 ST 程序：'+item['path']})
        elif kind=='interface':
            definition=validate_interface(item['definition'])
            if base.get('interfacePath'):
                definition=merge_interface(base['interfaceDefinition'],definition)
                path=Path(base['interfacePath']).relative_to(base_root).as_posix()
                if not candidate.get('interfacePath') or Path(candidate['interfacePath']).relative_to(candidate_root).as_posix()!=path:
                    reject('修改已有接口不能迁移其资源或重新生成画面。','conflict')
            else:
                if base_manifest.get('schemaVersion')!=1 or (base_manifest.get('simulation') not in (
                        {'provider':'none','project':None}, {'provider':'oip','project':None})
                        and not (base.get('scene') and base_manifest.get('simulation', {}).get('provider')=='oip')):
                    reject('首次接口配置仅支持本机 PLC 或已关联 OIP 的工程。','conflict')
                revision=actual_manifest.get('configurationRevision')
                if not isinstance(revision,str) or not re.fullmatch('[0-9a-f]{16}',revision):
                    reject('首次接口配置缺少受控资源版本。','conflict')
                path='integration/'+revision+'/interface.json';new_hmi='integration/'+revision+'/hmi/main.fuxap'
                if path in before['files'] or new_hmi in before['files']:
                    reject('首次接口资源不能覆盖已有文件。','conflict')
                expected_manifest.update(schemaVersion=3,configurationRevision=revision,
                    interface={'provider':'project-interface-v1','path':path},hmi={'provider':'fuxa','project':new_hmi})
                if expected_manifest['simulation'].get('project') is None:
                    # The interface converter normalizes an unbound tool intent;
                    # a scene created earlier in this same plan remains attached.
                    expected_manifest['simulation'] = {'provider':'none','project':None}
                allowed.update((manifest_path,new_hmi))
                # A later turn can edit the newly inspected HMI. It was not an
                # offered target in this source, so this plan cannot guess IDs.
                if any(change['kind'].startswith('hmi-') for change in plan['changes']):
                    reject('首次配置后请重新读取画面，再提交具体控件修改。','conflict')
            current['interfaceDefinition']=definition
            expected_json[path]=definition;allowed.add(path)
            components.append({'tool':'fuxa','summary':'配置工程变量与操作；现有画面保留，首次配置生成原生 HMI'})
        elif kind.startswith('hmi-'):
            if not hmi_path:reject('本轮来源没有可修改的 HMI。','conflict')
            views=[view for view in hmi.get('hmi',{}).get('views',[]) if view.get('id')==item['viewId']]
            if len(views)!=1:reject('本轮画面身份不唯一。','conflict')
            if kind=='hmi-view-name':views[0]['name']=item['name'].strip()
            elif kind=='hmi-static-text':replace_static_text(views[0],item['elementId'],item['text'])
            else:append_value(current,hmi,item['viewId'],item['signalId'])
            expected_json[hmi_path]=hmi;allowed.add(hmi_path)
            components.append({'tool':'fuxa','summary':{'hmi-view-name':'修改画面名称',
                'hmi-static-text':'修改画面文字','hmi-readonly-value':'添加只读显示'}[kind]+'：'+item['viewId']})
        else:
            target=parts.get(item['partId'])
            if target is None or kind not in target['operations']:
                reject('本轮来源不允许此场景部件修改。','conflict')
            part=next(part for part in scene_data['parts'] if part['id']==item['partId'])
            if kind=='oip-part-name':part['name']=item['name'].strip()
            else:part['params']['speed']=item['value']
            expected_json[scene_path]=scene_data;allowed.add(scene_path)
            components.append({'tool':'oip','summary':'修改场景部件：'+item['partId']})
    if actual_manifest!=expected_manifest:reject('候选清单含计划外变更。','conflict')
    for path in set(before['files'])|set(after['files']):
        if path not in allowed and before['files'].get(path)!=after['files'].get(path):
            reject('候选含计划外文件变更：'+path,'conflict')
    for path,content in expected_bytes.items():
        actual=candidate_root/path
        if (content is None and actual.exists()) or (content is not None and (not actual.is_file() or actual.read_bytes()!=content)):
            reject('PLC 内容与共享编辑工具执行结果不一致。','conflict')
    for path,value in expected_json.items():
        if read_json(candidate_root/path)!=value:reject('原生资源包含计划外内容或权限变化：'+path,'conflict')
    return components


def verify_candidate(source, payload, parent=None, plan=None):
    """Pure read publication check. Never acquire project/task locks here."""
    before = _snapshot(_manifest_project(source))
    if payload.get('projectId') != source['id'] or payload.get('baselineRevision') != before['projectRevision']:
        reject('候选源工程身份或保存版本已变化。', 'conflict')
    candidate = read_user_project(payload['candidateManifest']); after = _snapshot(candidate)
    if candidate['id'] != source['id'] or after['projectRevision'] != payload.get('candidateDigest'):
        reject('候选文件已变化。', 'conflict')
    accepted=validate_plan(payload.get('acceptedPlan'))
    if plan is not None and accepted != validate_plan(plan): reject('候选计划不一致。', 'conflict')
    if parent:
        if payload.get('parentCandidateDigest') != parent.get('candidateDigest'): reject('父候选版本不一致。', 'conflict')
        verify_candidate(source, parent)
    # Published parent metadata comes from the task ledger and is content
    # addressed. Its preceding tree is unnecessary here. New generation always
    # provides the actual immediate parent, so the current delta is replayed.
    if parent or not payload.get('parentCandidateDigest'):
        base=read_user_project(parent['candidateManifest']) if parent else _manifest_project(source)
        components=_verify_plan_effects(base,candidate,accepted,payload.get('nativeReceipts'))
        if (payload.get('components')!=components or payload.get('toolChanges')!=components
                or payload.get('summary')!={'before':'工程保存版本','after':'；'.join(c['summary'] for c in components)}):
            reject('候选展示摘要与本轮实际计划不一致。','conflict')
    differences = sorted(k for k in set(before['files']) | set(after['files']) if before['files'].get(k) != after['files'].get(k))
    changes = [{'path': k, 'beforeSha256': before['files'].get(k), 'afterSha256': after['files'].get(k)} for k in differences]
    if payload.get('changedFiles') != differences or payload.get('changes') != changes or payload.get('noChange') != (not differences):
        reject('候选累计差异不一致。', 'conflict')
    saved_context = payload.get('editingInput')
    legacy_context = (isinstance(saved_context, dict) and 'openplcTools' not in saved_context
                      and not any(change['kind'] == 'openplc-tools' for change in accepted['changes']))
    # A previously published candidate is content-addressed, including its
    # saved editing input. Upgrading the tool catalog must not invalidate that
    # receipt. Only the exact pre-shared-tools projection is accepted; arbitrary
    # omitted/added legacy fields and new-tool plans cannot use this branch.
    oip_native = isinstance(saved_context, dict) and 'oipTools' in saved_context
    oip_creation = isinstance(saved_context, dict) and 'oipCreation' in saved_context
    if any(change['kind'] in ('oip-tools', 'oip-create-scene') for change in accepted['changes']) and not oip_native:
        reject('原生 OIP 候选缺少工具上下文。', 'conflict')
    expected_context = ProjectEditAdapters().planning_input(candidate, shared=not legacy_context,
        oip_native=oip_native or oip_creation, oip_creation=oip_creation)
    if legacy_context and 'interfaceTemplate' not in saved_context and 'interfaceRules' not in saved_context:
        # The first saved project-edit artifacts predate the interface guidance
        # fields as well. Their actual interface declarations remain mandatory.
        expected_context.pop('interfaceTemplate')
        expected_context.pop('interfaceRules')
    if not legacy_context and isinstance(saved_context, dict):
        saved_tools = saved_context.get('openplcTools')
        catalog = saved_tools.get('tools') if isinstance(saved_tools, dict) else None
        if (not isinstance(catalog, list) or not 1 <= len(catalog) <= 128
                or any(not isinstance(tool, dict) or set(tool) != {'name', 'description', 'input_schema'}
                       or not isinstance(tool['name'], str) or not isinstance(tool['description'], str)
                       or not isinstance(tool['input_schema'], dict) for tool in catalog)):
            reject('候选共享工具目录格式无效。', 'conflict')
        # Tool descriptions/schemas are current engine guidance, not project
        # content. DSH replaces this saved catalog with the live trusted one
        # before a model turn. Keep the native project summary and all other
        # editing input fields exact; plans/files still undergo shared replay.
        expected_context['openplcTools']['tools'] = catalog
    if saved_context != expected_context:
        reject('候选可编辑上下文不一致。', 'conflict')
    return True


def interface_guidance(configuration):
    """An example declaration, explicitly distinct from actual project signals."""
    instances=(configuration or {}).get('resource',{}).get('instances',[])
    names=[item['name'] for item in instances if isinstance(item,dict) and isinstance(item.get('name'),str)
           and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',item['name'])]
    template=None
    if names:
        instance=names[0]
        template={'schemaVersion':1,'protocol':'project-interface-v1','title':'工程变量与操作',
            'description':'仅为格式示例；Example* 必须替换成 PLC 源码中真实声明的变量，不能直接提交。',
            'variables':[
                {'id':'exampleStart','label':'启动请求示例','path':instance+'.ExampleStart',
                 'type':'BOOL','access':'readwrite','aiVisible':True},
                {'id':'exampleSetpoint','label':'设定值示例','path':instance+'.ExampleSetpoint',
                 'type':'INT','access':'readwrite','aiVisible':True,'min':0,'max':100},
                {'id':'exampleValue','label':'只读显示示例','path':instance+'.ExampleValue',
                 'type':'INT','access':'read','aiVisible':True}],
            'operations':[
                {'id':'example_start','label':'启动示例','kind':'pulse','variable':'exampleStart',
                 'value':True,'durationMs':100,'enabled':True,'aiVisible':True},
                {'id':'example_set','label':'写入设定示例','kind':'write','variable':'exampleSetpoint',
                 'valueFrom':'input','enabled':True,'aiVisible':True}]}
    return {'interfaceTemplate':template,'interfaceRules':{
        'purpose':'interface 修改中的 definition 必须满足下列格式；示例不代表当前已有信号。只声明实际用户需求需要的变量和操作。',
        'required':['schemaVersion=1','protocol=project-interface-v1','variables[1..128]','operations[0..128]'],
        'variableRequired':['id','label','path','type','access','aiVisible'],
        'variableTypes':['BOOL','INT','REAL'],'variableAccess':['read','readwrite'],
        'instanceNames':names,'path':'使用真实实例名.变量名；仅支持完整 PLC 实例路径，编译时核对路径和类型。',
        'ranges':'BOOL 不接受范围；可写 INT/REAL 必须有 min/max，INT 范围 -32768..32767，REAL 必须为有限 float32。',
        'operationRequired':['id','label','kind','variable','enabled','aiVisible'],
        'operationTarget':'variable 引用 variables 的 id，只能引用 access=readwrite 的变量。',
        'pulse':'kind=pulse，只能 BOOL，value=true，durationMs 为 100..2000 整数，不含 valueFrom。',
        'write':'kind=write，value（符合变量类型和范围）与 valueFrom=input 二选一，不含 durationMs。',
        'permissions':'aiVisible、enabled 必须显式为布尔值；无需提交未提供的隐藏或禁用声明，服务端会原样保留。不可显式修改它们，也不可扩大已有只读权限。',
        'firstScreen':'首次声明生成原生 HMI；生成后重新读取目标，再提交画面文字或只读显示修改。'}}


class ProjectEditAdapters(AgentAdapters):
    def planning_input(self, project, *, shared=True, oip_native=True, oip_creation=True):
        project = _manifest_project(project)
        raw = read_json(project['manifestPath'])
        if raw.get('schemaVersion') not in (1, 3) or raw.get('target') != {'provider': 'openplc-runtime', 'mode': 'local'}:
            return None
        shared_tools = None
        if shared:
            from workbench_openplc_tools import inspect_tools
            shared_tools = inspect_tools(project)
        sources = editable_sources(project)
        hmi = read_json(project['hmi']) if project.get('hmi') else None
        views, texts = saved_target_catalog(hmi) if hmi else ([], [])
        parts = oip_targets(project)
        native_oip = None; creation_oip = None
        if oip_native and project.get('scene'):
            from workbench_oip_tools import inspect_tools
            native_oip = inspect_tools(project)
        elif oip_native and oip_creation and raw.get('simulation') in (
                {'provider':'none', 'project':None}, {'provider':'oip', 'project':None}):
            from workbench_oip_tools import inspect_creation
            creation_oip = inspect_creation(project)
        configuration=read_json(project['plc']).get('data',{}).get('configuration')
        operations = (['openplc-tools'] if shared else []) + (['plc-source'] if sources else []) + ['interface']
        if hmi: operations += ['hmi-view-name', 'hmi-static-text', 'hmi-readonly-value']
        if parts: operations += ['oip-part-name']
        if any('oip-conveyor-speed' in p['operations'] for p in parts): operations += ['oip-conveyor-speed']
        if native_oip and native_oip.get('tools'): operations += ['oip-tools']
        if creation_oip: operations += ['oip-create-scene']
        return {'schemaVersion': 1, 'projectRevision': _snapshot(project)['projectRevision'], 'operations': operations,
                **({'openplcTools': shared_tools} if shared else {}),
                **({'oipTools': native_oip} if native_oip is not None else {}),
                **({'oipCreation': creation_oip} if creation_oip is not None else {}),
                'plcSources': sources, 'plcConfiguration': configuration, **interface_guidance(configuration),
                'interfaceDefinition': ai_context(read_json(project['interfacePath'])) if project.get('interfacePath') else None,
                'hmiTargets': {'views': views, 'staticTexts': texts, 'readonlyValues': value_targets(project) if hmi else []},
                'oipParts': parts,
                'planSchema': {'schemaVersion': 1, 'changes': {k: sorted(FIELDS[k]) for k in operations}},
                'limitations': ['只读取保存文件；编辑器未保存内容不包含在内。',
                    *(['PLC 修改优先使用 openplc-tools，共用 OpenPLC 的 POU、变量和受限原生 LD 编辑工具；实际工具及参数以 openplcTools.tools 为准。',
                       'plc-source 仅兼容旧整文件候选，不能与 openplc-tools 混用；不能加入宿主代码或物理 I/O 地址。'] if shared else
                      ['ST 可修改逻辑、变量及标准功能块调用；保留 POU 名称，不增加宿主代码或物理 I/O 地址。']),
                    '首次 interface 配置生成 HMI；已有 HMI 保持原布局，接口变化必须兼容既有控件与权限。',
                    '候选结构检查不是编译通过；保留修改后运行编译验证，确认 PLC 和接口一致。',
                    *(['当前工程还没有 OIP 场景。按本轮需求用 oip-create-scene 创建首个原生场景，name 为场景标题，calls 为 0–64 项原生编辑；可直接添加目录中的部件。无需切模型、分派团队、预先关联场景或配置 HMI／接口。创建后继续修改用 oip-tools。结果先作为候选，用户保留后进入当前工程；不会自动启动仿真或建立 PLC 通信。'] if creation_oip is not None else
                      ['OIP 修改使用 oip-tools，部件编辑、参数及信号地址以 oipTools 原生目录为准；检查结果不代表外部 PLC 通信或仿真已验证。'] if native_oip is not None else
                      ['OIP 仅修改已有部件名称或未绑定的输送带速度，不生成场景几何或新增通信连接。'])]}

    def generate_from_plan(self, project, *, task_id, request, expected_revision, plan, route, parent=None, **kwargs):
        plan = validate_plan(plan)
        if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', task_id): reject('任务身份无效。')
        if not isinstance(request, str) or not 1 <= len(request) <= 8000: reject('需要本次实际用户需求。')
        project = _manifest_project(project)
        root = Path(project['projectRoot']).resolve(); state = self.state_root.resolve()
        if root.is_relative_to(state) or state.is_relative_to(root): reject('候选目录不得与源工程互相包含。')
        with _candidate_project_lease(self.state_root, project['id']):
            before = _snapshot(project)
            if before['projectRevision'] != expected_revision: reject('工程保存版本已变化。', 'conflict')
            if self.planning_input(project) is None: reject('统一修改支持本机 ST／工程声明项目。', 'not_ready')
            base = project
            if parent:
                verify_candidate(project, parent)
                base = read_user_project(parent['candidateManifest'])
            baseline = _snapshot(base); base_root, files = _files(base)
            folder = self.state_root / task_id; plain(folder, self.state_root); folder.mkdir(exist_ok=True)
            destination = folder / ('candidate-' + uuid.uuid4().hex); destination.mkdir()
            candidate_root = destination / 'project'; candidate_root.mkdir()
            for path in files:
                relative = path.relative_to(base_root); target = candidate_root / relative
                target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, target)
                if _file_hash(target) != baseline['files'][relative.as_posix()]: reject('复制期间源文件已变化。', 'conflict')
            manifest = candidate_root / Path(base['manifestPath']).relative_to(base_root)
            candidate = read_user_project(manifest)
            if _snapshot(candidate) != baseline: reject('候选副本未匹配来源。', 'conflict')
            components = []; native_receipts = {}
            try:
                for change in plan['changes']:
                    components.append(apply_change(candidate, change, native_receipts))
                    candidate = read_user_project(manifest)
            except (ValueError, OSError, KeyError, TypeError) as exc:
                if isinstance(exc, AdapterError): raise
                reject(str(exc)[:600])
            after = _snapshot(candidate)
            if _snapshot(project) != before or _snapshot(base) != baseline: reject('生成期间源文件已变化。', 'conflict')
            differences = sorted(k for k in set(before['files']) | set(after['files']) if before['files'].get(k) != after['files'].get(k))
            result = {'status': 'ok', 'projectId': project['id'], 'taskId': task_id,
                      'source': 'saved-files-only', 'sourceBasis': 'saved_revision',
                      'generation': 'host-planned-project-edit', 'unsavedEditsIncluded': False,
                      'tool': 'joint', 'scope': 'project-edit', 'operation': 'project-edit',
                      'baselineRevision': expected_revision, 'candidateDigest': after['projectRevision'],
                      'candidateManifest': str(manifest), 'nativeArtifact': str(manifest),
                      'changedFiles': differences, 'changes': [{'path': k, 'beforeSha256': before['files'].get(k),
                         'afterSha256': after['files'].get(k)} for k in differences],
                      'components': components, 'toolChanges': components, 'acceptedPlan': plan,
                      **({'nativeReceipts': native_receipts} if native_receipts else {}),
                      'revisionSupported': bool(differences), 'noChange': not differences,
                      'parentCandidateDigest': parent.get('candidateDigest') if parent else None,
                      'editingInput': self.planning_input(candidate),
                      'summary': {'before': '工程保存版本', 'after': '；'.join(c['summary'] for c in components)},
                      'validation': 'native-structure-only', 'checks': ['保存版本及文件摘要一致', '原生工程结构检查'],
                      'authoritativeSourceModified': False, 'modelCalled': False, 'applySupported': False,
                      'selectedRoute': route}
            write_json(destination / 'candidate.json', result)
            verify_candidate(project, result, parent=parent, plan=plan)
            return result
