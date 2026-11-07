"""Typed input adapter copied only into a project-owned, zero-plugin local session."""
import json
from pathlib import Path
import re
import struct
from project_interface import bind_interface, interface_hash, operation_value, validate_interface, validate_value


def assert_local_project(project, mode, program):
    project = Path(project)
    if mode != 'local' or re.search(r'\bAT\s*%|\{\s*external', program, re.I):
        raise ValueError('工程接口写入仅支持无地址映射的隔离本机程序')
    data = json.loads((project / 'project.json').read_text(encoding='utf-8-sig'))['data']
    if data.get('remoteDevices') or data.get('servers'):
        raise ValueError('工程接口不能同时配置外部设备或服务器')
    pins = project / 'devices/pin-mapping.json'
    if pins.exists() and json.loads(pins.read_text(encoding='utf-8-sig')) not in ({}, []):
        raise ValueError('工程接口不能包含硬件引脚映射')


def counter_input_paths(project, mode, program, leaves):
    # Legacy monitor hook name; capability is determined entirely by this contract.
    try:
        assert_local_project(project, mode, program)
        definition = validate_interface(json.loads((Path(project) / 'project-interface.json').read_text(encoding='utf-8-sig')))
        bound = bind_interface(definition, leaves)
        return [bound[item['id']]['path'] for item in definition['variables'] if item['access'] == 'readwrite']
    except (KeyError, TypeError, ValueError, OSError):
        return []


def input_leaves(manifest, leaves):
    try:
        if manifest.get('mode') != 'local' or manifest.get('physicalHardware') is not False or manifest.get('locatedAddresses'):
            return {}
        definition = validate_interface(manifest['projectInterface'])
        if manifest.get('projectInterfaceHash') != interface_hash(definition):
            return {}
        bound = bind_interface(definition, leaves)
        result = {bound[item['id']]['path']: bound[item['id']] for item in definition['variables'] if item['access'] == 'readwrite'}
        return result if manifest.get('localInputPaths') == list(result) else {}
    except (KeyError, TypeError, ValueError):
        return {}


def validate_input_request(request, manifest, leaves, runtime_state, fresh):
    if runtime_state != 'RUNNING' or fresh is not True:
        raise ValueError('工程操作需要所属 Runtime RUN 且变量实时有效')
    allowed = input_leaves(manifest, leaves)
    if request.get('projectInterfaceHash') != manifest.get('projectInterfaceHash'):
        raise ValueError('请求声明版本不匹配')
    operation, variable, value = operation_value(manifest['projectInterface'], request.get('operationId'),
                                                request.get('value'), request.get('operationPhase', 'apply'))
    matching = [leaf for path, leaf in allowed.items() if path.upper() == variable['path'].upper()]
    if len(matching) != 1 or request.get('inputPath') != matching[0]['path']:
        raise ValueError('操作目标未获授权或与声明不匹配')
    return matching[0]


def write_bool_input(client, leaf, value):
    # Keep the monitor ABI name; the payload is typed and length checked.
    forcing = value is not None
    payload = b''
    if forcing:
        validate_value(dict(id=leaf['path'], type=leaf['type']), value)
        payload = bytes([int(value)]) if leaf['type'] == 'BOOL' else struct.pack('<h' if leaf['type'] == 'INT' else '<f', value)
        if len(payload) != leaf['size']:
            raise ValueError('写入长度与编译变量不匹配')
    packet = bytes([0x42, leaf['arrayIdx']]) + struct.pack('>H', leaf['elemIdx']) + bytes([int(forcing)]) + struct.pack('>H', len(payload)) + payload
    if client.debug(packet) != b'\x42\x7e':
        raise RuntimeError('Runtime 拒绝工程变量写入：' + leaf['path'])


def clear_local_inputs(client, allowed):
    # End BOOL pulses, then release all forces. Numeric values are not replaced
    # by a guessed zero/default: program initialization and logic own their state.
    for leaf in allowed.values():
        if leaf['type'] == 'BOOL':
            write_bool_input(client, leaf, False)
    for leaf in allowed.values():
        write_bool_input(client, leaf, None)
