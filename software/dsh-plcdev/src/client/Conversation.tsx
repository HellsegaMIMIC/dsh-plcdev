import {BrandTitle} from './Brand';
import React, { useEffect, useRef, useState } from 'react';
import { validateSnapshot, validateTasks, definitiveFailure, taskStatus } from './model.mjs';
import { conversationApi as api, reviewTarget, saveReviewBookmark, restoredReviewTarget, validateBinding, candidateChanges } from './conversation-client.mjs';
import { reviewActionRequest, reviewPendingKey, readReviewPending, reviewReceiptRequest, validateReviewReceipt } from './conversation-client.mjs';
import { reviewDisabledReason, revisionDisabledReason } from './review-ui-state.mjs';
import { projectIdentity, projectLabel, revisionBasis, reviewStages, stageLabel, stageTone, stageColor, artifactRows, artifactSummary } from './conversation-client.mjs';
import {turnCandidateResults,openResultInEditor,editorOpenNotice,editorOpenRequest,prepareEditorSession} from './result-flow.mjs';
import {ResultPreview} from './ResultPreview';
import {CandidateResultCard} from './CandidateResultCard';
import {ResultOperationCards} from './ResultOperationCards';
import {candidateOperationGroups} from './candidate-operations.mjs';
import {oipResultState,oipPreviewState,readOipResourceObservation} from './oip-result-state.mjs';
import {reviewMutationLocks,notifyReviewChange,REVIEW_CHANGED,reviewResultConfirmed,reviewRejection,clearReviewPending,settleReviewPending} from './review-mutation.mjs';
import {taskReadsFor} from './task-reads.mjs';

const css = `
.pc-tool-card,.pc-review{--pc-surface:var(--dsw-alias-bg-base,#fff);--pc-canvas:var(--dsw-alias-bg-module-platform,#f5f6f8);--pc-line:var(--dsw-alias-border-l2,#e2e6ed);--pc-sub:var(--dsw-alias-label-secondary,#667085);--pc-accent:var(--plcdev-accent);color:var(--dsw-alias-label-primary,#202939);font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);box-sizing:border-box}
.pc-tool-card *,.pc-review *{box-sizing:border-box}
.pc-tool-card{border:1px solid var(--pc-line);background:var(--pc-surface);border-radius:12px;padding:14px 16px;margin:8px 0}
:is(.pc-review,.pc-tool-card) .pc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
:is(.pc-review,.pc-tool-card) .pc-row>strong{font-size:14px;font-weight:600}
:is(.pc-review,.pc-tool-card) .pc-muted{font-size:12px;line-height:1.65;color:var(--pc-sub,var(--dsw-alias-label-secondary,#667085))}
:is(.pc-review,.pc-tool-card) .pc-row .pc-spacer{flex:1}
.pc-tool-card button,.pc-review button{font:inherit;font-size:13px;font-weight:500;line-height:1.4;min-height:36px;color:inherit;background:var(--pc-surface);border:1px solid var(--pc-line);border-radius:8px;padding:7px 12px;cursor:pointer;transition:background .15s,border-color .15s}
.pc-tool-card button:hover:not(:disabled),.pc-review button:hover:not(:disabled){background:var(--pc-canvas);border-color:color-mix(in srgb,var(--pc-accent) 35%,var(--pc-line))}
.pc-tool-card button:focus-visible,.pc-review button:focus-visible,.pc-tool-card summary:focus-visible,.pc-review summary:focus-visible{outline:2px solid var(--pc-accent);outline-offset:3px}
.pc-tool-card .pc-primary,.pc-review .pc-primary{background:var(--pc-accent);border-color:var(--pc-accent);color:var(--plcdev-on-accent)}
.pc-tool-card .pc-primary:hover:not(:disabled),.pc-review .pc-primary:hover:not(:disabled){background:var(--pc-accent);filter:brightness(.95)}
.pc-review .pc-quiet{border-color:transparent;background:transparent;color:var(--pc-sub)}
.pc-tool-card button:disabled,.pc-review button:disabled{opacity:.55;cursor:default}
:is(.pc-review,.pc-tool-card) .pc-error{color:var(--dsw-alias-label-primary,#24334a);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#8b5b14) 45%,currentColor);font-size:13px;margin-top:7px;overflow-wrap:anywhere}
.pc-review .pc-error{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b7791f) 7%,var(--pc-surface));border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b7791f) 20%,var(--pc-line))}
.pc-tool-card code,.pc-review code{font-family:var(--ds-font-family-code,monospace)}
.pc-review{height:100%;overflow:auto;padding:20px;background:var(--pc-canvas)}
.pc-review-surface{max-width:960px;margin:0 auto;padding:20px 24px;background:var(--pc-surface);border:1px solid var(--pc-line);border-radius:12px;min-width:0}
.pc-review.pc-review-embedded{padding:0;background:var(--pc-surface)}.pc-review-embedded .pc-review-surface{max-width:none;border:0;border-radius:0;padding:20px}.pc-review-embedded .pc-review-toolbar{position:sticky;top:-20px;padding-top:12px;background:var(--pc-surface);z-index:1}
.pc-review h2{font-size:17px;line-height:1.5;font-weight:600;margin:0}
.pc-review h3{font-size:14px;font-weight:600;margin:24px 0 10px}
.pc-review-toolbar{padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--pc-line)}
.pc-review .pc-review-request{font-size:15px;font-weight:500;line-height:1.65;margin:8px 0 12px}
.pc-review .pc-review-state{display:inline-flex;align-items:center;border-radius:6px;background:var(--pc-canvas);padding:3px 8px;font-size:12px;font-weight:500}
.pc-review .pc-review-actions{margin-top:20px!important;padding-top:18px;border-top:1px solid var(--pc-line);gap:10px;align-items:flex-start}
.pc-review-actions>div{flex:0 1 200px;max-width:260px;min-width:0}.pc-review-actions small{margin-top:4px}
.pc-review .pc-revision-controls{padding:14px 16px;margin-top:18px;background:var(--pc-canvas);border-radius:8px}.pc-revision-controls>p{margin-top:0}.pc-revision-controls>small{display:block;margin-top:7px;color:var(--pc-sub);font-size:12px}
.pc-review p{margin:8px 0;overflow-wrap:anywhere}
.pc-review dl{display:grid;grid-template-columns:78px minmax(0,1fr);gap:7px;margin:12px 0}
.pc-review dt{font-size:13px;color:var(--pc-sub)}
.pc-review dd{margin:0;overflow-wrap:anywhere;font-size:13px}
.pc-review .pc-change{font-size:16px;padding:14px 16px;margin:14px 0;background:var(--pc-canvas);border:1px solid var(--pc-line);border-radius:8px;overflow-wrap:anywhere}
.pc-review ul{padding-left:22px;margin:10px 0 16px}.pc-review li{padding:5px 0;overflow-wrap:anywhere}.pc-review li code{font-size:12px;color:var(--pc-sub)}
.pc-review .pc-changed-files{list-style:none;padding:0}.pc-review .pc-changed-files li{padding:0}.pc-review .pc-changed-files details{border:0;margin:0;padding:6px 0}.pc-review .pc-changed-files summary{color:inherit;font-weight:400}.pc-review details{padding:12px 0;border-top:1px solid var(--pc-line);margin-top:14px}.pc-review summary,.pc-tool-card summary{cursor:pointer;color:var(--pc-sub);font-size:13px;font-weight:500;line-height:1.6}.pc-review details[open]>summary{margin-bottom:12px}.pc-review pre,.pc-tool-card pre{background:var(--pc-canvas);padding:12px;border-radius:8px}.pc-tool-card details{margin-top:12px;padding-top:10px;border-top:1px solid var(--pc-line)}
@media(max-width:480px){.pc-review{padding:12px}.pc-review-surface{padding:16px 14px;border-radius:10px}.pc-review-toolbar{gap:6px}.pc-review-toolbar h2{width:100%}.pc-review-toolbar .pc-spacer{display:none}.pc-tool-card{padding:12px}.pc-review-actions>div{max-width:none;flex-basis:100%}.pc-review dl{grid-template-columns:72px minmax(0,1fr)}}

:is(.pc-review,.pc-tool-card) summary{list-style:none;display:flex;align-items:center;gap:10px}:is(.pc-review,.pc-tool-card) summary::-webkit-details-marker{display:none}:is(.pc-review,.pc-tool-card) summary:before{content:'';display:inline-block;width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);margin-right:2px}:is(.pc-review,.pc-tool-card) details[open]>summary:before{transform:rotate(135deg)}
`;
const browserStorage=()=>window.localStorage;
const textError=(e:any)=>e?.name==='AbortError'?'请求超时，未自动重试。':e?.message||'请求失败。';
function visibleArtifacts(task:any){
  return artifactRows(task).flatMap((row:any)=>{
    const changes=Array.isArray(row.component?.changes)?row.component.changes:Array.isArray(row.component?.changedFiles)?row.component.changedFiles:[];
    if(!row.summary&&!changes.length&&row.widgets===null)return [];
    return [{...row,summary:row.summary||(changes.length?`${changes.length} 个文件变化`:'已生成原生画面')}];
  });
}
/**
 * Native tool.result presentation. The durable event supplies task identity;
 * this card is a historical call record and never claims to be the latest state.
 */
