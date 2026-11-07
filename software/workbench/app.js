'use strict';
(() => {
const root=document.getElementById('plcdev-workbench-refined'),$=id=>document.getElementById(id);
const escape=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
 'external-link':'M14 3h7v7M21 3 10 14M10 3H4v17h17v-6','folder-open':'M3 7V4h6l2 3h10v4M3 20l3-9h16l-3 9Z','folder-cog':'M3 20V5h6l2 3h10v5M16 15v6M13 18h6',
 'workflow':'M4 3h6v6H4ZM14 15h6v6h-6ZM7 9v9h7','laptop':'M5 4h14v13H5ZM2 20h20','layers-2':'m12 3 10 5-10 5L2 8ZM2 14l10 5 10-5','plus':'M12 4v16M4 12h16','activity':'M2 12h4l3-8 6 16 3-8h4','list':'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
 'cpu':'M6 6h12v12H6ZM9 9h6v6H9ZM8 2v4m8-4v4M8 18v4m8-4v4M2 8h4m-4 8h4m12-8h4m-4 8h4','monitor':'M2 3h20v14H2ZM12 17v4M7 21h10','boxes':'m12 3 9 5v9l-9 5-9-5V8Zm0 10v9M3 8l9 5 9-5',
 'file-code-2':'M4 2h11l5 5v15H4ZM15 2v6h5M10 12l-3 3 3 3m4-6 3 3-3 3','panels-top-left':'M3 3h18v18H3ZM3 8h18M8 8v13',
 'arrow-down':'M12 3v18m-6-6 6 6 6-6','arrow-left-right':'M3 7h18m-5-5 5 5-5 5M21 17H3m5-5-5 5 5 5','arrow-up-right':'M5 19 19 5M5 5h14v14',
 'circle-check':'M20 7a9 9 0 1 0 1 6M8 11l4 4 9-11','square-check':'M3 3h18v18H3ZM7 12l4 4 7-9','square':'M5 5h14v14H5Z','circle':'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
 'play':'m7 3 14 9-14 9Z','circle-play':'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M10 8l6 4-6 4Z','circle-pause':'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M9 8v8m6-8v8',
 'triangle-alert':'m12 3 10 18H2ZM12 9v5m0 3v1','circle-alert':'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v6m0 3v1','power':'M12 2v10M6 5a9 9 0 1 0 12 0','x':'m5 5 14 14M5 19 19 5','minus':'M4 12h16','settings-2':'M3 6h18M3 18h18M8 3v6m8 6v6'
};
function icon(name){return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.circle)+'"/></svg>';}
root.querySelectorAll('[data-lucide]').forEach(el=>{el.outerHTML=icon(el.dataset.lucide);});
function readCredential(){let value=location.hash.slice(1);try{if(value){sessionStorage.setItem('plcdev-workbench-token',value);history.replaceState(null,'',location.pathname+location.search);}else value=sessionStorage.getItem('plcdev-workbench-token');}catch{if(location.hash)history.replaceState(null,'',location.pathname+location.search);}return value||'';}
let token=readCredential(),connectionState=token?'loading':'missing-auth';
const client='web-'+crypto.randomUUID();let sequence=0,snapshot=null,online=false,polling=null,selected='runtime',confirmEnd=null,actionMessage='',readGeneration=0,selectedProject=new URLSearchParams(location.search).get('project')||'batch-conveyor',projectList=[];
const busyProjects=new Map();
let catalogBusy=false,catalogUncertain=false,monitorSignature='';
let integrationContext=null,integrationBusy=false,integrationUncertain=false;
let interfaceContext=null,interfaceBusy=false,interfaceUncertain=false;
let agentContext=null,agentLoadGeneration=0,agentCreateBusy=false,agentRefreshTimer=null;
const agentOpening=new Set();
const agentPending=loadAgentPending();
function loadAgentPending(){
 try{const saved=JSON.parse(sessionStorage.getItem('plcdev-agent-pending')||'[]');if(!Array.isArray(saved))return new Map();return new Map(saved.filter(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[1]?.projectId===entry[0]&&typeof entry[1]?.clientRequestId==='string'&&typeof entry[1]?.request==='string'&&entry[1].request.length<=4000&&typeof entry[1]?.expectedRevision==='string'&&entry[1]?.executionScope==='proposal').slice(-20));}catch{return new Map();}
}
function saveAgentPending(){try{sessionStorage.setItem('plcdev-agent-pending',JSON.stringify([...agentPending]));}catch{}}

