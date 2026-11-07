"""Release scanner negative cases; synthetic values are never reported."""
import hashlib,json,tempfile,unittest
from pathlib import Path
from verify_source_release import audit

class ReleaseAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        (self.root/'safe.txt').write_text('source',encoding='utf-8');self.manifest()
    def manifest(self):
        files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.iterdir() if p.is_file() and p.name!='SOURCE-MANIFEST.json'}
        (self.root/'SOURCE-MANIFEST.json').write_text(json.dumps({'files':files}),encoding='utf-8')
    def test_clean_manifest(self):self.assertTrue(audit(self.root)['passed'])
    def test_secret_and_auth_state_are_rejected_without_value(self):
        value='sk-'+'A'*32
        (self.root/'credentials.json').write_text(json.dumps({'key':value}),encoding='utf-8')
        report=audit(self.root)
        self.assertFalse(report['passed']);self.assertNotIn(value,json.dumps(report))
        self.assertEqual({'provider-key','private-or-binary-file'},{r['rule'] for r in report['findings']})
    def test_changed_extra_and_missing_files_fail(self):
        (self.root/'safe.txt').write_text('changed',encoding='utf-8');(self.root/'extra.txt').write_text('extra',encoding='utf-8')
        self.assertEqual({'safe.txt','extra.txt'},set(audit(self.root)['manifestDifferences']))
        (self.root/'safe.txt').unlink();self.assertIn('safe.txt',audit(self.root)['manifestDifferences'])
    def test_local_auth_url_and_personal_paths_fail(self):
        text='http://127.0.0.1:55100/?token='+'B'*16+'\n'+'C:'+'/Users/'+'Lenovo/'+'private.txt'
        (self.root/'safe.txt').write_text(text,encoding='utf-8')
        self.assertEqual({'authenticated-local-url','personal-machine-path'},{r['rule'] for r in audit(self.root)['findings']})

if __name__=='__main__':unittest.main()
