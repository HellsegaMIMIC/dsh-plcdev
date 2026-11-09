import React,{useEffect,useSyncExternalStore} from 'react';
import {useConversationContext} from './useConversationContext';
import {graphEntities} from './model.mjs';
import {RuntimePane} from './RuntimePane';
export function ProjectPane({sessionId,useTabInfo,contexts,projectContexts,onProject,onOverview,onRetainedProject}:any){
  const params=useTabInfo()?.tab?.navigation?.params,target=params?.projectId;
  const key='plcdev.dsh.project-view.'+sessionId;
  let id=target;
  try{if(params==null)id=window.localStorage.getItem(key);}catch{}
  useEffect(()=>{if(/^[a-z][a-z0-9-]{0,63}$/.test(target||''))try{window.localStorage.setItem(key,target);}catch{}},[key,target]);
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(id||''))return <p>未指定工程，请从头部打开。</p>;
  return <ProjectContent key={sessionId+':'+id} {...{sessionId,id,contexts,projectContexts,onProject,onOverview,onRetainedProject}}/>;
}
function ProjectContent({sessionId,id,contexts,projectContexts,onProject,onRetainedProject}:any){
  const binding=useConversationContext(contexts,sessionId),controller=projectContexts.get(id),state=useSyncExternalStore(controller.subscribe,controller.snapshot),s=state.snapshot;
  return <div className="pc-project" style={{padding:18,overflow:'auto',height:'100%',fontSize:13,color:'var(--dsw-alias-label-primary,#24334a)'}}>
    <style>{`.pc-project button{font:inherit;color:inherit;background:var(--dsw-alias-bg-module-platform,#f5f6f8);border:1px solid var(--dsw-alias-border-l2,#8895);border-radius:7px;padding:6px 9px;margin:3px;cursor:pointer}.pc-project button:disabled{opacity:.45;cursor:default}.pc-project h2{font-size:17px;overflow-wrap:anywhere}.pc-project h3{font-size:14px;margin-top:22px}.pc-project p{line-height:1.6}.pc-project section{border-top:1px solid #8895;margin-top:20px}`}</style>
    <h2>工程 · {s?.project?.name||id}</h2><p>正在查看此工程；对话工程：{binding.projects.find((p:any)=>p.id===binding.binding?.projectId)?.name||binding.binding?.projectId||'未选择'}</p>
    {binding.binding?.projectId!==id&&<button disabled={binding.busy||!binding.binding||!!binding.pending||!!binding.storageError||!!binding.binding?.pendingRequests.length} onClick={()=>binding.controller.bind(id)}>用于后续对话</button>}
    {binding.error&&<p role="status">{binding.error}</p>}
    <h3>工程资源</h3>{s?graphEntities(s).filter((e:any)=>e.tool).map((e:any)=><p key={e.id}>{e.role} · {e.title} <button disabled={state.busy||!!state.pending||s.capabilities?.tools?.[e.tool]!==true} onClick={()=>controller.action('tool',e.tool)}>打开</button></p>):<p>正在读取工程资源…</p>}
    <button onClick={()=>onRetainedProject(id)}>打开完整工作台</button><button onClick={()=>controller.refresh()}>刷新状态</button>
    <p>在聊天中向当前模型提出修改需求；支持 native 工具调用的模型可提交联合计划，不要求专用模型。团队模式仍按已验证范围使用。</p>
    <RuntimePane {...{projectId:id,projectContexts,onProject,sessionId}}/>
  </div>;
}
