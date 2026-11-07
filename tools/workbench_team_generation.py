"""Native Team proposals -> immutable artifacts -> the existing review ledger.

No model invocation, source apply, compilation or Runtime operation is exposed
here. Actual native member identities are authenticated by the DSH host.
"""
from contextlib import closing, contextmanager, ExitStack
import json
from pathlib import Path
import re
import subprocess
import time

from workbench_team_tasks import TeamWorkflow, encoded, digest
from workbench_agent_adapters import AdapterError, _manifest_project, _snapshot
from workbench_professional_artifacts import ProfessionalCandidates, inspect_contract, generate_component, ROLES, CONTRACT
from workbench_project_config import plain
from workbench_projects import ProjectCatalog, read_user_project
from plcdev_runtime_owner import FileLease

WORKFLOW = 'team-generation-v1'


def registered_project(project_id):
    return _manifest_project(ProjectCatalog().projects.get(project_id))


def generation_contexts(project_id, revision):
    """Only the fixed native resources relevant to these supported operations."""
    from workbench_joint_candidate import FUXA
    project = registered_project(project_id)
    contract = inspect_contract(project, revision)
    before = _snapshot(project)
    text = (Path(project['plc']).parent / 'pous/function-blocks/BatchConveyor.st').read_text(encoding='utf-8')
    initial = re.findall(r'IF NOT Initialized THEN\s+Target := (\d+);', text)
    if len(initial) != 1:
        raise ValueError('本批仅支持具有明确初始化目标的批次功能块。')
    base = {'projectId': project_id, 'projectRevision': revision,
            'sourceBasis': 'saved_revision', 'unsavedEditsIncluded': False,
            'generationContract': contract['contract'], 'contractDigest': digest(contract),
            'permissions': contract['permissions'],
            'limits': '仅生成候选；不修改源工程，不保留、不编译、不运行。'}
    plc_schema = {'type': 'object', 'additionalProperties': False,
                  'required': ['operation', 'value'], 'properties': {
                      'operation': {'const': 'batch-default-target'},
                      'value': {'type': 'integer', 'minimum': 1, 'maximum': 1000}}}
    oip_schema = {'type': 'object', 'additionalProperties': False,
                  'required': ['operation', 'partId', 'value'], 'properties': {
                      'operation': {'const': 'conveyor-speed'},
                      'partId': {'const': contract['conveyorId']},
                      'value': {'type': 'number', 'minimum': 0.1, 'maximum': 3}}}
    spec_schema = json.loads((FUXA / 'model-schema.json').read_text(encoding='utf-8'))
    reference = subprocess.run(['node', '-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).reference()))',
                                str(FUXA / 'native-project.cjs')], capture_output=True, timeout=20, check=True)
    reference = json.loads(reference.stdout.decode('utf-8'))
    # Reference controls are editable layout suggestions, not an alternate PLC.
    contexts = {
        'plc': {**base, 'interface': 'openplc-generation-v1', 'proposalSchema': plc_schema,
                'sourceSummary': {'initialTarget': int(initial[0]), 'programs': contract['plcPrograms'],
                                  'bindings': contract['bindings']['plc']},
                'instruction': '仅改变批次初始目标。控制逻辑、互锁、地址和恢复规则由适配器逐字保留。'},
        'hmi': {**base, 'interface': 'fuxa-generation-v1',
                'proposalSchema': {'type': 'object', 'additionalProperties': False,
                                   'required': ['operation', 'spec', 'defaultTarget'], 'properties': {
                                       'operation': {'const': 'native-page'}, 'spec': spec_schema,
                                       'defaultTarget': {'type': 'integer', 'minimum': 1, 'maximum': 1000}}},
                'allowedSpec': spec_schema, 'referenceSpec': reference,
                'sourceSummary': {'initialTarget': int(initial[0]), 'tags': contract['hmiTags'],
                                  'actions': contract['hmiActions']},
                'instruction': '提交完整spec；沿用referenceSpec所有输入和按钮及唯一tag/action。可修改布局、颜色、文案；defaultTarget必须等于PLC成员的目标。已有权限由本机保留，不能改变脚本或权限。'},
        'oip': {**base, 'interface': 'oip-generation-v1', 'proposalSchema': oip_schema,
                'sourceSummary': {'scene': contract['sceneFile'], 'conveyorId': contract['conveyorId'],
                                  'bindings': contract['bindings']['oip']},
                'instruction': '仅设置已绑定输送带的速度参数，不能改变通信、点位、几何或工艺。'},
    }
    if any(len(encoded(v)) > 29000 for v in contexts.values()):
        raise ValueError('专业上下文过大，未截断或发送。')
    if _snapshot(project) != before:
        raise ValueError('读取专业上下文期间工程变化。')
    return contexts


