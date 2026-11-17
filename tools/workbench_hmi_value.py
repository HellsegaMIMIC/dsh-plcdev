"""Append a bounded read-only display, retaining the existing tag's access context.

Only already displayed numeric project signals are offered. No device, tag,
PLC, script or existing control is rewritten; candidates use saved files.
"""
from copy import deepcopy
import hashlib
import re
from xml.sax.saxutils import escape, quoteattr

from workbench_agent_adapters import AdapterError
from workbench_hmi_svg import _tree, secure_svg
from workbench_project_config import read_json

WORKFLOW = 'hmi-readonly-value-v1'
_REQUEST = re.compile(r'\s*在画面 ID“([^“”\r\n]+)”添加信号 ID“([^“”\r\n]+)”的只读数值显示[。.!！]?\s*')


def validate_value_intent(request, plan, targets=None):
    match = _REQUEST.fullmatch(request) if isinstance(request, str) and len(request) <= 4000 else None
    if (not isinstance(plan, dict) or set(plan) != {'viewId', 'signalId'} or not match
            or any(not isinstance(v, str) or not 1 <= len(v) <= 120 or any(ord(c) < 32 for c in v) for v in plan.values())
            or (plan['viewId'], plan['signalId']) != match.groups()):
        raise ValueError('请明确指定画面和信号：在画面 ID“画面ID”添加信号 ID“信号ID”的只读数值显示。')
    if targets is not None and len([t for t in targets if t['viewId'] == plan['viewId'] and t['signalId'] == plan['signalId']]) != 1:
        raise ValueError('当前保存版本没有唯一可保全权限的只读数值显示目标。')


def _signals(project):
    definition = project.get('interfaceDefinition')
    if definition:
        return [dict(v, tag='plcdev_var_' + v['id']) for v in definition['variables']
                if v.get('aiVisible') is True and v.get('access') == 'read' and v.get('type') in ('INT', 'REAL')]
    roles = project.get('configuration', {}).get('bindings', {}).get('plc', {})
    return [dict(v, id=k, label={'count':'当前计数','target':'目标计数'}.get(k, k), tag='plcdev_' + tag)
            for k, tag in [('count','countDisplay'), ('target','targetDisplay')]
            if isinstance((v := roles.get(k)), dict) and v.get('path') and v.get('type') in ('INT','DINT','UINT','UDINT','REAL')]


def _id(view_id, signal_id):
    return 'VAL_PLCD_read_' + hashlib.sha256((view_id + '\0' + signal_id).encode()).hexdigest()[:16]


def value_targets(project, payload=None):
    if not project.get('hmi'): return []
    payload = read_json(project['hmi']) if payload is None else payload
    result = []
    for view in payload.get('hmi', {}).get('views', []):
        try:
            secure_svg(view)
            _, nodes, _ = _tree(view['svgcontent'])
            height = int(nodes[0]['attrs']['height']); width = int(nodes[0]['attrs']['width'])
            if not 100 <= height <= 3900 or not 260 <= width <= 4096: continue
            if view.get('profile', {}).get('height') != height: continue
        except (AdapterError, KeyError, TypeError, ValueError): continue
        for signal in _signals(project):
            ident = _id(view['id'], signal['id'])
            if ident in view['items']: continue
            matches = [item for item in view['items'].values() if item.get('type') == 'svg-ext-value'
                       and item.get('property', {}).get('variableId') == signal['tag']]
            if len(matches) != 1: continue
            item = matches[0]; prop = item['property']
            device = payload.get('devices', {}).get(prop.get('variableSrc'), {})
            tag = device.get('tags', {}).get(signal['tag'], {})
            variable = view.get('variables', {}).get(signal['tag'], {})
            if (prop.get('events') or prop.get('actions') or prop.get('ranges') or tag.get('access') != 'read'
                    or variable.get('id') != signal['tag'] or variable.get('source') != device.get('id')): continue
            # Preserve an existing display's permissions verbatim; do not invent a public one.
            result.append({'viewId':view['id'], 'viewName':view.get('name', view['id']),
                           'signalId':signal['id'], 'label':signal['label'], 'path':signal['path'], 'type':signal['type']})
    return result


def append_value(project, payload, view_id, signal_id):
    targets = [t for t in value_targets(project, payload) if t['viewId'] == view_id and t['signalId'] == signal_id]
    if len(targets) != 1: raise AdapterError('not_ready', '无法确认只读数值显示的来源、权限或画布空间。')
    target = targets[0]; signal = next(s for s in _signals(project) if s['id'] == signal_id)
    view = next(v for v in payload['hmi']['views'] if v['id'] == view_id)
    template = next(i for i in view['items'].values() if i.get('type') == 'svg-ext-value' and i['property'].get('variableId') == signal['tag'])
    data, nodes, ids = _tree(view['svgcontent']); root = nodes[0]; canvas = root['children'][0]
    height = int(root['attrs']['height']); ident = _id(view_id, signal_id)
    paint = {k:v for k,v in ids[template['id']]['attrs'].items() if k not in ('id','type')}
    paint.setdefault('fill', '#1f2937'); paint.setdefault('font-size','28')
    attrs = ' '.join(f'{k}={quoteattr(v)}' for k,v in paint.items())
    label = escape(target['label'])
    # FUXA's native value processor only updates groups with one child. A
    # standalone caption is safe only for an explicitly public display.
    prop = template['property']
    public = prop.get('permission') == 0 and prop.get('permissionRoles', {}).get('show') == [] and template.get('hide') is False
    caption = (f'<text id="PLCD_readcaption_{ident[-16:]}" x="24" y="{height+28}" fill="{paint["fill"]}" font-size="13">{label}</text>' if public else '')
    addition = (caption + f'<g id="{ident}" type="svg-ext-value" {attrs}>'
                f'<text id="value_{ident}" x="24" y="{height+64}">—</text></g>')
    updated = (data[:canvas['closeStart']] + addition.encode('utf-8') + data[canvas['closeStart']:]).decode('utf-8')
    opening = updated[:root['openEnd']]
    opening, count = re.subn(r'\bheight="' + str(height) + '"', 'height="' + str(height+96) + '"', opening)
    if count != 1: raise AdapterError('not_ready', '画布高度无法安全更新。')
    view['svgcontent'] = opening + updated[root['openEnd']:]
    view['profile']['height'] = height + 96
    item = deepcopy(template); item.update(id=ident, name=target['label'])
    view['items'][ident] = item
    secure_svg(view)
    # Keep every existing node's parent/order. Whole-page canonicalization
    # would move legacy captions into value groups, stopping native updates.
    view['svgcontent'] = ''.join(c if ord(c) < 128 else '&#' + str(ord(c)) + ';' for c in view['svgcontent'])
    final, _, final_ids = _tree(view['svgcontent'])
    group = final_ids[ident]
    if (len(group['children']) != 1 or final.find(ident.encode()) != group['idStart']
            or final.lower().find(b'<foreignobject', group['idStart']) != -1):
        raise AdapterError('not_ready', '新增数值控件的原生更新或权限目标无法确认。')
    return target['label']
