"""Bounded native SVG targets for FUXA 1.3.5's string-based permission filter.

The installed filter finds the first *substring* item.id, then scans forward
for a foreignObject. A DOM ID alone is therefore insufficient. Validate the
whole bounded native tree and every occurrence before canonicalizing only the
known caption/value layout in a detached candidate. Never edit the source.
"""
import re
from xml.parsers import expat

from workbench_agent_adapters import AdapterError


SVG = 'http://www.w3.org/2000/svg'
HTML = 'http://www.w3.org/1999/xhtml'
POLICY = 'fuxa-1.3.5-ascii-dom-targets-v2'
PAINT = {'fill', 'stroke', 'stroke-width', 'font-size', 'font-family', 'text-anchor'}
ATTRS = {
    'svg': {'xmlns', 'xmlns:svg', 'xmlns:html', 'width', 'height'},
    'g': {'id', 'type'} | PAINT,
    'title': set(),
    'text': {'id', 'x', 'y'} | PAINT,
    'rect': {'id', 'x', 'y', 'width', 'height', 'rx'} | PAINT,
    'foreignObject': {'id', 'x', 'y', 'width', 'height'},
    'button': {'xmlns', 'id', 'class', 'style', 'disabled'},
    'input': {'xmlns', 'id', 'type', 'min', 'max', 'step', 'value', 'style', 'readonly', 'disabled'},
}
STYLES = {'width', 'height', 'border', 'border-radius', 'background', 'color',
          'font-size', 'box-sizing', 'padding'}


def fail(message):
    raise AdapterError('not_ready', '无法安全定位 FUXA SVG 权限目标：' + message)


def _tree(svg):
    if not isinstance(svg, str) or not svg or len(svg) > 2_000_000 or '<!' in svg or '<?' in svg:
        fail('SVG为空、过大或包含不受支持的声明。')
    try: data = svg.encode('utf-8')
    except UnicodeError: fail('SVG含孤立代理码，无法可靠解析。')
    parser = expat.ParserCreate()
    nodes, stack, ids = [], [], {}

    def tag_end(start):
        quote = None
        for i in range(start, len(data)):
            c = data[i]
            if quote:
                if c == quote: quote = None
            elif c in (34, 39): quote = c
            elif c == 62: return i + 1
        fail('标签未闭合。')

    def start(tag, attrs):
        if tag not in ATTRS or set(attrs) - ATTRS[tag] or len(nodes) >= 1000:
            fail('存在未知元素、属性或过多节点。')
        if tag == 'button' and attrs.get('class') != 'md-btn md-btn-raised':
            fail('自定义HTML样式类不在本批权限验证范围。')
        for k, v in attrs.items():
            if k.startswith('xmlns') and v != (HTML if tag in ('button', 'input') else HTML if k == 'xmlns:html' else SVG):
                fail('命名空间不能可靠映射。')
            if k in ('fill', 'stroke') and not re.fullmatch(r'#[0-9a-fA-F]{6}|none', v):
                fail('不支持引用或动态绘制属性。')
        if 'style' in attrs:
            seen = set()
            for declaration in attrs['style'].split(';'):
                if not declaration.strip(): continue
                key, sep, value = declaration.partition(':')
                key, value = key.strip(), value.strip()
                if not sep or key not in STYLES or key in seen or not re.fullmatch(r'[a-zA-Z0-9#.% \-]+', value):
                    fail('样式可能覆盖权限或包含动态内容。')
                seen.add(key)
        offset = parser.CurrentByteIndex
        end = tag_end(offset)
        if (data[end - 2:end] == b'/>') != (tag in ('input', 'rect')):
            fail('HTML／SVG标签闭合形式可能造成XML与浏览器DOM差异。')
        node = {'tag': tag, 'attrs': attrs, 'start': offset, 'openEnd': end,
                'parent': stack[-1] if stack else None, 'children': [], 'text': []}
        if stack: stack[-1]['children'].append(node)
        nodes.append(node); stack.append(node)
        ident = attrs.get('id')
        if ident is not None:
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,159}', ident) or ident in ids:
                fail('ID格式无效或重复。')
            opening = data[offset:end]
            match = re.search(rb'\sid="' + re.escape(ident.encode()) + rb'"(?=[\s/>])', opening)
            if not match:
                fail('ID属性不是可核对的原生字面形式。')
            node['idStart'] = offset + match.start() + 5
            ids[ident] = node

    def end(tag):
        node = stack.pop()
        node['closeStart'] = parser.CurrentByteIndex
        node['end'] = node['openEnd'] if data[node['openEnd'] - 2:node['openEnd']] == b'/>' else tag_end(parser.CurrentByteIndex)

    def text(value):
        if stack: stack[-1]['text'].append(value)

    parser.StartElementHandler = start; parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    try: parser.Parse(data, True)
    except expat.ExpatError as e: fail('SVG不是受支持的完整XML：' + str(e))
    if not nodes or nodes[0]['tag'] != 'svg' or nodes[0]['attrs'].get('xmlns') != SVG:
        fail('缺少明确SVG根命名空间。')
    for node in nodes:
        if node['tag'] not in ('title', 'text', 'button') and ''.join(node['text']).strip():
            fail('非文本节点包含未映射内容。')
    return data, nodes, ids


