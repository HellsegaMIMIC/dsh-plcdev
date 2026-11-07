"""Portable project-owned variables and operations, independent of any process recipe."""
from copy import deepcopy
import hashlib
import json
import math
import re
import struct

PROTOCOL = 'project-interface-v1'
SIZES = {'BOOL': 1, 'INT': 2, 'REAL': 4}
MISSING = object()


def fields(value, allowed, required, label):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError(label + '包含未知字段或缺少必需字段')


def identifier(value):
    if (not isinstance(value, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,39}', value)
            or value.lower() in {'__proto__', 'prototype', 'constructor'}):
        raise ValueError('标识符须为 1–40 个英文字母、数字或下划线，不能数字开头或使用保留名称')
    return value


def text(value, label, maximum=80, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()) or any(ord(c) < 32 or c in '<>' for c in value):
        raise ValueError(label + '须为可见文本，最多 ' + str(maximum) + ' 个字符')


def _number(value, kind):
    if kind == 'INT':
        if type(value) is not int or not -32768 <= value <= 32767:
            raise ValueError('INT 须为 -32768–32767 的整数')
    elif kind == 'REAL':
        if type(value) not in (int, float):
            raise ValueError('REAL 须为有限 32 位浮点数')
        try:
            converted = float(value)
            if not math.isfinite(converted) or not math.isfinite(struct.unpack('<f', struct.pack('<f', converted))[0]):
                raise ValueError('REAL 须为有限 32 位浮点数')
        except (OverflowError, struct.error) as exc:
            raise ValueError('REAL 超出 32 位浮点数范围') from exc
    else:
        raise ValueError('不支持的数值类型')
    return value


def validate_value(variable, value):
    kind = variable['type']
    if kind == 'BOOL':
        if type(value) is not bool:
            raise ValueError(variable['id'] + '要求 BOOL 布尔值')
    else:
        _number(value, kind)
        if 'min' in variable and not variable['min'] <= value <= variable['max']:
            raise ValueError(variable['id'] + '超出声明的数值范围')
    return value


def validate_interface(definition):
    """Return a detached validated declaration. Omitted permissions never default on."""
    fields(definition, {'schemaVersion', 'protocol', 'title', 'description', 'variables', 'operations'},
           {'schemaVersion', 'protocol', 'variables', 'operations'}, '工程接口')
    if type(definition['schemaVersion']) is not int or definition['schemaVersion'] != 1 or definition['protocol'] != PROTOCOL:
        raise ValueError('仅支持 project-interface-v1 版本 1')
    if 'title' in definition:
        text(definition['title'], '接口名称')
    if 'description' in definition:
        text(definition['description'], '接口说明', 500, empty=True)
    variables, operations = definition['variables'], definition['operations']
    if not isinstance(variables, list) or not 1 <= len(variables) <= 128:
        raise ValueError('接口需要 1–128 个变量')
    if not isinstance(operations, list) or len(operations) > 128:
        raise ValueError('接口操作须为数组，最多 128 项')
    by_id, ids, paths = {}, set(), set()
    for item in variables:
        fields(item, {'id', 'label', 'path', 'type', 'access', 'aiVisible', 'min', 'max', 'unit'},
               {'id', 'label', 'path', 'type', 'access', 'aiVisible'}, '变量')
        ident = identifier(item['id'])
        if ident.lower() in ids:
            raise ValueError('变量标识符重复：' + ident)
        ids.add(ident.lower());by_id[ident] = item
        text(item['label'], '变量名称')
        path = item['path']
        if not isinstance(path, str) or len(path) > 200 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+', path):
            raise ValueError('变量须使用完整的 PLC 实例路径')
        if path.upper() in paths:
            raise ValueError('PLC 变量路径重复：' + path)
        paths.add(path.upper())
        if not isinstance(item['type'], str) or item['type'] not in SIZES or item['access'] not in ('read', 'readwrite') or type(item['aiVisible']) is not bool:
            raise ValueError('变量类型、读写权限或 AI 可见性无效')
        if 'unit' in item:
            text(item['unit'], '单位', 24, empty=True)
        if item['type'] == 'BOOL':
            if 'min' in item or 'max' in item:
                raise ValueError('BOOL 不接受数值范围')
        else:
            if ('min' in item) != ('max' in item) or (item['access'] == 'readwrite' and 'min' not in item):
                raise ValueError('数值写变量须声明 min/max，读取范围也须成对提供')
            if 'min' in item:
                _number(item['min'], item['type']);_number(item['max'], item['type'])
                if item['min'] > item['max']:
                    raise ValueError('变量最小值不能大于最大值')
    ids = set()
    for item in operations:
        fields(item, {'id', 'label', 'kind', 'variable', 'value', 'valueFrom', 'durationMs', 'enabled', 'aiVisible'},
               {'id', 'label', 'kind', 'variable', 'enabled', 'aiVisible'}, '操作')
        ident = identifier(item['id'])
        if ident.lower() in ids:
            raise ValueError('操作标识符重复：' + ident)
        ids.add(ident.lower());text(item['label'], '操作名称')
        if type(item['enabled']) is not bool or type(item['aiVisible']) is not bool:
            raise ValueError('操作启用及 AI 可见性须为布尔值')
        variable = by_id.get(item['variable']) if isinstance(item['variable'], str) else None
        if not variable or variable['access'] != 'readwrite':
            raise ValueError('操作只能写入已声明的可写变量')
        if item['kind'] == 'pulse':
            if variable['type'] != 'BOOL' or item.get('value') is not True or 'valueFrom' in item:
                raise ValueError('脉冲只支持 BOOL value:true，随后自动释放为 false')
            if type(item.get('durationMs')) is not int or not 100 <= item['durationMs'] <= 2000:
                raise ValueError('脉冲 durationMs 须为 100–2000 毫秒整数')
        elif item['kind'] == 'write':
            if 'durationMs' in item or ('value' in item) == ('valueFrom' in item):
                raise ValueError('写操作须在 value 与 valueFrom 中二选一，不能包含脉冲时长')
            if 'valueFrom' in item and item['valueFrom'] != 'input':
                raise ValueError('操作 valueFrom 仅支持 input')
            if 'value' in item:
                validate_value(variable, item['value'])
        else:
            raise ValueError('操作 kind 仅支持 write／pulse')
    return deepcopy(definition)


