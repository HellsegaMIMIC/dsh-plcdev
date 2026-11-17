import React,{useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import {runtimeDockLabel} from './conversation-client.mjs';
import {runtimeActions} from './project-context.mjs';
import {monitoredVariables} from './overview-model.mjs';
import {conversationApi} from './conversation-client.mjs';
import {validateToolEnvironment} from './tool-distributions.mjs';
import {ToolDownloads} from './ToolDownloads';
import {RuntimeRelation} from './RuntimeRelation';
import {RuntimeEvents} from './RuntimeEvents';
import {currentRuntimeIssues} from './runtime-relation.mjs';
import {runtimeObservationFresh} from './model.mjs';

const runtimeStyles=`
.pc-runtime{--rt-line:var(--dsw-alias-border-l2,#dfe5ec);--rt-bg:var(--dsw-alias-bg-base,#fff);--rt-muted:var(--dsw-alias-label-secondary,#657184);--rt-soft:var(--dsw-alias-bg-module-platform,#f4f6f9);color:var(--dsw-alias-label-primary,#243247);min-width:0;overflow-wrap:anywhere;font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);background:var(--rt-bg);border:1px solid var(--rt-line);border-radius:12px;container-type:inline-size}
.pc-runtime *{box-sizing:border-box}.pc-runtime p{margin:0}.pc-runtime button{font:inherit;font-size:13px;min-height:36px;color:inherit;border:1px solid var(--rt-line);border-radius:8px;background:var(--rt-bg);padding:6px 12px;cursor:pointer;white-space:normal}.pc-runtime button:hover:not(:disabled){background:var(--rt-soft)}.pc-runtime button:disabled{opacity:.46;cursor:default}.pc-runtime button:focus-visible,.pc-runtime summary:focus-visible{outline:2px solid var(--plcdev-accent,#7653bc);outline-offset:3px}
.pc-runtime .pc-runtime-summary{padding:24px}.pc-runtime .pc-runtime-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}.pc-runtime .pc-runtime-heading>button{background:transparent;border-color:transparent;color:var(--rt-muted)}.pc-runtime .pc-runtime-state{font-size:22px;font-weight:600;letter-spacing:-.4px;display:flex;align-items:center;gap:12px}.pc-runtime .pc-runtime-state:before{content:'';width:10px;height:10px;border:3px solid var(--rt-muted);border-radius:50%;box-sizing:content-box;flex:none;opacity:.65}.pc-runtime .pc-runtime-state[data-state=running]:before{border-color:#16866d;box-shadow:0 0 0 4px color-mix(in srgb,#16866d 10%,var(--rt-bg));opacity:1}.pc-runtime .pc-runtime-state[data-state=fault]:before{border-color:#c06b28;opacity:1}.pc-runtime .pc-runtime-context{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-top:12px;font-size:13px;color:var(--rt-muted)}.pc-runtime .pc-runtime-context button{padding:4px 9px;font-size:13px}.pc-runtime .pc-runtime-muted{color:var(--rt-muted);font-size:13px}.pc-runtime .pc-runtime-load{margin-top:6px;font-size:13px;color:var(--rt-muted)}
.pc-runtime .pc-runtime-controls{margin-top:24px}.pc-runtime .pc-runtime-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}.pc-runtime .pc-runtime-controls>p{margin-bottom:12px}.pc-runtime .pc-runtime-action{display:flex;flex-direction:column;align-items:flex-start;gap:8px;flex:0 1 152px;min-width:0}.pc-runtime .pc-runtime-action>button{min-width:120px;width:100%}.pc-runtime .pc-runtime-action small{font-size:12px;line-height:1.6;color:var(--rt-muted)}.pc-runtime .pc-runtime-primary{background:var(--plcdev-accent,#7653bc);border-color:var(--plcdev-accent,#7653bc);color:var(--plcdev-on-accent,#fff)}.pc-runtime .pc-runtime-primary:hover:not(:disabled){filter:brightness(.94)}
.pc-runtime .pc-runtime-notice{margin:16px 0 0;padding:12px 14px;border:1px solid var(--rt-line);border-radius:8px;background:var(--rt-soft);font-size:13px}.pc-runtime .pc-runtime-notice button{margin-top:8px}.pc-runtime .pc-runtime-monitor{padding:20px 24px 24px;border-top:1px solid var(--rt-line)}.pc-runtime h4{font:inherit;font-weight:600;margin:0 0 16px}.pc-runtime table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px}.pc-runtime th,.pc-runtime td{padding:12px;text-align:left;border-bottom:1px solid var(--rt-line);overflow-wrap:anywhere;vertical-align:top}.pc-runtime th{font-weight:500;color:var(--rt-muted);background:var(--rt-soft)}.pc-runtime tr:last-child td{border-bottom:0}.pc-runtime td:nth-child(3){font-variant-numeric:tabular-nums;font-weight:600}.pc-runtime .pc-runtime-diagnostics{padding:14px 24px;border-top:1px solid var(--rt-line);font-size:12px;color:var(--rt-muted)}.pc-runtime summary{cursor:pointer;line-height:24px}.pc-runtime .pc-runtime-diagnostics p{margin-top:8px}.pc-runtime code{font:inherit;overflow-wrap:anywhere}
@container(max-width:540px){.pc-runtime .pc-runtime-summary,.pc-runtime .pc-runtime-monitor{padding:18px 16px}.pc-runtime .pc-runtime-state{font-size:18px}.pc-runtime .pc-runtime-heading{gap:8px}.pc-runtime .pc-runtime-diagnostics{padding:12px 16px}.pc-runtime .pc-runtime-action{flex:1 1 108px}.pc-runtime .pc-runtime-action>button{min-width:0;width:100%;padding-inline:8px}.pc-runtime th,.pc-runtime td{padding:9px 5px;font-size:12px}.pc-runtime th:nth-child(1){width:44%}.pc-runtime th:nth-child(2){width:18%}.pc-runtime th:nth-child(3){width:13%}.pc-runtime th:nth-child(4){width:25%}}

.pc-runtime summary{list-style:none;display:flex;align-items:center;gap:10px}.pc-runtime summary::-webkit-details-marker{display:none}.pc-runtime summary:before{content:'';display:inline-block;width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);margin-right:2px}.pc-runtime details[open]>summary:before{transform:rotate(135deg)}
/* Observation tabs own their complete hit area; ordinary button hover styling must not bleed into it. */
.pc-runtime .pc-observation-tabs{display:flex;align-items:stretch;gap:24px;flex-wrap:wrap;border-top:1px solid var(--rt-line);border-bottom:1px solid var(--rt-line);padding:0 24px}
.pc-runtime .pc-observation-tabs>button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:50px;margin:0;border:0;border-bottom:2px solid transparent;border-radius:0;padding:14px 0 12px;background:transparent;box-shadow:none;transform:none;color:var(--rt-muted);font-weight:600;line-height:1.6;text-decoration:none;transition:color .15s}
.pc-runtime .pc-observation-tabs>button:is(:hover,:active,:focus){background:transparent;border-color:transparent;box-shadow:none;transform:none;text-decoration:none}
.pc-runtime .pc-observation-tabs>button[aria-pressed=true]{border-bottom-color:var(--plcdev-accent,#7653bc);color:var(--plcdev-accent,#7653bc)}
.pc-runtime .pc-observation-tabs>button:focus:not(:focus-visible){outline:none}
.pc-runtime .pc-observation-tabs>button:focus-visible{outline:2px solid var(--plcdev-accent,#7653bc);outline-offset:2px}
.pc-runtime .pc-observation-tabs small{align-self:center;font-size:11px;color:var(--rt-muted);margin-left:auto}
@container(max-width:540px){.pc-runtime .pc-observation-tabs{padding-inline:16px;gap:0 18px}.pc-runtime .pc-observation-tabs small{flex-basis:100%;margin:0 0 12px}}
`;

function projectName(snapshot:any,id:string|undefined){
  if(!id)return '工程名称未提供';
  const project=snapshot?.project?.id===id?snapshot.project:snapshot?.projects?.find((item:any)=>item.id===id);
  if(typeof project?.name==='string'&&project.name.trim())return project.name;
  const session=snapshot?.otherSessions?.find((item:any)=>item.projectId===id);
  return typeof session?.projectName==='string'&&session.projectName.trim()?session.projectName:'工程名称未提供';
}

export function RuntimePane({projectId,projectContexts,onProject,sessionId,projectRevision=null}:any){
  const controller=projectContexts.get(projectId),state=useSyncExternalStore(controller.subscribe,controller.snapshot),s=state.snapshot;
  const reasonId=useId();
  const [observation,setObservation]=useState('variables'),[source,setSource]=useState('all'),[node,setNode]=useState<string|null>(null);
  const [environment,setEnvironment]=useState<any>(null),[toolsOpen,setToolsOpen]=useState(false),[environmentRefresh,setEnvironmentRefresh]=useState(0);
  const [eventData,setEventData]=useState<any>(null),[eventStale,setEventStale]=useState(true);
  const observationRef=useRef<HTMLDivElement>(null),mapRef=useRef<HTMLDivElement>(null),returnEventRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{let cancelled=false;conversationApi('tool-environment').then(validateToolEnvironment).then(value=>{if(!cancelled)setEnvironment(value);}).catch(()=>{if(!cancelled)setEnvironment(null);});return()=>{cancelled=true;};},[environmentRefresh]);
  useEffect(()=>{setObservation('variables');setSource('all');setNode(null);setEventData(null);setEventStale(true);},[projectId]);
  const issues=eventStale?{}:currentRuntimeIssues(eventData,s,projectRevision);
  const showEvents=(filter:string)=>{setSource(filter);setObservation('events');setNode(null);requestAnimationFrame(()=>{observationRef.current?.scrollIntoView?.({block:'nearest'});observationRef.current?.querySelector<HTMLButtonElement>('[data-tab="events"]')?.focus({preventScroll:true});});};
  const showNode=(filter:string)=>{returnEventRef.current=document.activeElement as HTMLElement;setNode(({compiler:'compiler',runtime:'runtime',fuxa:'hmi',oip:'oip',plcdev:'project'} as any)[filter]||'runtime');requestAnimationFrame(()=>mapRef.current?.scrollIntoView?.({block:'nearest'}));};
  const selectNode=(next:string|null)=>{setNode(next);if(!next&&returnEventRef.current?.isConnected){returnEventRef.current.scrollIntoView?.({block:'nearest'});returnEventRef.current.focus({preventScroll:true});returnEventRef.current=null;}};
  // Sampling can expire between status responses.
  const [,tick]=useState(0);
  useEffect(()=>{const id=setInterval(()=>tick(n=>n+1),1000);return ()=>clearInterval(id);},[]);
  const variables=monitoredVariables(s,!!s);
  const observationFresh=runtimeObservationFresh(s);
  const reason=(cap:string)=>!s?'状态尚未确认':state.busy?'操作正在处理':state.pending?'请先核对上次操作结果':s.capabilities?.[cap]!==true?(s.capabilities?.reasons?.[cap]||'后台未允许此操作'):'';
  const reasons=runtimeActions.map(([,cap])=>reason(cap)),commonReason=reasons[0]&&reasons.every(value=>value===reasons[0])?reasons[0]:'';
  const runtimeLabel=s?runtimeDockLabel(s,projectId).replace('本工程未创建','尚未准备'):'当前状态无法确认';
  const owner=s?.runtimeOwner;
  const history=(!s||owner===undefined||owner?.state==='unknown')?state.lastRuntimeOwner:null;
  return <section className="pc-runtime" aria-label="运行状态与监视">
    <style>{runtimeStyles}</style>
    <style>{`.pc-runtime .pc-runtime-monitor{border-top:0}.pc-runtime .pc-environment-note{margin:12px 0 0;font-size:12px;color:var(--rt-muted)}.pc-runtime .pc-runtime-primary{background:var(--plcdev-accent,#7653bc);border-color:var(--plcdev-accent,#7653bc)}.pc-runtime .pc-runtime-primary:hover:not(:disabled){background:var(--plcdev-accent,#7653bc);border-color:var(--plcdev-accent,#7653bc);filter:brightness(.94)}.pc-runtime .pc-events-wrap{padding:0 24px 18px}.pc-runtime .pc-map-wrap{scroll-margin-top:15px}.pc-runtime [hidden]{display:none!important}@container(max-width:540px){.pc-runtime .pc-events-wrap{padding-inline:16px}}`}</style>
    <div className="pc-runtime-summary"><div className="pc-runtime-heading"><strong className="pc-runtime-state" data-state={runtimeLabel==='运行中'?'running':runtimeLabel==='异常'?'fault':undefined}>{runtimeLabel}</strong><button disabled={state.busy} onClick={()=>controller.refresh()}>刷新状态</button></div>
    {owner&&<div className="pc-runtime-context"><p>运行目标归属：{owner.state==='unknown'?'状态无法确认':owner.projectId?projectName(s,owner.projectId):'所属工程未确认'}</p>{owner.state!=='unknown'&&owner.projectId&&owner.projectId!==projectId&&<button onClick={()=>onProject(sessionId,owner.projectId)}>查看占用工程</button>}</div>}
    {s&&owner===undefined&&<p className="pc-runtime-context pc-runtime-muted">运行目标归属：未提供</p>}
    {history&&<p className="pc-runtime-context pc-runtime-muted">上次确认的运行归属（当前状态未知）：{projectName(s,history.projectId)}</p>}
    {s?.session?.active&&<p className="pc-runtime-load">装载版本：{s.links?.load?.label||'与当前工程的关系未确认'}</p>}
    <div className="pc-map-wrap" ref={mapRef}><RuntimeRelation snapshot={s} environment={environment} projectRevision={projectRevision} issues={issues} onEvents={showEvents} onEnvironment={()=>setToolsOpen(true)} selected={node} onSelect={selectNode}/></div>
    <p className="pc-environment-note">保留工程、编译并准备、运行 PLC 分别执行；工具入口已找到不代表编译或运行已验证。</p>
    <div className="pc-runtime-controls">{commonReason&&<p className="pc-runtime-muted" id={reasonId}>{commonReason}</p>}<div className="pc-runtime-actions">{runtimeActions.map(([action,cap,label])=>{const disabled=reason(cap),description=commonReason?reasonId:disabled?reasonId+'-'+action:undefined;return <div className="pc-runtime-action" key={action}><button className={!disabled&&['start','runtime-start'].includes(action)?'pc-runtime-primary':undefined} disabled={!!disabled} aria-describedby={description} onClick={()=>controller.action(action)}>{label}</button>{disabled&&!commonReason&&<small id={description}>{disabled}</small>}</div>;})}</div></div>
    {(state.notice||state.error||state.pending)&&<div className="pc-runtime-notice" role="status">{(state.notice||state.error)&&<p>{state.notice||state.error}</p>}{state.pending&&<button disabled={!s||state.busy} onClick={()=>controller.acknowledge()}>已核对当前状态，解除待核对提示</button>}</div>}
    </div><div ref={observationRef}><nav className="pc-observation-tabs" aria-label="运行观察内容"><button data-tab="variables" aria-pressed={observation==='variables'} onClick={()=>setObservation('variables')}>变量监视</button><button data-tab="events" aria-pressed={observation==='events'} onClick={()=>setObservation('events')}>运行事件{Object.values(issues).reduce((sum:number,n:any)=>sum+Number(n),0)>0?' · '+Object.values(issues).reduce((sum:number,n:any)=>sum+Number(n),0):''}</button><small>当前工程 · {eventStale?'事件状态待读取':'事件已读取'}</small></nav>
    <div hidden={observation!=='variables'} className="pc-runtime-monitor">{s?.session?.active?<>{variables.length?<table><thead><tr><th>变量</th><th>类型</th><th>值</th><th>数据质量</th></tr></thead><tbody>{variables.map((v:any)=><tr key={v.path}><td>{v.path}</td><td>{v.type}</td><td>{v.value}</td><td>{v.quality}</td></tr>)}</tbody></table>:<p className="pc-runtime-muted">后台尚未提供变量采样。</p>}{s.state?.requiresManualRecovery===true&&observationFresh&&<p className="pc-runtime-notice" role="status">需要在 HMI 核对批次数量后再恢复操作。</p>}</>:<p className="pc-runtime-muted">{s?'准备运行实例后可查看变量采样。':'变量采样不可用，请刷新状态。'}</p>}</div>
    <div className="pc-events-wrap" hidden={observation!=='events'}><RuntimeEvents key={projectId} projectId={projectId} projectRevision={projectRevision} source={source} onSourceChange={setSource} onNode={showNode} onEvents={(value:any,meta:any)=>{setEventData(value);setEventStale(meta.stale||!value);}}/></div></div>
    <details className="pc-runtime-diagnostics"><summary>实例信息</summary>
      <p>运行实例：{!s?'状态无法确认':s.session?.id||(s.session?.active===false?'尚未准备':'身份未确认')}</p>
      {owner&&owner.state!=='unknown'&&<><p>归属工程编号：<code>{owner.projectId||'未提供'}</code></p><p>占用实例编号：<code>{owner.sessionId||'未提供'}</code></p>{owner.owner&&<p>所属入口：{owner.owner}</p>}</>}
      {s?.session?.active&&<p>装载程序摘要：<code>{s.session.programHash||'未提供'}</code></p>}
      <p>观察数据：{observationFresh?'有效':'无法确认'}</p>
      {history&&<><p>历史归属工程编号：<code>{history.projectId||'未提供'}</code> · 实例 <code>{history.sessionId}</code></p>{history.programHash&&<p>历史装载程序摘要：<code>{history.programHash}</code></p>}<p>历史归属核对时间：{new Date(history.observedAt).toLocaleString()}</p></>}
    </details>
    {toolsOpen&&<ToolDownloads onClose={()=>setToolsOpen(false)} onChecked={()=>setEnvironmentRefresh(n=>n+1)}/>}
  </section>;
}
