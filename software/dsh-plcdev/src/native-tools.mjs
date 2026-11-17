import { createHash } from 'node:crypto';
import {matchesHmiIntent,matchesHmiRevisionIntent,matchesReadonlyValueIntent} from './hmi-intent.mjs';
import {validProjectEditPlan} from './project-edit-contract.mjs';
import {nativeToolEvidence} from './native-tool-evidence.mjs';
import {projectWorkflowRoute} from './project-workflow.mjs';
import {boundedProjectContext,readProjectContext,hasContextReference} from './project-context-read.mjs';

export const TOOL_NAMES = Object.freeze(['plcdev_project_context', 'plcdev_propose_joint', 'plcdev_task_status', 'plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text','plcdev_propose_hmi_readonly_value','plcdev_propose_project_edit','plcdev_validate_candidate','plcdev_project_read']);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
function exact(args, keys) {
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('PLCdev 工具参数无效：必须传入参数对象。');
  const missing=keys.filter(key=>!Object.hasOwn(args,key)),extra=Object.keys(args).filter(key=>!keys.includes(key));
  if(missing.length||extra.length){
    const safe=names=>names.slice(0,12).map(name=>/^[A-Za-z0-9_]{1,64}$/.test(name)?name:'未支持字段').join('、')+(names.length>12?'（共 '+names.length+' 项）':'');
    throw new Error('PLCdev 工具参数无效：本工具只接受 '+(keys.length?keys.join('、'):'空对象 {}')+'。'+
      (missing.length?'缺少 '+safe(missing)+'。':'')+(extra.length?'多余 '+safe(extra)+'。':'')+
      '请按字段要求修正后重试同一工具；尚未提交修改，不要换用旧联合工具。');
  }
}
function compactTask(task) {
  return { projectId: task.projectId, taskId: task.taskId, status: task.status,
    projectRevision: task.projectRevision,
    workflow: task.workflow, candidateDigest: task.candidate?.candidateDigest,
    summary: task.candidate?.summary, reason: task.reason,
    candidate: task.candidate ? { candidateDigest: task.candidate.candidateDigest,
      validation: task.candidate.validation,
      components: task.candidate.components?.map(component => ({tool:component.tool,summary:component.summary,widgets:component.widgets,...nativeToolEvidence(component)})) } : undefined,
    retention: task.retention ? { status: task.retention.status, projectId: task.retention.projectId,
      keptProjectId: task.retention.keptProjectId, completionScope: task.retention.completionScope,
      version: task.retention.version, revision: task.retention.revision } : undefined,
    compilation: task.compilation ? { status: task.compilation.status, diagnostic: task.compilation.diagnostic, reason: task.compilation.reason, completionScope: task.compilation.completionScope } : undefined,
    nextStep: task.retention?.completionScope==='saved-project-version'
      ? '修改已保留到当前工程，请在本会话继续修改或编译验证。再次修改前重新读取当前工程上下文。旧工具窗口可能仍显示旧版本，请从结果卡打开当前工程。'
      : task.retention?.keptProjectId
        ? '这是此前保留的独立副本。继续修改请打开该副本的关联会话；当前会话仍可核对或编译这份历史结果。'
        : '在结果卡审阅并保留本轮修改；保留后可在当前工程会话继续修改或编译验证。不会自动运行。' };
}

