import React,{useId,useState} from 'react';
import {candidateOperationGroups} from './candidate-operations.mjs';
import {ResultPreviewButton} from './ResultPreview';
import {nativeCheckLabel} from '../native-tool-evidence.mjs';
import {ToolLogo} from './ToolLogo';

export const operationCardCss=`
.pc-operation-mark:has(img){background:transparent;border-radius:0}
.pc-operation-cards{display:grid;gap:8px;margin:10px 0}.pc-operation-card{border:1px solid var(--pc-line);border-radius:9px;overflow:hidden;min-width:0;background:var(--pc-surface)}.pc-operation-head{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;padding:6px 10px 6px 5px}:is(.pc-tool-card,.pc-review) .pc-operation-toggle{display:flex;flex:1 1 230px;align-items:center;gap:8px;min-width:0;min-height:34px;background:transparent;border:0;padding:5px 7px;text-align:left}.pc-operation-toggle strong{font-size:13px;white-space:nowrap}.pc-operation-count{font-size:11px;color:var(--pc-sub);font-weight:400;overflow-wrap:anywhere}.pc-operation-chevron{display:inline-block;font-size:18px;color:var(--pc-sub);transform:rotate(0)}.pc-operation-toggle[aria-expanded=true] .pc-operation-chevron{transform:rotate(90deg)}.pc-operation-mark{flex-shrink:0;display:grid;place-items:center;font-size:9px;font-weight:600;width:25px;height:25px;border-radius:5px;background:var(--pc-canvas);color:var(--pc-sub)}.pc-operation-links{display:flex;flex:0 1 auto;max-width:100%;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}:is(.pc-tool-card,.pc-review) .pc-operation-links button{min-height:30px;font-size:11px;padding:4px 5px;background:transparent;border:0;color:var(--pc-accent)}.pc-operation-content{padding:10px 13px;border-top:1px solid var(--pc-line);background:var(--pc-canvas);max-height:300px;overflow:auto;scrollbar-width:thin;font-size:12px}.pc-operation-content ul{margin:0;padding-left:18px}.pc-operation-content li{margin:3px 0;overflow-wrap:anywhere}.pc-operation-files{margin-top:8px!important}.pc-operation-files li{display:flex;gap:9px;align-items:baseline}.pc-operation-files span{font-size:10px;flex-shrink:0;color:var(--pc-sub)}.pc-operation-files code{font-size:11px;overflow-wrap:anywhere}.pc-operation-links [aria-disabled=true]{color:var(--pc-sub)}
`;

export function ResultOperationCards({task,conversationId,onOpenTool,busy=false,openReason,toolSync}:any){
  const groups=candidateOperationGroups(task),prefix=useId();
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  return <div className="pc-operation-cards"><style>{operationCardCss}</style>{groups.length?groups.map((group:any)=>{
    const id=prefix+'-'+group.tool,open=expanded.has(group.tool),reason=openReason?.(group.tool)||'',sync=toolSync?.[group.tool];
    return <article className="pc-operation-card" key={group.tool} data-result-tool={group.tool}>
      <div className="pc-operation-head"><button className="pc-operation-toggle plcdev-tab" id={id+'-toggle'} aria-expanded={open} aria-controls={id} onClick={()=>setExpanded(previous=>{const next=new Set(previous);next.has(group.tool)?next.delete(group.tool):next.add(group.tool);return next;})}><span className="pc-operation-chevron" aria-hidden="true">›</span><span className="pc-operation-mark" aria-hidden="true">{group.tool==='project'?group.mark:<ToolLogo tool={group.tool} size={24}/>}</span><strong>{group.name}</strong><span className="pc-operation-count">{group.countLabel}</span></button>
        <div className="pc-operation-links">{task.workflow==='project-edit-v1'&&task.candidate?.candidateDigest&&group.tool!=='project'&&<ResultPreviewButton conversationId={conversationId} task={task} tool={group.tool}/>} {group.tool!=='project'&&onOpenTool&&<button className="plcdev-link" disabled={busy||!!reason} title={reason||undefined} aria-label={'在 '+group.name+' 查看'+(reason?'：'+reason:'')} onClick={()=>onOpenTool(group.tool)}>在 {group.name} 查看</button>}</div>
      </div>
      {(group.checkLabel||sync)&&<div className="pc-operation-status" style={{display:'flex',gap:'4px 12px',flexWrap:'wrap',padding:'0 13px 7px',fontSize:11,color:'var(--pc-sub)'}}>{group.checkLabel&&<span>{group.checkLabel}</span>}{sync&&<span role="status" data-tool-sync={sync.state} title={sync.message}>{sync.label}</span>}{sync?.message&&sync.state!=='synced'&&<span>{sync.message}</span>}</div>}
      <div id={id} className="pc-operation-content" role="region" aria-labelledby={id+'-toggle'} hidden={!open}>
        {!!group.operations.length?<ul aria-label="原生操作汇总">{group.operations.map((operation:any,index:number)=><li key={index}>{operation.summary}</li>)}</ul>:!!group.summaries.length&&<ul>{group.summaries.map((summary:string,index:number)=><li key={index}>{summary}</li>)}</ul>}
        {!!group.checks.length&&<div style={{marginTop:8}}><strong>原生检查</strong><ul>{group.checks.map((check:any,index:number)=><li key={check.id+index} data-check-status={check.status}>{check.label}：{nativeCheckLabel(check.status)}{check.summary&&' · '+check.summary}</li>)}</ul><p className="pc-muted">对应这份候选；未验证仿真运行或外部 PLC 通信。</p></div>}
        {!!group.files.length&&<ul className="pc-operation-files">{group.files.map((file:any)=><li key={file.path}><span>{file.kind}</span><code>{file.path}</code></li>)}</ul>}
        {!group.filesKnown&&<p className="pc-muted">文件差异尚未提供。</p>}
      </div>
    </article>;
  }):<p className="pc-muted">{task.status==='no_change'?'没有待保留的文件变化。':'暂无可核对的工具产物。'}</p>}</div>;
}