let infoTab='properties',infoCollapsed=false,treeSignature='',treeFocusKey='';
const treeExpanded=new Map(),treeMetadata=new Map();
const routes={generate:['t-eez-out','t-hmi-in'],load:['t-plc-out','t-runtime-in'],variables:['t-hmi-data','t-runtime-data'],io:['t-runtime-io','t-fio-in']};
const pipeNodes={generate:['eez','hmi'],load:['plc','runtime'],variables:['hmi','runtime'],io:['runtime','fio']};
const pipeNames={generate:'生成画面',load:'编译装载',variables:'变量读写',io:'Modbus TCP'};
const PIPE_FRESH_MS=2000,motionQuery=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
let pipeExpiryTimer=null,reducedMotion=motionQuery?.matches===true;
function recent(timestamp){const age=Date.now()-Number(timestamp)*1000;return typeof timestamp==='number'&&Number.isFinite(timestamp)&&timestamp>0&&age>=0&&age<PIPE_FRESH_MS;}
function pipeline(key){
 const link=links()[key]||{},delivery=key==='generate'||key==='load',active=snapshot?.session?.active===true;
 if(delivery){const state=online?link.state||'unknown':'unknown';return {kind:'delivery',state,quality:'unknown',flow:false,tone:!online?'neutral':['stale','missing','disconnected'].includes(state)?'warn':state==='current'?'ok':'neutral',label:!online?'状态未知':({current:'版本一致',stale:'需要更新',missing:'缺少产物',inactive:'未交付',unknown:'待核对'})[state]||link.label||'待核对'};}
 let quality='unknown',state=link.state||'unknown',label='状态未知',expires=null;
 if(!online)state='unknown';
 else if(!active){state='inactive';label='无运行会话';}
 else if(snapshot.observerFresh!==true)state='unknown';
 else if(state==='disconnected'||(key==='variables'?link.channelConnected===false:snapshot.state?.communication?.connected===false)){state='disconnected';label='已断开';}
 else if(key==='variables'&&link.dataQuality==='historical'&&snapshot.state?.runtimeState==='STOPPED'){quality='historical';label='历史值';}
 else {
  const timestamp=key==='variables'?link.observedAt:snapshot.state?.communication?.lastSuccessAt;
  const valid=state==='connected'&&(key!=='variables'||(link.channelConnected===true&&link.dataFresh===true&&link.dataQuality==='live'));
  if(valid&&recent(timestamp)){quality='live';label=key==='variables'?'实时双向':link.requiresManualRecovery===true?'已连接 · 待确认':'已连接';expires=timestamp*1000+PIPE_FRESH_MS;}
  else if(state==='connected'){state='stale';label=typeof timestamp==='number'&&Number.isFinite(timestamp)?'数据过期':'状态未知';}
  else if(state==='stale')label='数据过期';
  else if(state==='inactive')label='尚未连接';
 }
 const flow=quality==='live'&&!document.hidden&&!reducedMotion&&!isLocalProject();
 return {kind:'communication',state,quality,label,flow,expires,tone:quality==='live'?(key==='io'&&link.requiresManualRecovery===true?'warn':'ok'):online&&active&&quality!=='historical'?'warn':'neutral'};
}
function renderPipelines(){
 clearTimeout(pipeExpiryTimer);let nextExpiry=Infinity;
 for(const [key,ids] of Object.entries(routes)){
  const view=pipeline(key),group=root.querySelector('[data-pipeline="'+key+'"]'),edge=root.querySelector('[data-edge="'+key+'"]'),chosen=selected===key;
  const label=key==='variables'&&isStartStop()?(inputQuality()==='live'?'变量实时':inputQuality()==='historical'?'历史值':snapshot?.session?.active?'变量未知':'变量服务'):view.label;
  text('p-label-'+key,label);text('p-line-name-'+key,pipeNames[key]);
  for(const el of [group,edge]){el.dataset.kind=view.kind;el.dataset.state=view.state;el.dataset.quality=view.quality;el.dataset.flow=String(view.flow);el.dataset.tone=view.tone;el.dataset.selected=String(chosen);}
  const wire=root.querySelector('[data-route="'+key+'"]');wire.dataset.tone=view.tone;wire.dataset.selected=String(chosen);const marker='url(#t-arrow-'+(chosen&&view.tone!=='warn'?'selected':view.tone)+')';wire.setAttribute('marker-end',marker);if(view.kind==='communication')wire.setAttribute('marker-start',marker);
  ids.forEach(id=>$(id).dataset.tone=view.tone);edge.querySelector('button').title=pipeNames[key]+' · '+label+' · 点击查看双方与连接详情';
  if(view.expires)nextExpiry=Math.min(nextExpiry,view.expires);
 }
 root.querySelectorAll('[data-node]').forEach(el=>el.dataset.linked=String((pipeNodes[selected]||[]).includes(el.dataset.node)));
 root.dataset.motionPaused=String(document.hidden||reducedMotion);
 // Expire the indication even when a new status request is still waiting.
 if(Number.isFinite(nextExpiry))pipeExpiryTimer=setTimeout(render,Math.max(10,nextExpiry-Date.now()+10));
}
const labels={idle:'尚未准备',building:'编译与准备中',ready:'会话就绪',stopping:'正在结束',ended:'已结束',fault:'需要处理'};
const components=()=>{const c=snapshot?.components||{};return c.fuxa&&!c.eez?{...c,eez:c.fuxa}:c;};const links=()=>snapshot?.links||{};
const cap=key=>online&&!busyProjects.has(selectedProject)&&snapshot?.project?.id===selectedProject&&snapshot?.capabilities?.[key]===true&&(key!=='canInput'||inputQuality()==='live');
const toolCap=key=>online&&!busyProjects.has(selectedProject)&&snapshot?.project?.id===selectedProject&&snapshot?.capabilities?.tools?.[key]===true;
const isStartStop=()=>snapshot?.project?.kind==='start-stop'||(!snapshot&&projectList.find(p=>p.id===selectedProject)?.kind==='start-stop');
const isUserProject=()=>snapshot?.project?.kind==='user'||(!snapshot&&projectList.find(p=>p.id===selectedProject)?.kind==='user');
const currentProject=()=>snapshot?.project||projectList.find(p=>p.id===selectedProject)||{};
const isFuxaProject=(p=currentProject())=>['fuxa-oip','fuxa-local'].includes(p.defaultMode);
const isFuxaLocal=(p=currentProject())=>p.defaultMode==='fuxa-local';
const isBatchInterface=(p=currentProject())=>p.defaultMode==='fuxa-oip';
const isLocalProject=()=>isStartStop()||(isUserProject()&&!isFuxaProject());
const integration=()=>currentProject().configuration||null;
const designName=()=>isFuxaProject()?'FUXA':'EEZ Studio';
const sceneName=()=>isFuxaProject()?'Open Industry Project':'Factory I/O';
const hmiFile=(p=currentProject())=>p.configuration?.hmiFile||p.hmi||null;
const sceneFile=(p=currentProject())=>isFuxaLocal(p)?null:p.configuration?.sceneFile||p.scene||null;
const hmiAction=()=>isFuxaProject()?controlAction('open-hmi','打开 HMI','canShowHmi'):controlAction(snapshot?.hmiOpen?'reopen-hmi':'show-hmi',snapshot?.hmiOpen?'重新打开 HMI':'打开 HMI',snapshot?.hmiOpen?'canReconnectHmi':'canShowHmi');
const designAction=()=>toolAction(isFuxaProject()?'fuxa':'hmi',isFuxaProject()?'打开 FUXA 工程':'打开 EEZ 工程');
const simulationName=provider=>({none:'暂未选择',oip:'Open Industry Project（OIP）',factoryio:'Factory I/O'})[provider]||'暂未选择';
const sessionKey=()=>snapshot?.sessionId||snapshot?.toolsOpen?selectedProject+'|'+snapshot.instance+'|'+(snapshot.sessionId||'tools'):null;
const short=path=>path?path.replace(/\\/g,'/').split('/').pop():'未配置';
const text=(id,value)=>{$(id).textContent=value??'—';};
function treeComponents(project){
 const saved=treeMetadata.get(project.id),p=saved?.project||project,c=saved?.components||{},items=[];
 if(p.plc)items.push({key:'plc',label:'OpenPLC',icon:'file-code-2',path:p.plc});
 if(p.target||p.targetDefinition||c.runtime)items.push({key:'runtime',label:'Runtime',icon:'cpu',path:p.target||'本机运行目标'});
 if(hmiFile(p))items.push({key:'eez',label:isFuxaProject(p)?'FUXA':'EEZ Studio',icon:'panels-top-left',path:hmiFile(p)});
 if(p.hmiExecutable||(hmiFile(p)&&(c.hmi||isFuxaProject(p))))items.push({key:'hmi',label:isFuxaProject(p)?'FUXA 运行画面':'HMI',icon:'monitor',path:p.hmiExecutable||hmiFile(p)});
 if(sceneFile(p))items.push({key:'fio',label:isFuxaProject(p)?'OIP 场景':'Factory I/O',icon:'boxes',path:sceneFile(p)});
 return items;
}
function treeButtons(){return [...($('p-project-tree')?.querySelectorAll('[role="treeitem"]')||[])].filter(button=>!button.disabled&&!button.closest('[hidden]'));}
function focusTree(button){if(!button)return;treeFocusKey=button.dataset.treeKey;for(const item of treeButtons())item.tabIndex=item===button?0:-1;button.focus();}
function renderProjectTree(){
 const tree=$('p-project-tree');if(!tree)return;
 tree.setAttribute('role','tree');tree.setAttribute('aria-label','工程树');
 if(snapshot?.project?.id===selectedProject){treeMetadata.set(selectedProject,{project:snapshot.project,components:snapshot.components||{}});if(!treeExpanded.has(selectedProject))treeExpanded.set(selectedProject,true);}
 const records=projectList.map(p=>({project:p,children:treeComponents(p)}));
 const signature=JSON.stringify(records.map(({project:p,children})=>[p.id,p.name,children,treeExpanded.get(p.id)===true]));
 if(signature!==treeSignature){
  const previousFocus=tree.contains(document.activeElement)?document.activeElement.dataset.treeKey:null;treeSignature=signature;tree.replaceChildren();
  if(!records.length){const empty=document.createElement('p');empty.className='p-tree-empty';empty.textContent=online?'没有已登记的工程':'连接后台后读取工程';tree.append(empty);}
  for(const {project:p,children} of records){
   const branch=document.createElement('div'),button=document.createElement('button'),arrow=document.createElement('span'),glyph=document.createElement('span'),label=document.createElement('span'),status=document.createElement('span'),group=document.createElement('div');
   branch.className='p-tree-branch';button.className='p-tree-item p-tree-project';button.type='button';button.dataset.project=p.id;button.dataset.treeKey='project:'+p.id;button.setAttribute('role','treeitem');button.setAttribute('aria-level','1');button.tabIndex=-1;
   arrow.className='p-tree-chevron';arrow.dataset.treeToggle=p.id;arrow.setAttribute('aria-hidden','true');arrow.textContent=children.length?(treeExpanded.get(p.id)?'▾':'▸'):'·';
   glyph.innerHTML=icon('folder-open');label.className='p-tree-label';label.textContent=p.name;status.className='p-tree-status';button.append(arrow,glyph,label,status);button.title=p.name;
   group.className='p-tree-children';group.setAttribute('role','group');group.hidden=treeExpanded.get(p.id)!==true;group.id='p-tree-group-'+encodeURIComponent(p.id);button.setAttribute('aria-controls',group.id);if(children.length)button.setAttribute('aria-expanded',String(!group.hidden));
   for(const child of children){const item=document.createElement('button'),name=document.createElement('span');item.className='p-tree-item p-tree-component';item.type='button';item.dataset.select=child.key;item.dataset.treeOwner=p.id;item.dataset.treeKey='component:'+p.id+':'+child.key;item.setAttribute('role','treeitem');item.setAttribute('aria-level','2');item.tabIndex=-1;item.innerHTML=icon(child.icon);name.className='p-tree-label';name.textContent=child.label;item.append(name);item.title=child.path;group.append(item);}
   branch.append(button,group);tree.append(branch);
  }
  if(previousFocus){const restore=[...tree.querySelectorAll('[data-tree-key]')].find(item=>item.dataset.treeKey===previousFocus);if(restore&&!restore.closest('[hidden]')){restore.focus();treeFocusKey=previousFocus;}else{treeFocusKey='project:'+selectedProject;[...tree.querySelectorAll('.p-tree-project')].find(item=>item.dataset.project===selectedProject)?.focus();}}
 }
 for(const button of tree.querySelectorAll('.p-tree-project')){const current=button.dataset.project===selectedProject,other=online?(snapshot?.otherSessions||[]).find(s=>s.projectId===button.dataset.project&&(s.active||['building','stopping'].includes(s.phase))):null;button.disabled=!online;button.setAttribute('aria-current',String(current));button.setAttribute('aria-selected',String(current&&(selected==='project'||!treeComponents(projectList.find(p=>p.id===selectedProject)||{}).some(item=>item.key===selected)||treeExpanded.get(selectedProject)!==true)));button.querySelector('.p-tree-status').textContent=current?'当前':other?other.phase==='building'?'准备中':other.runtimeState==='RUNNING'?'运行中':other.runtimeState==='STOPPED'?'已停止':'会话占用':'';}
 for(const button of tree.querySelectorAll('.p-tree-component')){const current=button.dataset.treeOwner===selectedProject;button.disabled=!current||!snapshot;button.setAttribute('aria-selected',String(current&&button.dataset.select===selected));}
 const visible=treeButtons(),focused=visible.find(button=>button===document.activeElement)||visible.find(button=>button.dataset.treeKey===treeFocusKey)||visible.find(button=>button.getAttribute('aria-selected')==='true')||visible[0];
 for(const button of tree.querySelectorAll('[role="treeitem"]'))button.tabIndex=button===focused?0:-1;
 if(focused)treeFocusKey=focused.dataset.treeKey;
}
function renderInfoPanels(){
 const tabs=$('p-info-tabs');if(!tabs)return;const available=!!snapshot;
 if($('p-info-dock'))$('p-info-dock').hidden=!available;if($('p-info-resizer'))$('p-info-resizer').hidden=!available;
 for(const button of tabs.querySelectorAll('[data-info-tab]')){const active=button.dataset.infoTab===infoTab;button.setAttribute('role','tab');button.id=button.id||'p-tab-'+button.dataset.infoTab;button.setAttribute('aria-selected',String(active));button.setAttribute('aria-controls','p-info-'+button.dataset.infoTab);button.tabIndex=active?0:-1;}
 tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','工程信息');
 for(const key of ['properties','monitor','diagnostics']){const panel=$('p-info-'+key);if(!panel)continue;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tabs.querySelector('[data-info-tab="'+key+'"]')?.id||'p-tab-'+key);panel.hidden=!available||infoCollapsed||infoTab!==key;}
 if($('p-properties-empty'))$('p-properties-empty').hidden=!!detail();
 if($('p-info-empty'))$('p-info-empty').hidden=isStartStop()||isUserProject();
 if(available&&infoTab==='monitor'&&!infoCollapsed){if(isStartStop())$('p-local-debug').open=true;else if(isUserProject())$('p-user-monitor').open=true;}
 if(available&&infoTab==='diagnostics'&&$('p-more'))$('p-more').open=true;
 if(root.dataset.panelLayout!=='ready')root.dataset.infoCollapsed=String(infoCollapsed);
}
function selectInfoTab(key,focus=false){if(!['properties','monitor','diagnostics'].includes(key))return;infoTab=key;infoCollapsed=false;renderInfoPanels();if(focus)$('p-info-tabs')?.querySelector('[data-info-tab="'+key+'"]')?.focus();drawRoutes();}
function selectObject(key){selected=key;infoTab='properties';infoCollapsed=false;render();}
function inputQuality(){if(!online||snapshot?.observerFresh!==true)return 'unknown';const state=snapshot.state||{};if(state.runtimeState==='RUNNING')return state.telemetryFresh===true&&links().variables?.dataQuality==='live'?'live':'unknown';return state.runtimeState==='STOPPED'&&links().variables?.dataQuality==='historical'?'historical':'unknown';}
function inputValue(name){if(inputQuality()==='unknown')return '未知';const value=snapshot?.state?.variables?.[name];return typeof value==='boolean'?(value?'1':'0'):'未读取';}
function mark(id,label,tone='neutral',symbol='circle'){const el=$(id);el.innerHTML=icon(symbol)+'<span>'+escape(label)+'</span>';el.dataset.tone=tone;}
function wireTone(link){if(!online)return 'neutral';if(isStartStop()&&link===links().variables&&inputQuality()!=='live')return inputQuality()==='unknown'&&snapshot?.session?.active?'warn':'neutral';return ['disconnected','stale','missing'].includes(link?.state)?'warn':link?.state==='connected'?'ok':'neutral';}
function issues(){if(!online)return [{key:'issues',text:'工作台后台连接中断'}];const out=[];if(snapshot?.error)out.push({key:'runtime',text:snapshot.error});if(snapshot?.session?.active&&snapshot?.observerFresh===false)out.push({key:'runtime',text:'运行状态尚未确认 · 观察数据已失效'});for(const [key,l] of Object.entries(links())){if(['disconnected','stale','missing'].includes(l.state)||(snapshot?.session?.active&&l.state==='unknown'))out.push({key,text:l.label||'链路状态未知'});}if(!isLocalProject()&&snapshot?.session?.active)for(const key of (isFuxaLocal()?['variables']:['variables','io'])){if(pipeline(key).quality==='unknown'&&!out.some(x=>x.key===key))out.push({key,text:pipeNames[key]+' · '+pipeline(key).label});}if(isStartStop()&&snapshot?.state?.runtimeState==='RUNNING'&&inputQuality()==='unknown'&&!out.some(x=>x.key==='variables'))out.push({key:'variables',text:'PLC 正在运行，变量遥测已失效'});if(isUserProject()&&snapshot?.state?.runtimeState==='RUNNING'&&monitorQuality()==='unknown'&&!out.some(x=>x.key==='runtime'))out.push({key:'runtime',text:'PLC 正在运行，变量遥测已失效'});if(snapshot?.session?.active&&snapshot?.observerFresh===true&&snapshot?.state?.requiresManualRecovery)out.push({key:'hmi',text:'重连后需要核对批次数量'});return out;}
function drawRoutes(){
 const canvas=$('p-graph'),b=canvas.getBoundingClientRect();if(!b.width)return;$('t-wires').setAttribute('viewBox','0 0 '+b.width+' '+b.height);
 const local=isLocalProject();
 for(const [key,[from,to]] of Object.entries(routes)){
  const start=$(from),end=$(to),a=start.getBoundingClientRect(),z=end.getBoundingClientRect(),label=root.querySelector('[data-edge="'+key+'"]'),group=root.querySelector('[data-pipeline="'+key+'"]');
  start.title=start.getAttribute('aria-label');end.title=end.getAttribute('aria-label');
  if(label.hidden||!a.width||!z.width){label.style.maxWidth='';group.querySelectorAll('path').forEach(path=>path.setAttribute('d',''));continue;}
  const x1=a.left+a.width/2-b.left,y1=a.top+a.height/2-b.top,x2=z.left+z.width/2-b.left,y2=z.top+z.height/2-b.top;
  const vertical=(key==='generate'||key==='load')&&!local,m=vertical?(y1+y2)/2:(x1+x2)/2;
  const d=vertical?`M ${x1} ${y1} V ${m} H ${x2} V ${y2}`:`M ${x1} ${y1} H ${m} V ${y2} H ${x2}`;
  group.querySelectorAll('path').forEach(path=>path.setAttribute('d',d));
  label.dataset.orientation=vertical?'vertical':'horizontal';
  label.style.left=(vertical?x1+18:m)+'px';label.style.top=(vertical?m:(y1+y2)/2-30)+'px';
  label.style.maxWidth=vertical?'118px':Math.min(126,Math.max(68,Math.abs(x2-x1)-24))+'px';
 }
}
function activeMock(){return snapshot?.mode==='mock'&&(snapshot.session?.active===true||['building','stopping'].includes(snapshot.phase));}
function factoryScene(){
 if(isFuxaProject()){const c=components().factory||{},target=sceneFile(),reason=!online?'后台连接已失效。':snapshot?.capabilities?.reasons?.oip||snapshot?.capabilities?.reasons?.canOpenOip||'',known=online&&c.sceneIdentityVerified===true;return {target,canOpen:!!target&&toolCap('oip'),canShow:false,reason,request:online?c.label||'尚未打开':'状态未知',identity:!online?'状态未知':known?'已确认目标场景':'尚未确认场景身份',requestedScene:c.requestedScene||null,note:reason||'打开工程内保存的 OIP 场景；打开入口不自动运行场景或 PLC。场景身份与通信状态分别确认。'};}
 const s=snapshot||{},c=s.components?.factory||{},caps=s.capabilities||{},target=s.project?.scene?(c.sceneTarget||s.project.scene):null;
 const supported=typeof caps.canOpenFactoryScene==='boolean',showSupported=typeof caps.canShowFactory==='boolean';
 const occupied=s.session?.active===true||['building','stopping'].includes(s.phase),other=(s.otherSessions||[]).find(item=>item.active||['building','stopping'].includes(item.phase));
 let reason=!online?'后台连接已失效，请恢复连接。':!target?'当前工程未配置场景。':!supported?'工作台后台需要更新后才能打开工程场景。':busyProjects.has(selectedProject)?'当前工程操作正在等待确认。':caps.reasons?.canOpenFactoryScene||'';
 if(!reason&&occupied)reason='「'+s.project.name+'」仍有运行会话；结束所属会话后才能打开工程场景。';
 if(!reason&&other)reason='「'+other.projectName+'」占用运行目标；请返回该工程结束会话后再打开场景。';
 if(!reason&&s.runtimeOwner)reason='运行目标仍被占用；释放运行会话后才能打开工程场景。';
 if(!reason&&c.processRunning!==false)reason=c.processRunning===true?'Factory I/O 已打开；请保存并关闭现有窗口后，再打开工程场景。':'尚未确认 Factory I/O 是否已关闭，暂不能加载场景。';
 const canOpen=!!target&&supported&&cap('canOpenFactoryScene')&&!occupied&&!other&&!s.runtimeOwner&&c.processRunning===false&&!activeMock();
 if(!reason&&!canOpen)reason='当前暂不能打开工程场景，请刷新状态后重试。';
 const canShow=!!target&&showSupported&&cap('canShowFactory')&&!activeMock();
 const request=!online?'状态未知':({requested:'已请求加载 · 场景未确认','process-exited':'启动进程已退出 · 场景未确认','not-requested':'尚未请求加载'})[c.sceneLaunchState]||'尚未获得加载状态';
 const identity=!online?'状态未知':c.sceneIdentityVerified===true?'已确认目标场景':'未确认当前场景';
 return {target,canOpen,canShow,reason,request,identity,requestedScene:c.requestedScene||null,note:reason||'将加载当前工程关联的场景。打开请求成功不等于场景身份已确认；请在 Factory I/O 核对场景、驱动与映射。'};
}
const factoryAction=()=>({label:'打开工程场景',body:{action:'tool',tool:isFuxaProject()?'oip':'factory'},allowed:factoryScene().canOpen});
const factoryWindowAction=()=>({label:'显示现有窗口',body:{action:'tool',tool:'factory-window'},allowed:factoryScene().canShow});
const toolAction=(name,label)=>({label,body:{action:'tool',tool:name},allowed:toolCap(name==='hmi'?'eez':name)});
const controlAction=(name,label,capability)=>({label,body:{action:name},allowed:cap(capability)});
function detail(){const s=snapshot||{},p=s.project||{},c=components(),l=links(),v=s.state||{},lost=!online;
 const fieldState=entry=>lost?'未知 · 后台离线':entry?.label||'状态未知';
 const context=lost?'状态已失效，请恢复后台连接。':'';
 if(selected==='variables'&&isStartStop())return {title:'输入与监视 ↔ Runtime',icon:'arrow-left-right',fields:[['工程',p.name],['会话',s.sessionId||'未创建'],['通信',inputQuality()==='unknown'?'变量状态未知':fieldState(l.variables)],['数据质量',inputQuality()==='live'?'实时':inputQuality()==='historical'?'历史值':'未知']],note:context||(v.runtimeState==='RUNNING'&&inputQuality()==='unknown'?'PLC 执行状态与变量新鲜度分别确认。当前变量已失效，输入操作已禁用。':'输入请求绑定当前工程和本次会话；过期请求或其他会话的请求不会执行。')};
 switch(selected){
  case 'project':return {title:'工程文件与配置',icon:'folder-cog',fields:[['工程',p.name],...(isUserProject()?[['工程定义',p.manifestPath],['应用',p.application?.provider||'OpenPLC'],['PLC 程序',p.plc],['运行目标',p.target],['仿真工具',simulationName(p.simulation?.provider)],['场景关联',sceneFile(p)||p.simulation?.project||'尚未配置'],['HMI 工程',hmiFile(p)||'未配置'],...(p.configuration?[['绑定协议',p.interfaceDefinition?.protocol||p.configuration.bindings?.protocol||'尚未确认'],['配置版本',p.configuration.revision]]:[])]:[['PLC 程序',p.plc],['HMI 工程',p.hmi||'未配置'],['场景',p.scene||'未配置'],['目标',p.target]])],note:context||(isFuxaLocal()?'本工程声明的变量、操作权限与 FUXA 原生画面一同保存；保存接口不会启动运行。':isFuxaProject()?'画面、场景和变量映射随工程保存为独立副本；编译与运行会话另行创建。'+(s.capabilities?.reasons?.canConfigureProject||''):isUserProject()?'工程定义保存应用和组件关联；运行会话另行创建。仿真意向不代表已经关联场景或建立通信。':'各入口只使用当前工程关联的文件；切换查看工程不会启动、停止或迁移已有会话。'),action:isUserProject()&&!isBatchInterface()&&typeof s.capabilities?.canConfigureInterface==='boolean'?{label:'声明变量与操作',body:{action:'configure-interface'},allowed:cap('canConfigureInterface')}:isUserProject()?{label:'配置画面、场景与绑定',body:{action:'configure-project'},allowed:cap('canConfigureProject')}:p.scene?toolAction('scene-folder','打开场景目录'):toolAction('plc','打开 PLC 工程')};
  case 'issues':return {title:'连接与待处理项',icon:'circle-alert',fields:[],note:context||(!issues().length?'当前无待处理项。':'选择问题，查看对应组件与处理入口。')};
  case 'plc':return {title:'OpenPLC · 程序编辑',icon:'file-code-2',fields:[['关联文件',p.plc],['软件',fieldState(c.plc)],['程序交付',fieldState(l.load)]],note:context||'打开请求携带当前工程；进程存在不代表编辑器已确认打开该工程。',action:toolAction('plc','打开 PLC 工程')};
  case 'eez':return {title:designName()+' · 画面设计',icon:'panels-top-left',fields:[['关联文件',hmiFile(p)],['软件',fieldState(c.eez)],['画面产物',fieldState(l.generate)]],note:context||(isFuxaProject()?'在 FUXA 中编辑与保存当前工程的原生画面，AI 修改沿用其变量绑定；运行画面另行打开。':'编辑并保存画面后，需要重新构建 HMI；此入口打开源工程。'),action:designAction()};
  case 'runtime':return {title:'Runtime · 执行目标',icon:'cpu',fields:[['目标',p.target],['会话',s.sessionId||'未创建'],['PLC 状态',fieldState(c.runtime)],['装载版本',s.session?.programHash?.slice(0,16)||'尚无装载记录']],note:context||(!s.session?.active?s.capabilities?.reasons?.canPrepare||'先编译并准备当前工程，再运行 PLC。':c.runtime?.state==='running'?(isUserProject()?'当前程序正在执行，可在下方查看只读变量。':'PLC 控制程序正在执行；过程启动与停止由程序输入或 HMI 分别控制。'):s.capabilities?.reasons?.canRun||(isUserProject()?'PLC 已准备，保持 STOP；运行后可在下方监视变量。':'PLC 已准备；运行 PLC 后，再操作过程输入。')),action:!s.session?.active?controlAction('start','编译并准备会话','canPrepare'):toolAction('logs','打开会话日志')};
  case 'hmi':return {title:'HMI · 操作画面',icon:'monitor',fields:[['窗口进程',fieldState(c.hmi)],['变量通道',fieldState(l.variables)],['数据质量',lost?'未知':l.variables?.dataQuality==='live'?'实时':l.variables?.dataQuality==='historical'?'历史值':'未知'],...(isFuxaLocal()?[['工程变量',String(p.interfaceDefinition?.variables?.length||0)+' 项'],['允许操作',String((p.interfaceDefinition?.operations||[]).filter(op=>op.enabled!==false).length)+' 项']]:[['批次数量',lost?'未知':v.count===undefined?'尚未读取':String(v.count)+(v.countKnown?' 件':' 件 · 未确认')]])],note:context||(isFuxaLocal()?'HMI 只能读取本工程声明的变量，写入只经过已启用的操作；数据失效时禁止操作。':v.requiresManualRecovery?'请在 HMI 核对已通过数量，确认恢复后另行启动。':'关闭 HMI 不结束会话；连接失效会撤销过程许可。'),action:hmiAction()};
  case 'fio':if(activeMock())return {title:'回环模拟设备 · 验证对端',icon:'boxes',fields:[['类型','本机 Modbus 模拟器'],['端点',l.io?.details?.endpoint],['通信',fieldState(l.io)],['运行信号',lost||l.io?.sceneRunning==null?'未知':l.io.sceneRunning?'Run':'Stop']],note:context||'当前会话使用回环模拟器；此结果不代表 Factory I/O 场景已通过。'};{const scene=factoryScene();return {title:sceneName()+' · 工程场景',icon:'boxes',fields:[['目标场景',scene.target||'未配置'],['打开请求',scene.request],...(scene.requestedScene?[['已请求文件',scene.requestedScene]]:[]),['场景身份',scene.identity],['软件',fieldState(c.factory)],['驱动通信',fieldState(l.io)],['场景运行信号',lost||!s.session?.active||l.io?.sceneRunning==null?'未知':l.io.sceneRunning?'Run':'Stop']],note:context||scene.note,action:factoryAction(),secondary:scene.canShow?factoryWindowAction():null};}
  default:{
   const k=selected,link=l[k]||{},view=pipeline(k),delivery=view.kind==='delivery';
   const parties={generate:[designName(),isFuxaProject()?'FUXA 运行画面':'LVGL HMI'],load:['OpenPLC','Runtime'],variables:['HMI','Runtime'],io:['Runtime',activeMock()?'回环模拟设备':sceneName()]}[k];if(!parties)return null;
   const fields=[['双方',parties.join(delivery?' → ':' ↔ ')],['用途',delivery?'工程产物交付 · 单向':'运行通信 · 双向'],['状态',view.label]];
   if(delivery){fields.push(['核对结果',fieldState(link)]);if(k==='load')fields.push(['交付会话',s.sessionId||'尚未准备']);}
   else {fields.push(['数据质量',view.quality==='live'?'实时':view.quality==='historical'?'历史值':'未知'],['协议',link.protocol||link.details?.protocol||'尚未确认'],['端点',link.endpoint||link.details?.endpoint||'尚未确认']);}
   if(k==='io'){const known=online&&s.session?.active===true&&s.observerFresh===true&&view.quality==='live';fields.push(['场景状态',known?(link.sceneRunning===true?'Run':link.sceneRunning===false?'Stop':'未知'):'未知'],['恢复确认',known?(link.requiresManualRecovery===true?'待人工核对数量':'无需恢复确认'):'尚未确认']);}
   const stamp=k==='io'?v.communication?.lastSuccessAt:link.observedAt;
   if(typeof stamp==='number'&&Number.isFinite(stamp)&&stamp>0&&online)fields.push([k==='generate'?'最近哈希核对':k==='io'?'最近通信成功':'最近观察',new Date(stamp*1000).toLocaleTimeString('zh-CN',{hour12:false})]);
   let note={generate:isFuxaProject()?'FUXA 编辑入口与运行画面使用本工程的原生项目。此线表示画面交付关系；打开编辑器不代表浏览器运行画面仍在线。':'EEZ 源画面生成并构建为 HMI 产物。这里显示源码与产物的核对结果，不代表持续网络通信或本次构建时间。',load:'PLC 源程序经编译装载到当前会话。连线表示程序交付关系；PLC 是否执行请查看 Runtime 状态。',variables:'经本机 HTTP 服务与 PLC 变量邮箱交换请求和状态。动态仅提示近期数据有效，不表示流速或报文数量；PLC STOP 时可保留历史值。',io:'经本机通信适配层连接 Runtime 和对端。通信连接和场景 Run 分开确认；自动重连后仍须核对数量，旧启动请求不会重放。'}[k];
   let action=k==='load'?controlAction('start',s.session?.active?'重新编译并准备':'编译并准备会话','canPrepare'):k==='generate'?designAction():k==='variables'?hmiAction():activeMock()?null:factoryAction();
   if(k==='io'&&!activeMock()){const scene=factoryScene();fields.push(['目标场景',scene.target||'未配置'],['场景身份',scene.identity]);if(scene.reason)note+=' '+scene.reason;}
   return {title:pipeNames[k],icon:delivery?'arrow-down':'arrow-left-right',fields,note:context||note,action,secondary:k==='io'&&!activeMock()&&factoryScene().canShow?factoryWindowAction():null};
  }
 }
}
function monitorQuality(){const s=snapshot;if(!online||!s?.session?.active||s.observerFresh!==true)return 'unknown';if(s.state?.runtimeState==='RUNNING'&&s.state?.telemetryFresh===true)return 'live';return s.state?.runtimeState==='STOPPED'?'historical':'unknown';}
function renderUserMonitor(s){
 const enabled=isUserProject(),panel=$('p-user-monitor');panel.hidden=!enabled;if(!enabled){panel.open=false;return;}
 const quality=monitorQuality(),variables=Array.isArray(s.state?.variables)?s.state.variables:[];
 text('p-monitor-scope',(s.project?.name||'当前工程')+' · 会话 '+(s.sessionId?.slice(0,12)||'未创建'));
 mark('p-monitor-quality',quality==='live'?'变量实时':quality==='historical'?'PLC STOP · 历史值':s.session?.active?'变量已失效':'尚无运行会话',quality==='live'?'ok':s.session?.active&&quality==='unknown'?'warn':'neutral');
 const rows=variables.map(variable=>{const stale=quality==='unknown'||(quality==='live'&&variable.fresh===false),missing=variable.value===null||variable.value===undefined;return {path:String(variable.path??''),type:String(variable.type??''),value:stale?'未知':missing?'未读取':typeof variable.value==='boolean'?(variable.value?'TRUE':'FALSE'):String(variable.value),quality:stale?'已失效':missing?'未读取':quality==='historical'?'STOP 历史':'实时'};});
 const signature=JSON.stringify([selectedProject,s.sessionId,quality,rows]);
 if(signature!==monitorSignature){monitorSignature=signature;$('p-monitor-rows').replaceChildren();for(const variable of rows){const tr=document.createElement('tr');for(const key of ['path','type','value','quality']){const td=document.createElement('td');td.textContent=variable[key];tr.append(td);}$('p-monitor-rows').append(tr);}}
 $('p-monitor-table').hidden=!rows.length;$('p-monitor-empty').hidden=!!rows.length;text('p-monitor-empty',s.session?.active?'等待当前会话的编译符号和变量…':'编译并准备工程后，在此查看程序变量。');
}
function renderProjectContext(s,latch){
 const select=$('p-project'),signature=JSON.stringify(projectList.map(p=>[p.id,p.name]));
 if(projectList.length&&select.dataset.items!==signature){select.replaceChildren();for(const p of projectList){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.append(option);}select.dataset.items=signature;}
 if(projectList.length)select.value=selectedProject;
 text('p-project-description',s.project?.description||projectList.find(p=>p.id===selectedProject)?.description||'');text('p-end-note',isFuxaLocal()?'结束当前工程所属 Runtime 与 FUXA 实例；其他工程不受影响。':isFuxaProject()?'结束当前工程所属 Runtime、FUXA 与 OIP 实例；其他工程不受影响。':isLocalProject()?'退出当前工程所属的 Runtime 与监视进程；工程保持打开。':'退出当前工程所属 Runtime 与 HMI；工程保持打开，外部场景保留。');
 const local=isLocalProject();
 const present={eez:!local&&!!hmiFile(),hmi:!local&&!!(hmiFile()||s.project?.hmiExecutable),fio:!local&&!!sceneFile()};
 for(const id of ['eez','hmi','fio'])root.querySelector('[data-node="'+id+'"]').hidden=!present[id];
 $('p-local-debug').hidden=!latch;if(!latch)$('p-local-debug').open=false;
 for(const key of ['generate','variables','io']){const hidden=key==='generate'?!(present.eez&&present.hmi):key==='variables'?!present.hmi:!present.fio;root.querySelector('[data-edge="'+key+'"]').hidden=hidden;root.querySelector('[data-route="'+key+'"]').toggleAttribute('hidden',hidden);root.querySelector('[data-route-hit="'+key+'"]').toggleAttribute('hidden',hidden);root.querySelector('[data-pipeline="'+key+'"]').toggleAttribute('hidden',hidden);}
 $('t-runtime-io').hidden=!present.fio;$('t-runtime-data').hidden=!present.hmi;
 renderProviderLabels();
 const variableEdge=root.querySelector('[data-edge="variables"]');variableEdge.querySelector('.t-mobile-ends').textContent=latch?'输入与监视 ↔ Runtime':'HMI ↔ Runtime';variableEdge.querySelector('button').setAttribute('aria-label',latch?'查看本机输入与 Runtime 的变量通信':'查看 HMI 与 Runtime 的变量通信');
 if(latch){const quality=inputQuality();for(const [name,id] of [['Start','start'],['Stop','stop'],['Motor','motor']]){text('p-input-'+id,inputValue(name));$('p-input-'+id).dataset.on=String(quality==='live'&&inputValue(name)==='1');}mark('p-state-inputs',quality==='live'?'变量实时':quality==='historical'?'PLC STOP · 历史值':!s.session?.active&&online?'尚未连接':'变量状态未知',wireTone(s.links?.variables));$('p-input-start-button').disabled=!cap('canInput');$('p-input-stop-button').disabled=!cap('canInput');text('p-debug-scope',(s.project?.name||projectList.find(p=>p.id===selectedProject)?.name||'读取工程中')+' · 会话 '+(s.sessionId?.slice(0,12)||'未创建')); }
 renderUserMonitor(s);
 const other=$('p-running-projects');other.replaceChildren();const sessions=online?(s.otherSessions||[]).filter(x=>x.projectId!==selectedProject&&(x.active||['building','stopping'].includes(x.phase))):[];
 for(const [projectId,pending] of busyProjects)if(projectId!==selectedProject&&!sessions.some(x=>x.projectId===projectId))sessions.push({projectId,projectName:pending.projectName,pendingOnly:true});
 other.hidden=!sessions.length;
 for(const session of sessions){const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button'),pending=busyProjects.get(session.projectId);label.textContent=pending?.message||'「'+session.projectName+'」'+(session.phase==='building'?'正在准备':session.phase==='stopping'?'正在结束':session.runtimeState==='RUNNING'?'仍在运行':session.runtimeState==='STOPPED'?'保留已停止的会话':'会话仍在占用运行目标')+' · '+(session.id?.slice(0,12)||'准备中');button.textContent='查看该工程';button.className='p-button';button.dataset.project=session.projectId;row.append(label,button);other.append(row);}
 if(sessions.length){const note=document.createElement('small');note.textContent=sessions.some(x=>!x.pendingOnly)?'切换工程不会停止它；需要释放运行目标时，请返回所属工程结束会话。':'操作仍绑定原工程与会话；切换不会转移请求。';other.append(note);}
 if($('p-current-title'))text('p-current-title',s.project?.name||'未选择工程');renderProjectTree();
}
function connectionFailure(error){online=false;confirmEnd=null;connectionState=error.connectionState||'offline';if(connectionState==='invalid-auth'){token='';try{sessionStorage.removeItem('plcdev-workbench-token');}catch{}}actionMessage=error.name==='AbortError'?'后台响应超时，旧状态已失效。':error.message;}
function renderConnection(){
 const hasSnapshot=!!snapshot,pending=connectionState==='loading',auth=['missing-auth','invalid-auth'].includes(connectionState);
 const wording={loading:['正在连接工作台','正在验证入口并读取工程清单…','正在读取工程清单…','连接中'],
  'missing-auth':['此浏览器尚未获得工作台授权','请从本机启动器打开工作台，再使用它打开的页面。','未授权 · 未读取工程','未授权'],
  'invalid-auth':['工作台授权已失效','当前页面的授权已被后台拒绝，请重新运行启动器打开工作台。','授权失效 · 未读取工程','授权失效'],
  offline:['无法连接工作台后台','请检查后台是否仍在运行，或重新运行启动器后重试。','未连接 · 工程读取失败','后台未连接'],
  error:['工程信息读取失败',actionMessage||'请重新从启动器打开后重试。','工程读取失败','后台未连接']}[connectionState];
 root.querySelector('.p-work').hidden=!hasSnapshot;root.querySelector('.p-session').hidden=!hasSnapshot;$('p-other').hidden=!hasSnapshot;root.querySelector('.activity').hidden=!hasSnapshot;
 root.querySelector('[data-select="project"]').disabled=!hasSnapshot;
 $('p-agent-open').disabled=!online||snapshot?.project?.id!==selectedProject||!isUserProject();$('p-agent-open').title=isUserProject()?'查看和创建当前用户工程的 AI 任务':'当前仅支持用户工程，请先导入案例副本。';
 $('p-new-project').disabled=!online||catalogBusy||snapshot?.projectCatalog?.canCreate!==true;$('p-open-project').disabled=!online||catalogBusy||snapshot?.projectCatalog?.canOpen!==true;
 const oldCatalog=online&&hasSnapshot&&!snapshot.projectCatalog;$('p-catalog-help').hidden=!oldCatalog;
 for(const id of ['p-new-project','p-open-project'])$(id).title=oldCatalog?'当前后台尚未提供工程管理能力，请重启工作台后台。':'';
 if($('p-project-dialog').open)updateProjectForm();
 $('p-configure-interface').hidden=!isUserProject();$('p-configure-interface').disabled=interfaceBusy||isBatchInterface()||!cap('canConfigureInterface');$('p-configure-interface').title=isBatchInterface()?'此工程沿用批次邮箱配置，请使用“画面与场景”。':snapshot?.capabilities?.reasons?.canConfigureInterface||'声明当前工程的 HMI 变量与操作权限';
 if($('p-interface-dialog').open)updateInterfaceForm();
 $('p-configure-project').hidden=!isUserProject()||isFuxaLocal();$('p-configure-project').disabled=!cap('canConfigureProject')||integrationBusy;$('p-configure-project').title=snapshot?.capabilities?.reasons?.canConfigureProject||(!snapshot?.capabilities||typeof snapshot.capabilities.canConfigureProject!=='boolean'?'当前后台不支持组件配置，请重启工作台后台。':'配置当前工程的画面、场景与变量映射');
 if($('p-integration-dialog').open)updateIntegrationForm();
 $('p-connection').hidden=online;$('p-connection').dataset.state=connectionState;$('p-connection-retry').disabled=pending||!!polling;
 if(!online&&wording){text('p-connection-title',wording[0]);text('p-connection-message',wording[1]);text('backend',wording[3]);$('p-launch-help').hidden=pending;}
 const select=$('p-project');select.disabled=!online;
 if(!hasSnapshot){select.replaceChildren();const option=document.createElement('option');option.value=selectedProject;option.textContent=wording?.[2]||'尚未读取工程';select.append(option);select.dataset.items='connection:'+connectionState;text('p-project-id','尚未读取工程');text('p-project-open',pending?'等待连接':auth?'等待有效授权':'工程未连接');text('p-project-description','');$('notice').hidden=true;$('p-end-confirm').hidden=true;$('p-local-debug').hidden=true;$('p-user-monitor').hidden=true;$('p-feedback').hidden=true;}
 else if(!online)text('p-project-open','连接失效 · 状态未知');
 renderInfoPanels();
}
function retryConnection(){token=readCredential();connectionState=token?'loading':connectionState==='invalid-auth'?'invalid-auth':'missing-auth';online=false;actionMessage='';render();refresh();}
function render(){const s=snapshot||{},v=s.state||{},c=components(),l=links(),list=issues(),d=detail();
 const latch=isStartStop(),local=isLocalProject();root.dataset.projectKind=isUserProject()?'user':latch?'start-stop':'batch';root.dataset.topology=local?'local':'linked';root.dataset.interfaceTopology=String(isFuxaLocal());renderProjectContext(s,latch);
 root.dataset.detail=String(!!d);root.dataset.grid='true';root.dataset.portnames='true';text('backend',online?'后台已连接':'后台未连接');text('p-project-id',s.project?.id||selectedProject);text('p-project-open',s.project?.opened?'工程已关联':'读取工程中');text('p-mode',local?'本机隔离 Runtime':isFuxaLocal()?'FUXA + 本机 Runtime':activeMock()?'回环模拟对端':isFuxaProject()?'FUXA + OIP':'Factory I/O');
 const overall=!online?'状态未知':list.length?list.length+' 项待处理':s.phase==='building'?'正在编译与准备':!s.session?.active?'尚无运行会话':c.runtime?.state==='stopped'?'PLC STOP · 历史数据':'链路状态已确认';mark('p-health',overall,list.length?'warn':online&&c.runtime?.state==='running'?'ok':'neutral',list.length?'triangle-alert':online?'circle-check':'circle-alert');
 const msg=busyProjects.get(selectedProject)?.message||actionMessage||s.error||(!online?'无法读取后台，组件与链路状态已标为未知。':s.phase==='building'?s.message:'');text('notice',msg);$('notice').hidden=!msg;$('notice').dataset.error=String(!online||!!s.error);text('p-feedback',online?s.message||'':'');$('p-feedback').hidden=!online||!s.message;
 const toolShort={unavailable:'未安装',available:'可用', 'launch-requested':'已请求打开','process-alive':'进程存在','launch-failed':'打开失败'};
 for(const key of ['plc','eez'])mark('p-state-'+key,online?toolShort[c[key]?.state]||c[key]?.label||'未知':'状态未知',c[key]?.state==='launch-failed'?'warn':'neutral',c[key]?.available?'square-check':'square');
 mark('p-state-runtime',online?c.runtime?.label||'未知':'状态未知',online&&c.runtime?.state==='running'?'ok':c.runtime?.state==='fault'?'warn':'neutral',c.runtime?.state==='running'?'circle-play':'circle-pause');
 mark('p-state-hmi',online?(isFuxaProject()?c.hmi?.label||'状态未知':s.hmiOpen?'窗口进程存在':'未打开'):'状态未知',online&&c.hmi?.state==='connected'?'ok':'neutral',s.hmiOpen&&online?'square-check':'square');
 const mock=activeMock(),factory=factoryScene();const fioNode=root.querySelector('[data-node="fio"]');fioNode.querySelector('.p-name').textContent=mock?'回环模拟设备':isFuxaProject()?'OIP':'Factory I/O';fioNode.querySelector('.p-role').textContent=mock?'本机测试对端':'虚拟产线场景';fioNode.querySelector('[data-select="fio"]').setAttribute('aria-label',mock?'查看回环模拟设备':'查看 '+sceneName()+' 工程场景');$('p-fio-launch').hidden=mock;const fioShow=factory.canShow;$('p-fio-launch').dataset.action=fioShow?'show-fio':'open-fio';$('p-fio-launch').setAttribute('aria-label',fioShow?'显示现有 Factory I/O 窗口':'打开当前工程场景');$('p-fio-launch').dataset.tooltip=fioShow?'显示现有窗口':'打开工程场景';$('p-fio-launch').title=fioShow?'仅显示已有窗口，不加载或切换场景':factory.reason||'打开 '+short(factory.target);text('p-file-fio',mock?'':short(factory.target));$('p-file-fio').title=factory.target||'未配置场景';text('p-factory-identity',factory.identity);$('p-factory-identity').hidden=mock;$('t-fio-in').setAttribute('aria-label',mock?'回环模拟器 Modbus 接口':sceneName()+' Modbus 驱动接口');root.querySelector('[data-edge="io"] button').setAttribute('aria-label',mock?'查看 Runtime 与回环模拟器通信':'查看 Runtime 与 '+sceneName()+' 通信');const scene=online&&l.io?.state==='connected'&&(!isFuxaProject()||(s.session?.active===true&&s.observerFresh===true&&pipeline('io').quality==='live'))?l.io.sceneRunning:null;mark('p-state-fio',scene===true?(mock?'模拟 Run':'场景 Run'):scene===false?(mock?'模拟 Stop':'场景 Stop'):mock?'回环模拟对端':'场景未知',scene===true?'ok':'neutral',scene===true?'circle-play':'circle');
 renderPipelines();
 root.querySelectorAll('[data-select]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.select===selected)));root.querySelectorAll('[data-node]').forEach(el=>el.dataset.selected=String(el.dataset.node===selected));
 $('p-inspector').hidden=!d;if(d){text('p-detail-title',d.title);$('p-detail-icon').innerHTML=icon(d.icon);text('p-detail-scope',s.project?.name||'批次计数工程');$('p-fields').innerHTML=d.fields.map(([k,value])=>'<div><dt>'+escape(k)+'</dt><dd>'+escape(value)+'</dd></div>').join('');text('p-detail-note',d.note);$('p-detail-action').hidden=!d.action;if(d.action){text('p-detail-action',d.action.label);$('p-detail-action').disabled=!d.action.allowed;$('p-detail-action').dataset.detailAction='true';$('p-detail-action').title=d.action.body.tool==='factory'?factory.reason:'';} $('p-detail-secondary').hidden=!d.secondary;if(d.secondary){text('p-detail-secondary',d.secondary.label);$('p-detail-secondary').disabled=!d.secondary.allowed;$('p-detail-secondary').dataset.detailSecondary='true';} $('p-issues').hidden=selected!=='issues';$('p-issues').innerHTML=selected==='issues'?list.map(x=>'<button class="p-button" data-select="'+escape(x.key)+'">'+escape(x.text)+'</button>').join(''):'';}
 const active=s.session?.active===true;const execution=online?c.runtime?.state:'unknown';text('p-session-id',active?s.sessionId?.slice(0,12):labels[s.phase]||'未创建');text('p-session-target',(s.project?.name||projectList.find(p=>p.id===selectedProject)?.name||'读取工程中')+' · '+(s.project?.target||'本机隔离 Runtime')+(isFuxaLocal()?' · FUXA / 本机 Runtime':isFuxaProject()?' · FUXA / OIP':isUserProject()?' · 无设备连接':latch?' · 软件输入':s.mode==='mock'?' · 回环模拟':' · Factory I/O'));
 $('p-user-session-note').hidden=!isUserProject();$('p-user-edit-note').hidden=!isUserProject()||active||s.phase==='building';
 $('p-execution').innerHTML=icon(execution==='running'?'play':'square')+(execution==='running'?'PLC RUN':execution==='stopped'?'PLC STOP':!active&&online?'未运行':'状态未知');$('p-execution').dataset.running=String(execution==='running');
 const main=$('p-session-main');main.dataset.action=!active?'start':execution==='running'?'runtime-stop':'runtime-start';main.innerHTML=icon(!active?'layers-2':execution==='running'?'square':'play')+(!active?'编译并准备':execution==='running'?'停止 PLC':'运行 PLC');main.disabled=!cap(!active?'canPrepare':execution==='running'?'canStop':'canRun');main.dataset.emphasis=execution==='running'?'secondary':'primary';main.title=s.capabilities?.reasons?.[!active?'canPrepare':execution==='running'?'canStop':'canRun']||'';
 $('p-session-hmi').disabled=!cap('canShowHmi');$('p-session-hmi').hidden=local;$('p-session-end').disabled=!cap('canEnd');$('p-session-end').hidden=!active&&s.phase!=='building'&&!s.toolsOpen;const toolsOnly=isFuxaProject()&&s.toolsOpen&&!active;text('p-session-end',toolsOnly?'关闭工程工具':'结束会话');$('p-end-confirm').hidden=!confirmEnd||confirmEnd!==sessionKey()||!online;text('p-end-title','结束「'+(s.project?.name||'当前工程')+'」的 '+(toolsOnly?'工程工具':s.sessionId?.slice(0,12)||'当前会话')+'？');
 root.querySelector('[data-action="open-plc"]').disabled=!toolCap('plc');root.querySelector('[data-action="open-eez"]').disabled=!toolCap(isFuxaProject()?'fuxa':'eez');root.querySelector('[data-action="open-hmi"]').disabled=!cap('canShowHmi');$('p-fio-launch').disabled=!(factory.canShow||factory.canOpen);
 const own=s.runtimeOwner,reservation=s.phase==='building'?s.project?.name:(s.otherSessions||[]).find(x=>x.phase==='building')?.projectName; $('p-other').replaceChildren();const ownership=document.createElement('span');ownership.textContent=!online?'运行目标归属未知':own?'运行目标占用：'+(own.sessionId===s.sessionId?'当前工程':projectList.find(p=>p.id===own.projectId)?.name||(s.otherSessions||[]).find(x=>x.id===own.sessionId)?.projectName||own.owner||'其他入口')+' · PID '+own.pid:reservation?'运行目标已预留给「'+reservation+'」 · 正在编译与准备':'运行目标空闲 · 同一时间仅一个工程使用';$('p-other').append(ownership);const logs=document.createElement('button');logs.textContent='查看日志 ↗';logs.dataset.action='logs';logs.disabled=!toolCap('logs');$('p-other').append(logs);
 $('dependencies').innerHTML=(s.dependencies||[]).map(x=>'<span class="dependency '+(x.available?'available':'missing')+'">'+escape(x.label)+' · '+(online?(x.available?'路径存在':'缺少'):'待确认')+'</span>').join('');$('events').replaceChildren();for(const item of (s.events||[]).slice(-8).reverse()){const li=document.createElement('li');li.textContent=new Date(item.at*1000).toLocaleTimeString('zh-CN',{hour12:false})+'　'+item.message;$('events').append(li);}renderConnection();drawRoutes();
}
async function api(path,body,timeoutMs){if(!token)throw Object.assign(Error('请从 Start-PLCdev.cmd 或 OpenPLC 入口打开工作台。'),{connectionState:connectionState==='invalid-auth'?'invalid-auth':'missing-auth'});const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs??(path==='action'?28000:4500));try{const r=await fetch('/api/'+path,{method:body?'POST':'GET',cache:'no-store',signal:abort.signal,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.status===401||r.status===403)throw Object.assign(Error('工作台授权已失效，请重新运行启动器打开页面。'),{connectionState:'invalid-auth'});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.error||'工作台请求失败（'+r.status+'）'),{connectionState:'error',httpStatus:r.status});return result;}finally{clearTimeout(timer);}}
async function refresh(){
 const project=selectedProject;if(polling?.project===project)return;const requestState={project,generation:++readGeneration};polling=requestState;
 try{const s=await api('status?project='+encodeURIComponent(project));if(requestState.generation!==readGeneration||project!==selectedProject)return;if(s.schemaVersion!==3)throw Object.assign(Error('后台版本尚未更新，请重新启动工作台服务。'),{connectionState:'error'});if(s.project?.id!==project)throw Object.assign(Error('后台工程身份不匹配，已停用操作。'),{connectionState:'error'});if(snapshot?.sessionId!==s.sessionId||snapshot?.instance!==s.instance){confirmEnd=null;resetLocalDebug();}if(!online)actionMessage='';snapshot=s;projectList=s.projects||projectList;online=true;connectionState='ready';render();}
 catch(e){if(requestState.generation!==readGeneration||project!==selectedProject)return;connectionFailure(e);render();}
 finally{if(polling===requestState){polling=null;if(!online)renderConnection();}}
}
function resetLocalDebug(){$('p-local-debug').open=false;$('p-user-monitor').open=false;monitorSignature='';$('p-monitor-rows').replaceChildren();text('p-debug-scope','');for(const name of ['start','stop','motor']){text('p-input-'+name,'—');$('p-input-'+name).dataset.on='false';}$('p-input-start-button').disabled=true;$('p-input-stop-button').disabled=true;}
const agentStatusLabels={queued:'待执行',pending:'待执行',created:'已创建',running:'执行中',generating:'生成候选',validating:'校验中',awaiting_review:'待审阅',needs_review:'待核对',blocked:'待处理',conflict:'冲突',failed:'失败',cancelled:'已取消',completed:'已完成',unknown_outcome:'结果待核对',not_ready:'尚未就绪'};
function agentTaskStatus(value){return agentStatusLabels[value]||String(value||'状态未知');}
function closeAgentDialog(){
 ++agentLoadGeneration;agentContext=null;if(agentRefreshTimer!==null){clearTimeout(agentRefreshTimer);agentRefreshTimer=null;}
 const dialog=$('p-agent-dialog');if(dialog.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
}
function updateAgentForm(){
 const ctx=agentContext,pending=ctx&&agentPending.get(ctx.projectId),ready=!!ctx&&online&&snapshot?.project?.id===ctx.projectId&&!!ctx.revision&&!ctx.loading;
 $('p-agent-request').disabled=agentCreateBusy||!!pending;
 $('p-agent-saved-basis').disabled=agentCreateBusy||!!pending;
 $('p-agent-example').disabled=agentCreateBusy||!!pending;
 $('p-agent-submit').disabled=agentCreateBusy||!ready||(!pending&&(!ctx.savedRevisionCandidate||!$('p-agent-saved-basis').checked||!$('p-agent-request').value.trim()));
 $('p-agent-submit').textContent=agentCreateBusy?'正在提交…':pending?'核对并重试原请求':'创建候选任务';
 $('p-agent-refresh').disabled=!!ctx?.loading;
}
function renderAgentTasks(ctx,tasks){
 const target=$('p-agent-tasks');target.replaceChildren();ctx.candidates=new Map();
 if(!Array.isArray(tasks)||!tasks.length){target.textContent='本工程暂无任务。';return;}
 for(const task of tasks){
  if(!task||task.projectId!==ctx.projectId)continue;
  const item=document.createElement('article'),head=document.createElement('div'),status=document.createElement('strong'),id=document.createElement('code'),request=document.createElement('p'),meta=document.createElement('small');
  item.className='p-agent-task';head.className='p-agent-task-head';status.textContent=agentTaskStatus(task.status);id.textContent=String(task.taskId||'未知任务');request.textContent=String(task.request||'');
  const detail=[];if(task.createdAt){const time=typeof task.createdAt==='number'?new Date(task.createdAt*1000):null;detail.push('创建：'+(time&&!Number.isNaN(time.getTime())?time.toLocaleString('zh-CN',{hour12:false}):String(task.createdAt)));}if(task.reason||task.message||task.error)detail.push(String(task.reason||task.message||task.error));if(task.completionScope)detail.push('范围：'+String(task.completionScope));
  if(task.sourceBasis==='saved_revision'||task.candidate?.sourceBasis==='saved_revision')detail.unshift('基于已保存版本');
  const baseline=task.projectRevision||task.candidate?.baselineRevision;if(typeof baseline==='string'&&/^[0-9a-f]{12,64}$/.test(baseline))detail.push('基线 '+baseline.slice(0,12));
  meta.textContent=detail.join(' · ');head.append(status,id);item.append(head,request,meta);
  const candidate=task.candidate,digest=candidate?.candidateDigest,taskId=task.taskId;
  if(task.status==='awaiting_review'&&typeof taskId==='string'&&/^task-[0-9a-f]{32}$/.test(taskId)&&typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest)){
   const summary=candidate.summary;if(summary&&typeof summary==='object'){const note=document.createElement('p');note.textContent='候选变更：'+[summary.before,summary.after].filter(v=>typeof v==='string').join(' → ');item.append(note);}
   ctx.candidates.set(taskId,digest);const button=document.createElement('button');button.type='button';button.className='p-button';button.dataset.action='agent-open-candidate';button.dataset.taskId=taskId;button.dataset.digest=digest;button.textContent='打开候选工程';button.disabled=agentOpening.has(ctx.projectId+'|'+taskId);item.append(button);
  }
  target.append(item);
 }
}
async function loadAgentTasks(ctx=agentContext){
 if(!ctx||ctx!==agentContext)return;if(agentRefreshTimer!==null){clearTimeout(agentRefreshTimer);agentRefreshTimer=null;}const generation=++agentLoadGeneration;ctx.loading=true;updateAgentForm();
 try{
  const data=await api('agent/tasks?project='+encodeURIComponent(ctx.projectId),undefined,60000);
  if(ctx!==agentContext||generation!==agentLoadGeneration||selectedProject!==ctx.projectId)return;
  if(data.projectId!==ctx.projectId||typeof data.projectRevision!=='string'||!data.projectRevision||!Array.isArray(data.tasks))throw Error('任务服务返回的工程身份或版本无效。');
  ctx.revision=data.projectRevision;renderAgentTasks(ctx,data.tasks);text('p-agent-revision','工程版本 '+ctx.revision.slice(0,12));
  const abilities=data.capabilities||{},candidate=abilities.savedRevisionCandidate===true?'可用':abilities.savedRevisionCandidate===false?'当前工程暂不支持':'未确认';ctx.savedRevisionCandidate=abilities.savedRevisionCandidate===true;
  text('p-agent-capabilities','已保存版本候选：'+candidate+' · 模型生成：'+(abilities.modelGeneration===true?'可用':abilities.modelGeneration===false?'未接入':'未确认'));

  text('p-agent-message',agentPending.has(ctx.projectId)?'上次提交结果尚未确认。请核对任务列表；重试会保留原请求和版本。':ctx.savedRevisionCandidate?'请确认使用已保存版本；工程在生成期间发生变化时，任务会提示冲突。':'此工程暂不支持当前改名操作，可查看已有任务。');
  if(data.tasks.some(t=>['queued','pending','running','generating','validating'].includes(t?.status)))agentRefreshTimer=setTimeout(()=>{agentRefreshTimer=null;if(agentContext===ctx&&$('p-agent-dialog').open&&!ctx.loading)loadAgentTasks(ctx);},2000);
 }catch(error){
  if(ctx!==agentContext||generation!==agentLoadGeneration)return;
  ctx.revision=null;text('p-agent-tasks','任务暂时无法读取。');text('p-agent-revision','');text('p-agent-capabilities','工程能力暂时无法确认。');
  text('p-agent-message',error.name==='AbortError'?'任务服务响应超时，请刷新；已有任务和运行会话不会因页面关闭而停止。':('任务服务不可用：'+error.message));
 }finally{if(ctx===agentContext&&generation===agentLoadGeneration){ctx.loading=false;updateAgentForm();}}
}
function showAgentDialog(){
 if(!online||snapshot?.project?.id!==selectedProject)return;
 const p=currentProject(),dialog=$('p-agent-dialog');agentContext={projectId:p.id,name:p.name,revision:null,loading:false};
 const pending=agentPending.get(p.id);$('p-agent-request').value=pending?.request||'';$('p-agent-saved-basis').checked=pending?.sourceBasis==='saved_revision';
 text('p-agent-scope','当前工程：'+p.name+' · 任务和候选只属于该工程。');text('p-agent-capabilities','正在读取工程能力…');text('p-agent-tasks','正在读取任务…');text('p-agent-message','正在读取工程版本与任务…');text('p-agent-revision','');
 if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}updateAgentForm();loadAgentTasks(agentContext);
}
async function submitAgentTask(){
 const ctx=agentContext;if(!ctx||ctx.projectId!==selectedProject||agentCreateBusy||!online||!ctx.revision)return;
 let pending=agentPending.get(ctx.projectId);if(!pending){const request=$('p-agent-request').value.trim();if(!request||ctx.loading||!ctx.savedRevisionCandidate||!$('p-agent-saved-basis').checked)return;pending={projectId:ctx.projectId,request,executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:crypto.randomUUID(),expectedRevision:ctx.revision};agentPending.set(ctx.projectId,pending);saveAgentPending();}
 agentCreateBusy=true;updateAgentForm();text('p-agent-message','正在创建候选任务，等待后台确认…');
 try{
  const result=await api('agent/tasks',pending,60000);const task=result?.task;
  if(!task||!task.taskId||task.projectId!==pending.projectId)throw Error('后台未确认同一工程的任务身份。');
  agentPending.delete(pending.projectId);saveAgentPending();
  if(ctx===agentContext&&selectedProject===ctx.projectId){$('p-agent-request').value='';$('p-agent-saved-basis').checked=false;text('p-agent-message','任务已创建；状态及候选以任务列表为准。');await loadAgentTasks(ctx);}
 }catch(error){
  const definitive=Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500&&error.httpStatus!==408;
  if(definitive){agentPending.delete(pending.projectId);saveAgentPending();}
  if(ctx===agentContext&&selectedProject===ctx.projectId){
   text('p-agent-message',definitive?'任务未创建：'+error.message:'任务结果尚未确认。请刷新列表核对；重试使用原请求编号，避免重复创建。');
  }
 }finally{agentCreateBusy=false;updateAgentForm();}
}
async function openAgentCandidate(taskId,digest){
 const ctx=agentContext;if(!ctx||selectedProject!==ctx.projectId||!online||ctx.candidates?.get(taskId)!==digest)return;
 const key=ctx.projectId+'|'+taskId;if(agentOpening.has(key))return;agentOpening.add(key);
 for(const button of $('p-agent-tasks').querySelectorAll('button[data-task-id]'))if(button.dataset.taskId===taskId)button.disabled=true;
 text('p-agent-message','正在打开该任务的候选副本…');
 try{
  const result=await api('agent/tasks/open',{projectId:ctx.projectId,taskId,candidateDigest:digest},60000);
  if(!result?.ok)throw Error('后台未确认打开结果。');
  if(agentContext===ctx&&selectedProject===ctx.projectId)text('p-agent-message','已请求在 OpenPLC 打开候选副本；请在新窗口查看，原工程不会因查看而改写。');
 }catch(error){
  if(agentContext===ctx&&selectedProject===ctx.projectId)text('p-agent-message',Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500?'未能打开候选：'+error.message:'打开结果尚未确认，请先查看 OpenPLC 窗口再重试。');
 }finally{
  agentOpening.delete(key);if(agentContext===ctx)for(const button of $('p-agent-tasks').querySelectorAll('button[data-task-id]'))if(button.dataset.taskId===taskId)button.disabled=false;
 }
}
function switchProject(id){if(id===selectedProject||!projectList.some(p=>p.id===id))return;closeIntegrationDialog(true);closeInterfaceDialog(true);closeAgentDialog();resetLocalDebug();selectedProject=id;++readGeneration;polling=null;snapshot=null;online=false;connectionState=token?'loading':'missing-auth';confirmEnd=null;actionMessage='';selected='runtime';try{history.replaceState(null,'',location.pathname+'?project='+encodeURIComponent(id));}catch{}render();refresh();}
function renderProviderLabels(){
 const fuxa=isFuxaProject(),editor=root.querySelector('[data-node="eez"]'),title=editor.querySelector('.t-tool-title');
 if(title.dataset.provider!==(fuxa?'fuxa':'eez')){title.dataset.provider=fuxa?'fuxa':'eez';title.innerHTML=fuxa?icon('panels-top-left')+'<span>FUXA</span>':'<img src="/assets/eez-studio-logo.png" alt="EEZ Studio 产品标志"><span>EEZ Studio</span>';}
 editor.querySelector('[data-select="eez"]').setAttribute('aria-label','查看 '+designName());
 editor.querySelector('[data-action="open-eez"]').setAttribute('aria-label','打开当前工程的 '+designName()+' 画面');
 root.querySelector('[data-node="hmi"] .p-role').textContent=fuxa?'FUXA 浏览器画面':'LVGL 软件画面';
 const generate=root.querySelector('[data-edge="generate"]');generate.querySelector('.t-mobile-ends').textContent=(fuxa?'FUXA':'EEZ')+' → HMI';generate.querySelector('button').setAttribute('aria-label','查看 '+designName()+' 到 HMI 的画面交付状态');
 $('t-eez-out').setAttribute('aria-label',designName()+' 画面产物接口');
 pipeNames.generate=fuxa?'原生画面':'生成画面';
 for(const [id,path] of [['p-file-eez',hmiFile()],['p-file-hmi',fuxa?hmiFile():currentProject().hmiExecutable],['p-file-plc',currentProject().plc]]){text(id,path?short(path):'');$(id).title=path||'';}
}

