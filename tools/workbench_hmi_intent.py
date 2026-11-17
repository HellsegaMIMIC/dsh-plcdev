"""Fail-closed, explicit HMI-only requests for the saved-version workflow.

This deliberately accepts a small grammar, not general natural language. The
model's selection is checked against the user's entire request and a freshly
read, bounded list of real targets; the model is not an authority on intent.
"""
import re


_QUOTED = r'(?P<{0}_open>[“"])(?P<{0}>[^“”"\r\n]+)(?P<{0}_close>[”"])'
_REQUEST = re.compile(
    r'(?:把|将)(?P<kind>静态文字|文字|画面名称)(?P<id_mode>\s*ID\s*)?'
    + _QUOTED.format('old')
    + r'(?:改为|改成|设为|设置为|替换为)'
    + _QUOTED.format('new') + r'[。.!！]?'
)
_SCOPED_REQUEST = re.compile(
    r'(?:把|将)画面\s*ID\s*' + _QUOTED.format('view')
    + r'的(?P<kind>静态文字|文字)(?P<id_mode>\s*ID\s*)?'
    + _QUOTED.format('old')
    + r'(?:改为|改成|设为|设置为|替换为)'
    + _QUOTED.format('new') + r'[。.!！]?'
)
_PAIRS = {'“': '”', '"': '"'}
_HELP = ('请用单条明确指令，例如：把静态文字“原文字”改为“新文字”，'
         '或把文字 ID“PLCD_id”改为“新文字”；画面名称请使用“画面名称”。'
         '目标有重名时可用：把画面 ID“画面ID”的文字 ID“元素ID”改为“新文字”。')


def validate_hmi_intent(workflow, request, plan, targets):
    """Validate a plan against explicit user intent and current saved targets.

    ``targets`` is the complete supported target list from the same saved
    revision: hmiTextTargets for text, hmiViews for view names. A repeated
    name or ID is intentionally ambiguous, even if the model chose one.
    """
    kinds = {'hmi-static-text-v1': ('文字', 'text'),
             'hmi-view-name-v1': ('画面名称', 'name')}
    if workflow not in kinds or not isinstance(request, str) or not isinstance(plan, dict) or not isinstance(targets, list):
        raise ValueError(_HELP)
    match = _REQUEST.fullmatch(request.strip())
    scoped = False
    if not match and workflow == 'hmi-static-text-v1':
        match = _SCOPED_REQUEST.fullmatch(request.strip())
        scoped = match is not None
    if (not match or (match['kind'] != kinds[workflow][0] and not (workflow == 'hmi-static-text-v1' and match['kind'] == '静态文字'))
            or (workflow == 'hmi-static-text-v1' and not match['id_mode'] and match['kind'] != '静态文字')
            or any(_PAIRS[match[k + '_open']] != match[k + '_close']
                   for k in (('view', 'old', 'new') if scoped else ('old', 'new')))):
        raise ValueError(_HELP)
    old, new = match['old'], match['new']
    # Candidate renderers trim new values. Reject whitespace instead of
    # silently publishing something other than the explicitly quoted value.
    if not old.strip() or not new.strip() or new != new.strip() or any(ord(c) < 32 for c in old + new):
        raise ValueError('原值和新值须为完整有效文字；新值首尾不能有空白。')
    if plan.get(kinds[workflow][1]) != new:
        raise ValueError('计划中的新值与请求中完整引用的新值不一致。')

    if workflow == 'hmi-static-text-v1':
        selector = 'elementId' if match['id_mode'] else 'text'
        matches = [t for t in targets if isinstance(t, dict) and t.get(selector) == old
                   and (not scoped or t.get('viewId') == match['view'])]
        if (len(matches) != 1 or matches[0].get('viewId') != plan.get('viewId')
                or matches[0].get('elementId') != plan.get('elementId')):
            raise ValueError('原文字或元素 ID 未唯一定位当前保存版本中的计划目标。')
        if not match['id_mode'] and matches[0].get('ambiguousText') is not False:
            raise ValueError('原文字与其他已保存的静态文字或控件文案可能重复，请使用明确的画面及元素 ID。')
        original = matches[0].get('text')
    else:
        selector = 'id' if match['id_mode'] else 'name'
        matches = [t for t in targets if isinstance(t, dict) and t.get(selector) == old]
        if len(matches) != 1 or matches[0].get('id') != plan.get('viewId'):
            raise ValueError('原名称或画面 ID 未唯一定位当前保存版本中的计划目标。')
        if not match['id_mode'] and matches[0].get('ambiguousName') is not False:
            raise ValueError('画面名称可能与其他画面显示相同，请使用明确的画面 ID。')
        original = matches[0].get('name')
    if original == new:
        raise ValueError('新值与当前值相同，未生成候选。')
