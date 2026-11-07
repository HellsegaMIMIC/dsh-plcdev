"""Inspect a public source tree; never print matched secret values or start applications."""
from pathlib import Path
import argparse,hashlib,json,re,sys

SKIP={'.git','node_modules','__pycache__','lib','.tools','outputs'}
FORBIDDEN_NAMES={'controller.json','service.json','dsh-launch.json','team-model-scope.json','cookies.json','credentials.json','secrets.json'}
PATTERNS={
 'provider-key':re.compile(r'\bsk-[A-Za-z0-9_-]{24,}\b'),
 'github-token':re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'),
 'private-key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'authenticated-local-url':re.compile(r'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]{12,}'),
 'personal-machine-path':re.compile(r'(?:D:[\\/]Projects[\\/]|C:[\\/]Users[\\/]Lenovo[\\/]|wxid_[0-9a-z_]+)',re.I),
}

def audit(root):
    root=Path(root).resolve();findings=[];files={}
    for path in sorted(root.rglob('*')):
        relative=path.relative_to(root)
        if any(p in SKIP for p in relative.parts):continue
        if path.is_symlink() or getattr(path.lstat(),'st_file_attributes',0)&0x400:
            findings.append(dict(file=relative.as_posix(),rule='linked-path'));continue
        if not path.is_file():continue
        name=path.name.lower()
        if name in FORBIDDEN_NAMES or name.startswith('.env') and name not in ('.env.example','.env.sample') or path.suffix.lower() in ('.sqlite','.sqlite3','.db','.exe','.dll','.pem','.key','.ndjson'):
            findings.append(dict(file=relative.as_posix(),rule='private-or-binary-file'))
        raw=path.read_bytes();files[relative.as_posix()]=hashlib.sha256(raw).hexdigest()
        try:text=raw.decode('utf-8-sig')
        except UnicodeDecodeError:continue
        for label,pattern in PATTERNS.items():
            for match in pattern.finditer(text):findings.append(dict(file=relative.as_posix(),line=text.count('\n',0,match.start())+1,rule=label))
    manifest=root/'SOURCE-MANIFEST.json'
    integrity=[]
    if manifest.exists():
        expected=json.loads(manifest.read_text(encoding='utf-8'))['files']
        for name,digest in expected.items():
            if files.get(name)!=digest:integrity.append(name)
        for name in files:
            if name not in expected and name!='SOURCE-MANIFEST.json':integrity.append(name)
    return dict(passed=not findings and not integrity,filesChecked=len(files),findings=findings,manifestDifferences=integrity,automaticScanIsNotCompletePrivacyProof=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path);p.add_argument('--report',type=Path);a=p.parse_args();r=audit(a.root)
    if a.report:a.report.write_text(json.dumps(r,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(r,indent=2));sys.exit(0 if r['passed'] else 1)
