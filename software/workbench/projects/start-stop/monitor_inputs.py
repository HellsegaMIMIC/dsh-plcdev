"""Two validated local inputs, copied only into the isolated latch Runtime."""
import json
from pathlib import Path
import re
import struct

LOCAL_INPUT_PATHS = ('INSTANCE0.START', 'INSTANCE0.STOP')

def counter_input_paths(project, mode, program, leaves):
    try:
        project = Path(project)
        if mode != 'local' or re.search(r'\bAT\s*%|\{\s*external', program, re.I): return []
        data = json.loads((project/'project.json').read_text(encoding='utf-8-sig'))['data']
        resource = data['configuration']['resource']
        if resource.get('globalVariables') or resource['instances'] != [dict(name='instance0', task='task0', program='main')]: return []
        if data.get('remoteDevices') or data.get('servers'): return []
        if json.loads((project/'devices/pin-mapping.json').read_text(encoding='utf-8-sig')) not in ({}, []): return []
        if [p.relative_to(project).as_posix() for p in (project/'pous').rglob('*') if p.is_file()] != ['pous/programs/main.ld']: return []
        clean = re.sub(r'\(\*[\s\S]*?\*\)|//[^\r\n]*', ' ', program).upper()
        main = re.findall(r'(?m)^\s*PROGRAM\s+MAIN\s*$(.*?)\bEND_PROGRAM\b', clean, re.S)
        if len(main) != 1: return []
        sections = re.findall(r'\bVAR\s+(.*?)\bEND_VAR\b', main[0], re.S)
        if len(sections) != 1: return []
        pins = re.findall(r'\b(START|STOP|MOTOR)\s*:\s*BOOL\s*:=\s*FALSE\s*;', sections[0])
        if sorted(pins) != ['MOTOR', 'START', 'STOP']: return []
        if re.search(r'\b(?:START|STOP)\s*:=', main[0].split('END_VAR', 1)[1]): return []
        if len({(v['arrayIdx'], v['elemIdx']) for v in leaves}) != len(leaves): return []
        for path in (*LOCAL_INPUT_PATHS, 'INSTANCE0.MOTOR'):
            matches = [v for v in leaves if v['path'] == path]
            if len(matches) != 1 or matches[0]['type'] != 'BOOL' or matches[0]['size'] != 1: return []
        return list(LOCAL_INPUT_PATHS)
    except (KeyError, TypeError, ValueError, OSError): return []

def input_leaves(manifest, leaves):
    if manifest.get('mode') != 'local' or manifest.get('locatedAddresses') or manifest.get('localInputPaths') != list(LOCAL_INPUT_PATHS): return {}
    if len({(v['arrayIdx'], v['elemIdx']) for v in leaves}) != len(leaves): return {}
    result = {}
    for path in LOCAL_INPUT_PATHS:
        matches = [v for v in leaves if v.get('path') == path]
        if len(matches) != 1 or matches[0].get('type') != 'BOOL' or matches[0].get('size') != 1: return {}
        result[path] = matches[0]
    return result

def validate_input_request(request, manifest, leaves, runtime_state, fresh):
    allowed = input_leaves(manifest, leaves)
    if request.get('inputPath') not in allowed or type(request.get('value')) is not bool:
        raise ValueError('Only validated local Start/Stop BOOL inputs may be changed')
    if runtime_state != 'RUNNING' or not fresh: raise ValueError('Input pulses require RUNNING with fresh telemetry')
    return allowed[request['inputPath']]

def write_bool_input(client, leaf, value):
    forcing = value is not None
    if forcing and type(value) is not bool: raise ValueError('Local input value must be boolean')
    packet = bytes([0x42, leaf['arrayIdx']]) + struct.pack('>H', leaf['elemIdx']) + bytes([int(forcing)]) + struct.pack('>H', int(forcing))
    if forcing: packet += bytes([int(value)])
    if client.debug(packet) != b'\x42\x7e': raise RuntimeError('Local input write rejected: '+leaf['path'])

def clear_local_inputs(client, allowed):
    for path in allowed: write_bool_input(client, allowed[path], False)
    for path in allowed: write_bool_input(client, allowed[path], None)
