import React,{useEffect,useState} from 'react';
import {useConversationContext} from './useConversationContext';
export function ConversationHeader({sessionId,contexts,onProject,onReview,navigation}:any){
  const state=useConversationContext(contexts,sessionId),[menu,setMenu]=useState(false);
  const id=state.binding?.projectId,name=state.projects.find((p:any)=>p.id===id)?.name||id;
  useEffect(()=>navigation.subscribe(()=>{const intent=navigation.snapshot();if(intent?.sessionId!==sessionId)return;if(intent.taskId)onReview(sessionId,intent);else onProject(sessionId,intent.projectId);navigation.clear(intent);}),[navigation,sessionId,onReview,onProject]);
  return <div className="pc-context" style={{position:'relative',maxWidth:260,fontSize:13}}><style>{`.pc-context button,.pc-context select{font:inherit;color:inherit;background:var(--dsw-alias-bg-module-platform,#f5f6f8);border:1px solid var(--dsw-alias-border-l2,#8895);border-radius:7px;padding:5px 8px;cursor:pointer}.pc-context button:disabled{opacity:.5}.pc-context p{margin:8px 0;line-height:1.5}`}</style>
    <button title={name||'选择工程'} onClick={()=>id?onProject(sessionId,id):setMenu(!menu)} style={{maxWidth:210,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{id?'工程：'+name:state.loading?'正在读取工程…':'选择工程'}</button>
    <button aria-label="切换对话工程" aria-expanded={menu} onClick={()=>setMenu(!menu)}>▾</button>
    {state.binding?.revisionContext&&state.binding.revisionContext.state!=='submitted'&&<div role="status"><span title="草稿保持不变；下一条支持工具的模型消息作为指定候选的新需求。">继续修改中</span><button disabled={state.busy} onClick={()=>state.controller.cancelRevision()}>取消修订</button></div>}
    {menu&&<div style={{position:'absolute',right:0,top:'100%',zIndex:10,padding:12,width:260,background:'var(--dsw-alias-bg-base,#fff)',color:'var(--dsw-alias-label-primary,#24334a)',border:'1px solid #8895',borderRadius:8}}>
      <label>后续对话工程<select aria-label="后续对话工程" value={id||''} disabled={state.busy||!state.binding||!!state.pending||!!state.storageError||!!state.binding?.pendingRequests.length} onChange={e=>{if(e.target.value)state.controller.bind(e.target.value);}} style={{width:'100%'}}><option value="">选择工程</option>{state.projects.map((p:any)=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}</select></label>
      <p>选择后仅改变后续对话归属。</p><p>工程工具随对话提供，不要求专用模型。模型需支持 native 工具调用；无工具时仍可聊天、查看和审阅。普通文件编辑不会登记为候选。</p><button onClick={()=>state.controller.refresh()}>重新读取</button>
      {!!state.binding?.taskRefs.length&&<details><summary>历史更改</summary>{state.binding.taskRefs.map((t:any)=><button key={t.taskId} onClick={()=>onReview(sessionId,t)}>查看 {state.projects.find((p:any)=>p.id===t.projectId)?.name||t.projectId} 的更改</button>)}</details>}
      {state.pending&&<p>有待核对请求，原工程和请求编号已保留。请重新读取后核对历史更改。<button disabled={state.busy||!!state.storageError} onClick={()=>state.controller.retryPending()}>以原请求编号核对／重试</button></p>}
    </div>}
    {(state.busy||state.error||state.storageError)&&<div role="status">{state.busy?'正在切换…':state.error||state.storageError}</div>}
    {state.binding?.modelCapability?.state==='tools-unavailable'&&<div role="status">{state.binding.modelCapability.message}</div>}
  </div>;
}
