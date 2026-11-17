import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {activityLabel} from './runtime-activity.mjs';

export function RuntimeActivity({activity,onOpenRuntime,currentProjectId,currentView,compact=false,onShowDetails,excludeProjectId}:any){
  if(!activity)return null;
  return <ActivityContent {...{activity,onOpenRuntime,currentProjectId,currentView,compact,onShowDetails,excludeProjectId}}/>;
}

function ActivityContent({activity,onOpenRuntime,currentProjectId,currentView,compact,onShowDetails,excludeProjectId}:any){
  const state=useSyncExternalStore(activity.subscribe,activity.snapshot);
  const [,tick]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>tick(n=>n+1),1000);return ()=>clearInterval(timer);},[]);
  const items=state.items.filter((item:any)=>item.projectId!==excludeProjectId&&!(item.projectId===currentProjectId&&currentView==='runtime'));
  if(!items.length)return null;
  if(compact){
    const item=items[0],label=items.length>1?`运行实例 · ${items.length}`:item.projectId!==currentProjectId?'其他工程实例':activityLabel(item).replace('实例就绪 · ','').replace('运行状态待核对','运行待核对');
    const description=items.map((entry:any)=>entry.projectName+' · '+activityLabel(entry)).join('；');
    return <button className="pc-runtime-compact" title={description} aria-label={description+'，查看运行详情'} onClick={()=>items.length===1&&onOpenRuntime?onOpenRuntime(item.projectId):onShowDetails?.()}>{label}</button>;
  }
  return <div className="pc-runtime-activity" aria-label="活动运行实例">
    <style>{`.pc-runtime-activity{display:grid;gap:6px;font:12px/1.5 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#657184);min-width:0;max-width:100%}.pc-runtime-activity>div{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:8px;background:var(--dsw-alias-bg-module-platform,#f4f6f9)}.pc-runtime-activity span{min-width:0;overflow-wrap:anywhere}.pc-runtime-activity button{font:inherit;color:var(--plcdev-accent,#7653bc);border:0;background:transparent;padding:4px 0;cursor:pointer;white-space:normal}.pc-runtime-activity button:focus-visible{outline:2px solid currentColor;outline-offset:3px}`}</style>
    {items.map((item:any)=><div key={item.projectId+':'+item.sessionId}>
      <span>{item.projectName} · {activityLabel(item)}</span>
      {onOpenRuntime&&<button onClick={()=>onOpenRuntime(item.projectId)}>返回监视</button>}
    </div>)}
  </div>;
}
