import {BrandTitle} from './Brand';
import React, {useEffect, useState, useRef, useMemo} from 'react';
import {filterProjects, projectLocation, projectModifiedLabel} from './project-list.mjs';
import {useConversationContext} from './useConversationContext';
import {conversationApi} from './conversation-client.mjs';
import {bindingBlockedReason} from './conversation-context.mjs';
import {BackendConnection} from './BackendConnection';
import {ProjectOperations} from './ProjectOperations';

const projectListStyles=`
.pc-project-list,.pc-project-picker{--pc-text:var(--dsw-alias-label-primary,#263242);--pc-muted:var(--dsw-alias-label-secondary,#647184);--pc-border:var(--dsw-alias-border-l2,#dfe4eb);--pc-surface:var(--dsw-alias-bg-base,#fff);--pc-subtle:var(--dsw-alias-bg-module-platform,#f5f7fa);--pc-accent:var(--plcdev-accent);color:var(--pc-text);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:1.5;box-sizing:border-box}
.pc-project-list *,.pc-project-picker *{box-sizing:border-box}
.pc-project-list{display:grid;gap:16px;width:100%;max-width:1120px;min-width:0;container:project-list / inline-size}
.pc-project-search{display:grid;gap:8px;color:var(--pc-muted);font-size:13px;font-weight:500}
.pc-project-search-field{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;background:var(--pc-surface);border:1px solid var(--pc-border);border-radius:8px}
.pc-project-search-field:focus-within{border-color:var(--pc-accent);outline:2px solid color-mix(in srgb,var(--pc-accent) 16%,transparent);outline-offset:1px}
.pc-project-search-field svg{flex-shrink:0}
.pc-project-search-field input{min-width:0;width:100%;height:100%;padding:0!important;border:0!important;border-radius:0;background:transparent!important;color:var(--pc-text);font:inherit;outline:none!important;box-shadow:none!important}
.pc-project-filters{display:grid;grid-template-columns:minmax(180px,1fr) 150px 150px;align-items:end;gap:12px}
.pc-project-filter{display:grid;gap:8px;font-size:13px;color:var(--pc-muted)}
.pc-project-filter select{width:100%;min-width:0;height:40px;padding:0 10px;border:1px solid var(--pc-border);border-radius:8px;background:var(--pc-surface);color:var(--pc-text);font:inherit;box-sizing:border-box}
.pc-project-filter select:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.pc-project-match-count{font-size:12px;color:var(--pc-muted);margin:0}
@container project-list (max-width:640px){.pc-project-filters{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.pc-project-search{grid-column:1/-1}}
.pc-project-rows{border:1px solid var(--pc-border);border-radius:12px;background:var(--pc-surface);overflow:hidden}
.pc-project-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:16px;padding:16px 24px;align-items:center}
.pc-project-row+.pc-project-row{border-top:1px solid var(--pc-border)}
.pc-project-icon{display:flex;align-items:center;justify-content:center;align-self:start;width:40px;height:40px;border:1px solid color-mix(in srgb,var(--pc-accent) 16%,var(--pc-border));border-radius:10px;background:color-mix(in srgb,var(--pc-accent) 7%,var(--pc-surface));color:var(--pc-accent)}
.pc-project-info{display:grid;gap:8px;min-width:0;overflow-wrap:anywhere}
.pc-project-name{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pc-project-name strong{font-size:15px;font-weight:600;letter-spacing:.01em}
.pc-project-current{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border-radius:5px;background:color-mix(in srgb,var(--pc-accent) 10%,var(--pc-surface));color:var(--pc-text);font-size:12px;line-height:20px}
.pc-project-location{color:var(--pc-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.pc-project-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;color:var(--pc-muted);font-size:12px}
.pc-project-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pc-project-tool{display:inline-flex;max-width:100%;align-items:center;gap:5px;padding:2px 7px;border:1px solid var(--pc-border);border-radius:5px;background:var(--pc-subtle);font-size:11px;line-height:18px}
.pc-project-tool svg{flex-shrink:0}
.pc-project-runtime{display:inline-flex;align-items:center;gap:6px}
.pc-project-runtime:before{content:'';width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--pc-muted)}
.pc-project-list .pc-project-select,.pc-project-list .pc-project-page-button,.pc-project-picker .pc-project-picker-button{display:inline-flex;justify-content:center;align-items:center;min-height:36px;padding:7px 12px;border:1px solid var(--pc-border);border-radius:7px;background:var(--pc-surface);color:var(--pc-text);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:normal;text-align:center}
.pc-project-list .pc-project-select{background:var(--pc-accent);border-color:var(--pc-accent);color:var(--plcdev-on-accent);white-space:nowrap}
.pc-project-list button:hover:not(:disabled),.pc-project-picker .pc-project-picker-button:hover:not(:disabled){background:var(--pc-subtle);filter:brightness(.97);border-color:var(--pc-accent)}
.pc-project-list .pc-project-select:hover:not(:disabled){background:var(--pc-accent);color:var(--plcdev-on-accent)}
.pc-project-list button:focus-visible,.pc-project-picker .pc-project-picker-button:focus-visible{outline:2px solid var(--pc-accent);outline-offset:3px}
.pc-project-list button:disabled,.pc-project-picker .pc-project-picker-button:disabled{cursor:default;opacity:.48}
.pc-project-row[data-current="true"] .pc-project-select:disabled{background:var(--pc-subtle);border-color:var(--pc-border);color:var(--pc-muted);opacity:1}
.pc-project-pagination{display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:12px;color:var(--pc-muted);font-size:12px}
.pc-project-empty{margin:0;padding:40px 24px;text-align:center;color:var(--pc-muted)}
.pc-project-picker{height:100%;overflow:auto;padding:24px;background:var(--pc-subtle)}
.pc-project-picker-content{width:100%;max-width:1120px;margin:0 auto;display:grid;gap:24px}
.pc-project-picker .pc-project-picker-back{justify-self:start;min-height:32px;padding:4px 0;border-color:transparent;background:transparent;color:var(--pc-muted)}
.pc-project-picker-heading{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.pc-project-picker h1{margin:0;font-size:20px;font-weight:600;line-height:1.4;letter-spacing:-.02em}
.pc-project-picker-notice{margin:0;padding:12px 16px;border:1px solid var(--pc-border);border-left:3px solid var(--pc-accent);border-radius:8px;background:var(--pc-surface);font-size:13px;overflow-wrap:anywhere}
@media(max-width:640px){.pc-project-row{grid-template-columns:32px minmax(0,1fr);gap:12px;padding:16px}.pc-project-icon{width:32px;height:32px;border-radius:8px}.pc-project-icon svg{width:19px;height:19px}.pc-project-row .pc-project-select{grid-column:2;justify-self:start;white-space:normal}.pc-project-name strong{font-size:14px}.pc-project-meta{gap:8px 12px}.pc-project-pagination{justify-content:space-between;gap:8px}}
@media(max-width:560px){.pc-project-picker{padding:16px}.pc-project-picker-content{gap:16px}.pc-project-picker h1{font-size:18px}}
`;
function ProjectCount({id}:any){
  const [count,setCount]=useState<number|null>(null);
  useEffect(()=>{let stopped=false,timer:any;async function read(){try{const data=await conversationApi('conversations/project?projectId='+encodeURIComponent(id));if(!stopped)setCount(data?.projectId===id&&data.countsComplete===true&&Array.isArray(data.current)?data.current.length:null);}catch{if(!stopped)setCount(null);}finally{if(!stopped)timer=setTimeout(read,15000);}}read();return()=>{stopped=true;clearTimeout(timer);};},[id]);
  return <span className="pc-project-count">关联会话数：{count===null?'未确认':count}</span>;
}
export function ProjectList({projects,currentId,action,onChoose,disabled}:any){
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[tool,setTool]=useState('all'),[sort,setSort]=useState('modified');
  const search=useRef<HTMLInputElement>(null);useEffect(()=>{search.current?.focus({preventScroll:true});},[]);
  const filtered=useMemo(()=>filterProjects(projects,query,{tool,sort}),[projects,query,tool,sort]), pages=Math.max(1,Math.ceil(filtered.length/5)), currentPage=Math.min(page,pages-1);
  return <div className="pc-project-list">
    <style>{projectListStyles}</style>
    <div className="pc-project-filters"><label className="pc-project-search">搜索工程名称或路径
      <span className="pc-project-search-field"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input ref={search} aria-label="搜索工程名称或路径" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></span>
    </label><label className="pc-project-filter">工程内容<select aria-label="筛选工程内容" value={tool} onChange={e=>{setTool(e.target.value);setPage(0);}}><option value="all">全部工程</option><option value="plc">含 PLC 程序</option><option value="hmi">含 HMI 画面</option><option value="scene">含仿真场景</option></select></label><label className="pc-project-filter">排序<select aria-label="工程排序" value={sort} onChange={e=>{setSort(e.target.value);setPage(0);}}><option value="modified">最近修改</option><option value="name">工程名称</option></select></label></div>
    <p className="pc-project-match-count">{query||tool!=='all'?`${filtered.length} / ${projects?.length||0} 个工程`:`${filtered.length} 个工程`}</p>
    <div className="pc-project-rows">
      {filtered.slice(currentPage*5,currentPage*5+5).map((p:any)=><article key={p.id} className="pc-project-row" data-current={p.id===currentId}>
        <span className="pc-project-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/><path d="M3 10h18M9 14h6M12 12v5"/></svg></span>
        <div className="pc-project-info">
          <div className="pc-project-name"><strong>{p.name||'工程名称未提供'}</strong>{p.id===currentId&&<span className="pc-project-current plcdev-selected">{action==='用于当前对话'?'当前关联':'当前查看'}</span>}</div>
          <div className="pc-project-location">{projectLocation(p)}</div>
          <div className="pc-project-meta">
            <span className="pc-project-tools">{Array.isArray(p.toolchain)?p.toolchain.length?p.toolchain.map((tool:any,i:number)=><span key={i} className="pc-project-tool"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1" y="2" width="10" height="8" rx="1"/><path d="M3 5h6M3 7h4"/></svg><span>{tool.role||'资源'} {tool.name||'工具未提供'}</span></span>):'工具链未配置':'工具链未提供'}</span>
            <ProjectCount id={p.id}/>
            <span className="pc-project-modified" title="已保存工程文件的最近修改时间">{projectModifiedLabel(p)}</span>
            {p.runtimeStatus&&<span className="pc-project-runtime">上次运行状态：{({RUNNING:'运行中',RUN:'运行中',STOPPED:'已停止',STOP:'已停止',unknown:'状态未确认'} as any)[p.runtimeStatus]||'状态未确认'}</span>}
          </div>
        </div>
        <button className="pc-project-select" disabled={disabled||action==='用于当前对话'&&p.id===currentId} onClick={()=>onChoose(p.id)}>{action}</button>
      </article>)}
      {!filtered.length&&<p className="pc-project-empty">{query||tool!=='all'?'没有匹配的工程。':'工程清单为空或尚未读取。'}</p>}
    </div>
    {pages>1&&<nav className="pc-project-pagination" aria-label="工程分页"><button className="pc-project-page-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pages}</span><button className="pc-project-page-button" disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}>下一页</button></nav>}
  </div>;
}
export function ConversationProjectPicker({contexts,sessionId,onReturn,snapshot,connected,onToolDownloads}:any){
  const state=useConversationContext(contexts,sessionId), binding=state.binding;
  const [creationNotice,setCreationNotice]=useState('');
  const scope=useMemo(()=>({sessionId}),[sessionId]),currentScope=useRef(scope);currentScope.current=scope;
  useEffect(()=>state.controller.subscribeDirectory?.(),[state.controller]);
  const epoch=useRef(0),currentSession=useRef(sessionId);currentSession.current=sessionId;
  useEffect(()=>{epoch.current++;setCreationNotice('');return()=>{epoch.current++;};},[sessionId]);
  const reason=bindingBlockedReason(state),blocked=!!reason;
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')onReturn();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[onReturn]);
  async function choose(id:string){
    if(currentScope.current!==scope||currentSession.current!==sessionId)return;
    const current=state.controller.snapshot();if(bindingBlockedReason(current)||id===current.binding?.projectId)return;
    const ticket=epoch.current;
    try{await state.controller.bind(id);if(ticket===epoch.current&&currentSession.current===sessionId&&state.controller.snapshot().binding?.projectId===id)onReturn();}
    catch{if(ticket===epoch.current&&currentSession.current===sessionId)setCreationNotice('工程关联未确认，请重新读取后选择。');}
  }
  async function created(result:any){
    if(currentScope.current!==scope||currentSession.current!==sessionId)return;
    const current=state.controller.snapshot();
    if(current.binding?.version!==binding?.version||current.binding?.projectId!==binding?.projectId){setCreationNotice('工程已创建；当前对话关联已变化，请重新选择要使用的工程。');return;}
    await choose(result.projectId);
  }
  return <section className="pc-project-picker plcdev-scope" aria-label="选择当前对话工程">
    <div className="pc-project-picker-content">
      <button className="pc-project-picker-button pc-project-picker-back" onClick={onReturn}>← 返回对话</button>
      <header className="pc-project-picker-heading"><h1><BrandTitle>选择当前对话工程</BrandTitle></h1><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{onToolDownloads&&<button className="pc-project-picker-button" onClick={onToolDownloads}>工具下载与安装</button>}<button className="pc-project-picker-button" onClick={()=>state.controller.refresh()}>重新读取</button></div></header>
      {binding?.revisionContext&&binding.revisionContext.state!=='submitted'&&<p className="pc-project-picker-notice" role="status">切换后原修订仍保留但不能直接继续；如需修改，请取消并重新选择候选。候选与输入草稿保留。</p>}
      {blocked&&<p className="pc-project-picker-notice" role="status">{reason}</p>}
      {state.error&&!blocked&&<p className="pc-project-picker-notice" role="alert">{state.error}</p>}
      {creationNotice&&<p className="pc-project-picker-notice" role="status">{creationNotice}</p>}
      {state.backendDisconnected&&<BackendConnection onConnected={()=>state.controller.refresh({preserveActionError:true})}/>}
      <ProjectOperations mode="catalog" snapshot={snapshot} connected={connected&&!blocked} context="conversation" contextId={sessionId} onChanged={created}/>
      <ProjectList projects={state.projects} currentId={binding?.projectId} action="用于当前对话" onChoose={choose} disabled={blocked}/>
    </div>
  </section>;
}
