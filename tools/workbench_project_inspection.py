"""Saved-file provenance and readback for the DSH project view.

This module never saves an editor, changes an engineering file, compiles, or
contacts a Runtime. Its only writes are versioned inspection receipts. A layout
receipt records a human review; it is not a test or a claim of runtime validity.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from factoryio_runtime import ROOT, store
from plcdev_runtime_owner import FileLease
from workbench_agent_adapters import _manifest_project, _snapshot, _digest
from workbench_project_config import plain, read_json

HASH = re.compile(r'^[0-9a-f]{64}$')
PROJECT = re.compile(r'^user-[0-9a-f]{32}$')
STATE_ROOT = ROOT / 'outputs/workbench/project-inspections'
EDITOR_MESSAGE = '仅回读已经保存到工程文件的内容；原生编辑器中的未保存修改仍由原生工具处理。'


class InspectionError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _relative(project, path):
    return Path(path).relative_to(Path(project['projectRoot'])).as_posix()


def _label(value, fallback):
    return value[:160] if isinstance(value, str) and value.strip() else fallback


def _hmi_semantics(value):
    """Ignore only positioning attributes on SVG visual nodes, conservatively.

    Node identities/order, scripts, bindings, device/security settings, styles,
    text and all JSON fields remain in the digest. Unknown native layout fields
    therefore remain content changes, instead of accidentally hiding behavior.
    """
    value = copy.deepcopy(value)
    for view in value.get('hmi', {}).get('views', []):
        raw = view.get('svgcontent')
        if not isinstance(raw, str) or '<!DOCTYPE' in raw.upper() or '<!ENTITY' in raw.upper():
            return None
        try:
            svg = ET.fromstring(raw)
        except ET.ParseError:
            return None
        for node in svg.iter():
            tag = node.tag.rsplit('}', 1)[-1]
            # Do not ignore root viewport/size, link targets, paths or animation.
            if node is not svg and tag in {'g', 'text', 'rect', 'circle', 'ellipse', 'line', 'image', 'foreignObject'}:
                for key in ('x', 'y', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'transform'):
                    node.attrib.pop(key, None)
            node.attrib = dict(sorted(node.attrib.items()))
        view['svgcontent'] = ET.tostring(svg, encoding='unicode')
    return _digest(value)


def _relations(project, hmi):
    plc_path = _relative(project, project['plc'])
    definition = project.get('interfaceDefinition')
    tag_signals = {}
    if definition:
        variables = definition['variables']
        tag_signals = {'plcdev_var_' + item['id']: item['id'] for item in variables}
    else:
        bindings = (project.get('configuration') or {}).get('bindings', {})
        variables = [dict(id=key, label=key, path=item['path'], type=item['type'], access='read',
                          location=item.get('location')) for key, item in bindings.get('plc', {}).items()]
        # These aliases are implemented by the batch mailbox adapter. A phase,
        # quality or draft tag is deliberately not guessed to be a PLC variable.
        for name in ('count', 'target'):
            if name in bindings.get('plc', {}):
                tag_signals['plcdev_' + name] = name
                tag_signals['plcdev_' + name + 'Display'] = name
    rows = {item['id']: {key: item[key] for key in ('id', 'label', 'path', 'type', 'access', 'aiVisible', 'location') if item.get(key) is not None}
            for item in variables}
    for row in rows.values():
        row.update(source={'kind': 'plc', 'path': plc_path}, hmi=[], scene=[], status='declared')
    for view in (hmi or {}).get('hmi', {}).get('views', []):
        if not isinstance(view.get('id'), str):
            continue
        for ident, item in view.get('items', {}).items():
            prop = item.get('property') or {}
            tags = {value for value in (prop.get('variableId'), prop.get('variableId2')) if isinstance(value, str) and value}
            for tag in tags:
                signal = rows.get(tag_signals.get(tag))
                if signal is not None:
                    signal['hmi'].append({'viewId': view['id'], 'viewName': _label(view.get('name'), view['id']),
                                          'elementId': ident, 'label': _label(item.get('name'), _label(item.get('label'), ident)),
                                          'tagId': tag})
    model = project.get('modelDefinition') or {}
    for item in model.get('signals', []):
        for signal in rows.values():
            if signal['path'] == item['path'] and signal['type'] == item['type']:
                signal['scene'].append({'id': item['id'], 'label': item['id'], 'direction': item['direction'],
                                         'path': _relative(project, project['modelBindingsPath'])})
    bindings = (project.get('configuration') or {}).get('bindings', {})
    for name in ('entryConveyor', 'conveyor'):
        if name in rows and name in bindings.get('oip', {}).get('outputs', {}):
            rows[name]['scene'].append({'id': name, 'label': name, 'direction': 'plc-to-model',
                                        'path': _relative(project, project['bindingsPath'])})
    if 'sensorClear' in rows and 'sensorOccupied' in bindings.get('oip', {}).get('inputs', {}):
        rows['sensorClear']['scene'].append({'id': 'sensorOccupied', 'label': 'sensorOccupied（按批次适配器取反）',
                                             'direction': 'model-to-plc', 'path': _relative(project, project['bindingsPath'])})
    return list(rows.values())


def _observe(project):
    project = _manifest_project(project)
    before = _snapshot(project)
    hmi = read_json(Path(project['hmi'])) if project.get('hmi') else None
    signals = _relations(project, hmi)
    hmi_path = _relative(project, project['hmi']) if hmi else None
    plc_prefix = _relative(project, Path(project['plc']).parent) + '/'
    scene_prefix = _relative(project, Path(project['scene']).parent) + '/' if project.get('scene') else None
    bindings = {_relative(project, project[key]) for key in ('bindingsPath', 'interfacePath', 'modelBindingsPath') if project.get(key)}
    resources = []
    for path, digest in before['files'].items():
        kind = ('hmi' if path == hmi_path else 'binding' if path in bindings else 'plc' if path.startswith(plc_prefix)
                else 'scene' if scene_prefix and path.startswith(scene_prefix) else 'configuration')
        resources.append({'id': path, 'kind': kind, 'label': Path(path).name, 'path': path, 'sha256': digest})
    fingerprint = {**before, 'hmiPath': hmi_path, 'hmiSemantics': _hmi_semantics(hmi) if hmi else None,
                   'kinds': {item['path']: item['kind'] for item in resources}}
    if _snapshot(_manifest_project(project)) != before:
        raise InspectionError('source_changed', '读取期间工程文件已变化，请保存完成后重新读取。')
    return project, fingerprint, resources, signals


def _changes(baseline, current):
    if baseline is None:
        return []
    result = []
    for path in sorted(set(baseline['files']) | set(current['files'])):
        if baseline['files'].get(path) == current['files'].get(path):
            continue
        kind = 'added' if path not in baseline['files'] else 'removed' if path not in current['files'] else 'changed'
        scope = current['kinds'].get(path, baseline['kinds'].get(path, 'unknown'))
        if scope == 'hmi':
            same_semantics = current['hmiSemantics'] and current['hmiSemantics'] == baseline.get('hmiSemantics')
            scope = 'hmi-layout' if kind == 'changed' and same_semantics and path == baseline.get('hmiPath') else 'hmi-content'
        result.append({'path': path, 'kind': kind, 'scope': scope})
    return result


def _validate_fingerprint(value, project_id):
    if not isinstance(value, dict) or value.get('projectId') != project_id or not HASH.fullmatch(str(value.get('projectRevision', ''))):
        raise ValueError('identity')
    if (not isinstance(value.get('files'), dict) or not isinstance(value.get('kinds'), dict)
            or len(value['files']) > 10000 or set(value['files']) != set(value['kinds'])):
        raise ValueError('files')
    for path, digest in value['files'].items():
        if (not isinstance(path, str) or not path or '\\' in path or ':' in path or path.startswith('/')
                or '..' in path.split('/') or not HASH.fullmatch(str(digest))):
            raise ValueError('path')
    if _digest({'projectId': project_id, 'files': value['files']}) != value['projectRevision']:
        raise ValueError('revision')
    if value.get('hmiSemantics') is not None and not HASH.fullmatch(str(value['hmiSemantics'])):
        raise ValueError('semantics')


class ProjectInspection:
    def __init__(self, state_root=None):
        self.state_root = Path(state_root or STATE_ROOT).resolve()

    def _paths(self, project):
        project_id = project.get('id')
        if not isinstance(project_id, str) or not PROJECT.fullmatch(project_id):
            raise InspectionError('invalid_project', '请选择已登记的用户工程。')
        root = Path(project['projectRoot']).resolve()
        if self.state_root.is_relative_to(root) or root.is_relative_to(self.state_root):
            raise InspectionError('invalid_state', '读取记录目录不能与工程目录互相包含。')
        file = self.state_root / (project_id + '.json')
        for item in (self.state_root, file, file.with_suffix('.lock')):
            if item.exists() or item.is_symlink():
                plain(item, self.state_root.parent)
        return file

    def _load(self, file, project):
        try:
            file.stat()
        except FileNotFoundError:
            return None
        try:
            value = read_json(file, limit=4 * 1024 * 1024)
            if (value.get('schemaVersion') != 1 or value.get('projectId') != project['id']
                    or value.get('manifestPath') != str(Path(project['manifestPath']).resolve())):
                raise ValueError('identity')
            for key in ('baseline', 'captured'):
                _validate_fingerprint(value[key], project['id'])
            if value.get('lastReview') is not None:
                review = value['lastReview']
                if (not isinstance(review, dict) or review.get('type') != 'layout'
                        or not HASH.fullmatch(str(review.get('fromRevision', '')))
                        or review.get('toRevision') != value.get('acknowledgedRevision')
                        or not HASH.fullmatch(str(review.get('toRevision', '')))
                        or not isinstance(review.get('changes'), list)):
                    raise ValueError('review')
            return value
        except (ValueError, KeyError, TypeError):
            raise InspectionError('record_unreadable', '工程读取记录无法核对，原记录已保留。') from None

    @staticmethod
    def _response(project, current, resources, signals, record, block_reason=None):
        baseline = record['baseline'] if record else None
        changes = _changes(baseline, current)
        layout_only = bool(changes) and all(item['scope'] == 'hmi-layout' for item in changes)
        captured = record['captured']['projectRevision'] if record else None
        return {'ok': True, 'schemaVersion': 1, 'projectId': project['id'], 'projectRevision': current['projectRevision'],
                'source': 'saved-files-only', 'editorState': {'state': 'unknown', 'message': EDITOR_MESSAGE},
                'resources': resources, 'signals': signals,
                'readback': {'state': 'untracked' if not baseline else 'changed' if changes else 'current',
                             'baselineRevision': baseline['projectRevision'] if baseline else None,
                             'observedRevision': current['projectRevision'], 'capturedRevision': captured,
                             'changes': changes, 'layoutOnly': layout_only,
                             'acknowledgedRevision': record.get('acknowledgedRevision') if record else None,
                             'lastReview': record.get('lastReview') if record else None},
                'capabilities': {'canCapture': not block_reason,
                                 'canAcknowledgeLayout': not block_reason and layout_only and captured == current['projectRevision'],
                                 'blockedReason': block_reason},
                'limitations': [EDITOR_MESSAGE, '信号关系来自工程声明和已保存的绑定；不推断程序内部依赖，不代表编译或运行验证。',
                                '布局确认只记录人工审阅；PLC、绑定、脚本和未知格式变化不能以布局确认通过。']}

    def inspect(self, project, body=None, *, block_reason=None):
        file = self._paths(project)
        if body is None:
            actual, current, resources, signals = _observe(project)
            return self._response(actual, current, resources, signals, self._load(file, actual), block_reason)
        if (not isinstance(body, dict) or set(body) != {'projectId', 'action', 'expectedRevision', 'expectedBaseline'}
                or body['projectId'] != project['id'] or body['action'] not in ('capture', 'acknowledge')
                or not HASH.fullmatch(str(body['expectedRevision']))
                or (body['expectedBaseline'] is not None and not HASH.fullmatch(str(body['expectedBaseline'])))):
            raise InspectionError('invalid_request', '读取记录请求或版本无效。')
        if block_reason:
            raise InspectionError('inspection_blocked', block_reason)
        self.state_root.mkdir(parents=True, exist_ok=True)
        try:
            with FileLease(file.with_suffix('.lock'), timeout=2):
                actual, current, resources, signals = _observe(project)
                record = self._load(file, actual)
                baseline_revision = record['baseline']['projectRevision'] if record else None
                if current['projectRevision'] != body['expectedRevision'] or baseline_revision != body['expectedBaseline']:
                    raise InspectionError('revision_changed', '工程或读取基线已变化，请刷新后重新核对。')
                if body['action'] == 'capture':
                    record = {**(record or {}), 'schemaVersion': 1, 'projectId': actual['id'],
                              'manifestPath': str(Path(actual['manifestPath']).resolve()),
                              'baseline': record['baseline'] if record else current, 'captured': current}
                else:
                    response = self._response(actual, current, resources, signals, record)
                    if not response['capabilities']['canAcknowledgeLayout']:
                        raise InspectionError('not_layout_only', '请先读取变化；只有已读取且仅涉及画面位置的变化可以确认布局。')
                    record = {**record, 'baseline': current, 'captured': current,
                              'acknowledgedRevision': current['projectRevision'],
                              'lastReview': {'fromRevision': baseline_revision, 'toRevision': current['projectRevision'],
                                             'changes': response['readback']['changes'], 'type': 'layout',
                                             'confirmedAt': datetime.now(timezone.utc).isoformat()}}
                if _snapshot(_manifest_project(actual))['projectRevision'] != current['projectRevision']:
                    raise InspectionError('source_changed', '记录前工程文件已变化，未确认此版本。')
                store(file, record)
                return self._response(actual, current, resources, signals, record)
        except RuntimeError:
            raise InspectionError('inspection_busy', '另一个窗口正在记录此工程，请稍后刷新。') from None


def project_inspection(workspace, project_id, body=None):
    """Controller entry; reuse project identity and unresolved FUXA protection."""
    from workbench_fuxa_recovery import recovery_status
    target = workspace.resolve(project_id)
    project = getattr(target, 'project', None)
    if not isinstance(project, dict) or project.get('id') != project_id:
        raise InspectionError('invalid_project', '工程归属无法确认。')
    recovery = recovery_status(workspace, project_id)
    blocked = (recovery.get('message') if recovery['state'] not in ('none',) and recovery.get('reasonCode') != 'not_supported' else None)
    with workspace.lock:
        if project_id in workspace.configuring:
            blocked = '工程配置正在更新，请完成后重新读取。'
        return ProjectInspection().inspect(project, body, block_reason=blocked)
