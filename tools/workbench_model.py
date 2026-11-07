"""Project-owned numerical plant using the common Runtime/FUXA lifecycle."""
from pathlib import Path
import shutil
from factoryio_runtime import ROOT,sha
from workbench_start_stop import read
from workbench_interface import FuxaLocalManager
from workbench_user_project import UserProjectManager
from project_model_binding import validate_model_binding,bind_model,model_binding_hash

class ModelLocalManager(FuxaLocalManager):
    run_prefix='workbench-model'

    def __init__(self,instance,project_config):
        super().__init__(instance,project_config)
        if not self.project.get('hmi'):
            self.mode='local'
            self.message='本工程使用独立数值模型；编译后显式运行，可监视声明变量。未配置 HMI。'

    def dependencies(self):
        if not self.project.get('hmi'):
            return UserProjectManager.dependencies(self)
        return FuxaLocalManager.dependencies(self)

    def build(self):
        # Headless models use the same Runtime lifecycle without allocating an
        # unrelated FUXA profile, port or HTTP bridge. configure_inputs stays shared.
        if not self.project.get('hmi'):
            return UserProjectManager.build(self)
        return FuxaLocalManager.build(self)

    def snapshot(self):
        if self.project.get('hmi'):
            return FuxaLocalManager.snapshot(self)
        result=UserProjectManager.snapshot(self)
        changed=not self.current_configuration()
        locked=result['session']['active'] or result['phase'] in ('building','stopping')
        result.update(mode='local',toolsOpen=False,toolsStarting=[],toolErrors={},
                      configurationLocked=locked,configFingerprint=self.config_hash,
                      projectChanged=result['projectChanged'] or changed)
        result['session']['configFingerprint']=self.config_hash
        result['capabilities']['canConfigureInterface']=not locked
        if changed:
            result['capabilities'].update(canPrepare=False,canRun=False)
            reason='工程模型或接口声明已改变；结束所属会话并重新打开工程。'
            result['capabilities']['reasons'].update(canPrepare=reason,canRun=reason)
        return result

    def ensure_bridge(self):
        if not self.project.get('hmi'):
            raise ValueError('本工程未配置 HMI，不创建 FUXA 通信入口')
        return FuxaLocalManager.ensure_bridge(self)

    def tool(self,name):
        if not self.project.get('hmi'):
            if name in ('fuxa','eez','hmi'):
                raise ValueError('本工程未配置 HMI')
            return UserProjectManager.tool(self,name)
        return FuxaLocalManager.tool(self,name)

    def action(self,body):
        if not self.project.get('hmi'):
            return UserProjectManager.action(self,body)
        return FuxaLocalManager.action(self,body)

    def end(self):
        if not self.project.get('hmi'):
            return UserProjectManager.end(self)
        return FuxaLocalManager.end(self)

    def configure_inputs(self,run,manifest,compiled_project):
        if self.project.get('simulation',{}).get('provider')!='local-model':
            raise ValueError('Only explicit local-model configuration may execute numerically; OIP general-model driver is not implemented')
        super().configure_inputs(run,manifest,compiled_project)
        definition=validate_model_binding(read(Path(self.project['modelBindingsPath'])),self.interface_definition)
        if definition['model']['id']!='xyz_ptp_v1':raise ValueError('model implementation unavailable')
        bind_model(definition,read(run/'runtime/core/generated/debug-map.json')['leaves'],self.interface_definition)
        manifest['projectModel']=definition;manifest['projectModelHash']=model_binding_hash(definition)
        sources={ROOT/'tools/project_model_loop.py':'project_model_loop.py',ROOT/'tools/project_model_binding.py':'project_model_binding.py',ROOT/'tools/project_interface_inputs.py':'project_interface_inputs.py',ROOT/'software/simulation/xyz_model.py':'xyz_model.py'}
        for source,name in sources.items():
            shutil.copyfile(source,run/name);manifest['preparedHashes'][name]=sha(run/name)
        monitor=run/'editor_runtime_monitor.py';text=monitor.read_text(encoding='utf-8')
        changes=[
          ('    last_values, last_ticks, last_request = {}, [], None','    from project_model_loop import ProjectModelLoop, read_values as model_read_values\n    global read_values\n    read_values = model_read_values\n    model_loop = ProjectModelLoop(manifest, leaves, OUT)\n    last_values, last_ticks, last_request = {}, [], None'),
          ("            if state == 'RUNNING':\n                last_ticks, last_values = read_values(client, leaves)","            model_loop.step(client, state)\n            if state == 'RUNNING':\n                last_ticks, last_values = read_values(client, leaves)"),
          ('            time.sleep(0.15)','            time.sleep(0.005)'),
          ("        write_json(OUT / 'monitor-result.json', result)","        model_loop.close()\n        write_json(OUT / 'monitor-result.json', result)")]
        for before,after in changes:
            if text.count(before)!=1:raise ValueError('reviewed model monitor anchor changed')
            text=text.replace(before,after)
        monitor.write_text(text,encoding='utf-8');manifest['preparedHashes']['editor_runtime_monitor.py']=sha(monitor)
        manifest.setdefault('patches',[]).append(dict(file='editor_runtime_monitor.py',scope='model-bound zero-plugin session',source=str(ROOT/'tools/workbench_model.py'),sha256=sha(monitor)))
