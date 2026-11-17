"""Bounded, static FUXA canvas projection, without device or executable data.

Reuse the saved native SVG geometry. This is deliberately not a FUXA runtime:
HTML buttons/inputs become inert SVG, and unsupported visual content is marked
partial. No network access, asset resolution, scripts or device configuration.
"""
import json
import math
import re
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

SVG_NS = 'http://www.w3.org/2000/svg'
HTML_NS = 'http://www.w3.org/1999/xhtml'
MAX_FILE = 2 * 1024 * 1024
MAX_SVG = 262144
MAX_VIEWS = 16
MAX_NODES = 4096
MAX_DEPTH = 48
ID = re.compile(r'[A-Za-z_][A-Za-z0-9_.:-]{0,255}\Z')
NUMBER = re.compile(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?:px|%)?\Z')
COLOR = re.compile(r'(?:#[\da-fA-F]{3,4}|#[\da-fA-F]{6}|#[\da-fA-F]{8}|(?:rgb|rgba|hsl|hsla)\([\d.,% +\-]+\)|[A-Za-z]{1,24})\Z')
TAGS = {'svg', 'g', 'text', 'tspan', 'rect', 'path', 'line', 'polyline', 'polygon',
        'circle', 'ellipse', 'defs', 'linearGradient', 'radialGradient', 'stop',
        'clipPath'}
NUMERIC = {'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
           'width', 'height', 'dx', 'dy', 'font-size', 'stroke-width', 'opacity',
           'fill-opacity', 'stroke-opacity', 'stop-opacity', 'offset', 'textLength',
           'stroke-dashoffset', 'stroke-miterlimit'}
COLORS = {'fill', 'stroke', 'stop-color', 'color'}
ENUMS = {
    'text-anchor': {'start', 'middle', 'end'}, 'font-style': {'normal', 'italic', 'oblique'},
    'font-weight': {'normal', 'bold', 'bolder', 'lighter', *map(str, range(100, 1000, 100))},
    'stroke-linecap': {'butt', 'round', 'square'}, 'stroke-linejoin': {'miter', 'round', 'bevel'},
    'fill-rule': {'nonzero', 'evenodd'}, 'clip-rule': {'nonzero', 'evenodd'},
    'gradientUnits': {'userSpaceOnUse', 'objectBoundingBox'},
    'clipPathUnits': {'userSpaceOnUse', 'objectBoundingBox'},
    'spreadMethod': {'pad', 'reflect', 'repeat'},
    'dominant-baseline': {'auto', 'middle', 'central', 'hanging', 'text-before-edge',
                          'text-after-edge', 'alphabetic', 'ideographic'},
    'display': {'none', 'inline'}, 'visibility': {'hidden', 'visible', 'collapse'},
    'lengthAdjust': {'spacing', 'spacingAndGlyphs'},
}
KNOWN_WIDGETS = {'svg-ext-value', 'svg-ext-html_button', 'svg-ext-html_input'}


def _name(value):
    if value.startswith('{'):
        namespace, name = value[1:].split('}', 1)
        return namespace, name
    return '', value


def _label(value, fallback=''):
    if not isinstance(value, str):
        return fallback
    return ''.join(c for c in value if c >= ' ' and not 0xD800 <= ord(c) <= 0xDFFF)[:256]


def _number(value):
    if not isinstance(value, str) or len(value) > 40 or not NUMBER.fullmatch(value):
        return None
    number = float(re.sub(r'(?:px|%)$', '', value))
    return value if math.isfinite(number) and abs(number) <= 1000000 else None


