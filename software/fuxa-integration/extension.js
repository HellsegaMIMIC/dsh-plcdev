/* Native FUXA companion. Layouts remain editable native SVG gauges. */
(() => {
  'use strict';
  let context=null, connected=false, attemptedConnection=false, aiOperation=null;
  let heartbeatSequence=0, commandSequence=0, managementSequence=0, contextVersion=0, contextRequest=0;
  let stopped=false, heartbeatBusy=false, managementBusy=false, refreshBusy=false;
  let localError='', dismissedServerError='', completionNotice='', promptTouched=false, interfaceSeen=false;
  const genericPrompt='根据本工程声明的变量和可用操作，设计一个清晰简洁的操作画面。显示关键状态和单位，允许输入的值与 PLC 当前值分开，只提供本工程授权的操作按钮。';
  const client='hmi-'+crypto.randomUUID().replaceAll('-','').slice(0,24);
  const el=(tag,cls,text,id)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;if(id)n.id=id;return n;};
  const dock=el('aside','plcdev-ai');dock.setAttribute('aria-label','PLCdev AI 画面助手');
  const toggle=el('button','plcdev-ai-toggle','AI 画面','plcdev-ai-toggle');toggle.type='button';toggle.title='用 DeepSeek 生成或修改原生 FUXA 画面';
  toggle.setAttribute('aria-controls','plcdev-ai-panel');toggle.setAttribute('aria-expanded','false');
  const panel=el('section','plcdev-ai-panel','','plcdev-ai-panel');panel.hidden=true;panel.append(el('h2','','AI 画面助手'));
  const settings=el('div','plcdev-ai-settings'),switchRow=el('div','plcdev-ai-switch-row');
  const aiSwitch=el('button','plcdev-ai-switch','已关闭','plcdev-ai-enabled');aiSwitch.type='button';aiSwitch.setAttribute('role','switch');aiSwitch.setAttribute('aria-label','启用 DeepSeek AI');aiSwitch.setAttribute('aria-checked','false');
  switchRow.append(el('span','','DeepSeek AI'),aiSwitch);
  const model=el('div','plcdev-ai-config-line','','plcdev-ai-model'),provider=el('div','plcdev-ai-config-line','','plcdev-ai-provider');
  const configStatus=el('p','plcdev-ai-config-status','','plcdev-ai-config-status'),checkConfig=el('button','plcdev-ai-check','刷新配置','plcdev-ai-check');
  checkConfig.type='button';checkConfig.title='仅检查本机 OpenPLC 配置，不发送模型请求';
  settings.append(switchRow,model,provider,configStatus,checkConfig,el('p','plcdev-ai-config-note','复用 OpenPLC 的 DeepSeek 配置；这里不显示密钥。'));panel.append(settings);
  const links=el('p','plcdev-ai-links');for(const [name,url]of[['编辑画面','/editor'],['运行画面','/home']]){const a=el('a','',name);a.href=url;links.append(a);}panel.append(links);
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
  const actions=el('div','plcdev-ai-actions'),generate=el('button','','生成／修改并预览','plcdev-ai-generate'),keep=el('button','','保留','plcdev-ai-keep'),undo=el('button','','撤销','plcdev-ai-undo');
  for(const b of[generate,keep,undo]){b.type='button';actions.append(b);}panel.append(state,errorBox,actions);dock.append(toggle,panel);
  const toast=el('div','plcdev-ai-toast');toast.hidden=true;toast.setAttribute('role','status');dock.append(toast);
  const statusbar=el('aside','plcdev-runtime-bar');statusbar.setAttribute('aria-label','PLC Runtime 管理');
  const runtimeLabel=el('span','','PLC Runtime · 未连接'),run=el('button','','运行 PLC'),stop=el('button','','停止 PLC');run.type=stop.type='button';run.title='启动 Runtime；不会自动启动输送批次';stop.title='停止 Runtime；独立于画面心跳与过程停止按钮';statusbar.append(runtimeLabel,run,stop);
  let toastTimer;
  function tell(message){toast.textContent=message;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.hidden=true,6500);}
  function aiState(){const a=context?.ai||{};return{enabled:a.enabled??context?.aiEnabled??false,busy:!!a.busy,configuration:a.configuration||{state:'unchecked',model:'deepseek-flash',providerHost:'api.deepseek.com',message:'请刷新配置，检查本机 DeepSeek 设置。'},lastError:a.lastError||''};}
  function display(){
    const ai=aiState(),blocked=!!aiOperation||ai.busy,config=ai.configuration;
    aiSwitch.setAttribute('aria-checked',String(ai.enabled));aiSwitch.textContent=ai.enabled?'已开启':'已关闭';aiSwitch.disabled=!connected||blocked;
    checkConfig.disabled=!connected||blocked;checkConfig.textContent=aiOperation==='check'?'检查中…':'刷新配置';
    model.textContent='模型 · '+(config.model||'未配置');provider.textContent='服务 · '+(config.providerHost?'https://'+config.providerHost+'/v1':'未配置');
    const labels={ready:'本机配置可用',missing:'未找到本机配置',unreadable:'本机配置无法读取',unavailable:'本机配置检查不可用',unchecked:'本机配置尚未检查'};
    configStatus.textContent=(labels[config.state]||'配置状态未知')+(config.message?' · '+config.message:'');configStatus.dataset.state=config.state||'unchecked';
    generate.disabled=!connected||blocked||!ai.enabled||config.state!=='ready'||!!context?.pending;
    keep.disabled=undo.disabled=!connected||blocked||!context?.pending;prompt.disabled=blocked;
    const serverError=ai.lastError&&ai.lastError!==dismissedServerError?ai.lastError:'';
    errorText.textContent=localError||serverError;errorBox.hidden=!errorText.textContent;
    let kind='ready',message=completionNotice||'可以生成新画面，或按需求修改现有画面。';
    if(!connected){kind=attemptedConnection?'offline':'loading';message=attemptedConnection?'集成服务离线。请恢复本机 FUXA 服务；重连后不会自动提交请求。':'连接本机服务…';}
    else if(blocked){kind='busy';message={generate:'AI 正在生成可撤销预览，请稍候…',keep:'正在保留原生工程…',undo:'正在恢复生成前的工程…',settings:'正在更新 AI 开关…',check:'正在检查本机配置，不发送模型请求…'}[aiOperation]||'另一页面正在处理 AI 事务，请稍候…';}
    else if(context?.pending){kind='pending';message='预览待确认。请保留或撤销；关闭 AI 后仍可处理这份预览。';}
    else if(localError||serverError){kind='error';message='上次操作未完成，错误保留在下方。确认后可重试。';}
    else if(!ai.enabled){kind='disabled';message='AI 已关闭。开启后可手动生成；开启本身不会发送模型请求。';}
    else if(config.state!=='ready'){kind='configuration';message='请刷新配置；需要在 OpenPLC 中保存有效的 DeepSeek 设置。';}
    state.textContent=message;panel.dataset.aiState=kind;
  }
  async function api(url,body){
    const response=await fetch('/plcdev/'+url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-PLCdev-HMI':context?.capability||''}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(url==='ai/generate'?190000:6500)});
    let data;try{data=await response.json();}catch{throw Error('本机服务返回无效响应，请刷新重试');}if(!response.ok||data.ok===false)throw Error(data.error||'本机请求失败');return data;
  }
  function acceptContext(data){context=data;if(data.interface){interfaceBox.hidden=false;interfaceContent.replaceChildren();for(const v of data.interface.variables||[])interfaceContent.append(el('p','','变量 · '+v.label+' ('+v.id+') · '+v.type+(v.unit?' · '+v.unit:'')+(v.min!==undefined?' · '+v.min+'…'+v.max:'')+' · '+(v.access==='read'?'只读':'按授权操作写入')));for(const o of data.interface.operations||[])interfaceContent.append(el('p','','操作 · '+o.label+' ('+o.id+') → '+o.variable+(o.valueFrom==='input'?' · 使用编辑值':'')));if(!interfaceSeen&&!promptTouched)prompt.value=genericPrompt;interfaceSeen=true;run.title='启动当前工程 Runtime；工艺动作由工程程序与操作声明决定';}else{interfaceBox.hidden=true;}contextVersion++;connected=true;attemptedConnection=true;display();}
  async function connect(){
    if(stopped||refreshBusy)return;refreshBusy=true;const request=++contextRequest,version=contextVersion;
    try{const data=await api('context');if(request===contextRequest&&version===contextVersion)acceptContext(data);}
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
  dismissError.addEventListener('click',()=>{localError='';dismissedServerError=aiState().lastError;display();});
  function reloadPreview(){try{sessionStorage.setItem('plcdev-ai-open','1');sessionStorage.setItem('plcdev-ai-prompt',prompt.value);}catch{}location.reload();}
  generate.addEventListener('click',()=>operate('generate',async()=>{await api('ai/generate',{prompt:prompt.value});reloadPreview();}));
  keep.addEventListener('click',()=>operate('keep',async()=>{await api('ai/keep',{transactionId:context.transactionId});completionNotice='已保留原生工程；可继续编辑或提出下一次修改。';}));
  undo.addEventListener('click',()=>operate('undo',async()=>{await api('ai/undo',{transactionId:context.transactionId});reloadPreview();}));
  function init(){
    document.body.append(dock,statusbar);
    try{if(sessionStorage.getItem('plcdev-ai-open')){panel.hidden=false;toggle.setAttribute('aria-expanded','true');sessionStorage.removeItem('plcdev-ai-open');}const saved=sessionStorage.getItem('plcdev-ai-prompt');if(saved){prompt.value=saved;promptTouched=true;}}catch{}
    display();connect();runtimeStatus();setInterval(heartbeat,300);setInterval(runtimeStatus,1000);setInterval(connect,5000);
  }
  window.addEventListener('pagehide',()=>stopped=true);window.addEventListener('pageshow',()=>{stopped=false;connect();});window.addEventListener('focus',()=>connect());
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
