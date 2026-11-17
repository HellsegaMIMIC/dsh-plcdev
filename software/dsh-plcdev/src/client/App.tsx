import {BrandTitle} from './Brand';
import {conversationApi as api} from './conversation-client.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { createReadGate, validateSnapshot, validateTasks, readPending, persistPending, definitiveFailure, canUseTool, externalRuntimeOwner, runtimeOwnerLabel, graphEntities, taskStatus, selectionKey } from './model.mjs';
import { eezLogo } from './assets';
import {ToolLogo} from './ToolLogo';
import { styles } from './styles';
import { ProjectList, ConversationProjectPicker } from './ProjectList';
import { ProjectSessions } from './ProjectSessions';
import { RuntimePane } from './RuntimePane';
import {RuntimeSummary} from './RuntimeRelation';
import { ProjectOperations } from './ProjectOperations';
import { overviewLinks, overviewResources, displayValue } from './overview-model.mjs';
import { ConversationReview } from './Conversation';
import { RuntimeActivity } from './RuntimeActivity';
import { BackendConnection } from './BackendConnection';
import { isBackendDisconnected, backendReadError } from './backend-state.mjs';
import { readWorkspace, rememberWorkspace, projectLocationFor, workspaceLocation } from './workspace-navigation.mjs';
import { workspaceStyles } from './workspace-styles';
import { useProjectInspection, ProjectSignalList, ProjectSignalDetail, ProjectReadback } from './ProjectSignals';
import {EditorSessionPicker} from './EditorSessionPicker';
import {openResultInEditor,editorOpenNotice} from './result-flow.mjs';
import {ToolDownloads,ToolDownloadEntry} from './ToolDownloads';

const memoryStorage = { getItem: (_: string) => null, setItem: (_: string, __: string) => { throw new Error('本地存储不可用'); } };
function storage() { try { return window.localStorage; } catch { return memoryStorage; } }
function initialProject() { try { return readWorkspace(storage()).current?.projectId || storage().getItem(selectionKey) || ''; } catch { return ''; } }
const short = (value: any) => String(value || '').replace(/\\/g, '/').split('/').pop();
const phaseLabel: any = { idle: '尚未准备', building: '编译准备中', ready: '实例就绪', stopping: '正在结束', ended: '已结束', fault: '需要处理' };
const recoveryReason:any={pending:'请在原 FUXA 面板核对。旧版保留会写回当前 HMI 文件，撤销会恢复生成前内容；不会创建独立工程副本。',source_checkpoint_missing:'旧预览缺少源版本检查点；请先在 FUXA 核对基线。保留会写回当前 HMI 文件，不创建副本。',config_changed:'旧预览所属的工程配置已变化；请保留原事务并核对工程归属。',source_changed:'工程画面在预览后已变化；请保留原事务并核对源画面。',write_outcome_unknown:'上次写回结果未知；请保留现场核对，不要重试写回或撤销。',undo_outcome_unknown:'上次撤销预览的结果未知；请保留现场核对，不要重试写回或撤销。',transaction_outcome_unknown:'旧事务处理结果无法确认；请保留现场核对，不要重试写回或撤销。',native_write_unknown:'上次 FUXA 原生保存的结果未知；请保留现场并核对原生画面、设备设置和工程文件，不要重复保存或处理预览。',not_supported:'本工程的受管 FUXA 状态尚未提供。',transaction_unreadable:'事务记录或工程归属无法核对；请保留原记录。'};
function Glyph({ kind = 'project', size = 24 }: { kind?: string; size?: number }) {
  const paths: any = { project: 'M3 20V5h6l2 3h10v12Z', runtime: 'M6 6h12v12H6ZM9 9h6v6H9ZM8 2v4m8-4v4M8 18v4m8-4v4M2 8h4m-4 8h4m12-8h4m-4 8h4', scene: 'M3 16h18v5H3Zm3-8h5v6H6Zm8-5h5v11h-5M6 18v1m4-1v1m4-1v1m4-1v1', hmi: 'M3 3h18v14H3ZM12 17v4m-5 0h10M6 7h6m-6 4h3m4-4h5v6h-5', fuxa: 'M4 21V3h16M4 11h13', link: 'M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6', tasks: 'M6 3h15v18H6ZM3 7h6m-6 5h6m-6 5h6M12 7h6m-6 5h6m-6 5h6', open: 'M14 3h7v7M21 3 10 14M10 3H4v17h17v-6' };
  if (['plc','openplc','fuxa','oip'].includes(kind)) return <ToolLogo tool={kind} size={size}/>;
  if (kind === 'eez') return <img className="pd-logo" width={size} height={size} src={eezLogo} alt="" />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind] || paths.project}/></svg>;
}