def secure_svg(view):
    """Return (canonical SVG, semantic target proof), or reject without writes.

    Legacy lbl_<item.id> captions are the sole known prefix exception. Their
    unique text nodes move inside their own group. Value-only groups move after
    HTML controls: native disabled-value scanning must not disable the next
    unrelated input. Absolute geometry and relative HTML-control order remain.
    All other text/attribute/reference/ID collisions fail, even after the owner.
    """
    data, nodes, ids = _tree(view.get('svgcontent'))
    items = view.get('items')
    if not isinstance(items, dict) or not items: fail('缺少原生控件。')
    root = nodes[0]
    if len(root['children']) != 1 or root['children'][0]['tag'] != 'g' or root['children'][0]['attrs']:
        fail('画布不是无额外行为的单层原生容器。')
    canvas = root['children'][0]
    targets, captions, groups, owned = {}, {}, {}, {}
    for ident, item in items.items():
        group = ids.get(ident)
        if (item.get('id') != ident or not group or group['tag'] != 'g'
                or group['parent'] is not canvas or group['attrs'].get('type') != item.get('type')):
            fail('控件元数据与唯一SVG组不对应：' + str(ident))
        kind = item['type']; caption = ids.get('lbl_' + ident)
        expected = {ident}
        if caption:
            if kind not in ('svg-ext-value', 'svg-ext-html_input') or caption['tag'] != 'text' or (caption['parent'] is not canvas and caption['parent'] is not group) or caption['children']:
                fail('前缀标签不是所属控件的独立原生文字。')
            expected.add('lbl_' + ident); captions[ident] = caption
        if kind == 'svg-ext-value':
            child = ids.get('value_' + ident)
            if not child or child['tag'] != 'text' or child['parent'] is not group or child['children'] or item['property'].get('events'):
                fail('值显示与SVG文字或事件不一致。')
            expected.add('value_' + ident); html_tag = None
        elif kind in ('svg-ext-html_button', 'svg-ext-html_input'):
            button = kind == 'svg-ext-html_button'; family = 'HXB_' if button else 'HXI_'
            foreign = ids.get('H-' + family + ident)
            child = ids.get(('B-' if button else 'I-') + family + ident)
            rect = ids.get('rect_' + ident); html_tag = 'button' if button else 'input'
            if (not foreign or foreign['tag'] != 'foreignObject' or foreign['parent'] is not group
                    or not child or child['tag'] != html_tag or child['parent'] is not foreign
                    or child['attrs'].get('xmlns') != HTML or child['children']
                    or len(foreign['children']) != 1
                    or not rect or rect['tag'] != 'rect' or rect['parent'] is not group or rect['children']):
                fail('HTML交互控件不在唯一所属foreignObject内。')
            expected.update(('rect_' + ident, 'H-' + family + ident, ('B-' if button else 'I-') + family + ident))
        else: fail('不支持该SVG控件类型。')
        expected_direct = {x for x in expected - {ident} if ids[x]['parent'] is group}
        if {n['attrs'].get('id') for n in group['children']} != expected_direct:
            fail('控件内存在未登记子元素。')
        allowed = []
        for name in expected:
            if name in owned: fail('SVG节点被多个权限目标共用。')
            owned[name] = ident
            node = ids[name]
            allowed.append(node['idStart'] + name.index(ident))
        occurrences = [m.start() for m in re.finditer(re.escape(ident.encode()), data)]
        if sorted(occurrences) != sorted(allowed):
            fail('控件ID与文字、属性、引用或其他ID碰撞：' + ident)
        for node in nodes:
            if ident in ''.join(node['text']) or any(ident in val for key, val in node['attrs'].items() if key != 'id'):
                fail('解码后的文字或属性包含权限目标ID：' + ident)
        groups[ident] = group
        targets[ident] = {'type': kind, 'htmlControl': html_tag, 'caption': caption is not None, 'policy': POLICY,
                         'readonly': bool(html_tag == 'input' and ('readonly' in child['attrs'] or item['property'].get('options', {}).get('readonly') is True)),
                         'disabled': bool(html_tag and 'disabled' in child['attrs'])}
    for node in canvas['children']:
        ident = node['attrs'].get('id')
        if ident in groups or any(node is c for c in captions.values()): continue
        if node['tag'] not in ('text', 'title') or node['children']:
            fail('画布存在未登记交互或容器。')
    blocks, values = [], []
    for node in canvas['children']:
        ident = node['attrs'].get('id')
        if any(node is c for c in captions.values()): continue
        block = data[node['start']:node['end']]
        caption = captions.get(ident)
        if caption and caption['parent'] is canvas:
            at = node['openEnd'] - node['start']
            block = block[:at] + data[caption['start']:caption['end']] + block[at:]
        (values if ident in groups and items[ident]['type'] == 'svg-ext-value' else blocks).append(block)
    canonical = (data[:canvas['openEnd']] + b'\n'.join(blocks + values)
                 + data[canvas['closeStart']:]).decode('utf-8')
    # Native utils lowercases a JS UTF-16 string but slices the original string
    # with those offsets. Encoding *every* non-ASCII scalar as a numeric XML
    # reference makes byte/UTF-16/lowercase offsets identical without guessing
    # Unicode casing tables. DOM text/attributes are compared by the native gate.
    canonical = ''.join(c if ord(c) < 128 else '&#' + str(ord(c)) + ';' for c in canonical)
    if not canonical.isascii(): fail('最终SVG没有满足ASCII索引不变量。')
    # Reparse what will actually be delivered and prove the installed filter's
    # first-substring and forward-foreignObject targets on those exact bytes.
    final, _, final_ids = _tree(canonical)
    foreign_end = max((n['end'] for n in final_ids.values() if n['tag'] == 'foreignObject'), default=0)
    for ident, proof in targets.items():
        group = final_ids[ident]
        if final.find(ident.encode()) != group['idStart']:
            fail('原生首次字符串定位不指向目标组ID。')
        if proof['htmlControl']:
            foreign = next(n for n in group['children'] if n['tag'] == 'foreignObject')
            lower = final.lower()
            if (lower.find(b'<foreignobject', group['idStart']) != foreign['start']
                    or lower.find(b'</foreignobject', foreign['start']) != foreign['closeStart']):
                fail('原生禁用扫描不能限定在所属HTML控件。')
        elif group['start'] < foreign_end:
            fail('只读值控件可能误定位后续HTML控件。')
    return canonical, targets


def html_locks(view):
    """Exact independent HTML locks; metadata is deliberately not a fallback."""
    _, _, ids = _tree(view['svgcontent'])
    result = {}
    for ident, item in view['items'].items():
        kind = item['type']
        if kind not in ('svg-ext-html_input', 'svg-ext-html_button'): continue
        child_id = ('I-HXI_' if kind == 'svg-ext-html_input' else 'B-HXB_') + ident
        child = ids.get(child_id)
        if not child: fail('缺少HTML限制目标。')
        result[ident] = {k: child['attrs'][k] for k in ('readonly', 'disabled', 'type', 'min', 'max', 'step') if k in child['attrs']}
    return result
