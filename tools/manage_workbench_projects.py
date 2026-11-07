"""Register or import the user's own source before starting a source-only workbench."""
import argparse,json
from pathlib import Path
from factoryio_runtime import ROOT
from workbench_projects import ProjectCatalog

def catalog(state):
    state=Path(state).resolve()
    if not state.is_relative_to(ROOT/'outputs') or state==ROOT/'outputs':raise ValueError('Use an explicit state directory under outputs')
    return ProjectCatalog(index_path=state/'projects.json')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state',type=Path,required=True)
    commands=p.add_subparsers(dest='verb',required=True)
    opened=commands.add_parser('open');opened.add_argument('--manifest',type=Path,required=True)
    created=commands.add_parser('create');created.add_argument('--parent',type=Path,required=True);created.add_argument('--name',required=True);created.add_argument('--language',choices=['ld','st'],default='st')
    imported=commands.add_parser('import');imported.add_argument('--source',type=Path,required=True);imported.add_argument('--parent',type=Path,required=True);imported.add_argument('--name',required=True)
    a=p.parse_args();c=catalog(a.state)
    if a.verb=='open':project=c.open(str(a.manifest.resolve()))
    else:project=c.create(a.name,str(a.parent.resolve()),language=getattr(a,'language','st'),source=str(a.source.resolve()) if a.verb=='import' else None)
    print(json.dumps({'projectId':project['id'],'manifestPath':project['manifestPath'],'servicesStarted':False,'runtimeStarted':False,'modelCalls':0},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
