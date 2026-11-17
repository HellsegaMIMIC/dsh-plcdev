import React,{useEffect,useState} from 'react';
import {conversationApi as api} from './conversation-client.mjs';
import {previewUrl,validateResultPreview,textDiff,ladderDeclarations,ladderSummary} from './result-flow.mjs';
import {ResultPreviewButton} from './ResultPreviewPopover';
import {previewFiles} from './ladder-preview.mjs';
import {HmiPreview} from './HmiPreview';
export {ResultPreviewButton} from './ResultPreviewPopover';

const previewCss=`
.pc-preview{margin-top:16px}.pc-preview-file{border:1px solid var(--pc-line);border-radius:9px;overflow:hidden;margin:12px 0}.pc-preview-title{padding:10px 12px;background:var(--pc-canvas);font-weight:600;overflow-wrap:anywhere}.pc-preview-body{padding:12px}.pc-preview-diff{margin:0!important;padding:0!important;overflow:auto;font-size:12px!important;line-height:1.7}.pc-preview-line{display:flex;min-width:max-content;gap:10px;padding:1px 10px}.pc-preview-line[data-kind=add]{background:color-mix(in srgb,#16834b 13%,var(--pc-surface))}.pc-preview-line[data-kind=remove]{background:color-mix(in srgb,#b64c4c 12%,var(--pc-surface))}.pc-preview-line>span:first-child{width:16px;user-select:none;opacity:.7}.pc-preview-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.pc-preview-pair pre{max-height:360px;overflow:auto;white-space:pre-wrap}.pc-preview-rung{border-left:3px solid var(--pc-accent);padding:2px 10px;margin:12px 0}.pc-preview-rung p{font-size:13px}.pc-preview-rung ul{margin:4px 0!important;padding-left:18px!important}.pc-preview-rung li{font-size:12px!important;padding:2px 0!important}.pc-preview-state{font-size:12px;color:var(--pc-sub)}@media(max-width:600px){.pc-preview-pair{grid-template-columns:1fr}}`;

function Diff({before,after}:any){
  const diff=textDiff(before,after);
  if(diff.large)return <div className="pc-preview-pair"><div><strong>修改前</strong><pre>{before||'此文件尚不存在'}</pre></div><div><strong>修改后</strong><pre>{after||'此文件已移除'}</pre></div></div>;
  return <pre className="pc-preview-diff" aria-label="源码前后差异">{diff.lines.map((line:any,i:number)=><span key={i} className="pc-preview-line" data-kind={line.kind}><span>{line.kind==='add'?'+':line.kind==='remove'?'−':' '}</span><span>{line.text||' '}</span>{'\n'}</span>)}</pre>;
}

function Ladder({graph,label}:any){
  const rows=ladderSummary(graph);
  if(rows===null)return <p className="pc-preview-state">{label}：未提供可解析的梯形图网络，请在 OpenPLC 中预览。</p>;
  return <div><strong>{label} · {rows.length} 个网络</strong>{!rows.length&&<p className="pc-preview-state">尚无梯形图网络</p>}{rows.map((row:any)=><div key={row.index} className="pc-preview-rung"><strong>网络 {row.index}</strong>{row.comment&&<p>{row.comment}</p>}<ul>{row.nodes.map((node:any,i:number)=><li key={i}>{node.type==='contact'?(node.variant==='negated'?'常闭触点':'触点'):node.type==='coil'?'线圈':node.type==='block'?'功能调用':'变量'}：<code>{node.blockName||node.name||'未命名'}</code>{node.bindings.length>0&&<span> · {node.bindings.map((binding:any)=>`${binding.port} = ${binding.variable}`).join('；')}</span>}</li>)}</ul><span className="pc-preview-state">{row.connectionCount} 条原生连接</span></div>)}</div>;
}

