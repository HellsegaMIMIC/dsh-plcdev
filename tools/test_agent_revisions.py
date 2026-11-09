"""Revision transaction tests: real SQLite, no model, editor or Runtime."""
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from agent_task_service import TaskStore, AgentServiceError

REV='a'*64
DIGEST='b'*64
class RevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=TaskStore(Path(self.temp.name)/'tasks.sqlite3')
        self.parent=self.make('parent')
        self.store.publish(self.parent['taskId'],{'candidateDigest':DIGEST,'summary':{'after':'title 5'}})
    def body(self,key,parent=None):
        return dict(projectId='user-'+'1'*32,request='改成 6',expectedRevision=REV,executionScope='generate_only',clientRequestId=key,sourceBasis='saved_revision',workflow='joint-ai-v1',**({'revisionParent':parent} if parent else {}))
    def make(self,key,parent=None):
        task,_=self.store.create(self.body(key,parent),REV)
        self.store.transition(task['taskId'],expected=('queued',),status='running')
        return self.store.get(task['taskId'])
    def ref(self):return {'taskId':self.parent['taskId'],'candidateDigest':DIGEST}
    def test_internal_plan_is_not_exposed_in_task_summary(self):
        task=self.make('private-plan')
        self.store.publish(task['taskId'],{'candidateDigest':DIGEST,'acceptedPlan':{'private':'spec'},'revisionSupported':True})
        public=self.store.get(task['taskId'])['candidate']
        self.assertTrue(public['revisionSupported'])
        self.assertNotIn('acceptedPlan',public)

    def test_plan_and_route_survive_reopen_and_replay_cannot_replace_them(self):
        body=self.body('host-plan')
        body['planSubmission']={'schemaVersion':1,'plan':{'title':'5'},'route':{'provider':'A','model':'a'}}
        task,_=self.store.create(body,REV)
        reopened=TaskStore(self.store.path)
        self.assertEqual(reopened.plan_submission(task['taskId']),body['planSubmission'])
        self.assertEqual(reopened.existing(body)['taskId'],task['taskId'])
        self.assertNotIn('planSubmission',reopened.get(task['taskId']))
        body['planSubmission']['route']['provider']='B'
        with self.assertRaises(AgentServiceError):reopened.existing(body)
    def keep(self,key='keep'):
        return self.store.review_start(self.parent['taskId'],{'action':'keep','clientRequestId':key,'expectedRevision':REV})
    def test_success_atomically_supersedes_and_all_new_keeps_fail(self):
        child=self.make('child',self.ref())
        self.assertEqual(self.store.get(self.parent['taskId'])['status'],'awaiting_review')
        self.assertEqual(self.store.revision_context(child)['previousSummary'],{'after':'title 5'})
        self.store.publish(child['taskId'],{'candidateDigest':'c'*64})
        reopened=TaskStore(self.store.path)
        self.assertEqual(reopened.get(self.parent['taskId'])['supersededBy'],child['taskId'])
        for key in ('browser','native','other-client'):
            with self.assertRaises(AgentServiceError):self.keep(key)
        self.assertEqual(reopened.existing(self.body('child',self.ref()))['taskId'],child['taskId'])
    def test_failure_unknown_and_cancel_leave_old_candidate_valid(self):
        for state in ('failed','unknown_outcome','cancelled'):
            child=self.make(state,self.ref());self.store.transition(child['taskId'],expected=('running',),status=state)
            self.assertEqual(self.store.get(self.parent['taskId'])['status'],'awaiting_review')
        self.assertTrue(self.keep())
    def test_keep_wins_publish_race_without_retroactive_reversal(self):
        child=self.make('child',self.ref());self.keep()
        with self.assertRaises(AgentServiceError):self.store.publish(child['taskId'],{'candidateDigest':'c'*64})
        self.assertEqual(self.store.get(self.parent['taskId'])['status'],'keeping')
        self.assertNotIn('candidate',self.store.get(child['taskId']))
    def test_two_simultaneous_publications_have_exactly_one_winner(self):
        children=[self.make(str(i),self.ref()) for i in range(2)]
        def publish(t):
            try:self.store.publish(t['taskId'],{'candidateDigest':'c'*64});return True
            except AgentServiceError:return False
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(publish,children))
        self.assertEqual(sum(results),1)
        winner=children[results.index(True)]['taskId']
        self.assertEqual(self.store.get(self.parent['taskId'])['supersededBy'],winner)
    def test_identity_revision_and_idempotency_are_fenced(self):
        self.make('child',self.ref())
        bad={**self.body('child',self.ref()),'request':'changed'}
        with self.assertRaises(AgentServiceError):self.store.existing(bad)
        for payload in ({**self.body('bad',self.ref()),'projectId':'project-b'},self.body('bad',{**self.ref(),'candidateDigest':'c'*64}),{**self.body('bad',self.ref()),'expectedRevision':'d'*64}):
            with self.assertRaises(AgentServiceError):self.store.create(payload,payload['expectedRevision'])

if __name__=='__main__':unittest.main()
