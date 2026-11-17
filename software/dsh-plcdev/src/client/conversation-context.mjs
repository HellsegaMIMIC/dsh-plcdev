import {conversationApi, validateBinding, bindRequest, conversationParticipation, readConversationPending, recoverConversationRequest, saveConversationPending, clearConversationPending} from './conversation-client.mjs';
import {validateSnapshot} from './model.mjs';
import {backendReadError, isBackendDisconnected} from './backend-state.mjs';

export function bindingError(error) {
  if(error?.code==='participation_locked')return '此会话已有工程操作，请保留工程关联；普通聊天请新建会话。';
  if(['submission_conflicts_overflow','submission_conflict_corrupt','submission_inflight_overflow','submission_inflight_corrupt'].includes(error?.code))return '会话请求记录无法完整核对，请保留现场；工程操作已停用。';
  if(error?.code==='submission_identity_conflict')return '原请求返回不同任务身份，请保留记录并核对；不能切换工程。';
  if(error?.code==='submission_in_flight')return '原请求仍在途或发送者状态无法确认，请先核对；不能切换工程。';
  if(error?.code==='submission_unknown')return '存在结果待核对的请求，请先核对原请求；不能切换工程。';
  return ({403:'无法关联，来源校验未通过。',409:'工程关联已变化，请重新读取后再选择。',503:'后台不可用，请稍后重新读取。'})[error?.httpStatus] || '关联结果无法确认，请重新读取；不会自动重发。';
}
export function bindingBlockedReason(state) {
  if(state.busy)return '正在切换或处理会话操作，请稍候。';
  if(!state.binding)return state.error||'会话工程尚未确认，请重新读取。';
  if(state.storageError)return '浏览器恢复信息不可用，请先核对。';
  if(state.binding.submissionConflicts?.length)return '原请求返回不同任务身份，请保留记录并核对，不能切换工程。';
  if(state.binding.submissionInFlight?.some(f=>f.state==='evidence_conflict'))return '已记录任务与回执证据不一致，请保留现场人工核对，不能切换工程。';
  if(state.binding.submissionInFlight?.length)return '原请求仍在途或发送者状态无法确认，请先核对；不能切换工程。';
  if(state.pending||state.binding.pendingRequests?.length)return '存在结果待核对的请求，请先返回对话核对。';
  return '';
}
// One controller per DSH session, owned by the plugin instance. No shared selection.
export function createConversationContexts({api=conversationApi, storage=()=>window.localStorage, interval=4000}={}) {
  const sessions=new Map();
  return {get(sessionId){
    if(sessions.has(sessionId))return sessions.get(sessionId);
    let state={binding:null,lastBinding:null,projects:[],pending:null,error:'',actionError:'',bindingReadError:'',directoryError:'',bindingReadCode:'',directoryCode:'',backendDisconnected:false,notice:'',storageError:'',busy:false,loading:true};
    let epoch=0,dirEpoch=0,timer=null,reading=false,directoryReading=false,directorySubscribers=0;
    const listeners=new Set();
    // Successful reads clear only their own errors. Never dismiss an uncertain
    // write/recovery result merely because a background read succeeds.
    const publish=patch=>{state={...state,...patch,...(Object.hasOwn(patch,'error')?{actionError:patch.error}:{})};state.error=state.actionError||state.bindingReadError||state.directoryError;state.backendDisconnected=[state.bindingReadCode,state.directoryCode].some(code=>isBackendDisconnected({code}));listeners.forEach(fn=>fn());};
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
        publish({binding,lastBinding:binding,loading:false,bindingReadError:'',bindingReadCode:''});recover(binding);
        if(!directoryReading)directory();
      }catch(e){if(ticket===epoch)publish({binding:null,loading:false,bindingReadError:isBackendDisconnected(e)?backendReadError(e):bindingError(e),bindingReadCode:e.code||''});}
      finally{if(ticket===epoch){reading=false;if(listeners.size)timer=setTimeout(refresh,interval);}}
    }
    async function directory({force=false}={}){
      if(!directorySubscribers&&!conversationParticipation(state.binding||state.lastBinding).enabled){
        dirEpoch++;directoryReading=false;
        if(state.projects.length||state.directoryError||state.directoryCode)publish({projects:[],directoryError:'',directoryCode:''});
        return;
      }
      if(directoryReading&&!force)return;
      const ticket=++dirEpoch;directoryReading=true;
      try{const value=validateSnapshot(await api('status'));if(ticket===dirEpoch)publish({projects:value.projects,directoryError:'',directoryCode:''});}
      catch(e){if(ticket===dirEpoch)publish({directoryError:backendReadError(e)||'工程目录读取失败，请重新读取。',directoryCode:e.code||''});}
      finally{if(ticket===dirEpoch)directoryReading=false;}
    }
    const controller={active:()=>listeners.size>0,snapshot:()=>state,subscribe(fn){listeners.add(fn);if(listeners.size===1)refresh();return()=>{listeners.delete(fn);if(!listeners.size){clearTimeout(timer);epoch++;dirEpoch++;reading=false;directoryReading=false;}};},subscribeDirectory(){directorySubscribers++;directory();return()=>{directorySubscribers=Math.max(0,directorySubscribers-1);directory();};},refresh({preserveActionError=false}={}){if(!preserveActionError)publish({error:''});refresh();directory({force:true});},
      async revise(task){
        if(state.busy||state.pending||state.storageError||!state.binding)return;
        if(state.binding.pendingRequests.length){publish({error:'有已投递或结果未知的请求，请先核对原请求。'});return;}
        if(state.binding.revisionContext&&state.binding.revisionContext.state!=='submitted'){publish({error:'本会话已有修订上下文，请先完成或取消。'});return;}
        if(state.binding.submissionConflicts?.length||state.binding.submissionInFlight?.length){publish({error:bindingBlockedReason(state)+' 当前不能设置新修订。'});return;}
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
        if(state.binding.submissionInFlight?.length||state.binding.submissionConflicts?.length){publish({error:bindingBlockedReason(state)+' 当前不能取消修订。'});return;}
        if(state.pending||state.binding.pendingRequests.length){publish({error:'有已投递或结果未知的请求，请先核对原请求；当前不能取消修订。'});return;}
        epoch++;reading=false;clearTimeout(timer);
        publish({busy:true,error:''});try{const binding=validateBinding(await api('conversations/revision/cancel',{conversationId:sessionId,intentId:revision.intentId}),sessionId);publish({binding});}catch(e){publish({error:e.message});}finally{publish({busy:false});refresh();}
      },
      async retryPending(){
        const body=state.pending;if(!body||state.busy||state.storageError)return;
        if(state.binding?.submissionConflicts?.some(c=>c.projectId===body.projectId&&c.clientRequestId===body.clientRequestId)){publish({error:'原请求返回不同任务身份，请保留记录人工核对。'});return;}
        const delivery=state.binding?.submissionInFlight?.find(f=>f.projectId===body.projectId&&f.clientRequestId===body.clientRequestId);
        if(delivery&&delivery.state!=='owner_exited'){publish({error:delivery.state==='evidence_conflict'?'已记录任务与回执证据不一致，请保留现场人工核对。':'原请求仍在途或发送者状态无法确认，暂不重发；可只读核对。'});return;}
        try{saveConversationPending(storage(),body);}catch{publish({storageError:'无法保存恢复请求，本次未发送。'});return;}
        publish({busy:true,error:''});epoch++;reading=false;clearTimeout(timer);
        try{const result=await api('conversations/tasks',body,65000);if(result.conversationId!==sessionId||result.task?.projectId!==body.projectId||!result.task?.taskId)throw new Error('归属未确认');clearConversationPending(storage(),sessionId);publish({pending:null});}
        catch{publish({error:'请求结果仍待核对，保留原请求编号。'});}
        finally{publish({busy:false});refresh();}
      },
      async checkReceipt(request){
        if(state.busy||!(state.binding?.pendingRequests.some(p=>p.clientRequestId===request.clientRequestId&&p.projectId===request.projectId)||state.binding?.submissionInFlight?.some(p=>p.clientRequestId===request.clientRequestId&&p.projectId===request.projectId)))return;
        const priorDelivery=state.binding?.submissionInFlight?.find(p=>p.clientRequestId===request.clientRequestId&&p.projectId===request.projectId);
        epoch++;reading=false;clearTimeout(timer);publish({busy:true,error:'',notice:''});
        try{
          const result=await api('conversations/receipt',{conversationId:sessionId,clientRequestId:request.clientRequestId});
          if(result.conversationId!==sessionId||result.projectId!==request.projectId||typeof result.found!=='boolean')throw new Error('回执归属未确认。');
          const limitation=priorDelivery?.state==='evidence_conflict'?' 已有回执证据冲突，仍需人工核对。':priorDelivery?.state==='legacy_unknown'?' 旧请求发送者状态无法确认，仍不能切换工程。':priorDelivery?.state==='active_or_unknown'?' 请重新读取确认发送是否收束；在途期间不能切换工程。':'';
          publish({notice:(result.found?'已核对到原任务，请从历史更改查看。':'当前未找到回执，结果仍未知；未重发，不能切换关联工程。')+limitation});
        }catch(e){publish({error:e.message||'回执暂不可核对，未重发。'});}
        finally{publish({busy:false});refresh();}
      },
      async bind(projectId){
        if(state.busy||!state.binding||state.pending||state.storageError||state.binding.pendingRequests.length)return;
        if(projectId===null&&conversationParticipation(state.binding).locked){publish({error:'此会话已有工程操作，请保留工程关联；普通聊天请新建会话。'});return;}
        if(projectId!==state.binding.projectId&&state.binding.submissionConflicts?.length){publish({error:'原请求返回了不同任务身份，请先保留记录并核对，不能切换工程。'});return;}
        if(projectId!==state.binding.projectId&&state.binding.submissionInFlight?.length){publish({error:bindingBlockedReason(state)});return;}
        // A freshly retained copy may not be in the cached directory yet.
        // The server validates existence; never silently discard this explicit intent.
        if(projectId!==null&&!/^[a-z][a-z0-9-]{0,63}$/.test(projectId))return;
        const body=bindRequest(state.binding,projectId);
        epoch++;reading=false;clearTimeout(timer);publish({busy:true,error:''});
        try{const binding=validateBinding(await api('conversations/bind',body),sessionId);publish({binding,lastBinding:binding});recover(binding);}
        catch(e){publish({error:bindingError(e)});}
        finally{publish({busy:false});refresh();directory();}
      },
      dispose(){listeners.clear();clearTimeout(timer);epoch++;dirEpoch++;reading=false;}
    };
    sessions.set(sessionId,controller);return controller;
  },activeSession(){const ids=[...sessions].filter(([,c])=>c.active()).map(([id])=>id);return ids.length===1?ids[0]:null;},dispose(){sessions.forEach(c=>c.dispose());sessions.clear();}};
}
