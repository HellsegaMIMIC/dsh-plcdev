'use strict';
// The native API may mutate its profile before returning an error or before a
// client disconnects. A per-request intent prevents a later restart from
// silently replacing that possibly edited profile with the source file.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const message='原生画面或设备设置保存结果尚未确认；请保留原 profile、源画面及设备设置核对，未自动重试或覆盖。';
function folder(savedir){return path.join(savedir,'native-write-intents');}
function inspect(savedir){
 const dir=folder(savedir);let stat;try{stat=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('invalid native intent directory');
 const stream=fs.opendirSync(dir);try{return stream.readSync()!==null;}finally{stream.closeSync();}
}
function begin(savedir,{projectId,configHash,endpoint,beforeDigest}){
 const dir=folder(savedir);try{fs.mkdirSync(dir);}catch(e){if(e.code!=='EEXIST')throw e;}
 const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('invalid native intent directory');
 const id=crypto.randomUUID(),file=path.join(dir,id+'.json');let fd,failed=false;
 try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({version:1,id,projectId,configHash,endpoint,beforeDigest}));fs.fsyncSync(fd);}
 catch(e){failed=true;throw e;}
 finally{if(fd!==undefined){try{fs.closeSync(fd);}finally{if(failed)try{fs.unlinkSync(file);}catch{}}}}
 return file;
}
function complete(file){fs.unlinkSync(file);}
module.exports={message,inspect,begin,complete};
