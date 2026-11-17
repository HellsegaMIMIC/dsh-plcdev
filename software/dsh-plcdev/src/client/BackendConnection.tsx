import React,{useEffect,useRef,useState} from 'react';
import {conversationApi} from './conversation-client.mjs';

export function BackendConnection({onConnected}: {onConnected?:()=>void|Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function connect(){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{
      const result=await conversationApi('backend/connect',{},65000);
      if(result.ok!==true||result.connected!==true||result.service!=='plcdev-workbench'||typeof result.instance!=='string'||!result.instance)
        throw new Error('工程服务未确认连接，请重新读取状态。');
      if(mounted.current)await onConnected?.();
    }catch(e:any){if(mounted.current)setError(e.name==='AbortError'?'连接工程服务超时，请重新读取状态后重试。':e.message||'连接工程服务失败，请重试。');}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }
  return <div className="pc-backend-connection" style={{display:'grid',gap:6,marginTop:8}}>
    <div><button disabled={busy} onClick={connect}>{busy?'正在连接…':'连接工程服务'}</button></div>
    <small style={{fontSize:12,color:'var(--dsw-alias-label-secondary,#667085)'}}>仅恢复工程服务，不启动 PLC。</small>
    {error&&<p role="alert" style={{margin:0,fontSize:13}}>{error}</p>}
  </div>;
}
