'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const legacyNative=require('./native-project.cjs'),interfaces=require('./project-interface.cjs');
const {collectUtf8}=require('./model-output.cjs');
const {settings}=require('./ai-settings.cjs');
const {projectFile,rebase:rebaseProject}=require('./project-file.cjs');
const {profileLease}=require('./profile-lease.cjs');
const nativeIntent=require('./native-write-intent.cjs');
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const now=()=>Date.now()/1000;
function uncertainResolution(value){
 const r=value?.resolution;
 const action=r&&typeof r==='object'&&!Array.isArray(r)&&r.version===1&&r.state==='unknown'?r.action:null;
 return action==='keep'?'上次写回的结果未知；请核对源画面及原事务记录，未自动重试或撤销。':action==='undo'?'上次撤销的结果未知；请核对原生画面及原事务记录，未自动重试或写回。':'上次事务操作的结果未知；请保留现场核对，未自动重试、撤销或写回。';
}
// JSON.parse accepts duplicate keys, which can hide a damaged recovery
// marker. Match the discovery service and fail closed before using the record.
function strictTransaction(raw){
 const parsed=JSON.parse(raw);let i=0;
 const space=()=>{while(/[\x20\t\r\n]/.test(raw[i]||'\0'))i++;};
 const string=()=>{const start=i++;while(i<raw.length){const c=raw[i++];if(c==='\\')i++;else if(c==='"')return JSON.parse(raw.slice(start,i));}throw Error('invalid string');};
 function value(){
  space();const c=raw[i];
  if(c==='"'){string();return;}
  if(c==='{'){
   i++;space();const keys=new Set();if(raw[i]==='}'){i++;return;}
   for(;;){space();const key=string();if(keys.has(key))throw Error('duplicate transaction field');keys.add(key);space();i++;value();space();if(raw[i++]==='}')return;}
  }
  if(c==='['){i++;space();if(raw[i]===']'){i++;return;}for(;;){value();space();if(raw[i++]===']')return;}}
  while(i<raw.length&&!/[\x20\t\r\n,\]}]/.test(raw[i]))i++;
 }
 value();return parsed;
}
function mount(app){
 const preview=require('../native-preview-client.cjs').previewClient(process.env.PLCDEV_NATIVE_PREVIEW);
 const express=require(require.resolve('express',{paths:[process.env.PLCDEV_FUXA_ROOT]}));
 const port=Number(process.env.PLCDEV_FUXA_PORT||18810),origin='http://127.0.0.1:'+port;
 const profile=process.env.PLCDEV_FUXA_PROFILE;if(!profile)throw Error('PLCDEV_FUXA_PROFILE is required');
 const interfaceFile=process.env.PLCDEV_FUXA_INTERFACE_FILE||null,interfaceBytes=interfaceFile?fs.readFileSync(interfaceFile):null;
 const definition=interfaceBytes?interfaces.forContract(JSON.parse(interfaceBytes.toString('utf8').replace(/^\uFEFF/,''))):null,native=definition||legacyNative;
 const interfaceFingerprint=interfaceBytes?hash(interfaceBytes.toString('utf8')):null;
 const rebase=(value,base)=>rebaseProject(value,base,definition);
 const savedir=path.join(profile,'plcdev');fs.mkdirSync(savedir,{recursive:true});
 // Acquire before reading a transaction or creating project-owner metadata.
 // A second integrated FUXA process must not start with the same profile.
 const lease=profileLease(savedir);
 try{
 // The native launcher used to initialize this file before the profile lock.
 // Keep its original contents, but create it only while owning the profile.
 const work=path.join(profile,'_appdata'),settingsFile=path.join(work,'settings.js');
 fs.mkdirSync(work,{recursive:true});
 try{fs.writeFileSync(settingsFile,'module.exports={...require('+JSON.stringify(path.join(process.env.PLCDEV_FUXA_ROOT,'settings.default.js'))+'),uiHost:"127.0.0.1",uiPort:'+port+',nodeRedEnabled:false,daqEnabled:false,secureEnabled:false,swaggerEnabled:false,logApiLevel:"none",hideEditorOnboarding:true};\n',{flag:'wx'});}
 catch(e){if(e.code!=='EEXIST')throw e;}
 const transactionFile=path.join(savedir,'transaction.json');
 const ai=settings({directory:savedir});let aiLastError=null,aiSettingsBusy=false;
 const capability=crypto.randomBytes(24).toString('hex'),drafts=definition?{...definition.drafts}:{targetDraft:3,recoveryDraft:0},clients=new Map();
 let pending=null,recoveryError=null,aiBusy=false,nativeWrites=0,nativeTail=Promise.resolve(),commandResult='尚未提交命令',cached=null,cachedAt=0,inflight=null;
 try{
  const bytes=fs.readFileSync(transactionFile);if(bytes.length>16*1024*1024)throw Error('transaction too large');
  const value=strictTransaction(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));
  if(value!==null){
   if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)||![value.baseline,value.project,value.spec].every(x=>x&&typeof x==='object'&&!Array.isArray(x)))throw Error('invalid transaction');
   if(!Object.hasOwn(value,'resolution')&&value.sourceRevision!=null&&(typeof value.sourceRevision!=='object'||Array.isArray(value.sourceRevision)||!/^([a-f0-9]{64})$/.test(value.sourceRevision.sourceHash||'')||!/^([a-f0-9]{64})$/.test(value.sourceRevision.nativeBaselineHash||'')))throw Error('invalid source checkpoint');
   pending=value;
  }
 }catch(e){if(e.code!=='ENOENT')recoveryError='旧画面事务记录无法读取或已损坏；原记录未改动，请保留现场核对。';}
 if(pending&&Object.hasOwn(pending,'resolution'))recoveryError=uncertainResolution(pending);
 if(pending&&process.env.PLCDEV_FUXA_PROJECT_FILE&&(pending.projectId!==process.env.PLCDEV_FUXA_PROJECT_ID||(pending.configHash!==process.env.PLCDEV_FUXA_CONFIG_HASH&&!Object.hasOwn(pending,'resolution'))))recoveryError='待处理画面属于其他工程配置；原记录未改动，请核对所属工程。';
 try{if(nativeIntent.inspect(savedir))recoveryError=nativeIntent.message;}catch{recoveryError=nativeIntent.message;}
 const bound=projectFile({file:process.env.PLCDEV_FUXA_PROJECT_FILE,projectId:process.env.PLCDEV_FUXA_PROJECT_ID,configHash:process.env.PLCDEV_FUXA_CONFIG_HASH,profile,definition,preserveOwner:!!recoveryError});
 let projectReady=!bound,projectInit=null;const internal=crypto.randomBytes(24).toString('hex');
 const save=(value=pending)=>{
  const temp=transactionFile+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});fs.renameSync(temp,transactionFile);}
  catch(e){try{fs.unlinkSync(temp);}catch{}throw e;}
 };
 // The response may be lost after the native effect and before the caller sees
 // it. Keep an ID-scoped receipt before clearing the journal; an absent receipt
 // never means that it is safe to repeat the operation.
 const receiptPath=id=>path.join(savedir,'receipts',id+'.json');
 const receiptOwner=()=>bound?hash(path.resolve(bound.file)):null;
 function saveReceipt(id,action){
  const file=receiptPath(id),directory=path.dirname(file);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const parent=fs.lstatSync(directory);
  if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('invalid receipt directory');
  // Never replace a pre-existing receipt, including a partial one. An error
  // leaves the intent locked and cannot be interpreted as a missing effect.
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({version:1,id,action,projectId:bound?.projectId||null,sourceIdentity:receiptOwner(),completedAt:new Date().toISOString()}));fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  // The small index makes the last completed transaction discoverable even
  // after a browser closes or the FUXA port changes. It is not a receipt by
  // itself; readers revalidate the referenced immutable, project-bound file.
  const index=path.join(savedir,'receipt-latest.json'),temp=index+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify({id,action}),{flag:'wx',mode:0o600});fs.renameSync(temp,index);}
  catch(e){try{fs.unlinkSync(temp);}catch{}throw e;}
 }
 function readSmallRecord(file){
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.size>4096)throw Error('invalid receipt file');
  const fd=fs.openSync(file,'r');try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096)throw Error('invalid receipt file');
   const bytes=Buffer.alloc(4097),length=fs.readSync(fd,bytes,0,bytes.length,0);if(length>4096||length!==stat.size||fs.fstatSync(fd).size!==length)throw Error('invalid receipt file');
   return strictTransaction(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
  }finally{fs.closeSync(fd);}
 }
 function readReceipt(id,action){
  let record;try{const file=receiptPath(id),parent=fs.lstatSync(path.dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('invalid receipt directory');record=readSmallRecord(file);}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!record||record.version!==1||record.id!==id||record.action!==action||record.projectId!==(bound?.projectId||null)||record.sourceIdentity!==receiptOwner()||typeof record.completedAt!=='string')throw Error('invalid receipt');
  return record;
 }
 function lastReceipt(){
  try{const value=readSmallRecord(path.join(savedir,'receipt-latest.json'));
   if(!value||typeof value.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)||!['keep','undo'].includes(value.action))return null;
   const r=readReceipt(value.id,value.action);return r?{transactionId:r.id,action:r.action,completedAt:r.completedAt,journalPending:pending?.id===r.id}:null;
  }catch{return null;}
 }
 const fail=(message,status=400)=>Object.assign(Error(message),{status});
 function assertInterface(){if(!interfaceFile)return;let current;try{current=hash(fs.readFileSync(interfaceFile).toString('utf8'));}catch{}if(current!==interfaceFingerprint)throw fail('工程接口已修改，请关闭并从工作台重新打开 FUXA；旧权限已失效',409);}
 function session(){assertInterface();try{const s=JSON.parse(fs.readFileSync(process.env.PLCDEV_FUXA_SESSION_FILE||'','utf8'));if(bound&&(s.projectId!==bound.projectId||s.configFingerprint!==bound.configHash))throw Error('wrong project');if(definition&&(!s.bridgeToken||typeof s.bridgeToken!=='string'))throw Error('Missing bridge identity');if(!s.sessionId||!s.programHash||!Number.isInteger(s.batchHttpPort)||s.batchHttpPort<1024||s.batchHttpPort>65535)throw Error();return s;}catch{throw fail(definition?'尚未连接当前工程运行会话':'尚未连接批次会话',503);}}
 function epoch(){try{const s=session();return hash([s.sessionId,s.programHash,s.batchHttpPort,...(bound?[bound.projectId,bound.configHash]:[])]).slice(0,24);}catch{return 'unavailable';}}
 function local(req){return ['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress)&&[new URL(origin).host,'localhost:'+port].includes(req.headers.host);}
 const wrap=fn=>(req,res)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>res.status(e.status||500).json({ok:false,error:e.status?e.message:'本机集成请求失败；请检查服务日志'}));
 app.use('/plcdev',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!local(req))return res.status(403).json({ok:false,error:'Local access only'});if(req.headers.origin&&![origin,'http://localhost:'+port].includes(req.headers.origin))return res.status(403).json({ok:false,error:'Origin rejected'});next();});
 app.use('/plcdev',express.json({limit:'512kb'}));
 const authenticated=(req)=>{assertInterface();if(req.headers['x-plcdev-hmi']!==capability)throw fail('页面授权已更新，请刷新页面',403);};
 function gate(req,kind){authenticated(req);const b=req.body||{};if(b.epoch!==epoch())throw fail('运行会话已改变，请刷新页面',409);if(typeof b.client!=='string'||!/^hmi-[a-z0-9-]{1,27}$/.test(b.client))throw fail('Invalid client');if(!Number.isSafeInteger(b.sequence)||b.sequence<1)throw fail('Invalid sequence');if(typeof b.expires!=='number'||b.expires<now()||b.expires>now()+5)throw fail('请求已过期',409);const c=clients.get(b.client)||{heartbeat:0,command:0,management:0,liveAt:0};if(b.sequence<=c[kind])throw fail('旧请求已拒绝',409);c[kind]=b.sequence;clients.set(b.client,c);if(kind==='command'&&now()-c.liveAt>1.5)throw fail('当前画面心跳已过期，请等待重新连接',409);return c;}
 async function upstream(route,opts={}){const s=session();const headers={'X-PLCdev-Session':s.sessionId,'X-PLCdev-Client':opts.client||'fuxa-read',...(bound?{'X-PLCdev-Project':bound.projectId,'X-PLCdev-Config':bound.configHash}:{}),...(definition?{'X-PLCdev-Bridge':s.bridgeToken}:{}),...opts.headers};const isCommand=route==='/command'||route==='/management';let r;try{r=await fetch('http://127.0.0.1:'+s.batchHttpPort+route,{method:opts.method||'GET',headers,body:opts.body,signal:AbortSignal.timeout(isCommand?5500:1200)});}catch{throw Object.assign(fail(isCommand?'命令应答未收到；结果未知，请核对 PLC 后再操作':'批次适配未连接',503),{uncertain:isCommand});}let data;try{data=await r.json();}catch{throw Object.assign(fail(isCommand?'命令应答无效；结果未知，请核对 PLC 后再操作':'批次适配返回无效数据',502),{uncertain:isCommand});}if(!r.ok||data.ok===false)throw fail(data.error||data.message||'PLC 拒绝请求',r.ok?409:r.status);return data;}
 async function state(){assertInterface();if(cached&&cached.epoch===epoch()&&Date.now()-cachedAt<150)return cached;if(inflight)return inflight;inflight=(async()=>{const requestedEpoch=epoch();let raw=null,error=null;try{raw=await upstream('/state');}catch(e){error=e.message;}if(requestedEpoch!==epoch()){raw=null;error='运行会话已改变，等待新会话数据';}if(definition){const fresh=raw?.telemetryFresh===true,values={};for(const [id,v]of definition.variables){let value='— 数据失效';if(fresh&&Object.hasOwn(raw?.values||{},id)){try{interfaces.typed(v,raw.values[id]);value=v.type==='BOOL'?(raw.values[id]?'TRUE':'FALSE'):String(raw.values[id]);}catch{value='— 数据无效';}}values[id]=value;}cached={ok:!!raw,connected:!!raw,epoch:requestedEpoch,telemetry:{telemetryFresh:fresh,runtimeState:raw?.runtimeState||null},tags:{...values,...drafts},drafts:{...drafts},commandResult,...(error?{error}:{})};cachedAt=Date.now();return cached;}const telemetry={};for(const k of ['count','target','batchState','flags','remainingMs','countKnown','targetLocked','requiresManualRecovery','telemetryFresh','sceneRunning','runtimeState','batchId','hmiConnected','oipInputs','ackSequence','ackCode','pending'])telemetry[k]=raw?.[k]??null;telemetry.communication=raw?.communication?{state:raw.communication.state,connected:raw.communication.connected,requiresManualRecovery:raw.communication.requiresManualRecovery,provider:raw.communication.provider,remoteOutputsKnownZero:raw.communication.remoteOutputsKnownZero}:null;
 const fresh=!!raw?.telemetryFresh,known=fresh&&!!raw.countKnown;const phases=['待新批次／可设置目标','启动延时中','输送中','已停止，计数保留','故障锁存','批次完成','数量待核对，等待恢复'];const data={count:known?raw.count:'—',target:fresh?raw.target:'—',countDisplay:known?String(raw.count)+' 件':fresh?'数量未知，需人工核对':'— 数据失效',targetDisplay:fresh?String(raw.target)+' 件'+(raw.targetLocked?' · 已冻结':''):'— 数据失效',phase:raw?.requiresManualRecovery?'连接待确认，请核对数量':fresh?(phases[raw.batchState]||'状态 '+raw.batchState):'等待有效 PLC 数据',quality:!raw?'未连接':fresh?(known?'有效':'数量未知'):(raw.runtimeState==='RUNNING'?'已过期':'STOP · 历史值不作实时显示'),communication:!raw?'未连接':raw.communication?.connected?(raw.sceneRunning===true?'已连接 · 场景运行':raw.sceneRunning===false?'已连接 · 场景停止':'已连接 · 场景未知'):'断开 · 等待重连',runtime:raw?.runtimeState||'未知',remainingDisplay:fresh?(raw.remainingMs/1000).toFixed(1)+' 秒':'—',commandResult,...drafts};
 cached={ok:!!raw,connected:!!raw,epoch:requestedEpoch,telemetry,tags:data,drafts:{...drafts},commandResult,...(error?{error}:{})};cachedAt=Date.now();return cached;})().finally(()=>inflight=null);return inflight;}
 const context=()=>({ok:true,capability,epoch:epoch(),projectId:bound?.projectId||null,configHash:bound?.configHash||null,projectFileStatus:bound?.snapshot()||null,aiEnabled:ai.enabled,ai:{...ai.snapshot(),busy:aiBusy||aiSettingsBusy,lastError:aiLastError},pending:!!pending,transactionId:pending?.id,source:pending?.source,lastResolution:lastReceipt(),drafts,...(definition?{interface:definition.publicContract,interfaceFingerprint}:{})});
 app.get('/plcdev/context',wrap(async(req,res)=>{let recovery=null;try{await ensureProject();}catch(e){if(!pending&&!recoveryError)throw e;recovery={state:'blocked',...(recoveryError===nativeIntent.message?{reasonCode:'native_write_unknown'}:aiRecoveryAvailable()?{reasonCode:'ai_resolution_unknown'}:{}),message:e.status?e.message:'旧画面事务暂无法核对；原记录未改动。'};}await ai.check();res.json({...context(),...(recovery?{recovery}:{})});}));
 app.get('/plcdev/native-preview/status',wrap(async(req,res)=>res.json(await preview('status'))));
 app.post('/plcdev/native-preview/current',wrap(async(req,res)=>{
  if(req.headers['x-plcdev-hmi']!==capability)throw fail('页面授权已更新，请刷新页面',403);
  if(!req.body||Object.keys(req.body).join(',')!=='revision')throw fail('工程版本未确认');
  res.json(await preview('current',req.body.revision));
 }));
 app.post('/plcdev/ai/settings',wrap(async(req,res)=>{authenticated(req);if(aiBusy||aiSettingsBusy)throw fail('AI 正在处理，请完成后再切换开关',409);aiSettingsBusy=true;try{await ai.set(req.body?.enabled);aiLastError=null;}catch(e){aiLastError=e.status?e.message:'AI 设置失败';throw e;}finally{aiSettingsBusy=false;}res.json(context());}));
 app.post('/plcdev/ai/check',wrap(async(req,res)=>{authenticated(req);if(aiBusy||aiSettingsBusy)throw fail('AI 正在处理，请完成后再检查配置',409);aiSettingsBusy=true;try{await ai.check(true);aiLastError=null;}finally{aiSettingsBusy=false;}res.json(context());}));
 app.post('/plcdev/ai/receipt',wrap(async(req,res)=>{
  authenticated(req);const {transactionId:id,action}=req.body||{};
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)||!['keep','undo'].includes(action))throw fail('事务身份无效');
  let record;try{record=readReceipt(id,action);}catch{throw fail('事务回执无法核对，请保留现场。',503);}
  res.json({ok:true,state:record?'completed':'unknown',...(record?{journalPending:pending?.id===id}:{})});
 }));
 app.get('/plcdev/state',wrap(async(req,res)=>res.json(await state())));
 app.get('/plcdev/tags',wrap(async(req,res)=>{const s=await state();res.json(native.TAGS.map(name=>({id:native.tagId(name),name,type:(definition?name.startsWith('$'):['targetDraft','recoveryDraft'].includes(name))?'number':'string',value:s.tags[name]})));}));
 app.post('/plcdev/tags',wrap(async(req,res)=>{assertInterface();if(req.headers.origin)throw fail('Native server tag writes only',403);if(!Array.isArray(req.body)||!req.body.length||req.body.length>(definition?128:2))throw fail('Invalid draft writes');const updates={};for(const item of req.body){if(!item||typeof item!=='object')throw fail('Invalid draft write');if(definition){const key=definition.TAGS.find(key=>key.startsWith('$')&&definition.tagId(key)===item.id);if(!key)throw fail('只允许编辑工程声明的本机草稿值',403);try{updates[key]=definition.draftValue(key,item.value);}catch(e){throw fail(e.message);}}else{const key=String(item.id).replace(/^plcdev_/,'');if(!['targetDraft','recoveryDraft'].includes(key))throw fail('只允许编辑本地草稿值',403);const n=Number(item.value);if(!Number.isInteger(n)||n<0||n>32767)throw fail('草稿值超出范围');updates[key]=n;}}Object.assign(drafts,updates);cachedAt=0;res.json({ok:true,drafts});}));
 app.post('/plcdev/heartbeat',wrap(async(req,res)=>{const c=gate(req,'heartbeat');await upstream('/heartbeat',{method:'POST',client:req.body.client,headers:{'Content-Type':'application/json'},body:'{}'});c.liveAt=now();res.json({ok:true,epoch:epoch()});}));
 app.post('/plcdev/management',wrap(async(req,res)=>{gate(req,'management');const b=req.body;if(!['run','stop'].includes(b.action))throw fail('Unknown management action');const s=session(),kind=b.action==='run'?9:10,form=new URLSearchParams({kind,value:0,program:s.programHash,sequence:b.sequence,expires:b.expires});const result=await upstream('/management',{method:'POST',client:b.client,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});cachedAt=0;res.json({ok:true,applied:result.applied===true,kind:result.kind,value:result.value,message:b.action==='run'?(definition?'Runtime 已运行；工艺操作请使用声明按钮':'Runtime 已运行；批次需另行启动'):'Runtime 已停止'});}));
 app.post('/plcdev/command',wrap(async(req,res)=>{gate(req,'command');const b=req.body;if(!Object.hasOwn(native.ACTIONS,b.action))throw fail('Unknown or disabled command',definition?403:400);const s=session();let headers,body;if(definition){let value;try{value=definition.operationValue(b.action,b.value,drafts);}catch(e){throw fail(e.message,403);}headers={'Content-Type':'application/json'};body=JSON.stringify({action:b.action,value,program:s.programHash,sequence:b.sequence,expires:b.expires});}else{const value=b.value===undefined?(b.action==='target'?drafts.targetDraft:b.action==='recover'?drafts.recoveryDraft:0):b.value;if(!Number.isInteger(value)||value<0||value>32767)throw fail('命令数值超出范围');headers={'Content-Type':'application/x-www-form-urlencoded'};body=new URLSearchParams({kind:native.ACTIONS[b.action],value,program:s.programHash,sequence:b.sequence,expires:b.expires}).toString();}try{const result=await upstream('/command',{method:'POST',client:b.client,headers,body});commandResult='已确认：'+(definition?.operations.get(b.action)?.label||b.action);cachedAt=0;res.json({ok:true,applied:result.applied===true,ackSequence:result.ackSequence,kind:result.kind,value:result.value,message:result.message||commandResult});}catch(e){commandResult=e.uncertain?'结果未知，请核对 PLC 后再操作':'已拒绝：'+e.message;cachedAt=0;throw e;}}));
 async function ensureProject(){
  assertInterface();if(recoveryError)throw fail(recoveryError,409);if(projectReady)return;if(projectInit)return projectInit;
  projectInit=(async()=>{const source=bound.load(origin+'/plcdev/tags');
   if(pending){
    // The native preview is not the saved source baseline. Resume its exact
    // source/normalized checkpoint so keep persists changes and undo can still
    // save edits made before preview. Old transactions retain conflict checks.
    if(pending.sourceRevision)bound.resume(pending.sourceRevision);
    else{if(hash(rebase(source))!==hash(rebase(pending.baseline)))throw fail('工程画面已在外部修改，待处理预览未覆盖工程文件；请保留窗口并处理冲突',409);bound.ready(pending.baseline);}
    const current=await project();
    await project(rebase(current?.hmi?.views?.length?current:pending.project,origin+'/plcdev/tags'));
   }else{
    await project(source);bound.ready(await project());
   }
   projectReady=true;
  })().finally(()=>projectInit=null);return projectInit;
 }
 app.post('/plcdev/project/flush',wrap(async(req,res)=>{authenticated(req);await ensureProject();if(aiBusy||nativeWrites||pending)throw fail('画面正在保存或存在待处理预览，请先完成后再关闭工程工具',409);aiBusy=true;try{let preservedConflict=null;if(bound){const value=await project();try{bound.persist(value);}catch(e){if(!bound.snapshot().error?.includes('已在外部修改'))throw e;const folder=path.join(savedir,'conflicts');fs.mkdirSync(folder,{recursive:true});preservedConflict=path.join(folder,crypto.randomUUID()+'.fuxap');fs.writeFileSync(preservedConflict,JSON.stringify(rebase(value),null,2)+'\n',{flag:'wx'});}}res.json({ok:true,projectId:bound?.projectId||null,projectFileStatus:bound?.snapshot()||null,preservedConflict});}finally{aiBusy=false;}}));
 // A pending AI resolution is not proof that its native effect completed.
 // Re-read its journal and owner before allowing a read-only view or export.
 function aiRecoveryAvailable(){
  try{
   if(!bound||!pending||recoveryError!==uncertainResolution(pending)||nativeIntent.inspect(savedir))return false;
   const r=pending.resolution;if(!r||r.version!==1||r.state!=='unknown'||!['preview','keep','undo'].includes(r.action)||pending.projectId!==bound.projectId||pending.configHash!==bound.configHash)return false;
   const owner=readSmallRecord(path.join(savedir,'project-owner.json'));
   if(owner.version!==1||owner.projectId!==bound.projectId||owner.configHash!==bound.configHash||typeof owner.file!=='string'||path.resolve(owner.file)!==path.resolve(bound.file))return false;
   const st=fs.lstatSync(transactionFile);if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)return false;
   const fd=fs.openSync(transactionFile,'r');try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==st.size||stat.size>16*1024*1024)return false;
    const bytes=Buffer.alloc(stat.size+1),n=fs.readSync(fd,bytes,0,bytes.length,0);if(n!==stat.size||fs.fstatSync(fd).size!==n)return false;
    const value=strictTransaction(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n)).replace(/^\uFEFF/,''));
    return JSON.stringify(value)===JSON.stringify(pending);
   }finally{fs.closeSync(fd);}
  }catch{return false;}
 }
 // This is evidence preservation, not resolution of the uncertain write.
 // Both owner and the one native intent must still be exactly identifiable.
 function recoveryIntent(){
  if(aiRecoveryAvailable())return {id:pending.id,kind:'ai-resolution',action:pending.resolution.action};
  if(!bound||recoveryError!==nativeIntent.message)throw fail('当前没有可核对的原生保存意图',409);
  try{
   const owner=readSmallRecord(path.join(savedir,'project-owner.json'));
   if(owner.version!==1||owner.projectId!==bound.projectId||owner.configHash!==bound.configHash||typeof owner.file!=='string'||path.resolve(owner.file)!==path.resolve(bound.file))throw Error('owner');
   const dir=path.join(savedir,'native-write-intents'),st=fs.lstatSync(dir);
   if(!st.isDirectory()||st.isSymbolicLink())throw Error('directory');
   const entries=fs.readdirSync(dir);if(entries.length!==1||!/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/.test(entries[0]))throw Error('intent count');
   const record=readSmallRecord(path.join(dir,entries[0]));
   if(!record||Object.keys(record).sort().join(',')!=='beforeDigest,configHash,endpoint,id,projectId,version'||record.version!==1||entries[0]!==record.id+'.json'||record.projectId!==bound.projectId||record.configHash!==bound.configHash||!['/project','/projectData','/device'].includes(record.endpoint)||!/^[a-f0-9]{64}$/.test(record.beforeDigest))throw Error('intent');
   return {...record,kind:'native-write'};
  }catch{throw fail('保存意图或工程归属无法唯一核对；请保留原 profile 和源文件。',409);}
 }
 app.post('/plcdev/native-recovery/status',wrap(async(req,res)=>{
  authenticated(req);if(!req.body||Object.keys(req.body).length)throw fail('请求字段无效');
  const intent=recoveryIntent();res.json({ok:true,transactionId:intent.id,scope:'native-project-snapshot',deviceSecurityIncluded:false});
 }));
 app.post('/plcdev/native-recovery/export',wrap(async(req,res)=>{
  authenticated(req);const id=req.body?.transactionId;
  if(!req.body||Object.keys(req.body).join(',')!=='transactionId'||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw fail('保存意图身份无效');
  if(aiBusy||nativeWrites)throw fail('画面操作正在处理，请稍后核对',409);
  const intent=recoveryIntent();if(intent.id!==id)throw fail('保存意图已改变，请重新核对',409);
  aiBusy=true;
  try{
   const first=JSON.stringify(rebase(await project()),null,2)+'\n',second=JSON.stringify(rebase(await project()),null,2)+'\n';
   if(first!==second||JSON.stringify(recoveryIntent())!==JSON.stringify(intent))throw fail('核对期间画面或保存意图发生变化；未导出',409);
   const bytes=Buffer.from(first,'utf8');if(bytes.length>16*1024*1024)throw fail('画面快照超过大小限制；未导出',409);
   if(req.aborted||res.destroyed) return;
   const dir=path.join(savedir,intent.kind==='ai-resolution'?'ai-recovery':'native-recovery');try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   const parent=fs.lstatSync(dir);if(!parent.isDirectory()||parent.isSymbolicLink())throw fail('快照目录无法安全核对；未导出',409);
   const file=path.join(dir,id+'.fuxap'),temp=path.join(dir,id+'.'+crypto.randomUUID()+'.tmp');let created=false;
   try{
    let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}
    try{fs.linkSync(temp,file);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size!==bytes.length||!fs.readFileSync(file).equals(bytes))throw fail('已有快照与当前读取不一致；请保留现场人工核对，未覆盖。',409);
   }finally{try{fs.unlinkSync(temp);}catch{}}
   res.json({ok:true,transactionId:id,path:file,sha256:hash(first),created,scope:'native-project-snapshot',deviceSecurityIncluded:false});
  }finally{aiBusy=false;}
 }));
 // Native Save Project / incremental view saves also update this engineering file.
 // Internal seed/AI preview requests bypass this bridge; pending previews are never committed here.
 if(definition)app.use('/api',express.json({limit:'8mb'}));
 if(bound)app.use('/api',async(req,res,next)=>{
  if(!['/project','/projectData','/device'].includes(req.path))return next();
  if(req.headers['x-plcdev-project-internal']===internal)return next();
  if(!local(req)||(req.headers.origin&&![origin,'http://localhost:'+port].includes(req.headers.origin)))return res.status(403).json({error:'Local project access only'});
  let disconnected=false;res.once('close',()=>{if(!res.writableFinished)disconnected=true;});
  const abandoned=()=>disconnected||req.aborted||res.destroyed;
  // During a native write uncertainty, the same verified project owner may
  // inspect the existing native profile without reinitializing it. All writes
  // and other recovery actions remain blocked until the record is resolved.
  if(req.method==='GET'&&req.path==='/project'&&aiRecoveryAvailable())return next();
  if(req.method==='GET'&&req.path==='/project'&&recoveryError===nativeIntent.message){try{
   const value=readSmallRecord(path.join(savedir,'project-owner.json'));
   if(value.version===1&&value.projectId===bound.projectId&&value.configHash===bound.configHash&&typeof value.file==='string'&&path.resolve(value.file)===path.resolve(bound.file))return next();
  }catch{} }
  try{await ensureProject();}catch(e){if(abandoned())return;return res.status(e.status||503).json({error:e.message});}
  if(req.method==='POST'){
   // An AI preview transaction must never overwrite a native edit that was
   // already in flight, and new native edits wait while it commits/undoes.
   if(aiBusy)return res.status(409).json({error:'画面事务正在处理，请完成后再编辑。'});
   if(nativeWrites>=32)return res.status(409).json({error:'原生画面保存排队已满；本次未派发，请检查编辑器后重试。'});
   // Native saves are serialized through their entire read/persist cycle.
   // Queue rather than reject normal concurrent editor saves, so an older
   // snapshot cannot overwrite a later one and edits are not silently lost.
   nativeWrites++;const previous=nativeTail;let nextWrite;nativeTail=new Promise(resolve=>{nextWrite=resolve;});
   let released=false;const release=()=>{if(!released){released=true;nativeWrites--;nextWrite();}};
   await previous;
   if(abandoned()){release();return;}
   if(recoveryError){release();return res.status(409).json({error:recoveryError});}
   if(definition){try{let proposed;if(req.path==='/project')proposed=req.body;else if(req.path==='/device')throw fail('工程接口不允许添加独立设备凭据或写入通道',403);else{proposed=await project();const body=req.body||{},data=body.data;if(body.cmd==='set-view'){if(!data?.id)throw Error('Invalid view');proposed.hmi.views=proposed.hmi.views.filter(v=>v.id!==data.id).concat([data]);}else if(body.cmd==='del-view'){proposed.hmi.views=proposed.hmi.views.filter(v=>v.id!==(data?.id||data));}else if(body.cmd==='set-device'){if(!data?.id)throw Error('Invalid device');proposed.devices[data.id]=data;}else if(body.cmd==='layout'){proposed.hmi.layout=data;}else if(body.cmd==='set-script'){if(!data?.id)throw Error('Invalid script');proposed.scripts=(proposed.scripts||[]).filter(v=>v.id!==data.id).concat([data]);}else if(body.cmd==='del-script'){proposed.scripts=(proposed.scripts||[]).filter(v=>v.id!==(data?.id||data));}else if(body.cmd==='client-access'){proposed.clientAccess=data;}else throw fail('此工程仅允许声明内的画面、变量绑定与操作编辑',403);}interfaces.validateProject(proposed,definition.contract);}catch(e){release();if(abandoned())return;return res.status(e.status||422).json({error:'project-interface-rejected',message:e.message});}}
   if(abandoned()){release();return;}
   let before,intent;try{
    before=hash(rebase(await project()));
    if(abandoned()){release();return;}
    if(recoveryError)throw Error('another native write is uncertain');
    intent=nativeIntent.begin(savedir,{projectId:bound.projectId,configHash:bound.configHash,endpoint:req.path,beforeDigest:before});
   }catch{
    // A partial intent is evidence, even when its creation did not complete.
    try{if(nativeIntent.inspect(savedir))recoveryError=nativeIntent.message;}catch{recoveryError=nativeIntent.message;}
    release();if(abandoned())return;return res.status(503).json({error:'project-native-intent-failed',message:recoveryError||'无法保存原生写入记录，本次未发送。'});
   }
   // A disconnected client does not prove the native handler has stopped.
   // Retain the per-request intent until it completes and its effect is known.
   res.once('finish',release);
   const end=res.end;let ended=false;
   const unknown=()=>{recoveryError=nativeIntent.message;release();res.statusCode=503;res.removeHeader('Content-Length');res.setHeader('Content-Type','application/json');end.call(res,JSON.stringify({error:'project-native-write-uncertain',message:nativeIntent.message}));};
   res.end=function(...args){if(ended)return res;ended=true;
    // Native setProject can modify its persistent store before an error even
    // when GET still shows old in-memory data; /device has separate security
    // storage. Only pre-dispatch rejection is definitive.
    if(res.statusCode>=400){unknown();return res;}
    Promise.resolve().then(async()=>{
     if(recoveryError||aiBusy)throw Error('another native write is uncertain');
     if(!pending){const current=await project();if(recoveryError)throw Error('another native write is uncertain');
      bound.persist(current);}
     nativeIntent.complete(intent);release();end.apply(res,args);
    }).catch(unknown);return res;
   };
  }next();
 });
 async function project(value){assertInterface();if(value&&definition)interfaces.validateProject(value,definition.contract);const r=await fetch(origin+'/api/project',{method:value?'POST':'GET',headers:{'X-PLCdev-Project-Internal':internal,...(value?{'Content-Type':'application/json'}:{})},body:value?JSON.stringify(value):undefined,signal:AbortSignal.timeout(15000)});if(!r.ok)throw fail('FUXA 工程读取或保存失败',502);if(!value)return r.json();return true;}
 function model(request){return new Promise((resolve,reject)=>{let argv;try{argv=JSON.parse(process.env.PLCDEV_FUXA_AI_COMMAND_JSON);if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'))throw Error();}catch{return reject(fail('AI 执行器未配置',503));}const child=cp.spawn(argv[0],argv.slice(1),{cwd:path.resolve(__dirname,'../..'),windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',size=0;const timer=setTimeout(()=>{child.kill();reject(fail('AI 请求超时，原工程保持不变',504));},180000);collectUtf8(child.stdout,(chunk,bytes)=>{size+=bytes;if(size>1024*1024){child.kill();return;}out+=chunk;});child.stderr.on('data',()=>{});child.on('error',()=>{clearTimeout(timer);reject(fail('AI 执行器未能启动',503));});child.on('close',code=>{clearTimeout(timer);if(code!==0||size>1024*1024)return reject(fail('AI 请求失败，原工程保持不变',502));try{const result=JSON.parse(out);if(!result.ok||typeof result.content!=='string')throw Error();resolve(result);}catch{reject(fail('AI 返回无效结果',502));}});child.stdin.end(JSON.stringify(request));});}
 function pageContext(current){
  let keptSpec=null;try{keptSpec=native.validate(JSON.parse(fs.readFileSync(path.join(savedir,'kept-spec.json'),'utf8')));}catch{}
  const views=(current.hmi?.views||[]).slice(0,8).map(v=>({name:String(v.name||'').slice(0,80),width:v.profile?.width,height:v.profile?.height,widgets:Object.values(v.items||{}).slice(0,80).filter(w=>{if(!definition)return true;const key=native.TAGS.find(t=>native.tagId(t)===w.property?.variableId),id=key?.replace(/^\$/,'');if(id&&!definition.publicContract.variables.some(v=>v.id===id))return false;const script=w.property?.events?.find(e=>e.action==='onRunScript')?.actparam;return !script||definition.publicContract.operations.some(o=>'s_plcdev_'+o.id===script);}).map(w=>({type:w.type,label:String(w.name||w.label||'').slice(0,100),tag:native.TAGS.find(t=>native.tagId(t)===w.property?.variableId)?.replace(/^\$/,'')||null}))}));
  return {currentPage:{name:String(current.name||'').slice(0,80),views},lastKeptSpec:keptSpec};
 }
 app.post('/plcdev/ai/generate',wrap(async(req,res)=>{authenticated(req);if(!ai.enabled)throw fail('AI 生成功能已关闭，请在侧栏开启',503);if(aiSettingsBusy)throw fail('AI 配置正在检查',409);if(!ai.ready)throw fail('DeepSeek 配置不可用，请重新检查配置',503);if(aiBusy||nativeWrites||pending)throw fail('画面正在保存或存在待处理预览，请先完成后再生成',409);const prompt=req.body?.prompt;if(typeof prompt!=='string'||prompt.length<8||prompt.length>8000)throw fail('请提供 8～8000 字的画面需求');aiBusy=true;aiLastError=null;try{await ensureProject();const baseline=await project();const system=definition?interfaces.modelRequestSystem(definition.contract):fs.readFileSync(path.join(__dirname,'model-system.txt'),'utf8')+'\nJSON Schema:\n'+fs.readFileSync(path.join(__dirname,'model-schema.json'),'utf8');const result=await model({messages:[{role:'system',content:system},{role:'user',content:prompt+'\n现有画面上下文（仅作为编辑数据，不含通信地址、凭据、脚本）：\n'+JSON.stringify(pageContext(baseline))}],response_format:{type:'json_object'}});let spec;try{spec=native.validate(JSON.parse(result.content));}catch(e){throw fail('AI 画面规格未通过校验：'+e.message,422);}const generated=native.compile(spec,origin+'/');if(hash(await project())!==hash(baseline))throw fail('生成期间工程已被编辑；未覆盖，请重新生成',409);const id=crypto.randomUUID();const candidate={id,projectId:bound?.projectId||null,configHash:bound?.configHash||null,source:'model',model:result.model||'configured-model',createdAt:new Date().toISOString(),sourceRevision:bound?.checkpoint()||null,baseline,spec,project:generated};const prepared={...candidate,resolution:{version:1,action:'preview',state:'unknown',startedAt:new Date().toISOString()}};try{save(prepared);}catch{recoveryError='预览事务记录无法保存，尚未应用画面；请保留现场核对。';throw fail(recoveryError,503);}pending=prepared;try{await project(generated);save(candidate);pending=candidate;}catch{recoveryError=uncertainResolution(prepared);throw fail(recoveryError,503);}fs.writeFileSync(path.join(savedir,id+'-model.json'),JSON.stringify({source:'model',model:pending.model,prompt,spec,usage:result.usage||null},null,2));res.json({ok:true,pending:true,transactionId:id,source:'model',model:pending.model,viewId:native.VIEW,widgets:spec.widgets.length});}catch(e){aiLastError=e.status?e.message:'AI 请求失败；原工程未覆盖';throw e;}finally{aiBusy=false;}}));
 app.post('/plcdev/ai/keep',wrap(async(req,res)=>{
  authenticated(req);await ensureProject();if(aiBusy||nativeWrites)throw fail('工程画面正在保存或事务正在处理，请稍后重试',409);if(!pending||req.body.transactionId!==pending.id)throw fail('预览已失效',409);aiBusy=true;
  try{
   const current=await project(),id=pending.id;
   // Reject a known external edit before recording a write intent. persist()
   // repeats the check immediately before replacing the source file.
   if(bound){const source=bound.snapshot();if(source.state!=='ready')throw fail(source.error||'工程画面无法核对，未写回。',409);}
   const prepared={...pending,resolution:{version:1,action:'keep',state:'unknown',startedAt:new Date().toISOString(),sourceRevision:bound?.checkpoint()||null,preview:current}};
   try{save(prepared);}catch{recoveryError='写回前事务记录无法保存，工程画面未写回；请保留现场核对。';throw fail(recoveryError,503);}
   pending=prepared;
   try{
    if(bound)bound.persist(current);
    fs.writeFileSync(path.join(savedir,id+'-kept.fuxap'),JSON.stringify(current,null,2));
    fs.writeFileSync(path.join(savedir,'kept-spec.json'),JSON.stringify(pending.spec,null,2));
    saveReceipt(id,'keep');save(null);pending=null;aiLastError=null;res.json({ok:true,kept:true,transactionId:id});
   }catch{recoveryError='上次写回的结果未知；请核对源画面及原事务记录，未自动重试或撤销。';throw fail(recoveryError,503);}
  }finally{aiBusy=false;}
 }));
 app.post('/plcdev/ai/undo',wrap(async(req,res)=>{
  authenticated(req);await ensureProject();if(aiBusy||nativeWrites)throw fail('工程画面正在保存或事务正在处理，请稍后重试',409);if(!pending||req.body.transactionId!==pending.id)throw fail('预览已失效',409);aiBusy=true;
  try{
   const id=pending.id,current=await project();
   // Preserve the exact preview before the first potentially mutating request.
   const prepared={...pending,resolution:{version:1,action:'undo',state:'unknown',startedAt:new Date().toISOString(),sourceRevision:bound?.checkpoint()||null,preview:current}};
   try{save(prepared);}catch{recoveryError='撤销前事务记录无法保存，尚未撤销；请保留现场核对。';throw fail(recoveryError,503);}
   pending=prepared;
   try{await project(bound?rebase(pending.baseline,origin+'/plcdev/tags'):pending.baseline);saveReceipt(id,'undo');save(null);pending=null;aiLastError=null;res.json({ok:true,undone:true,transactionId:id});}
   catch{recoveryError=uncertainResolution(prepared);throw fail(recoveryError,503);}
  }finally{aiBusy=false;}
 }));
 app.get('/plcdev/extension.js',(req,res)=>res.type('application/javascript').send(
  fs.readFileSync(path.join(__dirname,'../native-preview-banner.js'),'utf8')+'\n'+fs.readFileSync(path.join(__dirname,'extension.js'),'utf8')));
 app.get('/plcdev/extension.css',(req,res)=>res.type('text/css').sendFile(path.join(__dirname,'extension.css')));
 return {state,epoch,close:lease.close};
 }catch(e){lease.close();throw e;}
}
module.exports={mount};
