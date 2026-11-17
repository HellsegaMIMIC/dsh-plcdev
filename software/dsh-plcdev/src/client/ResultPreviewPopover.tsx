import {BrandTitle} from './Brand';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {conversationApi as api} from './conversation-client.mjs';
import {previewUrl,validateResultPreview,textDiff} from './result-flow.mjs';
import {previewFiles} from './ladder-preview.mjs';
import {NativeLadderPreview} from './NativeLadderPreview';
import {HmiPreview} from './HmiPreview';

const popupCss=`
.pc-result-popover{--pc-surface:var(--dsw-alias-bg-base,#fff);--pc-canvas:var(--dsw-alias-bg-module-platform,#f5f6f8);--pc-line:var(--dsw-alias-border-l2,#e2e6ed);--pc-sub:var(--dsw-alias-label-secondary,#667085);--pc-accent:var(--plcdev-accent);position:fixed;z-index:1000;display:flex;flex-direction:column;width:min(590px,calc(100vw - 24px));max-height:min(400px,calc(100dvh - 24px));border:1px solid var(--pc-line);border-radius:12px;background:var(--pc-surface);color:var(--dsw-alias-label-primary,#202939);font:13px/1.5 var(--dsw-font-family,system-ui,sans-serif);box-shadow:0 8px 28px #14202d22;box-sizing:border-box}
.pc-result-popover *{box-sizing:border-box}.pc-result-popover button,.pc-result-popover select{font:inherit;color:inherit;background:transparent;border:1px solid var(--pc-line);border-radius:6px;padding:4px 8px;cursor:pointer}.pc-result-popover button:disabled{opacity:.4;cursor:default}.pc-result-popover :is(button,select):focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.pc-result-popover-head,.pc-result-popover-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;flex:none}.pc-result-popover-head h2,.pc-result-popover-head strong{margin:0;font-size:13px;font-weight:600;overflow-wrap:anywhere}.pc-result-popover-head button{border:0;padding:2px 6px}.pc-result-popover-head select{max-width:100%;font-size:11px;min-width:0}.pc-result-popover-head>div{min-width:0;flex:1;display:grid;gap:3px;align-items:start;justify-items:start}.pc-result-popover-body{overflow-x:hidden;overflow-y:auto;padding:0 12px;min-height:0;scrollbar-width:thin;overscroll-behavior:contain}.pc-result-popover-body p{margin:8px 0;font-size:12px}.pc-result-popover-body pre{margin:0;padding:8px 0;font:12px/1.65 var(--ds-font-family-code,monospace);white-space:pre-wrap;overflow-wrap:anywhere}.pc-result-popover-foot{font-size:11px;color:var(--pc-sub)}.pc-result-popover-foot button{border:0;padding:2px 0;color:var(--pc-sub)}.pc-preview-launch{white-space:nowrap}
.pc-popover-diff-line{display:flex;gap:8px;padding:1px 7px}.pc-popover-diff-line>span:last-child{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.pc-popover-diff-line>span:first-child{flex:none;width:12px}.pc-popover-diff-line[data-kind=add]{background:color-mix(in srgb,#16834b 13%,var(--pc-surface))}.pc-popover-diff-line[data-kind=remove]{background:color-mix(in srgb,#b64c4c 12%,var(--pc-surface))}
.pc-result-overlay{position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:#14202d40;padding:20px}.pc-result-overlay .pc-result-popover{position:relative;left:auto!important;top:auto!important;width:min(1120px,100%);max-height:calc(100dvh - 40px)}
@media(max-width:600px){.pc-result-overlay{padding:12px}.pc-result-overlay .pc-result-popover{max-height:calc(100dvh - 24px)}}
`;
function PreviewFile({file,afterLabel}:any){
 if(file.kind==='metadata')return <p>{file.unavailableReason||'此类资源请在对应工具查看。'}</p>;
 if(file.truncated)return <p>文件超出预览范围，请在对应工具查看。</p>;
 if(file.kind==='hmi')return <HmiPreview file={file} afterLabel={afterLabel}/>;
 if(file.kind==='ld')return <NativeLadderPreview file={file} afterLabel={afterLabel}/>;
 if(file.beforeUnavailable)return <><p>旧基线不可用，以下为已核对的候选内容。</p><pre>{file.afterText||''}</pre></>;
 const diff=textDiff(file.beforeText,file.afterText);
 if(diff.large)return <><strong>修改前</strong><pre>{file.beforeText||'此文件尚不存在'}</pre><strong>{afterLabel}</strong><pre>{file.afterText||'此文件已移除'}</pre></>;
 return <pre aria-label="源码前后差异">{diff.lines.map((line:any,i:number)=><span key={i} className="pc-popover-diff-line" data-kind={line.kind}><span>{line.kind==='add'?'+':line.kind==='remove'?'−':' '}</span><span>{line.text||' '}</span>{'\n'}</span>)}</pre>;
}
function PreviewDialog({anchor,task,files,loading,error,retry,onClose}:any){
 const panel=useRef<HTMLElement>(null),[large,setLarge]=useState(false),[index,setIndex]=useState(0);
 const file=files[Math.min(index,Math.max(0,files.length-1))];
 const ended=['discarded','superseded','reverted','cancelled'].includes(task.status);
 useLayoutEffect(()=>{
  const position=()=>{
   if(!panel.current||!anchor.current||large)return;
   const box=anchor.current.getBoundingClientRect(),width=Math.min(590,innerWidth-24);
   const height=Math.min(panel.current.getBoundingClientRect().height||380,innerHeight-24);
   const below=innerHeight-box.bottom-21,above=box.top-21;
   panel.current.style.left=Math.max(12,Math.min(box.left,innerWidth-width-12))+'px';
   panel.current.style.top=Math.max(12,Math.min(below>=height||below>=above?box.bottom+9:box.top-height-9,innerHeight-height-12))+'px';
  };
  position();window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(position);if(panel.current)observer?.observe(panel.current);
  return()=>{observer?.disconnect();window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);};
 },[anchor,large,file,loading,error]);
 useEffect(()=>{
  const click=(event:MouseEvent)=>{if(!large&&!panel.current?.contains(event.target as Node)&&!anchor.current?.contains(event.target as Node))onClose(false);};
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();onClose(true);}
   if(event.key==='Tab'&&large&&panel.current){
    const list=Array.from(panel.current.querySelectorAll('button,select,[tabindex="0"]')).filter((e:any)=>!e.disabled) as HTMLElement[];
    const first=list[0],last=list[list.length-1];
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
   }
  };
  document.addEventListener('click',click);document.addEventListener('keydown',key,true);
  return()=>{document.removeEventListener('click',click);document.removeEventListener('keydown',key,true);};
 },[anchor,large,onClose]);
 useEffect(()=>{panel.current?.focus({preventScroll:true});},[large]);
 const body=<section ref={panel} className="pc-result-popover plcdev-scope plcdev-rail" role="dialog" aria-label="PLCdev 修改详情" aria-modal={large?'true':'false'} tabIndex={-1}>
  <style>{popupCss}</style><header className="pc-result-popover-head"><div><h2><BrandTitle>修改详情</BrandTitle></h2>{files.length>1?<select aria-label="选择修改文件" value={file?.path||''} onChange={e=>setIndex(files.findIndex((f:any)=>f.path===e.target.value))}>{files.map((f:any)=><option key={f.path} value={f.path}>{f.path}</option>)}</select>:<strong title={file?.path}>{file?.path}</strong>}</div><button onClick={()=>onClose(true)} aria-label="关闭修改详情">×</button></header>
  <div className="pc-result-popover-body">{loading?<p>正在读取修改…</p>:error?<p role="alert">{error} <button onClick={retry}>重新读取</button></p>:!file?<p>没有可展示的文件变化。</p>:<PreviewFile file={file} afterLabel={task.status==='discarded'?'撤销前':'修改后'}/>}</div>
  <footer className="pc-result-popover-foot"><span>{task.status==='discarded'?'已撤销 · 历史':ended?'历史记录':''}</span>{file&&file.kind!=='metadata'&&!file.truncated&&(file.kind!=='hmi'||[file.beforeHmi,file.afterHmi].some(side=>side?.views?.some((view:any)=>view.svg)))&&<button onClick={()=>setLarge(v=>!v)}>{large?'收起大图':'放大'}</button>}</footer>
 </section>;
 return createPortal(large?<div className="pc-result-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose(true);}}>{body}</div>:body,document.body);
}
export function ResultPreviewButton({conversationId,task,tool,label='查看改动',file:providedFile}:any){
 const anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),[state,setState]=useState<any>(null),[refresh,setRefresh]=useState(0);
 const key=conversationId+':'+task.projectId+':'+task.taskId+':'+task.candidate?.candidateDigest;
 useEffect(()=>setOpen(false),[conversationId,task.projectId,task.taskId,task.candidate?.candidateDigest,task.status]);
 useEffect(()=>{
  if(!open||providedFile)return;let cancelled=false;setState(null);
  (async()=>{try{const value=validateResultPreview(await api(previewUrl(conversationId,task),undefined,65000),task);if(!cancelled)setState({key,value});}
   catch(error:any){if(!cancelled)setState({key,error:error?.message||'修改内容暂未能读取。'});}})();
  return()=>{cancelled=true;};
 },[key,open,refresh,providedFile]);
 const current=state?.key===key?state:null;
 const close=(focus:boolean)=>{setOpen(false);if(focus)anchor.current?.focus({preventScroll:true});};
 return <><button ref={anchor} type="button" className="pc-preview-launch plcdev-link" aria-haspopup="dialog" aria-expanded={open} onClick={e=>{e.stopPropagation();setOpen(v=>!v);}}>{label}</button>{open&&<PreviewDialog anchor={anchor} task={task} files={providedFile?[providedFile]:previewFiles(current?.value,tool)} loading={!providedFile&&!current} error={current?.error} retry={()=>setRefresh(n=>n+1)} onClose={close}/>}</>;
}

