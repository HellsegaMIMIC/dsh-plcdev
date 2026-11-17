import React,{useEffect,useRef,useState} from 'react';
import {conversationApi,readReviewPending,reviewPendingKey} from './conversation-client.mjs';
import {taskReadsFor} from './task-reads.mjs';
import {projectResourceState} from './project-resource-state.mjs';
import {REVIEW_CHANGED,reviewMutationLocks} from './review-mutation.mjs';
import {openResultInEditor,editorOpenNotice} from './result-flow.mjs';
import {ToolLogo} from './ToolLogo';

const css=`
.pc-project .pc-resource-section{padding-top:12px}.pc-project .pc-resource-section h4{font-size:12px;font-weight:500;color:var(--pc-sub);margin:0}.pc-project .pc-resource-section+.pc-resource-section{border-top:1px solid var(--pc-line)}.pc-project .pc-resource-row .pc-resource-identity{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.pc-project .pc-resource-row .pc-resource-tag{font-size:11px;line-height:1.5;padding:2px 6px;border-radius:5px;background:var(--pc-canvas);color:var(--pc-sub)}.pc-project .pc-resource-row .pc-resource-task{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pc-project .pc-resource-state-message{font-size:12px;color:var(--pc-sub);padding:8px 0;margin:0}
`;
const canonicalTool=(tool:string)=>tool==='plc'?'openplc':tool;
function reviewBlock(sessionId:string,task:any){
  const key=reviewPendingKey(sessionId,task);
  if(reviewMutationLocks.has(key))return '正在处理这轮修改，请稍候。';
  try{if(readReviewPending(window.localStorage,sessionId,task))return '这轮操作结果待核对，请回对话核对。';}
  catch{return '修改状态暂时无法核对。';}
  return '';
}

/** The saved graph and this conversation's candidates are different versions.
 * Display them together, but keep their launch identities and permissions apart.
 */
