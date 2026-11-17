import {BrandTitle} from './Brand';
import React,{useEffect,useSyncExternalStore,useState,useRef} from 'react';
import {useConversationContext} from './useConversationContext';
import {ProjectResourceList} from './ProjectResourceList';
import {RuntimeSummary} from './RuntimeRelation';
import {RuntimeActivity} from './RuntimeActivity';
import {ProjectSignalDetail,useProjectInspection} from './ProjectSignals';
import {signalReference} from './conversation-flow.mjs';
import {bindingBlockedReason} from './conversation-context.mjs';
import {BackendConnection} from './BackendConnection';
import {conversationApi} from './conversation-client.mjs';
import {openResultInEditor,editorOpenNotice} from './result-flow.mjs';
const css=`
.pc-project{--pc-surface:var(--dsw-alias-bg-base,#fff);--pc-canvas:var(--dsw-alias-bg-module-platform,#f5f6f8);--pc-line:var(--dsw-alias-border-l2,#e2e6ed);--pc-sub:var(--dsw-alias-label-secondary,#667085);--pc-accent:var(--plcdev-accent);box-sizing:border-box;min-width:0;overflow-wrap:anywhere;background:var(--pc-canvas);font-family:var(--dsw-font-family,system-ui,sans-serif);line-height:1.6}
.pc-project *{box-sizing:border-box}.pc-project>div,.pc-project>section{max-width:1120px;margin-inline:auto}.pc-project button{font:inherit;font-size:13px;font-weight:500;line-height:1.4;min-height:36px;color:inherit;background:var(--pc-surface);border:1px solid var(--pc-line);border-radius:8px;padding:7px 12px;cursor:pointer;transition:background .15s,border-color .15s}.pc-project button:hover:not(:disabled){background:var(--pc-canvas);border-color:color-mix(in srgb,var(--pc-accent) 35%,var(--pc-line))}.pc-project button:disabled{opacity:.45;cursor:default}.pc-project button:focus-visible,.pc-project summary:focus-visible{outline:2px solid var(--pc-accent);outline-offset:3px}.pc-project .pc-project-primary{background:var(--pc-accent);border-color:var(--pc-accent);color:var(--plcdev-on-accent)}.pc-project .pc-project-primary:hover:not(:disabled){background:var(--pc-accent);filter:brightness(.95)}.pc-project .pc-project-quiet{border-color:transparent;background:transparent;color:var(--pc-sub)}
.pc-project h2{font-size:17px;line-height:1.5;font-weight:600;overflow-wrap:anywhere;margin:0}.pc-project h3{font-size:14px;font-weight:600;margin:0}.pc-project p{line-height:1.65;margin:10px 0}.pc-project .pc-project-heading,.pc-project .pc-resource-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}.pc-project-heading h2{flex:1 1 140px;min-width:0}.pc-project-summary{padding:18px 18px 16px;border:1px solid var(--pc-line);border-radius:12px;background:var(--pc-surface)}.pc-project .pc-binding-state{display:flex;align-items:center;gap:6px;font-size:12px;margin:8px 0 0;color:var(--pc-sub)}.pc-project .pc-binding-state::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#268878);flex:none}.pc-project-binding{font-size:13px;color:var(--pc-sub)}.pc-project-bind-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}.pc-project-bind-actions small{flex-basis:100%;font-size:12px;color:var(--pc-sub)}
.pc-project>.pc-project-resources{border:1px solid var(--pc-line);border-radius:12px;background:var(--pc-surface);margin-top:16px;padding:0 18px;overflow:hidden}.pc-project .pc-resource-heading{padding:12px 0;border-bottom:1px solid var(--pc-line)}.pc-project .pc-resource-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin:0;padding:14px 0;border-bottom:1px solid var(--pc-line)}.pc-project .pc-resource-row:last-child{border-bottom:0}.pc-project .pc-resource-row>div{flex:1 1 150px;min-width:0;display:grid;gap:3px}.pc-project .pc-resource-row strong{font-size:13px;font-weight:500}.pc-project .pc-resource-row span{font-size:12px;color:var(--pc-sub)}.pc-project>.pc-runtime{margin-top:16px;padding:0;border:1px solid var(--pc-line);border-radius:12px;background:var(--pc-surface)}.pc-project .pc-project-message{padding:10px 12px;border-radius:8px;background:var(--pc-canvas);font-size:13px}
@media(max-width:480px){.pc-project{padding:12px!important}.pc-project-summary{padding:14px}.pc-project>.pc-project-resources{padding:0 14px}.pc-project>.pc-runtime{padding:0}.pc-project .pc-resource-row>div{flex-basis:140px}}
`;
export function ProjectPane({sessionId,useTabInfo,contexts,projectContexts,onProject,onOverview,onRetainedProject,onClose,runtimeActivity,onOpenRuntime,onOpenResultResource}:any){
  const info=useTabInfo?.(),params=info?.tab?.navigation?.params,target=params?.projectId;
  const key='plcdev.dsh.project-view.'+sessionId;
  let id=target;
  try{if(params==null)id=window.localStorage.getItem(key);}catch{}
  useEffect(()=>{if(/^[a-z][a-z0-9-]{0,63}$/.test(target||''))try{window.localStorage.setItem(key,target);}catch{}},[key,target]);
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(id||''))return <div className="pc-project plcdev-scope plcdev-rail" style={{padding:18}}><h2><BrandTitle compact>工程引用</BrandTitle></h2><p>未指定工程，请从头部打开。</p></div>;
  const close=onClose?()=>onClose(sessionId,info?.tab?.id):info?.tab?.actions?.close;
  return <ProjectContent key={sessionId+':'+id} {...{sessionId,id,contexts,projectContexts,onProject,onOverview,onRetainedProject,runtimeActivity,onOpenRuntime,onOpenResultResource}} reference={params?.reference} onClose={close}/>;
}
function ProjectContent({sessionId,id,contexts,projectContexts,onProject,onRetainedProject,runtimeActivity,onOpenRuntime,onOpenResultResource,reference,onClose}:any){
  const binding=useConversationContext(contexts,sessionId),controller=projectContexts.get(id),state=useSyncExternalStore(controller.subscribe,controller.snapshot),s=state.snapshot;
  const bindReason=bindingBlockedReason(binding);
  const sameProject=binding.binding?.projectId===id;
  const [editorBusy,setEditorBusy]=useState(false),[editorNotice,setEditorNotice]=useState('');
  const opening=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function openPlc(){
    if(opening.current||!sameProject)return;
    opening.current=true;setEditorBusy(true);setEditorNotice('正在连接此工程的 DSH 会话并打开 OpenPLC…');
    try{const result=await openResultInEditor({api:conversationApi,conversationId:sessionId,projectId:id,target:'project',isCurrent:()=>alive.current,onState:(value:any)=>setEditorNotice(editorOpenNotice(value))});if(alive.current&&result.state==='requested')setEditorNotice('已请求打开，OpenPLC 尚未确认工程加载。');}
    catch(error:any){if(alive.current)setEditorNotice(error?.message||'编辑器连接未能确认。');}
    finally{opening.current=false;if(alive.current)setEditorBusy(false);}
  }
  const projectName=s?.project?.name||binding.projects.find((p:any)=>p.id===id)?.name||'工程名称未确认';
  const conversationProject=!binding.binding?(binding.loading?'正在读取':'状态未确认'):binding.binding.projectId?(binding.projects.find((p:any)=>p.id===binding.binding.projectId)?.name||'名称未提供'):'未选择';
  return <div className="pc-project plcdev-scope plcdev-rail" onKeyDown={event=>{if(event.key==='Escape'&&onClose){event.stopPropagation();onClose();}}} style={{padding:18,overflow:'auto',height:'100%',fontSize:14,color:'var(--dsw-alias-label-primary,#202939)'}}>
    <style>{css}</style>
    <div className="pc-project-summary">
    <div className="pc-project-heading"><h2><BrandTitle compact>工程引用</BrandTitle></h2>{onClose&&<button className="pc-project-quiet" onClick={onClose}>关闭</button>}</div>
    <p className="pc-project-name">{projectName}</p>
    <div className="pc-project-bind-actions"><button className="plcdev-link" onClick={()=>onRetainedProject(id,sessionId)}>打开工程页</button></div>
    {sameProject?<p className="pc-binding-state">已用于当前对话</p>:<><p className="pc-project-binding">对话工程：{conversationProject}</p>
      {binding.binding?.revisionContext&&binding.binding.revisionContext.state!=='submitted'&&<p>切换后原修订仍保留但不能直接继续；如需修改，请取消并重新选择候选。候选与输入草稿保留。</p>}
      <div className="pc-project-bind-actions"><button className="pc-project-primary" disabled={!!bindReason} onClick={()=>binding.controller.bind(id)}>用于后续对话</button>{bindReason&&<small> {bindReason}</small>}</div></>}
    {binding.error&&<p className="pc-project-message" role="status">{binding.error}</p>}
    {editorNotice&&<p className="pc-project-message" role="status">{editorNotice}</p>}
    {state.notice&&<p className="pc-project-message" role="status">{state.notice}</p>}
    {!!s?.previousToolWindows?.length&&<p className="pc-project-message" role="status">旧版本工具窗口仍打开。请从下方打开当前资源；旧窗口中的未保存编辑仍保留。</p>}
    {s?.savedVersionSync?.state==='blocked'&&<p className="pc-project-message" role="status">{s.savedVersionSync.message}</p>}
    {binding.backendDisconnected&&<BackendConnection onConnected={()=>{binding.controller.refresh({preserveActionError:true});controller.refresh();}}/>}
    </div>
    {reference!==undefined&&<ReferenceContent {...{id,reference,projectName,onClose}}/>}
    <ProjectResourceList {...{sessionId,contexts,binding,controller,state,onOpenResultResource}} projectId={id} savedBusy={editorBusy} onOpenSaved={(resource:any)=>resource.tool==='plc'&&sameProject?openPlc():controller.action('tool',resource.tool)}/>
    {onOpenRuntime&&<RuntimeSummary snapshot={s} onOpen={()=>onOpenRuntime(id,sessionId)}/>}
    <div style={{marginTop:16}}><RuntimeActivity activity={runtimeActivity} excludeProjectId={onOpenRuntime?id:undefined} onOpenRuntime={(projectId:string)=>onOpenRuntime?.(projectId,sessionId)}/></div>
  </div>;
}

function ReferenceContent({id,reference,projectName,onClose}:any){
  const target=signalReference(reference),inspection=useProjectInspection(id,!!target&&target.projectId===id);
  const mismatch=inspection.data&&inspection.data.projectRevision!==target?.savedRevision;
  if(!target||target.projectId!==id)return <p role="status">此引用的工程身份无效，请回工程重新选择。</p>;
  if(mismatch)return <section className="pc-project-resources"><p role="status">工程保存版本已变化，原引用不再代表当前版本。请回工程重新选择信号。</p><p>引用版本 {target.savedRevision.slice(0,8)} · 当前版本 {inspection.data.projectRevision.slice(0,8)}</p></section>;
  if(inspection.data&&!inspection.data.signals.some((signal:any)=>signal.id===target.signalKey))return <p role="status">原信号已不存在，请回工程重新选择。</p>;
  return <ProjectSignalDetail inspection={inspection} signalId={target.signalKey} projectName={projectName} onClose={onClose||(()=>{})} showCarry={false}/>;
}
