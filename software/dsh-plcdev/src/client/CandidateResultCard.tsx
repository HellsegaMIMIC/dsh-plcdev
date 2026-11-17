import {BrandTitle} from './Brand';
import React,{useEffect,useRef,useState} from 'react';
import {definitiveFailure} from './model.mjs';
import {conversationApi as api,reviewTarget,reviewStages,revisionBasis,reviewActionRequest,reviewPendingKey,readReviewPending} from './conversation-client.mjs';
import {reviewDisabledReason,revisionDisabledReason} from './review-ui-state.mjs';
import {bindingBlockedReason} from './conversation-context.mjs';
import {resultStatus,candidateOperationGroups} from './candidate-operations.mjs';
import {openResultInEditor,editorOpenNotice,prepareEditorSession,readEditorObservation} from './result-flow.mjs';
import {ResultOperationCards} from './ResultOperationCards';
import {reviewMutationLocks,notifyReviewChange,REVIEW_CHANGED,reviewResultConfirmed,reviewRejection,clearReviewPending,settleReviewPending} from './review-mutation.mjs';
import {taskReadsFor} from './task-reads.mjs';
import {oipResultState,oipPreviewState,readOipResourceObservation} from './oip-result-state.mjs';

const message=(error:any)=>error?.message||'操作尚未确认，请核对后再试。';
const cardCss=`
.pc-result-card{--pc-surface:var(--dsw-alias-bg-base,#fff);--pc-canvas:var(--dsw-alias-bg-module-platform,#f5f6f8);--pc-line:var(--dsw-alias-border-l2,#e2e6ed);--pc-sub:var(--dsw-alias-label-secondary,#667085);--pc-accent:var(--plcdev-accent);color:var(--dsw-alias-label-primary,#202939);font:13px/1.6 var(--dsw-font-family,system-ui,sans-serif);margin:10px 0;padding:12px 14px;border:1px solid var(--pc-line);border-radius:12px;background:var(--pc-surface);min-width:0}.pc-result-card *{box-sizing:border-box}.pc-result-card button{font:inherit;font-size:12px;line-height:1.4;padding:7px 10px;border:1px solid var(--pc-line);border-radius:7px;background:var(--pc-surface);color:inherit;cursor:pointer}.pc-result-card button:disabled{opacity:.5;cursor:default}.pc-result-card button:focus-visible{outline:2px solid var(--pc-accent);outline-offset:3px}.pc-result-card button:hover:not(:disabled){background:var(--pc-canvas)}.pc-result-card .pc-primary{background:var(--pc-accent);border-color:var(--pc-accent);color:var(--plcdev-on-accent)}.pc-result-card .pc-primary:hover:not(:disabled){background:var(--pc-accent);filter:brightness(.96)}.pc-result-heading,.pc-result-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pc-result-heading{justify-content:space-between;gap:8px;color:var(--pc-sub);font-size:12px}.pc-result-heading h3{margin:0;color:var(--dsw-alias-label-primary,#202939);font-size:13px;font-weight:600;overflow-wrap:anywhere}.pc-result-project{margin:4px 0;overflow-wrap:anywhere}.pc-result-heading [data-result-status]{font-size:11px;padding:2px 7px;border-radius:5px;background:var(--pc-canvas)}.pc-result-actions{margin-top:12px;padding-top:10px;border-top:1px solid var(--pc-line)}.pc-result-actions .pc-result-details{margin-left:auto;border:0;background:transparent;color:var(--pc-sub)}.pc-result-card .pc-muted{font-size:12px;color:var(--pc-sub);margin:7px 0;overflow-wrap:anywhere}.pc-result-card .pc-result-warning{font-size:12px;border-left:2px solid var(--dsw-alias-state-warn-primary,#b7791f);padding:4px 10px;margin:8px 0;overflow-wrap:anywhere}.pc-result-card [hidden]{display:none!important}.pc-result-card code{font-family:var(--ds-font-family-code,monospace)}
`;

