'use strict';
// Local preference and credential availability only. Never invokes a model request.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const error=(message,status=503)=>Object.assign(Error(message),{status});
function settings({directory,env=process.env}){
 const file=path.join(directory,'ai-settings.json');
 let enabled=env.PLCDEV_FUXA_AI_ENABLED==='1',configuration={state:'unchecked',model:'',providerHost:'',message:'尚未检查本机配置'},checking=null,checked=false;
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));enabled=saved.version===1&&saved.enabled===true;}catch(e){if(e.code!=='ENOENT')enabled=false;}
 const argv=name=>{try{const value=JSON.parse(env[name]);return Array.isArray(value)&&value.length&&value.every(x=>typeof x==='string'&&x.length)?value:null;}catch{return null;}};
 const command=argv('PLCDEV_FUXA_AI_COMMAND_JSON'),checkCommand=argv('PLCDEV_FUXA_AI_CHECK_COMMAND_JSON');
 const snapshot=()=>({enabled,configuration:{...configuration}});
 function probe(){return new Promise(resolve=>{
  if(!command)return resolve({state:'unavailable',model:'',providerHost:'',message:'AI 执行器未安装，请检查 PLCdev 环境。'});
  if(!checkCommand)return resolve({state:'ready',model:'自定义执行器',providerHost:'自定义配置',message:'执行器已配置；尚未检查远端服务。'});
  let output='',bytes=0,done=false,child,timer;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
  const unavailable={state:'unavailable',model:'',providerHost:'',message:'无法检查本机 DeepSeek 配置，请重试。'};
  try{child=cp.spawn(checkCommand[0],checkCommand.slice(1),{windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{return finish(unavailable);}
  timer=setTimeout(()=>{child.kill();finish(unavailable);},4000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{bytes+=Buffer.byteLength(part,'utf8');if(bytes>8192){child.kill();finish(unavailable);}else output+=part;});child.stderr.on('data',()=>{});child.on('error',()=>finish(unavailable));
  child.on('close',code=>{if(done)return;let result;try{result=JSON.parse(output);if(!result||typeof result!=='object'||Array.isArray(result))throw Error();}catch{return finish(unavailable);}
   // Copy only known public values. No arbitrary stdout or exception reaches the browser.
   if(code===0&&result.ok===true&&result.hasKey===true&&result.model==='deepseek-flash'&&result.providerHost==='api.deepseek.com')return finish({state:'ready',model:result.model,providerHost:result.providerHost,message:'已读取 OpenPLC 保存的配置；网络和额度会在生成时验证。'});
   const state=['missing','unreadable','unavailable'].includes(result.state)?result.state:'unreadable';
   finish({state,model:'deepseek-flash',providerHost:'api.deepseek.com',message:state==='missing'?'未找到已保存的 DeepSeek 配置，请在 OpenPLC AI 设置中保存后重新检查。':state==='unavailable'?'本机配置检查依赖不可用，请检查 PLCdev 环境。':'现有 DeepSeek 配置无法读取，请在 OpenPLC AI 设置中重新保存后检查。'});
  });
 });}
 async function check(force=false){if(checking)return checking;if(checked&&!force)return snapshot();checking=probe().then(value=>{configuration=value;checked=true;return snapshot();}).finally(()=>checking=null);return checking;}
 async function set(value){if(typeof value!=='boolean')throw error('AI 开关值无效',400);if(value){await check(true);if(configuration.state!=='ready')throw error(configuration.message);}
  const next={version:1,enabled:value};const temp=file+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(next,null,2));fs.renameSync(temp,file);}catch{throw error('AI 设置保存失败；开关未改变',500);}enabled=value;return snapshot();}
 return {snapshot,check,set,get enabled(){return enabled;},get ready(){return configuration.state==='ready';}};
}
module.exports={settings};
