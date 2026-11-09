"""Line RPC fixture for the offline DSH AgentLoop integration test, not a service.
Real candidate renderer and SQLite TaskStore; isolated copied teaching fixture.
No model, HTTP server, compiler, editor or Runtime is launched.
"""
import json
import sys
from unittest.mock import patch
from test_workbench_joint_candidate import JointTests
from agent_task_service import TaskStore, TaskService
from workbench_agent_adapters import _snapshot

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
    f=JointTests();f.setUp()
    service=object.__new__(TaskService);service.home=f.home/'service'
    service.store=TaskStore(service.home/'tasks.sqlite3')
    def forbid(*args,**kwargs):raise AssertionError('Hidden network/model call')
    try:
        with patch('agent_task_service.ProjectCatalog') as catalog, patch('workbench_joint_candidate.request_model',forbid), patch('http.client.HTTPSConnection',forbid):
            catalog.return_value.projects={f.project['id']:f.project}
            for line in sys.stdin:
                try:
                    data=json.loads(line);op=data['op']
                    if op=='init':result={'projectId':f.project['id'],'revision':f.baseline['projectRevision'],'plan':f.plan,'planningInput':f.adapter.planning_input(f.project)}
                    elif op=='list':result=service.store.list(f.project['id'])
                    elif op=='create':
                        body=data['body'];body['executionScope']='generate_only'
                        task,duplicate=service.store.create(body,f.baseline['projectRevision'])
                        if not duplicate:
                            service.store.transition(task['taskId'],expected=('queued',),status='running')
                            try:service.store.publish(task['taskId'],service._generate_candidate(task['taskId']))
                            except Exception as e:service.store.transition(task['taskId'],expected=('running',),status='failed',code=getattr(e,'code','failed'),reason='Offline candidate rejected')
                        result={'task':service.store.get(task['taskId']),'duplicate':duplicate}
                    elif op=='reopen':
                        service.store=TaskStore(service.home/'tasks.sqlite3');result=True
                    elif op=='check':
                        assert _snapshot(f.project)==f.baseline
                        tasks=service.store.list(f.project['id'])
                        result={'sourceUnchanged':True,'tasks':tasks,'plans':{t['taskId']:service.store.plan_submission(t['taskId']) for t in tasks}}
                    else:raise ValueError('Unknown fixture command')
                    print(json.dumps({'ok':True,'result':result},ensure_ascii=False),flush=True)
                except Exception as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False),flush=True)
    finally:f.tearDown()

if __name__=='__main__':main()