/** Native DSH tools use trusted session identity, fixed saved revision and proposal-only authority. */
export function createNativeTools({ bridge, conversations, projectContext }) {
  const contextViews=new WeakMap();
  const viewOwner=exec=>projectContext?.get(exec.agent?.session?.id)??exec.agent;
  async function projectName(projectId) {
    try {
      const result = await bridge.handle('GET', '/api/plcdev/status?project=' + encodeURIComponent(projectId));
      const project = result.status === 200 && result.body.project;
      return project?.id === projectId && typeof project.name === 'string' ? project.name : null;
    } catch { return null; } // Optional display metadata must never hide a durable task receipt.
  }
  function session(exec) {
    exec.signal?.throwIfAborted();
    const id = exec.agent?.session?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new Error('需要真实 DSH 对话身份，不能由工具参数指定会话。');
    return id;
  }
  async function context(id, exec) {
    const scope = projectContext?.assertExecution(exec);
    const binding = conversations.snapshot(id);
    if (!binding.projectId) throw new Error('请先在对话右上角选择并关联 PLCdev 工程。');
    const response = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(binding.projectId));
    if (response.status !== 200 || response.body.projectId !== binding.projectId || !/^[0-9a-f]{64}$/.test(response.body.projectRevision ?? ''))
      throw new Error('尚未核对工程已保存版本。');
    const revision = response.body.projectRevision;
    const name = await projectName(binding.projectId);
    const current = conversations.snapshot(id);
    if (current.projectId !== binding.projectId || current.version !== binding.version)
      throw new Error('读取工程期间绑定已变化，请重新核对。');
    if (projectContext) projectContext.assertExecution(exec);
    if(scope?.revision?.expectedRevision&&scope.revision.expectedRevision!==revision)throw new Error('父候选源版本已变化，不能继续修改。');
    if (scope && scope.sourceRevision && scope.sourceRevision !== revision) throw new Error('源版本已变化，请重新发送需求。');
    if (scope) scope.sourceRevision ??= revision;
    return { binding, listing: response.body, projectName: name, contextToken: hash(JSON.stringify([id, binding.projectId, binding.version, revision, scope?.turnKey])) };
  }
  function define(name, title, description, parameters, execute) {
    return { name, description, parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: (_args, value) => { try { const data = JSON.parse(value); return data.task ? { projectId: data.task.projectId, taskId: data.task.taskId } : {}; } catch { return {}; } } },
      presentCall: () => ({ card: 'generic', title, kind: name.startsWith('plcdev_propose_') ? 'edit' : 'read' }),
      isConcurrencySafe: () => !name.startsWith('plcdev_propose_') && name !== 'plcdev_validate_candidate',
      async execute(args, exec) {
        projectContext?.assertExecution(exec);
        const result=await execute(args,exec);
        if(name==='plcdev_project_context'){
          const full=JSON.parse(JSON.stringify(result));contextViews.set(viewOwner(exec),full);
          return JSON.stringify(boundedProjectContext(full));
        }
        return JSON.stringify(result);
      },
    };
  }
  return [
    define(TOOL_NAMES[0], '核对 PLCdev 工程', 'Start here for ordinary requests to change the bound PLC/HMI/OIP project. Returns workflowRoute plus exact small context or a bounded summary with _plcdevRead references. Read needed full schemas/parameters/source through plcdev_project_read before the indicated proposal tool. No shell commands, source-code searches or environment repair. Read the bound project, saved native PLC/scene state, shared native tool catalogs, declared interface and supported HMI targets. editingInput.openplcTools contains authoritative tools with input_schema for POU, variable and ladder edits. editingInput.oipTools contains the installed OIP editing/checking catalog, scene objects and binding limitations; If no scene exists, editingInput.oipCreation supplies the authoritative catalog for oip-create-scene. These direct project tools do not require a team, another model or manual scene association. Call before proposing edits or compiling a kept candidate. In project-edit revisions editingInput describes the current parent candidate. No Runtime control.', object({}), async (args, exec) => {
      exact(args, []); const id = session(exec), { binding, listing, projectName, contextToken } = await context(id, exec);
      const own = new Set(binding.taskRefs.filter(r => r.projectId === binding.projectId).map(r => r.taskId));
      const revision = projectContext?.get(id)?.revision;
      let editingInput = listing.editingInput;
      if (revision?.workflow === 'project-edit-v1') {
        const parent = listing.tasks.find(t=>own.has(t.taskId)&&t.taskId===revision.parent.taskId&&t.projectId===binding.projectId);
        if (!parent || parent.status!=='awaiting_review' || parent.supersededBy || parent.candidate?.candidateDigest!==revision.parent.candidateDigest || parent.candidate?.editingInput?.projectRevision!==revision.parent.candidateDigest)
          throw new Error('父候选内容无法核对，请重新选择继续修改。');
        editingInput = parent.candidate.editingInput;
        // Tool documentation belongs to the current trusted executor, while
        // project data belongs to the selected parent candidate.
        if (editingInput.openplcTools && listing.editingInput?.openplcTools) editingInput = {
          ...editingInput, openplcTools: { ...editingInput.openplcTools,
            tools: listing.editingInput.openplcTools.tools },
        };
        if (editingInput.oipTools) {
          const current=listing.editingInput?.oipTools||listing.editingInput?.oipCreation;
          if(!current || ['nativeVersion','contractVersion','catalogDigest'].some(key=>
            editingInput.oipTools[key]!==undefined&&editingInput.oipTools[key]!==current[key]))
            throw new Error('OIP 编辑工具版本已变化，请重新读取保存工程并生成候选。');
          editingInput={...editingInput,oipTools:{...editingInput.oipTools,tools:current.tools}};
        } else if (editingInput.oipCreation && !listing.editingInput?.oipCreation) {
          throw new Error('OIP 编辑工具版本已变化，请重新读取保存工程并生成候选。');
        } else if (listing.editingInput?.oipCreation) {
          // Old HMI candidates predate first-scene support. Extend only this
          // planning view; the stored candidate/digest remains unchanged.
          const current=listing.editingInput.oipCreation;
          if(editingInput.oipCreation && ['nativeVersion','contractVersion','catalogDigest'].some(key=>
            editingInput.oipCreation[key]!==undefined&&editingInput.oipCreation[key]!==current[key]))
            throw new Error('OIP 编辑工具版本已变化，请重新读取保存工程并生成候选。');
          const oipLimitations=(listing.editingInput.limitations??[]).filter(line=>typeof line==='string'&&line.includes('OIP'));
          editingInput={...editingInput,oipCreation:current,
            operations:[...new Set([...(editingInput.operations??[]),'oip-create-scene'])],
            planSchema:{...editingInput.planSchema,schemaVersion:1,changes:{...editingInput.planSchema?.changes,
              'oip-create-scene':listing.editingInput.planSchema?.changes?.['oip-create-scene']??['calls','kind','name']}},
            limitations:[...(editingInput.limitations??[]).filter(line=>typeof line!=='string'||!line.includes('OIP')),...oipLimitations]};
        }
      }
      return { ok: true, projectId: binding.projectId, projectName, sourceBasis: 'saved_revision', projectRevision: listing.projectRevision, contextToken,
        workflowRoute:projectWorkflowRoute(listing,revision),
        ...(editingInput?.interfaceTemplate?{interfaceGuidance:'首次用 interface 声明生成 HMI 时，标题写在 change.definition.title：它同时用于 FUXA 工程名、首个画面名称和画面页头可见标题，无需搜索生成器代码。definition.description 是合法的可选工程说明，不显示在画面中。title 为非空可见文本且最多 80 字符；description 最多 500 字符且可空；两者均在 definition 内，不含控制字符或 <>。已有 HMI 的标题或静态文字修改须使用当前提供的 HMI 操作和目标；修改 interface.title 不会自动重写已有画面。'}:{}),
        projectEditCandidate: listing.capabilities?.projectEditCandidate === true, editingInput,
        jointAiCandidate: listing.capabilities?.jointAiCandidate === true,
        hmiViewNameCandidate: listing.capabilities?.hmiViewNameCandidate === true, hmiViews: listing.hmiViews,
        editingUnavailable: listing.editingUnavailable ?? null,
        hmiStaticTextCandidate: listing.capabilities?.hmiStaticTextCandidate === true, hmiTextTargets: listing.hmiTextTargets,
        hmiReadonlyValueCandidate: listing.capabilities?.hmiReadonlyValueCandidate === true, hmiValueTargets: listing.hmiValueTargets,
        planningInput: listing.planningInput,
        revision: projectContext?.get(id)?.revision ? {parent:projectContext.get(id).revision.parent,workflow:projectContext.get(id).revision.workflow||'joint-ai-v1',target:projectContext.get(id).revision.target,previousRequest:projectContext.get(id).revision.previousRequest,previousSummary:projectContext.get(id).revision.previousSummary} : null,
        // Recent independent tasks are references only. Their old requirements
        // and diffs must not be mistaken for this turn's requested change.
        tasks: listing.tasks.filter(t => own.has(t.taskId)).slice(-5)
          .map(({projectId, taskId, status, workflow, retention, compilation}) => ({projectId, taskId, status, workflow,
            ...(retention?.keptProjectId?{keptProjectId:retention.keptProjectId,keptRevision:retention.revision}:{}),
            ...(compilation?{compilation:{status:compilation.status,diagnostic:typeof compilation.diagnostic==='string'?compilation.diagnostic.slice(0,1000):null,completionScope:compilation.completionScope}}:{})})),
        boundary: 'Follow workflowRoute for this candidate chain; use plcdev_propose_project_edit for supported operations in editingInput when that route is offered. Prefer openplc-tools for PLC edits: choose only names and inputs from editingInput.openplcTools.tools, and submit ordered calls against its project state. This uses the same editing tools as the OpenPLC AI panel without another AI conversation. Inspect configuration before planning: a new program is not automatically scheduled, and functions/function-blocks need calls from a configured program. Read-only tool output is not returned to this model inside a submitted batch; use the supplied project context when planning. plc-source is a legacy compatibility format, not the default editing path. project-edit revisions use parent editingInput and accumulate changes. Legacy hmiViews/hmiTextTargets still describe saved source. Unsaved editor changes excluded. For OIP with no scene, use oip-create-scene when editingInput.oipCreation is offered: name is the scene title and calls contains 0..64 ordered native edits. No team, model switch, manual scene association or HMI/interface setup is required. For an existing scene use oip-tools and its authoritative editingInput.oipTools catalog, scene objects and binding restrictions; its native checks do not prove physical simulation or external PLC communication. User reviews and keeps the whole candidate. A retention with completionScope=saved-project-version stays in this project and conversation; reread its new saved context before continuing. plcdev_validate_candidate compiles the user-kept version only. A legacy retention with a different keptProjectId is a separate project: this source conversation is NOT automatically rebound; continue that copy in its own project conversation. No Runtime start/stop.' };
    }),
    define(TOOL_NAMES[8], '读取工程详情', 'Read exact native schemas, package parameters, scene objects or source from this turn context. Use contextToken and the exact JSON pointer or opaque reference path from _plcdevRead/index. offset starts at 0; continue nextOffset for pages. A complete value is unchanged native data. References are not schema/content: follow their paths before planning; long text is explicitly chunked. No filesystem paths, terminal, another model or team needed. Read-only; exact current project/revision authority required.', object({contextToken:string,path:string,offset:{type:'integer',minimum:0}}),async(args,exec)=>{
      exact(args,['contextToken','path','offset']);const id=session(exec);
      const fresh=await context(id,exec),view=contextViews.get(viewOwner(exec));
      if(args.contextToken!==fresh.contextToken||!view||view.contextToken!==args.contextToken)
        throw new Error('工程详情已过期或本轮尚未读取上下文，请先调用 plcdev_project_context。');
      const revision=projectContext?.get(id)?.revision;
      if(revision){
        const parent=fresh.listing.tasks.find(t=>fresh.binding.taskRefs.some(r=>r.projectId===fresh.binding.projectId&&r.taskId===t.taskId)&&t.taskId===revision.parent?.taskId&&t.projectId===fresh.binding.projectId);
        if(!parent||parent.status!=='awaiting_review'||parent.supersededBy||parent.candidate?.candidateDigest!==revision.parent?.candidateDigest||
            revision.workflow==='project-edit-v1'&&parent.candidate?.editingInput?.projectRevision!==revision.parent?.candidateDigest)
          throw new Error('父候选已变化，工程详情不再有效；请重新选择继续修改。');
      }
      return readProjectContext(view,args);
    }),
    define(TOOL_NAMES[6], '生成工程修改候选', 'Top-level arguments must be exactly contextToken and planJson; do not pass request (the host supplies original user intent). Correct argument errors using this same tool, not a legacy joint route. Submit planJson={schemaVersion:1,changes:[...]} using editingInput from plcdev_project_context. Prefer shared OpenPLC editing: {kind:"openplc-tools",calls:[{name,input}]} with 1..64 ordered calls in one batch per plan; do not mix with plc-source. Use the authoritative names, input_schema and limitations in editingInput.openplcTools.tools for POU creation, variable editing and supported native ladder operations. The backend runs those same OpenPLC tools on a private candidate, without another model. If editingInput.oipCreation is offered, create the first OIP scene with {kind:"oip-create-scene",name,calls:[{name,input}]}: name is a nonempty title up to 80 characters with no controls or angle brackets, calls has 0..64 ordered native edits from oipCreation.tools. Do not add an oip-tools or legacy OIP change to the same plan; include initial part edits in creation calls. Continue editing the created parent scene in later turns using oip-tools. No team or model switch is needed. An existing OIP scene uses {kind:"oip-tools",calls:[{name,input}]} with 1..64 ordered calls in one batch, from editingInput.oipTools.tools only. Reuses the original OIP editing/checking layer in a private candidate, with no simulation start. Do not mix oip-tools with legacy oip-part-name/oip-conveyor-speed. Use the supplied scene IDs, catalog and binding limitations; native tag edits do not automatically rewrite the external PLC. Other exact shapes: interface {kind,definition}; hmi-view-name {kind,viewId,name}; hmi-static-text {kind,viewId,elementId,text}; hmi-readonly-value {kind,viewId,signalId}; oip-part-name {kind,partId,name}; oip-conveyor-speed {kind,partId,value}. Legacy plc-source {kind,path,expectedHash,content} remains compatible but is not the default. Use only offered operations and exact target IDs. Maximum 512 KiB JSON. Preserve complete user intent. A selected project-edit revision uses the parent editingInput, carrying its earlier edits forward. Creates a separate candidate for user review, never keeps or runs it.', object({contextToken:string,planJson:string}), async (args,exec)=>{
      exact(args,['contextToken','planJson']);const id=session(exec);
      const {binding,listing,projectName,contextToken}=await context(id,exec);
      if(args.contextToken!==contextToken)throw new Error('工程绑定或源版本已变化，请重新读取上下文。');
      if(listing.capabilities?.projectEditCandidate!==true)throw new Error('当前工程没有已接入的工程修改操作，请查看上下文中的能力范围。');
      if(binding.pendingRequests.length)throw new Error('本对话仍有待核对请求，请先恢复原请求。');
      if(typeof exec.callId!=='string'||!exec.callId)throw new Error('DSH 工具调用身份缺失。');
      const scope=projectContext?.assertExecution(exec);
      if(!scope?.route||!scope.userRequest)throw new Error('缺少本轮用户原文或实际模型路由。');
      if(scope.revision&&scope.revision.workflow!=='project-edit-v1')throw new Error('当前选择的是旧候选修订，请使用对应工具或先取消修订。');
      if(typeof args.planJson!=='string'||Buffer.byteLength(args.planJson)>524288)throw new Error('工程修改计划无效或超过 512 KiB。');
      let plan;try{plan=JSON.parse(args.planJson);}catch{throw new Error('计划须为有效 JSON。');}
      if(hasContextReference(plan))throw new Error('修改计划含尚未读取的工程详情引用，请先用 plcdev_project_read 读取完整参数或源码。');
      if(!validProjectEditPlan(plan))throw new Error('计划须符合 editingInput 中的操作格式，并包含 schemaVersion:1 与非空 changes。');
      exec.signal?.throwIfAborted();
      const result=await conversations.handle('POST','/api/plcdev/conversations/tasks',{
        conversationId:id,projectId:binding.projectId,expectedVersion:binding.version,request:scope.userRequest,
        planSubmission:{schemaVersion:1,plan,route:scope.route},expectedRevision:listing.projectRevision,
        executionScope:'proposal',sourceBasis:'saved_revision',workflow:'project-edit-v1',clientRequestId:'native-'+hash(scope.turnKey||exec.callId),
        ...(scope.revision?{revisionParent:scope.revision.parent,revisionIntentId:scope.revision.intentId}:{})});
      if(result.status<200||result.status>=300)throw new Error(result.body.error||'候选任务未确认，请核对本对话任务。');
      exec.concludeTurn?.();return {ok:true,projectName,task:compactTask(result.body.task)};
    }),
    define(TOOL_NAMES[7], '编译验证保留版本', 'Compile an already user-kept candidate referenced by this conversation and belonging to the currently bound source project. Call plcdev_project_context first and use its exact token. Does not keep candidates, modify the source, download or start Runtime. Returns compiler diagnostics; compile success is not a runtime test.', object({contextToken:string,taskId:string}), async (args,exec)=>{
      exact(args,['contextToken','taskId']);const id=session(exec);
      const {binding,listing,projectName,contextToken}=await context(id,exec);
      if(args.contextToken!==contextToken)throw new Error('工程绑定或源版本已变化，请重新读取上下文。');
      if(!binding.taskRefs.some(r=>r.projectId===binding.projectId&&r.taskId===args.taskId))throw new Error('候选不属于当前会话关联的工程。');
      if(binding.pendingRequests.length)throw new Error('本对话仍有待核对请求，请先恢复原请求。');
      const task=listing.tasks.find(t=>t.projectId===binding.projectId&&t.taskId===args.taskId);
      const retention=task?.retention;
      const savedHere=retention?.completionScope==='saved-project-version'&&retention.keptProjectId===binding.projectId&&Number.isInteger(retention.version)&&retention.version>=2;
      const legacyCopy=retention?.completionScope!=='saved-project-version'&&retention?.keptProjectId!==binding.projectId;
      if(!task||!['project-edit-v1','joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1'].includes(task.workflow)||!['kept','compiled','compile_failed'].includes(task.status)||!/^user-[0-9a-f]{32}$/.test(retention?.keptProjectId||'')||(!savedHere&&!legacyCopy)||!/^([0-9a-f]{64})$/.test(retention?.revision||'')||!/^([0-9a-f]{64})$/.test(task.candidate?.candidateDigest||''))
        throw new Error('请先在结果卡保留修改，再编译验证；未自动保留候选。');
      if(savedHere&&listing.projectRevision!==retention.revision)throw new Error('当前工程已变化，请验证当前保留版本。');
      const scope=projectContext?.assertExecution(exec);
      if(!scope?.route||!scope.userRequest||typeof exec.callId!=='string'||!exec.callId)throw new Error('缺少本轮验证调用身份。');
      if(scope.revision)throw new Error('当前处于候选修订中，请完成或取消修订后验证已保留版本。');
      exec.signal?.throwIfAborted();
      const result=await conversations.handle('POST','/api/plcdev/conversations/review',{
        conversationId:id,projectId:binding.projectId,taskId:args.taskId,candidateDigest:task.candidate.candidateDigest,
        expectedRevision:task.retention.revision,action:'compile',clientRequestId:'native-compile-'+hash((scope.turnKey||exec.callId)+'\0'+args.taskId)});
      if(result.status<200||result.status>=300)throw new Error(result.body.error||'编译结果尚未确认，请在原任务中核对。');
      return {ok:true,projectName,task:compactTask(result.body.task),boundary:'仅编译已保留版本；没有运行或下载到硬件。'};
    }),
    define(TOOL_NAMES[1], '生成 PLC／HMI／场景联合候选', 'Submit your structured plan as planJson using the contract from plcdev_project_context. The backend validates and renders native OpenPLC/FUXA/OIP artifacts without another model call. Use the exact contextToken from plcdev_project_context. Request must preserve the user intent. Creates a separate candidate only, never keeps, compiles or runs it.', object({ request: string, contextToken: string, planJson: string }), async (args, exec) => {
      exact(args, ['request', 'contextToken', 'planJson']); const id = session(exec);
      if (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 4000) throw new Error('候选需求应为 1–4000 字符。');
      const { binding, listing, projectName, contextToken } = await context(id, exec);
      if (args.contextToken !== contextToken) throw new Error('工程绑定或源版本已变化。请重新读取上下文，不得把旧需求自动投到新工程。');
      if (listing.capabilities?.jointPlanCandidate !== true) throw new Error('当前工程尚未开放真实 AI 联合候选。');
      if (binding.pendingRequests.length) throw new Error('本对话仍有待核对请求，请在工程与任务区使用原请求编号恢复。');
      if (typeof exec.callId !== 'string' || !exec.callId) throw new Error('DSH 工具调用身份缺失。');
      exec.signal?.throwIfAborted();
      const scope = projectContext?.assertExecution(exec);
      if (!scope?.route || !scope.userRequest) throw new Error('缺少本轮用户原文或实际模型路由。');
      if(scope.revision?.workflow&&scope.revision.workflow!=='joint-ai-v1')throw new Error('当前修订属于 HMI 候选，请使用对应的 HMI 工具。');
      if (typeof args.planJson !== 'string' || Buffer.byteLength(args.planJson)>65536) throw new Error('结构化计划无效或过长。');
      let plan; try { plan=JSON.parse(args.planJson); } catch { throw new Error('计划须为有效 JSON。'); }
      if (!plan || Array.isArray(plan) || typeof plan!=='object') throw new Error('计划须为 JSON 对象。');
      const result = await conversations.handle('POST', '/api/plcdev/conversations/tasks', {
        conversationId: id, projectId: binding.projectId, expectedVersion: binding.version,
        request: scope.userRequest, planSubmission:{schemaVersion:1,plan,route:scope.route}, expectedRevision: listing.projectRevision, executionScope: 'proposal',
        sourceBasis: 'saved_revision', workflow: 'joint-ai-v1', clientRequestId: 'native-' + hash(scope.turnKey || exec.callId),
        ...(projectContext?.get(id)?.revision?{request:projectContext.get(id).userRequest,revisionParent:projectContext.get(id).revision.parent,revisionIntentId:projectContext.get(id).revision.intentId}:{}),
      });
      if (result.status < 200 || result.status >= 300) throw new Error(result.body.error || '候选任务未确认，请核对本对话任务。');
      // Durable asynchronous generation continues in TaskService, not a model polling loop.
      exec.concludeTurn?.();
      return { ok: true, projectName, task: compactTask(result.body.task) };
    }),
    define(TOOL_NAMES[3], '生成 HMI 画面名称候选', 'Rename one existing FUXA view only. The entire user request must use this exact unambiguous form: 把画面名称“原名称”改为“新名称”, or 把画面名称 ID“画面ID”改为“新名称”. Select a unique saved view from plcdev_project_context. Otherwise ask the user to restate; do not infer or truncate. Leaves PLC, scene and bindings unchanged. Candidate requires review.', object({contextToken:string,viewId:string,name:string}), async (args,exec)=>{
      exact(args,['contextToken','viewId','name']);const id=session(exec);
      const {binding,listing,projectName,contextToken}=await context(id,exec);
      if(args.contextToken!==contextToken)throw new Error('工程绑定或源版本已变化，请重新读取上下文。');
      if(listing.capabilities?.hmiViewNameCandidate!==true||!Array.isArray(listing.hmiViews)||listing.hmiViews.filter(v=>v.id===args.viewId).length!==1)throw new Error('画面身份未在当前保存版本中确认。');
      if(typeof args.name!=='string'||!args.name.trim()||args.name.length>80||/[\x00-\x1f<>]/.test(args.name))throw new Error('画面名称无效。');
      if(binding.pendingRequests.length)throw new Error('本对话仍有待核对请求，请先恢复原请求。');
      if(typeof exec.callId!=='string'||!exec.callId)throw new Error('DSH 工具调用身份缺失。');
      const scope=projectContext?.assertExecution(exec);
      if(!scope?.route||!scope.userRequest)throw new Error('缺少本轮用户原文或模型路由。');
      const plan={viewId:args.viewId,name:args.name};
      if(!(scope.revision?matchesHmiRevisionIntent('hmi-view-name-v1',scope.userRequest,plan,scope.revision):matchesHmiIntent('hmi-view-name-v1',scope.userRequest,plan,listing.hmiViews)))throw new Error('无法唯一确认完整修改意图与目标。修订时请明确引用父候选当前名称或画面 ID。');
      exec.signal?.throwIfAborted();
      const result=await conversations.handle('POST','/api/plcdev/conversations/tasks',{
        conversationId:id,projectId:binding.projectId,expectedVersion:binding.version,request:scope.userRequest,
        planSubmission:{schemaVersion:1,plan:{viewId:args.viewId,name:args.name.trim()},route:scope.route},
        expectedRevision:listing.projectRevision,executionScope:'proposal',sourceBasis:'saved_revision',
        workflow:'hmi-view-name-v1',clientRequestId:'native-'+hash(scope.turnKey||exec.callId),...(scope.revision?{revisionParent:scope.revision.parent,revisionIntentId:scope.revision.intentId}:{})});
      if(result.status<200||result.status>=300)throw new Error(result.body.error||'候选任务未确认，请核对本对话任务。');
      exec.concludeTurn?.();return {ok:true,projectName,task:compactTask(result.body.task)};
    }),
    define(TOOL_NAMES[4], '生成 HMI 静态文字候选', 'Change one unique listed FUXA static text only. Entire user request must be a single explicit instruction: 把静态文字“原文字”改为“新文字”, 把文字 ID“元素ID”改为“新文字”, or 把画面 ID“画面ID”的文字 ID“元素ID”改为“新文字”. Otherwise ask for clarification; never infer a target or truncate the requested value. Dynamic values, buttons, bindings, PLC and scene are not changed.', object({contextToken:string,viewId:string,elementId:string,text:string}), async (args,exec)=>{
      exact(args,['contextToken','viewId','elementId','text']);const id=session(exec);
      const {binding,listing,projectName,contextToken}=await context(id,exec);
      if(args.contextToken!==contextToken)throw new Error('工程绑定或源版本已变化，请重新读取上下文。');
      if(listing.capabilities?.hmiStaticTextCandidate!==true||!Array.isArray(listing.hmiTextTargets)||listing.hmiTextTargets.filter(v=>v.viewId===args.viewId&&v.elementId===args.elementId).length!==1)throw new Error('静态文字身份未在当前保存版本中确认。');
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>160||/[\x00-\x1f<>]/.test(args.text))throw new Error('静态文字无效。');
      if(binding.pendingRequests.length)throw new Error('本对话仍有待核对请求，请先恢复原请求。');
      if(typeof exec.callId!=='string'||!exec.callId)throw new Error('DSH 工具调用身份缺失。');
      const scope=projectContext?.assertExecution(exec);
      if(!scope?.route||!scope.userRequest)throw new Error('缺少本轮用户原文或模型路由。');
      const plan={viewId:args.viewId,elementId:args.elementId,text:args.text};
      if(!(scope.revision?matchesHmiRevisionIntent('hmi-static-text-v1',scope.userRequest,plan,scope.revision):matchesHmiIntent('hmi-static-text-v1',scope.userRequest,plan,listing.hmiTextTargets)))throw new Error('无法唯一确认完整修改意图与目标。修订时请明确引用父候选当前静态文字或文字 ID。');
      exec.signal?.throwIfAborted();
      const result=await conversations.handle('POST','/api/plcdev/conversations/tasks',{
        conversationId:id,projectId:binding.projectId,expectedVersion:binding.version,request:scope.userRequest,
        planSubmission:{schemaVersion:1,plan:{viewId:args.viewId,elementId:args.elementId,text:args.text.trim()},route:scope.route},
        expectedRevision:listing.projectRevision,executionScope:'proposal',sourceBasis:'saved_revision',
        workflow:'hmi-static-text-v1',clientRequestId:'native-'+hash(scope.turnKey||exec.callId),...(scope.revision?{revisionParent:scope.revision.parent,revisionIntentId:scope.revision.intentId}:{})});
      if(result.status<200||result.status>=300)throw new Error(result.body.error||'候选任务未确认，请核对本对话任务。');
      exec.concludeTurn?.();return {ok:true,projectName,task:compactTask(result.body.task)};
    }),
    define(TOOL_NAMES[5], '生成 HMI 只读数值显示候选', 'Append one readonly numeric display using a unique hmiValueTargets entry from plcdev_project_context. Entire user request must be: 在画面 ID“viewId”添加信号 ID“signalId”的只读数值显示. Ask for this explicit request if missing; do not truncate other requirements. Preserves existing control permissions and all PLC/device/scene data. Adds below the existing canvas. Saved source only, no parent revisions.', object({contextToken:string,viewId:string,signalId:string}), async (args,exec)=>{
      exact(args,['contextToken','viewId','signalId']);const id=session(exec);
      const {binding,listing,projectName,contextToken}=await context(id,exec);
      if(args.contextToken!==contextToken)throw new Error('工程绑定或源版本已变化，请重新读取上下文。');
      if(listing.capabilities?.hmiReadonlyValueCandidate!==true)throw new Error('当前工程没有可保全权限的只读数值显示目标。');
      if(binding.pendingRequests.length)throw new Error('本对话仍有待核对请求，请先恢复原请求。');
      if(typeof exec.callId!=='string'||!exec.callId)throw new Error('DSH 工具调用身份缺失。');
      const scope=projectContext?.assertExecution(exec),plan={viewId:args.viewId,signalId:args.signalId};
      if(!scope?.route||!scope.userRequest||scope.revision)throw new Error('需要当前模型、完整用户需求；新增显示暂不支持父候选修订。');
      if(!matchesReadonlyValueIntent(scope.userRequest,plan,listing.hmiValueTargets))throw new Error('请在完整需求中明确指定当前画面和信号 ID，不能附带其他修改。');
      exec.signal?.throwIfAborted();
      const result=await conversations.handle('POST','/api/plcdev/conversations/tasks',{
        conversationId:id,projectId:binding.projectId,expectedVersion:binding.version,request:scope.userRequest,
        planSubmission:{schemaVersion:1,plan,route:scope.route},expectedRevision:listing.projectRevision,
        executionScope:'proposal',sourceBasis:'saved_revision',workflow:'hmi-readonly-value-v1',clientRequestId:'native-'+hash(scope.turnKey||exec.callId)});
      if(result.status<200||result.status>=300)throw new Error(result.body.error||'候选任务未确认，请核对本对话任务。');
      exec.concludeTurn?.();return {ok:true,projectName,task:compactTask(result.body.task)};
    }),
    define(TOOL_NAMES[2], '读取 PLCdev 候选状态', 'Read one candidate already referenced by this DSH conversation. Cannot access another conversation task or change project/Runtime state.', object({ taskId: string }), async (args, exec) => {
      exact(args, ['taskId']); const id = session(exec), binding = conversations.snapshot(id);
      const ref = binding.taskRefs.find(r => r.taskId === args.taskId);
      if (!ref) throw new Error('任务不属于当前 DSH 对话。');
      const result = await bridge.handle('GET', '/api/plcdev/tasks?project=' + encodeURIComponent(ref.projectId));
      const task = result.status === 200 && result.body.tasks?.find(t => t.taskId === ref.taskId && t.projectId === ref.projectId);
      if (!task) throw new Error('所属工程暂未返回该任务。');
      return { ok: true, projectName: await projectName(ref.projectId), task: compactTask(task) };
    }),
  ].sort((a,b)=>TOOL_NAMES.indexOf(a.name)-TOOL_NAMES.indexOf(b.name));
}
