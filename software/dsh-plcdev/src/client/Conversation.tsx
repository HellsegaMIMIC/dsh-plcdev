import React, { useEffect, useRef, useState } from 'react';
import { validateSnapshot, validateTasks, definitiveFailure, taskStatus } from './model.mjs';
import { conversationApi as api, reviewTarget, reviewedCandidate, saveReviewBookmark, restoredReviewTarget } from './conversation-client.mjs';
import { reviewActionRequest, reviewPendingKey, readReviewPending } from './conversation-client.mjs';
import { projectIdentity, projectLabel, revisionBasis, reviewStages, stageLabel, stageTone, stageColor, artifactRows } from './conversation-client.mjs';

const css = `
.pc-tool-card,.pc-review{color:var(--dsw-alias-label-primary,#24334a);font:var(--dsw-font-xs-13,13px/20px sans-serif);font-family:var(--dsw-font-family,inherit);box-sizing:border-box}
.pc-tool-card *,.pc-review *{box-sizing:border-box}
.pc-tool-card{border:1px solid var(--dsw-alias-border-l2,#dde4ed);background:var(--dsw-alias-bg-module-platform,#f7f9fc);border-radius:var(--dsw-radius-lg,16px);padding:9px 11px;margin:6px 0}
.pc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pc-row>strong{font-size:13px}
.pc-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,#64748b)}
.pc-row .pc-spacer{flex:1}
.pc-tool-card button,.pc-review button{font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#dde4ed);border-radius:var(--dsw-radius-sm,8px);padding:5px 9px;cursor:pointer}
.pc-tool-card button:disabled,.pc-review button:disabled{opacity:.55;cursor:default}
.pc-error{color:var(--dsw-alias-label-warning,#8b5b14);font-size:13px;margin-top:7px;overflow-wrap:anywhere}
.pc-tool-card code,.pc-review code{font-family:var(--ds-font-family-code,monospace)}
.pc-review{height:100%;overflow:auto;padding:18px}
.pc-review h2{font-size:16px;font-weight:500;margin:0 0 8px}
.pc-review h3{font-size:13px;margin:18px 0 8px}
.pc-review p{margin:8px 0;overflow-wrap:anywhere}
.pc-review dl{display:grid;grid-template-columns:78px minmax(0,1fr);gap:7px;margin:12px 0}
.pc-review dt{font-size:13px;color:var(--dsw-alias-label-tertiary,#64748b)}
.pc-review dd{margin:0;overflow-wrap:anywhere;font-size:13px}
.pc-review .pc-change{font-size:16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,#dde4ed);border-bottom:1px solid var(--dsw-alias-border-l2,#dde4ed)}
`;
const browserStorage=()=>window.localStorage;
const textError=(e:any)=>e?.name==='AbortError'?'请求超时，未自动重试。':e?.message||'请求失败。';
/**
 * Native tool.result presentation. The durable event supplies task identity;
 * this card is a historical call record and never claims to be the latest state.
 */
