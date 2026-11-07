"""Install pinned native FUXA and apply the small reproducible PLCdev extension hooks."""
from pathlib import Path
import argparse, hashlib, json, re, shutil, subprocess
from plcdev_environment import tool_path
ROOT=Path(__file__).resolve().parents[1]
PACKAGE='@frangoteam/fuxa@1.3.5'
DEFAULT=tool_path('fuxaPackage').parents[2]
def install(destination=DEFAULT,skip_install=False):
    destination=destination.resolve();package=destination/'node_modules/@frangoteam/fuxa'
    if not skip_install:
        npm=shutil.which('npm.cmd') or shutil.which('npm')
        if not npm:raise RuntimeError('Node.js and npm are required')
        lock=json.loads((ROOT/'config/fuxa.package-lock.json').read_text(encoding='utf-8'))
        if lock['packages']['node_modules/@frangoteam/fuxa']['version']!='1.3.5':raise RuntimeError('Pinned FUXA lock differs')
        destination.mkdir(parents=True,exist_ok=True)
        (destination/'package.json').write_text(json.dumps(lock['packages'][''],indent=2)+'\n',encoding='utf-8')
        (destination/'package-lock.json').write_text(json.dumps(lock,indent=2)+'\n',encoding='utf-8')
        subprocess.run([npm,'ci','--prefix',str(destination),'--omit=dev','--no-audit','--no-fund'],check=True,cwd=ROOT)
    version=json.loads((package/'package.json').read_text())['version']
    if version!='1.3.5':raise RuntimeError('Expected pinned FUXA 1.3.5, got '+version)
    changes=[(package/'main.js','const app = express();','const app = express();\n// PLCDEV_EXTENSION_HOOK\nif (process.env.PLCDEV_FUXA_EXTENSION) require(process.env.PLCDEV_FUXA_EXTENSION).mount(app);'),
             (package/'dist/index.html','</head>','<link rel="stylesheet" href="/plcdev/extension.css"><script defer src="/plcdev/extension.js"></script><!-- PLCDEV_EXTENSION_HOOK --></head>')]
    evidence=[]
    for file,anchor,replacement in changes:
        content=file.read_text(encoding='utf-8');backup=file.with_name(file.name+'.plcdev-original')
        if 'PLCDEV_EXTENSION_HOOK' not in content:
            if content.count(anchor)!=1:raise RuntimeError('Unexpected upstream hook in '+str(file))
            if not backup.exists():shutil.copy2(file,backup)
            file.write_text(content.replace(anchor,replacement),encoding='utf-8')
        evidence.append({'file':str(file.relative_to(package)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'originalSha256':hashlib.sha256(backup.read_bytes()).hexdigest() if backup.exists() else None})
    # Upstream SVG editor treats text content as a pseudo-attribute. Keep this
    # targeted vendor correction reproducible without rebuilding Angular.
    for patch_name in ('fuxa-text-undo.patch.json','fuxa-property-dialog.patch.json'):
        patch=json.loads((ROOT/'software/fuxa-integration'/patch_name).read_text(encoding='utf-8'))
        file=package/patch['file'];content=file.read_text(encoding='utf-8');backup=file.with_name(file.name+'.plcdev-original')
        if patch['id'] not in content:
            if hashlib.sha256(file.read_bytes()).hexdigest()!=patch['upstreamSha256']:
                raise RuntimeError('Unexpected upstream asset; review '+patch_name+' before applying')
            for change in patch['replacements']:
                if content.count(change['before'])!=1:raise RuntimeError('Unexpected patch anchor: '+patch_name)
                content=content.replace(change['before'],change['after'])
            if not backup.exists():shutil.copy2(file,backup)
            file.write_text(content+'\n// '+patch['id']+'\n',encoding='utf-8')
        elif any(content.count(change['after'])!=1 for change in patch['replacements']):
            raise RuntimeError('Patch marker exists but implementation differs: '+patch_name)
        evidence.append({'file':patch['file'],'patch':patch['id'],'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'originalSha256':hashlib.sha256(backup.read_bytes()).hexdigest() if backup.exists() else None})
    # PLCdev-created profiles inherit this default. FUXA's own saved language
    # preference still takes precedence; no user profile or project is edited.
    file=package/'settings.default.js';backup=file.with_name(file.name+'.plcdev-original')
    original_hash='435c73bd98c96272b134f96ed50df857afea84533ef9381dd4951c87c0a6623c'
    raw=file.read_bytes()
    if not backup.exists():
        if hashlib.sha256(raw).hexdigest()!=original_hash:raise RuntimeError('Unexpected FUXA default settings')
        shutil.copy2(file,backup)
    baseline=backup.read_bytes()
    if hashlib.sha256(baseline).hexdigest()!=original_hash:raise RuntimeError('Unexpected FUXA default settings backup')
    anchor=b"language: 'en'";replacement=b"language: 'zh-cn'"
    if baseline.count(anchor)!=1:raise RuntimeError('Unexpected default language anchor')
    localized=baseline.replace(anchor,replacement)
    if raw not in (baseline,localized):raise RuntimeError('Unexpected modification to FUXA default settings')
    if raw!=localized:file.write_bytes(localized)
    evidence.append({'file':'settings.default.js','patch':'plcdev-default-zh-cn','sha256':hashlib.sha256(localized).hexdigest(),'originalSha256':original_hash})

    # Keep the upstream catalogue and merge only reviewed UI translations.
    file=package/'dist/assets/i18n/zh-cn.json';backup=file.with_name(file.name+'.plcdev-original')
    original_hash='f483802756dc9f7811e3c14d2ea66f73093b01fac8d283546c8032b7b9494cf7'
    if not backup.exists():
        if hashlib.sha256(file.read_bytes()).hexdigest()!=original_hash:raise RuntimeError('Unexpected FUXA Chinese catalogue')
        shutil.copy2(file,backup)
    baseline=backup.read_bytes()
    if hashlib.sha256(baseline).hexdigest()!=original_hash:raise RuntimeError('Unexpected FUXA Chinese catalogue backup')
    original=json.loads(baseline);current=json.loads(file.read_text(encoding='utf-8'))
    overrides=json.loads((ROOT/'software/fuxa-integration/zh-cn-overrides.json').read_text(encoding='utf-8'))
    if set(current)!=set(original) or not set(overrides)<=set(original):raise RuntimeError('Unexpected FUXA Chinese catalogue keys')
    if any(current[k]!=v for k,v in original.items() if k not in overrides):raise RuntimeError('Unexpected modification to FUXA Chinese catalogue')
    for key,value in overrides.items():
        if not isinstance(value,str) or sorted(re.findall(r'{{\s*[^{}]+?\s*}}',value))!=sorted(re.findall(r'{{\s*[^{}]+?\s*}}',original[key])):
            raise RuntimeError('Invalid Chinese translation parameters: '+key)
    original.update(overrides)
    file.write_text(json.dumps(original,ensure_ascii=False,indent=4)+'\n',encoding='utf-8')
    evidence.append({'file':'dist/assets/i18n/zh-cn.json','patch':'plcdev-zh-cn-overrides','count':len(overrides),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'originalSha256':original_hash})
    record={'package':PACKAGE,'version':version,'source':'https://github.com/frangoteam/FUXA/releases/tag/v1.3.5','packageRoot':str(package),'patches':evidence}
    (destination/'plcdev-install.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
    return record
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',type=Path,default=DEFAULT);p.add_argument('--skip-install',action='store_true');a=p.parse_args();print(json.dumps(install(a.directory,a.skip_install),ensure_ascii=False))
