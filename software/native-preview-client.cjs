'use strict';
// Shared by FUXA's server and the isolated OIP main process. The renderer never
// receives the controller address or capability and cannot select a destination.
const http=require('node:http');
function previewClient(raw){
 let descriptor=null;
 if(raw){try{
  const d=JSON.parse(raw),u=new URL(d.base);
  if(d.version!==1||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||
     !/^editor-[a-f0-9]{32}$/.test(d.launchId)||!/^([a-f0-9]{64})$/.test(d.token)||!/^([a-f0-9]{64})$/.test(d.instance))throw Error();
  descriptor=Object.freeze(d);
 }catch{throw Error('Invalid native preview identity');}}
 return async(action='status',revision)=>{
  if(!descriptor)return {active:false};
  if(!['status','current'].includes(action)||action==='current'&&!/^[a-f0-9]{64}$/.test(revision||''))throw Error('Invalid preview action');
  const d=descriptor,body=action==='current'?JSON.stringify({revision}):null;
  const value=await new Promise((resolve,reject)=>{
   const req=http.request(d.base+'/v1/previews/'+d.launchId+'/'+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.token,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
    let bytes=0,chunks=[];res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){res.destroy();reject(Error('Invalid preview response'));}else chunks.push(chunk);});
    res.on('error',reject);res.on('end',()=>{try{
     const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(res.statusCode!==200||v.ok!==true||v.version!==1||v.instance!==d.instance||v.launchId!==d.launchId)throw Error();
     resolve(v);
    }catch{reject(Error('Preview state unavailable'));}});
   });
   req.setTimeout(action==='current'?35000:3000,()=>req.destroy(Error('Preview timeout')));
   req.on('error',reject);req.end(body);
  });
  // A strict projection keeps private identities and server implementation
  // details outside the native web view.
  if(typeof value.active!=='boolean'||!['pending','kept','discarded','superseded','unknown'].includes(value.state)||
     typeof value.label!=='string'||value.label.length>100||typeof value.canOpenCurrent!=='boolean'||
     value.canOpenCurrent&&!/^[a-f0-9]{64}$/.test(value.currentRevision||''))throw Error('Invalid preview state');
  return {active:value.active,state:value.state,label:value.label,canOpenCurrent:value.canOpenCurrent,
    currentRevision:value.currentRevision||null,opened:value.opened===true,message:typeof value.message==='string'?value.message.slice(0,160):null};
 };
}
module.exports={previewClient};