function interfaceReason(){
 if(!interfaceContext)return '尚未选择工程。';
 if(selectedProject!==interfaceContext.projectId||snapshot?.project?.id!==interfaceContext.projectId)return '工程已切换，请重新打开变量与操作。';
 if(!online)return '后台连接失效，请恢复后再保存。';
 if(snapshot.instance!==interfaceContext.instance)return '后台已重启，请重新打开变量与操作。';
 if((integration()?.revision||null)!==interfaceContext.revision)return '工程配置已在其他入口更新，请重新打开后编辑，避免覆盖新版本。';
 if((snapshot.sessionId||null)!==interfaceContext.sessionId)return '运行会话已改变，请重新打开配置。';
 return snapshot.capabilities?.canConfigureInterface===true?'':snapshot.capabilities?.reasons?.canConfigureInterface||'请先结束当前工程的运行会话并关闭工具，再修改接口。';
}
function interfaceControl(tag,field,value,label,options){
 const control=document.createElement(tag);control.dataset.interfaceField=field;control.setAttribute('aria-label',label);control.autocomplete='off';
 if(tag==='select')for(const [v,t] of options){const o=document.createElement('option');o.value=v;o.textContent=t;control.append(o);}
 control.value=value??'';return control;
}
function interfaceCell(row,control){const td=document.createElement('td');td.append(control);row.append(td);return control;}
function interfaceCheck(row,field,value,label){const wrap=document.createElement('label');wrap.className='p-interface-check';const control=interfaceControl('input',field,'',label);control.type='checkbox';control.checked=value===true;wrap.append(control,document.createTextNode(label));interfaceCell(row,wrap);return control;}
function interfaceRemove(row){const button=document.createElement('button');button.type='button';button.className='p-button';button.dataset.action='interface-remove-row';button.textContent='删除';button.setAttribute('aria-label','删除这一行');interfaceCell(row,button);}
function interfaceRows(kind){return [...$(kind==='variables'?'p-interface-variables':'p-interface-operations').querySelectorAll('tr')];}
function interfaceValue(row,field){return row.querySelector('[data-interface-field="'+field+'"]');}
function addInterfaceVariable(value={}){
 if(!interfaceContext||interfaceBusy)return;
 const row=document.createElement('tr'),label='变量 '+(interfaceRows('variables').length+1)+' ';
 for(const field of ['id','label','path']){const control=interfaceCell(row,interfaceControl('input',field,value[field],label+({id:'标识',label:'名称',path:'PLC 路径'})[field]));control.required=true;control.maxLength=field==='path'?240:80;if(field==='path')control.placeholder='MAIN.Value';}
 interfaceCell(row,interfaceControl('select','type',value.type||'BOOL',label+'类型',[['BOOL','BOOL'],['INT','INT'],['REAL','REAL']]));
 interfaceCell(row,interfaceControl('select','access',value.access||'read',label+'权限',[['read','只读'],['readwrite','可操作']]));
 for(const field of ['min','max','unit']){const control=interfaceCell(row,interfaceControl('input',field,value[field],label+({min:'最小值',max:'最大值',unit:'单位'})[field]));if(field!=='unit'){control.type='number';control.step='any';}else control.maxLength=24;}
 interfaceCheck(row,'aiVisible',value.aiVisible!==false,'AI 可见');interfaceRemove(row);$('p-interface-variables').append(row);syncInterfaceOperations();updateInterfaceSummary();return row;
}
function addInterfaceOperation(value={}){
 if(!interfaceContext||interfaceBusy)return;
 const row=document.createElement('tr'),label='操作 '+(interfaceRows('operations').length+1)+' ';
 for(const field of ['id','label']){const control=interfaceCell(row,interfaceControl('input',field,value[field],label+(field==='id'?'标识':'名称')));control.required=true;control.maxLength=80;}
 interfaceCell(row,interfaceControl('select','kind',value.kind||'write',label+'方式',[['write','写入'],['pulse','脉冲']]));
 const variable=interfaceCell(row,interfaceControl('select','variable','',label+'目标变量',[]));variable.dataset.savedValue=value.variable||'';variable.required=true;
 interfaceCell(row,interfaceControl('select','valueFrom',value.valueFrom==='input'?'input':'fixed',label+'取值',[['fixed','固定值'],['input','用户输入']]));
 const fixed=interfaceCell(row,interfaceControl('input','value',value.value===undefined?'':String(value.value),label+'固定值'));fixed.placeholder='true / false 或数字';
 const duration=interfaceCell(row,interfaceControl('input','durationMs',value.durationMs??200,label+'脉冲毫秒'));duration.type='number';duration.min='100';duration.max='2000';duration.step='1';
 interfaceCheck(row,'enabled',value.enabled!==false,'已启用');interfaceCheck(row,'aiVisible',value.aiVisible!==false,'AI 可见');interfaceRemove(row);$('p-interface-operations').append(row);syncInterfaceOperations();updateInterfaceSummary();return row;
}
function syncInterfaceOperations(){
 const variables=interfaceRows('variables').map(row=>({id:interfaceValue(row,'id').value.trim(),label:interfaceValue(row,'label').value.trim(),type:interfaceValue(row,'type').value,access:interfaceValue(row,'access').value}));
 for(const row of interfaceRows('variables'))for(const field of ['min','max']){const control=interfaceValue(row,field),type=interfaceValue(row,'type').value;control.disabled=interfaceBusy||type==='BOOL';control.required=type!=='BOOL'&&interfaceValue(row,'access').value==='readwrite';control.step=type==='INT'?'1':'any';if(type==='INT'){control.min='-32768';control.max='32767';}else{control.removeAttribute('min');control.removeAttribute('max');}}
 for(const row of interfaceRows('operations')){
  const select=interfaceValue(row,'variable'),selected=select.value||select.dataset.savedValue||'',choices=variables.filter(v=>v.id&&v.access==='readwrite'),signature=JSON.stringify(choices.map(v=>[v.id,v.label]));
  if(select.dataset.options!==signature){select.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='选择可操作变量';select.append(empty);for(const v of choices){const option=document.createElement('option');option.value=v.id;option.textContent=v.label+' · '+v.id;select.append(option);}if(selected&&!choices.some(v=>v.id===selected)){const option=document.createElement('option');option.value=selected;option.textContent=selected+' · 不可操作/已移除';select.append(option);}select.value=selected;select.dataset.options=signature;}select.dataset.savedValue=select.value;
  const pulse=interfaceValue(row,'kind').value==='pulse',input=interfaceValue(row,'valueFrom').value==='input',variable=variables.find(v=>v.id===select.value);
  interfaceValue(row,'durationMs').disabled=interfaceBusy||!pulse;interfaceValue(row,'durationMs').required=pulse;
  interfaceValue(row,'value').disabled=interfaceBusy||input||pulse;interfaceValue(row,'value').required=!input&&!pulse;
  interfaceValue(row,'valueFrom').disabled=interfaceBusy||pulse;if(pulse){interfaceValue(row,'valueFrom').value='fixed';interfaceValue(row,'value').value='true';}
  interfaceValue(row,'value').placeholder=variable?.type==='BOOL'?'true 或 false':'数字';
  const enabled=interfaceValue(row,'enabled');row.dataset.enabled=String(enabled.checked);enabled.parentElement.lastChild.textContent=enabled.checked?'已启用':'已禁用';
 }
}
function updateInterfaceSummary(){
 const variables=interfaceRows('variables'),operations=interfaceRows('operations'),writable=variables.filter(row=>interfaceValue(row,'access').value==='readwrite').length,enabled=operations.filter(row=>interfaceValue(row,'enabled').checked).length;
 text('p-interface-summary',variables.length+' 个变量 · '+(variables.length-writable)+' 个只读 · '+writable+' 个可操作 · '+enabled+' / '+operations.length+' 个操作启用');
 $('p-interface-empty-variables').hidden=variables.length>0;$('p-interface-empty-operations').hidden=operations.length>0;
}
function updateInterfaceForm(){
 const form=$('p-interface-form'),reason=interfaceReason();for(const control of form.querySelectorAll('input,select,button'))control.disabled=interfaceBusy;
 $('p-interface-submit').disabled=interfaceBusy||interfaceUncertain||!!reason;form.setAttribute('aria-busy',String(interfaceBusy));text('p-interface-submit',interfaceBusy?'正在校验并保存…':'保存变量与操作');syncInterfaceOperations();
 if(reason&&!interfaceBusy&&!interfaceUncertain)text('p-interface-message',reason);
}
function showInterfaceDialog(){
 if(!cap('canConfigureInterface')||isBatchInterface()||interfaceBusy)return;
 const p=currentProject(),definition=p.interfaceDefinition||{variables:[],operations:[]};interfaceContext={projectId:p.id,name:p.name,instance:snapshot.instance,sessionId:snapshot.sessionId||null,revision:integration()?.revision||null,title:definition.title,description:definition.description};interfaceUncertain=false;$('p-interface-hmi-source').value='';
 text('p-interface-scope',p.name+' · '+(p.manifestPath||'当前工程定义'));$('p-interface-variables').replaceChildren();$('p-interface-operations').replaceChildren();
 for(const variable of definition.variables||[])addInterfaceVariable(variable);for(const operation of definition.operations||[])addInterfaceOperation(operation);
 text('p-interface-message','只保存接口与工程画面；不会打开工具、写入变量或启动 PLC。');updateInterfaceSummary();updateInterfaceForm();
 const dialog=$('p-interface-dialog');if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}$('p-interface-add-variable').focus();
}
function closeInterfaceDialog(force=false){if(interfaceBusy&&!force)return;const dialog=$('p-interface-dialog');if(dialog.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}interfaceContext=null;}
function collectInterface(){
 const ids=new Set(),paths=new Set(),identifier=/^[A-Za-z_][A-Za-z0-9_]{0,39}$/,reserved=new Set(['constructor','prototype','__proto__']);
 if(interfaceRows('variables').length>128||interfaceRows('operations').length>128)throw Error('每个工程最多声明 128 个变量和 128 个操作。');
 const variables=interfaceRows('variables').map(row=>{
  const variable={};for(const field of ['id','label','path','type','access'])variable[field]=interfaceValue(row,field).value.trim();variable.aiVisible=interfaceValue(row,'aiVisible').checked;
  if(!identifier.test(variable.id)||reserved.has(variable.id)||ids.has(variable.id))throw Error('变量标识须为 1–40 位字母、数字或下划线，以字母或下划线开头，且不得重复或使用保留名称。');ids.add(variable.id);
  if(!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(variable.path))throw Error(variable.label+' 的 PLC 路径至少包含程序名与变量名，如 MAIN.Value。');
  if(paths.has(variable.path.toUpperCase()))throw Error('PLC 变量路径不得重复。');paths.add(variable.path.toUpperCase());
  if(variable.type!=='BOOL')for(const field of ['min','max']){const raw=interfaceValue(row,field).value.trim();if(raw!==''){variable[field]=Number(raw);if(!Number.isFinite(variable[field])||(variable.type==='INT'&&!Number.isInteger(variable[field])))throw Error(variable.label+' 的范围必须是有效'+(variable.type==='INT'?'整数。':'数字。'));}}
  if(variable.type!=='BOOL'&&variable.access==='readwrite'&&(variable.min===undefined||variable.max===undefined))throw Error(variable.label+' 为可操作数值变量，必须填写最小值和最大值。');
  if(variable.min!==undefined&&variable.max!==undefined&&variable.min>variable.max)throw Error(variable.label+' 的最小值不能大于最大值。');
  if(variable.type==='REAL'&&['min','max'].some(field=>variable[field]!==undefined&&!Number.isFinite(Math.fround(variable[field]))))throw Error(variable.label+' 的范围超出 REAL 支持的数值。');
  const unit=interfaceValue(row,'unit').value.trim();if(unit)variable.unit=unit;return variable;
 });
 if(!variables.length)throw Error('请至少声明一个 PLC 变量。');
 const opIds=new Set(),operations=interfaceRows('operations').map(row=>{
  const op={};for(const field of ['id','label','kind','variable'])op[field]=interfaceValue(row,field).value.trim();op.enabled=interfaceValue(row,'enabled').checked;op.aiVisible=interfaceValue(row,'aiVisible').checked;
  if(!identifier.test(op.id)||reserved.has(op.id)||opIds.has(op.id))throw Error('操作标识格式无效、重复或使用保留名称。');opIds.add(op.id);
  const variable=variables.find(v=>v.id===op.variable);if(!variable||variable.access!=='readwrite')throw Error(op.label+' 必须绑定本工程的可操作变量。');
  if(op.kind==='pulse'){if(variable.type!=='BOOL')throw Error(op.label+' 的脉冲只支持 BOOL 变量。');op.value=true;op.durationMs=Number(interfaceValue(row,'durationMs').value);}
  else if(interfaceValue(row,'valueFrom').value==='input')op.valueFrom='input';
  else {const raw=interfaceValue(row,'value').value.trim();if(variable.type==='BOOL'){if(!/^(true|false|0|1)$/i.test(raw))throw Error(op.label+' 的固定值必须为 true/false 或 1/0。');op.value=/^(true|1)$/i.test(raw);}else{op.value=Number(raw);if(raw===''||!Number.isFinite(op.value)||(variable.type==='INT'&&!Number.isInteger(op.value)))throw Error(op.label+' 的固定值类型不匹配。');if((variable.min!==undefined&&op.value<variable.min)||(variable.max!==undefined&&op.value>variable.max))throw Error(op.label+' 的固定值超出变量范围。');}}
  return op;
 });
 return {schemaVersion:1,protocol:'project-interface-v1',...(interfaceContext.title?{title:interfaceContext.title}:{}),...(interfaceContext.description?{description:interfaceContext.description}:{}),variables,operations};
}
async function submitInterfaceForm(){
 if(interfaceBusy||interfaceUncertain||interfaceReason()||!$('p-interface-form').reportValidity())return;
 let definition;try{definition=collectInterface();}catch(error){text('p-interface-message',error.message);return;}
 const bound=interfaceContext;interfaceBusy=true;busyProjects.set(bound.projectId,{projectName:bound.name,action:'project-interface-configure',message:'正在保存「'+bound.name+'」的变量与操作…'});text('p-interface-message','正在校验 PLC 变量与操作权限，并保存工程画面。');render();
 try{
  const hmiSource=$('p-interface-hmi-source').value.trim();
  const result=await api('action',{action:'project-interface-configure',projectId:bound.projectId,sessionId:bound.sessionId,client,sequence:++sequence,expires:Date.now()/1000+12,configurationRevision:bound.revision,definition,...(hmiSource?{hmiSource}:{})},150000);
  if(!result.ok||result.projectId!==bound.projectId||result.project?.id!==bound.projectId)throw Error('后台未确认同一工程的结果，请重新打开工程核对。');
  projectList=projectList.map(p=>p.id===bound.projectId?result.project:p);treeMetadata.delete(bound.projectId);
  if(interfaceContext===bound&&selectedProject===bound.projectId){closeInterfaceDialog(true);actionMessage='变量、操作与工程画面已保存。尚未启动工具或运行会话。';++readGeneration;polling=null;await refresh();}
 }catch(error){if(interfaceContext===bound&&selectedProject===bound.projectId){interfaceUncertain=error.name==='AbortError'||!error.connectionState;text('p-interface-message',interfaceUncertain?'保存结果尚未确认，请关闭后重新打开工程核对；不要重复提交。':error.message);if(error.connectionState==='invalid-auth')connectionFailure(error);}}
 finally{interfaceBusy=false;busyProjects.delete(bound.projectId);if(interfaceContext===bound)updateInterfaceForm();if(selectedProject===bound.projectId)await refresh();else render();}
}

