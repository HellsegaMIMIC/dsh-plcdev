"""Preserve FUXA authorization when regenerating an existing bounded batch page.

Never interpret absent/null/zero/empty permission values as defaults: FUXA's
server, script manager and client have different forceUndefined rules. Exact
contexts are transported through a bijection of unchanged native interactions.
This is not a replacement authorization evaluator or a permission editor.
"""
from copy import deepcopy
import json
import math
import re

from workbench_agent_adapters import AdapterError, _digest
from workbench_hmi_svg import secure_svg, html_locks


ACCESS = ('permission', 'permissionRoles')
TYPES = ('svg-ext-value', 'svg-ext-html_input', 'svg-ext-html_button')


def fail(message):
    raise AdapterError('not_ready', '无法保留原生 HMI 权限：' + message)


def access(context):
    if not isinstance(context, dict):
        fail('权限上下文不是对象。')
    result = {k: deepcopy(context[k]) for k in ACCESS if k in context}
    mask = result.get('permission')
    if mask is not None and (type(mask) is not int or not -1 <= mask <= 65535):
        fail('位掩码格式不受支持。')
    roles = result.get('permissionRoles')
    if roles is not None:
        if not isinstance(roles, dict) or set(roles) - {'show', 'enabled'}:
            fail('角色权限格式不受支持。')
        for values in roles.values():
            if values is not None and (not isinstance(values, list) or len(values) > 128
                    or any(not isinstance(v, str) or not v or len(v) > 160 or any(ord(c) < 32 for c in v) for v in values)
                    or len(set(values)) != len(values)):
                fail('角色列表格式不受支持。')
    return result


def _replace_access(target, source):
    for key in ACCESS:
        target.pop(key, None)
    target.update(access(source))


def _signature(view_id, item):
    if item.get('type') not in TYPES or not isinstance(item.get('property'), dict):
        fail('控件类型不能可靠映射。')
    prop = item['property']
    if set(item) - {'id', 'type', 'label', 'name', 'property', 'hide', 'lock'} or set(prop) - {
            'variableId', 'variable', 'variableSrc', 'events', 'actions', 'ranges', 'permission', 'permissionRoles', 'text', 'options'}:
        fail('存在未纳入权限行为证明的控件属性。')
    if prop.get('actions') or prop.get('ranges'):
        fail('带动态动作／范围的控件不能自动映射。')
    interaction = {k: deepcopy(prop[k]) for k in ('variableId', 'variable', 'variableSrc', 'events', 'actions', 'ranges') if k in prop}
    return {'view': view_id, 'type': item['type'], 'interaction': interaction}


def _index(project):
    try:
        views = project['hmi']['views']
        scripts = project['scripts']
        layout = project['hmi']['layout']
    except (TypeError, KeyError):
        fail('缺少脚本、画面或布局。')
    if not isinstance(views, list) or len(views) != 1 or not isinstance(views[0].get('property'), dict):
        fail('本批只支持一个有明确原生身份的画面。')
    view = views[0]
    if not isinstance(view.get('id'), str) or not view['id'] or view['property'].get('events'):
        fail('画面身份或自动动作不受支持。')
    if not isinstance(layout, dict) or not isinstance(scripts, list):
        fail('脚本或布局无效。')
    by_script = {}
    allowed = {('hmi', 'views', 0), ('hmi', 'views', 0, 'property')}
    for i, script in enumerate(scripts):
        if not isinstance(script, dict) or not isinstance(script.get('id'), str) or script['id'] in by_script:
            fail('脚本身份重复或无效。')
        by_script[script['id']] = script
        allowed.add(('scripts', i))
    controls, ids = {}, {}
    for ident, item in view['items'].items():
        if ident != item.get('id') or ident in ids:
            fail('控件身份无效。')
        signature = _signature(view['id'], item)
        key = _digest(signature)
        if key in controls:
            fail('存在交互含义相同的多个控件，不能猜测权限归属。')
        controls[key] = {'item': item, 'signature': signature}
        ids[ident] = key
        allowed.add(('hmi', 'views', 0, 'items', ident, 'property'))
        for name in ('hide', 'lock'):
            if name in item and type(item[name]) is not bool:
                fail('控件显示／锁定标记无效。')
        options = item['property'].get('options', {})
        if not isinstance(options, dict) or 'readonly' in options and type(options['readonly']) is not bool:
            fail('输入只读标记无效。')
        if set(options) - {'updated', 'numeric', 'min', 'max', 'step', 'type', 'readonly'}:
            fail('存在不受支持的输入行为选项。')
    # Unknown permission locations must not disappear in the converter. Layout
    # is retained in its entirety, including nested navigation/header contexts.
    def walk(value, path=()):
        if isinstance(value, list):
            for i, child in enumerate(value):
                walk(child, (*path, i))
        elif isinstance(value, dict):
            if any(k in value for k in ACCESS):
                access(value)
                if path not in allowed and path[:2] != ('hmi', 'layout'):
                    fail('有未映射的权限位置：' + '/'.join(map(str, path)))
            for key, child in value.items():
                walk(child, (*path, key))
    walk(project)
    return view, by_script, controls, ids


