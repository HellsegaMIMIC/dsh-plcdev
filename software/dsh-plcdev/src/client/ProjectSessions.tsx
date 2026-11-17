import React,{useEffect,useRef,useState} from 'react';
import {conversationApi} from './conversation-client.mjs';
import {taskStatus} from './model.mjs';
import {hostSessionTitle, revisionGroups, validateProjectConversations} from './project-sessions.mjs';

export function ProjectSessions({projectId,tasks,hostSessions,openSession,onReview,onCreateSession}:any){
  const abort=useRef<AbortController|null>(null);const [navigating,setNavigating]=useState(false);
  useEffect(()=>{const current=new AbortController();abort.current=current;setNavigating(false);return()=>current.abort();},[projectId]);
  const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[catalog,setCatalog]=useState<any>(null);
  useEffect(()=>{let done=false,timer:any;setResult(null);setError('');async function read(){try{const value=validateProjectConversations(await conversationApi('conversations/project?projectId='+encodeURIComponent(projectId)),projectId);if(!done){setResult(value);setError('');}}catch(e:any){if(!done){setResult(null);setError(e.message||'关联会话读取失败。');}}finally{if(!done)timer=setTimeout(read,5000);}}if(projectId)read();return()=>{done=true;clearTimeout(timer);};},[projectId,refresh]);
  useEffect(()=>{let offList=()=>{};function update(){offList();const service=hostSessions?.get?.();const list=service?.list;if(!list?.getSnapshot||!list?.subscribe){setCatalog(null);return;}const read=()=>setCatalog(list.getSnapshot());read();offList=list.subscribe(read);}update();const offService=hostSessions?.subscribe?.(update)||(()=>{});return()=>{offList();offService();};},[hostSessions]);
  async function navigate(sessionId:string,taskId?:string){if(navigating||!openSession)return;const signal=abort.current?.signal;setNavigating(true);try{const out=await openSession({projectId,sessionId,...(taskId?{taskId}:{}),signal});if(!out.ok){if(out.dispatched)window.alert(out.message||'会话跳转结果未确认。');else if(!signal?.aborted)setError(out.message||'会话跳转结果未确认。');}}catch(e:any){if(!signal?.aborted)setError(e?.message||'会话跳转结果未确认。');}finally{if(!signal?.aborted)setNavigating(false);}}
  const rows=result?.projectId===projectId?result:null;
  const available=tasks?.projectId===projectId&&Array.isArray(tasks.tasks)?tasks.tasks:null;
  function list(entries:any[],historical:boolean){return entries.map((row:any)=>{
    const groups=available?revisionGroups(row.taskIds,available,projectId):[];
    const missing=available?row.taskIds.filter((id:string)=>!available.some((t:any)=>t.taskId===id)):row.taskIds;
    const pending=groups.filter((g:any[])=>g[g.length-1]?.status==='awaiting_review').length;
    const dated=groups.map((g:any[])=>g[g.length-1]).filter((t:any)=>typeof t.updatedAt==='number'&&Number.isFinite(t.updatedAt)).sort((a:any,b:any)=>b.updatedAt-a.updatedAt);
    const latest=dated[0];
    const listed=catalog?.phase==='ready'&&Array.isArray(catalog.ids)&&catalog.ids.includes(row.conversationId)&&catalog.byId?.[row.conversationId]&&catalog.byId[row.conversationId].origin!=='subagent';
    return <article key={row.conversationId} className="pc-session-card">
      <div className="pc-session-heading" data-session-summary><div><strong>{hostSessionTitle(catalog,row.conversationId)||'会话标题未提供'}</strong><p className="pc-session-state">{historical?'历史关联 · ':''}{available?(missing.length?`已读取待审阅 ${pending} 项，部分任务状态未确认`:pending?`待审阅 ${pending} 项`:row.taskIds.length?`${groups.length} 项修改方案`:'暂无修改'):'任务状态未确认'}</p></div><button disabled={navigating||!openSession||!listed} onClick={()=>navigate(row.conversationId)}>打开会话</button></div>
      {latest&&<div className="pc-session-latest"><p>{latest.request||'需求未提供'}</p><small>最近更新 · <time>{new Date(latest.updatedAt*1000).toLocaleString()}</time></small></div>}
      {!listed&&<p className="pc-session-unavailable">宿主会话尚未确认可访问。</p>}
      {!!row.taskIds.length&&<details><summary>查看修改方案（{available?groups.length:'未确认'}）</summary>
        {groups.map((chain:any[])=>{const latest=chain[chain.length-1];return <section key={latest.taskId} style={{borderTop:'1px solid var(--pd-line)',padding:'8px 0'}}><strong>{taskStatus(latest.status)}</strong><p>{typeof latest.request==='string'&&latest.request.trim()?latest.request:'需求未提供'}</p>{chain.length>1&&<details><summary>修订过程（{chain.length} 次）</summary>{chain.map((task:any)=><p key={task.taskId}>{task.request||'需求未提供'} · {taskStatus(task.status)}</p>)}</details>}<button disabled={navigating||(!onReview&&!openSession)||!listed} onClick={()=>onReview?onReview({projectId,sessionId:row.conversationId,taskId:latest.taskId}):navigate(row.conversationId,latest.taskId)}>{latest.status==='awaiting_review'?(onReview?'审阅修改':'在所属会话审阅'):(onReview?'查看修改':'在所属会话查看')}</button></section>;})}
        {!!missing.length&&<p>有 {missing.length} 项任务尚无法读取，状态未确认。</p>}
      </details>}
      <details className="pc-session-identity"><summary>会话信息</summary><dl><dt>关联方式</dt><dd>{historical?'曾产生本工程任务，当前已切换工程':'当前绑定此工程'}</dd><dt>会话编号</dt><dd>{row.conversationId}</dd>{historical&&<><dt>当前工程编号</dt><dd>{row.currentProjectId||'未绑定工程'}</dd></>}</dl></details>
    </article>;
  });}
  return <section className="pc-project-sessions" aria-label="工程关联会话">
    <style>{`
.pc-project-sessions{--ss-line:var(--dsw-alias-border-l2,#dfe5ec);--ss-muted:var(--dsw-alias-label-secondary,#657184);--ss-soft:var(--dsw-alias-bg-module-platform,#f4f6f9);min-width:0;border:1px solid var(--ss-line);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#243247);font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);overflow-wrap:anywhere;container-type:inline-size}
.pc-project-sessions>p{margin:0;padding:18px 24px;font-size:13px;color:var(--ss-muted)}.pc-project-sessions .pc-session-card{padding:24px;border-top:1px solid var(--ss-line)}.pc-project-sessions .pc-session-heading{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}.pc-project-sessions .pc-session-heading>div{min-width:0;flex:1 1 160px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.pc-project-sessions .pc-session-heading strong{font-size:15px;font-weight:600}.pc-project-sessions button{font:inherit;font-size:13px;min-height:36px;padding:6px 12px;border:1px solid var(--ss-line);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;cursor:pointer}.pc-project-sessions button:hover:not(:disabled){background:var(--ss-soft)}.pc-project-sessions button:disabled{opacity:.46;cursor:default}.pc-project-sessions :is(button,summary):focus-visible{outline:2px solid var(--plcdev-accent,#7653bc);outline-offset:3px}.pc-project-sessions .pc-session-heading>button{flex-shrink:0}.pc-project-sessions .pc-session-state{margin:0;font-size:12px;color:var(--ss-muted);border:1px solid var(--ss-line);border-radius:6px;padding:2px 7px;background:var(--ss-soft)}.pc-project-sessions .pc-session-latest{margin:10px 0 16px}.pc-project-sessions .pc-session-latest p{margin:0 0 6px}.pc-project-sessions .pc-session-latest small{font-size:12px;color:var(--ss-muted)}.pc-project-sessions summary{padding:6px 0;cursor:pointer;font-size:13px}.pc-project-sessions .pc-session-identity summary{font-size:12px;color:var(--ss-muted)}.pc-project-sessions .pc-session-card details[open]{margin-top:8px}.pc-project-sessions dl{display:grid;grid-template-columns:6em minmax(0,1fr);gap:8px;margin:12px 0;font-size:12px}.pc-project-sessions dt{color:var(--ss-muted)}.pc-project-sessions dd{margin:0}.pc-project-sessions .pc-session-unavailable{font-size:12px;color:var(--ss-muted);margin:8px 0}.pc-project-sessions>details{padding:16px 24px;border-top:1px solid var(--ss-line)}.pc-project-sessions>details>.pc-session-card{margin-top:12px;padding:16px 0}
@container(max-width:540px){.pc-project-sessions .pc-session-card{padding:18px 16px}.pc-project-sessions>p,.pc-project-sessions>details{padding:16px}.pc-project-sessions .pc-session-heading>div{flex-basis:100%}.pc-project-sessions .pc-session-heading{gap:10px}}

.pc-project-sessions summary{list-style:none;display:flex;align-items:center;gap:10px}.pc-project-sessions summary::-webkit-details-marker{display:none}.pc-project-sessions summary:before{content:'';display:inline-block;width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);margin-right:2px}.pc-project-sessions details[open]>summary:before{transform:rotate(135deg)}
`}</style>
    {onCreateSession&&<p><button onClick={onCreateSession}>新建工程会话</button></p>}
    {error&&<p role="alert">{error} <button onClick={()=>setRefresh(n=>n+1)}>重新读取</button></p>}
    {!rows&&!error&&<p>正在读取关联会话…</p>}
    {rows&&<><p>{rows.countsComplete?`当前关联 ${rows.current.length} 个会话`:'关联数量未完全确认'}{rows.unavailable.length?'；部分会话身份不可访问或无法确认。':''}</p>{list(rows.current,false)}{!rows.current.length&&<p>没有可确认的当前关联会话。</p>}{!!rows.historical.length&&<details><summary>曾产生本工程任务的会话（{rows.historical.length}）</summary>{list(rows.historical,true)}</details>}</>}
  </section>;
}