function integrationReason(){
 if(!integrationContext)return '尚未选择配置工程。';
 if(selectedProject!==integrationContext.projectId||snapshot?.project?.id!==integrationContext.projectId)return '工程已切换，请在当前工程重新打开配置。';
 if(!online)return '后台连接失效，请恢复后再保存。';
 if(snapshot.instance!==integrationContext.instance)return '后台已重启，请关闭并重新打开配置。';
 if((integration()?.revision||null)!==integrationContext.revision)return '工程配置已在其他入口更新，请重新打开后编辑，避免覆盖新版本。';
 return snapshot.capabilities?.canConfigureProject===true?'':snapshot.capabilities?.reasons?.canConfigureProject||'当前不能修改工程配置，请先结束所属运行会话和工具。';
}
function updateIntegrationForm(){
 const form=$('p-integration-form'),reason=integrationReason();
 for(const field of form.querySelectorAll('input'))field.disabled=integrationBusy;
 $('p-integration-close').disabled=integrationBusy;$('p-integration-cancel').disabled=integrationBusy;
 $('p-integration-submit').disabled=integrationBusy||integrationUncertain||!!reason||!integrationContext?.bindings;
 text('p-integration-submit',integrationBusy?'正在导入与校验…':'保存工程配置');form.setAttribute('aria-busy',String(integrationBusy));
 if(reason&&!integrationBusy&&!integrationUncertain)text('p-integration-message',reason);
}
function showIntegrationDialog(){
 if(!cap('canConfigureProject')||integrationBusy)return;
 const p=currentProject(),config=p.configuration,binding=config?.bindings||snapshot.projectCatalog?.bindingDefaults;
 integrationContext={projectId:p.id,name:p.name,instance:snapshot.instance,sessionId:snapshot.sessionId||null,revision:config?.revision||null,bindings:binding?JSON.parse(JSON.stringify(binding)):null};
 integrationUncertain=false;const rows=$('p-binding-rows');rows.replaceChildren();
 text('p-integration-scope',p.name+' · 保存到 '+(p.manifestPath||'当前工程定义'));
 const sources=snapshot.projectCatalog?.integrationSources||{};
 $('p-integration-hmi').value=config?.hmiFile?'':sources.hmiSource||'';$('p-integration-oip').value=config?.sceneFile?'':sources.oipSource||'';$('p-integration-hmi').required=!config?.hmiFile;$('p-integration-oip').required=!config?.sceneFile;
 text('p-integration-saved-hmi',config?.hmiFile?'已保存：'+config.hmiFile+'。留空沿用；填写新路径将替换工程副本。':sources.hmiSource?'已填入示例画面来源，可改为自己的兼容画面；原文件保留。':'首次配置需要画面文件；原文件保留。');
 text('p-integration-saved-oip',config?.sceneFile?'已保存：'+config.sceneFile+'。留空沿用；填写新路径将替换工程副本。':sources.oipSource?'已填入示例场景来源，可更换并核对下方场景名称和点位；原文件保留。':'首次配置需要完整场景目录；原文件保留。');
 for(const [role,entry] of Object.entries(binding?.plc||{})){const tr=document.createElement('tr'),name=document.createElement('th');name.scope='row';name.textContent=role;tr.append(name);for(const field of ['path','type','location']){const td=document.createElement('td'),input=document.createElement('input');input.value=entry[field]||'';input.required=true;input.autocomplete='off';input.dataset.bindingRole=role;input.dataset.bindingField=field;input.setAttribute('aria-label',role+' '+({path:'变量路径',type:'IEC 类型',location:'IEC 地址'})[field]);td.append(input);tr.append(td);}rows.append(tr);}
 $('p-binding-scene').value=binding?.oip?.scene?.project||'';
 $('p-binding-sensor').value=binding?.oip?.inputs?.sensorOccupied?.address??'';
 $('p-binding-active-high').checked=binding?.oip?.inputs?.sensorOccupied?.activeHigh!==false;
 $('p-binding-entry').value=binding?.oip?.outputs?.entryConveyor?.address??'';
 $('p-binding-conveyor').value=binding?.oip?.outputs?.conveyor?.address??'';
 text('p-integration-message',binding?'只保存配置，不打开工具或启动运行。': '后台尚未提供绑定模板，请更新并重启工作台后台。');
 updateIntegrationForm();const dialog=$('p-integration-dialog');if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}$('p-integration-hmi').focus();
}
function closeIntegrationDialog(force=false){
 if(integrationBusy&&!force)return;const dialog=$('p-integration-dialog');if(dialog.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}integrationContext=null;
}
async function submitIntegrationForm(){
 if(integrationBusy||integrationUncertain||integrationReason()||!integrationContext?.bindings||!$('p-integration-form').reportValidity())return;
 const bound=integrationContext,bindings=JSON.parse(JSON.stringify(bound.bindings));
 for(const input of $('p-binding-rows').querySelectorAll('input'))bindings.plc[input.dataset.bindingRole][input.dataset.bindingField]=input.value.trim();
 bindings.oip.inputs.sensorOccupied={...bindings.oip.inputs.sensorOccupied,address:Number($('p-binding-sensor').value),activeHigh:$('p-binding-active-high').checked};
 bindings.oip.outputs.entryConveyor={...bindings.oip.outputs.entryConveyor,address:Number($('p-binding-entry').value)};
 bindings.oip.outputs.conveyor={...bindings.oip.outputs.conveyor,address:Number($('p-binding-conveyor').value)};bindings.oip.scene={...bindings.oip.scene,project:$('p-binding-scene').value.trim()};
 const hmiSource=$('p-integration-hmi').value.trim(),oipSource=$('p-integration-oip').value.trim();
 integrationBusy=true;busyProjects.set(bound.projectId,{projectName:bound.name,action:'project-configure',message:'正在保存「'+bound.name+'」的组件与变量绑定…'});text('p-integration-message','正在导入工程副本并校验绑定，请稍候。');updateIntegrationForm();render();
 try{
  const result=await api('action',{action:'project-configure',projectId:bound.projectId,sessionId:bound.sessionId,client,sequence:++sequence,expires:Date.now()/1000+12,configurationRevision:bound.revision,...(hmiSource?{hmiSource}:{}),...(oipSource?{oipSource}:{}),bindings},150000);
  if(!result.ok||result.projectId!==bound.projectId||result.project?.id!==bound.projectId)throw Error('后台未确认相同工程的保存结果，请重新打开工程核对。');
  projectList=projectList.map(p=>p.id===bound.projectId?result.project:p);treeMetadata.delete(bound.projectId);
  if(integrationContext===bound&&selectedProject===bound.projectId){closeIntegrationDialog(true);actionMessage='画面、场景与绑定已保存。尚未启动工具或运行会话。';++readGeneration;polling=null;await refresh();}
 }catch(error){
  if(integrationContext===bound&&selectedProject===bound.projectId){integrationUncertain=error.name==='AbortError'||!error.connectionState;text('p-integration-message',integrationUncertain?'保存结果尚未确认，请关闭并重新打开配置核对；不要重复提交。':error.message);if(error.connectionState==='invalid-auth')connectionFailure(error);}
 }finally{
  integrationBusy=false;busyProjects.delete(bound.projectId);if(integrationContext===bound)updateIntegrationForm();if(selectedProject===bound.projectId)await refresh();else render();
 }
}
function updateProjectForm(){
 const mode=$('p-project-operation').value,opening=mode==='open',importing=mode==='import';
 $('p-project-create-fields').hidden=opening;$('p-project-manifest-field').hidden=!opening;$('p-project-source-field').hidden=!importing;$('p-project-language-field').hidden=importing;
 for(const id of ['p-project-name','p-project-parent','p-project-language','p-project-simulation'])$(id).disabled=catalogBusy||opening;
 for(const id of ['p-project-name','p-project-parent'])$(id).required=!opening;
 $('p-project-source').disabled=catalogBusy||!importing;$('p-project-source').required=importing;
 $('p-project-manifest').disabled=catalogBusy||!opening;$('p-project-manifest').required=opening;
 $('p-project-language').disabled=catalogBusy||opening||importing;
 $('p-project-operation').disabled=catalogBusy;
 $('p-project-dialog-close').disabled=catalogBusy;$('p-project-dialog-cancel').disabled=catalogBusy;
 const allowed=opening?snapshot?.projectCatalog?.canOpen:snapshot?.projectCatalog?.canCreate;
 $('p-project-submit').disabled=catalogBusy||catalogUncertain||!online||allowed!==true;
 text('p-project-dialog-title',opening?'打开工程':importing?'导入工程副本':'新建工程');
 text('p-project-submit',catalogBusy?'正在处理…':opening?'打开工程':importing?'导入副本':'创建工程');
 $('p-project-form').setAttribute('aria-busy',String(catalogBusy));
}
function showProjectDialog(mode){
 if(catalogBusy||!online)return;
 $('p-project-operation').value=mode;
 if(!$('p-project-parent').value)$('p-project-parent').value=snapshot?.projectCatalog?.defaultParent||'';
 if(!catalogUncertain)text('p-project-form-message','');updateProjectForm();
 const dialog=$('p-project-dialog');if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
 $(mode==='open'?'p-project-manifest':'p-project-name').focus();
}
function closeProjectDialog(){if(catalogBusy)return;const dialog=$('p-project-dialog');if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
async function submitProjectForm(){
 if(catalogBusy||catalogUncertain||!online||!$('p-project-form').reportValidity())return;
 const mode=$('p-project-operation').value,opening=mode==='open',catalog=snapshot?.projectCatalog;
 if((opening?catalog?.canOpen:catalog?.canCreate)!==true)return;
 const request=opening?{action:'project-open',manifestPath:$('p-project-manifest').value.trim()}:{action:'project-create',name:$('p-project-name').value.trim(),parent:$('p-project-parent').value.trim(),language:$('p-project-language').value,simulation:$('p-project-simulation').value,...(mode==='import'?{source:$('p-project-source').value.trim()}:{})};
 const instance=snapshot.instance,boundProject=selectedProject,boundSession=snapshot.sessionId||null;
 catalogBusy=true;text('p-project-form-message',opening?'正在读取工程定义…':'正在建立工程和 OpenPLC 程序，请稍候。现有运行会话保持原状。');updateProjectForm();renderConnection();
 try{
  const result=await api('action',{...request,projectId:boundProject,sessionId:boundSession,client,sequence:++sequence,expires:Date.now()/1000+12},150000);
  if(!result.ok||!result.projectId||result.project?.id!==result.projectId)throw Error('后台未返回有效的工程身份，请检查工程目录后再打开。');
  if(snapshot?.instance&&snapshot.instance!==instance)throw Error('后台已重启；工程操作结果需要重新核对，请通过工程文件打开。');
  projectList=[...projectList.filter(p=>p.id!==result.projectId),result.project];catalogBusy=false;closeProjectDialog();
  if(result.projectId===selectedProject){++readGeneration;polling=null;await refresh();}else switchProject(result.projectId);
 }catch(e){
  if(e.connectionState==='invalid-auth')connectionFailure(e);
  catalogUncertain=e.name==='AbortError'||!e.connectionState;
  text('p-project-form-message',catalogUncertain?'结果尚未确认：'+(e.name==='AbortError'?'等待后台响应超时。':e.message)+' 请先检查保存位置，已有 project.plcdev 时使用“打开工程”，避免重复新建。':e.message);
 }finally{catalogBusy=false;updateProjectForm();renderConnection();}
}
async function act(body){
 if(body.action==='configure-project'){showIntegrationDialog();return;}
 if(body.action==='configure-interface'){showInterfaceDialog();return;}
 const project=selectedProject;if(busyProjects.has(project)||!online||snapshot?.project?.id!==project)return;if(body.action==='tool'&&((body.tool==='factory'&&!factoryScene().canOpen)||(body.tool==='factory-window'&&!factoryScene().canShow)))return;
 const boundSession=snapshot?.sessionId||null,instance=snapshot?.instance,projectName=snapshot.project.name;
 const operation=body.action==='tool'&&body.tool==='factory'?'打开工程场景 '+short(factoryScene().target):body.action==='tool'&&body.tool==='factory-window'?'显示现有 Factory I/O 窗口':{start:'编译并准备',end:'结束会话','runtime-start':'运行 PLC','runtime-stop':'停止 PLC','show-hmi':'打开 HMI','reopen-hmi':'重新打开 HMI',tool:'打开关联工具',input:body.input==='start'?'发送启动脉冲':'发送停止脉冲'}[body.action]||'执行操作';
 busyProjects.set(project,{projectName,action:body.action,message:'正在为「'+projectName+'」'+operation+'，等待确认…'});++readGeneration;polling=null;actionMessage='';render();
 try{await api('action',{...body,projectId:project,client,sequence:++sequence,expires:Date.now()/1000+12,sessionId:boundSession});if(project===selectedProject)actionMessage='';}
 catch(e){if(e.connectionState==='invalid-auth')connectionFailure(e);else if(project===selectedProject)actionMessage=e.name==='AbortError'?'操作确认超时，正在重新读取状态；请勿重复提交。':e.message;}
 finally{busyProjects.delete(project);if(project===selectedProject){if(snapshot?.instance!==instance)confirmEnd=null;await refresh();}render();}
}
root.addEventListener('click',event=>{
 const el=event.target.closest('[data-select],button');if(!el||!root.contains(el)||el.disabled)return;
 const toggle=event.target.closest('[data-tree-toggle]');if(toggle){const id=toggle.dataset.treeToggle;treeExpanded.set(id,!treeExpanded.get(id));treeFocusKey='project:'+id;renderProjectTree();focusTree([...treeButtons()].find(item=>item.dataset.treeKey===treeFocusKey));return;}
 if(el.dataset.infoTab){selectInfoTab(el.dataset.infoTab);return;}
 if(el.dataset.project){if(el.classList.contains('p-tree-project')){treeExpanded.set(el.dataset.project,true);treeFocusKey=el.dataset.treeKey;if(el.dataset.project===selectedProject){selectObject('project');return;}}switchProject(el.dataset.project);return;}
 if(el.dataset.select){if(el.dataset.treeOwner&&el.dataset.treeOwner!==selectedProject)return;selectObject(el.dataset.select);return;}
 if(el.dataset.detailAction||el.dataset.detailSecondary){const d=detail(),action=el.dataset.detailSecondary?d?.secondary:d?.action;if(action?.allowed)act(action.body);return;}
 const key=el.dataset.action;
 if(key==='retry-connection'){retryConnection();return;}
 if(key==='close-detail'){selected=null;infoCollapsed=true;render();}
 else if(key==='ask-end'){if(cap('canEnd'))confirmEnd=sessionKey();render();}
 else if(key==='cancel-end'){confirmEnd=null;render();}
 else if(key==='end'){if(confirmEnd&&confirmEnd===sessionKey()&&cap('canEnd')){confirmEnd=null;act({action:'end'});}}
 else if(key==='input-start'||key==='input-stop'){if(cap('canInput'))act({action:'input',input:key==='input-start'?'start':'stop'});}
 else if(key==='open-plc')act({action:'tool',tool:'plc'});
 else if(key==='open-eez')act({action:'tool',tool:isFuxaProject()?'fuxa':'hmi'});
 else if(key==='open-fio'){if(factoryScene().canOpen)act(factoryAction().body);}
 else if(key==='show-fio'){if(factoryScene().canShow)act({action:'tool',tool:'factory-window'});}
 else if(key==='open-hmi')act({action:isFuxaProject()?'open-hmi':'show-hmi'});
 else if(key==='logs')act({action:'tool',tool:'logs'});
 else if(['start','runtime-start','runtime-stop','show-hmi'].includes(key))act({action:key==='show-hmi'&&isFuxaProject()?'open-hmi':key});
 else if(key==='agent-open')showAgentDialog();
 else if(key==='agent-close')closeAgentDialog();
 else if(key==='agent-refresh')loadAgentTasks();
 else if(key==='agent-example'){if(!agentCreateBusy&&!agentPending.has(selectedProject)){$('p-agent-request').value='将 Count 改为 BatchCount';updateAgentForm();}}
 else if(key==='agent-open-candidate')openAgentCandidate(el.dataset.taskId,el.dataset.digest);
 else if(key==='configure-interface')showInterfaceDialog();
 else if(key==='close-interface')closeInterfaceDialog();
 else if(key==='interface-add-variable')addInterfaceVariable();
 else if(key==='interface-add-operation')addInterfaceOperation();
 else if(key==='interface-remove-row'){el.closest('tr').remove();syncInterfaceOperations();updateInterfaceSummary();}
 else if(key==='configure-project')showIntegrationDialog();
 else if(key==='close-integration')closeIntegrationDialog();
});
root.addEventListener('keydown',event=>{
 const tab=event.target.closest('[data-info-tab]');
 if(tab&&$('p-info-tabs')?.contains(tab)){
  const tabs=[...$('p-info-tabs').querySelectorAll('[data-info-tab]')],index=tabs.indexOf(tab);let target=null;
  if(event.key==='ArrowRight')target=tabs[(index+1)%tabs.length];else if(event.key==='ArrowLeft')target=tabs[(index-1+tabs.length)%tabs.length];else if(event.key==='Home')target=tabs[0];else if(event.key==='End')target=tabs.at(-1);
  if(target){event.preventDefault();selectInfoTab(target.dataset.infoTab,true);}return;
 }
 const item=event.target.closest('[role="treeitem"]');if(!item||!$('p-project-tree')?.contains(item)||item.disabled)return;
 const visible=treeButtons(),index=visible.indexOf(item),owner=item.dataset.treeOwner||item.dataset.project;let target=null;
 if(event.key==='ArrowDown')target=visible[Math.min(index+1,visible.length-1)];
 else if(event.key==='ArrowUp')target=visible[Math.max(index-1,0)];
 else if(event.key==='Home')target=visible[0];else if(event.key==='End')target=visible.at(-1);
 else if(event.key==='ArrowRight'&&item.classList.contains('p-tree-project')){if(item.getAttribute('aria-expanded')==='false'){treeExpanded.set(owner,true);renderProjectTree();target=treeButtons().find(button=>button.dataset.project===owner);}else target=treeButtons().find(button=>button.dataset.treeOwner===owner);}
 else if(event.key==='ArrowLeft'){if(item.dataset.treeOwner)target=visible.find(button=>button.dataset.project===owner);else if(item.getAttribute('aria-expanded')==='true'){treeExpanded.set(owner,false);renderProjectTree();target=treeButtons().find(button=>button.dataset.project===owner);}}
 else if(event.key==='Enter'||event.key===' '){event.preventDefault();item.click();return;}
 if(target){event.preventDefault();focusTree(target);}
});
root.addEventListener('focusin',event=>{const item=event.target.closest('[role="treeitem"]');if(item&&$('p-project-tree')?.contains(item))treeFocusKey=item.dataset.treeKey;});
root.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;const key=button.dataset.action;if(key==='new-project')showProjectDialog('create');else if(key==='open-project')showProjectDialog('open');else if(key==='close-project-dialog')closeProjectDialog();});
$('p-agent-form').addEventListener('submit',event=>{event.preventDefault();submitAgentTask();});
$('p-agent-request').addEventListener('input',updateAgentForm);
$('p-agent-saved-basis').addEventListener('change',updateAgentForm);
$('p-agent-dialog').addEventListener('cancel',()=>{++agentLoadGeneration;agentContext=null;if(agentRefreshTimer!==null){clearTimeout(agentRefreshTimer);agentRefreshTimer=null;}});
$('p-interface-form').addEventListener('submit',event=>{event.preventDefault();submitInterfaceForm();});
$('p-interface-form').addEventListener('input',()=>{if(!interfaceBusy){syncInterfaceOperations();updateInterfaceSummary();}});
$('p-interface-form').addEventListener('change',()=>{if(!interfaceBusy){syncInterfaceOperations();updateInterfaceSummary();}});
$('p-interface-dialog').addEventListener('cancel',event=>{if(interfaceBusy)event.preventDefault();else interfaceContext=null;});
$('p-integration-form').addEventListener('submit',event=>{event.preventDefault();submitIntegrationForm();});
$('p-integration-dialog').addEventListener('cancel',event=>{if(integrationBusy)event.preventDefault();else integrationContext=null;});
$('p-project-form').addEventListener('submit',event=>{event.preventDefault();submitProjectForm();});
$('p-project-operation').addEventListener('change',()=>{catalogUncertain=false;text('p-project-form-message','');updateProjectForm();});
$('p-project-form').addEventListener('input',()=>{if(!catalogBusy&&catalogUncertain){catalogUncertain=false;text('p-project-form-message','请先确认此前的工程是否已经创建，避免重复操作。');updateProjectForm();}});
$('p-project-dialog').addEventListener('cancel',event=>{if(catalogBusy)event.preventDefault();});
$('p-project').addEventListener('change',event=>switchProject(event.target.value));
document.addEventListener('visibilitychange',render);
if(motionQuery?.addEventListener)motionQuery.addEventListener('change',event=>{reducedMotion=event.matches;render();});else if(motionQuery?.addListener)motionQuery.addListener(event=>{reducedMotion=event.matches;render();});
if(globalThis.ResizeObserver)new ResizeObserver(drawRoutes).observe($('p-graph'));window.addEventListener('resize',drawRoutes);render();refresh();setInterval(()=>{if(!['missing-auth','invalid-auth'].includes(connectionState))refresh();},1000);
})();
