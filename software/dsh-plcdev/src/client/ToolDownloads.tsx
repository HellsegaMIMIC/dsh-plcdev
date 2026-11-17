import React,{useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {BrandTitle} from './Brand';
import {ToolLogo} from './ToolLogo';
import {conversationApi} from './conversation-client.mjs';
import {toolDistributions,toolInstallGroups,validateToolEnvironment} from './tool-distributions.mjs';
import {buildToolInstallPrompt} from './tool-install-prompt.mjs';

const labels:any={found:'已找到',missing:'未找到',unchecked:'未检测'};
const downloadLabels:any={openplc:'编辑预览包',fuxa:'联网安装包',oip:'汉化补丁',runtime:'官方下载'};
const css=`
.pd-tools-backdrop{position:fixed;inset:0;z-index:100;background:transparent;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.pd-tools-dialog{width:720px;max-width:100%;max-height:calc(100dvh - 48px);overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#243247);border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:16px;padding:24px;box-sizing:border-box;font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif)}
.pd-tools-backdrop>.pd-tools-dialog{box-shadow:0 10px 36px #14213724}
.pd-tools-dialog>header,.pd-tools-row>header,.pd-tools-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.pd-tools-dialog>header{justify-content:space-between}.pd-tools-dialog h2{font-size:18px;margin:0;min-width:0}.pd-tools-dialog h3{font-size:15px;margin:0;min-width:0}.pd-tools-dialog .plcdev-title{align-items:center}.pd-tools-dialog p{margin:8px 0;color:var(--dsw-alias-label-secondary,#657184)}
.pd-tools-dialog button,.pd-tools-dialog a.pd-tools-download{font:inherit;font-size:13px;min-height:34px;box-sizing:border-box;padding:5px 11px;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:8px;background:transparent;color:inherit;text-decoration:none;cursor:pointer}.pd-tools-dialog button:disabled{opacity:.5;cursor:default}.pd-tools-dialog :is(button,a,summary):focus-visible{outline:2px solid var(--plcdev-accent,#7250b8);outline-offset:3px}.pd-tools-dialog .pd-tools-download{color:var(--plcdev-accent,#7250b8)!important}.pd-tools-dialog a:not(.pd-tools-download){color:var(--plcdev-accent,#7250b8);text-decoration:underline;text-underline-offset:3px}
.pd-tools-dialog{container:pd-tool-panel / inline-size}.pd-tools-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:start;gap:10px;margin:14px 0}.pd-tools-row{min-width:0;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:10px;padding:12px 14px;box-sizing:border-box}.pd-tools-row>header{flex-wrap:nowrap;gap:8px}.pd-tools-row h3{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pd-tools-status{display:flex;flex-wrap:wrap;gap:0 10px;margin:3px 0 7px;font-size:12px;color:var(--dsw-alias-label-secondary,#657184)}.pd-tools-status>span{white-space:nowrap}.pd-tools-status>[data-state=missing]{color:var(--dsw-alias-warning,#9a6717)}.pd-tools-row-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.pd-tools-dialog .pd-tools-row-actions :is(a,button){min-height:28px;padding:3px 0;border:0;border-radius:4px;white-space:nowrap;font-size:12px;line-height:22px;text-decoration:none}.pd-tools-row-actions button{color:var(--dsw-alias-label-secondary,#657184)}.pd-tools-row-actions button[aria-expanded=true]{color:var(--plcdev-accent,#7250b8)}.pd-tools-row-actions :is(a,button):hover{text-decoration:underline;text-underline-offset:3px}.pd-tools-row-actions button span{display:inline-block;margin-left:5px;transition:transform .15s}.pd-tools-row-actions button[aria-expanded=true] span{transform:rotate(180deg)}.pd-tools-detail{margin:0 0 14px;padding:14px 16px;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#f5f6f8);font-size:12px;overflow-wrap:anywhere}.pd-tools-detail>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.pd-tools-detail h3{font-size:14px}.pd-tools-detail>header button{min-height:28px;padding:2px 7px;border:0;font-size:12px}.pd-tools-detail .pd-tools-actions{margin-top:10px}.pd-tools-detail-part h4{font:inherit;font-weight:600;margin:12px 0 4px}.pd-tools-detail-part+.pd-tools-detail-part{border-top:1px solid var(--dsw-alias-border-l2,#dfe5ec);margin-top:12px;padding-top:2px}.pd-tools-detail code,.pd-tools-config code{overflow-wrap:anywhere;white-space:normal;font-size:12px}.pd-tools-config{border-top:1px solid var(--dsw-alias-border-l2,#dfe5ec);padding-top:14px;font-size:12px}.pd-tools-config summary{cursor:pointer;font-size:13px}.pd-tools-error{border-left:3px solid #bd893c;padding-left:12px;font-size:13px}.pd-tools-empty-entry{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);margin:16px 0}.pd-tools-empty-entry p{margin:0;color:var(--dsw-alias-label-secondary,#657184);font-size:13px}
@container pd-tool-panel (max-width:1000px){.pd-tools-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container pd-tool-panel (max-width:500px){.pd-tools-list{grid-template-columns:minmax(0,1fr)}.pd-tools-row{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;padding:10px 12px}.pd-tools-row>header{grid-column:1;grid-row:1}.pd-tools-status{grid-column:2;grid-row:1;margin:0;align-self:center}.pd-tools-group>header{grid-column:1/-1}.pd-tools-group>.pd-tools-status{grid-column:1/-1;grid-row:2;margin-top:4px}.pd-tools-row-actions{grid-column:1/-1;margin-top:5px}}
.pd-tools-dialog.pd-tools-inline{width:100%;max-height:none;overflow:visible;border-radius:12px}.pd-tools-agent{margin:18px 0;padding:16px 18px;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#f5f6f8)}.pd-tools-agent h3{font-size:14px}.pd-tools-agent p{font-size:13px;margin:5px 0 12px}.pd-tools-agent-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pd-tools-agent select,.pd-tools-prompt textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:7px;box-sizing:border-box;max-width:100%;min-width:0}.pd-tools-agent select{min-height:36px;padding:5px 10px;font-size:13px}.pd-tools-dialog .pd-tools-copy{background:var(--plcdev-accent,#7250b8);border-color:var(--plcdev-accent,#7250b8);color:var(--plcdev-on-accent,#fff)}.pd-tools-prompt{margin-top:12px;font-size:12px}.pd-tools-prompt summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#657184)}.pd-tools-prompt textarea{display:block;width:100%;height:220px;margin-top:10px;padding:12px;font-size:12px;line-height:1.65;resize:vertical}.pd-tools-agent [role=status]{display:block;margin-top:8px;font-size:12px}.pd-tools-dialog :is(select,textarea):focus-visible{outline:2px solid var(--plcdev-accent,#7250b8);outline-offset:3px}
@media(max-width:600px){.pd-tools-backdrop{padding:12px}.pd-tools-dialog{padding:18px 16px;max-height:calc(100dvh - 24px)}.pd-tools-dialog h2{font-size:16px}.pd-tools-row>header{gap:8px}.pd-tools-row h3{font-size:14px}}
`;

export function ToolDownloadEntry({onOpen}:any){return <><style>{css}</style><div className="pd-tools-empty-entry"><p>还没有安装工程工具？</p><button onClick={onOpen}>工具下载与安装</button></div></>;}

export function ToolDownloads({onClose,onChecked,embedded=false}:any){
  const [value,setValue]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [scope,setScope]=useState('all'),[copyState,setCopyState]=useState(''),[promptOpen,setPromptOpen]=useState(false);
  const [detailId,setDetailId]=useState<string|null>(null),detailPanelId=useId(),detailOrigin=useRef<HTMLButtonElement|null>(null),detailPanel=useRef<HTMLElement>(null);
  const detailTool=toolInstallGroups.find(tool=>tool.id===detailId);
  const promptRef=useRef<HTMLTextAreaElement>(null),copySequence=useRef(0),titleId=useId();
  const prompt=buildToolInstallPrompt(scope);
  const sequence=useRef(0),dialog=useRef<HTMLElement>(null),first=useRef<HTMLButtonElement>(null),origin=useRef<HTMLElement|null>(document.activeElement as HTMLElement);
  async function check(){
    const ticket=++sequence.current;setBusy(true);setError('');
    try{const next=validateToolEnvironment(await conversationApi('tool-environment'));if(ticket===sequence.current){setValue(next);onChecked?.();}}
    catch(e:any){if(ticket===sequence.current){setValue(null);setError(e.message||'工具位置暂时无法检测。');}}
    finally{if(ticket===sequence.current)setBusy(false);}
  }
  useEffect(()=>{void check();if(!embedded)first.current?.focus();return()=>{sequence.current++;copySequence.current++;if(!embedded&&origin.current?.isConnected)origin.current.focus();};},[]);
  useEffect(()=>{if(copyState==='failed'){promptRef.current?.focus();promptRef.current?.select();}},[copyState]);
  useEffect(()=>{if(detailId)detailPanel.current?.scrollIntoView?.({block:'nearest'});},[detailId]);
  async function copyPrompt(){
    const ticket=++copySequence.current;setCopyState('copying');
    try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(prompt);if(ticket===copySequence.current)setCopyState('copied');}
    catch{if(ticket===copySequence.current){setPromptOpen(true);setCopyState('failed');}}
  }
  function key(event:React.KeyboardEvent){
    if(event.key==='Escape'){event.stopPropagation();event.preventDefault();onClose();return;}
    if(event.key!=='Tab')return;
    const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,select,textarea')||[]).filter(node=>node.getClientRects().length>0);
    const firstNode=nodes[0],last=nodes.at(-1);if(!firstNode||!last)return;
    if(event.shiftKey&&document.activeElement===firstNode){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();firstNode.focus();}
  }
  const content=<section ref={dialog} className={'pd-tools-dialog plcdev-scope'+(embedded?' pd-tools-inline':'')} role={embedded?'region':'dialog'} aria-modal={embedded?undefined:true} aria-labelledby={titleId}>
    <header><h2 id={titleId}>{embedded?'工具配置与下载':<BrandTitle>工具下载与安装</BrandTitle>}</h2>{!embedded&&<button ref={first} aria-label="关闭工具下载" onClick={onClose}>×</button>}</header>
    <p>编辑工具优先使用 PLCdev 适配版本，运行依赖一并准备。</p>
    <div className="pd-tools-agent"><h3>交给 DSH Agent 安装</h3><p>复制提示词到 DSH 对话，让 Agent 检查本机并补齐工具。</p>
      <div className="pd-tools-agent-controls"><select aria-label="安装提示词范围" value={scope} onChange={event=>{copySequence.current++;setScope(event.target.value);setCopyState('');}}><option value="all">全部工具与运行依赖</option>{toolInstallGroups.map(tool=><option key={tool.id} value={tool.id}>{tool.name}</option>)}</select><button className="pd-tools-copy" disabled={copyState==='copying'} onClick={copyPrompt}>{copyState==='copying'?'正在复制…':'复制安装提示词'}</button></div>
      {copyState==='copied'&&<span role="status">已复制，粘贴到 DSH 对话即可。</span>}{copyState==='failed'&&<span role="status">无法自动复制，已展开提示词，请选中后复制。</span>}
      <details className="pd-tools-prompt" open={promptOpen} onToggle={event=>setPromptOpen(event.currentTarget.open)}><summary>查看提示词</summary><textarea ref={promptRef} aria-label="DSH 安装提示词" readOnly value={prompt}/></details>
    </div>
    <div className="pd-tools-actions"><button disabled={busy} onClick={check}>{busy?'正在检测…':'重新检测'}</button><span style={{fontSize:12,color:'var(--dsw-alias-label-secondary,#657184)'}}>已找到仅表示安装入口存在。</span></div>
    {error&&<p className="pd-tools-error" role="alert">{error}</p>}{value?.configError&&<p className="pd-tools-error" role="alert">{value.configError}</p>}
    <div className="pd-tools-list">{toolInstallGroups.map(tool=><section className={'pd-tools-row'+(tool.members.length>1?' pd-tools-group':'')} key={tool.id} aria-label={tool.name}>
      <header><ToolLogo tool={['openplc','runtime','msys'].includes(tool.id)?'plc':tool.id} size={20}/><h3 title={tool.name}>{tool.id==='oip'?'OIP':tool.name}</h3></header>
      <div className="pd-tools-status">{tool.members.map(id=>{const detected=value?.tools.find((row:any)=>row.id===id);return <span key={id} data-tool={id} data-state={detected?.state||'unchecked'}>{tool.members.length>1?(id==='runtime'?'Runtime：':'编译依赖：'):''}{id==='msys'&&detected?.state==='missing'?'待补齐':labels[detected?.state]||'未检测'}</span>;})}</div>
      <div className="pd-tools-row-actions"><a className="pd-tools-download" href={tool.download||tool.installation||tool.repository} title={tool.downloadLabel||tool.edition} aria-label={tool.name+' · '+(tool.downloadLabel||downloadLabels[tool.id])} target="_blank" rel="noopener noreferrer">{downloadLabels[tool.id]}</a><button aria-label={tool.name+' 详情'} aria-expanded={detailId===tool.id} aria-controls={detailPanelId} onClick={event=>{detailOrigin.current=event.currentTarget;setDetailId(detailId===tool.id?null:tool.id);}}>详情<span aria-hidden="true">⌄</span></button></div>
    </section>)}</div>
    <section ref={detailPanel} id={detailPanelId} className="pd-tools-detail" hidden={!detailTool} aria-label={detailTool?.name+' 安装详情'}>{detailTool&&<>
      <header><h3>{detailTool.name}</h3><button aria-label="收起工具详情" onClick={()=>{setDetailId(null);detailOrigin.current?.focus();}}>收起</button></header>
      {detailTool.members.map(id=>{const tool=toolDistributions.find(row=>row.id===id)!,detailDetected=value?.tools.find((row:any)=>row.id===id);return <div className="pd-tools-detail-part" key={id}>
      {detailTool.members.length>1&&<h4>{id==='runtime'?'OpenPLC Runtime':'编译依赖'}</h4>}
      <p>{tool.edition}</p>{tool.availability&&<p>{tool.availability}</p>}
      <p>{detailDetected?.version&&<>本机版本 {detailDetected.version} · </>}{detailDetected?.path?<code>{detailDetected.path}</code>:detailDetected?.reason||'本机位置尚未确认'}</p>
      {detailDetected?.checks?.some((item:any)=>item.state!=='found')&&<p>待补齐或核对：{detailDetected.checks.filter((item:any)=>item.state!=='found').map((item:any)=>item.entry).join('、')}</p>}
      <p>配置项 <code>tools.{tool.key}</code>：{tool.pathHint}</p>
      </div>;})}
      <div className="pd-tools-actions">{detailTool.repository&&<a href={detailTool.installation||detailTool.repository+'#安装'} target="_blank" rel="noopener noreferrer">安装说明</a>}{detailTool.official&&<a href={detailTool.official} target="_blank" rel="noopener noreferrer">官方版本与源码</a>}</div>
    </>}</section>
    <details className="pd-tools-config"><summary>安装后如何接入</summary><p>按各工具安装说明完成准备，在本机环境配置中填写工具位置，然后重新检测。检测不会修改配置或启动工具。</p><p><code>{value?.configPath||'outputs/local/environment.json'}</code></p><p>已连接的工程服务会继续使用原配置；修改位置后，请先正常结束运行会话及已打开的工程工具，再重启工程服务。</p></details>
  </section>;
  // Escape layout containers that establish a fixed-position containing block.
  return embedded?<><style>{css}</style>{content}</>:createPortal(<div className="pd-tools-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget){event.preventDefault();onClose();}}} onKeyDown={key}><style>{css}</style>{content}</div>,document.body);
}
