"""A source-only distribution can import user sources without bundled examples."""
import json,tempfile,unittest
from pathlib import Path
from workbench_projects import load_projects,ProjectCatalog
from plcdev_workbench import Workspace

class EmptyCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.registry=self.root/'registry.json';self.registry.write_text(json.dumps({'schemaVersion':1,'defaultProjectId':None,'projects':[]}),encoding='utf-8')
    def test_explicit_empty_registry_and_workspace_do_not_require_examples(self):
        self.assertEqual((None,{}),load_projects(self.registry))
        workspace=Workspace('test',projects={},managers={});self.assertIsNone(workspace.default);self.assertEqual({},workspace.snapshots())
    def test_missing_nonempty_default_is_still_rejected(self):
        self.registry.write_text(json.dumps({'schemaVersion':1,'defaultProjectId':'missing','projects':[]}),encoding='utf-8')
        with self.assertRaises(ValueError):load_projects(self.registry)
    def test_import_preserves_native_source_and_registers_new_identity(self):
        source=self.root/'input';source.mkdir();entry=source/'project.json';raw=json.dumps({'meta':{'type':'plc-project'},'data':{}});entry.write_text(raw,encoding='utf-8')
        c=ProjectCatalog(registry_path=self.registry,index_path=self.root/'index.json')
        first=c.create('OwnProject',str(self.root/'copies'),source=str(source));second=c.create('SecondCopy',str(self.root/'copies'),source=str(source))
        self.assertNotEqual(first['id'],second['id']);self.assertEqual(raw,entry.read_text(encoding='utf-8'))
        self.assertEqual(raw,Path(first['plc']).read_text(encoding='utf-8'));self.assertEqual(2,len(c.refresh()))

if __name__=='__main__':unittest.main()
