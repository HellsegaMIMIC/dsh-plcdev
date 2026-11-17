import {validateProjectConversations} from './project-sessions.mjs';

// Navigation is presentation only. A request is successful only when the target
// session's mounted header acknowledges it after checking its own task refs.
export function createVerifiedSessionNavigator({services,navigation,api,timeout=5000}) {
  let busy=false;
  return async function open({projectId,sessionId,taskId,signal}) {
    if(busy)return {ok:false,message:'已有会话跳转正在核对。'};
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(projectId||'') || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(sessionId||'') || (taskId!==undefined&&!/^task-[0-9a-f]{32}$/.test(taskId)))return {ok:false,message:'会话或任务身份无效。'};
    busy=true;let dispatched=false;
    try{
      const {sessions,workspace}=services();
      if(typeof sessions?.refresh!=='function'||typeof sessions?.list?.getSnapshot!=='function'||typeof workspace?.openSession!=='function')throw Error('宿主会话跳转接口不可用。');
      let timer;try{await Promise.race([sessions.refresh(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('宿主会话列表刷新超时。')),timeout);})]);}finally{clearTimeout(timer);}
      if(signal?.aborted)throw Error('工程页面已切换，未跳转会话。');
      const current=services();if(current.sessions!==sessions||current.workspace!==workspace)throw Error('宿主会话服务已变化，请重新读取。');
      const catalog=sessions.list.getSnapshot(),row=catalog?.byId?.[sessionId];
      if(catalog?.phase!=='ready'||!Array.isArray(catalog.ids)||!catalog.ids.includes(sessionId)||!row||row.origin==='subagent')throw Error('所属主会话不可访问或未出现在宿主会话列表。');
      const associations=validateProjectConversations(await api('conversations/project?projectId='+encodeURIComponent(projectId)),projectId);
      if(signal?.aborted)throw Error('工程页面已切换，未跳转会话。');
      const association=[...associations.current,...associations.historical].find(item=>item.conversationId===sessionId);
      if(!association || taskId&&!association.taskIds.includes(taskId))throw Error('会话或任务的工程归属已变化，请重新读取。');
      if(services().sessions!==sessions||services().workspace!==workspace)throw Error('宿主会话服务已变化，请重新读取。');
      const latest=sessions.list.getSnapshot(),latestRow=latest?.byId?.[sessionId];
      if(latest?.phase!=='ready'||!Array.isArray(latest.ids)||!latest.ids.includes(sessionId)||!latestRow||latestRow.origin==='subagent')throw Error('所属主会话已不可访问，请重新读取。');
      workspace.openSession(sessionId);dispatched=true;
      const receipt=await navigation.requestVerified({projectId,sessionId,...(taskId?{taskId}:{})},timeout);
      return {...receipt,dispatched};
    }catch(error){return {ok:false,message:error?.message||'会话跳转无法确认。',dispatched};}
    finally{busy=false;}
  };
}
