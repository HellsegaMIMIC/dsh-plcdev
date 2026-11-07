import React, { useEffect, useRef, useState } from 'react';
import { createReadGate, validateSnapshot, validateTasks, readPending, persistPending, makeCandidateRequest, definitiveFailure, candidateIdentity, canUseTool, externalRuntimeOwner, runtimeOwnerLabel, graphEntities, connectionLabel, taskStatus, selectionKey } from './model.mjs';
import { openplcLogo, eezLogo } from './assets';
import { styles } from './styles';
import { overviewLinks, overviewResources, monitoredVariables, overviewConnection, displayValue } from './overview-model.mjs';

const memoryStorage = { getItem: (_: string) => null, setItem: (_: string, __: string) => { throw new Error('本地存储不可用'); } };
function storage() { try { return window.localStorage; } catch { return memoryStorage; } }
function initialProject() { try { return storage().getItem(selectionKey) || ''; } catch { return ''; } }
const short = (value: any) => String(value || '').replace(/\\/g, '/').split('/').pop();
const phaseLabel: any = { idle: '尚未准备', building: '编译准备中', ready: '实例就绪', stopping: '正在结束', ended: '已结束', fault: '需要处理' };
async function api(path: string, body?: any, timeout = 15000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch('/api/plcdev/' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const error: any = new Error(data?.error || data?.message || '服务请求失败（' + response.status + '）'); error.httpStatus = response.status; throw error; }
    if (!data) throw new Error('服务未返回有效 JSON 数据。');
    return data;
  } finally { clearTimeout(timer); }
}
function Glyph({ kind = 'project', size = 24 }: { kind?: string; size?: number }) {
  const paths: any = { project: 'M3 20V5h6l2 3h10v12Z', runtime: 'M6 6h12v12H6ZM9 9h6v6H9ZM8 2v4m8-4v4M8 18v4m8-4v4M2 8h4m-4 8h4m12-8h4m-4 8h4', scene: 'M3 16h18v5H3Zm3-8h5v6H6Zm8-5h5v11h-5M6 18v1m4-1v1m4-1v1m4-1v1', hmi: 'M3 3h18v14H3ZM12 17v4m-5 0h10M6 7h6m-6 4h3m4-4h5v6h-5', fuxa: 'M4 21V3h16M4 11h13', link: 'M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4', tasks: 'M6 3h15v18H6ZM3 7h6m-6 5h6m-6 5h6M12 7h6m-6 5h6m-6 5h6', open: 'M14 3h7v7M21 3 10 14M10 3H4v17h17v-6' };
  if (kind === 'plc' || kind === 'eez') return <img className="pd-logo" width={size} height={size} src={kind === 'plc' ? openplcLogo : eezLogo} alt="" />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind] || paths.project}/></svg>;
}
export function PlcdevIcon() { return <Glyph kind="runtime" size={20}/>; }

