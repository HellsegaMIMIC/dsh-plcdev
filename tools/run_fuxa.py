"""Run isolated loopback-only native FUXA. Does not start or manage PLC Runtime."""
from pathlib import Path
import argparse,json,os,shutil,subprocess,sys
from install_fuxa import ROOT,DEFAULT,install
from fuxa_ai_request import APPROVED_PROFILE
from plcdev_environment import tool_path


def ai_environment(enabled=False,profile=None,helper_json=None):
    """Register the local executor, without reading credentials or enabling it implicitly.

    The server treats AI_ENABLED as an initial default only. Its saved sidebar
    preference takes precedence, including a saved false value.
    """
    env={'PLCDEV_FUXA_AI_ENABLED':'1' if enabled else '0'}
    if helper_json is not None:
        if not enabled:raise ValueError('--ai-helper-argv requires --enable-approved-ai')
        try:helper=json.loads(helper_json)
        except (TypeError,ValueError):raise ValueError('AI helper argv must be a nonempty list of strings') from None
        if not isinstance(helper,list) or not helper or any(not isinstance(item,str) or not item or '\0' in item for item in helper):
            raise ValueError('AI helper argv must be a nonempty list of strings')
        # Custom executors have no assumed --check protocol.
    else:
        helper=[sys.executable,str(ROOT/'tools/fuxa_ai_request.py'),'--profile',str(Path(profile or APPROVED_PROFILE).resolve())]
        env['PLCDEV_FUXA_AI_CHECK_COMMAND_JSON']=json.dumps([*helper,'--check'])
    env['PLCDEV_FUXA_AI_COMMAND_JSON']=json.dumps(helper)
    return env


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--profile',type=Path,required=True);p.add_argument('--session-file',type=Path);p.add_argument('--port',type=int,default=18810);p.add_argument('--directory',type=Path,default=DEFAULT);p.add_argument('--ai-profile',type=Path);p.add_argument('--ai-helper-argv');p.add_argument('--enable-approved-ai',action='store_true');a=p.parse_args()
    if not 1024<=a.port<=65535:raise ValueError('Invalid local port')
    ai_env=ai_environment(a.enable_approved_ai,a.ai_profile,a.ai_helper_argv)
    record=install(a.directory,skip_install=True);package=Path(record['packageRoot']);profile=a.profile.resolve();work=profile/'_appdata';work.mkdir(parents=True,exist_ok=True)
    settings=work/'settings.js'
    if not settings.exists():settings.write_text('module.exports={...require('+json.dumps(str(package/'settings.default.js'))+'),uiHost:"127.0.0.1",uiPort:'+str(a.port)+',nodeRedEnabled:false,daqEnabled:false,secureEnabled:false,swaggerEnabled:false,logApiLevel:"none",hideEditorOnboarding:true};\n',encoding='utf-8')
    env=dict(os.environ,PLCDEV_FUXA_ROOT=str(package),PLCDEV_FUXA_PROFILE=str(profile),PLCDEV_FUXA_PORT=str(a.port),PLCDEV_FUXA_EXTENSION=str(ROOT/'software/fuxa-integration/server-plugin.cjs'),PLCDEV_FUXA_AI_ENABLED='0')
    if a.session_file:env['PLCDEV_FUXA_SESSION_FILE']=str(a.session_file.resolve())
    env.pop('PLCDEV_FUXA_AI_CHECK_COMMAND_JSON',None)
    env.update(ai_env)
    node=str(tool_path('node'))
    if not node:raise RuntimeError('Node.js required')
    raise SystemExit(subprocess.call([node,str(package/'main.js'),'--port',str(a.port),'--userDir',str(profile)],cwd=package,env=env))
if __name__=='__main__':main()
