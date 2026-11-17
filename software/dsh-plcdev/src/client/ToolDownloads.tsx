import React,{useEffect,useRef,useState} from 'react';
import {BrandTitle} from './Brand';
import {ToolLogo} from './ToolLogo';
import {conversationApi} from './conversation-client.mjs';
import {toolDistributions,validateToolEnvironment} from './tool-distributions.mjs';

const labels:any={found:'已找到',missing:'未找到',unchecked:'未检测'};
const css=`
.pd-tools-backdrop{position:fixed;inset:0;z-index:100;background:#14213755;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.pd-tools-dialog{width:720px;max-width:100%;max-height:calc(100dvh - 48px);overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#243247);border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:16px;padding:24px;box-sizing:border-box;font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif)}
.pd-tools-dialog>header,.pd-tools-row>header,.pd-tools-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.pd-tools-dialog>header{justify-content:space-between}.pd-tools-dialog h2{font-size:18px;margin:0;min-width:0}.pd-tools-dialog h3{font-size:15px;margin:0;min-width:0}.pd-tools-dialog .plcdev-title{align-items:center}.pd-tools-dialog p{margin:8px 0;color:var(--dsw-alias-label-secondary,#657184)}
.pd-tools-dialog button,.pd-tools-dialog a.pd-tools-download{font:inherit;font-size:13px;min-height:34px;box-sizing:border-box;padding:5px 11px;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:8px;background:transparent;color:inherit;text-decoration:none;cursor:pointer}.pd-tools-dialog button:disabled{opacity:.5;cursor:default}.pd-tools-dialog :is(button,a,summary):focus-visible{outline:2px solid var(--plcdev-accent,#7250b8);outline-offset:3px}.pd-tools-dialog .pd-tools-download{color:var(--plcdev-accent,#7250b8)!important}.pd-tools-dialog a:not(.pd-tools-download){color:var(--plcdev-accent,#7250b8);text-decoration:underline;text-underline-offset:3px}
.pd-tools-list{margin-top:16px}.pd-tools-row{border-top:1px solid var(--dsw-alias-border-l2,#dfe5ec);padding:18px 0}.pd-tools-row>header>span:last-child{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#657184)}.pd-tools-row>header>[data-state=missing]{color:#9a6717!important}.pd-tools-row>p{font-size:13px}.pd-tools-row details{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#657184)}.pd-tools-row summary{cursor:pointer}.pd-tools-row code,.pd-tools-config code{overflow-wrap:anywhere;white-space:normal;font-size:12px}.pd-tools-config{border-top:1px solid var(--dsw-alias-border-l2,#dfe5ec);padding-top:14px;font-size:12px}.pd-tools-config summary{cursor:pointer;font-size:13px}.pd-tools-error{border-left:3px solid #bd893c;padding-left:12px;font-size:13px}.pd-tools-empty-entry{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#dfe5ec);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);margin:16px 0}.pd-tools-empty-entry p{margin:0;color:var(--dsw-alias-label-secondary,#657184);font-size:13px}
@media(max-width:600px){.pd-tools-backdrop{padding:12px}.pd-tools-dialog{padding:18px 16px;max-height:calc(100dvh - 24px)}.pd-tools-dialog h2{font-size:16px}.pd-tools-row>header{gap:8px}.pd-tools-row h3{font-size:14px}}
`;

export function ToolDownloadEntry({onOpen}:any){return <><style>{css}</style><div className="pd-tools-empty-entry"><p>还没有安装工程工具？</p><button onClick={onOpen}>工具下载与安装</button></div></>;}

