"""Bounded teaching inputs for the native CounterRecovery example; never arbitrary debug writes."""
from __future__ import annotations
import json
from pathlib import Path
import re
import struct

INPUT_NAMES = ('START', 'STOP', 'PULSE', 'FAULT', 'RESET', 'PERMIT')
LOCAL_INPUT_PATHS = tuple('INSTANCE0.' + name + side for side in 'AB' for name in INPUT_NAMES)


def counter_input_paths(project, mode, program, leaves):
    """Fail closed for other programs, mappings or languages, while still allowing read-only monitoring."""
    if mode != 'local' or re.search(r'\bAT\s*%|\{\s*external', program, re.I):
        return []
    try:
        project = Path(project)
        data = json.loads((project / 'project.json').read_text(encoding='utf-8-sig'))['data']
        resource = data['configuration']['resource']
        if resource['globalVariables'] or resource['instances'] != [dict(name='instance0', task='task0', program='main')]:
            return []
        if data.get('remoteDevices') or data.get('servers'):
            return []
        if json.loads((project / 'devices/pin-mapping.json').read_text(encoding='utf-8-sig')) not in ({}, []):
            return []
        expected = ['pous/function-blocks/CounterRecovery.ld', 'pous/programs/main.ld']
        if sorted(p.relative_to(project).as_posix() for p in (project / 'pous').rglob('*') if p.is_file()) != expected:
            return []
        for relative in expected:
            if re.search(r'\bAT\s*%|\{\s*external', (project / relative).read_text(encoding='utf-8-sig'), re.I):
                return []
        # Work against compiler output, not merely file names supplied by a project.
        clean = re.sub(r'\(\*[\s\S]*?\*\)|//[^\r\n]*', ' ', program).upper()
        fb = re.findall(r'\bFUNCTION_BLOCK\s+COUNTERRECOVERY\b(.*?)\bEND_FUNCTION_BLOCK\b', clean, re.S)
        main = re.findall(r'(?m)^\s*PROGRAM\s+MAIN\s*$(.*?)\bEND_PROGRAM\b', clean, re.S)
        if len(fb) != 1 or len(main) != 1:
            return []
        input_sections = re.findall(r'\bVAR_INPUT\b(.*?)\bEND_VAR\b', fb[0], re.S)
        if len(input_sections) != 1:
            return []
        pins = re.findall(r'\b([A-Z_]\w*)\s*:\s*([A-Z_]\w*)\s*(?::=\s*(?:FALSE|0))?\s*;', input_sections[0])
        if set(pins) != {(name, 'BOOL') for name in INPUT_NAMES} or len(pins) != 6:
            return []
        for side in 'AB':
            if not re.search(r'\bCHANNEL' + side + r'\s*:\s*COUNTERRECOVERY\s*;', main[0]):
                return []
            calls = re.findall(r'\bCHANNEL' + side + r'\s*\(([^;]*)\)\s*;', main[0])
            if len(calls) != 1 or not re.search(r'\bEN\s*:=\s*TRUE\b', calls[0]):
                return []
            for name in INPUT_NAMES:
                if not re.search(r'\b' + name + side + r'\s*:\s*BOOL\s*:=\s*FALSE\s*;', main[0]):
                    return []
                if not re.search(r'\b' + name + r'\s*:=\s*' + name + side + r'\b', calls[0]):
                    return []
                # The external teaching input must not also be assigned by the program body.
                if re.search(r'\b' + name + side + r'\s*:=', main[0]):
                    return []
        positions = [(v['arrayIdx'], v['elemIdx']) for v in leaves]
        if len(positions) != len(set(positions)):
            return []
        for path in LOCAL_INPUT_PATHS:
            matches = [v for v in leaves if v['path'] == path]
            if len(matches) != 1 or matches[0]['type'] != 'BOOL' or matches[0]['size'] != 1:
                return []
        return list(LOCAL_INPUT_PATHS)
    except (KeyError, TypeError, ValueError, OSError):
        return []


def input_leaves(manifest, leaves):
    if manifest.get('mode') != 'local' or manifest.get('locatedAddresses') or manifest.get('localInputPaths') != list(LOCAL_INPUT_PATHS):
        return {}
    result = {}
    for path in LOCAL_INPUT_PATHS:
        matches = [v for v in leaves if v.get('path') == path]
        if len(matches) != 1 or matches[0].get('type') != 'BOOL' or matches[0].get('size') != 1:
            return {}
        result[path] = matches[0]
    positions = [(v['arrayIdx'], v['elemIdx']) for v in leaves]
    return result if len(positions) == len(set(positions)) else {}


def validate_input_request(request, manifest, leaves, runtime_state, fresh):
    allowed = input_leaves(manifest, leaves)
    path, value = request.get('inputPath'), request.get('value')
    if not isinstance(path, str) or path not in allowed or type(value) is not bool:
        raise ValueError('Only the twelve validated local CounterRecovery BOOL inputs may be changed')
    if runtime_state != 'RUNNING' or not fresh:
        raise ValueError('Local input changes require RUNNING with fresh telemetry')
    return allowed[path]


def write_bool_input(client, leaf, value):
    forcing = value is not None
    if forcing and type(value) is not bool:
        raise ValueError('Local input value must be boolean')
    packet = bytes([0x42, leaf['arrayIdx']]) + struct.pack('>H', leaf['elemIdx']) + bytes([int(forcing)]) + struct.pack('>H', int(forcing))
    if forcing:
        packet += bytes([int(value)])
    if client.debug(packet) != b'\x42\x7e':
        raise RuntimeError('Local input write was rejected: ' + leaf['path'])


def clear_local_inputs(client, allowed):
    # Remove permission before releasing other inputs. unforce alone leaves the
    # raw IECVar value unchanged, so explicitly write FALSE before unforcing.
    paths = sorted(allowed, key=lambda path: ('.PERMIT' not in path, path))
    for path in paths:
        write_bool_input(client, allowed[path], False)
    for path in paths:
        write_bool_input(client, allowed[path], None)