def permission_contract(project):
    view, scripts, controls, _ = _index(project)
    _, targets = secure_svg(view)
    return {'scripts': {k: {'access': access(s), 'mode': s.get('mode'), 'code': s.get('code'),
                            'parameters': s.get('parameters')} for k, s in scripts.items()},
            'view': {'id': view['id'], 'access': access(view), 'propertyAccess': access(view['property'])},
            'controls': {k: {'interaction': v['signature'], 'access': access(v['item']['property']),
                              'svgTarget': targets[v['item']['id']],
                              'state': {n: v['item'][n] for n in ('hide', 'lock') if n in v['item']},
                              'inputAccess': {n: v['item']['property'].get('options', {})[n]
                                              for n in ('readonly',) if n in v['item']['property'].get('options', {})}}
                         for k, v in controls.items()},
            'layout': deepcopy(project['hmi']['layout'])}


def _input_policy(original, proposed, view, locks):
    if original['type'] != 'svg-ext-html_input':
        return
    source = original['property'].get('options', {})
    target = proposed['property']['options']
    target.pop('readonly', None)
    if 'readonly' in source:
        target['readonly'] = source['readonly']
    if locks.get('type') != 'number' or source.get('type', 'number') != 'number' or str(locks.get('step', '1')) != '1' or source.get('step', 1) != 1:
        fail('本批仅支持步长1的原生数字输入，其他输入无法证明等价。')
    # A tighter existing input range must not be widened while keeping ACLs.
    for key, fn in (('min', max), ('max', min)):
        try: values = ([source[key]] if key in source else []) + ([float(locks[key])] if key in locks else [])
        except (TypeError, ValueError): fail('原HTML输入范围无法解释。')
        for value in values:
            if type(value) not in (int, float) or not math.isfinite(value): fail('原输入范围无效。')
            target[key] = fn(value, target[key])
    if target['min'] > target['max']:
        fail('输入范围没有交集。')
    tag = proposed['property']['variableId']
    pattern = r'<input\b[^>]*\bid="I-HXI_' + re.escape(proposed['id']) + r'"[^>]*/>'
    matches = list(re.finditer(pattern, view['svgcontent']))
    if len(matches) != 1:
        fail('输入 SVG 与原生控件无法对应。')
    svg_input = matches[0][0]
    initial = re.search(r'\bvalue="([^"]+)"', svg_input)
    if not initial or not target['min'] <= float(initial[1]) <= target['max']:
        fail('输入初值不在原工程允许范围内：' + tag)
    for key in ('min', 'max'):
        svg_input = re.sub(r'\b' + key + r'="[^"]*"', key + '="' + str(target[key]) + '"', svg_input)
    if target.get('readonly') or 'readonly' in locks:
        svg_input = svg_input[:-2] + ' readonly="readonly"/>'
    if 'disabled' in locks:
        svg_input = svg_input[:-2] + ' disabled="disabled"/>'
    view['svgcontent'] = view['svgcontent'][:matches[0].start()] + svg_input + view['svgcontent'][matches[0].end():]


def inherit_permissions(source, generated):
    """Return a detached candidate; bijective unchanged interactions only.

    Regenerated IDs can differ when an interaction has exactly one source and
    destination. An existing ID cannot be repurposed for another interaction.
    Missing, additional, duplicated, changed-type or changed-action controls fail.
    """
    before = permission_contract(source)
    old_view, old_scripts, old_controls, old_ids = _index(source)
    original_locks = html_locks(old_view)
    result = deepcopy(generated)
    view, scripts, controls, ids = _index(result)
    if (old_view['id'] != view['id'] or set(scripts) != set(old_scripts) or set(controls) != set(old_controls)):
        fail('画面／脚本／控件有新增、删除或交互变化。')
    if any(old_ids[ident] != key for ident, key in ids.items() if ident in old_ids):
        fail('已有控件编号被用于不同动作／变量。')
    _replace_access(view, old_view)
    _replace_access(view['property'], old_view['property'])
    result['hmi']['layout'] = deepcopy(source['hmi']['layout'])
    for ident, script in scripts.items():
        original = old_scripts[ident]
        if any(script.get(k) != original.get(k) for k in ('mode', 'code', 'parameters')):
            fail('脚本内容或执行位置发生变化。')
        _replace_access(script, original)
    for key, value in controls.items():
        original, proposed = old_controls[key]['item'], value['item']
        _replace_access(proposed['property'], original['property'])
        for name in ('hide', 'lock'):
            proposed.pop(name, None)
            if name in original:
                proposed[name] = original[name]
        _input_policy(original, proposed, view, original_locks.get(original['id'], {}))
        if proposed['type'] == 'svg-ext-html_button' and 'disabled' in original_locks.get(original['id'], {}):
            marker = 'id="B-HXB_' + proposed['id'] + '"'
            view['svgcontent'] = view['svgcontent'].replace(marker, marker + ' disabled="disabled"', 1)
    view['svgcontent'], _ = secure_svg(view)
    if permission_contract(result) != before:
        fail('生成后权限契约不同。')
    from workbench_hmi_native_gate import verify_native_permissions
    verify_native_permissions(source, result)
    return result
