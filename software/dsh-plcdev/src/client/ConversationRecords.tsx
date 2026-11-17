import {BrandTitle,markRecordsTab} from './Brand';
import React,{useEffect,useRef,useState} from 'react';
import {useConversationContext} from './useConversationContext';
import {reviewTarget,reviewPendingKey} from './conversation-client.mjs';
import {resultStatus} from './candidate-operations.mjs';
import {CandidateResultCard} from './CandidateResultCard';
import {taskReadsFor} from './task-reads.mjs';
import {REVIEW_CHANGED} from './review-mutation.mjs';

const css=`.pc-records{height:100%;overflow:auto;min-height:0;color:var(--dsw-alias-label-primary,#202939);font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);background:var(--dsw-alias-bg-base,#fff)}.pc-records-inner{max-width:900px;padding:24px;margin:auto}.pc-records-heading{display:flex;align-items:center;gap:12px;margin-bottom:22px;flex-wrap:wrap}.pc-records-heading h2{font-size:17px;margin:0;flex:1}.pc-records button.pc-records-back{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e6ed);border-radius:8px;background:transparent;color:inherit;cursor:pointer}.pc-records button:focus-visible{outline:2px solid var(--plcdev-accent);outline-offset:3px}.pc-records-empty{padding:48px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#667085)}.pc-records-round{margin-bottom:20px;scroll-margin-top:20px;border-radius:12px}.pc-records-round[data-focused=true]{outline:2px solid var(--plcdev-accent);outline-offset:5px}.pc-records-caption{font-size:13px;margin:0 0 6px;overflow-wrap:anywhere}.pc-records-error{color:var(--dsw-alias-label-secondary,#667085);margin:8px 0}@media(max-width:560px){.pc-records-inner{padding:18px 12px}}`;
const recordKey=(task:any)=>task.projectId+':'+task.taskId;