def interface_hash(definition):
    value = validate_interface(definition)
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def ai_context(definition):
    definition = validate_interface(definition)
    variables = [item for item in definition['variables'] if item['aiVisible']]
    ids = {item['id'] for item in variables}
    return dict(definition, variables=variables, operations=[item for item in definition['operations']
                if item['enabled'] and item['aiVisible'] and item['variable'] in ids])


def operation_value(definition, operation_id, value=MISSING, phase='apply'):
    definition = validate_interface(definition)
    operation = next((item for item in definition['operations'] if item['id'] == operation_id), None)
    if not operation or not operation['enabled']:
        raise ValueError('操作未声明或未启用')
    variable = next(item for item in definition['variables'] if item['id'] == operation['variable'])
    if phase == 'release':
        if operation['kind'] != 'pulse' or value is not False:
            raise ValueError('仅脉冲操作允许自动释放为 false')
        selected = False
    elif phase == 'apply':
        if operation.get('valueFrom') == 'input':
            if value is MISSING:
                raise ValueError('操作需要输入值')
            selected = value
        else:
            selected = operation['value']
            if value is not MISSING and (type(value) is not type(selected) or value != selected):
                raise ValueError('固定操作值不能被请求覆盖')
        validate_value(variable, selected)
    else:
        raise ValueError('未知操作阶段')
    return operation, variable, selected


def bind_interface(definition, leaves):
    """Bind declared paths/types to the actual compiler debug map; no inferred symbols."""
    definition = validate_interface(definition)
    if not isinstance(leaves, list) or not leaves or len(leaves) > 512:
        raise ValueError('编译变量映射无效')
    by_path, addresses = {}, set()
    for leaf in leaves:
        if not isinstance(leaf, dict) or not isinstance(leaf.get('path'), str):
            raise ValueError('编译变量条目无效')
        path = leaf['path'].upper()
        if path in by_path:
            raise ValueError('编译变量路径重复：' + path)
        if (type(leaf.get('arrayIdx')) is not int or not 0 <= leaf['arrayIdx'] <= 255
                or type(leaf.get('elemIdx')) is not int or not 0 <= leaf['elemIdx'] <= 65535):
            raise ValueError('编译变量索引无效')
        address = (leaf['arrayIdx'], leaf['elemIdx'])
        if address in addresses:
            raise ValueError('编译变量索引重复')
        by_path[path] = leaf;addresses.add(address)
    result = {}
    for variable in definition['variables']:
        leaf = by_path.get(variable['path'].upper())
        if leaf is None or leaf.get('type') != variable['type'] or type(leaf.get('size')) is not int or leaf['size'] != SIZES[variable['type']]:
            raise ValueError('声明与编译变量路径／类型不匹配：' + variable['path'])
        result[variable['id']] = deepcopy(leaf)
    return result
