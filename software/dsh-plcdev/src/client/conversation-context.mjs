import {conversationApi, validateBinding, bindRequest, readConversationPending, recoverConversationRequest, saveConversationPending, clearConversationPending} from './conversation-client.mjs';
import {validateSnapshot} from './model.mjs';

export function bindingError(error) {
  return ({403:'无法关联，来源校验未通过。',409:'工程关联已变化，请重新读取后再选择。',503:'后台不可用，请稍后重新读取。'})[error?.httpStatus] || '关联结果无法确认，请重新读取；不会自动重发。';
}
// One controller per DSH session, owned by the plugin instance. No shared selection.
export function createConversationContexts({api=conversationApi, storage=()=>window.localStorage, interval=4000}={}) {
  const sessions=new Map();
  return {get(sessionId){
    if(sessions.has(sessionId))return sessions.get(sessionId);
    let state={binding:null,projects:[],pending:null,error:'',storageError:'',busy:false,loading:true};
    let epoch=0,timer=null,reading=false;
    const listeners=new Set();
    const publish=patch=>{state={...state,...patch};listeners.forEach(fn=>fn());};
    function recover(binding){
      try{
        const disk=storage();
        let pending=readConversationPending(disk,sessionId);
        if(pending&&binding.taskRefs.some(ref=>ref.clientRequestId===pending.clientRequestId&&ref.projectId===pending.projectId)){clearConversationPending(disk,sessionId);pending=null;}
        pending ||= binding.pendingRequests.map(p=>recoverConversationRequest(p,sessionId)).find(Boolean)||null;
        if(pending)saveConversationPending(disk,pending);
        publish({pending,storageError:''});
      }catch{publish({storageError:'浏览器无法保存恢复信息；待核对请求请保留现场。'});}
    }
    async function refresh(){
      if(reading||state.busy)return;
      clearTimeout(timer);reading=true;const ticket=++epoch;
      try{
        const binding=validateBinding(await api('conversations?conversationId='+encodeURIComponent(sessionId)),sessionId);
        if(ticket!==epoch)return;
        publish({binding,loading:false});recover(binding);
      }catch(e){if(ticket===epoch)publish({loading:false,error:bindingError(e)});}
      finally{if(ticket===epoch){reading=false;if(listeners.size)timer=setTimeout(refresh,interval);}}
    }
    async function directory(){
      try{const value=validateSnapshot(await api('status'));publish({projects:value.projects});}
      catch{publish({error:'工程目录读取失败，请重新读取。'});}
    }
    const controller={active:()=>listeners.size>0,snapshot:()=>state,subscribe(fn){listeners.add(fn);if(listeners.size===1){refresh();directory();}return()=>{listeners.delete(fn);if(!listeners.size){clearTimeout(timer);epoch++;reading=false;}};},refresh(){publish({error:''});refresh();directory();},
      async revise(task){
        if(state.busy||state.pending||state.storageError||!state.binding)return;
        if(state.binding.projectId!==task.projectId){await controller.bind(task.projectId);if(state.binding.projectId!==task.projectId)return;}
        const body={conversationId:sessionId,projectId:task.projectId,taskId:task.taskId,candidateDigest:task.candidate.candidateDigest,expectedRevision:task.projectRevision,expectedVersion:state.binding.version,intentId:crypto.randomUUID()};
        epoch++;reading=false;clearTimeout(timer);
        publish({busy:true,error:''});
        try{const binding=validateBinding(await api('conversations/revision',body),sessionId);publish({binding});}
        catch(e){publish({error:e.message||'修订上下文未确认，请重新读取。'});}
        finally{publish({busy:false});refresh();}
      },
      async cancelRevision(){
        const revision=state.binding?.revisionContext;if(!revision||state.busy)return;
        epoch++;reading=false;clearTimeout(timer);
        publish({busy:true,error:''});try{const binding=validateBinding(await api('conversations/revision/cancel',{conversationId:sessionId,intentId:revision.intentId}),sessionId);publish({binding});}catch(e){publish({error:e.message});}finally{publish({busy:false});refresh();}
      },
      async retryPending(){
        const body=state.pending;if(!body||state.busy||state.storageError)return;
        try{saveConversationPending(storage(),body);}catch{publish({storageError:'无法保存恢复请求，本次未发送。'});return;}
        publish({busy:true,error:''});epoch++;reading=false;clearTimeout(timer);
        try{const result=await api('conversations/tasks',body,65000);if(result.conversationId!==sessionId||result.task?.projectId!==body.projectId||!result.task?.taskId)throw new Error('归属未确认');clearConversationPending(storage(),sessionId);publish({pending:null});}
        catch{publish({error:'请求结果仍待核对，保留原请求编号。'});}
        finally{publish({busy:false});refresh();}
      },
      async bind(projectId){
        if(state.busy||!state.binding||state.pending||state.storageError||state.binding.pendingRequests.length)return;
        // A freshly retained copy may not be in the cached directory yet.
        // The server validates existence; never silently discard this explicit intent.
        if(!/^[a-z][a-z0-9-]{0,63}$/.test(projectId))return;
        const body=bindRequest(state.binding,projectId);
        epoch++;reading=false;clearTimeout(timer);publish({busy:true,error:''});
        try{const binding=validateBinding(await api('conversations/bind',body),sessionId);publish({binding});recover(binding);}
        catch(e){publish({error:bindingError(e)});}
        finally{publish({busy:false});refresh();directory();}
      },
      dispose(){listeners.clear();clearTimeout(timer);epoch++;reading=false;}
    };
    sessions.set(sessionId,controller);return controller;
  },activeSession(){const ids=[...sessions].filter(([,c])=>c.active()).map(([id])=>id);return ids.length===1?ids[0]:null;},dispose(){sessions.forEach(c=>c.dispose());sessions.clear();}};
}
