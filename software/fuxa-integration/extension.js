/* Native FUXA companion. Layouts remain editable native SVG gauges. */
(() => {
  'use strict';
  let context=null, connected=false, attemptedConnection=false, aiOperation=null;
  let heartbeatSequence=0, commandSequence=0, managementSequence=0, contextVersion=0, contextRequest=0;
  let stopped=false, heartbeatBusy=false, managementBusy=false, refreshBusy=false;
  let localError='', dismissedServerError='', completionNotice='', promptTouched=false, interfaceSeen=false;
  const resolutionKey='plcdev-ai-outstanding-resolution';let outstanding=null,checkingReceipt=false;
  try{const raw=sessionStorage.getItem(resolutionKey);if(raw){const value=JSON.parse(raw);outstanding=value&&typeof value==='object'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)&&['keep','undo'].includes(value.action)?value:{invalid:true};}}catch{outstanding={invalid:true};}
  const genericPrompt='根据本工程声明的变量和可用操作，设计一个清晰简洁的操作画面。显示关键状态和单位，允许输入的值与 PLC 当前值分开，只提供本工程授权的操作按钮。';
  const client='hmi-'+crypto.randomUUID().replaceAll('-','').slice(0,24);
  const el=(tag,cls,text,id)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;if(id)n.id=id;return n;};
  installPlcdevNativeBrand();
  const dock=el('aside','plcdev-ai plcdev-scope');dock.setAttribute('aria-label','PLCdev AI 画面助手');
  const toggle=el('button','plcdev-ai-toggle','AI 画面','plcdev-ai-toggle');toggle.type='button';toggle.title=plcdevNativeBrand.brandName+' · AI 画面助手';toggle.replaceChildren(plcdevNativeTitle('AI 画面'));
  toggle.setAttribute('aria-controls','plcdev-ai-panel');toggle.setAttribute('aria-expanded','false');
  const panel=el('section','plcdev-ai-panel plcdev-scope plcdev-rail','','plcdev-ai-panel');panel.hidden=true;const heading=el('h2');heading.append(plcdevNativeTitle('AI 画面助手'));panel.append(heading);
  const settings=el('div','plcdev-ai-settings'),switchRow=el('div','plcdev-ai-switch-row');
  const aiSwitch=el('button','plcdev-ai-switch','已关闭','plcdev-ai-enabled');aiSwitch.type='button';aiSwitch.setAttribute('role','switch');aiSwitch.setAttribute('aria-label','启用 DeepSeek AI');aiSwitch.setAttribute('aria-checked','false');
  switchRow.append(el('span','','DeepSeek AI'),aiSwitch);
  const model=el('div','plcdev-ai-config-line','','plcdev-ai-model'),provider=el('div','plcdev-ai-config-line','','plcdev-ai-provider');
  const configStatus=el('p','plcdev-ai-config-status','','plcdev-ai-config-status'),checkConfig=el('button','plcdev-ai-check','刷新配置','plcdev-ai-check');
  checkConfig.type='button';checkConfig.title='仅检查本机 OpenPLC 配置，不发送模型请求';
  settings.append(switchRow,model,provider,configStatus,checkConfig,el('p','plcdev-ai-config-note','复用 OpenPLC 的 DeepSeek 配置；这里不显示密钥。'));panel.append(settings);
  const links=el('p','plcdev-ai-links');for(const [name,url]of[['编辑画面','/editor'],['运行画面','/home']]){const a=el('a','plcdev-link',name);a.href=url;links.append(a);}panel.append(links);
  const promptLabel=el('label','plcdev-ai-prompt-label','生成或修改需求');promptLabel.htmlFor='plcdev-ai-prompt';
  const prompt=el('textarea','','','plcdev-ai-prompt');prompt.rows=5;prompt.setAttribute('aria-describedby','plcdev-ai-context-note');
  prompt.value='设计一个清晰简洁的输送带批次计数画面，目标可设为 3 或 5 件，显示当前计数、目标、3 秒启动延时、设备通信、PLC 状态和命令结果。包括启动、停止、故障、复位、新批次及断线后人工数量确认。突出数量与状态，编辑值和 PLC 接受值分开。';
  const interfaceBox=el('details','plcdev-ai-interface','','plcdev-ai-interface'),interfaceSummary=el('summary','','本工程可用变量与操作'),interfaceContent=el('div','plcdev-ai-interface-content');interfaceBox.hidden=true;interfaceBox.append(interfaceSummary,interfaceContent);panel.append(interfaceBox);
  prompt.addEventListener('input',()=>promptTouched=true);
  panel.append(promptLabel,prompt,el('p','plcdev-ai-context-note','现有画面会作为上下文。说明要改哪里，生成后可继续原生编辑，再保留或撤销。','plcdev-ai-context-note'));
  const state=el('p','plcdev-ai-state','连接本机服务…','plcdev-ai-state');state.setAttribute('role','status');state.setAttribute('aria-live','polite');
  const errorBox=el('div','plcdev-ai-error','','plcdev-ai-error'),errorText=el('p','','','plcdev-ai-error-text');
  errorBox.hidden=true;errorText.setAttribute('role','alert');
  const dismissError=el('button','','清除提示','plcdev-ai-dismiss-error');dismissError.type='button';errorBox.append(errorText,dismissError);
  const history=el('details','plcdev-ai-interface','','plcdev-ai-resolution-history'),historyText=el('p','','','plcdev-ai-resolution-history-text');history.hidden=true;history.append(el('summary','','最近一次已完成的旧事务'),historyText);
  const preservation=el('section','plcdev-ai-interface','','plcdev-ai-preservation');preservation.hidden=true;
  const preserveNote=el('p','','仅保全当前可读取的画面快照，不覆盖源文件、不解除保存阻断。外链图片不会随快照复制：/_images 和 /resources 资源分别存放在原 profile 的 _images 和 _appdata/_upload_files 中，请保留原 profile。设备安全设置及其他资源仍须另行核对；快照可能含工程配置，请妥善保管。');
  const preserve=el('button','','保全画面快照','plcdev-ai-preserve');preserve.type='button';
  const preserveResult=el('p','','','plcdev-ai-preserve-result');preserveResult.setAttribute('role','status');preservation.append(preserveNote,preserve,preserveResult);panel.append(preservation);
  const actions=el('div','plcdev-ai-actions'),generate=el('button','','生成／修改并预览','plcdev-ai-generate'),keep=el('button','','写回当前工程','plcdev-ai-keep'),undo=el('button','','撤销预览','plcdev-ai-undo');
  generate.classList.add('plcdev-action');keep.classList.add('plcdev-action');
  keep.title='将当前 FUXA 预览写回此工程画面文件；不会创建独立工程副本。';
  undo.title='恢复生成前的 FUXA 画面；不会写回当前工程文件。';
  for(const b of[generate,keep,undo]){b.type='button';actions.append(b);}panel.append(state,errorBox,history,actions);dock.append(toggle,panel);
  const toast=el('div','plcdev-ai-toast');toast.hidden=true;toast.setAttribute('role','status');dock.append(toast);
  const recoveryBanner=el('aside','plcdev-recovery-banner','','plcdev-recovery-banner');recoveryBanner.hidden=true;recoveryBanner.setAttribute('role','status');recoveryBanner.setAttribute('aria-live','polite');
  const statusbar=el('aside','plcdev-runtime-bar');statusbar.setAttribute('aria-label','PLC Runtime 管理');
  const runtimeLabel=el('span','','PLC Runtime · 未连接'),run=el('button','','运行 PLC'),stop=el('button','','停止 PLC');run.type=stop.type='button';run.title='启动 Runtime；不会自动启动输送批次';stop.title='停止 Runtime；独立于画面心跳与过程停止按钮';statusbar.append(runtimeLabel,run,stop);
  let toastTimer;
  function tell(message){toast.textContent=message;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.hidden=true,6500);}
  function aiState(){const a=context?.ai||{};return{enabled:a.enabled??context?.aiEnabled??false,busy:!!a.busy,configuration:a.configuration||{state:'unchecked',model:'deepseek-flash',providerHost:'api.deepseek.com',message:'请刷新配置，检查本机 DeepSeek 设置。'},lastError:a.lastError||''};}
  function display(){
    const ai=aiState(),recovery=context?.recovery,blocked=!!aiOperation||ai.busy||!!recovery||!!outstanding,config=ai.configuration;
    const nativeUnknown=recovery?.reasonCode==='native_write_unknown',aiUnknown=recovery?.reasonCode==='ai_resolution_unknown',uncertain=nativeUnknown||aiUnknown;recoveryBanner.hidden=!uncertain;
    preservation.hidden=!uncertain;preserve.disabled=!connected||!!aiOperation||ai.busy;
    const warning=!connected?'上次画面事务结果未确认；当前连接已断开，状态无法确认。请停止编辑并保留现场。':nativeUnknown?'原生画面或设备设置保存结果未确认；画面和设备保存已阻断，其他原生编辑仍可能可操作。请停止编辑并保留现场。':'上次 AI 画面事务结果未确认；画面和设备保存已阻断，其他原生编辑仍可能可操作。请停止编辑并保留现场。';
    if(uncertain&&recoveryBanner.textContent!==warning)recoveryBanner.textContent=warning;
    aiSwitch.setAttribute('aria-checked',String(ai.enabled));aiSwitch.textContent=ai.enabled?'已开启':'已关闭';aiSwitch.disabled=!connected||blocked;
    checkConfig.disabled=!connected||blocked;checkConfig.textContent=aiOperation==='check'?'检查中…':'刷新配置';
    model.textContent='模型 · '+(config.model||'未配置');provider.textContent='服务 · '+(config.providerHost?'https://'+config.providerHost+'/v1':'未配置');
    const labels={ready:'本机配置可用',missing:'未找到本机配置',unreadable:'本机配置无法读取',unavailable:'本机配置检查不可用',unchecked:'本机配置尚未检查'};
    configStatus.textContent=(labels[config.state]||'配置状态未知')+(config.message?' · '+config.message:'');configStatus.dataset.state=config.state||'unchecked';
    generate.disabled=!connected||blocked||!ai.enabled||config.state!=='ready'||!!context?.pending;
    keep.disabled=undo.disabled=!connected||blocked||!context?.pending;prompt.disabled=blocked;
    const serverError=ai.lastError&&ai.lastError!==dismissedServerError?ai.lastError:'';
    errorText.textContent=localError||serverError;errorBox.hidden=!errorText.textContent;
    const last=context?.lastResolution;history.hidden=!last;
    historyText.textContent=last?((last.action==='keep'?'已写回当前工程画面':'已撤销预览')+' · 事务 '+last.transactionId+' · '+last.completedAt+(last.journalPending?'。事务记录仍待核对，请保留现场。':'。此记录不能证明其他事务的结果。')):'';
    let kind='ready',message=completionNotice||'可以生成新画面，或按需求修改现有画面。';
    if(!connected){kind=attemptedConnection?'offline':'loading';message=attemptedConnection?'集成服务离线。请恢复本机 FUXA 服务；重连后不会自动提交请求。':'连接本机服务…';}
    else if(recovery){kind='error';message=recovery.message||'旧画面事务暂无法核对；原记录未改动。';}
    else if(outstanding){kind='error';message=outstanding.invalid?'上次事务身份无法读取，请保留现场核对。':'上次写回或撤销结果尚未确认；正在核对原事务，请勿重新提交。';}
    else if(blocked){kind='busy';message={generate:'AI 正在生成可撤销预览，请稍候…',keep:'正在写回当前工程画面…',undo:'正在恢复生成前的工程…',settings:'正在更新 AI 开关…',check:'正在检查本机配置，不发送模型请求…'}[aiOperation]||'另一页面正在处理 AI 事务，请稍候…';}
    else if(context?.pending){kind='pending';message='旧预览待处理。写回会修改当前工程画面文件；撤销恢复预览前画面，均不会创建副本。';}
    else if(localError||serverError){kind='error';message='上次操作的提示保留在下方，请先核对。';}
    else if(completionNotice){kind='ready';message=completionNotice;}
    else if(!ai.enabled){kind='disabled';message='AI 已关闭。开启后可手动生成；开启本身不会发送模型请求。';}
    else if(config.state!=='ready'){kind='configuration';message='请刷新配置；需要在 OpenPLC 中保存有效的 DeepSeek 设置。';}
    state.textContent=message;panel.dataset.aiState=kind;
  }
  async function api(url,body){
    const response=await fetch('/plcdev/'+url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-PLCdev-HMI':context?.capability||''}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(url==='ai/generate'?190000:6500)});
    let data;try{data=await response.json();}catch{throw Error('本机服务返回无效响应，请核对结果');}if(!response.ok||data.ok===false)throw Object.assign(Error(data.error||'本机请求失败'),{status:response.status});return data;
  }
  function rememberResolution(value){sessionStorage.setItem(resolutionKey,JSON.stringify(value));if(sessionStorage.getItem(resolutionKey)!==JSON.stringify(value))throw Error('无法保存事务核对信息；本次未提交。');outstanding=value;}
  function forgetResolution(){sessionStorage.removeItem(resolutionKey);outstanding=null;}
  async function checkResolution(){
    const item=outstanding;if(!item||item.invalid||checkingReceipt||!connected)return;
    if(item.projectId!==(context?.projectId??null)){localError='原事务属于另一个工程；请返回原工程核对，未重新提交。';display();return;}
    checkingReceipt=true;
    try{const result=await api('ai/receipt',{transactionId:item.id,action:item.action});if(outstanding!==item)return;
      if(result.state==='completed'){
        forgetResolution();localError='';completionNotice=item.action==='keep'?'已核对：上次操作已写回当前工程画面，未创建副本。':'已核对：上次操作已恢复生成前画面。';
        if(result.journalPending)localError='操作已完成，但事务记录仍待核对；请保留现场。';
      }else localError='尚无可确认的事务回执；请保留现场，未自动重试。';
    }catch{if(outstanding===item)localError='暂时无法读取事务回执；结果未知，未自动重试。';}
    finally{checkingReceipt=false;display();}
  }
  function acceptContext(data){context=data;if(data.interface){interfaceBox.hidden=false;interfaceContent.replaceChildren();for(const v of data.interface.variables||[])interfaceContent.append(el('p','','变量 · '+v.label+' ('+v.id+') · '+v.type+(v.unit?' · '+v.unit:'')+(v.min!==undefined?' · '+v.min+'…'+v.max:'')+' · '+(v.access==='read'?'只读':'按授权操作写入')));for(const o of data.interface.operations||[])interfaceContent.append(el('p','','操作 · '+o.label+' ('+o.id+') → '+o.variable+(o.valueFrom==='input'?' · 使用编辑值':'')));if(!interfaceSeen&&!promptTouched)prompt.value=genericPrompt;interfaceSeen=true;run.title='启动当前工程 Runtime；工艺动作由工程程序与操作声明决定';}else{interfaceBox.hidden=true;}contextVersion++;connected=true;attemptedConnection=true;display();}
  async function connect(){
    if(stopped||refreshBusy)return;refreshBusy=true;const request=++contextRequest,version=contextVersion;
    try{const data=await api('context');if(request===contextRequest&&version===contextVersion){acceptContext(data);await checkResolution();}}
    catch{if(request===contextRequest&&version===contextVersion){connected=false;attemptedConnection=true;display();}}
    finally{refreshBusy=false;}
  }
  async function operate(kind,action){
    if(aiOperation||aiState().busy||!connected)return;
    aiOperation=kind;contextVersion++;localError='';completionNotice='';dismissedServerError=aiState().lastError;display();
    try{await action();}catch(error){localError=error.message||'本机操作失败，请重试';}
    finally{aiOperation=null;contextVersion++;display();await connect();}
  }
  const envelope=sequence=>({client,sequence,expires:Date.now()/1000+3,epoch:context?.epoch});
  function runningView(){return /^\/home(?:\/|$)/.test(location.pathname)&&!!document.querySelector('g[id^="VAL_PLCD_"],g[id^="HXB_PLCD_"],g[id^="HXI_PLCD_"],g[id^="PLCD_"][type^="svg-ext-"]');}
  async function heartbeat(){if(stopped||!context||heartbeatBusy||!runningView())return;heartbeatBusy=true;try{await api('heartbeat',envelope(++heartbeatSequence));}catch(e){if(e.message.includes('会话已改变'))await connect();}finally{heartbeatBusy=false;}}
  window.PLCdevHmi={command:async(action,value)=>{if(!context||!runningView()){tell('请在运行画面提交操作');return{ok:false};}try{const result=await api('command',{...envelope(++commandSequence),action,...(value===undefined?{}:{value})});tell(result.message||'PLC 已确认操作');return result;}catch(e){tell(e.message);return{ok:false,error:e.message};}}};
  async function runtimeStatus(){try{const s=await api('state'),r=s.telemetry.runtimeState;runtimeLabel.textContent='PLC Runtime · '+(r==='RUNNING'?'运行中':r==='STOPPED'?'已停止':'未知');run.disabled=managementBusy||!s.connected||r==='RUNNING';stop.disabled=managementBusy||!s.connected||r==='STOPPED';}catch{runtimeLabel.textContent='PLC Runtime · 未连接';run.disabled=stop.disabled=true;}}
  async function management(action){if(managementBusy)return;managementBusy=true;run.disabled=stop.disabled=true;try{const result=await api('management',{...envelope(++managementSequence),action});tell(result.message);}catch(e){tell(e.message);}finally{managementBusy=false;runtimeStatus();}}
  run.addEventListener('click',()=>management('run'));stop.addEventListener('click',()=>management('stop'));
  toggle.addEventListener('click',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)connect();});
  aiSwitch.addEventListener('click',()=>operate('settings',async()=>acceptContext(await api('ai/settings',{enabled:!aiState().enabled}))));
  checkConfig.addEventListener('click',()=>operate('check',async()=>acceptContext(await api('ai/check',{}))));
  preserve.addEventListener('click',()=>operate('preserve',async()=>{
    preserveResult.textContent='正在核对当前保存意图和画面…';
    const status=await api('native-recovery/status',{});
    try{const result=await api('native-recovery/export',{transactionId:status.transactionId});preserveResult.textContent='画面快照：'+result.path+' · SHA-256：'+result.sha256+'。原事务结果仍未知；/_images 和 /resources 外链图片未随快照复制，请保留原 profile，设备安全设置和其他资源仍须核对。';}
    catch(e){preserveResult.textContent='快照结果尚未确认。可再次保全以核对同一意图，已有文件不会覆盖；请保留原现场。';throw e;}
  }));
  dismissError.addEventListener('click',()=>{localError='';dismissedServerError=aiState().lastError;display();});
  function reloadPreview(){try{sessionStorage.setItem('plcdev-ai-open','1');sessionStorage.setItem('plcdev-ai-prompt',prompt.value);}catch{}location.reload();}
  async function resolvePreview(action){
    const item={id:context.transactionId,action,projectId:context.projectId??null};
    try{rememberResolution(item);}catch{throw Error('无法保存事务核对信息；本次未提交。');}
    try{await api('ai/'+action,{transactionId:item.id});forgetResolution();}
    catch(error){
      // These local rejections occur before any native write. All transport,
      // timeout and server failures remain unknown until an ID-scoped receipt.
      if([400,403,422].includes(error.status)){forgetResolution();throw error;}
      throw Error('操作结果尚未确认；将核对原事务，不会自动重试。');
    }
  }
  generate.addEventListener('click',()=>operate('generate',async()=>{await api('ai/generate',{prompt:prompt.value});reloadPreview();}));
  keep.addEventListener('click',()=>operate('keep',async()=>{await resolvePreview('keep');completionNotice='已写回当前工程画面文件；未创建独立副本。';}));
  undo.addEventListener('click',()=>operate('undo',async()=>{await resolvePreview('undo');reloadPreview();}));
  function init(){
    document.body.append(dock,statusbar,recoveryBanner);
    try{if(sessionStorage.getItem('plcdev-ai-open')){panel.hidden=false;toggle.setAttribute('aria-expanded','true');sessionStorage.removeItem('plcdev-ai-open');}const saved=sessionStorage.getItem('plcdev-ai-prompt');if(saved){prompt.value=saved;promptTouched=true;}}catch{}
    display();connect();runtimeStatus();setInterval(heartbeat,300);setInterval(runtimeStatus,1000);setInterval(connect,5000);
  }
  window.addEventListener('pagehide',()=>stopped=true);window.addEventListener('pageshow',()=>{stopped=false;connect();});window.addEventListener('focus',()=>connect());
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();

if(typeof installPlcdevPreviewBanner==='function')installPlcdevPreviewBanner(async(action,revision)=>{
 const read=async(path,options={})=>{const response=await fetch('/plcdev/'+path,{...options,signal:AbortSignal.timeout(action==='current'?40000:5000)});if(!response.ok)throw Error('Preview unavailable');return response.json();};
 if(action==='status')return read('native-preview/status');
 const context=await read('context');
 return read('native-preview/current',{method:'POST',headers:{'Content-Type':'application/json','X-PLCdev-HMI':context.capability},body:JSON.stringify({revision})});
},clearance=>{
 for(const node of document.querySelectorAll('.plcdev-ai,.plcdev-runtime-bar,.plcdev-recovery-banner'))
  node.style.setProperty('--plcdev-preview-clearance',clearance+'px');
});