function Topology({ snapshot, connected, selected, onSelect, onOpen, busy }: any) {
  const viewport = useRef<HTMLDivElement>(null), [canvasHeight,setCanvasHeight]=useState(320);
  useEffect(()=>{
    const view=viewport.current;if(!view)return;
    const resize=()=>{if(view.clientHeight>0)setCanvasHeight(Math.max(296,Math.min(396,view.clientHeight-12)));};
    resize();const observer=new ResizeObserver(resize);observer.observe(view);return()=>observer.disconnect();
  },[]);
  const entities = graphEntities(snapshot), links = overviewLinks(snapshot);
  const complex = entities.some((e: any) => e.id === 'designer' || e.id === 'scene');
  const upper=8,lower=canvasHeight-124,level=Math.round((canvasHeight-116)/2),mid=lower+58;
  const deliveryLabel=Math.round((upper+116+lower)/2)-22;
  const positions: any = complex ? {designer:[4,upper],plc:[40,upper],hmi:[4,lower],runtime:[40,lower],scene:[76,lower]} : {plc:[20,level],runtime:[60,level]};
  const routes: any = complex ? {generate:[`M140 ${upper+116}V${lower}`,15.5,deliveryLabel],load:[`M500 ${upper+116}V${lower}`,51.5,deliveryLabel],variables:[`M240 ${mid}H400`,27,mid-22],io:[`M600 ${mid}H760`,63,mid-22]} : {load:[`M400 ${level+58}H600`,44,level+36]};
  const selectedLink = links.find((l: any) => l.id === selected);
  const selectedNodes = selectedLink?.nodes || [selected];
  useEffect(() => {
    const view = viewport.current, node = view?.querySelector<HTMLElement>(`[data-node="${selectedNodes[0]}"]`);
    if (view && node) view.scrollLeft = Math.max(0,node.offsetLeft + node.offsetWidth / 2 - view.clientWidth / 2);
  }, [selected]);
  return <div className="pd-canvas-scroll" ref={viewport}><div className={'pd-canvas '+(complex?'':'pd-local')} style={{height:canvasHeight}}>
    <svg className="pd-wires" viewBox={`0 0 1000 ${canvasHeight}`} preserveAspectRatio="none" aria-hidden="true">{links.map((link: any) => {const status=overviewConnection(snapshot,link.key,connected);return <path key={link.id} className={'pd-wire pd-'+status.tone+(selected===link.id?' selected':'')+(['load','generate'].includes(link.key)?' delivery':'')} d={routes[link.key][0]}/>;})}</svg>
    {links.map((link: any) => {const status=overviewConnection(snapshot,link.key,connected),route=routes[link.key];return <button key={link.id} data-edge={link.key} className={'pd-edge pd-'+status.tone+(selected===link.id?' selected':'')} style={{left:route[1]+'%',top:route[2]}} onClick={()=>onSelect(link.id)} aria-pressed={selected===link.id}><span>{link.title}</span><small>{status.label}</small></button>;})}
    {entities.map((entity: any) => {
      const [left,top]=positions[entity.id];
      const toolAllowed=entity.tool ? canUseTool(snapshot,snapshot.project.id,entity.tool,connected) : entity.hmi && connected && snapshot?.capabilities?.[snapshot?.hmiOpen&&!entity.fuxa?'canReconnectHmi':'canShowHmi']===true;
      const component=entity.component||{};
      const label=connected ? component.label || ({available:'入口可用 · 窗口未确认',unavailable:'工具未安装','launch-requested':'已请求打开','process-alive':'进程存在','launch-failed':'打开失败'} as any)[component.state] || (entity.id==='runtime'?phaseLabel[snapshot.phase]:'状态未确认') : '状态未知';
      const related=selectedNodes.includes(entity.id);
      const ports=links.flatMap((l:any)=>{if(l.source!==entity.id&&l.target!==entity.id)return [];if(complex&&['load','generate'].includes(l.key))return [l.source===entity.id?'bottom':'top'];return [l.source===entity.id?'right':'left'];});
      return <article key={entity.id} data-node={entity.id} style={{left:left+'%',top}} className={'pd-entity'+(related?selectedLink?' pd-related':' pd-selected':'')}>
        <button className="pd-entity-body" onClick={()=>onSelect(entity.id)} aria-label={'查看 '+entity.title+' 属性'} aria-pressed={related}><div className="pd-entity-title"><Glyph kind={entity.icon} size={25}/><strong>{entity.title}</strong></div><span className="pd-entity-role">{entity.role}</span><span className="pd-entity-file">{short(entity.path)||snapshot.project.name}</span><span className="pd-entity-state"><i className={connected&&component.state==='available'?'pd-dot good':'pd-dot'}/>{String(label||'状态未确认').replace(/会话/g,'运行实例')}</span></button>
        {(entity.tool||entity.hmi)&&<button className="pd-entity-open" disabled={!toolAllowed||busy} onClick={()=>onOpen(entity)} aria-label={'打开 '+entity.title} title={toolAllowed?'打开工程入口':snapshot?.capabilities?.reasons?.[entity.tool]||'当前状态不允许打开'}><Glyph kind="open" size={14}/></button>}
        {[...new Set(ports)].map((port:any)=><span key={port} className={'pd-port '+port}/>)}
      </article>;
    })}
  </div></div>;
}

