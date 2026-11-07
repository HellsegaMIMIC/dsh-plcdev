"""Ordinary projects use a common local lifecycle and optional declared operations."""
import json
import math
import os
from pathlib import Path
import shutil
import time
from factoryio_runtime import ROOT, sha, store
from project_interface import MISSING, bind_interface, interface_hash, operation_value, validate_interface
from project_interface_inputs import assert_local_project
from workbench_start_stop import LocalProjectManager, read


class UserProjectManager(LocalProjectManager):
    def __init__(self, instance, project_config):
        if project_config.get('kind') != 'user' or project_config.get('defaultMode') not in ('local', 'fuxa-local'):
            raise ValueError('用户工程需要本机隔离 Runtime 目标')
        super().__init__(instance, project_config)
        self.interface_definition = (validate_interface(project_config['interfaceDefinition'])
                                     if project_config.get('interfaceDefinition') is not None else None)
        self.supports_inputs = bool(self.interface_definition and any(item['enabled'] for item in self.interface_definition['operations']))
        self._interface_bindings = {}
        self._interface_manifest_hash = (sha(Path(project_config['manifestPath'])) if self.interface_definition else None)

    def _assert_interface_current(self):
        if self.interface_definition is None:
            raise ValueError('本工程未声明变量操作接口')
        path = Path(self.project['interfacePath'])
        current = validate_interface(json.loads(path.read_text(encoding='utf-8-sig')))
        if (interface_hash(current) != interface_hash(self.interface_definition)
                or sha(Path(self.project['manifestPath'])) != self._interface_manifest_hash):
            raise ValueError('工程接口已改变，请结束旧会话并重新打开／编译')
        return current

    def configure_inputs(self, run, manifest, compiled_project):
        if self.interface_definition is None:
            return super().configure_inputs(run, manifest, compiled_project)
        definition = self._assert_interface_current()
        leaves = read(run / 'runtime/core/generated/debug-map.json')['leaves']
        program = (run / 'runtime/core/generated/program.st').read_text(encoding='utf-8-sig')
        if manifest.get('physicalHardware') is not False or manifest.get('locatedAddresses'):
            raise ValueError('工程接口只允许无地址映射、无实体设备的隔离 Runtime')
        assert_local_project(compiled_project, manifest.get('mode'), program)
        for name in ('plugins.conf', 'vpp_plugins.conf'):
            if any(line.strip() and not line.lstrip().startswith('#')
                   for line in (run / 'runtime' / name).read_text(encoding='utf-8').splitlines()):
                raise ValueError('工程接口 Runtime 不能加载设备插件')
        bound = bind_interface(definition, leaves)
        frozen = Path(compiled_project) / 'project-interface.json'
        store(frozen, definition)
        for source, destination in [('project_interface_inputs.py', 'editor_runtime_inputs.py'),
                                    ('project_interface.py', 'project_interface.py')]:
            shutil.copyfile(ROOT / 'tools' / source, run / destination)
            manifest['preparedHashes'][destination] = sha(run / destination)
            manifest.setdefault('patches', []).append(dict(file=destination, scope='declared project local session only',
                                                          source=str(ROOT / 'tools' / source), sha256=sha(run / destination)))
        manifest['preparedHashes'][Path(os.path.relpath(frozen, run)).as_posix()] = sha(frozen)
        manifest['projectInterface'] = definition
        manifest['projectInterfaceHash'] = interface_hash(definition)
        manifest['localInputPaths'] = [bound[item['id']]['path'] for item in definition['variables'] if item['access'] == 'readwrite']
        self._interface_bindings = bound
        self._assert_interface_current()

    def _operation_snapshot(self):
        # Subclass presentation can hide the legacy input UI without disabling
        # this declared-operation capability in the local lifecycle.
        return super().snapshot()

    def perform_operation(self, operation_id, value=MISSING, *, expires=None, session_id=MISSING, guard=None):
        """Apply one declared operation; lifecycle actions cannot interleave a pulse."""
        with self.action_lock:
            if session_id is not MISSING and session_id != (self.manifest or {}).get('sessionId'):
                raise ValueError('会话已更换，旧工程操作已拒绝')
            if expires is not None and (type(expires) not in (int, float) or not math.isfinite(expires)
                                        or not time.time() <= expires <= time.time() + 15):
                raise ValueError('工程操作已过期')
            definition = self._assert_interface_current()
            if (not self.manifest or self.manifest.get('projectInterfaceHash') != interface_hash(definition)
                    or not self._operation_snapshot()['capabilities'].get('canInput')):
                raise ValueError('操作需要本工程当前声明、已运行的会话及实时变量')
            operation, variable, selected = operation_value(definition, operation_id, value)
            leaf = self._interface_bindings.get(variable['id'])
            if leaf is None:
                raise ValueError('操作变量尚未经编译映射核对')
            fields = dict(inputPath=leaf['path'], operationId=operation_id,
                          projectInterfaceHash=self.manifest['projectInterfaceHash'])
            if guard is not None:
                guard()
            if operation['kind'] == 'pulse':
                try:
                    applied = self.request('set-input', **fields, value=True, operationPhase='apply')
                    time.sleep(operation['durationMs'] / 1000)
                finally:
                    try:
                        released = self.request('set-input', **fields, value=False, operationPhase='release')
                    except Exception:
                        try:
                            self.request('stop')
                        finally:
                            self.event('脉冲释放未确认，已请求停止所属 Runtime；请查看会话状态。')
                        raise
                result = dict(ok=True, operationId=operation_id, variable=variable['id'], value=True,
                              released=True, applied=applied, release=released)
            else:
                applied = self.request('set-input', **fields, value=selected, operationPhase='apply')
                result = dict(ok=True, operationId=operation_id, variable=variable['id'], value=selected, applied=applied)
            self.event('工程操作已确认：' + operation['label'])
            return result