def _dimension(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(str(value).removesuffix('px'))
        return result if math.isfinite(result) and 1 <= result <= 16384 else None
    except (TypeError, ValueError):
        return None


def _color(value):
    return value if isinstance(value, str) and COLOR.fullmatch(value) else None


def _style(value):
    """Only parse ordinary declarations; do not interpret CSS escapes or URLs."""
    if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\\@{}]|/\*|url\s*\(|expression\s*\(', value, re.I):
        return {}, bool(value)
    fields = {}
    for item in value.split(';'):
        if ':' in item:
            key, data = item.split(':', 1)
            fields[key.strip().lower()] = data.strip()
    return fields, False


def _svg_tag(name):
    # A default namespace is set on the output root. Avoid changing the global
    # ElementTree namespace registry used by unrelated project writers.
    return name


def _html_caption(value):
    """Extract the native button's static caption without executable subtrees."""
    if not isinstance(value, str):
        return '', True
    if len(value) > 4096 or re.search(r'<!|<\?', value):
        return '', True
    class Caption(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts, self.blocked, self.partial = [], [], False
        def handle_starttag(self, tag, attrs):
            if self.blocked:
                if tag not in ('br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'wbr'):
                    self.blocked.append(tag)
                return
            if tag not in ('span', 'br', 'b', 'strong', 'i', 'em'):
                self.partial = True
                if tag not in ('img', 'input', 'hr', 'meta', 'link', 'source', 'wbr'):
                    self.blocked.append(tag)
            else:
                self.partial |= bool(attrs) or tag not in ('span', 'br')
                if tag == 'br':
                    self.parts.append('\n')
        def handle_endtag(self, tag):
            if tag in self.blocked:
                self.blocked = self.blocked[:self.blocked.index(tag)]
        def handle_data(self, data):
            if not self.blocked:
                self.parts.append(data)
        def handle_decl(self, decl):
            self.partial = True
        def unknown_decl(self, decl):
            self.partial = True
        def handle_pi(self, data):
            self.partial = True
    parser = Caption()
    try:
        parser.feed(value)
        parser.close()
    except (ValueError, AssertionError):
        return '', True
    text = ''.join(parser.parts)
    cleaned = ''.join(c for c in text if c in '\t\n\r' or
                      0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF)
    return cleaned, parser.partial or cleaned != text


def _safe_canvas(view):
    svg = view.get('svgcontent')
    if not isinstance(svg, str) or len(svg) > MAX_SVG or re.search(r'<!|<\?', svg):
        raise ValueError('画面内容无法静态预览。')
    try:
        tree = ET.fromstring(svg)
    except (ET.ParseError, ValueError, RecursionError) as exc:
        raise ValueError('画面内容无法静态预览。') from exc
    if _name(tree.tag) not in (('', 'svg'), (SVG_NS, 'svg')):
        raise ValueError('画面内容无法静态预览。')
    nodes, stack = [], [(tree, 0)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_DEPTH or len(nodes) >= MAX_NODES:
            raise ValueError('画面超出静态预览范围。')
        nodes.append(node)
        stack.extend((child, depth + 1) for child in node)
    profile = view.get('profile') if isinstance(view.get('profile'), dict) else {}
    width = _dimension(profile.get('width')) or _dimension(tree.get('width'))
    height = _dimension(profile.get('height')) or _dimension(tree.get('height'))
    partial = [False]
    if not width or not height:
        width, height = width or 1220, height or 720
        partial[0] = True
    background = profile.get('bkcolor', 'transparent')
    if not isinstance(background, str) or not re.fullmatch(r'(?:transparent|#[\da-fA-F]{3,4}|#[\da-fA-F]{6}|#[\da-fA-F]{8})', background):
        background = 'transparent'
        partial[0] = True
    ids, duplicates = {}, set()
    for node in nodes:
        ident = node.get('id')
        if ident and ID.fullmatch(ident):
            if ident in ids:
                duplicates.add(ident)
            else:
                ids[ident] = 'hmi-' + str(len(ids))
    gradient_ids = {node.get('id') for node in nodes if _name(node.tag) in
                    ((SVG_NS, 'linearGradient'), (SVG_NS, 'radialGradient'),
                     ('', 'linearGradient'), ('', 'radialGradient'))}
    if duplicates:
        partial[0] = True
        for ident in duplicates:
            ids.pop(ident, None)
    items = view.get('items') if isinstance(view.get('items'), dict) else {}

    def attribute(name, value):
        if len(value) > 65536:
            return None
        if name == 'id':
            return ids.get(value)
        if name in NUMERIC:
            return _number(value)
        if name in COLORS:
            if _color(value):
                return value
            match = re.fullmatch(r'url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]{0,255})\s*\)', value)
            if match and match[1] in ids and match[1] in gradient_ids:
                return 'url(#' + ids[match[1]] + ')'
            return None
        if name == 'clip-path':
            # Clipping graphs can be recursive. Defer them to the native view.
            return None
        if name in ENUMS:
            return value if value in ENUMS[name] else None
        if name in ('transform', 'gradientTransform'):
            return value if re.fullmatch(r'(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([\d.eE+,\s-]+\)\s*)+', value) else None
        if name in ('viewBox', 'points', 'stroke-dasharray'):
            return value if re.fullmatch(r'[\d.eE+,\s-]{1,65536}', value) else None
        if name == 'd':
            return value if re.fullmatch(r'[MmLlHhVvCcSsQqTtAaZz\d.eE+,\s-]{0,65536}', value) else None
        if name == 'font-family':
            return value if re.fullmatch(r'[\w ,\-\'"]{1,256}', value) else None
        if name == 'preserveAspectRatio':
            return value if re.fullmatch(r'(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)', value) else None
        return None

    def plain_text(node):
        namespace, name = _name(node.tag)
        if namespace not in ('', HTML_NS) or name.lower() not in ('button', 'span', 'div', 'b', 'i', 'strong', 'em', 'p', 'br'):
            partial[0] = True
            return ''
        if name.lower() != 'button' and (node.attrib or name.lower() not in ('span', 'br')):
            partial[0] = True
        return (node.text or '') + ''.join(plain_text(child) + (child.tail or '') for child in node)

    def foreign(node, inherited, owner):
        # Only the two native HTML controls used by the existing compiler have
        # an accurate static equivalent. Everything else stays visibly partial.
        children = list(node)
        if len(children) != 1 or _name(children[0].tag)[0] not in ('', HTML_NS):
            partial[0] = True
            return None
        control = children[0]
        kind = _name(control.tag)[1].lower()
        if kind not in ('button', 'input'):
            partial[0] = True
            return None
        x, y = _number(node.get('x', '0')), _number(node.get('y', '0'))
        w, h = _dimension(node.get('width')), _dimension(node.get('height'))
        if x is None or y is None or '%' in x + y or not w or not h:
            partial[0] = True
            return None
        x, y = float(x.removesuffix('px')), float(y.removesuffix('px'))
        style, bad = _style(control.get('style', ''))
        partial[0] |= bad
        supported_styles = {'width', 'height', 'border', 'border-radius', 'background', 'background-color',
                            'color', 'font-size', 'font-family', 'font-weight', 'font-style', 'box-sizing',
                            'padding', 'display', 'visibility', 'opacity'}
        partial[0] |= bool(set(style) - supported_styles)
        for name in ('background', 'background-color', 'color'):
            partial[0] |= bool(style.get(name) and not _color(style[name]))
        font = _dimension(style.get('font-size')) or _dimension(inherited.get('font-size')) or 16
        fill = _color(style.get('background') or style.get('background-color')) or ('#ffffff' if kind == 'input' else inherited.get('fill', '#187a73'))
        fg = _color(style.get('color')) or ('#202939' if kind == 'input' else '#ffffff')
        output = ET.Element(_svg_tag('g'))
        foreign_style, bad = _style(node.get('style', ''))
        partial[0] |= bad
        for key, value in {**node.attrib, **foreign_style}.items():
            if key in ('x', 'y', 'width', 'height', 'id', 'style'):
                continue
            if key in ('transform', 'opacity', 'display', 'visibility'):
                checked = attribute(key, value)
                if checked is not None:
                    output.set(key, checked)
                else:
                    partial[0] = True
            else:
                partial[0] = True
        for key in ('opacity', 'display', 'visibility'):
            if key in style:
                checked = attribute(key, style[key])
                if checked is not None:
                    output.set(key, checked)
                else:
                    partial[0] = True
        ET.SubElement(output, _svg_tag('rect'), {'x': str(x), 'y': str(y), 'width': str(w), 'height': str(h),
                      'rx': '5' if kind == 'button' else '0', 'fill': fill, 'stroke': '#cbd5e1' if kind == 'input' else 'none'})
        if kind == 'button':
            text = plain_text(control)[:4096]
            # FUXA HtmlButton.initElement replaces the saved SVG button body
            # with property.text, then item.name when no icon/image is set.
            prop = owner.get('property') if isinstance(owner, dict) else None
            if isinstance(prop, dict):
                decoration = prop.get('icon') or prop.get('image')
                partial[0] |= bool(decoration)
                caption = prop.get('text') or (owner.get('name') if not decoration else '') or ''
                text, incomplete = _html_caption(caption)
                partial[0] |= incomplete
        elif control.get('type', 'text').lower() in ('number', 'text'):
            text = control.get('value', '')[:4096]
        else:
            text = '—'
            partial[0] = True
        attrs = {'x': str(x + (w / 2 if kind == 'button' else 6)), 'y': str(y + h / 2),
                 'font-size': str(font), 'font-family': inherited.get('font-family', 'sans-serif'),
                 'fill': fg, 'stroke': 'none', 'text-anchor': 'middle' if kind == 'button' else 'start', 'dominant-baseline': 'central'}
        for key in ('font-family', 'font-weight', 'font-style'):
            if key in style:
                checked = attribute(key, style[key])
                if checked is not None:
                    attrs[key] = checked
                else:
                    partial[0] = True
        ET.SubElement(output, _svg_tag('text'), attrs).text = text
        return output

    def clone(node, inherited, dynamic_value=False, owner=None):
        namespace, tag = _name(node.tag)
        if namespace not in ('', SVG_NS):
            partial[0] = True
            return None
        if tag in ('title', 'desc'):
            return None
        item = items.get(node.get('id'))
        if isinstance(item, dict):
            owner = item
        if isinstance(item, dict) and item.get('hide') is True:
            return None
        widget = (item.get('type') if isinstance(item, dict) else None) or node.get('type')
        dynamic_value |= widget == 'svg-ext-value'
        # secure_svg() may move a widget's static caption inside its value
        # group. Preserve that caption while suppressing saved runtime values.
        if str(node.get('id', '')).startswith('lbl_'):
            dynamic_value = False
        if isinstance(widget, str) and widget.startswith('svg-ext-') and widget not in KNOWN_WIDGETS:
            partial[0] = True
        if tag == 'foreignObject':
            return foreign(node, inherited, owner)
        if tag not in TAGS:
            # Includes all scripts, images, use, animation and active HTML.
            partial[0] = True
            return None
        output = ET.Element(_svg_tag(tag))
        style, bad = _style(node.get('style', ''))
        partial[0] |= bad
        fields = {k: v for k, v in node.attrib.items() if k != 'style'}
        fields.update(style)
        for key, value in fields.items():
            namespace, local = _name(key)
            if namespace:
                partial[0] |= namespace != 'http://www.w3.org/XML/1998/namespace'
                continue
            checked = attribute(local, value)
            if checked is not None:
                output.set(local, checked)
            elif local not in ('id', 'class', 'type', 'label', 'name', 'version', 'xmlns') and not local.startswith(('data-', 'aria-', 'on')):
                partial[0] = True
        if tag in ('text', 'tspan'):
            output.text = '—' if dynamic_value else (node.text or '')[:4096]
            if len(node.text or '') > 4096:
                partial[0] = True
        inherited = {**inherited, **output.attrib}
        for child in node:
            value = clone(child, inherited, dynamic_value, owner)
            if value is not None:
                output.append(value)
                if tag in ('text', 'tspan'):
                    value.tail = '' if dynamic_value else (child.tail or '')[:4096]
        return output

    output = clone(tree, {})
    output.set('xmlns', SVG_NS)
    output.set('width', str(width))
    output.set('height', str(height))
    output.set('viewBox', output.get('viewBox') or '0 0 ' + str(width) + ' ' + str(height))
    result = ET.tostring(output, encoding='unicode')
    if len(result) > MAX_SVG:
        raise ValueError('画面超出静态预览范围。')
    return width, height, background, result, partial[0]


def hmi_preview(content):
    """Return only saved canvas geometry; never return a whole FUXA document."""
    try:
        project = json.loads(content)
    except (ValueError, RecursionError) as exc:
        raise ValueError('HMI 文件无法静态预览。') from exc
    hmi = project.get('hmi') if isinstance(project, dict) else None
    views = hmi.get('views') if isinstance(hmi, dict) else None
    if not isinstance(views, list):
        raise ValueError('HMI 文件没有可预览画面。')
    if len(views) > MAX_VIEWS:
        raise ValueError('画面数量超出静态预览范围。')
    output, partial, seen = [], False, set()
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            raise ValueError('HMI 画面结构无法静态预览。')
        ident = _label(view.get('id'), 'view-' + str(index))
        if not ident or ident in seen:
            raise ValueError('HMI 画面标识无法核对。')
        seen.add(ident)
        name = _label(view.get('name'), '画面 ' + str(index + 1))
        try:
            if view.get('type', 'svg') != 'svg':
                raise ValueError('该类画面请在 FUXA 查看。')
            width, height, background, svg, incomplete = _safe_canvas(view)
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            width, height, background, svg, incomplete = 1220, 720, 'transparent', '', True
        output.append({'id': ident, 'name': name, 'width': width, 'height': height,
                       'background': background, 'svg': svg, 'partial': incomplete})
        partial |= incomplete
    return {'views': output, 'partial': partial}