function CompactFile({file,afterLabel}:any){
  if(file.kind==='metadata')return <p className="pc-preview-body pc-muted">{file.unavailableReason||'请在原生编辑器查看该资源。'}</p>;
  if(file.truncated)return <p className="pc-preview-body pc-muted">文件较大，请打开完整修改结果或原生编辑器核对。</p>;
  if(file.kind==='hmi')return <div className="pc-preview-body"><HmiPreview file={file} afterLabel={afterLabel}/></div>;
  if(file.beforeUnavailable)return <div className="pc-preview-body"><p className="pc-muted">旧基线不可用，以下为已核对的候选内容。</p><pre className="pc-preview-diff">{String(file.afterDeclarations||file.afterText||'').split('\n').slice(0,8).join('\n')}</pre></div>;
  if(file.kind==='ld'){
    const before=ladderSummary(file.before),after=ladderSummary(file.after);
    if(!after)return <p className="pc-preview-body pc-muted">梯形图文件已变化，请打开完整修改结果查看。</p>;
    return <div className="pc-preview-body"><span className="pc-preview-state">网络：{before?.length??'未确认'} → {after.length}</span>{after.slice(0,2).map((row:any)=><p key={row.index} style={{margin:'5px 0',fontSize:12}}><strong>网络 {row.index}</strong>{row.comment?' · '+row.comment:''}<br/>{row.nodes.slice(0,5).map((node:any)=>`${node.type==='contact'?(node.variant==='negated'?'常闭触点':'触点'):node.type==='coil'?'线圈':node.type==='block'?'功能调用':'变量'} ${node.blockName||node.name||'未命名'}`).join(' · ')}{row.nodes.length>5?' …':''}</p>)}<span className="pc-preview-state">实际网络摘要；接线请在 OpenPLC 预览。</span></div>;
  }
  const diff=textDiff(file.beforeText,file.afterText);
  if(diff.large)return <pre className="pc-preview-diff" style={{padding:10}}>{String(file.afterText||'').split('\n').slice(0,8).join('\n')}<span className="pc-preview-state">{'\n'}修改后内容节选，完整差异见修改结果。</span></pre>;
  const changed=diff.lines.filter((line:any)=>line.kind!=='same');
  return <pre className="pc-preview-diff" aria-label="修改内容节选">{changed.slice(0,10).map((line:any,i:number)=><span key={i} className="pc-preview-line" data-kind={line.kind}><span>{line.kind==='add'?'+':'−'}</span><span>{line.text||' '}</span>{'\n'}</span>)}{changed.length>10&&<span className="pc-preview-state">　还有 {changed.length-10} 行变化…</span>}{!changed.length&&<span className="pc-preview-state">　正文一致，请在修改结果中核对文件状态。</span>}</pre>;
}

export function ResultPreview({conversationId,task,compact=false,tool}:any){
  const [state,setState]=useState<any>(null),[refresh,setRefresh]=useState(0);
  const key=conversationId+':'+task.projectId+':'+task.taskId+':'+task.candidate?.candidateDigest;
  useEffect(()=>{
    let cancelled=false;setState(null);
    (async()=>{try{const value=validateResultPreview(await api(previewUrl(conversationId,task),undefined,65000),task);if(!cancelled)setState({key,value});}
      catch(error:any){if(!cancelled)setState({key,error:error?.message||'修改内容暂未能读取。'});}})();
    return()=>{cancelled=true;};
  },[conversationId,key,refresh]);
  const current=state?.key===key?state:null;
  const files=previewFiles(current?.value,tool);
  return <section className="pc-preview" aria-label="实际修改内容"><style>{previewCss}</style>{!compact&&<h3>修改内容</h3>}
    {!current?<p className="pc-muted">正在读取源版本与修改结果…</p>:current.error?<p role="status">{current.error} <button onClick={()=>setRefresh(n=>n+1)}>重新读取修改</button></p>:<>
      {current.value.truncated&&<p className="pc-muted">部分内容超出预览范围，请在原生编辑器核对完整结果。</p>}
      {!files.length&&<p>没有可展示的文件变化。</p>}
      {(compact?files.slice(0,2):files).map((file:any)=><article className="pc-preview-file" key={file.path}><div className="pc-preview-title">{file.beforeSha256===null?'新增 · ':file.afterSha256===null?'移除 · ':''}{file.path}</div>
        {compact?<CompactFile file={file} afterLabel={task.status==='discarded'?'撤销前':'修改后'}/>:file.kind==='metadata'?<p className="pc-preview-body pc-muted">{file.unavailableReason||'此类资源请通过原生预览查看。'}</p>:file.kind==='hmi'?<div className="pc-preview-body"><HmiPreview file={file} afterLabel={task.status==='discarded'?'撤销前':'修改后'}/></div>:<>
          {file.beforeUnavailable&&<p role="status" className="pc-preview-body pc-muted">原工程内容已变化，旧基线无法读取；以下只展示已核对的候选内容。</p>}
          {file.truncated&&<p className="pc-preview-body pc-muted">该文件超出预览大小，请通过原生编辑器查看。</p>}
          {file.kind==='ld'?<div className="pc-preview-body"><ResultPreviewButton conversationId={conversationId} task={task} file={file} label="查看梯形图对比"/><details><summary>变量声明变化</summary>{file.beforeUnavailable?<pre>{file.afterDeclarations||ladderDeclarations(file.afterText)}</pre>:<Diff before={file.beforeDeclarations||ladderDeclarations(file.beforeText)} after={file.afterDeclarations||ladderDeclarations(file.afterText)}/>}</details></div>:file.beforeUnavailable?<pre>{file.afterText}</pre>:!file.truncated&&<Diff before={file.beforeText} after={file.afterText}/>}
        </>}</article>)}
      {compact&&files.length>2&&<p className="pc-muted">另有 {files.length-2} 个文件变化，可在“查看修改结果”中核对。</p>}
    </>}
  </section>;
}