class GenerationWorkflow(TeamWorkflow):
    def __init__(self, store, home, *, generation_reader=generation_contexts,
                 project_reader=registered_project, component_generator=generate_component, **options):
        super().__init__(store, home, **options)
        self.generation_reader, self.project_reader = generation_reader, project_reader
        self.component_generator = component_generator
        with closing(self.connect()) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS team_components (
                task_id TEXT NOT NULL REFERENCES tasks(task_id), role TEXT NOT NULL,
                proposal_digest TEXT NOT NULL, component_digest TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(task_id,role))''')

    def public(self, db, run):
        result = super().public(db, run)
        workflow = db.execute('SELECT workflow FROM tasks WHERE task_id=?', (run['task_id'],)).fetchone()[0]
        result['kind'] = 'generation' if workflow == WORKFLOW else 'analysis'
        if workflow == WORKFLOW:
            for member in result['members']:
                row = db.execute('SELECT * FROM team_components WHERE task_id=? AND role=?',
                                 (run['task_id'], member['role'])).fetchone()
                member['componentDigest'] = row['component_digest'] if row else None
                member['componentSummary'] = json.loads(row['payload'])['summary'] if row else None
                member['artifact'] = 'team-generation/' + run['task_id'] + '/' + member['role'] + '.json' if row else None
        return result

    @contextmanager
    def lease(self, task_id):
        folder = self.home / 'team-generation'
        plain(folder, self.home)
        folder.mkdir(exist_ok=True)
        path = folder / (task_id + '.lock')
        plain(path, self.home)
        with FileLease(path, timeout=1):
            yield

    @contextmanager
    def _entry_lease(self, task_id):
        # Translate only the known acquisition failure of the task lease; the
        # protected body, release and unrelated RuntimeErrors keep their type.
        with ExitStack() as stack:
            try:
                stack.enter_context(self.lease(task_id))
            except RuntimeError as exc:
                if type(exc) is not RuntimeError or str(exc) != '已有 PLCdev 会话占用 Runtime；请先在所属入口结束会话。':
                    raise
                raise self.Error('busy', '任务正在处理，请稍后使用原请求编号重试。') from None
            yield

    def identity(self, db, actor, args, fields):
        self.fields(args, fields)
        run, slot = self.access(db, actor)
        try:
            task = self.store._public(db, db.execute('SELECT * FROM tasks WHERE task_id=?', (run['task_id'],)).fetchone())
        except (ValueError, KeyError, TypeError, RecursionError):
            raise self.Error('conflict', '原任务持久回执损坏；未恢复或重新执行。') from None
        if task['workflow'] != WORKFLOW or any(args[k] != task[k] for k in ('taskId', 'projectId', 'projectRevision')):
            self.fail('专业产物请求跨任务、工程或固定版本。')
        return run, slot, task

    def generate(self, actor, args):
        fields = ('taskId', 'projectId', 'projectRevision', 'contextDigest', 'proposal')
        with closing(self.connect()) as db:
            run, slot, task = self.identity(db, actor, args, fields)
            if not slot or not slot['read_digest'] or args['contextDigest'] != slot['read_digest']:
                self.fail('生成缺少实际成员读取固定专业上下文的证据。')
        with self._entry_lease(task['taskId']):
            with closing(self.connect()) as db:
                run, slot, task = self.identity(db, actor, args, fields)
                old = db.execute('SELECT * FROM team_components WHERE task_id=? AND role=?',
                                 (task['taskId'], actor['role'])).fetchone()
                if old:
                    if old['proposal_digest'] != digest(args['proposal']):
                        self.fail('此角色产物已固定，不能覆盖。请另建候选任务。')
                    return self.snapshot(actor, {})
                if task['status'] != 'team_waiting':
                    self.fail('当前任务不接受新专业产物。')
                context = json.loads(slot['context'])
            component = self.component_generator(self.project_reader(task['projectId']), task_id=task['taskId'],
                expected_revision=task['projectRevision'], role=actor['role'], proposal=args['proposal'])
            if (component['contractDigest'] != context['contractDigest'] or component['role'] != actor['role']
                    or component['taskId'] != task['taskId'] or component['projectId'] != task['projectId']):
                self.fail('专业产物与固定资源契约不符。')
            component_digest = digest(component)
            receipt = {'summary': component['summary'],
                       'findings': ['原生产物已由受控适配器验证并登记：' + component_digest],
                       'unverified': ['这是产物回执；尚未人工保留、原生编译或运行。']}
            with closing(self.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                run, slot, task = self.identity(db, actor, args, fields)
                db.execute('INSERT INTO team_components VALUES (?,?,?,?,?)',
                           (task['taskId'], actor['role'], digest(args['proposal']), component_digest, encoded(component)))
                db.execute('UPDATE team_slots SET report=?,report_digest=? WHERE task_id=? AND role=?',
                           (encoded(receipt), digest(receipt), task['taskId'], actor['role']))
                count = db.execute('SELECT COUNT(*) FROM team_components WHERE task_id=?', (task['taskId'],)).fetchone()[0]
                db.execute('UPDATE tasks SET status=?,reason=?,updated=? WHERE task_id=?',
                           ('components_ready' if count == 3 else 'team_waiting',
                            '三端产物齐备，等待Lead组装供人工审阅。' if count == 3 else '已登记专业产物，等待其余成员。',
                            time.time(), task['taskId']))
                self.store._event(db, task['taskId'], 'professional_artifact',
                                  {'role': actor['role'], 'sessionId': actor['sessionId'], 'componentDigest': component_digest})
                self.refresh(db, run)
                db.commit()
            return self.snapshot(actor, {})

    def verify_candidate_receipt(self, db, actor, task, payload):
        """Bind a published receipt to accepted inputs without reading source."""
        try:
            result = json.loads(payload)
            rows = db.execute('SELECT * FROM team_components WHERE task_id=? ORDER BY role',
                              (task['taskId'],)).fetchall()
            components, request = self.assembly_inputs(db, task, rows)
            proof = self.require_confirmed_assembly(task['taskId'], request)
            expected = self.verified_result(proof['result'], request, components)
            # The durable native receipt has the local generation marker. Only
            # these two fields are added/replaced by the publication transaction.
            expected['generation'] = 'native-team-professional-artifacts'
            expected['teamEvidence'] = {'rootSessionId': actor['rootSessionId'],
                'members': [{'role': m['role'], 'sessionId': m['sessionId'], 'componentDigest': m['componentDigest']}
                            for m in task['teamAnalysis']['members']]}
            if type(result) is not dict or encoded(result) != encoded(expected):
                raise ValueError('published receipt does not match verified assembly')
        except (self.Error, AdapterError, OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
            raise self.Error('conflict', '原候选完整回执、受理产物或持久证据不一致；未重新生成或确认。') from None

    @contextmanager
    def _keep_lease(self, lease):
        # Translate only known acquisition failures, never exceptions from the
        # protected body or lease release. Keep the serving module's Error type.
        with ExitStack() as stack:
            try:
                stack.enter_context(lease)
            except RuntimeError as exc:
                if type(exc) is not RuntimeError or str(exc) != '已有 PLCdev 会话占用 Runtime；请先在所属入口结束会话。':
                    raise
                raise self.Error('busy', '候选任务正在处理，请稍后使用原请求编号重试。') from None
            except AdapterError as exc:
                if exc.code != 'conflict' or str(exc) != '此工程已有候选任务正在生成；请稍后重试。':
                    raise
                raise self.Error('conflict', '此工程已有候选任务正在处理，请稍后使用原请求编号重试。') from None
            yield

    @contextmanager
    def keep_guard(self, task_id, project_id):
        # Same ordering as generation: task lease before candidate leases and
        # SQLite. These are artifact locks, never Runtime ownership locks.
        with self._keep_lease(self.lease(task_id)):
            with self._keep_lease(ProfessionalCandidates(self.home / 'candidates')._lease(project_id, task_id)):
                with self.artifact_lock:
                    yield

    def verify_keep_receipt(self, db, task, body):
        """Read-only keep gate; never materialize or repair missing evidence."""
        try:
            if (task['workflow'] != WORKFLOW or task['taskId'] != body['taskId']
                    or task['projectId'] != body['projectId']
                    or task['projectRevision'] != body['expectedRevision']):
                raise ValueError('keep identity mismatch')
            row = db.execute('SELECT payload FROM candidates WHERE task_id=?',
                             (task['taskId'],)).fetchone()
            result = json.loads(row['payload'])
            if result['candidateDigest'] != body['candidateDigest']:
                raise ValueError('keep digest mismatch')
            run = db.execute('SELECT * FROM team_runs WHERE task_id=?',
                             (task['taskId'],)).fetchone()
            team = self.public(db, run)
            if (encoded(team) != encoded(task['teamAnalysis'])
                    or sorted(m['role'] for m in team['members']) != sorted(ROLES)):
                raise ValueError('accepted team receipt mismatch')
            # Match the existing materializer's immutable representation, but
            # do not call it: absence must reject, not reconstruct a receipt.
            for member in team['members']:
                if (not member['sessionId'] or not member['nativeTaskId']
                        or not member['contextDigest'] or not member['report']
                        or digest(member['report']) != member['reportDigest']):
                    raise ValueError('incomplete member receipt')
                expected = {'projectId': task['projectId'],
                            'projectRevision': task['projectRevision'],
                            'taskId': task['taskId'], **member}
                expected.pop('notice', None)
                path = self.home / 'team-generation' / task['taskId'] / (member['role'] + '.json')
                plain(path, self.home)
                if path.read_text(encoding='utf-8') != encoded(expected) + '\n':
                    raise ValueError('member file mismatch')
            # Includes accepted components, fixed contexts, confirmed ledger,
            # full publication wrapper, native tree and all bundle receipts.
            self.verify_candidate_receipt(db, {'rootSessionId': run['root_session']}, task, row['payload'])
            return result
        except (self.Error, AdapterError, OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
            raise self.Error('conflict', '保留所需完整受理证据无法核实；未复制、修复或重新生成。') from None

    def review_keep(self, task_id, body):
        if self.store.review_existing(task_id, body):
            return False
        with self.keep_guard(task_id, body['projectId']):
            # Recheck inside the original SQL transaction: another request may
            # have committed since the lock-free historical lookup.
            return self.store.review_start(task_id, body, verify=self.verify_keep_receipt)

    def keep(self, task_id, body, changes, source):
        with self.keep_guard(task_id, body['projectId']):
            with closing(self.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                task = self.store._public(db, db.execute('SELECT * FROM tasks WHERE task_id=?',
                                                        (task_id,)).fetchone())
                if task['status'] != 'keeping':
                    self.fail('任务不处于已派发保留状态；未重试。')
                candidate = self.verify_keep_receipt(db, task, body)
                # Keep accepted SQLite inputs and cooperative artifact writers
                # pinned through JointChanges' own lease and checked copying.
                result = changes.keep(source, candidate, effect_id=body['clientRequestId'],
                    expected_revision=body['expectedRevision'], candidate_digest=body['candidateDigest'])
                db.commit()
                return result

    def assembly_inputs(self, db, task, rows):
        """Derive the request from accepted SQLite components and fixed contexts."""
        try:
            by_role = {}
            for row in rows:
                value = json.loads(row['payload'])
                role = row['role']
                slot = db.execute('SELECT context,read_digest FROM team_slots WHERE task_id=? AND role=?',
                                  (task['taskId'], role)).fetchone()
                context = json.loads(slot['context'])
                if (role not in ROLES or role in by_role or type(value) is not dict
                        or value.get('role') != role or value.get('contract') != CONTRACT
                        or value.get('taskId') != task['taskId'] or value.get('projectId') != task['projectId']
                        or value.get('baselineRevision') != task['projectRevision']
                        or context['projectId'] != task['projectId'] or context['projectRevision'] != task['projectRevision']
                        or context['generationContract'] != CONTRACT or slot['read_digest'] != digest(context)
                        or value.get('contractDigest') != context['contractDigest']
                        or row['component_digest'] != digest(value) or row['proposal_digest'] != digest(value['proposal'])):
                    raise ValueError('accepted component or fixed context mismatch')
                by_role[role] = value
            components = [by_role[role] for role in ROLES]
            contracts = {value['contractDigest'] for value in components}
            if len(by_role) != len(ROLES) or len(contracts) != 1:
                raise ValueError('incomplete or inconsistent components')
            return components, {'taskId': task['taskId'], 'projectId': task['projectId'],
                                'baselineRevision': task['projectRevision'],
                                'contractDigest': components[0]['contractDigest'], 'artifactDigest': digest(components)}
        except (ValueError, KeyError, TypeError, RecursionError):
            raise self.Error('unknown_outcome', '已登记产物、固定上下文或摘要无法核实；未发布或重新生成。') from None

    def require_confirmed_assembly(self, task_id, request):
        ledger = self.home / 'candidates' / task_id / 'professional-assembly.json'
        try:
            plain(ledger, self.home)
            proof = json.loads(ledger.read_text(encoding='utf-8'))
            if (type(proof) is not dict or set(proof) != {'request', 'state', 'result'}
                    or proof['state'] != 'confirmed' or type(proof['result']) is not dict
                    or encoded(proof['request']) != encoded(request)):
                raise ValueError('incomplete assembly proof')
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            raise self.Error('unknown_outcome', '原组装缺少可核查的完成记录；保持未知，不自动重试。') from None
        return proof

    def verified_result(self, result, request, components):
        try:
            return ProfessionalCandidates(self.home / 'candidates').verify_result(
                result, request=request, components=components)
        except AdapterError:
            raise self.Error('unknown_outcome', '组装完成结果无法完整核实；保留原记录，不发布或重新执行。') from None

    def assemble(self, actor, args):
        fields = ('taskId', 'projectId', 'projectRevision')
        with closing(self.connect()) as db:
            run, _, task = self.identity(db, actor, args, fields)
            if actor['role'] != 'lead': self.fail('只有实际Lead可组装联合候选。')
        with self._entry_lease(task['taskId']):
            with closing(self.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                run, _, task = self.identity(db, actor, args, fields)
                existing = db.execute('SELECT payload FROM candidates WHERE task_id=?', (task['taskId'],)).fetchone()
                if existing:
                    if task['status'] == 'awaiting_review':
                        self.verify_candidate_receipt(db, actor, task, existing['payload'])
                    # Keep/compile/discard states are historical receipts, not a
                    # new assertion that an old candidate is currently usable.
                    db.commit()
                    return {**self.snapshot(actor, {}), 'candidateVerification':
                            'current_tree' if task['status'] == 'awaiting_review' else 'historical_receipt_only'}
                rows = db.execute('SELECT * FROM team_components WHERE task_id=? ORDER BY role', (task['taskId'],)).fetchall()
                if len(rows) != 3: self.fail('必须等PLC、HMI和OIP各一份产物齐备。')
                components, request = self.assembly_inputs(db, task, rows)
                recovered_result = None
                if task['status'] == 'generation_assembling':
                    proof = self.require_confirmed_assembly(task['taskId'], request)
                    recovered_result = self.verified_result(proof['result'], request, components)
                elif task['status'] != 'components_ready':
                    self.fail('当前任务不能组装。')
                db.execute("UPDATE tasks SET status='generation_assembling',reason=?,updated=? WHERE task_id=?",
                           ('正在核对并组装三端原生产物。', time.time(), task['taskId']))
                db.commit()
            from workbench_joint_candidate import JointCandidateAdapters
            # Once intent is durable, absence of a ledger is not proof that the
            # attempt did nothing. Any unconfirmed failure stays assembling;
            # only an exact confirmed ledger can recover it, never blind retry.
            try:
                project = self.project_reader(task['projectId'])
                if project['id'] != task['projectId'] or _snapshot(project)['projectRevision'] != task['projectRevision']:
                    raise ValueError('source identity or revision mismatch')
                if recovered_result is None:
                    result = JointCandidateAdapters(state_root=self.home / 'candidates', allow_model=False).propose_professional_candidate(
                        project, task_id=task['taskId'], expected_revision=task['projectRevision'], components=components)
                else:
                    # A fully verified durable result is the original outcome.
                    # Recovery never calls the assembly operation a second time.
                    result = recovered_result
                # This gate applies to every first publication, including a
                # fresh adapter return and confirmed-ledger recovery.
                result = self.verified_result(result, request, components)
                if _snapshot(project)['projectRevision'] != task['projectRevision']:
                    raise ValueError('source changed before publication')
            except (AdapterError, OSError, ValueError, KeyError, TypeError):
                raise self.Error('unknown_outcome', '组装结果或源版本尚未完整核实；未发布，未自动重试。') from None
            # Local adapters are deterministic. Do not claim an AI call from the
            # existence of native identities; the model scope ledger proves calls.
            result['generation'] = 'native-team-professional-artifacts'
            result['teamEvidence'] = {'rootSessionId': actor['rootSessionId'],
                'members': [{'role': m['role'], 'sessionId': m['sessionId'], 'componentDigest': m['componentDigest']}
                            for m in task['teamAnalysis']['members']]}
            with closing(self.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                _, _, current = self.identity(db, actor, args, fields)
                current_rows = db.execute('SELECT * FROM team_components WHERE task_id=? ORDER BY role',
                                          (task['taskId'],)).fetchall()
                _, current_request = self.assembly_inputs(db, current, current_rows)
                if current['status'] != 'generation_assembling' or current_request != request:
                    raise self.Error('unknown_outcome', '发布前原任务或产物已变化；未发布或重新执行。')
                db.execute('INSERT INTO candidates VALUES (?,?)', (task['taskId'], encoded(result)))
                db.execute("UPDATE tasks SET status='awaiting_review',reason_code=NULL,reason=?,updated=? WHERE task_id=?",
                           ('三端联合候选已生成，请人工审阅；未保留、编译或运行。', time.time(), task['taskId']))
                self.store._event(db, task['taskId'], 'candidate_ready', {'candidateDigest': result['candidateDigest'],
                                  'rootSessionId': actor['rootSessionId']})
                db.commit()
            return self.snapshot(actor, {})

    def handle(self, operation, body):
        self.fields(body, ('actor', 'input'))
        actor, args = self.actor(body['actor']), body['input']
        if operation == 'create-generation':
            return self.create(actor, args, workflow=WORKFLOW, roles=ROLES, context_reader=self.generation_reader)
        if operation == 'generate': return self.generate(actor, args)
        if operation == 'assemble': return self.assemble(actor, args)
        if operation == 'report':
            with closing(self.connect()) as db:
                run, _ = self.access(db, actor)
                workflow = db.execute('SELECT workflow FROM tasks WHERE task_id=?', (run['task_id'],)).fetchone()[0]
                if workflow == WORKFLOW: self.fail('生成任务只接受经适配器验证的产物，不能用分析报告代替。')
        return super().handle(operation, body)
