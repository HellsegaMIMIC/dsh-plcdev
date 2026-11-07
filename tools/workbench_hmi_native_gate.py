"""Mandatory local FUXA behavior gate. Unavailable/unpinned/incomplete => deny."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import subprocess

from workbench_agent_adapters import AdapterError

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'tools/fuxa_permission_engine.json'
POLICY = 'fuxa-native-permission-nonexpansion-v1'
RECEIPT_VERSION = 2
MAX_ROLES = 4
SCOPE = 'bounded native DOM and pinned native authorization; no real browser events or runtime commands'
INVARIANTS = [
    'ASCII raw SVG preserves JavaScript UTF-16 lowercase offsets',
    'XML and HTML DOM equality',
    'no increased visible/editable/Enter/click/event/script capabilities',
    'readonly and disabled never removed',
    'native hidden/disabled decisions actually applied',
]


def reject(message):
    raise AdapterError('not_ready', '未能证明原生HMI权限不扩大：' + message)


def _sha(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _object(raw):
    def unique(pairs):
        value = {}
        for key, child in pairs:
            if key in value: raise ValueError('重复JSON字段')
            value[key] = child
        return value
    def invalid_constant(value):
        raise ValueError('非有限JSON数值：' + value)
    if type(raw) is not str: raise ValueError('JSON回执不是文本')
    value = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant)
    if type(value) is not dict: raise ValueError('JSON根必须是对象')
    return value


def _serialize(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False)


def _request_payload(source, candidate):
    from workbench_hmi_permissions import _index
    _, _, old, _ = _index(source); _, _, new, _ = _index(candidate)
    if set(old) != set(new): reject('原交互集合不一致。')
    pairs = [{'key': key, 'source': old[key]['item']['id'], 'candidate': new[key]['item']['id']} for key in sorted(old)]
    # Hash exact serialized resource bytes, without Python/JS number or key
    # ordering ambiguities. The native checker parses these very same strings.
    return _serialize({'receiptVersion': RECEIPT_VERSION, 'source': _serialize(source),
                       'candidate': _serialize(candidate), 'pairs': pairs})


def _roles(project):
    names = set()
    def visit(value):
        if type(value) is list:
            for child in value: visit(child)
        elif type(value) is dict:
            roles = value.get('permissionRoles')
            if type(roles) is dict:
                for key in ('show', 'enabled'):
                    if type(roles.get(key)) is list: names.update(roles[key])
            for child in value.values(): visit(child)
    visit(project)
    if len(names) > MAX_ROLES: reject('角色状态空间超过四角色上限。')
    # JS Array.sort() orders UTF-16 code units, not Unicode scalar values.
    return sorted(names, key=lambda name: name.encode('utf-16-be'))


def _expectations(payload, engine):
    request = _object(payload)
    if set(request) != {'receiptVersion', 'source', 'candidate', 'pairs'} or not _sha(engine):
        reject('检查请求或引擎身份无效。')
    source, candidate = _object(request['source']), _object(request['candidate'])
    if _request_payload(source, candidate) != payload:
        reject('请求版本、序列化或交互映射不一致。')
    roles = _roles(source)
    if roles != _roles(candidate): reject('源／候选角色集合不同。')
    # Two security modes; 261 mask principals plus all role subsets (and one
    # unlisted-role class) * four group classes, plus six missing identities.
    count = 2 * (261 + (2 ** len(roles) + 1) * 4 + 6)
    digest = lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest()
    return {'receiptVersion': RECEIPT_VERSION, 'ok': True, 'allNonexpanding': True,
            'policy': POLICY, 'engineDigest': engine, 'inputDigest': digest(payload),
            'sourceDigest': digest(request['source']), 'candidateDigest': digest(request['candidate']),
            'roles': roles, 'profileCount': count,
            'controlsChecked': (count + 1) * len(request['pairs']),
            'invariant': INVARIANTS, 'scope': SCOPE}


def _validate_receipt(audit, expected):
    if set(audit) != set(expected) | {'parseProofs', 'outcomeDigest'}:
        reject('检查回执字段不完整或含未知字段。')
    for name, value in expected.items():
        if type(audit[name]) is not type(value) or audit[name] != value:
            reject('检查回执字段、类型或覆盖范围不一致：' + name)
    proof = audit['parseProofs']
    if (type(proof) is not dict or set(proof) != {'source', 'candidate'}
            or not all(_sha(value) for value in proof.values()) or not _sha(audit['outcomeDigest'])):
        reject('DOM／结果证明字段无效。')


def engine_identity():
    try:
        raw = PIN.read_bytes(); manifest = _object(raw.decode('utf-8'))
        if (set(manifest) != {'policy', 'fuxaVersion', 'maxDistinctRoles', 'files'}
                or manifest['policy'] != POLICY or manifest['fuxaVersion'] != '1.3.5'
                or type(manifest['maxDistinctRoles']) is not int or manifest['maxDistinctRoles'] != MAX_ROLES
                or type(manifest['files']) is not dict or not manifest['files']):
            reject('固定原生引擎清单格式或策略无效。')
        for name, expected in manifest['files'].items():
            path = (ROOT / name).resolve()
            if not _sha(expected) or not path.is_relative_to(ROOT.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                reject('固定原生引擎或解析器文件不一致：' + name)
        return hashlib.sha256(raw).hexdigest()
    except AdapterError:
        raise
    except Exception as error:
        reject('固定原生引擎不可用：' + str(error))


@lru_cache(maxsize=32)
def _verify(payload, engine):
    try:
        expected = _expectations(payload, engine)
        result = subprocess.run(['node', str(ROOT / 'tools/fuxa_native_permission_gate.cjs')],
            input=payload, text=True, encoding='utf-8', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=ROOT, timeout=45, check=False)
        if result.returncode != 0: reject('实际过滤／DOM检查失败：' + result.stderr[-600:])
        audit = _object(result.stdout)
        _validate_receipt(audit, expected)
        # lru_cache stores a value only after every validation has succeeded.
        # Immutable serialized receipts prevent callers mutating cached proof.
        return _serialize(audit)
    except AdapterError:
        raise
    except Exception as error:
        reject('原生检查不可用／超时／回执损坏：' + str(error))


def verify_native_permissions(source, candidate):
    # Re-check pins even on a cached pair. A successful previous check cannot
    # hide a changed/unavailable engine. Caches contain successful checks only.
    try:
        engine = engine_identity()
        return _object(_verify(_request_payload(source, candidate), engine))
    except AdapterError:
        raise
    except Exception as error:
        reject('检查请求无法解释：' + str(error))
