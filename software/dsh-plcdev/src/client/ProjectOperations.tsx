import React,{useEffect,useRef,useState} from 'react';
import {conversationApi,validConversationId} from './conversation-client.mjs';

const KEY='plcdev.dsh.project-operation.pending.v1';
const styles:any={display:'grid',gap:20,maxWidth:680};
const textInput:any={width:'100%',boxSizing:'border-box',padding:7};
function confirmedReceipt(value:any, intent:any){
 return value?.requestId===intent?.requestId&&value?.projectId===intent?.projectId&&value?.action===intent?.action&&value?.state==='confirmed'&&value?.result?.ok===true&&typeof value?.result?.projectId==='string'&&value.result?.project?.id===value.result.projectId&&(!['project-configure','project-interface-configure','project-oip-configure'].includes(intent.action)||value.result.projectId===intent.projectId);
}
function loadPending(){
 const raw=window.localStorage.getItem(KEY);if(!raw)return null;
 const value=JSON.parse(raw);
 if(!value||typeof value.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)||typeof value.projectId!=='string'||(value.conversationId!==undefined&&!validConversationId(value.conversationId))||(value.target!==undefined&&(typeof value.target!=='string'||value.target.length>4096||/[\x00-\x1f]/.test(value.target)))||!['project-create','project-open','project-configure','project-interface-configure','project-oip-configure'].includes(value.action))throw new Error('保存的工程操作记录无法核验；请保留现场，检查工程目录。');
 return value;
}
export function ProjectOperations({snapshot,connected,onChanged,mode,initialSection,context,contextId}:any){
 const [form,setForm]=useState({action:'project-create',name:'',parent:'',language:'st',simulation:'none',source:'',manifestPath:'',hmiSource:'',oipSource:'',bindingsSource:'',definition:''});
 const [pending,setPending]=useState<any>(null),[feedback,setFeedback]=useState({text:'',tone:'warning'}),[busy,setBusy]=useState(false),[storageFailed,setStorageFailed]=useState(false),[configBasis,setConfigBasis]=useState<any>(null);
 const [section,setSection]=useState(initialSection||'interface'),[expanded,setExpanded]=useState(initialSection==='oip');
 useEffect(()=>{if(initialSection==='oip'){setSection('oip');setExpanded(true);}},[initialSection]);
 const error=feedback.text,setError=(text:string)=>setFeedback({text,tone:'warning'}),setNotice=(text:string)=>setFeedback({text,tone:'neutral'});
 const lock=useRef(false),mounted=useRef(true),projectRef=useRef(snapshot?.project?.id);
 const conversationOwner=context==='conversation'&&validConversationId(contextId)?contextId:null,conversationRef=useRef(conversationOwner);
 conversationRef.current=conversationOwner;
 projectRef.current=snapshot?.project?.id;
 useEffect(()=>{mounted.current=true;try{setPending(loadPending());}catch(e:any){setStorageFailed(true);setError(e.message||'无法读取操作恢复记录。');}return()=>{mounted.current=false;};},[]);
 useEffect(()=>{const p=snapshot?.project;if(!p?.id)return;setForm(f=>({...f,parent:f.parent||snapshot?.projectCatalog?.defaultParent||'',hmiSource:'',oipSource:'',bindingsSource:'',definition:p.interfaceDefinition?JSON.stringify(p.interfaceDefinition,null,2):''}));setConfigBasis({projectId:p.id,revision:p.configuration?.revision??null});},[snapshot?.project?.id]);
 const p=snapshot?.project,sid=snapshot?.session?.id;
 const hasSession=!!snapshot?.session&&Object.hasOwn(snapshot.session,'id')&&(sid===null||typeof sid==='string');
 const catalog=mode==='catalog';
 const oipSection=p?.schemaVersion===3||Object.hasOwn(snapshot?.capabilities||{},'canConfigureOip');
 const action=catalog?form.action:oipSection&&section==='oip'?'project-oip-configure':p?.defaultMode==='fuxa-oip'?'project-configure':'project-interface-configure';
 const capability=action==='project-create'?snapshot?.projectCatalog?.canCreate:action==='project-open'?snapshot?.projectCatalog?.canOpen:action==='project-configure'?snapshot?.capabilities?.canConfigureProject:action==='project-oip-configure'?snapshot?.capabilities?.canConfigureOip:snapshot?.capabilities?.canConfigureInterface;
 const configChanged=!catalog&&(!configBasis||configBasis.projectId!==p?.id||configBasis.revision!==(p?.configuration?.revision??null));
 const disabled=!connected||!p?.id||!hasSession||capability!==true||!!pending||storageFailed||busy||configChanged;
 const unavailableReason=action==='project-create'?'后台未确认支持创建工程。':action==='project-open'?'后台未确认支持登记并打开工程。':(snapshot?.capabilities?.reasons?.[action==='project-configure'?'canConfigureProject':action==='project-oip-configure'?'canConfigureOip':'canConfigureInterface']||'后台未确认支持此操作。');
 const reason=(configChanged?'工程配置版本已变化；请重新载入后检查配置，旧输入不会自动保存。':!connected?'后台未连接。':!p?.id||!hasSession?'工程或运行实例身份未确认。':capability!==true?unavailableReason:pending?'上一次工程操作结果尚未确认，请先核对回执和工程目录。':storageFailed?'无法保存恢复记录，操作已停用。':'');
 const field=(name:string,value:string)=>setForm(f=>({...f,[name]:value}));
 function persist(value:any){if(value)window.localStorage.setItem(KEY,JSON.stringify(value));else window.localStorage.removeItem(KEY);setPending(value);}
 async function notifyChanged(result:any,origin:string,originConversation:string|null){
  // A recovered global or foreign-chat operation may confirm its receipt, but
  // cannot reinterpret that old intent as a choice for the current conversation.
  if(context==='conversation'&&!conversationRef.current||projectRef.current!==origin||conversationRef.current!==originConversation||!mounted.current)return;
  try{await onChanged?.(result);}catch{if(mounted.current)setError('工程操作已完成，当前界面尚未同步，请重新读取工程目录。');}
 }
 async function consume(value:any){
  if(!confirmedReceipt(value,pending)){setError('结果仍未确认；请检查工程目录与配置，勿重复提交。');return;}
  const origin=pending?.projectId,originConversation=pending?.conversationId??null;persist(null);setNotice('操作结果已确认；请核对工程内容。');await notifyChanged(value.result,origin,originConversation);
 }
 async function check(){
  if(!pending||lock.current)return;lock.current=true;setBusy(true);setNotice('正在读取原请求回执…');
  try{const result=await conversationApi('project-operations?requestId='+encodeURIComponent(pending.requestId));if(mounted.current)await consume(result);}
  catch{if(mounted.current)setError('无法确认原请求结果；请检查工程目录与配置，勿重复提交。');}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 }
 function reloadConfiguration(){if(!p?.id||busy)return;setForm(f=>({...f,hmiSource:'',oipSource:'',bindingsSource:'',definition:p.interfaceDefinition?JSON.stringify(p.interfaceDefinition,null,2):''}));setConfigBasis({projectId:p.id,revision:p.configuration?.revision??null});setNotice('已载入当前工程配置，请检查后再保存。');}
 function acknowledge(){try{persist(null);setError('已解除本地等待限制；原请求记录仍在后台。开始新操作前请确认原结果。');}catch{setStorageFailed(true);setError('无法更新本地恢复记录，操作仍停用。');}}
 async function submit(event:React.FormEvent){
  event.preventDefault();if(disabled||lock.current)return;
  const currentProject=p.id,requestId=crypto.randomUUID();let body:any={requestId,projectId:currentProject,sessionId:sid,action};
  if(action==='project-create')body={...body,name:form.name.trim(),parent:form.parent.trim(),language:form.language,simulation:form.simulation,...(form.source.trim()?{source:form.source.trim()}:{})};
  else if(action==='project-open')body={...body,manifestPath:form.manifestPath.trim()};
  else if(action==='project-oip-configure')body={...body,configurationRevision:configBasis.revision,source:form.oipSource.trim()};
  else if(action==='project-configure')body={...body,configurationRevision:configBasis.revision,bindingsSource:form.bindingsSource.trim(),...(form.hmiSource.trim()?{hmiSource:form.hmiSource.trim()}:{}),...(form.oipSource.trim()?{oipSource:form.oipSource.trim()}:{})};
  else {try{body={...body,configurationRevision:configBasis.revision,definition:JSON.parse(form.definition),...(form.hmiSource.trim()?{hmiSource:form.hmiSource.trim()}:{})};}catch{setError('变量与操作声明不是有效 JSON。');return;}}
  const target=action==='project-create'?'父目录：'+body.parent+' · 新文件夹：'+body.name:action==='project-open'?'工程文件：'+body.manifestPath:'工程文件：'+(p.manifestPath||p.name||currentProject);
  lock.current=true;setBusy(true);setError('');
  try{persist({requestId,projectId:currentProject,action,target,...(conversationOwner?{conversationId:conversationOwner}:{})});}catch{lock.current=false;setBusy(false);setStorageFailed(true);setError('无法保存恢复记录，未发送操作。');return;}
  try{
   const result=await conversationApi('project-operations',body,160000);
   if(!mounted.current)return;
   if(confirmedReceipt(result,{requestId,projectId:currentProject,action})){persist(null);setNotice('操作结果已确认；请核对工程内容。');await notifyChanged(result.result,currentProject,conversationOwner);}
   else setError('结果尚未确认，请核对原请求与工程目录，勿重复提交。');
  }catch(e:any){if(mounted.current){if([400,403,413].includes(e?.httpStatus)){try{persist(null);setError(e.message||'请求未发送，请检查表单。');}catch{setStorageFailed(true);setError('请求被拒绝，但无法清除本地恢复记录，请核对后处理。');}}else setError('操作结果尚未确认，请核对原请求与工程目录，勿重复提交。');}}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 }
 return <section className={'pc-operations'+(catalog?'':' pc-operations-advanced')} aria-label={catalog?'工程管理':'工程配置'}>
  <style>{`
.pc-operations{--op-line:var(--dsw-alias-border-l2,#dfe5ec);--op-muted:var(--dsw-alias-label-secondary,#657184);color:var(--dsw-alias-label-primary,#243247);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--op-line);border-radius:12px;padding:24px;min-width:0;overflow-wrap:anywhere;font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);box-sizing:border-box;container-type:inline-size}.pc-operations summary{font-size:14px;font-weight:600;cursor:pointer;line-height:24px}.pc-operations form{margin-top:24px}.pc-operations label{display:grid;gap:8px;font-size:13px;font-weight:500}.pc-operations :is(input,select,textarea){font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--op-line);border-radius:7px;min-height:40px;min-width:0;max-width:100%;padding:8px 10px!important}.pc-operations textarea{font:12px/1.7 var(--ds-font-family-code,monospace);resize:vertical}.pc-operations p{font-size:13px;color:var(--op-muted);line-height:1.7;margin:0}.pc-operations>p,.pc-operations>:is([role=status],[role=alert]){margin-bottom:20px}.pc-operations :is([role=status],[role=alert]){border-left:3px solid var(--op-line);padding:10px 14px;background:var(--dsw-alias-bg-module-platform,#f4f6f9);border-radius:6px}.pc-operations [data-tone=warning]{border-left-color:#bd893c}.pc-operations button{font:inherit;font-size:13px;min-height:36px;padding:6px 12px;border:1px solid var(--op-line);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;cursor:pointer;justify-self:start}.pc-operations button:disabled{opacity:.46;cursor:default}.pc-operations button[type=submit]{background:var(--plcdev-accent,#7653bc);border-color:var(--plcdev-accent,#7653bc);color:var(--plcdev-on-accent,#fff)}.pc-operations button[type=submit]:hover:not(:disabled){filter:brightness(.94)}.pc-operations :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--plcdev-accent,#7653bc);outline-offset:3px}
@container(max-width:540px){.pc-operations form{gap:16px!important}.pc-operations summary{font-size:13px}}@media(max-width:640px){.pc-operations{padding:18px 16px}}

.pc-operations summary{list-style:none;display:flex;align-items:center;gap:10px}.pc-operations summary::-webkit-details-marker{display:none}.pc-operations summary:before{content:'';display:inline-block;width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);margin-right:2px}.pc-operations details[open]>summary:before{transform:rotate(135deg)}
.pc-operations.pc-operations-advanced{background:transparent;border-color:transparent;padding:14px 4px}.pc-operations-advanced>details>summary{font-size:13px;font-weight:500;color:var(--op-muted)}.pc-operations-advanced>details>p{margin-top:12px}.pc-operations-advanced form{margin-top:16px}
`}</style>
  {pending&&<div role="status" data-tone="warning"><strong>工程操作待核对</strong><p>原工程：{pending.projectId} · 请求编号：{pending.requestId}。结果未知时不会自动重发。{pending.target&&<span> {pending.target}</span>}</p><button disabled={busy} onClick={check}>核对原请求</button> <button disabled={busy} onClick={acknowledge}>已核对目录，允许新操作</button><p>解除限制不会撤销或重发原操作；请先检查工程目录及配置。</p></div>}
  {error&&<p role={feedback.tone==='warning'?'alert':'status'} data-tone={feedback.tone}>{error}</p>}
  <details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{catalog?'新建、导入或打开工程':'高级配置 · 画面、场景与变量'}</summary>
   {!catalog&&<p>手动导入资源或编辑绑定，保存将直接更新当前工程。日常修改可在 DSH 对话中完成。</p>}
   {!catalog&&oipSection&&<div role="group" aria-label="配置内容" style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:16}}><button type="button" aria-pressed={section!=='oip'} disabled={busy||!!pending} onClick={()=>setSection('interface')}>变量与画面</button><button type="button" aria-pressed={section==='oip'} disabled={busy||!!pending} onClick={()=>setSection('oip')}>关联 OIP 场景</button></div>}
   <form style={styles} onSubmit={submit}>
    {catalog?<><label>操作 <select value={form.action} onChange={e=>field('action',e.target.value)}><option value="project-create">新建／导入 OpenPLC 工程</option><option value="project-open">打开已有 PLCdev 工程</option></select></label>
     {action==='project-create'?<><label>工程名称<input style={textInput} required maxLength={80} value={form.name} onChange={e=>field('name',e.target.value)}/></label><label>工程父目录（绝对路径）<input style={textInput} required value={form.parent} onChange={e=>field('parent',e.target.value)}/></label><label>导入 OpenPLC 目录（绝对路径，可留空）<input style={textInput} value={form.source} onChange={e=>field('source',e.target.value)}/></label><label>初始语言 <select value={form.language} onChange={e=>field('language',e.target.value)} disabled={!!form.source.trim()}><option value="st">结构化文本 ST</option><option value="ld">梯形图 LD</option></select></label><label>仿真工具意向 <select value={form.simulation} onChange={e=>field('simulation',e.target.value)}><option value="none">暂不选择</option><option value="oip">OIP</option><option value="factoryio">Factory I/O</option></select></label><p>{form.source.trim()?'将原生源文件复制为独立工程。':form.language==='st'?'创建 ST 工程，再进入工程会话描述程序、变量和画面需求。':'创建 LD 工程，可在工程会话中用 AI 修改触点、线圈和受支持的功能块。'}{context==='conversation'?'创建后用于当前对话，已有目录不会被覆盖。':'已有目录不会被覆盖；创建后可新建关联会话。'}</p></>:<><label>工程定义文件（绝对路径）<input style={textInput} required value={form.manifestPath} onChange={e=>field('manifestPath',e.target.value)}/></label><p>{context==='conversation'?'登记后用于当前对话。':'登记已有工程并查看；不会改绑对话或启动运行。'}</p></>}
    </>:action==='project-oip-configure'?<><label>OIP 工程目录或 project.json（绝对路径）<input style={textInput} required value={form.oipSource} onChange={e=>field('oipSource',e.target.value)} placeholder="F:\\我的工程\\OIP\\project.json"/></label><p>导入场景到当前工程。不会启动仿真或建立 PLC 通信。</p></>:action==='project-configure'?<><label>FUXA 画面源文件（绝对路径；已有配置可留空）<input style={textInput} value={form.hmiSource} onChange={e=>field('hmiSource',e.target.value)}/></label><label>OIP 场景源文件（绝对路径；已有配置可留空）<input style={textInput} value={form.oipSource} onChange={e=>field('oipSource',e.target.value)}/></label><label>绑定 JSON 文件（绝对路径）<input style={textInput} required value={form.bindingsSource} onChange={e=>field('bindingsSource',e.target.value)}/></label><p>保存画面、场景和绑定的新工程配置；首次配置需要全部源文件。</p></>:<><label>变量与操作声明（project-interface-v1 JSON）<textarea style={{...textInput,minHeight:180}} required value={form.definition} onChange={e=>field('definition',e.target.value)}/></label><label>导入 FUXA 画面（绝对路径；留空生成声明画面）<input style={textInput} value={form.hmiSource} onChange={e=>field('hmiSource',e.target.value)}/></label><p>保存变量、操作和工程画面；后台会校验声明及画面引用。</p></>}
    {reason&&<p role="status" data-tone="warning">{reason}</p>}
    {configChanged&&<button type="button" disabled={!connected||busy} onClick={reloadConfiguration}>放弃旧输入并重新载入当前配置</button>}
    <button type="submit" disabled={disabled}>{busy?'正在处理…':action==='project-create'?'创建工程':action==='project-open'?'登记并打开工程':action==='project-configure'?'保存画面、场景与绑定':action==='project-oip-configure'?'保存场景关联':'保存变量、操作与画面'}</button>
   </form>
  </details>
 </section>;
}