export function App({contexts,projectContexts,hostSessions,openSession,getPicker,closePicker,onCreateSession,onCarryReference,onReturnToSession,onContinueRetained,onOpenEditorSession,onOpenResultResource,runtimeActivity,onOpenRuntime,getWorkspaceIntent,clearWorkspaceIntent}:any = {}) {
  const workspace=useRef(readWorkspace(storage()));
  const initialIntent=useRef(workspaceLocation(getWorkspaceIntent?.()));
  const [view,setView]=useState(()=>initialIntent.current?.view||workspace.current.current?.view||'resources');
  const [picker,setPicker]=useState<any>(()=>getPicker?.()||null),[catalog,setCatalog]=useState(()=>initialIntent.current?false:workspace.current.catalog);
  const [projectId,setProjectId]=useState(()=>initialIntent.current?.projectId||initialProject());
  const [projects,setProjects]=useState<any[]>([]),[snapshot,setSnapshot]=useState<any>(null),[connected,setConnected]=useState(false);
  const [statusError,setStatusError]=useState(''),[statusCode,setStatusCode]=useState(''),[tasks,setTasks]=useState<any>(null),[taskError,setTaskError]=useState('');
  const [fuxaRecovery,setFuxaRecovery]=useState<any>(null),[selected,setSelected]=useState<string|null>(()=>workspace.current.current?.selected||null);
  const [review,setReview]=useState<any>(()=>workspace.current.current?.review||null),[back,setBack]=useState<any[]>([]),[returnSession,setReturnSession]=useState<string|null>(null);
  const [message,setMessage]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[pendingVersion,setPendingVersion]=useState(0);
  const [environment,setEnvironment]=useState(false),[createdProject,setCreatedProject]=useState<string|null>(null);
  const [editorPicker,setEditorPicker]=useState<any>(null);
  const [configurationSection,setConfigurationSection]=useState('interface');
  const editorOpening=useRef(false);
  const rootElement=useRef<HTMLElement>(null),scrollElement=useRef<HTMLDivElement>(null),[compact,setCompact]=useState(false),[detailHeight,setDetailHeight]=useState(640);
  const opener=useRef<HTMLElement|null>(null),detailOrigin=useRef<any>(null),pendingRestore=useRef<any>(workspace.current.current),catalogOrigin=useRef<any>(null),lastScroll=useRef(0),creating=useRef(false);
  const location=()=>workspaceLocation({projectId,view,selected,review,scroll:scrollElement.current?.scrollTop??lastScroll.current});
  const locationRef=useRef<any>(null);locationRef.current={projectId,view,selected,review,catalog};
  const gate=useRef(createReadGate()),pending=useRef(readPending(storage())),pendingBusy=useRef(new Set<string>());
  const activeRef=useRef<any>({projectId,snapshot:null,connected:false}),client=useRef('dsh-'+crypto.randomUUID()),sequence=useRef(0),alive=useRef(true);
  const inspection=useProjectInspection(projectId,connected&&projectId!=='catalog');
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;gate.current.select('');};},[]);
  useEffect(()=>{setEditorPicker(null);setConfigurationSection('interface');},[projectId]);
  useEffect(()=>{const update=()=>{const next=getPicker?.()||null;if(next&&scrollElement.current){const origin=workspaceLocation({...locationRef.current,scroll:scrollElement.current.scrollTop});if(origin){lastScroll.current=origin.scroll;pendingRestore.current=origin;workspace.current=rememberWorkspace(storage(),workspace.current,origin,false);}}setPicker(next);};window.addEventListener('plcdev:picker-changed',update);return()=>window.removeEventListener('plcdev:picker-changed',update);},[getPicker]);
  useEffect(()=>{const node=rootElement.current,content=scrollElement.current;if(!node)return;const resize=()=>{setCompact(node.clientWidth<760);if(content?.clientHeight){const style=getComputedStyle(content);setDetailHeight(Math.max(1,content.clientHeight-parseFloat(style.paddingTop||'0')-parseFloat(style.paddingBottom||'0')));}};resize();const observer=new ResizeObserver(resize);observer.observe(node);if(content)observer.observe(content);return()=>observer.disconnect();},[catalog,picker]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape'||picker)return;if(environment)setEnvironment(false);else if(catalog&&catalogOrigin.current)cancelCatalog();else if(review||selected)closeDetail();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[picker,environment,catalog,review,selected]);
  useEffect(()=>{const applyIntent=(detail:any)=>{const id=detail?.projectId;if(typeof id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(id))return;if(detail.restore===true)restoreLocation(detail);else {switchProject(id,detail.view||'resources',true);if(typeof detail.selected==='string'&&detail.selected.length<=240)setSelected(detail.selected);}setReturnSession(typeof detail.returnTo?.sessionId==='string'?detail.returnTo.sessionId:null);clearWorkspaceIntent?.(detail);};const select=(event:Event)=>applyIntent((event as CustomEvent).detail);window.addEventListener('plcdev:select-project',select);const intent=getWorkspaceIntent?.();if(intent)applyIntent(intent);return()=>window.removeEventListener('plcdev:select-project',select);},[projectId,view,selected,review,getWorkspaceIntent,clearWorkspaceIntent]);
  useEffect(()=>{const restoring=pendingRestore.current,current=restoring?.projectId===projectId&&restoring.view===view?restoring:location();if(current)workspace.current=rememberWorkspace(storage(),workspace.current,current,catalog);},[projectId,view,selected,review,catalog]);
  useEffect(()=>()=>{const current=pendingRestore.current||workspaceLocation({...locationRef.current,scroll:scrollElement.current?.scrollTop??lastScroll.current});if(current)workspace.current=rememberWorkspace(storage(),workspace.current,current,locationRef.current.catalog);},[]);
  // Viewing another project only changes the UI. No binding or Runtime command is sent.
  useEffect(()=>{
    gate.current.select(projectId);let disposed=false,statusTimer:any,taskTimer:any;
    setSnapshot(null);setConnected(false);setTasks(null);setStatusError('');setStatusCode('');setTaskError('');setMessage('');setBusy(false);
    activeRef.current={projectId,snapshot:null,connected:false};
    if(projectId){try{storage().setItem(selectionKey,projectId);}catch{}}
    async function readStatus(){
      const ticket=gate.current.begin('status');
      try{
        const requested=projectId==='catalog'?'':projectId;
        const value=validateSnapshot(await api('status'+(requested?'?project='+encodeURIComponent(requested):'')),requested);
        if(disposed||!gate.current.accepts(ticket))return;
        setProjects(value.projects);if(value.catalogOnly)setCatalog(true);if(!projectId||projectId==='catalog'&&value.project.id!=='catalog'){setProjectId(value.project.id);return;}
        setSnapshot(value);setConnected(true);setStatusError('');setStatusCode('');activeRef.current={projectId,snapshot:value,connected:true};
      }catch(error:any){
        if(disposed||!gate.current.accepts(ticket))return;
        setSnapshot(null);setConnected(false);setStatusCode(error.code||'');setStatusError(error.name==='AbortError'?'后台响应超时，操作暂不可用。':backendReadError(error));activeRef.current={projectId,snapshot:null,connected:false};
        // A removed or migrated remembered project must not hide the catalog.
        // Use only the independent listing: never adopt its default project's
        // identity, connection, capabilities or pending operation context.
        if(projectId)try{
          const listing=validateSnapshot(await api('status'),'');
          if(!disposed&&gate.current.accepts(ticket))setProjects(listing.projects);
        }catch{/* Keep the original failure and all operations disabled. */}
      }
      finally{if(!disposed)statusTimer=setTimeout(readStatus,1500);}
    }
    async function readTasks(){
      if(!projectId||projectId==='catalog')return;const ticket=gate.current.begin('tasks');
      try{const value=validateTasks(await api('tasks?project='+encodeURIComponent(projectId),undefined,60000),projectId);if(disposed||!gate.current.accepts(ticket))return;setTasks(value);setTaskError('');}
      catch(error:any){if(disposed||!gate.current.accepts(ticket))return;setTasks(null);setTaskError(error.name==='AbortError'?'修改记录读取超时。':error.message);}
      finally{if(!disposed)taskTimer=setTimeout(readTasks,3000);}
    }
    readStatus();readTasks();return()=>{disposed=true;clearTimeout(statusTimer);clearTimeout(taskTimer);};
  },[projectId,refresh]);
  const hasFuxa=!!snapshot&&['fuxa-oip','fuxa-local'].includes(snapshot.project?.defaultMode);
  useEffect(()=>{
    let disposed=false,timer:any;setFuxaRecovery(null);if(!projectId||!hasFuxa)return;
    async function readRecovery(){
      const ticket=gate.current.begin('fuxa-recovery');
      try{const result=await api('fuxa-recovery?project='+encodeURIComponent(projectId));if(disposed||!gate.current.accepts(ticket))return;
        if(result.ok!==true||result.projectId!==projectId||!['none','pending','conflict','unavailable'].includes(result.state)||(result.state!=='none'&&!recoveryReason[result.reasonCode]))throw new Error('旧预览归属或状态未确认。');setFuxaRecovery(result);
      }catch{if(!disposed&&gate.current.accepts(ticket))setFuxaRecovery({projectId,state:'unavailable',reasonCode:'transaction_unreadable'});}
      finally{if(!disposed)timer=setTimeout(readRecovery,5000);}
    }
    readRecovery();return()=>{disposed=true;clearTimeout(timer);};
  },[projectId,refresh,hasFuxa]);
  const [,tick]=useState(0);useEffect(()=>{const id=setInterval(()=>tick(n=>n+1),750);return()=>clearInterval(id);},[]);
  function saveLocation(){const current=location();pendingRestore.current=null;if(current){lastScroll.current=current.scroll;workspace.current=rememberWorkspace(storage(),workspace.current,current,catalog);}return current;}
  function cancelPendingRestore(){if(!pendingRestore.current)return;saveLocation();}
  function restoreLocation(target:any){const valid=workspaceLocation(target);if(!valid)return;detailOrigin.current=null;lastScroll.current=valid.scroll;pendingRestore.current=valid;setCatalog(false);setView(valid.view);setSelected(valid.selected);setReview(valid.review);if(valid.projectId!==projectId){gate.current.select(valid.projectId);activeRef.current={projectId:valid.projectId,snapshot:null,connected:false};setSnapshot(null);setConnected(false);setTasks(null);setMessage('');setProjectId(valid.projectId);}}
  function switchProject(id:string,targetView?:string,record=true){
    if(!id||!/^[a-z][a-z0-9-]{0,63}$/.test(id))return;const origin=catalogOrigin.current||saveLocation();catalogOrigin.current=null;
    if(record&&origin&&origin.projectId!==id)setBack(items=>[...items,origin].slice(-8));
    const target=projectLocationFor(workspace.current,id,targetView);if(target)restoreLocation(target);
  }
  function changeView(next:string){saveLocation();restoreLocation(projectLocationFor(workspace.current,projectId,next));}
  function openCatalog(){catalogOrigin.current=saveLocation();opener.current=document.activeElement as HTMLElement;setCatalog(true);}
  function cancelCatalog(){const origin=catalogOrigin.current;catalogOrigin.current=null;if(origin)restoreLocation(origin);requestAnimationFrame(()=>{if(opener.current?.isConnected)opener.current.focus();else rootElement.current?.querySelector<HTMLElement>('.pd-project-switch')?.focus({preventScroll:true});});}
  function closeDetail(){const origin=detailOrigin.current;detailOrigin.current=null;setReview(null);setSelected(null);requestAnimationFrame(()=>{if(origin?.projectId===projectId&&origin.view===view&&scrollElement.current){scrollElement.current.scrollTop=origin.scroll;lastScroll.current=origin.scroll;}const focus=origin?.element||opener.current;if(focus?.isConnected)focus.focus({preventScroll:true});});}
  function rememberDetailOrigin(){pendingRestore.current=null;opener.current=document.activeElement as HTMLElement;detailOrigin.current={projectId,view,scroll:scrollElement.current?.scrollTop||0,element:opener.current};}
  function showResource(id:string){rememberDetailOrigin();setReview(null);setSelected(id);}
  function showReview(target:any){if(target?.projectId!==projectId||!target.sessionId||!target.taskId)return;rememberDetailOrigin();setSelected(null);setReview(target);}
  async function navigateSession(target:any){saveLocation();window.dispatchEvent(new CustomEvent('plcdev:workspace-origin',{detail:{...location(),sessionId:target.sessionId}}));const result=await openSession?.(target);if(result&&result.ok!==true)setMessage(result.message||'会话跳转结果未确认。');return result||{ok:false,message:'宿主会话导航尚未就绪。'};}
  function rememberSessionOrigin(sessionId?:string){const origin=saveLocation();if(origin)window.dispatchEvent(new CustomEvent('plcdev:workspace-origin',{detail:{...origin,...(sessionId?{sessionId}:{})}}));}
  async function createSession(){if(creating.current||!onCreateSession||!projectId)return;creating.current=true;rememberSessionOrigin();const current=projectId;try{const result=await onCreateSession(projectId);if(alive.current&&activeRef.current.projectId===current&&result?.ok===false)setMessage(result.message||'新会话创建结果未确认。');}catch(e:any){if(alive.current&&activeRef.current.projectId===current)setMessage(e.message||'新会话创建结果未确认。');}finally{creating.current=false;}}
  async function carryReference(id:string,reference:any){if(!onCarryReference||id!==projectId)return {ok:false,message:'当前工程已变化，请重新选择信号。'};rememberSessionOrigin();return onCarryReference(id,reference);}
  function goBack(){const target=back.at(-1);if(target){setBack(items=>items.slice(0,-1));restoreLocation(target);}}
  useEffect(()=>{
    if(catalog||picker||!snapshot||snapshot.project?.id!==projectId)return;
    const saved=pendingRestore.current;if(saved?.projectId!==projectId||saved.view!==view)return;
    // Status arrives before saved signal/readback data. Restoring against that
    // shorter DOM clamps scrollTop and loses the user's origin permanently.
    if(view==='resources'&&((tasks?.projectId!==projectId&&!taskError)||(!inspection.data&&!inspection.error)||(hasFuxa&&fuxaRecovery?.projectId!==projectId)))return;
    requestAnimationFrame(()=>{if(pendingRestore.current!==saved||!scrollElement.current)return;pendingRestore.current=null;scrollElement.current.scrollTop=saved.scroll;lastScroll.current=scrollElement.current.scrollTop;if(saved.selected)[...(rootElement.current?.querySelectorAll<HTMLElement>('[data-resource]')||[])].find(node=>node.dataset.resource===saved.selected)?.focus({preventScroll:true});});
  },[snapshot,projectId,catalog,picker,view,tasks,taskError,inspection.data,inspection.error,hasFuxa,fuxaRecovery]);
  async function openLinkedEditor(conversationId:string,explicitProject=projectId){
    if(editorOpening.current)return;
    editorOpening.current=true;
    const ticket=gate.current.begin('action');setBusy(true);setMessage('正在连接工程会话并打开 OpenPLC…');
    try{const result=await openResultInEditor({api,conversationId,projectId:explicitProject,target:'project',isCurrent:()=>alive.current&&gate.current.accepts(ticket),onState:(value:any)=>setMessage(editorOpenNotice(value))});
      if(alive.current&&gate.current.accepts(ticket)){setEditorPicker(null);if(result.state==='requested')setMessage('已请求打开，OpenPLC 尚未确认工程加载。');}
    }catch(error:any){if(alive.current&&gate.current.accepts(ticket))setMessage(error?.message||'编辑器连接未能确认。');}
    finally{editorOpening.current=false;if(alive.current&&gate.current.accepts(ticket))setBusy(false);}
  }
  async function createEditorSession(){
    if(creating.current||!onCreateSession||!editorPicker)return;
    const p=editorPicker.projectId;creating.current=true;setBusy(true);rememberSessionOrigin();
    try{const result=await onCreateSession(p);if(!result?.ok||!result.sessionId)throw new Error(result?.message||'新会话尚未确认，未打开编辑器。');await openLinkedEditor(result.sessionId,p);}
    catch(error:any){if(alive.current&&activeRef.current.projectId===p)setMessage(error?.message||'新会话连接未能确认。');}
    finally{creating.current=false;if(alive.current&&activeRef.current.projectId===p)setBusy(false);}
  }
  async function openEntity(entity:any,standalone=false){
    const context=activeRef.current,p=context.projectId,s=context.snapshot;if(busy||!context.connected||s?.project?.id!==p)return;
    if(entity.tool&&!canUseTool(s,p,entity.tool,true))return;
    if(entity.tool==='plc'&&!standalone&&(contexts||onCreateSession)){
      const sid=returnSession||contexts?.activeSession?.();
      const binding=sid?contexts?.get?.(sid)?.snapshot?.()?.binding:null;
      if(sid&&binding?.projectId===p)await openLinkedEditor(sid,p);
      else setEditorPicker({projectId:p,entity});
      return;
    }
    const body:any={projectId:p,sessionId:s.session?.id??s.sessionId??null,client:client.current,sequence:++sequence.current,expires:Date.now()/1000+12};
    if(entity.tool){if(!canUseTool(s,p,entity.tool,true))return;body.action='tool';body.tool=entity.tool;}
    else if(entity.hmi){const cap=s.hmiOpen&&!entity.fuxa?'canReconnectHmi':'canShowHmi';if(!s.capabilities?.[cap])return;body.action=entity.fuxa?'open-hmi':s.hmiOpen?'reopen-hmi':'show-hmi';}else return;
    const ticket=gate.current.begin('action');setBusy(true);setMessage('正在打开 '+entity.title+'…');
    try{const result=await api('action',body,30000);if(!result.ok)throw new Error('服务未确认入口打开结果。');if(alive.current&&gate.current.accepts(ticket))setMessage('已请求打开 '+entity.title+'，请在工具窗口中查看。');}
    catch(error:any){if(alive.current&&gate.current.accepts(ticket))setMessage(definitiveFailure(error)?'未能打开：'+error.message:'打开结果尚未确认，请检查工具窗口。'+error.message);}
    finally{if(alive.current&&gate.current.accepts(ticket))setBusy(false);}
  }
  // Compatibility recovery only: never manufacture a new legacy request.
  async function resumeLegacyRequest(){
    const {projectId:p,snapshot:s,connected:online}=activeRef.current,body=pending.current.get(p);
    if(!online||s?.project?.id!==p||tasks?.projectId!==p||!tasks.projectRevision||!body||pendingBusy.current.has(p))return;
    const ticket=gate.current.begin('legacy-recovery');pendingBusy.current.add(p);setPendingVersion(n=>n+1);setMessage('正在按原编号恢复旧请求…');
    try{
      const result=await api('tasks',body,65000);
      if(result.task?.projectId!==p||!result.task?.taskId)throw new Error('服务未确认同一工程的任务身份。');
      const remaining=new Map(pending.current);remaining.delete(p);persistPending(storage(),remaining);pending.current=remaining;
      if(alive.current&&gate.current.accepts(ticket)){setMessage('旧请求结果已确认，可在兼容记录中查看。');setRefresh(n=>n+1);}
    }catch(error:any){if(alive.current&&gate.current.accepts(ticket))setMessage('旧请求尚未核对完成，原编号与内容已保留。'+error.message);}
    finally{pendingBusy.current.delete(p);if(alive.current)setPendingVersion(n=>n+1);}
  }
  useEffect(()=>{if(!selected&&!review)return;const frame=requestAnimationFrame(()=>{const aside=rootElement.current?.querySelector<HTMLElement>('.pd-workspace-aside'),content=scrollElement.current;if(!aside)return;aside.scrollTop=0;aside.querySelector<HTMLElement>('button')?.focus({preventScroll:true});if(compact&&content&&detailOrigin.current){const header=aside.querySelector<HTMLElement>('header,.pc-review-toolbar')||aside;content.scrollTop+=header.getBoundingClientRect().top-content.getBoundingClientRect().top-12;}});return()=>cancelAnimationFrame(frame);},[selected,review,compact]);
  const current=snapshot?.project||projects.find(p=>p.id===projectId),entities=graphEntities(snapshot),groups=overviewResources(snapshot,tasks),links=overviewLinks(snapshot);
  const detail=entities.find(n=>n.id===selected),selectedLink=links.find(l=>l.id===selected);
  const delivery=['designer','hmi'].includes(selected||'')?links.find(link=>link.key==='generate'):null;
  const deliverySource=entities.find(n=>n.id===delivery?.source),deliveryTarget=entities.find(n=>n.id===delivery?.target);
  const sharedDeliveryFile=deliverySource?.path&&deliveryTarget?.path&&String(deliverySource.path).replaceAll('\\','/').toLowerCase()===String(deliveryTarget.path).replaceAll('\\','/').toLowerCase();
  const readyTasks=connected&&tasks?.projectId===projectId,waiting=pending.current.get(projectId),taskBusy=pendingBusy.current.has(projectId);
  const legacyTasks=tasks?.projectId===projectId?tasks.tasks.filter((t:any)=>!t.workflow||t.workflow==='count-rename-v1'):[];
  const otherSessions=snapshot?.otherSessions||[],externalOwner=externalRuntimeOwner(snapshot);
  const signalId=selected?.startsWith('signal:')?selected.slice(7):null;
  const awaiting=readyTasks?tasks.tasks.filter((task:any)=>task.status==='awaiting_review'&&task.workflow&&task.workflow!=='count-rename-v1'):[];
  const backendDisconnected=isBackendDisconnected({code:statusCode});
  const serviceError=statusError&&<div className="pd-alert" role="alert">{backendDisconnected?<div><strong>工程服务未连接</strong><p style={{margin:'6px 0'}}>暂时无法读取工程与生成候选。</p><BackendConnection onConnected={()=>setRefresh(n=>n+1)}/></div>:<><span>{statusError}</span><button onClick={()=>setRefresh(n=>n+1)}>重新读取</button></>}</div>;
  function requestConversation(){changeView('sessions');}
  const resourceDetail=selected&&(detail||selectedLink)&&<section className="pd-resource-detail" aria-label="资源详情">
    <header><h2><BrandTitle>{selectedLink?.title||detail?.title}</BrandTitle></h2><button aria-label="关闭资源详情" onClick={closeDetail}>×</button></header>
    <dl><dt>{selectedLink?'连接双方':'文件位置'}</dt><dd>{selectedLink?selectedLink.nodes.map((id:string)=>entities.find(n=>n.id===id)?.title||id).join(' ↔ '):displayValue(detail?.path)}</dd>
    {selectedLink&&<><dt>协议</dt><dd>{selectedLink.details?.protocol||(['load','generate'].includes(selectedLink.key)?'文件交付':'未声明')}</dd><dt>端点</dt><dd>{selectedLink.details?.endpoint||'未声明'}</dd></>}</dl>
    {delivery&&<div className="pd-resource-delivery"><h3>画面交付</h3>{sharedDeliveryFile?<p>编辑器与运行画面使用同一文件。</p>:<dl><dt>{selected==='designer'?'运行画面':'编辑工程'}</dt><dd>{displayValue(selected==='designer'?deliveryTarget?.path:deliverySource?.path)}</dd></dl>}<dl><dt>交付方式</dt><dd>{delivery.details?.protocol||'文件交付'}</dd>{delivery.details?.endpoint&&<><dt>端点</dt><dd>{displayValue(delivery.details.endpoint)}</dd></>}</dl></div>}
  </section>;
  const toolDialog=environment&&<ToolDownloads onClose={()=>setEnvironment(false)} onChecked={()=>setRefresh(n=>n+1)}/>;
  if(picker&&contexts)return <><ConversationProjectPicker contexts={contexts} sessionId={picker.sessionId} onReturn={closePicker} snapshot={snapshot} connected={connected} onToolDownloads={()=>setEnvironment(true)}/>{toolDialog}</>;
  if(catalog)return <section className="pd-root pd-catalog plcdev-scope plcdev-rail"><style>{styles+workspaceStyles}</style><RuntimeActivity activity={runtimeActivity} onOpenRuntime={onOpenRuntime} currentProjectId={projectId} currentView="catalog"/><header className="pd-page-toolbar"><h1><BrandTitle>打开工程</BrandTitle></h1><div>{catalogOrigin.current&&<button onClick={cancelCatalog}>取消，返回工程</button>}{projects.length>0&&<button onClick={()=>setEnvironment(true)}>工具下载与安装</button>}<button onClick={()=>setRefresh(n=>n+1)}>刷新清单</button></div></header><p className="pd-catalog-purpose">只切换查看位置，现有会话的关联工程保持。</p>{serviceError}{!projects.length&&<ToolDownloadEntry onOpen={()=>setEnvironment(true)}/>}<ProjectList projects={projects} currentId={projectId} action="打开工程" onChoose={(id:string)=>switchProject(id)}/><ProjectOperations mode="catalog" snapshot={snapshot} connected={connected} onChanged={(result:any)=>{setCreatedProject(result.projectId);switchProject(result.projectId,'resources');setRefresh(n=>n+1);}}/>{toolDialog}</section>;
  return <section ref={rootElement} className={'pd-root pd-workspace plcdev-scope plcdev-rail'+(compact?' pd-compact':'')} data-pending-version={pendingVersion}><style>{styles+workspaceStyles}</style>
    <RuntimeActivity activity={runtimeActivity} onOpenRuntime={onOpenRuntime} currentProjectId={projectId} currentView={view} excludeProjectId={view==='resources'?projectId:undefined}/>
    {(back.length>0||returnSession)&&<div className="pd-workspace-return">{back.length>0&&<button onClick={goBack}>← 返回{projects.find(p=>p.id===back.at(-1).projectId)?.name||'上一工程'}</button>}{returnSession&&onReturnToSession&&<button onClick={()=>{saveLocation();onReturnToSession(returnSession);}}>返回来源会话</button>}</div>}
    <header className="pd-header">
      <div className="pd-project-heading"><button className="pd-project-switch" title="切换查看工程" aria-label="切换查看工程" onClick={openCatalog}><BrandTitle>{current?.name||'正在读取工程…'}</BrandTitle><svg className="pd-project-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><span className="pd-version">{readyTasks?'保存版本 '+tasks.projectRevision.slice(0,8):'版本待确认'}</span></div>
      <div className="pd-header-right"><span className={'pd-connection '+(connected?'good':'')}><i className={'pd-dot '+(connected?'good':'')}/>{connected?'状态已读取':backendDisconnected?'工程服务未连接':statusError?'状态读取失败':'正在连接'}</span><button className="pd-quiet" onClick={()=>setRefresh(n=>n+1)} aria-label="刷新工程状态">刷新</button>{onCreateSession?<button disabled={!projectId} onClick={createSession}>新建工程会话</button>:<button disabled={!projectId} onClick={requestConversation}>选择关联会话</button>}</div>
    </header>
    {editorPicker?.projectId===projectId&&<EditorSessionPicker projectId={projectId} hostSessions={hostSessions} busy={busy} onChoose={(sid:string)=>openLinkedEditor(sid)} onCreate={onCreateSession?createEditorSession:undefined} onStandalone={()=>{const entity=editorPicker.entity;setEditorPicker(null);void openEntity(entity,true);}} onClose={()=>setEditorPicker(null)}/>}
    <nav className="pd-workspace-nav" aria-label="工程导航">
      <div className="pd-nav-primary" role="group" aria-label="主要工作区">{[['resources','工程资源'],['runtime','运行与监视']].map(([id,label])=><button className="plcdev-tab" key={id} aria-current={view===id?'page':undefined} onClick={()=>changeView(id)}><Glyph kind={id==='resources'?'project':'runtime'} size={16}/>{label}</button>)}</div>
      <div className="pd-nav-secondary" role="group" aria-label="工程管理">{[['sessions','关联会话'],['settings','工程设置']].map(([id,label])=><button className="plcdev-tab" key={id} aria-current={view===id?'page':undefined} onClick={()=>changeView(id)}><Glyph kind={id==='sessions'?'tasks':'settings'} size={16}/>{label}</button>)}</div>
    </nav>
    <div ref={scrollElement} onWheel={cancelPendingRestore} onTouchStart={cancelPendingRestore} onKeyDown={event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))cancelPendingRestore();}} onScroll={event=>{if(event.target===scrollElement.current)lastScroll.current=event.currentTarget.scrollTop;}} className="pd-workspace-content">
      {serviceError}
      {message&&<p className="pd-message" role="status">{message}</p>}
      {!!snapshot?.previousToolWindows?.length&&<p className="pd-message" role="status">旧版本工具窗口仍打开，请从工程资源打开当前版本。旧窗口中的未保存编辑仍保留。</p>}
      {snapshot?.savedVersionSync?.state==='blocked'&&<p className="pd-message" role="status">{snapshot.savedVersionSync.message}</p>}
      {waiting&&view!=='settings'&&<div className="pd-alert" role="status"><span>有一条旧版请求结果待核对。</span><button onClick={()=>changeView('settings')}>查看恢复记录</button></div>}
      <div className={'pd-workspace-split'+((resourceDetail||review||signalId)?' has-detail':'')}><div>
      {view==='runtime'?projectContexts?<RuntimePane key={projectId} projectId={projectId} projectRevision={readyTasks?tasks.projectRevision:null} projectContexts={projectContexts} onProject={(_sid:any,id:string)=>switchProject(id,'runtime')} sessionId={null}/>:<p>运行状态服务未就绪。</p>:view==='sessions'?<ProjectSessions projectId={projectId} tasks={tasks} hostSessions={hostSessions} openSession={navigateSession} onReview={showReview} onCreateSession={onCreateSession?createSession:undefined}/>:view==='settings'?<>
        <ProjectOperations mode="configuration" snapshot={snapshot} connected={connected} initialSection={configurationSection} onChanged={()=>setRefresh(n=>n+1)}/>
        <section className="pd-settings-details"><h2 style={{fontSize:15,margin:'0 0 12px'}}>工具环境</h2><button onClick={()=>setEnvironment(true)}>工具下载与安装</button></section>
        <details className="pd-settings-details"><summary>开发环境与诊断</summary>{snapshot?.dependencies?.length>0&&<details><summary>工程依赖检测</summary><dl>{snapshot.dependencies.map((dependency:any)=><React.Fragment key={dependency.id}><dt>{dependency.label||dependency.id}</dt><dd>{dependency.available===true?'入口已找到':dependency.available===false?'未找到':'未检测'}<br/><code>{dependency.path}</code></dd></React.Fragment>)}</dl></details>}<dl><dt>工程位置</dt><dd>{current?.manifestPath||'未提供'}</dd><dt>工程标识</dt><dd>{projectId}</dd></dl>{taskError&&<p role="status">{taskError}</p>}<p>运行报错与历史事件统一在“运行与监视 → 运行事件”查看。</p></details>
        {(waiting||legacyTasks.length>0)&&<details className="pd-settings-details" open={!!waiting}><summary>旧版请求与兼容记录</summary>
          {waiting&&<div className="pd-legacy-recovery" role="status"><strong>旧版请求结果待核对</strong><p>{waiting.request}</p><details><summary>原请求信息</summary><dl><dt>请求编号</dt><dd>{waiting.clientRequestId}</dd><dt>源保存版本</dt><dd>{waiting.expectedRevision}</dd></dl></details><p>仅沿用已保存的请求编号和内容恢复，不创建新的修改要求。</p><button disabled={!readyTasks||taskBusy} onClick={resumeLegacyRequest}>{taskBusy?'正在核对…':'按原编号恢复请求'}</button></div>}
          {legacyTasks.length>0&&<><p>旧版规则修改记录仅供核对。新的修改请进入工程对话。</p>{legacyTasks.map((task:any)=><details key={task.taskId}><summary>{task.request||'需求未提供'} · {taskStatus(task.status)}</summary><p>{task.reason||task.message||'结果说明未提供'}</p><p>任务编号：<code>{task.taskId}</code></p></details>)}</>}
        </details>}
      </>:<>
        {createdProject===projectId&&connected&&<div className="pd-work-summary" role="status"><div><strong>工程已就绪</strong><p>进入关联会话描述需求，AI 会读取工程、生成修改候选；审阅后保留到当前工程并编译验证。</p></div>{onCreateSession?<button onClick={createSession}>描述需求，开始 AI 修改</button>:<button onClick={requestConversation}>选择关联会话</button>}<button className="pd-quiet" onClick={()=>setCreatedProject(null)} aria-label="关闭工程就绪提示">×</button></div>}
        {!!awaiting.length&&<div className="pd-work-summary"><div><strong>{awaiting.length} 项修改待审阅</strong><p>按来源会话查看方案，审阅后保留本轮修改。</p></div><button onClick={()=>changeView('sessions')}>查看关联会话</button></div>}
        {hasFuxa&&fuxaRecovery?.projectId===projectId&&fuxaRecovery.state!=='none'&&<div className="pd-recovery-notice" role="status"><strong>{fuxaRecovery.reasonCode==='native_write_unknown'?'FUXA 原生保存结果待核对':fuxaRecovery.state==='pending'?'发现原 FUXA 待处理预览':fuxaRecovery.state==='conflict'?'原 FUXA 预览存在冲突':'原 FUXA 预览状态未确认'}</strong><p>{recoveryReason[fuxaRecovery.reasonCode]}</p><button disabled={busy||!canUseTool(snapshot,projectId,'fuxa',connected)} onClick={()=>openEntity({tool:'fuxa',title:'FUXA'})}>打开 FUXA 检查</button>{!canUseTool(snapshot,projectId,'fuxa',connected)&&<small> 后台尚未确认 FUXA 编辑器入口可用。</small>}</div>}
        <RuntimeSummary snapshot={connected?snapshot:null}/>
        {!!otherSessions.length&&connected&&<div className="pd-ownership">其他运行实例：{otherSessions.map((s:any)=><button key={s.projectId} onClick={()=>switchProject(s.projectId,'runtime')}>{s.projectName||'工程名称未提供'} · 上次状态：{({RUNNING:'PLC 运行中',STOPPED:'PLC 已停止'} as any)[s.runtimeState]||phaseLabel[s.phase]||'待核对'} ↗</button>)}</div>}
        {connected&&externalOwner&&!otherSessions.length&&<p className="pd-ownership">{runtimeOwnerLabel(externalOwner)}<button onClick={()=>changeView('runtime')}>查看运行状态</button></p>}
        {connected&&snapshot?.dependencies?.some((item:any)=>['editor','fuxa','oip'].includes(item.id)&&item.available===false)&&<div className="pd-message" role="status"><span>未找到 {snapshot.dependencies.filter((item:any)=>['editor','fuxa','oip'].includes(item.id)&&item.available===false).map((item:any)=>item.label).join('、')}。</span> <button onClick={()=>setEnvironment(true)}>工具下载与安装</button></div>}
        <div className="pd-resource-list" aria-label="工程资源列表">{!snapshot?<p>工程资源尚未读取。</p>:groups.filter((group:any)=>group.id!=='bindings').map((group:any)=><section className="pd-resource-section" key={group.id}><h2><span className="pd-resource-icon"><Glyph kind={group.id==='hmi'&&hasFuxa?'fuxa':group.id==='scene'&&entities.some(n=>n.tool==='oip')?'oip':group.icon} size={22}/></span>{group.label}</h2><div className="pd-resource-items">{group.items.length?group.items.map((item:any)=>{
          const entity=entities.find(n=>n.id===item.id),allowed=entity?.tool&&canUseTool(snapshot,projectId,entity.tool,connected);
          const hmi=group.id==='hmi'?entities.find(n=>item.nodes.includes(n.id)&&n.hmi):null,hmiCap=snapshot?.hmiOpen&&!hmi?.fuxa?'canReconnectHmi':'canShowHmi',hmiAllowed=connected&&snapshot?.capabilities?.[hmiCap]===true;
          return <div className="pd-resource-row" key={item.id}><div className="pd-resource-name"><strong>{item.title}</strong><span>{item.description}</span></div><div className="pd-resource-actions"><button className="pd-quiet plcdev-link plcdev-tab" data-resource={item.id} onClick={()=>showResource(item.id)} aria-expanded={selected===item.id}>详情</button>{entity?.tool&&<button disabled={busy||!allowed} title={allowed?undefined:snapshot?.capabilities?.reasons?.[entity.tool]||'后台尚未确认此入口可用'} onClick={()=>openEntity(entity)}>打开 {entity.title}</button>}{hmi&&<button disabled={busy||!hmiAllowed} title={hmiAllowed?undefined:snapshot?.capabilities?.reasons?.[hmiCap]||'后台尚未确认运行画面可用'} onClick={()=>openEntity(hmi)}>打开运行画面</button>}</div>{hmi&&!hmiAllowed&&<small className="pd-resource-reason">{snapshot?.capabilities?.reasons?.[hmiCap]||'后台尚未确认运行画面可用。'}</small>}{entity?.tool&&!allowed&&<small className="pd-resource-reason">后台尚未确认此入口可用。</small>}</div>;
        }):<p className="pd-empty-resource">未配置{group.id==='scene'&&Object.hasOwn(snapshot?.capabilities||{},'canConfigureOip')&&<button className="pd-quiet" onClick={()=>{setConfigurationSection('oip');changeView('settings');}}>关联 OIP 场景</button>}</p>}</div></section>)}</div>
        {connected&&<><ProjectSignalList inspection={inspection} selected={selected} onSelect={showResource} connections={links.filter(link=>['variables','io'].includes(link.key))}/><ProjectReadback inspection={inspection}/></>}
      </>}
      </div>{(resourceDetail||review||signalId)&&<aside className="pd-workspace-aside plcdev-scope plcdev-rail" aria-label="工程详情侧栏" style={{'--pd-detail-height':detailHeight+'px'} as React.CSSProperties}>{review?<ConversationReview key={review.sessionId+':'+review.taskId} contexts={contexts} sessionId={review.sessionId} target={review} embedded onClose={closeDetail} onRetainedProject={(id:string)=>switchProject(id,'resources')} onSourceSession={(target:any)=>navigateSession(target)} onContinueRetained={onContinueRetained} onOpenEditorSession={onOpenEditorSession} onOpenResultResource={onOpenResultResource}/>:signalId?<ProjectSignalDetail key={projectId+':'+signalId} inspection={inspection} signalId={signalId} projectName={current?.name} onClose={closeDetail} onCarryReference={onCarryReference?carryReference:undefined}/>:resourceDetail}</aside>}</div>
    </div>
    {toolDialog}
  </section>;
}
