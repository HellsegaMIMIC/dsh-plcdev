"""Bounded FUXA static text targets for saved-version candidates.

Only top-level PLCdev static text in an SVG accepted by the existing FUXA
permission verifier can be exposed. Dynamic values, captions belonging to
controls and arbitrary user SVG are deliberately excluded.
"""
from html import escape
import re
from collections import Counter
from workbench_agent_adapters import AdapterError
from workbench_hmi_svg import _tree, secure_svg

_SECRET = re.compile(r'(?i)(?:\bsk-[a-z0-9_-]{12,}|(?:api[_ -]?key|authorization|bearer|token|password|密钥|密码)\s*[:=]\s*\S{8,})')


def saved_target_catalog(payload):
    """Return complete, verified targets or fail closed for the affected kind.

    An omitted/invalid view would make uniqueness claims unsafe. Unknown SVG
    makes the text list incomplete, so the text capability is disabled for
    the whole project. Count saved captions and values when determining
    ambiguity. Runtime values are not inspected or proved unique.
    """
    views = payload.get('hmi', {}).get('views', []) if isinstance(payload, dict) else None
    if not isinstance(views, list) or len(views) > 100:
        return [], []
    names, seen = [], set()
    for view in views:
        if not isinstance(view, dict): return [], []
        ident, name = view.get('id'), view.get('name')
        if (not isinstance(ident, str) or not 1 <= len(ident) <= 120 or any(ord(c) < 32 for c in ident)
                or ident in seen or not isinstance(name, str) or not name.strip() or len(name) > 200
                or _SECRET.search(name)):
            return [], []
        seen.add(ident); names.append({'id': ident, 'name': name})
    normalized = lambda value: ' '.join(value.split())
    name_counts = Counter(normalized(row['name']) for row in names)
    for row in names: row['ambiguousName'] = name_counts[normalized(row['name'])] != 1
    targets, visible = [], []
    try:
        for view in views:
            editable = static_text_targets(view)
            _, nodes, _ = _tree(view.get('svgcontent'))
            all_text = [''.join(node['text']) for node in nodes if node['tag'] in ('text','button','title')]
            all_text.extend(node['attrs']['value'] for node in nodes if node['tag']=='input' and 'value' in node['attrs'])
            if any(_SECRET.search(value) for value in all_text): return names, []
            visible.extend(all_text)
            targets.extend({'viewId': view['id'], 'elementId': target['id'], 'text': target['text']} for target in editable)
            if len(targets) > 100: return names, []
    except AdapterError:
        return names, []
    counts = Counter(normalized(value) for value in visible)
    for target in targets: target['ambiguousText'] = counts[normalized(target['text'])] != 1
    return names, targets


def static_text_targets(view):
    # Reject a whole unsupported view rather than broadening the trusted format.
    secure_svg(view)
    _, nodes, _ = _tree(view.get('svgcontent'))
    root = nodes[0]
    if len(root['children']) != 1 or root['children'][0]['tag'] != 'g':
        raise AdapterError('not_ready', '无法确认画面静态文本范围。')
    canvas = root['children'][0]
    result = []
    for node in nodes:
        ident = node['attrs'].get('id', '')
        if (node['tag'] != 'text' or node['parent'] is not canvas or node['children'] or
                not re.fullmatch(r'PLCD_[A-Za-z0-9_-]{1,100}', ident)):
            continue
        text = ''.join(node['text'])
        if not text.strip() or len(text) > 160 or any(ord(c) < 32 for c in text):
            continue
        result.append({'id': ident, 'text': text})
    if len(result) > 100:
        raise AdapterError('not_ready', '静态文本目标过多，无法完整核对。')
    return result


def replace_static_text(view, element_id, value):
    if not isinstance(value, str) or not value.strip() or len(value) > 160 or any(ord(c) < 32 for c in value):
        raise AdapterError('invalid_request', '静态文本须为 1–160 个有效字符。')
    targets = static_text_targets(view)
    found = [target for target in targets if target['id'] == element_id]
    if len(found) != 1:
        raise AdapterError('invalid_request', '请选择已核对的唯一静态文本。')
    old = found[0]['text']
    if old == value.strip():
        raise AdapterError('invalid_request', '静态文字没有变化；未发布候选。')
    data, _, ids = _tree(view['svgcontent'])
    node = ids[element_id]
    replacement = escape(value.strip(), quote=False).encode('utf-8')
    view['svgcontent'] = (data[:node['openEnd']] + replacement + data[node['closeStart']:]).decode('utf-8')
    # Verify the changed SVG still satisfies the same exact permission policy.
    verified = static_text_targets(view)
    after = [target for target in verified if target['id'] == element_id]
    if len(after) != 1 or after[0]['text'] != value.strip():
        raise AdapterError('failed', '候选文字未能可靠重读。')
    return old