export function CandidateResultCard({block,sessionId,onReviewTask,onContinueRetained,onContinueCurrent,onOpenEditorSession,onOpenResultResource,contexts,hideRecordsLink=false,embedded=false}:any){
  let receipt:any=null;try{receipt=JSON.parse((block?.content||[]).filter((item:any)=>item?.type==='text').map((item:any)=>item.text).join('\n'));}catch{}
  const recorded=receipt?.task,target=reviewTarget(recorded),key=reviewPendingKey(sessionId,target);
  const reads=taskReadsFor(contexts);
  const [live,setLive]=useState<any>(null),[refresh,setRefresh]=useState(0),[pending,setPending]=useState<any>(null),[notice,setNoticeValue]=useState(''),[busy,setBusy]=useState(false),[binding,setBinding]=useState<any>(null),[editor,setEditor]=useState<any>(null);
  const [oipSync,setOipSync]=useState<any>(null);
  const [oipLaunch,setOipLaunch]=useState<any>(null);
  const alive=useRef(true),epoch=useRef(0),inFlight=useRef(false),autoOpen=useRef<string|null>(null);
  const progressNotice=useRef<any>(null),taskReadSequence=useRef(0);
  // Only an explicitly tagged progress-query error may be cleared by later
  // evidence. Any other operation notice replaces and invalidates that tag.
  const setNotice=(value:string)=>{progressNotice.current=null;setNoticeValue(value);};
  const active=useRef(key);active.current=key;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
  useEffect(()=>{epoch.current++;setLive(null);setNotice('');setEditor(null);setOipSync(null);setOipLaunch(null);autoOpen.current=null;},[key]);
  useEffect(()=>{if(!contexts||!sessionId)return;const controller=contexts.get(sessionId);setBinding(controller.snapshot());return controller.subscribe(()=>setBinding(controller.snapshot()));},[contexts,sessionId]);
  useEffect(()=>{
    const read=()=>{try{setPending(readReviewPending(window.localStorage,sessionId,target));}catch(error){setPending({invalid:true});setNotice(message(error));}};
    read();const changed=(event:any)=>{if(event.detail?.key===key){read();setRefresh(value=>value+1);}};
    const storage=(event:StorageEvent)=>{if(event.key===key){read();setRefresh(value=>value+1);}};
    window.addEventListener(REVIEW_CHANGED,changed);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(REVIEW_CHANGED,changed);window.removeEventListener('storage',storage);};
  },[key]);
  useEffect(()=>{
    let stopped=false,timer:any;
    if(!target||!sessionId)return;
    async function read(){
      const ticket=epoch.current,sequence=++taskReadSequence.current;
      try{
        const [listing,owned]=await Promise.all([reads.readTasks(target.projectId),reads.readBinding(sessionId)]);
        if(!owned.taskRefs.some((ref:any)=>ref.projectId===target.projectId&&ref.taskId===target.taskId))throw new Error('此修改不属于当前会话，请从来源会话查看。');
        const task=listing.tasks.find((item:any)=>item.taskId===target.taskId);
        if(!task)throw new Error('未找到这次修改，请重新核对。');
        if(!stopped&&ticket===epoch.current&&!inFlight.current){
          setLive({key,task,revision:listing.projectRevision,binding:owned});
          const stale=progressNotice.current,nowBinding=contexts?.get(sessionId)?.snapshot()?.binding;
          if(stale&&stale.key===key&&stale.epoch===ticket&&sequence>stale.afterRead&&
              (!contexts||nowBinding?.conversationId===sessionId&&nowBinding?.projectId===target.projectId&&nowBinding?.version===stale.bindingVersion)&&
              owned.conversationId===sessionId&&owned.projectId===target.projectId&&owned.version===stale.bindingVersion&&
              task.projectId===target.projectId&&task.taskId===target.taskId&&task.candidate?.candidateDigest===stale.digest&&
              listing.projectRevision===stale.revision&&(task.retention?.revision??null)===stale.retainedRevision&&task.status===stale.status){
            let unresolved=true;try{unresolved=!!readReviewPending(window.localStorage,sessionId,target);}catch{}
            if(!unresolved){progressNotice.current=null;setNoticeValue(previous=>previous===stale.message?'':previous);}
          }
        }
      }catch(error){if(!stopped&&ticket===epoch.current&&!inFlight.current)setLive({key,error:message(error)});}
      finally{if(!stopped)timer=setTimeout(read,4000);}
    }
    read();return()=>{stopped=true;clearTimeout(timer);};
  },[key,refresh,reads]);
  const current=live?.key===key?live:null,task=current?.task||recorded;
  const retained=reviewStages(current?.task)?.retainedProjectId;
  const sameProject=task?.retention?.completionScope==='saved-project-version'&&retained===target?.projectId;
  const revision=revisionBasis(task?.projectRevision,current?.revision);
  const tools=candidateOperationGroups(task).filter((group:any)=>group.tool!=='project');
  const hasOip=tools.some((group:any)=>group.tool==='oip');
  const settled=!!current?.task&&!current.error;
  const safe=()=>alive.current&&active.current===key;
  useEffect(()=>{
    if(!retained||!hasOip)return;let stopped=false,timer:any;
    async function observe(){
      const ticket=epoch.current;
      try{const snapshot=await reads.readSnapshot(retained);if(!stopped&&safe()&&ticket===epoch.current&&!inFlight.current)setOipSync(snapshot.oipSync||{state:'unknown'});}
      catch{if(!stopped&&safe()&&ticket===epoch.current&&!inFlight.current)setOipSync({state:'unknown',message:'暂时无法核对 OIP 的显示版本。'});}
      finally{if(!stopped)timer=setTimeout(observe,4000);}
    }
    observe();return()=>{stopped=true;clearTimeout(timer);};
  },[key,retained,hasOip,task?.retention?.revision,refresh,reads]);
  useEffect(()=>{
    if(retained||!oipLaunch?.launchId||task?.status!=='awaiting_review')return;
    let stopped=false,timer:any;
    async function observe(){
      const ticket=epoch.current;
      try{const value=await readOipResourceObservation(api,sessionId,oipLaunch);if(!stopped&&safe()&&ticket===epoch.current){setOipSync(value);if(value.state==='synced')setNotice('');}}
      catch{if(!stopped&&safe()&&ticket===epoch.current)setOipSync((previous:any)=>({...previous,state:previous?.state==='pending_confirmation'?'pending_confirmation':'unknown',message:'暂时无法核对 OIP 预览，请检查工具窗口。'}));}
      finally{if(!stopped)timer=setTimeout(observe,4000);}
    }
    timer=setTimeout(observe,1000);return()=>{stopped=true;clearTimeout(timer);};
  },[key,retained,oipLaunch?.launchId,task?.status]);
  useEffect(()=>{
    if(!settled||inFlight.current||reviewMutationLocks.has(key))return;
    try{const result=settleReviewPending(window.localStorage,sessionId,target,current.task);
      if(result){
        setPending(null);
        if(result.rejected)setNotice(result.rejected.reason);
        else if(result.request.action==='keep'){setOipSync(null);setOipLaunch(null);autoOpen.current=tools.find((group:any)=>group.tool==='openplc'||onOpenResultResource)?.tool||null;setNotice('修改已保留，正在核对工程状态。');}
        else setNotice(result.request.action==='undo'?'本轮候选已撤销。':current.task.status==='compiled'?'编译验证通过。':'编译验证失败，请查看诊断。');
        reads.invalidate(target.projectId,sessionId);contexts?.get(sessionId)?.refresh();notifyReviewChange(key);
      }
    }catch(error){setNotice(message(error));}
  },[key,current?.task,pending,busy]);
  const sessionReason=settled?bindingBlockedReason(binding||{binding:current.binding}):'';
  function reason(action:string){return !settled?'修改状态尚未确认。':sessionReason||(action==='compile'&&sameProject&&current.task.retention.revision!==current.revision?'工程已保存新版本，请验证当前版本。':'')||reviewDisabledReason({sessionId,task:current.task,target,action,busy,pendingAction:pending,revision,retainedProjectId:retained});}
  function openReason(tool:string){
    if(!settled)return '修改状态尚未确认。';
    if(pending)return '上次操作结果待核对。';
    if(!['awaiting_review','kept','compiled','compile_failed'].includes(current.task.status))return ['discarded','superseded'].includes(current.task.status)||current.task.supersededBy?'这是历史结果，可查看改动记录。':'当前结果尚不可打开。';
    if(tool!=='openplc'&&!onOpenResultResource)return '此工具的修改结果打开接口尚未接通。';
    if(tool==='oip'&&oipSync?.state==='pending_confirmation')return '请先在 OIP 确认打开工程。';
    return '';
  }
  async function openTool(tool:string){
    if(inFlight.current||openReason(tool))return;
    inFlight.current=true;setBusy(true);setEditor(null);setNotice('正在打开修改结果…');const ticket=++epoch.current;
    try{
      if(tool==='openplc'){
        await openResultInEditor({api,conversationId:sessionId,task:current.task,isCurrent:()=>safe()&&ticket===epoch.current,onState:(value:any)=>{setEditor(value);setNotice('');}});
      }else{
        const result=await onOpenResultResource({conversationId:sessionId,...target,candidateDigest:current.task.candidate.candidateDigest,tool,target:retained?'retained':'candidate'});
        if(safe()&&ticket===epoch.current){
          const sync=result?.toolSync?.oip;
          if(tool==='oip'){reads.invalidate(retained||target.projectId);setOipLaunch(result?.launchId?{...target,candidateDigest:current.task.candidate.candidateDigest,target:retained?'retained':'candidate',tool:'oip',launchId:result.launchId,observationRevision:result.observationRevision}:null);setOipSync(sync||{state:result?.state==='pending_confirmation'?'pending_confirmation':'unknown',message:result?.message});}
          setNotice(tool==='oip'?(sync?.state==='pending_confirmation'||result?.state==='pending_confirmation'?'请在 OIP 确认打开工程。':result?.message||'已请求打开场景，正在核对显示版本。'):result?.message||'已请求打开对应修改结果。');
        }
      }
    }catch(error:any){if(safe()&&ticket===epoch.current){
      setNotice(message(error));
      if(error?.code==='tasks_unavailable'&&current?.task?.candidate?.candidateDigest&&current?.revision&&
          current.binding?.conversationId===sessionId&&current.binding?.projectId===target.projectId){
        progressNotice.current={key,epoch:ticket,afterRead:taskReadSequence.current,message:message(error),
          digest:current.task.candidate.candidateDigest,revision:sameProject?current.task.retention.revision:current.revision,retainedRevision:current.task.retention?.revision??null,
          status:current.task.status,bindingVersion:current.binding.version};
        // A later component read must not reuse a shared request that started
        // before the failure. Only a fresh task/binding query can recover it.
        reads.invalidate(target.projectId,sessionId);
      }
    }}
    finally{inFlight.current=false;if(safe()){setBusy(false);setRefresh(value=>value+1);}}
  }
  useEffect(()=>{if(!autoOpen.current||busy||pending||!retained)return;const tool=autoOpen.current;autoOpen.current=null;void openTool(tool);},[retained,current?.task?.status,busy,pending]);
  useEffect(()=>{
    if(!editor?.launchId)return;let stopped=false,timer:any;const receipt=editor;
    async function observe(){
      try{const value=await readEditorObservation(api,sessionId,receipt);if(!stopped&&safe())setEditor(value);}
      catch{if(!stopped&&safe())setEditor((value:any)=>value?.launchId===receipt.launchId?{...value,observation:{state:'unknown'}}:value);}
      finally{if(!stopped)timer=setTimeout(observe,4000);}
    }
    timer=setTimeout(observe,4000);return()=>{stopped=true;clearTimeout(timer);};
  },[key,editor?.launchId]);
  async function review(action:string,reconcile=false){
    if(!target||!key||inFlight.current||reviewMutationLocks.has(key)||pending?.invalid)return;
    let saved:any;try{saved=readReviewPending(window.localStorage,sessionId,target);}catch(error){setPending({invalid:true});setNotice(message(error));return;}
    if(saved&&!reconcile){setPending(saved);setNotice('已有审阅请求待核对。');return;}
    if(!saved&&reason(action))return;
    const body=saved||reviewActionRequest(sessionId,current.task,target,action,crypto.randomUUID());
    if(!body)return;
    inFlight.current=true;reviewMutationLocks.add(key);epoch.current++;
    try{window.localStorage.setItem(key,JSON.stringify(body));setPending(body);}catch{inFlight.current=false;reviewMutationLocks.delete(key);setNotice('无法保存操作编号，本次未发送。');return;}
    reads.invalidate(target.projectId,sessionId);setBusy(true);setNotice('正在处理…');notifyReviewChange(key);
    try{
      const result=await api('conversations/review',body,30000);
      if(!result.ok||result.projectId!==body.projectId||result.taskId!==body.taskId||result.candidateDigest!==body.candidateDigest||result.task&&(result.task.projectId!==body.projectId||result.task.taskId!==body.taskId||result.task.candidate?.candidateDigest!==body.candidateDigest))throw new Error('操作归属尚未确认。');
      const confirmed=reviewResultConfirmed(result.task,body),rejected=reviewRejection(result.task,body);
      if((confirmed||rejected)&&!clearReviewPending(window.localStorage,sessionId,target,body)){
        if(safe())setPending(readReviewPending(window.localStorage,sessionId,target));return;
      }
      if(safe()){
        if(confirmed||rejected)setPending(null);if(result.task)setLive(previous=>({...previous,key,task:result.task}));
        if(rejected)setNotice(rejected.reason);
        else if(!confirmed)setNotice('结果待核对；保留原请求编号，不会自动重发。');
        else if(body.action==='keep'){setOipSync(null);setOipLaunch(null);autoOpen.current=tools.find((group:any)=>group.tool==='openplc'||onOpenResultResource)?.tool||null;setNotice('修改已保留，正在核对工程状态。');}
        else if(body.action==='undo')setNotice('本轮候选已撤销。');
        else setNotice(result.task?.status==='compiled'?'编译验证通过。':result.task?.status==='compile_failed'?'编译验证失败，请查看诊断。':'编译结果已返回，请核对状态。');
        contexts?.get(sessionId)?.refresh();
      }
    }catch(error){
      if(definitiveFailure(error)){clearReviewPending(window.localStorage,sessionId,target,body);if(safe())setPending(readReviewPending(window.localStorage,sessionId,target));}
      if(safe())setNotice(definitiveFailure(error)?message(error):'结果待核对；保留原请求编号，不会自动重发。');
    }finally{reads.invalidate(target.projectId,sessionId);reviewMutationLocks.delete(key);inFlight.current=false;if(safe()){setBusy(false);setRefresh(value=>value+1);}notifyReviewChange(key);}
  }
  async function continueEditing(){
    if(!settled||busy||pending)return;
    if(current.task.status==='awaiting_review'){
      if(!contexts)return;
      const controller=contexts.get(sessionId),disabled=revisionDisabledReason(controller.snapshot(),current.task);
      if(disabled){setNotice(disabled);return;}
      await controller.revise(current.task);
      const next=controller.snapshot(),parent=next.binding?.revisionContext?.parent;
      if(parent?.taskId===target.taskId&&parent?.candidateDigest===current.task.candidate?.candidateDigest)await onContinueCurrent?.({sessionId,...target});
      else if(next.error)setNotice(next.error);
      return;
    }
    if(!retained)return;
    inFlight.current=true;setBusy(true);
    try{
      if(sameProject){contexts?.get(sessionId)?.refresh();await onContinueCurrent?.({sessionId,...target});setNotice('可在当前对话继续描述修改。');}
      else if(onOpenEditorSession&&tools.some((group:any)=>group.tool==='openplc')){const link=editor?.sessionId&&editor.targetProjectId===retained?editor:await prepareEditorSession(api,sessionId,current.task);if(!safe())return;setEditor(link);await onOpenEditorSession(link);}
      else if(onContinueRetained)await onContinueRetained({sourceSessionId:sessionId,sourceProjectId:target.projectId,taskId:target.taskId,candidateDigest:current.task.candidate.candidateDigest,keptProjectId:retained,revision:current.task.retention.revision});
    }catch(error){if(safe())setNotice(message(error));}finally{inFlight.current=false;if(safe())setBusy(false);}
  }
  if(!target)return null;
  const actionable=current?.task?.status==='awaiting_review'&&!current.task.supersededBy;
  const stages=reviewStages(current?.task);
  const continueReason=actionable&&contexts&&binding?revisionDisabledReason(binding,current.task):'';
  const taskReason=['conflict','unknown_outcome','failed'].includes(current?.task?.status)&&typeof current.task.reason==='string'?current.task.reason:'';
  const editorNotice=!retained&&current?.task?.status==='discarded'?'候选已撤销；原 OpenPLC 预览不代表当前工程。':!retained&&(current?.task?.supersededBy||current?.task?.status==='superseded')?'此 OpenPLC 预览对应旧候选，请在最新结果卡查看。':editorOpenNotice(editor,!!retained);
  const warnings=[...new Set([current?.error,taskReason,settled&&!retained&&revision.same===false?'工程保存版本已变化，这份候选不能保留或继续修改。':'',pending?'上次操作结果待核对。':'',sessionReason,binding?.error].filter(Boolean))];
  return <section className={'pc-tool-card pc-result-card'+(embedded?'':' plcdev-scope plcdev-rail')} aria-label={embedded?'工程修改结果':'PLCdev 工程修改结果'} data-result-task={target.taskId}><style>{cardCss}</style>
    <div className="pc-result-heading"><h3>{embedded?(typeof receipt.projectName==='string'?receipt.projectName:'工程修改结果'):<BrandTitle compact>工程修改结果</BrandTitle>}</h3><span data-result-status>{settled?resultStatus(current.task):current?.error?'状态待核对':'正在核对状态'}</span></div>
    {!embedded&&typeof receipt.projectName==='string'&&<p className="pc-result-project">{receipt.projectName}</p>}
    <ResultOperationCards task={task} conversationId={sessionId} onOpenTool={openTool} busy={busy} openReason={openReason} toolSync={{oip:hasOip?(retained?oipResultState(task,oipSync):task.status==='awaiting_review'?oipPreviewState(oipLaunch,oipSync):null):null}}/>
    {retained&&!sameProject&&<p className="pc-muted">已保存到：{current.task.retention?.projectName||'修改工程副本'}</p>}
    <div className="pc-result-actions">
      {actionable&&<><button className="pc-primary" disabled={!!reason('keep')} title={reason('keep')||undefined} onClick={()=>review('keep')}>保留本轮修改</button><button disabled={!!reason('undo')} title={reason('undo')||undefined} onClick={()=>review('undo')}>撤销本轮</button>{contexts&&current.task.candidate?.revisionSupported===true&&<button disabled={busy||!!pending||!!continueReason||revision.same!==true} title={continueReason||undefined} onClick={continueEditing}>继续修改</button>}</>}
      {retained&&<button disabled={busy||!!pending} onClick={continueEditing}>继续修改</button>}
      {retained&&<button disabled={!!reason('compile')} title={reason('compile')||'仅编译保留版本的 PLC，不启动运行'} onClick={()=>review('compile')}>验证 PLC</button>}
      {!hideRecordsLink&&<button className="pc-result-details plcdev-link" onClick={()=>onReviewTask?.(target)}>查看调整记录</button>}
    </div>
    {warnings.map((warning,index)=><p className="pc-result-warning" role="status" key={index}>{warning}</p>)}
    {pending&&<button disabled={busy||pending.invalid} onClick={()=>review(pending.action,true)}>核对原操作</button>}
    {current?.task?.compilation&&<details><summary>PLC 编译详情</summary>{stages?.historicalCompilation?<p className="pc-muted">历史编译通过（旧版本回执），不代表本次操作成功。{current.task.compilation.revision&&<> 旧版本：<code>{current.task.compilation.revision}</code></>}</p>:<p className="pc-muted">{typeof current.task.compilation.diagnostic==='string'?current.task.compilation.diagnostic.slice(0,4000):stages?.compilation==='passed'?'编译通过；未执行运行验收。':'编译结果尚未提供可读诊断。'}</p>}</details>}
    {editor&&<p className="pc-muted" role="status">{editorNotice}</p>}
    {notice&&<p className="pc-muted" role="status">{notice}</p>}
  </section>;
}
