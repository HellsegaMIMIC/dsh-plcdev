'use strict';
// A process-lifetime profile lease. SQLite holds an OS lock until the owning
// process closes the connection or exits, including on abnormal termination.
// This coordinates only FUXA processes loading this integration.
const fs=require('fs'),path=require('path');
// FUXA's hook does not retain mount()'s return value. Keep the native SQLite
// connection strongly reachable for the lifetime of the mounted integration.
const activeConnections=new Set();

function profileLease(directory){
 const fail=(code,message)=>Object.assign(Error('['+code+'] '+message),{code});
 let DatabaseSync;
 try{({DatabaseSync}=require('node:sqlite'));}catch{
  throw fail('PLCDEV_FUXA_PROFILE_UNSUPPORTED','FUXA profile 无法取得进程锁：当前 Node 不提供同步 SQLite；请使用已验证的 Node 版本。');
 }
 if(typeof DatabaseSync!=='function')throw fail('PLCDEV_FUXA_PROFILE_UNSUPPORTED','FUXA profile 无法取得进程锁：当前 Node 不提供同步 SQLite；请使用已验证的 Node 版本。');
 const folder=fs.lstatSync(directory);
 if(!folder.isDirectory()||folder.isSymbolicLink())throw fail('PLCDEV_FUXA_PROFILE_INVALID','FUXA profile 锁目录无效；未启动。');
 const file=path.join(directory,'profile-lease.sqlite');
 try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail('PLCDEV_FUXA_PROFILE_INVALID','FUXA profile 锁文件无效；未启动。');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 let db;
 try{
  db=new DatabaseSync(file,{timeout:0});
  db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
 }catch(e){try{db?.close();}catch{}throw fail('PLCDEV_FUXA_PROFILE_LOCKED','FUXA profile 已被其他实例使用，或互斥锁不可用；未启动第二个实例。');}
 activeConnections.add(db);let closed=false;
 const close=()=>{if(closed)return;closed=true;try{db.exec('ROLLBACK');}finally{try{db.close();}finally{activeConnections.delete(db);}}};
 return {close};
}
module.exports={profileLease};