export function ProjectResourceList({sessionId,projectId,contexts,binding,controller,state,onOpenSaved,onOpenResultResource,savedBusy=false,embedded=false}:any){
  const reads=taskReadsFor(contexts),sameProject=binding.binding?.projectId===projectId;
  const refs=(binding.binding?.taskRefs||[]).filter((ref:any)=>ref.projectId===projectId);
  const key=JSON.stringify([sessionId,projectId,sameProject,binding.binding?.version,refs.map((ref:any)=>ref.taskId)]);
  const [loaded,setLoaded]=useState<any>(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const alive=useRef(true),opening=useRef(false),active=useRef(key),latest=useRef<any>(null),previousTasks=useRef(''),saved=useRef<any>(null),actionEpoch=useRef(0),readEpoch=useRef(0);
  if(active.current!==key){active.current=key;actionEpoch.current++;readEpoch.current++;}
  latest.current={binding,state};
  if(state.snapshot?.project?.id===projectId)saved.current=state.snapshot;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;actionEpoch.current++;readEpoch.current++;};},[]);
  useEffect(()=>{setNotice('');},[key]);
  useEffect(()=>{
    let stopped=false,timer:any;
    if(!sameProject||!refs.length){setLoaded({key,listing:null,error:''});return;}
    async function read(){
      const ticket=++readEpoch.current;
      try{
        const listing=await reads.readTasks(projectId);
        if(stopped||ticket!==readEpoch.current)return;
        const stamp=JSON.stringify(listing.tasks.map((task:any)=>[task.taskId,task.status,task.supersededBy,task.retention?.revision]));
        if(previousTasks.current&&previousTasks.current!==stamp){actionEpoch.current++;setNotice('');controller.refresh({invalidate:true});}
        previousTasks.current=stamp;
        setLoaded({key,listing,error:''});
      }catch(error:any){if(!stopped&&ticket===readEpoch.current)setLoaded((old:any)=>({key,listing:old?.key===key?old.listing:null,error:error?.message||'待保留资源暂时无法读取。'}));}
      finally{if(!stopped)timer=setTimeout(read,4000);}
    }
    read();return()=>{stopped=true;clearTimeout(timer);readEpoch.current++;};
  },[key,refresh,reads,controller]);
  function refreshAll(invalidate=false){
    actionEpoch.current++;readEpoch.current++;setNotice('');
    reads.invalidate(projectId,sessionId);setRefresh(value=>value+1);
    binding.controller.refresh({preserveActionError:true});controller.refresh({invalidate});
  }
  useEffect(()=>{
    const changed=(event:any)=>{
      const keys=refs.map((ref:any)=>reviewPendingKey(sessionId,ref));
      if(!keys.includes(event.detail?.key||event.key))return;
      refreshAll(true);
    };
    window.addEventListener(REVIEW_CHANGED,changed);window.addEventListener('storage',changed);
    return()=>{window.removeEventListener(REVIEW_CHANGED,changed);window.removeEventListener('storage',changed);};
  },[key,reads,controller]);
  const current=loaded?.key===key?loaded:null;
  const resources=projectResourceState({projectId,sessionId,snapshot:state.snapshot||saved.current,binding:binding.binding,tasks:current?.listing});
  const pendingTasks=new Set(resources.pending.map((row:any)=>row.task.taskId));
  const pendingError=current?.error||resources.error||'';
  const pendingLoading=sameProject&&refs.length>0&&!current;
  const sharedBusy=state.busy||savedBusy||busy||!!state.pending;
  function openReason(row:any){return sharedBusy?'正在处理，请稍候。':pendingError||binding.bindingReadError||row.disabledReason||reviewBlock(sessionId,row.task);}
  async function openCandidate(row:any){
    if(opening.current||openReason(row))return;
    opening.current=true;setBusy(true);setNotice('正在打开待保留版本…');const start=key,actionTicket=actionEpoch.current,readTicket=++readEpoch.current;
    const safe=()=>alive.current&&active.current===start&&actionTicket===actionEpoch.current;
    try{
      // A stale display row cannot authorize a launch. Re-read ownership and
      // candidate state; never fall back to opening the saved project.
      reads.invalidate(projectId,sessionId);
      const [listing,owned]=await Promise.all([reads.readTasks(projectId),reads.readBinding(sessionId)]);
      if(!safe())return;
      if(readTicket===readEpoch.current)setLoaded({key:start,listing,error:''});
      const fresh=projectResourceState({projectId,sessionId,snapshot:latest.current.state.snapshot||saved.current,binding:owned,tasks:listing});
      const found=fresh.pending.find((item:any)=>item.tool===row.tool&&item.task.taskId===row.task.taskId&&item.task.candidate.candidateDigest===row.task.candidate.candidateDigest);
      if(fresh.error||!found||found.disabledReason||reviewBlock(sessionId,row.task))throw new Error(fresh.error||found?.disabledReason||reviewBlock(sessionId,row.task)||'这轮修改状态已变化，请查看最新资源。');
      if(row.tool==='openplc'){
        await openResultInEditor({api:conversationApi,conversationId:sessionId,task:found.task,target:'candidate',isCurrent:safe,onState:(value:any)=>{if(safe())setNotice(editorOpenNotice(value));}});
      }else{
        if(!onOpenResultResource)throw new Error('此工具的查看入口暂不可用。');
        const request={conversationId:sessionId,projectId,taskId:found.task.taskId,candidateDigest:found.task.candidate.candidateDigest,tool:row.tool,target:'candidate'};
        const result=await onOpenResultResource(request);
        if(safe())setNotice(result?.state==='pending_confirmation'?'请在 OIP 确认打开场景。':result?.message||'已请求打开待保留版本。');
      }
    }catch(error:any){if(safe())setNotice(error?.message||'待保留版本暂时无法打开。');}
    finally{opening.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="pc-project-resources" aria-label="工程资源状态"><style>{css}</style>
    <div className="pc-resource-heading" style={embedded?{justifyContent:'flex-end',padding:'6px 0'}:undefined}>{!embedded&&<h3>工程资源</h3>}<button className="pc-project-quiet" disabled={sharedBusy} onClick={()=>refreshAll()}>刷新资源</button></div>
    {(resources.pending.length>0||pendingLoading||pendingError)&&<div className="pc-resource-section" data-pending>
      <h4>本会话待保留</h4>
      {pendingLoading&&<p className="pc-resource-state-message" role="status">正在读取本轮修改…</p>}
      {resources.pending.map((row:any)=><div key={row.key} className="pc-resource-row" data-resource-state="pending" data-resource-tool={row.tool} data-resource-task={row.task.taskId}>
        <div><div className="pc-resource-identity"><ToolLogo tool={row.tool}/><strong>{row.role}</strong><span className="pc-resource-tag">{row.label}</span></div><span>{row.name}</span>{pendingTasks.size>1&&<span className="pc-resource-task" title={row.taskLabel}>{row.taskLabel}</span>}{row.disabledReason&&<span>{row.disabledReason}</span>}</div>
        <button className="plcdev-link" disabled={!!openReason(row)} title={openReason(row)||undefined} aria-label={'在 '+row.name+' 查看待保留'} onClick={()=>openCandidate(row)}>查看待保留</button>
      </div>)}
      {pendingError&&<p className="pc-resource-state-message" role="status">{pendingError}</p>}
    </div>}
    <div className="pc-resource-section"><h4>已保存的工程资源</h4>
      {resources.saved.map((row:any)=><div key={row.id} className="pc-resource-row" data-resource-state="saved" data-resource-tool={canonicalTool(row.tool)}><div><div className="pc-resource-identity"><ToolLogo tool={row.tool}/><strong>{row.role}</strong></div><span>{row.title}</span></div><button className="plcdev-link" disabled={sharedBusy||!state.snapshot||state.snapshot.capabilities?.tools?.[row.tool]!==true} aria-label={'在 '+row.title+' 查看已保存'} onClick={()=>onOpenSaved(row)}>查看已保存</button></div>)}
      {(!state.snapshot||!resources.saved.length)&&<p className="pc-resource-state-message" role="status">{state.error?'工程资源暂时无法读取。':!state.snapshot?'正在读取工程资源…':'暂无已保存的工具资源。'}</p>}
    </div>
    {notice&&<p className="pc-resource-state-message" role="status">{notice}</p>}
  </section>;
}
