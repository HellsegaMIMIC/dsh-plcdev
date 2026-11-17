import React,{useEffect,useState} from 'react';
import {conversationApi as api} from './conversation-client.mjs';
import {validateProjectConversations,hostSessionTitle} from './project-sessions.mjs';

export function EditorSessionPicker({projectId,hostSessions,onChoose,onCreate,onStandalone,onClose,busy}:any){
  const [state,setState]=useState<any>(null),[selected,setSelected]=useState('');
  useEffect(()=>{let stopped=false;setState(null);setSelected('');
    (async()=>{try{const result=validateProjectConversations(await api('conversations/project?projectId='+encodeURIComponent(projectId)),projectId);await hostSessions?.get?.()?.refresh?.();if(!stopped)setState({result});}
      catch(error:any){if(!stopped)setState({error:error?.message||'关联会话暂时无法读取。'});}})();
    return()=>{stopped=true;};
  },[projectId]);
  const catalog=hostSessions?.get?.()?.list?.getSnapshot?.();
  const rows=state?.result?.current||[];
  return <section className="pd-work-summary" aria-label="选择 OpenPLC 的 DSH 会话" style={{display:'grid',gap:10,margin:'12px 0'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}><strong>在 OpenPLC 继续哪段对话？</strong><button className="pd-quiet" onClick={onClose} disabled={busy} aria-label="关闭编辑器会话选择">×</button></div>
    <p style={{margin:0}}>选择后，OpenPLC 和 DSH 共用该工程会话的模型、消息与修改记录。</p>
    {!state?<p>正在读取关联会话…</p>:state.error?<p role="status">{state.error}</p>:<div style={{display:'flex',gap:8,flexWrap:'wrap'}}><select aria-label="关联 DSH 会话" value={selected} disabled={busy||!rows.length} onChange={event=>setSelected(event.target.value)} style={{font:'inherit',maxWidth:'100%',minHeight:36}}><option value="">{rows.length?'请选择关联会话':'当前没有关联会话'}</option>{rows.map((row:any)=><option key={row.conversationId} value={row.conversationId}>{hostSessionTitle(catalog,row.conversationId)||'会话 '+row.conversationId.slice(0,12)}</option>)}</select><button disabled={busy||!selected} onClick={()=>onChoose(selected)}>连接会话并打开</button></div>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{onCreate&&<button disabled={busy} onClick={onCreate}>新建会话并打开</button>}<button className="pd-quiet" disabled={busy} onClick={onStandalone}>仅打开编辑器</button></div>
  </section>;
}
