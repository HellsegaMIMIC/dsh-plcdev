import {conversationApi} from './conversation-client.mjs';
import {validateSnapshot,definitiveFailure} from './model.mjs';
export const runtimeActions=[['start','canPrepare','编译并准备'],['runtime-start','canRun','运行'],['runtime-stop','canStop','停止'],['end','canEnd','结束本次运行']];
export function createProjectContexts({api=conversationApi,storage=()=>window.localStorage,now=()=>Date.now()}={}){
  const projects=new Map();
  return {get(projectId){
    if(projects.has(projectId))return projects.get(projectId);
    let state={snapshot:null,error:'',notice:'',busy:false,pending:null},timer,epoch=0;
    const listeners=new Set(),key='plcdev.dsh.runtime.pending.'+projectId;
    const publish=p=>{state={...state,...p};listeners.forEach(fn=>fn());};
    async function refresh(){
      clearTimeout(timer);const ticket=++epoch;
      // Expire the old snapshot before a potentially slow request.
      publish({snapshot:null});
      try{const snapshot=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);if(ticket===epoch)publish({snapshot,error:''});}
      catch(e){if(ticket===epoch)publish({snapshot:null,error:'当前状态无法确认：'+e.message});}
      finally{if(ticket===epoch&&listeners.size)timer=setTimeout(refresh,4000);}
    }
    function recover(){try{const pending=JSON.parse(storage().getItem(key)||'null');publish({pending,notice:pending?'上次操作结果待核对，不会自动重发。请核对当前状态后确认。':''});}catch{publish({pending:{invalid:true},notice:'无法读取持久恢复记录，操作已停用。'});}}
    const controller={snapshot:()=>state,subscribe(fn){listeners.add(fn);if(listeners.size===1){recover();refresh();}return()=>{listeners.delete(fn);if(!listeners.size){clearTimeout(timer);epoch++;}};},refresh,
      acknowledge(){if(!state.snapshot||state.busy)return;try{storage().removeItem(key);publish({pending:null,notice:''});}catch{publish({notice:'无法保存核对结果。'});}},
      async action(action,tool){
        const s=state.snapshot;if(!s||state.busy||state.pending)return;
        const cap=runtimeActions.find(a=>a[0]===action)?.[1];
        if(tool? s.capabilities?.tools?.[tool]!==true : !cap||s.capabilities?.[cap]!==true)return;
        const body={projectId,sessionId:s.session?.id??s.sessionId??null,action,client:'dsh-'+crypto.randomUUID(),sequence:1,expires:now()/1000+12,...(tool?{tool}:{})};
        try{storage().setItem(key,JSON.stringify(body));}catch{publish({notice:'无法保存操作身份，本次未发送。'});return;}
        publish({busy:true,pending:body,notice:'正在处理…'});
        try{const result=await api('action',body,30000);if(!result.ok)throw new Error('服务未确认结果');storage().removeItem(key);publish({pending:null,notice:'操作已登记，请核对最新状态。'});}
        catch(e){if(definitiveFailure(e)){try{storage().removeItem(key);publish({pending:null});}catch{}}publish({notice:definitiveFailure(e)?e.message:'操作结果待核对，不会自动重发。'});}
        finally{publish({busy:false});if(listeners.size)refresh();else publish({snapshot:null});}
      },dispose(){listeners.clear();clearTimeout(timer);epoch++;}
    };projects.set(projectId,controller);return controller;
  },dispose(){projects.forEach(c=>c.dispose());projects.clear();}};
}