export function TurnResultCards({turn,usePlcdevTurnTools,sessionId,onReviewTask,onContinueRetained,onContinueCurrent,onOpenEditorSession,onOpenResultResource,contexts}:any){
  const nodes=usePlcdevTurnTools(String(turn.turn));
  const results=turnCandidateResults(nodes);
  if(!results.length)return null;
  return <div data-plcdev-turn-results={turn.turn}>{results.map((result:any)=><CandidateResultCard key={result.key} {...result} {...{sessionId,onReviewTask,onContinueRetained,onContinueCurrent,onOpenEditorSession,onOpenResultResource,contexts}}/>)}</div>;
}

export function NativeToolCard({phase,block,toolName,onReviewTask,standalone=false,sessionId,onContinueRetained,onContinueCurrent,onOpenEditorSession,resultInTurn=false}:any){
  let data:any=null;try{if(phase==='result'&&!block.isError)data=JSON.parse((block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'));}catch{}
  const target=reviewTarget(data?.task||block?.meta);
  const task=data?.task||null;
  const [live,setLive]=useState<any>(null);
  const [opening,setOpening]=useState(false),[openNotice,setOpenNotice]=useState('');
  const [editorReceipt,setEditorReceipt]=useState<any>(null);
  const openGate=useRef(0),cardInFlight=useRef(false);
  useEffect(()=>{openGate.current++;setOpening(false);setOpenNotice('');setEditorReceipt(null);return()=>{openGate.current++;};},[target?.projectId,target?.taskId,sessionId]);
  useEffect(()=>{
    let stopped=false,timer:any;
    setLive(null);
    if(!target||resultInTurn)return;
    async function read(){
      try{
        const listing=validateTasks(await api('tasks?project='+encodeURIComponent(target.projectId),undefined,60000),target.projectId);
        const current=listing.tasks.find((item:any)=>item.taskId===target.taskId);
        if(!current)throw new Error('未找到任务');
        if(!stopped)setLive({projectId:target.projectId,taskId:target.taskId,task:current,revision:listing.projectRevision});
      }catch{if(!stopped)setLive({projectId:target.projectId,taskId:target.taskId,error:true});}
      finally{if(!stopped)timer=setTimeout(read,4000);}
    }
    read();return()=>{stopped=true;clearTimeout(timer);};
  },[target?.projectId,target?.taskId,resultInTurn]);
  const currentLive=live?.projectId===target?.projectId&&live?.taskId===target?.taskId?live:null;
  const visibleTask=currentLive?.task||task;
  const retainedProjectId=reviewStages(currentLive?.task)?.retainedProjectId;
  const savedToCurrent=currentLive?.task?.retention?.completionScope==='saved-project-version'&&retainedProjectId===target?.projectId;
  const canOpenPlc=visibleTask&&!['team-analysis-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1'].includes(visibleTask.workflow);
  async function openCardResult(){
    if(cardInFlight.current||!currentLive?.task||!sessionId)return;
    cardInFlight.current=true;
    const ticket=++openGate.current;setOpening(true);setOpenNotice(retainedProjectId?'修改工程已保存，正在打开…':'正在打开独立预览…');
    try{const result=await openResultInEditor({api,conversationId:sessionId,task:currentLive.task,onState:(value:any)=>{setEditorReceipt(value);setOpenNotice(editorOpenNotice(value,!!retainedProjectId));},isCurrent:()=>ticket===openGate.current});
      if(ticket===openGate.current&&result.state==='requested')setOpenNotice((retainedProjectId?'修改工程已保存。':'')+'OpenPLC 尚未确认加载，请核对编辑器后重试打开。');
    }catch(e:any){if(ticket===openGate.current)setOpenNotice((retainedProjectId?'修改工程已保存。':'')+textError(e));}
    finally{cardInFlight.current=false;if(ticket===openGate.current)setOpening(false);}
  }
  async function continueCardResult(){
    if(cardInFlight.current||!retainedProjectId||!(savedToCurrent?onContinueCurrent:onContinueRetained))return;
    cardInFlight.current=true;const ticket=openGate.current;setOpening(true);
    try{
      let result;
      if(savedToCurrent)result=await onContinueCurrent({sessionId,...target});
      else if(canOpenPlc&&onOpenEditorSession){const link=editorReceipt?.sessionId&&editorReceipt.targetProjectId===retainedProjectId?editorReceipt:await prepareEditorSession(api,sessionId,currentLive.task);if(ticket!==openGate.current)return;setEditorReceipt(link);result=await onOpenEditorSession(link);}
      else result=await onContinueRetained({sourceSessionId:sessionId,sourceProjectId:target.projectId,taskId:target.taskId,candidateDigest:currentLive.task.candidate?.candidateDigest,keptProjectId:retainedProjectId,revision:currentLive.task.retention.revision});
      if(ticket===openGate.current&&result?.ok===false)setOpenNotice(result.message||'接续会话尚未确认。');
    }
    catch(error:any){if(ticket===openGate.current)setOpenNotice(textError(error));}
    finally{cardInFlight.current=false;if(ticket===openGate.current)setOpening(false);}
  }
  const teamAnalysis=task?.workflow==='team-analysis-v1';
  const projectName=typeof data?.projectName==='string'&&data.projectName.trim()?data.projectName.trim():null;
  const projectId=target?.projectId||(typeof data?.projectId==='string'?data.projectId:null);
  const artifacts=['joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(visibleTask?.workflow)?visibleArtifacts(visibleTask):[];
  const title=({'plcdev_propose_project_edit':'工程修改候选','plcdev_validate_candidate':'编译验证保留版本','plcdev_propose_hmi_readonly_value':'HMI 只读显示候选','plcdev_propose_hmi_static_text':'HMI 静态文字候选','plcdev_propose_hmi_view_name':'HMI 画面名称候选','plcdev_project_context':'核对工程上下文','plcdev_propose_joint':'PLC／HMI／场景联合候选','plcdev_task_status':'读取候选状态','plcdev_team_context':'核对团队工程','plcdev_team_plan':'原生团队分工','plcdev_team_generate_plan':'三端原生团队分工','plcdev_team_status':'收回专业成果','plcdev_team_control':'专业成员控制','plcdev_plc_analyze':'PLC 专业读取','plcdev_hmi_analyze':'HMI 专业读取','plcdev_oip_analyze':'OIP 专业读取','plcdev_plc_generate':'OpenPLC 原生产物','plcdev_hmi_generate':'FUXA 原生画面','plcdev_oip_generate':'OIP 原生产物','plcdev_team_assemble':'三端候选组装','plcdev_team_report':'专业报告回执','plcdev_team_reconcile':'成果与原生任务核对'} as any)[toolName]||'PLCdev 工具';
  const outcome=phase!=='result'?'正在处理…':block.isError?'工具未完成，请展开结果核对。':task?(toolName==='plcdev_propose_joint'?'联合候选任务已登记（登记时状态）':'工具返回时状态：'+taskStatus(task.status)):data?.projectId?'已核对当前工程的已保存版本':'结果已记录';
  const chip=(kind:string,state:string)=><span key={kind} style={{padding:'2px 6px',borderRadius:6,border:'1px solid var(--pc-line,var(--dsw-alias-border-l2,#dfe5ec))',color:stageColor(stageTone(kind,state)),fontSize:11}}>{kind==='validation'?'校验':kind==='retention'?'保留':kind==='compilation'?'编译':'Runtime'}：{stageLabel(kind,state)}</span>;
  const finalResult=!!target&&(!!task?.candidate||teamAnalysis||['plcdev_propose_joint','plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text','plcdev_propose_project_edit','plcdev_validate_candidate','plcdev_team_assemble'].includes(toolName));
  if(!finalResult||resultInTurn&&!standalone)return <details style={{fontSize:12,margin:'6px 0'}}><summary>{title} · {outcome}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{phase==='result'?(block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):'等待工具返回'}</pre></details>;
  return <section className="pc-tool-card plcdev-scope plcdev-rail" aria-label={'PLCdev '+title}><style>{css}</style>
    <div className="pc-row"><strong><BrandTitle>{standalone&&!teamAnalysis?'工程修改结果':title}</BrandTitle></strong><span className="pc-spacer"/>{target&&<button className="plcdev-link" onClick={()=>onReviewTask(target)}>{teamAnalysis?'查看专业分析':standalone?'查看修改结果':'查看更改'}</button>}</div>
    {standalone&&visibleTask?.request&&<p style={{margin:'8px 0',fontWeight:500}}>{visibleTask.request}</p>}
    <p style={{margin:'5px 0',fontSize:13}}>{currentLive?.task?'当前任务：'+taskStatus(currentLive.task.status):currentLive?.error?'当前任务状态未能确认，请打开审阅重试。':'正在读取当前任务状态…'}</p>
    {['conflict','unknown_outcome'].includes(currentLive?.task?.status)&&typeof currentLive.task.reason==='string'&&<p role="status" className="pc-error">{currentLive.task.reason}</p>}
    {currentLive?.task&&!retainedProjectId&&revisionBasis(currentLive.task.projectRevision,currentLive.revision).same===false&&<p role="status" className="pc-error">工程保存版本已变化，旧候选不能保留或继续修改。</p>}
    {projectId&&<p style={{margin:'2px 0',fontSize:12}}>所属工程：<strong>{projectName||'工程名称未提供'}</strong></p>}
    {standalone&&retainedProjectId&&<p style={{margin:'6px 0'}}>{savedToCurrent?'已保存到当前工程：':'已保存到：'}<strong>{(editorReceipt?.targetProjectId===retainedProjectId&&editorReceipt.projectName)||currentLive.task.retention?.projectName||(savedToCurrent?projectName||'当前工程':'修改工程副本')}</strong></p>}
    {artifacts.length>0&&<div style={{marginTop:6,display:'grid',gap:4}}>{artifacts.map(row=><p key={row.tool} style={{margin:0,fontSize:12}}><strong>{row.badge}</strong> · {row.name}：{row.summary||'尚未产生候选摘要'}{row.widgets!==null?`（${row.widgets} 个可编辑控件）`:''}</p>)}</div>}
    {teamAnalysis?<p className="pc-muted">独立分析报告 · 候选生成、编译与运行未执行</p>:currentLive?.task&&reviewStages(currentLive.task)&&<div className="pc-row" style={{marginTop:6}}>{!standalone&&chip('validation',reviewStages(currentLive.task).validation)}{chip('retention',reviewStages(currentLive.task).retention)}{chip('compilation',reviewStages(currentLive.task).compilation)}{!standalone&&chip('runtime',reviewStages(currentLive.task).runtime)}</div>}
    {standalone&&<div className="pc-row" style={{marginTop:12}}>{canOpenPlc&&<button disabled={opening||!currentLive?.task?.candidate||!['awaiting_review','kept','compiled','compile_failed'].includes(currentLive?.task?.status)} onClick={openCardResult}>{opening?'正在处理…':retainedProjectId?'打开修改工程':'在 OpenPLC 预览'}</button>}{retainedProjectId&&(savedToCurrent?onContinueCurrent:onContinueRetained)&&<button disabled={opening} onClick={continueCardResult}>{savedToCurrent?'继续修改':editorReceipt?.sessionId&&onOpenEditorSession?'前往编辑器会话':'继续修改这个版本'}</button>}</div>}
    {openNotice&&<p role="status" className="pc-muted">{openNotice}</p>}
    {standalone&&sessionId&&visibleTask?.workflow==='project-edit-v1'&&visibleTask?.candidate?.candidateDigest&&<ResultPreview conversationId={sessionId} task={visibleTask} compact/>}
    {task?.workflow==='team-generation-v1'&&<p className="pc-muted">三名原生成员分别提交产物；服务回执不代表编译或运行通过。</p>}
    {!standalone&&target&&<p className="pc-muted">产物摘要来自本次工具调用；状态由任务服务刷新。</p>}
    {!standalone&&<details><summary className="pc-muted">工具结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:11}}>{phase==='result'?(block.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):'等待真实工具返回'}</pre></details>}
  </section>;
}

function RevisionControls({contexts,sessionId,task}:any){
  const controller=contexts.get(sessionId),[binding,setBinding]=useState(controller.snapshot());
  useEffect(()=>controller.subscribe(()=>setBinding(controller.snapshot())),[controller]);
  const hint=task.workflow==='project-edit-v1'?'下一条需求会接着当前候选修改，可继续调整已开放的 PLC、HMI 或场景内容；此前修改会累积保留。':task.workflow==='hmi-static-text-v1'?'下一条需求请明确引用当前静态文字或文字 ID；只修改同一文字。':task.workflow==='hmi-view-name-v1'?'下一条需求请明确引用当前画面名称或画面 ID；只修改同一画面。':'继续修改支持 HMI 标题，例如“标题改成 6”；其他内容保持上一版规格。';
  const reason=revisionDisabledReason(binding,task),reasonId='plcdev-revision-reason-'+task.taskId;
  return <div className="pc-revision-controls"><p>{hint}</p><button disabled={!!reason} aria-describedby={reason?reasonId:undefined} onClick={()=>controller.revise(task)}>{binding.binding?.projectId===task.projectId?'继续修改':'切回此工程继续修改'}</button>{reason&&<small id={reasonId}> {reason}</small>}{binding.error&&<p role="status">{binding.error}</p>}</div>;
}
export function ConversationReview({sessionId,useTabInfo,target:explicitTarget,embedded=false,onClose,onSourceSession,onOverview,onRetainedProject,onContinueRetained,onContinueCurrent,onOpenEditorSession,onOpenResultResource,onProject,contexts}:any){
  const info=useTabInfo?.();const params=explicitTarget!==undefined?explicitTarget:info?.tab?.navigation?.params;
  let target:any;try{target=restoredReviewTarget(browserStorage(),sessionId,params);}catch{target=reviewTarget(params);}
  const [loadedTask,setTask]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const [snapshot,setSnapshot]=useState<any>(null),[taskList,setTaskList]=useState<any>(null);
  const [metadataWarning,setMetadataWarning]=useState('');
  const [pendingAction,setPendingAction]=useState<any>(null),[receipt,setReceipt]=useState<any>(null);
  const [editorReceipt,setEditorReceipt]=useState<any>(null);
  const [oipOpen,setOipOpen]=useState<any>(null);
  const [oipLaunch,setOipLaunch]=useState<any>(null);
  const gate=useRef(0),alive=useRef(true),reviewEpoch=useRef(0),reviewInFlight=useRef(new Set<string>());
  const continuing=useRef(false);
  const broadcasting=useRef(false);
  const autoOpen=useRef('');
  const activeReviewKey=useRef('');activeReviewKey.current=target?reviewPendingKey(sessionId,target):'';
  const task=loadedTask?.__reviewSessionId===sessionId&&loadedTask?.projectId===target?.projectId&&loadedTask?.taskId===target?.taskId?loadedTask:null;
  const receiptRequest=reviewRejection(task,pendingAction||task?.reviewReceiptRequest)?null:reviewReceiptRequest(sessionId,task,target,pendingAction);
  const operationGroups=candidateOperationGroups(task),resourceTools=operationGroups.filter((group:any)=>group.tool!=='project');
  const canOpenPlc=!!task&&(task.workflow==='project-edit-v1'?resourceTools.some((group:any)=>group.tool==='openplc'):!['team-analysis-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1'].includes(task.workflow));
  let openable=false;
  try{if(task){editorOpenRequest(sessionId,task);openable=true;}}catch{}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;gate.current++;};},[]);
  useEffect(()=>{setEditorReceipt(null);setOipOpen(null);setOipLaunch(null);},[sessionId,target?.projectId,target?.taskId]);
  useEffect(()=>{if(params==null||!target)return;try{saveReviewBookmark(browserStorage(),sessionId,target);}catch{setNotice('浏览器无法保存审阅位置；刷新后请从所属工程任务重新打开。');}},[sessionId,target?.projectId,target?.taskId,params]);
  useEffect(()=>{try{setPendingAction(readReviewPending(browserStorage(),sessionId,target));}catch(e:any){setNotice(textError(e));setPendingAction({invalid:true});}},[sessionId,target?.projectId,target?.taskId]);
  useEffect(()=>{const changed=(event:any)=>{if(broadcasting.current||(event.detail?.key||event.key)!==activeReviewKey.current)return;try{setPendingAction(readReviewPending(browserStorage(),sessionId,target));}catch(e:any){setNotice(textError(e));setPendingAction({invalid:true});}setRefresh(n=>n+1);};window.addEventListener(REVIEW_CHANGED,changed);window.addEventListener('storage',changed);return()=>{window.removeEventListener(REVIEW_CHANGED,changed);window.removeEventListener('storage',changed);};},[sessionId,target?.projectId,target?.taskId]);
  useEffect(()=>{
    const key=reviewPendingKey(sessionId,target);if(!task||reviewInFlight.current.has(key)||reviewMutationLocks.has(key))return;
    try{const result=settleReviewPending(browserStorage(),sessionId,target,task);
      if(result){
        setPendingAction(null);
        if(result.rejected)setNotice(result.rejected.reason);
        else if(result.request.action==='keep'){setOipOpen(null);setOipLaunch(null);if(canOpenPlc||onOpenResultResource&&resourceTools.length)autoOpen.current=key;setNotice('修改已保留，正在核对工程状态。');}
        else setNotice(result.request.action==='undo'?'本轮候选已撤销。':task.status==='compiled'?'编译验证通过。':'编译验证失败，请查看诊断。');
        taskReadsFor(contexts).invalidate(target.projectId,sessionId);contexts?.get(sessionId)?.refresh();broadcasting.current=true;notifyReviewChange(key);broadcasting.current=false;
      }
    }catch(e:any){setNotice(textError(e));}
  },[sessionId,target?.projectId,target?.taskId,task,pendingAction,busy]);
  useEffect(()=>{
    let stopped=false,timer:any;const ticket=++gate.current,key=target?reviewPendingKey(sessionId,target):'';setTask(null);setSnapshot(null);setTaskList(null);setMetadataWarning('');setError('');setNotice('');setReceipt(null);setBusy(reviewInFlight.current.has(key));
    async function read(){
      if(!target){setError('未指定有效的工程候选。');return;}
      const projectId=target.projectId,epoch=reviewEpoch.current;
      try{
        const binding=validateBinding(await api('conversations?conversationId='+encodeURIComponent(sessionId)),sessionId);
        if(!binding.taskRefs.some((ref:any)=>ref.projectId===projectId&&ref.taskId===target.taskId))throw new Error('此候选不属于当前会话；请返回所属会话打开审阅。');
        // Name lookup only reads the fixed target project; the id is rechecked before use.
        let status:any=null,nameError='';
        try{status=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);}
        catch(e:any){nameError=textError(e);}
        const data=validateTasks(await api('tasks?project='+encodeURIComponent(projectId),undefined,60000),projectId);
        if(status&&status.project?.id!==projectId)throw new Error('工程名称返回了其他工程，已停用显示。');
        const exact=data.tasks.find((t:any)=>t.taskId===target.taskId);
        if(!exact)throw new Error('该工程中未找到此任务，未回退到其他候选。');
        if(!stopped&&ticket===gate.current&&epoch===reviewEpoch.current&&!reviewInFlight.current.has(key)&&target.projectId===projectId){
          setTask({...exact,__reviewSessionId:sessionId});setSnapshot(status);setTaskList(data);if(status?.oipSync&&reviewStages(exact)?.retainedProjectId)setOipOpen(null);
          setError('');setMetadataWarning(nameError?'工程名称未能确认；以下任务已按工程 UUID 核对。':'');
        }
      }catch(e:any){if(!stopped&&ticket===gate.current&&epoch===reviewEpoch.current&&!reviewInFlight.current.has(key)){setTask(null);setSnapshot(null);setTaskList(null);setError(textError(e));}}
      finally{if(!stopped)timer=setTimeout(read,epoch===reviewEpoch.current?4000:0);}
    }
    read();return()=>{stopped=true;gate.current++;clearTimeout(timer);};
  },[sessionId,target?.projectId,target?.taskId,refresh]);
  useEffect(()=>{
    if(!oipLaunch?.launchId||task?.status!=='awaiting_review')return;
    let stopped=false,timer:any;const key=activeReviewKey.current;
    async function observe(){
      try{const value=await readOipResourceObservation(api,sessionId,oipLaunch);if(!stopped&&alive.current&&key===activeReviewKey.current){setOipOpen(value);if(value.state==='synced')setNotice('');}}
      catch{if(!stopped&&alive.current&&key===activeReviewKey.current)setOipOpen((previous:any)=>({...previous,state:previous?.state==='pending_confirmation'?'pending_confirmation':'unknown',message:'暂时无法核对 OIP 预览，请检查工具窗口。'}));}
      finally{if(!stopped)timer=setTimeout(observe,4000);}
    }
    timer=setTimeout(observe,1000);return()=>{stopped=true;clearTimeout(timer);};
  },[sessionId,oipLaunch?.launchId,task?.status]);
  function resourceReason(tool:string){return !openable?'当前结果尚不可打开。':pendingAction?'上次操作结果待核对。':tool!=='openplc'&&!onOpenResultResource?'此工具的打开接口尚未接通。':tool==='oip'&&(oipOpen||(reviewStages(task)?.retainedProjectId?snapshot?.oipSync:null))?.state==='pending_confirmation'?'请先在 OIP 确认打开工程。':'';}
  async function open(tool='openplc'){
    if(!task||!openable||busy||reviewInFlight.current.has(reviewPendingKey(sessionId,target)))return;
    if(resourceReason(tool))return;
    const key=reviewPendingKey(sessionId,target),ticket=gate.current,retained=!!reviewStages(task)?.retainedProjectId;
    reviewInFlight.current.add(key);setBusy(true);setNotice(retained?'修改工程已保存，正在打开…':'正在打开独立预览…');
    try{if(tool!=='openplc'){
      const result=await onOpenResultResource({conversationId:sessionId,...target,candidateDigest:task.candidate.candidateDigest,tool,target:retained?'retained':'candidate'});
      if(alive.current&&ticket===gate.current&&activeReviewKey.current===key){if(tool==='oip'){setOipLaunch(result.launchId?{...target,candidateDigest:task.candidate.candidateDigest,target:retained?'retained':'candidate',tool:'oip',launchId:result.launchId,observationRevision:result.observationRevision}:null);setOipOpen(result.toolSync?.oip||{state:result.state==='pending_confirmation'?'pending_confirmation':'unknown',message:result.message});}setNotice(result.message||'已请求打开对应修改结果。');}
      return;
    }
    const result=await openResultInEditor({api,conversationId:sessionId,task,isCurrent:()=>alive.current&&ticket===gate.current&&activeReviewKey.current===key,onState:(value:any)=>{setEditorReceipt(value);setNotice(editorOpenNotice(value,retained));}});
      if(alive.current&&ticket===gate.current&&result.state==='requested')setNotice((retained?'修改工程已保存。':'')+'OpenPLC 尚未确认加载，请核对编辑器后重试打开。');
    }catch(e:any){if(alive.current&&ticket===gate.current)setNotice((retained?'修改工程已保存。':'')+textError(e));}
    finally{reviewInFlight.current.delete(key);if(alive.current&&ticket===gate.current)setBusy(false);}
  }
  useEffect(()=>{
    if(!autoOpen.current||autoOpen.current!==activeReviewKey.current||busy||pendingAction||!reviewStages(task)?.retainedProjectId)return;
    const tool=canOpenPlc?'openplc':resourceTools.find((group:any)=>onOpenResultResource)?.tool;
    autoOpen.current='';if(tool)void open(tool);
  },[task?.status,task?.retention?.keptProjectId,busy,pendingAction,sessionId,target?.taskId]);
  async function reviewAction(action:string){
    if(busy||!target||pendingAction?.invalid)return;
    const key=reviewPendingKey(sessionId,target);if(reviewInFlight.current.has(key)||reviewMutationLocks.has(key))return;
    let stored:any;try{stored=readReviewPending(browserStorage(),sessionId,target);}catch(e:any){setPendingAction({invalid:true});setNotice(textError(e));return;}
    if(stored&&!pendingAction){setPendingAction(stored);setNotice('已有审阅请求待核对。');return;}
    const body=stored||pendingAction||reviewActionRequest(sessionId,task,target,action,crypto.randomUUID());
    if(!body)return;
    reviewInFlight.current.add(key);reviewMutationLocks.add(key);reviewEpoch.current++;
    try{browserStorage().setItem(key,JSON.stringify(body));setPendingAction(body);}catch{reviewInFlight.current.delete(key);reviewMutationLocks.delete(key);reviewEpoch.current++;setNotice('无法保存审阅请求编号，本次未发送。');return;}
    setBusy(true);setNotice('正在登记审阅操作…');
    try{
      const result=await api('conversations/review',body,30000);
      if(!result.ok||result.projectId!==body.projectId||result.taskId!==body.taskId||result.candidateDigest!==body.candidateDigest||result.task&&(result.task.projectId!==body.projectId||result.task.taskId!==body.taskId||result.task.candidate?.candidateDigest!==body.candidateDigest))throw new Error('审阅操作归属未确认。');
      const confirmed=reviewResultConfirmed(result.task,body),rejected=reviewRejection(result.task,body);
      if((confirmed||rejected)&&!clearReviewPending(browserStorage(),sessionId,target,body)){
        if(alive.current&&activeReviewKey.current===key)setPendingAction(readReviewPending(browserStorage(),sessionId,target));return;
      }
      if(alive.current&&activeReviewKey.current===key){
        if(confirmed&&body.action==='keep'){setOipOpen(null);setOipLaunch(null);if(canOpenPlc||onOpenResultResource&&resourceTools.length)autoOpen.current=key;}
        if(confirmed||rejected){setPendingAction(null);contexts?.get(sessionId)?.refresh();}setTask({...(result.task||task),__reviewSessionId:sessionId});
        setNotice(rejected?rejected.reason:!confirmed?'结果待核对；保留原请求编号，不会自动重发。':body.action==='keep'?'正在确认修改工程的保存结果…':'操作已登记，结果会自动更新。');
      }
    }catch(e:any){
      if(definitiveFailure(e)){clearReviewPending(browserStorage(),sessionId,target,body);if(alive.current&&activeReviewKey.current===key)setPendingAction(readReviewPending(browserStorage(),sessionId,target));}
      if(alive.current&&activeReviewKey.current===key)setNotice(definitiveFailure(e)?textError(e):'结果待核对；请使用原请求编号核对，不要重复创建操作。');
    }finally{taskReadsFor(contexts).invalidate(target.projectId,sessionId);reviewInFlight.current.delete(key);reviewMutationLocks.delete(key);reviewEpoch.current++;if(alive.current&&activeReviewKey.current===key)setBusy(false);broadcasting.current=true;notifyReviewChange(key);broadcasting.current=false;}
  }
  async function continueRetained(){
    if(!task||busy||pendingAction||continuing.current||!['kept','compiled','compile_failed'].includes(task.status))return;
    const kept=task.retention?.keptProjectId||task.retention?.projectId;if(!kept)return;
    if(task.retention?.completionScope==='saved-project-version'&&kept===task.projectId){contexts?.get(sessionId)?.refresh();await onContinueCurrent?.({sessionId,projectId:task.projectId,taskId:task.taskId});setNotice('可在当前对话继续修改。');return;}
    if(!onContinueRetained)return;
    const linked=canOpenPlc&&onOpenEditorSession;
    continuing.current=true;setBusy(true);setNotice(linked?'正在定位编辑器使用的同一会话…':'正在核对修改副本并创建关联会话…');const ticket=gate.current;
    try{
      let result;
      if(linked){const link=editorReceipt?.sessionId&&editorReceipt.targetProjectId===kept?editorReceipt:await prepareEditorSession(api,sessionId,task);if(!alive.current||ticket!==gate.current)return;setEditorReceipt(link);result=await onOpenEditorSession(link);}
      else result=await onContinueRetained({sourceSessionId:sessionId,sourceProjectId:task.projectId,taskId:task.taskId,candidateDigest:task.candidate?.candidateDigest,keptProjectId:kept,revision:task.retention.revision});
      if(alive.current&&ticket===gate.current)setNotice(result?.ok?(linked?'已定位编辑器会话。':'接续需求已带入副本的新会话，尚未发送。'):result?.message||'副本会话未能确认，请核对后再操作。');
    }catch(e:any){if(alive.current&&ticket===gate.current)setNotice(textError(e));}
    finally{continuing.current=false;if(alive.current&&ticket===gate.current)setBusy(false);}
  }
  async function checkReceipt(){
    const body=receiptRequest;if(!body||busy||reviewInFlight.current.has(reviewPendingKey(sessionId,target)))return;
    const ticket=gate.current;setBusy(true);setReceipt(null);setNotice('正在只读核对原保存回执…');
    try{const result=validateReviewReceipt(await api('conversations/review-receipt',body,30000),body);
      if(alive.current&&ticket===gate.current){setReceipt(result);setNotice('');}
    }catch(e:any){if(alive.current&&ticket===gate.current)setNotice(textError(e));}
    finally{if(alive.current&&ticket===gate.current)setBusy(false);}
  }
  const evidence=(value:any)=>typeof value==='string'?value:JSON.stringify(value,null,2);
  const diagnostic=task?.compilation?.diagnostic||task?.compilation?.reason||task?.compilation?.message;
  const identity=projectIdentity(snapshot,target?.projectId);
  const revision=revisionBasis(task?.projectRevision,taskList?.projectRevision);
  const stages=reviewStages(task);
  const generated=['joint-ai-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(task?.workflow);
  const artifacts=generated?visibleArtifacts(task):[];
  const changes=candidateChanges(task);
  const retainedProjectId=stages?.retainedProjectId||null;
  const savedToCurrent=task?.retention?.completionScope==='saved-project-version'&&retainedProjectId===task?.projectId;
  const reviewControl=(action:string,label:string)=>{const reason=reviewDisabledReason({sessionId,task,target,action,busy,pendingAction,revision,retainedProjectId});const reasonId='plcdev-review-'+action+'-'+task.taskId;return <div key={action} style={{display:'grid',gap:3,alignContent:'start'}}><button className={action==='keep'?'pc-primary':undefined} disabled={!!reason} aria-describedby={reason?reasonId:undefined} onClick={()=>reviewAction(action)}>{label}</button>{reason&&<small id={reasonId} className="pc-muted">{reason}</small>}</div>;};
  const stage=(kind:string,state:string)=><span key={kind} style={{padding:'3px 7px',borderRadius:6,border:'1px solid var(--pc-line,var(--dsw-alias-border-l2,#dfe5ec))',color:stageColor(stageTone(kind,state)),fontSize:12}}>{kind==='validation'?'校验':kind==='retention'?'保留':kind==='compilation'?'编译':'Runtime'}：{stageLabel(kind,state)}</span>;
  const close=onClose?()=>onClose(sessionId,info?.tab?.id):info?.tab?.actions?.close;
  return <section className={'pc-review'+(embedded?' pc-review-embedded':' plcdev-scope plcdev-rail')} aria-label="PLCdev 原生候选审阅" data-project-id={target?.projectId||''} onKeyDown={event=>{if(event.key==='Escape'&&close){event.stopPropagation();close();}}}><style>{css}</style>
    <div className="pc-review-surface">
    <div className="pc-row pc-review-toolbar"><h2><BrandTitle>{task?.workflow==='team-analysis-v1'?'团队分析':'审阅修改'}</BrandTitle></h2><span className="pc-spacer"/>{!embedded&&onOverview&&<button className="pc-quiet" onClick={()=>onOverview(sessionId,target?.projectId)}>工程总览</button>}<button className="pc-quiet" onClick={()=>setRefresh(n=>n+1)} disabled={busy}>刷新</button>{close&&<button className="pc-quiet" onClick={close} aria-label="关闭审阅">关闭</button>}</div>
    {embedded&&onSourceSession&&target&&<p><button className="pc-quiet" onClick={()=>onSourceSession({sessionId,...target})}>前往来源会话</button></p>}
    {target&&<div className="pc-row" style={{marginTop:6}}><strong data-project-name={identity?.name||''}>{projectLabel(identity)}</strong></div>}
    {metadataWarning&&<p role="status" className="pc-muted">{metadataWarning}</p>}
    {error?<p role="status" className="pc-error">{error}</p>:!task?<p>正在读取所属工程任务…</p>:<>
      <p style={{marginTop:8}}><strong className="pc-review-state">{task.status==='kept'?(retainedProjectId?(savedToCurrent?'已保留到当前工程':'已保留为独立工程'):'保留结果未确认'):taskStatus(task.status)}</strong></p><p className="pc-review-request">{task.request}</p>
      {task.supersededBy&&<p role="status">此版本已有后续修改，不能再次保留。后续任务：{task.supersededBy}</p>}
      <p className="pc-muted">{task.sourceBasis==='saved_revision'?'基于工程已保存版本 · 不含编辑器未保存修改':'输入范围以原始任务记录为准'}</p>
      {revision.same===false&&!retainedProjectId&&<p className="pc-error" role="status">{task.workflow==='team-analysis-v1'?'当前保存版本已变化；本报告对应原版本。':'当前保存版本已变化；旧候选不能保留或继续修改。'}</p>}
      {revision.same===null&&<p className="pc-muted">工程保存版本对照尚未确认，暂按任务记录的输入基线显示。</p>}
      {generated&&<>
        {task.workflow==='project-edit-v1'&&retainedProjectId&&!savedToCurrent&&<p className="pc-muted">这是一条旧版副本保存记录。</p>}
        {canOpenPlc&&task.workflow!=='project-edit-v1'&&task.status!=='no_change'&&<div className="pc-row" style={{margin:'14px 0'}}><button className="plcdev-link" onClick={()=>open()} disabled={busy||!!pendingAction||!openable}>{retainedProjectId?'在 OpenPLC 查看已保存修改':'在 OpenPLC 预览'}</button><span className="pc-muted">{retainedProjectId?'打开已保留的修改工程':'预览独立于原工程，不修改已封存候选'}</span></div>}
        {task.workflow==='project-edit-v1'&&task.candidate?.candidateDigest&&task.status!=='no_change'&&<ResultOperationCards task={task} conversationId={sessionId} onOpenTool={open} busy={busy} openReason={resourceReason} toolSync={{oip:retainedProjectId?oipResultState(task,oipOpen||snapshot?.oipSync):task.status==='awaiting_review'?oipPreviewState(oipLaunch,oipOpen):null}}/>}
        {task.workflow==='hmi-view-name-v1'&&<><p>范围：仅重命名所选 FUXA 画面；画面内容、PLC 和场景不变。</p>{task.status!=='no_change'&&artifactSummary(task.candidate?.summary)&&<div className="pc-change">画面名称：<code>{artifactSummary(task.candidate.summary)}</code></div>}</>}
        {task.workflow==='hmi-static-text-v1'&&<><p>范围：仅修改所选 FUXA 静态文字；动态值、按钮、绑定、PLC 和场景不变。</p>{task.status!=='no_change'&&artifactSummary(task.candidate?.summary)&&<div className="pc-change">静态文字：<code>{artifactSummary(task.candidate.summary)}</code></div>}</>}
        {task.workflow==='hmi-readonly-value-v1'&&<><p>范围：在 HMI 新增信号的只读数值显示。PLC 程序与写入操作保持不变。</p>{task.status!=='no_change'&&artifactSummary(task.candidate?.summary)&&<div className="pc-change">{artifactSummary(task.candidate.summary)}</div>}</>}
        <details><summary>文件版本核对</summary>{changes===null?<p className="pc-muted">任务未提供可核验的文件差异；字段级差异尚不可用。</p>:changes.length===0?<p>与源保存版本无文件差异。</p>:<ul className="pc-changed-files">{changes.map(row=><li key={row.path}><details><summary>{row.path}</summary><code>{row.beforeSha256?.slice(0,12)||'新增文件'} → {row.afterSha256?.slice(0,12)||'移除文件'}</code></details></li>)}</ul>}</details>
        {artifacts.length>0&&task.workflow!=='project-edit-v1'&&<details><summary>工具产物摘要</summary><div style={{display:'grid',gap:8}}>{artifacts.map(row=><article key={row.tool}><strong>{row.badge} · {row.name}</strong><p>{row.summary}</p>{row.widgets!==null&&<span className="pc-muted">{row.widgets} 个可编辑控件</span>}</article>)}</div></details>}
        <h3>分层状态</h3>
        <div className="pc-row">{stages&&<>{stage('validation',stages.validation)}{stage('retention',stages.retention)}{stage('compilation',stages.compilation)}{stage('runtime',stages.runtime)}</>}</div>
        {retainedProjectId&&<p>{savedToCurrent?'已保存到当前工程：':'已保存到：'}<strong>{(editorReceipt?.targetProjectId===retainedProjectId&&editorReceipt.projectName)||task.retention?.projectName||(savedToCurrent?projectLabel(identity):'修改工程副本')}</strong></p>}
        {retainedProjectId&&!savedToCurrent&&onRetainedProject&&<button onClick={()=>onRetainedProject(retainedProjectId,sessionId)}>查看修改副本</button>}
        {retainedProjectId&&(savedToCurrent||onContinueRetained)&&['kept','compiled','compile_failed'].includes(task.status)&&<div className="pc-row"><button className="pc-primary" disabled={busy||!!pendingAction} onClick={continueRetained}>{savedToCurrent?'继续修改':editorReceipt?.sessionId&&onOpenEditorSession?'前往编辑器会话':'基于修改副本继续修改'}</button></div>}
        {stages?.retention==='discarded'&&<p className="pc-muted">候选已撤销；本任务不再提供保留。</p>}
        {task.status==='no_change'&&<p role="status">最终内容与保存版本一致，没有需要保留的修改。</p>}
        {contexts&&task.candidate?.revisionSupported===true&&['joint-ai-v1','hmi-view-name-v1','hmi-static-text-v1','project-edit-v1'].includes(task.workflow)&&task.status==='awaiting_review'&&revision.same===true&&(embedded?<p className="pc-muted">继续修改请前往来源会话；关闭审阅会返回当前工程。</p>:<RevisionControls {...{contexts,sessionId,task}}/>)}
        {task.status!=='no_change'&&<div className="pc-row pc-review-actions">{!retainedProjectId&&reviewControl('keep','保留本轮修改')}{!retainedProjectId&&reviewControl('undo','撤销本轮')}{reviewControl('compile','编译保留版本')}</div>}
        {pendingAction&&<p className="pc-error">审阅请求待核对 {pendingAction.clientRequestId||''} <button disabled={busy||pendingAction.invalid} onClick={()=>reviewAction(pendingAction.action)}>以原请求编号核对</button></p>}
        {receiptRequest&&<div className="pc-error"><button disabled={busy} onClick={checkReceipt}>只读核对原保存回执</button>
          {receipt?.state==='unknown'&&<p role="status">保存结果仍未知；不会自动重试。</p>}
          {receipt?.state==='confirmed_unregistered'&&<p role="status">已核对保存文件，但工程清单尚未确认登记：<code>{receipt.manifestPath}</code>。请保留现场核对；未自动登记。</p>}
          {receipt?.state==='confirmed_registered'&&<p role="status">已核对保存文件与工程清单：<code>{receipt.keptProjectId}</code> · 版本 <code>{receipt.revision.slice(0,12)}</code>。{onRetainedProject&&<button onClick={()=>onRetainedProject(receipt.keptProjectId,sessionId)}>查看已保存工程</button>}</p>}
        </div>}
        {task.status!=='no_change'&&<p className="pc-muted">撤销仅适用于尚未保留的修改。编译不会启动运行。</p>}
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
      {!generated&&artifactSummary(task.candidate?.summary)&&<div className="pc-change"><code>{artifactSummary(task.candidate.summary)}</code></div>}
      {task.status!=='no_change'&&<p className="pc-muted">{task.reason||task.message||'任务状态由原 TaskService 提供。'}</p>}
      {!generated&&canOpenPlc&&<button style={{marginTop:12}} onClick={open} disabled={busy||!!pendingAction||!openable}>{retainedProjectId?'在 OpenPLC 查看已保存修改':'在 OpenPLC 预览'}</button>}
      {!['joint-ai-v1','team-analysis-v1','team-generation-v1','hmi-view-name-v1','hmi-static-text-v1','hmi-readonly-value-v1','project-edit-v1'].includes(task.workflow)&&<p className="pc-muted">此任务为既有规则候选；真实 AI 联合能力以任务记录为准。</p>}
      <details style={{marginTop:18}}><summary>技术详情</summary>      {task.parentTaskId&&<p className="pc-muted">继续修改自任务：{task.parentTaskId}</p>}        {['hmi-view-name-v1','hmi-static-text-v1'].includes(task.workflow)&&<p className="pc-muted">画面 ID：<code>{task.candidate?.target?.viewId||'未提供'}</code>{task.workflow==='hmi-static-text-v1'&&<> · 文字元素 ID：<code>{task.candidate?.target?.elementId||'未提供'}</code></>}</p>}<dl><dt>所属工程</dt><dd>{projectLabel(identity)}</dd><dt>工程 UUID</dt><dd>{task.projectId}</dd><dt>任务编号</dt><dd>{task.taskId}</dd><dt>输入基线版本</dt><dd>{task.projectRevision||task.candidate?.baselineRevision||'未提供'}</dd><dt>当前保存版本</dt><dd>{taskList?.projectRevision||'未读取'}</dd><dt>保留工程 UUID</dt><dd>{retainedProjectId||'未保留'}</dd><dt>候选摘要</dt><dd>{task.candidate?.candidateDigest||'尚未产生'}</dd></dl><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{evidence({components:task.candidate?.components,changes:task.candidate?.changes,validation:task.candidate?.validation,modelEvidence:task.candidate?.modelEvidence,retention:task.retention,compilation:task.compilation})}</pre></details>
    </>}{notice&&<p role="status" className="pc-error">{notice}</p>}
    </div>
  </section>;
}