export function ToolDownloads({onClose,onChecked}:any){
  const [value,setValue]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const sequence=useRef(0),dialog=useRef<HTMLElement>(null),first=useRef<HTMLButtonElement>(null),origin=useRef<HTMLElement|null>(document.activeElement as HTMLElement);
  async function check(){
    const ticket=++sequence.current;setBusy(true);setError('');
    try{const next=validateToolEnvironment(await conversationApi('tool-environment'));if(ticket===sequence.current){setValue(next);onChecked?.();}}
    catch(e:any){if(ticket===sequence.current){setValue(null);setError(e.message||'工具位置暂时无法检测。');}}
    finally{if(ticket===sequence.current)setBusy(false);}
  }
  useEffect(()=>{void check();first.current?.focus();return()=>{sequence.current++;if(origin.current?.isConnected)origin.current.focus();};},[]);
  function key(event:React.KeyboardEvent){
    if(event.key==='Escape'){event.stopPropagation();event.preventDefault();onClose();return;}
    if(event.key!=='Tab')return;
    const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary')||[]).filter(node=>node.getClientRects().length>0);
    const firstNode=nodes[0],last=nodes.at(-1);if(!firstNode||!last)return;
    if(event.shiftKey&&document.activeElement===firstNode){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();firstNode.focus();}
  }
  return <div className="pd-tools-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}} onKeyDown={key}><style>{css}</style><section ref={dialog} className="pd-tools-dialog plcdev-scope" role="dialog" aria-modal="true" aria-labelledby="pd-tools-title">
    <header><h2 id="pd-tools-title"><BrandTitle>工具下载与安装</BrandTitle></h2><button ref={first} aria-label="关闭工具下载" onClick={onClose}>×</button></header>
    <p>编辑工具优先使用 PLCdev 适配版本；PLC 运行还需要 Runtime 与匹配的编译环境。</p>
    <div className="pd-tools-actions"><button disabled={busy} onClick={check}>{busy?'正在检测…':'重新检测'}</button><span style={{fontSize:12,color:'var(--dsw-alias-label-secondary,#657184)'}}>已找到仅表示安装入口存在。</span></div>
    {error&&<p className="pd-tools-error" role="alert">{error}</p>}{value?.configError&&<p className="pd-tools-error" role="alert">{value.configError}</p>}
    <div className="pd-tools-list">{toolDistributions.map(tool=>{const detected=value?.tools.find((row:any)=>row.id===tool.id);return <section className="pd-tools-row" key={tool.id} aria-label={tool.name}>
      <header><ToolLogo tool={['openplc','runtime','msys'].includes(tool.id)?'plc':tool.id} size={24}/><h3>{tool.name}</h3><span data-state={detected?.state||'unchecked'}>{labels[detected?.state]||'未检测'}{detected?.version?' · '+detected.version:''}</span></header>
      <p>{tool.edition}</p><div className="pd-tools-actions">
        {tool.download?<a className="pd-tools-download" href={tool.download} target="_blank" rel="noopener noreferrer">{tool.downloadLabel||'下载'+tool.kind}</a>:<span style={{fontSize:13}}>{tool.availability||'适配包发布准备中'}</span>}
        {tool.repository&&<a href={tool.installation||tool.repository+'#安装'} target="_blank" rel="noopener noreferrer">安装说明</a>}
      </div>
      <details><summary>安装位置与其他版本</summary><p>{detected?.path?<code>{detected.path}</code>:detected?.reason||'本机位置尚未确认'}</p>{detected?.checks?.some((item:any)=>item.state!=='found')&&<p>待补齐或核对：{detected.checks.filter((item:any)=>item.state!=='found').map((item:any)=>item.entry).join('、')}</p>}<p>配置项 <code>tools.{tool.key}</code>：{tool.pathHint}</p>{tool.official&&<a href={tool.official} target="_blank" rel="noopener noreferrer">官方版本与源码</a>}</details>
    </section>;})}</div>
    <details className="pd-tools-config"><summary>安装后如何接入</summary><p>按各工具安装说明完成准备，在本机环境配置中填写工具位置，然后重新检测。检测不会修改配置或启动工具。</p><p><code>{value?.configPath||'outputs/local/environment.json'}</code></p><p>已连接的工程服务会继续使用原配置；修改位置后，请先正常结束运行会话及已打开的工程工具，再重启工程服务。</p></details>
  </section></div>;
}
