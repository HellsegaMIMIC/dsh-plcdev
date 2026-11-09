import React,{useSyncExternalStore} from 'react';
import {runtimeDockLabel} from './conversation-client.mjs';
import {runtimeActions} from './project-context.mjs';
export function RuntimePane({projectId,projectContexts,onProject,sessionId}:any){
  const controller=projectContexts.get(projectId),state=useSyncExternalStore(controller.subscribe,controller.snapshot),s=state.snapshot;
  return <section><h3>运行 · {s?.project?.name||projectId}</h3><p>{s?runtimeDockLabel(s,projectId).replace('本工程未创建','尚未准备'):'当前状态无法确认'}</p>
    {s?.runtimeOwner&&<p>运行归属：{s.runtimeOwner.projectId||'尚未确认'} {s.runtimeOwner.projectId&&s.runtimeOwner.projectId!==projectId&&<button onClick={()=>onProject(sessionId,s.runtimeOwner.projectId)}>查看占用工程</button>}</p>}
    <p>运行实例：{s?.session?.id||'尚未准备'}</p><details><summary>程序与数据质量</summary><p>程序摘要：{s?.session?.programHash||'未确认'}</p><p>观察数据：{s?.observerFresh===true?'有效':'无法确认'}</p></details>
    {runtimeActions.map(([action,cap,label])=><button key={action} title={s?.capabilities?.reasons?.[cap]||''} disabled={!s||state.busy||!!state.pending||s.capabilities?.[cap]!==true} onClick={()=>controller.action(action)}>{label}</button>)}
    {(state.notice||state.error)&&<p role="status">{state.notice||state.error}</p>}
    {state.pending&&<button disabled={!s||state.busy} onClick={()=>controller.acknowledge()}>已核对当前状态，解除待核对提示</button>}
    <p>离开此页不会停止运行。编译并准备与候选编译分别管理。</p>
  </section>;
}