export function ConversationRecords({sessionId,contexts,viewRequest,completeViewRequest,openView,...actions}:any){
  const state=useConversationContext(contexts,sessionId),[fetched,setFetched]=useState<any>(null),[version,setVersion]=useState(0),[retry,setRetry]=useState(0),[focusError,setFocusError]=useState(''),[focused,setFocused]=useState<string|null>(null),[expanded,setExpanded]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null),handledView=useRef<any>(null);
  useEffect(()=>markRecordsTab(root.current),[]);
  const refs=state.binding?.taskRefs||[], signature=JSON.stringify(refs.map((r:any)=>[r.projectId,r.taskId]));
  const key=sessionId+':'+signature,reads=taskReadsFor(contexts),ids=[...new Set(refs.map((r:any)=>r.projectId))] as string[];
  const current=fetched?.key===key?fetched:null;
  const rows=refs.slice().reverse().map(({projectId,taskId}:any)=>{
    const task=reads.peekRecords(projectId)?.tasks.find((task:any)=>task.taskId===taskId);
    return task||{projectId,taskId,pending:!current?.done[projectId],unavailable:true};
  });
  const errors=Object.values(current?.errors||{}) as string[],loading=ids.some(id=>!current?.done[id]);
  useEffect(()=>{handledView.current=null;setFocusError('');setFocused(null);setExpanded(null);},[key]);
  useEffect(()=>{
    const keys=new Set(refs.map((ref:any)=>reviewPendingKey(sessionId,ref)));
    const changed=(event:any)=>{
      if(!keys.has(event.detail?.key||event.key))return;
      // Other result cards or windows can settle a review while these rows are
      // folded. Refresh owned records without reopening or replaying an action.
      for(const id of ids)reads.invalidate(id,sessionId);
      setRetry(n=>n+1);
    };
    window.addEventListener(REVIEW_CHANGED,changed);window.addEventListener('storage',changed);
    return()=>{window.removeEventListener(REVIEW_CHANGED,changed);window.removeEventListener('storage',changed);};
  },[key,reads]);
  useEffect(()=>{
    let stopped=false;setFetched({key,done:{},errors:{}});
    const off=ids.map(id=>reads.subscribeRecords(id,()=>{if(!stopped)setVersion(n=>n+1);}));
    // Each project arrives independently: a slow or unavailable project cannot
    // hide already known records from the other projects in this conversation.
    for(const id of ids)reads.readRecords(id).then(()=>{
      if(!stopped)setFetched((old:any)=>old?.key===key?{...old,done:{...old.done,[id]:true}}:old);
    },(error:any)=>{
      if(!stopped)setFetched((old:any)=>old?.key===key?{...old,done:{...old.done,[id]:true},errors:{...old.errors,[id]:error.message||'调整记录暂时无法读取。'}}:old);
    });
    return()=>{stopped=true;off.forEach(fn=>fn());};
  },[key,state.backendDisconnected,reads,retry]);
  useEffect(()=>{
    const target=reviewTarget(viewRequest?.focus);if(!target||handledView.current===viewRequest)return;
    const row=rows.find(r=>r.taskId===target.taskId&&r.projectId===target.projectId);
    if(row?.pending)return;
    if(!row||row.unavailable){if(loading)return;handledView.current=viewRequest;setFocusError(!row?'这次修改不在当前会话的调整记录中。':'这次修改暂时无法读取。');completeViewRequest?.();return;}
    handledView.current=viewRequest;setFocused(recordKey(row));setExpanded(recordKey(row));const element=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-record-task]')||[]).find(e=>e.dataset.recordTask===row.taskId&&e.dataset.recordProject===row.projectId);element?.scrollIntoView?.({block:'start'});element?.focus({preventScroll:true});completeViewRequest?.();
  },[viewRequest,loading,key,version]);
  return <div className="pc-records plcdev-scope plcdev-rail" ref={root}><style>{css}</style><div className="pc-records-inner">
    <div className="pc-records-heading"><h2><BrandTitle>本会话的调整</BrandTitle></h2>{loading&&<span className="pc-records-caption" role="status">{rows.some(task=>!task.unavailable)?'正在更新…':'正在读取…'}</span>}<button className="pc-records-back" onClick={()=>openView('chat')}>返回对话</button></div>
    {(state.error||errors.length>0||focusError)&&<p className="pc-records-error" role="status">{state.error||errors.join(' ')||focusError}{errors.length>0&&<button className="pc-records-back" style={{marginLeft:8}} onClick={()=>setRetry(n=>n+1)}>重试</button>}</p>}
    {!rows.length?<p className="pc-records-empty">{state.loading?'正在读取…':'本会话还没有工程修改。'}</p>:rows.filter(task=>!task.unavailable||(!task.pending&&!state.error&&!current?.errors[task.projectId])).map(task=><section key={recordKey(task)} className="pc-records-round" tabIndex={-1} data-record-task={task.taskId} data-record-project={task.projectId} data-focused={focused===recordKey(task)}>
      {task.unavailable?<p className="pc-records-error">这次修改暂时无法读取，记录仍保留。</p>:<><button className="pc-records-back plcdev-tab" style={{overflowWrap:'anywhere',width:'100%',textAlign:'left',display:'flex',gap:12,justifyContent:'space-between'}} aria-expanded={expanded===recordKey(task)} onClick={()=>setExpanded(expanded===recordKey(task)?null:recordKey(task))}><span>{expanded===recordKey(task)?'⌄':'›'} {typeof task.request==='string'?task.request:'工程修改'}</span>{expanded!==recordKey(task)&&<span style={{whiteSpace:'nowrap'}}>{resultStatus(task)}</span>}</button>{expanded===recordKey(task)&&<CandidateResultCard block={{content:[{type:'text',text:JSON.stringify({task})}]}} {...actions} {...{contexts,sessionId}} hideRecordsLink embedded onContinueCurrent={()=>openView('chat')}/>}</>}
    </section>)}
  </div></div>;
}