export function NativeToolCard({phase,block,toolName,onReviewTask}:any){
  let data:any=null;try{if(phase==='result'&&!block.isError)data=JSON.parse((block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'));}catch{}
  const target=reviewTarget(data?.task||block?.meta);
  const task=data?.task||null;
  const teamAnalysis=task?.workflow==='team-analysis-v1';
  const projectName=typeof data?.projectName==='string'&&data.projectName.trim()?data.projectName.trim():null;
  const projectId=target?.projectId||(typeof data?.projectId==='string'?data.projectId:null);
  const baseline=revisionBasis(task?.projectRevision||data?.projectRevision);
  const stages=reviewStages(task);
  const artifacts=['joint-ai-v1','team-generation-v1'].includes(task?.workflow)?artifactRows(task):[];
  const title=({'plcdev_project_context':'核对工程上下文','plcdev_propose_joint':'PLC／HMI／场景联合候选','plcdev_task_status':'读取候选状态','plcdev_team_context':'核对团队工程','plcdev_team_plan':'原生团队分工','plcdev_team_generate_plan':'三端原生团队分工','plcdev_team_status':'收回专业成果','plcdev_team_control':'专业成员控制','plcdev_plc_analyze':'PLC 专业读取','plcdev_hmi_analyze':'HMI 专业读取','plcdev_oip_analyze':'OIP 专业读取','plcdev_plc_generate':'OpenPLC 原生产物','plcdev_hmi_generate':'FUXA 原生画面','plcdev_oip_generate':'OIP 原生产物','plcdev_team_assemble':'三端候选组装','plcdev_team_report':'专业报告回执','plcdev_team_reconcile':'成果与原生任务核对'} as any)[toolName]||'PLCdev 工具';
  const outcome=phase!=='result'?'正在处理…':block.isError?'工具未完成，请展开结果核对。':task?(toolName==='plcdev_propose_joint'?'联合候选任务已登记（登记时状态）':'工具返回时状态：'+taskStatus(task.status)):data?.projectId?'已核对当前工程的已保存版本':'结果已记录';
  const chip=(kind:string,state:string)=><span key={kind} style={{padding:'2px 6px',borderRadius:6,border:'1px solid var(--dsw-alias-border-l1,#e2e8f0)',color:stageColor(stageTone(kind,state)),fontSize:11}}>{kind==='validation'?'校验':kind==='retention'?'保留':kind==='compilation'?'编译':'Runtime'}：{stageLabel(kind,state)}</span>;
  const finalResult=!!target&&(!!task?.candidate||teamAnalysis||['plcdev_propose_joint','plcdev_team_assemble'].includes(toolName));
  if(!finalResult)return <details style={{fontSize:12,margin:'6px 0'}}><summary>{title} · {outcome}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{phase==='result'?(block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):'等待工具返回'}</pre></details>;
  return <section className="pc-tool-card" aria-label={title}><style>{css}</style>
    <div className="pc-row"><strong>{title}</strong><span className="pc-spacer"/>{target&&<button onClick={()=>onReviewTask(target)}>{teamAnalysis?'查看专业分析':'查看更改'}</button>}</div>
    <p style={{margin:'5px 0',fontSize:13}}>{outcome}</p>
    {projectId&&<p style={{margin:'2px 0',fontSize:12}}>所属工程：<strong>{projectName||'工程名称未提供'}</strong></p>}
    {artifacts.length>0&&<div style={{marginTop:6,display:'grid',gap:4}}>{artifacts.map(row=><p key={row.tool} style={{margin:0,fontSize:12}}><strong>{row.badge}</strong> · {row.name}：{row.summary||'尚未产生候选摘要'}{row.widgets!==null?`（${row.widgets} 个可编辑控件）`:''}</p>)}</div>}
    {teamAnalysis?<p className="pc-muted">独立分析报告 · 候选生成、编译与运行未执行</p>:stages&&<div className="pc-row" style={{marginTop:6}}>{chip('validation',stages.validation)}{chip('retention',stages.retention)}{chip('compilation',stages.compilation)}{chip('runtime',stages.runtime)}</div>}
    {task?.workflow==='team-generation-v1'&&<p className="pc-muted">三名原生成员分别提交产物；服务回执不代表编译或运行通过。</p>}
    {target&&<p className="pc-muted">这是本次工具调用的历史记录，不代表最新状态；点击审阅重新读取 TaskService。</p>}
    <details><summary className="pc-muted">工具结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:11}}>{phase==='result'?(block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):'等待真实工具返回'}</pre></details>
  </section>;
}

function RevisionControls({contexts,sessionId,task}:any){
  const controller=contexts.get(sessionId),[binding,setBinding]=useState(controller.snapshot());
  useEffect(()=>controller.subscribe(()=>setBinding(controller.snapshot())),[controller]);
  return <div><p>继续修改支持 HMI 标题，例如“标题改成 6”；其他内容保持上一版规格。</p><button disabled={binding.busy||!!binding.pending||!!binding.storageError||task.status!=='awaiting_review'} onClick={()=>controller.revise(task)}>{binding.binding?.projectId===task.projectId?'继续修改':'切回此工程继续修改'}</button>{binding.error&&<p role="status">{binding.error}</p>}</div>;
}
export function ConversationReview({sessionId,useTabInfo,onOverview,onRetainedProject,onProject,contexts}:any){
  const info=useTabInfo();const params=info?.tab?.navigation?.params;
  let target:any;try{target=restoredReviewTarget(browserStorage(),sessionId,params);}catch{target=reviewTarget(params);}
  const [loadedTask,setTask]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const [snapshot,setSnapshot]=useState<any>(null),[taskList,setTaskList]=useState<any>(null);
  const [metadataWarning,setMetadataWarning]=useState('');
  const [pendingAction,setPendingAction]=useState<any>(null);
  const gate=useRef(0),alive=useRef(true);
  const task=loadedTask?.projectId===target?.projectId&&loadedTask?.taskId===target?.taskId?loadedTask:null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;gate.current++;};},[]);
  useEffect(()=>{if(params==null||!target)return;try{saveReviewBookmark(browserStorage(),sessionId,target);}catch{setNotice('浏览器无法保存审阅位置；刷新后请从所属工程任务重新打开。');}},[sessionId,target?.projectId,target?.taskId,params]);
  useEffect(()=>{try{setPendingAction(readReviewPending(browserStorage(),sessionId,target));}catch(e:any){setNotice(textError(e));setPendingAction({invalid:true});}},[sessionId,target?.projectId,target?.taskId]);
  useEffect(()=>{
    let stopped=false,timer:any;const ticket=++gate.current;setTask(null);setSnapshot(null);setTaskList(null);setMetadataWarning('');setError('');setNotice('');setBusy(false);
    async function read(){
      if(!target){setError('未指定有效的工程候选。');return;}
      const projectId=target.projectId;
      try{
        // Name lookup only reads the fixed target project; the id is rechecked before use.
        let status:any=null,nameError='';
        try{status=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);}
        catch(e:any){nameError=textError(e);}
        const data=validateTasks(await api('tasks?project='+encodeURIComponent(projectId),undefined,60000),projectId);
        if(status&&status.project?.id!==projectId)throw new Error('工程名称返回了其他工程，已停用显示。');
        const exact=data.tasks.find((t:any)=>t.taskId===target.taskId);
        if(!exact)throw new Error('该工程中未找到此任务，未回退到其他候选。');
        if(!stopped&&ticket===gate.current&&target.projectId===projectId){
          setTask(exact);setSnapshot(status);setTaskList(data);
          setError('');setMetadataWarning(nameError?'工程名称未能确认；以下任务已按工程 UUID 核对。':'');
        }
      }catch(e:any){if(!stopped&&ticket===gate.current){setTask(null);setSnapshot(null);setTaskList(null);setError(textError(e));}}
      finally{if(!stopped)timer=setTimeout(read,4000);}
    }
    read();return()=>{stopped=true;gate.current++;clearTimeout(timer);};
  },[sessionId,target?.projectId,target?.taskId,refresh]);
  async function open(){const body=reviewedCandidate(task,target);if(!body||busy)return;const ticket=gate.current;setBusy(true);setNotice('核对摘要并请求打开独立候选…');try{const result=await api('tasks/open',body,65000);if(!result.ok||result.projectId!==body.projectId||result.taskId!==body.taskId||result.candidateDigest!==body.candidateDigest)throw new Error('候选打开结果身份未确认。');if(alive.current&&ticket===gate.current)setNotice('已请求在 OpenPLC 打开该副本；请在原生编辑器中核对。');}catch(e:any){if(alive.current&&ticket===gate.current)setNotice(textError(e));}finally{if(alive.current&&ticket===gate.current)setBusy(false);}}
  async function reviewAction(action:string){
    if(busy||!target||pendingAction?.invalid)return;
    const body=pendingAction||reviewActionRequest(sessionId,task,target,action,crypto.randomUUID());
    if(!body)return;
    const key=reviewPendingKey(sessionId,target),ticket=gate.current;
    try{browserStorage().setItem(key,JSON.stringify(body));setPendingAction(body);}catch{setNotice('无法保存审阅请求编号，本次未发送。');return;}
    setBusy(true);setNotice('正在登记审阅操作…');
    try{
      const result=await api('conversations/review',body,30000);
      if(!result.ok||result.projectId!==body.projectId||result.taskId!==body.taskId||result.candidateDigest!==body.candidateDigest)throw new Error('审阅操作归属未确认。');
      browserStorage().removeItem(key);
      if(alive.current&&ticket===gate.current){setPendingAction(null);setTask(result.task||task);setNotice('操作已登记，结果会自动更新。');}
    }catch(e:any){
      if(definitiveFailure(e)){browserStorage().removeItem(key);if(alive.current&&ticket===gate.current)setPendingAction(null);}
      if(alive.current&&ticket===gate.current)setNotice(definitiveFailure(e)?textError(e):'结果待核对；请使用原请求编号核对，不要重复创建操作。');
    }finally{if(alive.current&&ticket===gate.current)setBusy(false);}
  }
  const enabled=(action:string)=>!busy&&!pendingAction&&(action!=='keep'||revisionBasis(task?.projectRevision,taskList?.projectRevision).same===true)&&!!reviewActionRequest(sessionId,task,target,action,'availability-check');
  const evidence=(value:any)=>typeof value==='string'?value:JSON.stringify(value,null,2);
  const diagnostic=task?.compilation?.diagnostic||task?.compilation?.reason||task?.compilation?.message;
  const identity=projectIdentity(snapshot,target?.projectId);
  const revision=revisionBasis(task?.projectRevision,taskList?.projectRevision);
  const stages=reviewStages(task);
  const generated=['joint-ai-v1','team-generation-v1'].includes(task?.workflow);
  const artifacts=generated?artifactRows(task):[];
  const retainedProjectId=stages?.retainedProjectId||null;
  const stage=(kind:string,state:string)=><span key={kind} style={{padding:'3px 7px',borderRadius:6,border:'1px solid var(--dsw-alias-border-l1,#e2e8f0)',color:stageColor(stageTone(kind,state)),fontSize:12}}>{kind==='validation'?'校验':kind==='retention'?'保留':kind==='compilation'?'编译':'Runtime'}：{stageLabel(kind,state)}</span>;
  return <section className="pc-review" aria-label="PLCdev 原生候选审阅" data-project-id={target?.projectId||''}><style>{css}</style>
    <div className="pc-row"><h2>{task?.workflow==='team-analysis-v1'?'PLCdev 团队分析':'PLCdev 候选审阅'}</h2><span className="pc-spacer"/><button onClick={onOverview}>工程总览</button><button onClick={()=>setRefresh(n=>n+1)} disabled={busy}>刷新</button></div>
    {target&&<div className="pc-row" style={{marginTop:6}}><strong data-project-name={identity?.name||''}>{projectLabel(identity)}</strong><span className="pc-muted"><code>{target.projectId}</code></span></div>}
    {metadataWarning&&<p role="status" className="pc-muted">{metadataWarning}</p>}
    {error?<p role="status" className="pc-error">{error}</p>:!task?<p>正在读取所属工程任务…</p>:<>
      <p style={{marginTop:6}}><strong>{taskStatus(task.status)}</strong></p><p>{task.request}</p>
      {task.supersededBy&&<p role="status">此版本已被新候选替代，不能创建修改副本。新任务：{task.supersededBy}</p>}
      {task.parentTaskId&&<p className="pc-muted">继续修改自任务：{task.parentTaskId}</p>}
      <p className="pc-muted">{task.sourceBasis==='saved_revision'?'基于工程已保存版本 · 不含编辑器未保存修改':'输入范围以原始任务记录为准'}</p>
      <div className="pc-row" style={{marginTop:6}}><span className="pc-muted">输入基线版本</span><code>{revision.baseline?revision.baseline.slice(0,12):'未提供'}</code><span className="pc-muted">当前保存版本</span><code>{revision.current?revision.current.slice(0,12):'未读取'}</code></div>
      {revision.same===false&&<p className="pc-error" role="status">{task.workflow==='team-analysis-v1'?'当前保存版本已变化；本报告仍对应原固定版本，不能当作新版本的分析。':'当前保存版本已不同于任务输入基线；旧候选不能保留。已保留工程仍按其保留版本摘要编译。'}</p>}
      {revision.same===null&&<p className="pc-muted">工程保存版本对照尚未确认，暂按任务记录的输入基线显示。</p>}
      {generated&&<>
        <h3>修改摘要 · PLC / HMI / 场景</h3>
        <div style={{display:'grid',gap:8}}>{artifacts.map(row=><article key={row.tool} style={{display:'flex',gap:10,padding:10,border:'1px solid var(--dsw-alias-border-l2,#dde4ed)',borderRadius:'var(--dsw-radius-md,12px)'}}><span style={{alignSelf:'flex-start',padding:'3px 6px',borderRadius:6,background:'var(--dsw-alias-bg-layer-2,#f1f5f9)',fontSize:11,fontWeight:600}}>{row.badge}</span><div><strong>{row.name}</strong><p style={{margin:'3px 0',fontSize:13}}>{row.summary||'未提供候选摘要'}</p>{row.widgets!==null&&<span className="pc-muted">{row.widgets} 个可编辑控件</span>}</div></article>)}</div>
        <div className="pc-row" style={{marginTop:10}}><span className="pc-muted">候选摘要</span><code>{task.candidate?.candidateDigest?task.candidate.candidateDigest.slice(0,12):'尚未产生'}</code></div>
        <h3>分层状态</h3>
        <div className="pc-row">{stages&&<>{stage('validation',stages.validation)}{stage('retention',stages.retention)}{stage('compilation',stages.compilation)}{stage('runtime',stages.runtime)}</>}</div>
        {retainedProjectId&&<p>已保留为新 UUID：<code>{retainedProjectId}</code>{identity?.name&&task.retention?.projectName?`（${task.retention.projectName}）`:''}</p>}
        {retainedProjectId&&onRetainedProject&&<button onClick={()=>onProject?onProject(sessionId,retainedProjectId):onRetainedProject(retainedProjectId)}>打开修改副本</button>}
        {stages?.retention==='discarded'&&<p className="pc-muted">候选已撤销；本任务不再提供保留。</p>}
        {contexts&&task.candidate?.revisionSupported===true&&task.workflow==='joint-ai-v1'&&task.status==='awaiting_review'&&revision.same===true&&<RevisionControls {...{contexts,sessionId,task}}/>}
        <div className="pc-row" style={{marginTop:14}}><button disabled={!enabled('keep')} onClick={()=>reviewAction('keep')}>创建修改副本</button>{!retainedProjectId&&<button disabled={!enabled('undo')} onClick={()=>reviewAction('undo')}>放弃这次修改</button>}<button disabled={!enabled('compile')} onClick={()=>reviewAction('compile')}>编译保留版本</button></div>
        {pendingAction&&<p className="pc-error">审阅请求待核对 {pendingAction.clientRequestId||''} <button disabled={busy||pendingAction.invalid} onClick={()=>reviewAction(pendingAction.action)}>以原请求编号核对</button></p>}
        <p className="pc-muted">保留创建新工程副本；原工程与 Runtime 不变。撤销仅适用于尚未保留的候选，保留后不提供自动回滚。编译通过也不会启动运行。</p>
        {task.compilation&&<div><h3>{stageLabel('compilation',stages?.compilation)}</h3>{stages?.historicalCompilation?<p className="pc-muted">历史编译通过（旧版本回执），不代表本次操作成功。{task.compilation.revision&&<> 旧版本：<code>{task.compilation.revision}</code></>}</p>:<p className="pc-muted">{typeof diagnostic==='string'?diagnostic.slice(0,240):task.compilation.status==='compiled'?'已验证保留版本；编译记录不证明当前运行状态。':'请展开技术详情查看编译诊断。'}</p>}</div>}
      </>}
      {task.workflow==='team-generation-v1'&&<>
        <h3>原生团队 · PLC／HMI／OIP 独立产物</h3>
        <p className="pc-muted">三个成员使用同一保存版本，分别生成本工具原生产物。下列回执由 TaskService 根据产物生成，不是静态分析或运行证据。</p>
        <p className="pc-muted">本批支持批次初始数量、可编辑 FUXA 页面及已有输送带速度；不包含任意 PLC 逻辑或场景几何生成。</p>
        <p className="pc-muted">Lead 会话：<code>{task.teamAnalysis?.rootSessionId}</code></p>
        {(task.teamAnalysis?.members||[]).map((member:any)=><article key={member.role} style={{padding:12,marginTop:10,border:'1px solid var(--dsw-alias-border-l2,#dde4ed)',borderRadius:10}}>
          <strong>{member.role.toUpperCase()} · {member.componentDigest?'产物已登记':'等待本角色产物'}</strong>
          <p>{member.instruction}</p><p className="pc-muted">原生任务 {member.nativeTaskId||'待登记'} · 子会话 <code>{member.sessionId||'待创建'}</code></p>
          {member.report&&<><p>{member.report.summary}</p><ul>{member.report.findings.map((finding:string,i:number)=><li key={i}>{finding}</li>)}</ul><p className="pc-muted">尚未验证：{member.report.unverified.join('；')}</p></>}
          {member.componentDigest&&<p className="pc-muted">产物摘要 <code>{member.componentDigest.slice(0,12)}</code> · 原生通知 {member.notice==='accepted'?'已进入 Lead 收件箱':'尚未确认，原产物保留'}</p>}
        </article>)}
      </>}
      {task.workflow==='team-analysis-v1'&&<>
        <h3>原生团队 · PLC／HMI 专业分析</h3>
        <p className="pc-muted">成员分别读取同一固定版本。以下是分析报告；候选生成、编译和 Runtime 验证未执行。</p>
        <p className="pc-muted">Lead 会话：<code>{task.teamAnalysis?.rootSessionId}</code></p>
        {(task.teamAnalysis?.members||[]).map((member:any)=><article key={member.role} style={{padding:12,marginTop:10,border:'1px solid var(--dsw-alias-border-l2,#dde4ed)',borderRadius:10}}>
          <strong>{member.role.toUpperCase()} · {member.report?'报告已登记':'等待报告'}</strong>
          <p>{member.instruction}</p><p className="pc-muted">原生任务 {member.nativeTaskId||'待登记'} · 子会话 <code>{member.sessionId||'待创建'}</code></p>
          {member.report&&<><p>{member.report.summary}</p><ul>{member.report.findings.map((finding:string,i:number)=><li key={i}>{finding}</li>)}</ul><h3>待验证</h3><ul>{member.report.unverified.map((item:string,i:number)=><li key={i}>{item}</li>)}</ul><p className="pc-muted">报告摘要 <code>{member.reportDigest?.slice(0,12)}</code> · 通知 {member.notice==='accepted'?'已进入 Lead 收件箱':'尚未确认，可直接核对本报告'}</p></>}
        </article>)}
      </>}
      {!generated&&task.candidate?.summary&&<div className="pc-change"><code>{task.candidate.summary.before}</code> → <code>{task.candidate.summary.after}</code></div>}
      <p className="pc-muted">{task.reason||task.message||'任务状态由原 TaskService 提供。'}</p>
      {task.workflow!=='team-analysis-v1'&&<button style={{marginTop:12}} onClick={open} disabled={busy||!!pendingAction||!reviewedCandidate(task,target)}>在 OpenPLC 打开候选</button>}
      {!['joint-ai-v1','team-analysis-v1','team-generation-v1'].includes(task.workflow)&&<p className="pc-muted">此任务为既有规则候选；真实 AI 联合能力以任务记录为准。</p>}
      <details style={{marginTop:18}}><summary>技术详情</summary><dl><dt>所属工程</dt><dd>{projectLabel(identity)}</dd><dt>工程 UUID</dt><dd>{task.projectId}</dd><dt>任务编号</dt><dd>{task.taskId}</dd><dt>输入基线版本</dt><dd>{task.projectRevision||task.candidate?.baselineRevision||'未提供'}</dd><dt>当前保存版本</dt><dd>{taskList?.projectRevision||'未读取'}</dd><dt>保留工程 UUID</dt><dd>{retainedProjectId||'未保留'}</dd><dt>候选摘要</dt><dd>{task.candidate?.candidateDigest||'尚未产生'}</dd></dl><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{evidence({components:task.candidate?.components,changes:task.candidate?.changes,validation:task.candidate?.validation,modelEvidence:task.candidate?.modelEvidence,retention:task.retention,compilation:task.compilation})}</pre></details>
    </>}{notice&&<p role="status" className="pc-error">{notice}</p>}
  </section>;
}
