'use strict';
// Portable native project ownership. Runtime endpoints never become source configuration.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DEVICE}=require('./native-project.cjs');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const failure=message=>Object.assign(Error(message),{status:409});
// Compare every native field; object key order is not an edit, array order is.
function ordered(value){return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;}
function rebase(project,base='/plcdev/tags',definition=null){
 const deviceId=definition?.DEVICE||DEVICE;
 if(definition)require('./project-interface.cjs').validateProject(project,definition.contract);
 const value=structuredClone(project);
 if(value?.version!=='1.01'||!Array.isArray(value.hmi?.views)||!value.hmi.views.length||!value.devices?.[deviceId])throw failure('工程画面不是已配置的 FUXA 批次画面');
 if(Object.keys(value.devices).some(id=>id!==deviceId))throw failure('当前工程画面包含未配置的外部设备，请先配置绑定');
 value.devices[deviceId].property={...value.devices[deviceId].property,getTags:base,postTags:true};
 return value;
}
function projectFile({file,projectId,configHash,profile,definition=null}){
 if(!file)return null;
 if(!path.isAbsolute(file)||!/^user-[a-f0-9]{32}$/.test(projectId||'')||typeof configHash!=='string'||!configHash.length)throw failure('FUXA 工程身份配置无效');
 const ownerFile=path.join(profile,'plcdev','project-owner.json');
 let previous=null;try{previous=JSON.parse(fs.readFileSync(ownerFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw failure('FUXA profile 工程身份记录无法读取');}
 if(previous&&previous.projectId!==projectId)throw failure('FUXA profile 属于另一个工程，拒绝复用');
 fs.mkdirSync(path.dirname(ownerFile),{recursive:true});
 fs.writeFileSync(ownerFile,JSON.stringify({version:1,projectId,file,configHash},null,2));
 let expected=null,nativeBaseline=null,status={state:'loading',projectId,configHash,file,hash:null,error:null};
 function load(base){try{const raw=fs.readFileSync(file),value=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));expected=digest(raw);nativeBaseline=null;status={...status,state:'loading',hash:expected,error:null};return rebase(value,base,definition);}catch(e){status={...status,state:'error',error:e.status?e.message:'工程画面文件无法读取'};throw failure(status.error);}}
 const normalizedHash=value=>digest(JSON.stringify(ordered(rebase(value,'/plcdev/tags',definition))));
 function ready(nativeValue){if(nativeValue!==undefined)nativeBaseline=normalizedHash(nativeValue);status={...status,state:'ready',hash:expected,error:null};}
 function checkpoint(){return{sourceHash:expected,nativeBaselineHash:nativeBaseline};}
 function resume(saved){
  if(!saved||saved.sourceHash!==expected||!/^([a-f0-9]{64})$/.test(saved.nativeBaselineHash||''))throw failure('工程画面已在外部修改，待处理预览未覆盖工程文件；请保留窗口并处理冲突');
  nativeBaseline=saved.nativeBaselineHash;ready();
 }
 function persist(value){try{
   const current=fs.readFileSync(file);if(digest(current)!==expected)throw failure('工程画面已在外部修改；未覆盖，请关闭工具后重新打开该工程');
   const proposed=rebase(value,'/plcdev/tags',definition),proposedHash=normalizedHash(proposed);
   // Check the external file first, including no-op saves. Only the normalized
   // result loaded from native FUXA establishes what 'unchanged' means.
   if(nativeBaseline!==null&&proposedHash===nativeBaseline){ready();return snapshot();}
   const raw=Buffer.from(JSON.stringify(proposed,null,2)+'\n','utf8'),temp=file+'.'+crypto.randomUUID()+'.tmp';
   fs.writeFileSync(temp,raw,{flag:'wx'});fs.renameSync(temp,file);expected=digest(raw);nativeBaseline=proposedHash;ready();return snapshot();
  }catch(e){status={...status,state:'error',error:e.status?e.message:'画面未保存回工程文件，请保留窗口并检查文件权限'};throw failure(status.error);}}
 function snapshot(){if(expected&&status.state==='ready'){try{if(digest(fs.readFileSync(file))!==expected)return{...status,state:'conflict',error:'工程画面已在外部修改；请关闭工具后重新打开'};}catch{return{...status,state:'error',error:'工程画面文件无法读取'};}}return{...status};}
 return {load,ready,checkpoint,resume,persist,snapshot,projectId,configHash,file};
}
module.exports={projectFile,rebase};