export function App() {
  const [projectId, setProjectId] = useState(initialProject);
  const [projects, setProjects] = useState<any[]>([]), [snapshot, setSnapshot] = useState<any>(null), [connected, setConnected] = useState(false);
  const [statusError, setStatusError] = useState(''), [tasks, setTasks] = useState<any>(null), [taskError, setTaskError] = useState('');
  const [tab, setTab] = useState('status'), [selected, setSelected] = useState('plc'), [request, setRequest] = useState(''), [consent, setConsent] = useState(false);
  const [message, setMessage] = useState(''), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [pendingVersion, setPendingVersion] = useState(0);
  const [infoCollapsed,setInfoCollapsed]=useState(true),[infoHeight,setInfoHeight]=useState(250),[menu,setMenu]=useState(''),[environment,setEnvironment]=useState(false);
  const menuRoot=useRef<HTMLElement>(null),resizeStart=useRef<{y:number;height:number}|null>(null);
  const rootElement = useRef<HTMLElement>(null), [compact, setCompact] = useState(false);
  const gate = useRef(createReadGate()), pending = useRef(readPending(storage())), pendingBusy = useRef(new Set<string>()), activeRef = useRef<any>({ projectId, snapshot: null, connected: false }), client = useRef('dsh-' + crypto.randomUUID()), sequence = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; gate.current.select(''); }; }, []);
  useEffect(() => {
    const node = rootElement.current; if (!node) return;
    let previous: boolean | undefined;
    const resize = () => { const narrow = node.clientWidth < 760; setCompact(narrow); previous = narrow; };
    resize(); const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(menuRoot.current&&!menuRoot.current.contains(event.target as Node))setMenu('');};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenu('');setEnvironment(false);}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[]);
  useEffect(()=>{
    const select=(event:Event)=>{const id=(event as CustomEvent).detail?.projectId;if(typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id))switchProject(id);};
    window.addEventListener('plcdev:select-project',select);return()=>window.removeEventListener('plcdev:select-project',select);
  },[projects,projectId]);
  // Closing this panel only cancels reads. Runtime lifecycle belongs to the workbench service.
  useEffect(() => {
    gate.current.select(projectId); let disposed = false, statusTimer: any, taskTimer: any;
    setSnapshot(null); setConnected(false); setTasks(null); setStatusError(''); setTaskError(''); setMessage(''); setConsent(false); setRequest(''); setSelected('plc'); setBusy(false); setMenu(''); setInfoCollapsed(true);
    activeRef.current = { projectId, snapshot: null, connected: false };
    if (projectId) { try { storage().setItem(selectionKey, projectId); } catch {} }
    async function readStatus() {
      const ticket = gate.current.begin('status');
      try {
        const value = validateSnapshot(await api('status' + (projectId ? '?project=' + encodeURIComponent(projectId) : '')), projectId);
        if (disposed || !gate.current.accepts(ticket)) return;
        setProjects(value.projects); if (!projectId) { setProjectId(value.project.id); return; }
        setSnapshot(value); setConnected(true); setStatusError(''); activeRef.current = { projectId, snapshot: value, connected: true };
      } catch (error: any) {
        if (disposed || !gate.current.accepts(ticket)) return;
        setSnapshot(null); setConnected(false); setStatusError(error.name === 'AbortError' ? '后台响应超时。已停用入口操作。' : error.message); activeRef.current = { projectId, snapshot: null, connected: false };
      } finally { if (!disposed) statusTimer = setTimeout(readStatus, 1500); }
    }
    async function readTasks() {
      if (!projectId) return;
      const ticket = gate.current.begin('tasks');
      try {
        const value = validateTasks(await api('tasks?project=' + encodeURIComponent(projectId), undefined, 60000), projectId);
        if (disposed || !gate.current.accepts(ticket)) return;
        setTasks(value); setTaskError('');
      } catch (error: any) {
        if (disposed || !gate.current.accepts(ticket)) return;
        setTasks(null); setTaskError(error.name === 'AbortError' ? '任务查询超时，候选操作已停用。' : error.message);
      } finally { if (!disposed) taskTimer = setTimeout(readTasks, 3000); }
    }
    readStatus(); readTasks();
    return () => { disposed = true; clearTimeout(statusTimer); clearTimeout(taskTimer); };
  }, [projectId, refresh]);
  // Expire communication colours even while a status request is taking longer.
  const [, tick] = useState(0); useEffect(() => { const id = setInterval(() => tick(n => n + 1), 750); return () => clearInterval(id); }, []);

  function switchProject(id: string) {
    if (id === projectId) return;
    gate.current.select(id); activeRef.current = { projectId: id, snapshot: null, connected: false }; setSnapshot(null); setConnected(false); setTasks(null); setMessage(''); setProjectId(id);
  }
  async function openEntity(entity: any) {
    const context = activeRef.current, p = context.projectId, s = context.snapshot;
    if (busy || !context.connected || s?.project?.id !== p) return;
    const body: any = { projectId: p, sessionId: s.session?.id ?? s.sessionId ?? null, client: client.current, sequence: ++sequence.current, expires: Date.now() / 1000 + 12 };
    if (entity.tool) { if (!canUseTool(s, p, entity.tool, true)) return; body.action = 'tool'; body.tool = entity.tool; }
    else if (entity.hmi) { const cap = s.hmiOpen && !entity.fuxa ? 'canReconnectHmi' : 'canShowHmi'; if (!s.capabilities?.[cap]) return; body.action = entity.fuxa ? 'open-hmi' : s.hmiOpen ? 'reopen-hmi' : 'show-hmi'; }
    else return;
    const ticket = gate.current.begin('action');
    setBusy(true); setMessage('正在打开 ' + entity.title + '…');
    try {
      const result = await api('action', body, 30000); if (!result.ok) throw new Error('服务未确认入口打开结果。');
      if (alive.current && gate.current.accepts(ticket)) setMessage('已请求打开 ' + entity.title + '。进程存在不代表场景或 PLC 已运行。');
    } catch (error: any) { if (alive.current && gate.current.accepts(ticket)) setMessage(definitiveFailure(error) ? '未能打开：' + error.message : '打开结果尚未确认，请检查工具窗口。' + error.message); }
    finally { if (alive.current && gate.current.accepts(ticket)) setBusy(false); }
  }
  function savePending() { persistPending(storage(), pending.current); setPendingVersion(n => n + 1); }
  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    const context = activeRef.current, p = context.projectId;
    if (!context.connected || context.snapshot?.project?.id !== p || tasks?.projectId !== p || !tasks.projectRevision || pendingBusy.current.has(p)) return;
    let body = pending.current.get(p);
    try {
      if (!body) {
        if (!tasks.capabilities?.savedRevisionCandidate) return;
        body = makeCandidateRequest({ projectId: p, request, revision: tasks.projectRevision, consent, clientRequestId: crypto.randomUUID() });
        pending.current.set(p, body);
        try { savePending(); } catch { pending.current.delete(p); throw new Error('浏览器无法保存请求恢复记录，未发送任务。请允许此站点本地存储。'); }
      }
    } catch (error: any) { setMessage(error.message); return; }
    const ticket = gate.current.begin('create');
    pendingBusy.current.add(p); setPendingVersion(n => n + 1); setMessage('正在创建候选任务…');
    try {
      const result = await api('tasks', body, 65000);
      if (result.task?.projectId !== p || !result.task?.taskId) throw new Error('服务未确认同一工程的任务身份。');
      pending.current.delete(p); savePending();
      if (alive.current && gate.current.accepts(ticket)) { setConsent(false); setRequest(''); setMessage('候选任务已创建，原工程保持不变。'); setTasks(null); }
    } catch (error: any) {
      if (definitiveFailure(error)) { pending.current.delete(p); try { savePending(); } catch {} }
      if (alive.current && gate.current.accepts(ticket)) setMessage(definitiveFailure(error) ? '任务未创建：' + error.message : '提交结果尚未确认。请先核对列表；重试将沿用同一请求编号和原保存版本。');
    } finally { pendingBusy.current.delete(p); if (alive.current) setPendingVersion(n => n + 1); }
  }
  async function openCandidate(task: any) {
    const context = activeRef.current, p = context.projectId;
    if (!context.connected || tasks?.projectId !== p || !tasks.tasks.includes(task) || busy) return;
    const body = candidateIdentity(task, p); if (!body) return;
    const ticket = gate.current.begin('action');
    setBusy(true); setMessage('正在核对候选摘要并打开独立副本…');
    try {
      const result = await api('tasks/open', body, 65000);
      if (!result.ok || result.projectId !== p || result.taskId !== body.taskId || result.candidateDigest !== body.candidateDigest) throw new Error('候选打开身份未获确认。');
      if (alive.current && gate.current.accepts(ticket)) setMessage('已请求在 OpenPLC 打开该候选副本，请在编辑器中审阅。');
    } catch (error: any) { if (alive.current && gate.current.accepts(ticket)) setMessage(definitiveFailure(error) ? '候选未打开：' + error.message : '候选打开结果尚未确认，请先检查 OpenPLC 窗口再重试。'); }
    finally { if (alive.current && gate.current.accepts(ticket)) setBusy(false); }
  }

  const current = snapshot?.project || projects.find(p=>p.id===projectId), entities = graphEntities(snapshot);
  const detail:any = entities.find((n:any)=>n.id===selected), links=overviewLinks(snapshot), selectedLink=links.find((l:any)=>l.id===selected);
  const groups=overviewResources(snapshot,tasks), selectedCategory=groups.find((g:any)=>g.items.some((r:any)=>r.id===selected||r.nodes.includes(selected)));
  const selectedTask=tasks?.projectId===projectId?tasks.tasks.find((t:any)=>'task:'+t.taskId===selected):null;
  const waiting=pending.current.get(projectId),taskBusy=pendingBusy.current.has(projectId),readyTasks=connected&&tasks?.projectId===projectId;
  const session=snapshot?.session,otherSessions=snapshot?.otherSessions||[],taskCount=tasks?.projectId===projectId?tasks.tasks.length:null,externalOwner=externalRuntimeOwner(snapshot);
  const variables=monitoredVariables(snapshot,connected);
  const instanceLabel=connected ? session?.active ? snapshot.observerFresh?snapshot.state?.runtimeState||'状态未确认':'状态失效' : phaseLabel[snapshot?.phase]||'未创建' : '状态未知';
  function selectResource(id:string){setSelected(id);setMenu('');setTab(id.startsWith('task:')?'tasks':'status');setInfoCollapsed(false);}
  function requestConversation(){window.dispatchEvent(new CustomEvent('plcdev:open-conversation',{detail:{projectId}}));}
  function reviewTask(task:any){if(task.projectId!==projectId)return;selectResource('task:'+task.taskId);window.dispatchEvent(new CustomEvent('plcdev:review-task',{detail:{projectId,taskId:task.taskId}}));}
  return <section ref={rootElement} className={'pd-root pd-d2 '+(compact?'pd-compact':'')} data-pending-version={pendingVersion}><style>{styles}</style>
    <header className="pd-header"><div className="pd-project-control"><PlcdevIcon/><div><label htmlFor="plcdev-project-select">PLCdev · 当前工程</label><select id="plcdev-project-select" aria-label="选择工程" value={projectId} onChange={e=>switchProject(e.target.value)} disabled={!projects.length}>{!projects.some(p=>p.id===projectId)&&<option value={projectId}>{statusError?'工程读取失败':'正在读取工程清单…'}</option>}{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div><span className="pd-saved">{readyTasks?'保存版本 '+tasks.projectRevision.slice(0,8):'版本待确认'}</span></div><div className="pd-header-right"><span className={'pd-connection '+(connected?'good':'')}><i className={'pd-dot '+(connected?'good':'')}/>{connected?'后台已连接':statusError?'后台未连接':'正在连接'}</span><button onClick={()=>setRefresh(n=>n+1)} aria-label="刷新工程状态">刷新</button><button className="pd-primary" disabled={!connected||!projectId} onClick={requestConversation}>工程对话 ↗</button></div></header>
    <nav className="pd-resources" ref={menuRoot} aria-label="当前工程资源">{groups.map((group:any)=><div className="pd-resource-group" key={group.id}><button className={'pd-resource-trigger'+(selectedCategory?.id===group.id?' selected':'')} onClick={()=>setMenu(menu===group.id?'':group.id)} aria-expanded={menu===group.id} aria-controls={'pd-menu-'+group.id}><Glyph kind={group.icon} size={16}/>{group.label}<small>{group.items.length}</small><span>⌄</span></button>{menu===group.id&&<div className="pd-resource-menu" id={'pd-menu-'+group.id}><div className="pd-resource-caption">{current?.name||'未选择工程'} · {group.label}</div>{group.items.length?group.items.map((item:any)=><button key={item.id} data-resource={item.id} aria-pressed={selected===item.id} onClick={()=>selectResource(item.id)}><Glyph kind={item.icon} size={17}/><span><strong>{item.title}</strong><small>{item.description}</small></span></button>):<p>{!connected?'连接后台后读取资源。':group.id==='tasks'?'本工程暂无候选任务。':'此工程未关联这类资源。'}</p>}{group.id==='tasks'&&<button onClick={()=>{setTab('tasks');setMenu('');setInfoCollapsed(false);}}>查看任务与创建候选 →</button>}</div>}</div>)}<button className="pd-environment" onClick={()=>{setEnvironment(true);setMenu('');}}>开发环境</button></nav>
    <main className="pd-main">
      {statusError&&<div className="pd-alert" role="alert">{statusError}<button onClick={()=>switchProject('')}>重新读取工程清单</button></div>}
      {!!otherSessions.length&&connected&&<div className="pd-ownership">其他运行实例：{otherSessions.map((s:any)=><button key={s.projectId} onClick={()=>switchProject(s.projectId)}>{s.projectName||s.projectId} · {s.runtimeState||phaseLabel[s.phase]||'状态待确认'} ↗</button>)}<span>切换查看不停止它们</span></div>}
      {connected&&externalOwner&&!otherSessions.length&&<div className="pd-ownership">{runtimeOwnerLabel(externalOwner)}<span>{externalOwner.state==='unknown'?externalOwner.reason||'占用状态未确认，请检查本机服务。':'实例 '+String(externalOwner.sessionId||'身份待核对').slice(0,18)+' · 保持原归属'}</span></div>}
      <div className="pd-topology-label"><Glyph kind="link" size={17}/><strong>工程拓扑</strong><span>{snapshot?entities.length+' 个实例':'等待读取'}</span><div className="pd-runtime-chip"><i className="pd-dot"/>运行实例 · <strong>{instanceLabel}</strong></div></div>
      {snapshot?<Topology snapshot={snapshot} connected={connected} selected={selected} onSelect={selectResource} onOpen={openEntity} busy={busy}/>:<div className="pd-placeholder"><Glyph kind="runtime" size={38}/><strong>{statusError?'等待后台恢复连接':'正在读取工程拓扑'}</strong><p>只展示当前工程已关联的资源与实例。</p></div>}
      <section className={'pd-info'+(infoCollapsed?' collapsed':'')}>
        {!infoCollapsed&&<div className="pd-info-resizer" role="separator" aria-label="调整信息区高度" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={440} aria-valuenow={infoHeight} tabIndex={0} onPointerDown={e=>{resizeStart.current={y:e.clientY,height:infoHeight};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(resizeStart.current)setInfoHeight(Math.max(140,Math.min(440,resizeStart.current.height+resizeStart.current.y-e.clientY)));}} onPointerUp={e=>{resizeStart.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{resizeStart.current=null;}} onKeyDown={e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();setInfoHeight(height=>e.key==='Home'?140:e.key==='End'?440:Math.max(140,Math.min(440,height+(e.key==='ArrowUp'?20:-20))));}}}/>}
        <div className="pd-tabs" role="tablist" aria-label="工程信息">{[{id:'status',label:'属性',icon:'runtime'},{id:'variables',label:'变量监视',icon:'link'},{id:'logs',label:'日志与诊断',icon:'tasks'},{id:'tasks',label:'候选任务',icon:'tasks'}].map(item=><button key={item.id} id={'pd-tab-'+item.id} role="tab" aria-controls="pd-info-content" aria-selected={tab===item.id&&!infoCollapsed} onClick={()=>{setTab(item.id);setInfoCollapsed(false);}}><Glyph kind={item.icon} size={15}/>{item.label}{item.id==='tasks'&&typeof taskCount==='number'&&<span className="pd-count">{taskCount}</span>}</button>)}<span className="pd-tab-spacer"/><button aria-label={infoCollapsed?'展开信息区':'收起信息区'} onClick={()=>setInfoCollapsed(!infoCollapsed)}>{infoCollapsed?'展开 ↑':'收起 ↓'}</button></div>
        {!infoCollapsed&&<div className="pd-info-content" id="pd-info-content" role="tabpanel" aria-labelledby={'pd-tab-'+tab} style={{height:infoHeight}}>
          {message&&<p className="pd-message" role="status">{message}</p>}
          {tab==='tasks'?<div className="pd-task-layout"><form className="pd-task-form" onSubmit={createTask}><div className="pd-form-title"><strong>创建候选</strong><span className="pd-tag">M1 · 规则改名</span></div><p>将 PLC 变量 <code>Count</code> 改为 <code>BatchCount</code>，生成独立候选副本。</p><div className="pd-capability">模型生成：{tasks?.capabilities?.modelGeneration===true?'后台声明可用':'未接入'} · 不自动应用</div><label className="pd-field-label" htmlFor="plcdev-task-request">本工程修改要求</label><textarea id="plcdev-task-request" value={waiting?.request||request} onChange={e=>setRequest(e.target.value)} maxLength={4000} disabled={!!waiting||taskBusy||!readyTasks} placeholder="把 Count 改名为 BatchCount，生成候选供我审阅" rows={3}/><label className="pd-consent"><input type="checkbox" checked={waiting?waiting.sourceBasis==='saved_revision':consent} disabled={!!waiting||taskBusy||!readyTasks} onChange={e=>setConsent(e.target.checked)}/><span>使用当前已保存版本；不包含编辑器未保存的修改。</span></label><span className="pd-revision">{tasks?.projectRevision?'保存版本 '+tasks.projectRevision.slice(0,12):'保存版本尚未确认'}</span><button className="pd-primary" type="submit" disabled={!readyTasks||taskBusy||(!waiting&&(!tasks?.capabilities?.savedRevisionCandidate||!consent||!request.trim()))}>{taskBusy?'正在提交…':waiting?'使用原请求重试':'生成独立候选'}</button>{waiting&&<p className="pd-note warning">有一条结果未确认的请求，重试沿用原保存版本和请求编号。</p>}{taskError&&<p className="pd-note warning">{taskError}</p>}{tasks&&!tasks.capabilities?.savedRevisionCandidate&&<p className="pd-note">此工程暂不支持本批改名候选，可查看已有任务。</p>}</form><div className="pd-task-list"><div className="pd-form-title"><strong>本工程任务</strong><span>服务端持久保存</span></div>{!tasks?<p className="pd-empty-small">{taskError?'任务状态暂时无法确认。':'正在读取任务…'}</p>:!tasks.tasks.length?<p className="pd-empty-small">暂无候选任务。</p>:tasks.tasks.map((task:any)=><article key={task.taskId} className={'pd-task'+(selectedTask?.taskId===task.taskId?' selected':'')}><div className="pd-task-head"><strong>{taskStatus(task.status)}</strong><code>{String(task.taskId).slice(0,18)}…</code></div><p>{task.request}</p>{task.candidate?.summary&&<div className="pd-change"><code>{task.candidate.summary.before}</code><span>→</span><code>{task.candidate.summary.after}</code></div>}<small>{task.sourceBasis==='saved_revision'||task.candidate?.sourceBasis==='saved_revision'?'已保存版本 · ':''}{task.reason||task.message||task.completionScope||'候选任务'}{task.candidate?.candidateDigest&&' · 摘要 '+task.candidate.candidateDigest.slice(0,12)}</small><div className="pd-task-actions"><button disabled={!readyTasks} onClick={()=>reviewTask(task)}>查看任务详情</button>{candidateIdentity(task,projectId)&&<button disabled={!readyTasks||busy} onClick={()=>openCandidate(task)}>在 OpenPLC 打开候选 <Glyph kind="open" size={13}/></button>}</div></article>)}</div></div>:tab==='variables'?<><div className="pd-form-title"><strong>当前工程变量</strong><span>只读 · 数据失效时隐藏旧值</span></div>{variables.length?<table className="pd-variables"><thead><tr><th>实例路径</th><th>类型</th><th>值</th><th>数据质量</th></tr></thead><tbody>{variables.map((v:any)=><tr key={v.path}><td>{v.path}</td><td>{v.type}</td><td>{v.value}</td><td>{v.quality}</td></tr>)}</tbody></table>:<p className="pd-empty-small">当前后台尚未提供本工程的变量采样。运行实例和数据来源确认后显示。</p>}</>:tab==='logs'?<><div className="pd-form-title"><strong>当前工程诊断</strong><span>{connected?'来自本机后台':'后台未连接'}</span></div>{snapshot?.message&&<p>{snapshot.message}</p>}{statusError&&<p className="pd-note warning">{statusError}</p>}{taskError&&<p className="pd-note warning">{taskError}</p>}{snapshot?.failure&&<p className="pd-note warning">{displayValue(snapshot.failure)}</p>}<ul className="pd-events">{(snapshot?.events||[]).slice(-20).reverse().map((event:any,i:number)=><li key={i}><time>{typeof event.at==='number'?new Date(event.at*1000).toLocaleTimeString():'—'}</time><span>{event.message||displayValue(event)}</span></li>)}</ul>{!snapshot?.events?.length&&<p className="pd-empty-small">暂无后台事件。</p>}</>:<div className="pd-detail-grid"><div><span className="pd-eyebrow">{selectedLink?'所选链路':'所选实例'}</span><h2>{selectedLink?.title||detail?.title||'当前工程'}</h2><dl><dt>{selectedLink?'连接双方':'关联文件／目标'}</dt><dd className="pd-path">{selectedLink?selectedLink.nodes.map((id:string)=>entities.find((n:any)=>n.id===id)?.title||id).join(' ↔ '):displayValue(detail?.path||current?.manifestPath||'未读取')}</dd><dt>所属工程</dt><dd>{current?.name||'未读取'}</dd><dt>工程身份</dt><dd className="pd-path">{projectId||'未读取'}</dd>{selectedLink?<><dt>状态</dt><dd>{overviewConnection(snapshot,selectedLink.key,connected).label}</dd><dt>协议</dt><dd>{selectedLink.details?.protocol||(['load','generate'].includes(selectedLink.key)?'文件交付':'未声明')}</dd><dt>端点</dt><dd className="pd-path">{selectedLink.details?.endpoint||'未声明'}</dd></>:<><dt>入口状态</dt><dd>{connected?detail?.component?.label||'尚未核验':'状态未知'}</dd><dt>工具模式</dt><dd>{current?.defaultMode||current?.kind||'未读取'}</dd></>}</dl>{detail&&(detail.tool||detail.hmi)&&<button disabled={busy||!connected||(detail.tool?!canUseTool(snapshot,projectId,detail.tool,connected):!snapshot?.capabilities?.[snapshot?.hmiOpen&&!detail.fuxa?'canReconnectHmi':'canShowHmi'])} onClick={()=>openEntity(detail)}>打开 {detail.title}<Glyph kind="open" size={13}/></button>}</div><div><span className="pd-eyebrow">独立运行实例</span><h2>{instanceLabel}</h2><dl><dt>实例编号</dt><dd className="pd-path">{session?.id||'未创建'}</dd><dt>执行目标</dt><dd>{session?.target||current?.target||'未确认'}</dd><dt>装载产物</dt><dd className="pd-path">{session?.programHash||'尚无装载记录'}</dd></dl><p className="pd-note">工程查看、DSH 对话与运行实例分别管理。关闭此页或切换工程不会发送运行／停止命令。</p></div></div>}
        </div>}
      </section>
    </main><footer className="pd-footer"><span>{current?.name||projectId||'PLCdev'}{current?.manifestPath?' · '+short(current.manifestPath):''}</span><span>当前工程资源 · 独立任务与运行实例</span></footer>
    {environment&&<div className="pd-environment-backdrop" onClick={e=>{if(e.target===e.currentTarget)setEnvironment(false);}}><section className="pd-environment-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-environment-title"><header><div><h2 id="pd-environment-title">开发环境</h2><p>{current?.name||'当前工程'} · 本机依赖检查</p></div><button autoFocus aria-label="关闭开发环境" onClick={()=>setEnvironment(false)}>×</button></header>{snapshot?.dependencies?.length?<ul>{snapshot.dependencies.map((dependency:any)=><li key={dependency.id}><span>{dependency.label||dependency.id}</span><strong>{dependency.available===true?'可用':dependency.available===false?'缺失':'未确认'}</strong><small>{dependency.path}</small></li>)}</ul>:<p>后台尚未提供依赖检查结果。</p>}<p className="pd-note">安装可用、窗口已打开、工程已关联和运行通信是不同状态。</p></section></div>}
  </section>;
}
