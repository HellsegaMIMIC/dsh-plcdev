import {conversationApi} from './conversation-client.mjs';
import {validateSnapshot,definitiveFailure,graphEntities} from './model.mjs';
export const runtimeActions=[['start','canPrepare','编译并准备'],['runtime-start','canRun','运行 PLC'],['runtime-stop','canStop','停止 PLC'],['end','canEnd','结束运行实例']];
// Opening a runtime view is separate from starting PLC execution or simulation.
// Keep the sidebar and full workspace on the same configured-resource mapping.
export function runtimeToolActions(snapshot){
  const entities=graphEntities(snapshot),caps=snapshot?.capabilities||{},actions=[];
  const hmi=entities.find(entity=>entity.hmi),scene=entities.find(entity=>entity.id==='scene'&&entity.tool);
  if(hmi){
    const reconnect=snapshot.hmiOpen&&!hmi.fuxa,capability=reconnect?'canReconnectHmi':'canShowHmi';
    const allowed=caps[capability]===true;
    actions.push({id:'hmi',label:reconnect?'重新打开运行画面':'打开运行画面',action:hmi.fuxa?'open-hmi':reconnect?'reopen-hmi':'show-hmi',capability,allowed,
      reason:allowed?'':caps.reasons?.[capability]||'后台尚未确认运行画面可用。'});
  }
  if(scene){
    const allowed=caps.tools?.[scene.tool]===true;
    actions.push({id:'scene',label:'打开仿真场景',action:'tool',tool:scene.tool,capability:null,allowed,
      reason:allowed?'':caps.reasons?.[scene.tool]||'后台尚未确认场景入口可用。',
      note:scene.tool==='oip'?caps.reasons?.oipRuntime||'':''});
  }
  return actions;
}
// Display-only evidence from the latest successful status; never used to
// authorize an action or persisted as a second source of Runtime ownership.
function lastOwner(snapshot,at){
  if(snapshot.runtimeOwner===null)return null;
  const owner=snapshot.runtimeOwner;
  if(!owner||owner.state==='unknown'||typeof owner.sessionId!=='string'||!owner.sessionId||owner.sessionId.length>160)return undefined;
  const text=value=>typeof value==='string'&&value.length<=160&&value.trim()?value:null;
  const program=text(owner.programHash)||(snapshot.session?.id===owner.sessionId?text(snapshot.session?.programHash):null);
  return {sessionId:owner.sessionId,owner:text(owner.owner),projectId:text(owner.projectId),programHash:program,observedAt:at};
}
export function createProjectContexts({api=conversationApi,storage=()=>window.localStorage,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const projects=new Map();
  return {get(projectId){
    if(projects.has(projectId))return projects.get(projectId);
    let state={snapshot:null,lastRuntimeOwner:null,error:'',notice:'',busy:false,pending:null},timer,expiryTimer,epoch=0;
    const listeners=new Set(),key='plcdev.dsh.runtime.pending.'+projectId;
    const publish=p=>{state={...state,...p};listeners.forEach(fn=>fn());};
    async function refresh({invalidate=false}={}){
      clearTimer(timer);const ticket=++epoch;let activeResponse=false;
      // Keep a recently confirmed snapshot during an ordinary refresh to avoid
      // flashing the entire project view. A slow or lost request must not leave
      // an old owner/capability snapshot active beyond its freshness window.
      // Ordinary polling is silent for idle projects too. Invalidations after
      // a mutation must still retire the old capabilities immediately.
      if(invalidate){clearTimer(expiryTimer);publish({snapshot:null});}
      try{const snapshot=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);if(ticket===epoch){
        clearTimer(expiryTimer);activeResponse=snapshot.session?.active===true;
        const received=now(),observed=snapshot.state?.observedAt;
        const needsSample=activeResponse&&snapshot.observerFresh===true;
        const age=typeof observed==='number'&&Number.isFinite(observed)?received-observed*1000:NaN;
        if(needsSample&&(!Number.isFinite(age)||age<0||age>=2000))publish({snapshot:null,error:'当前状态无法确认：观察数据已过期。'});
        else{
          const history=lastOwner(snapshot,received);
          publish({snapshot,error:'',...(history===undefined?{}:{lastRuntimeOwner:history})});
          {const expiry=activeResponse?(needsSample?received+2000-age:received+2000):received+8000;
            expiryTimer=setTimer(()=>{if(state.snapshot===snapshot)publish({snapshot:null,error:'当前状态无法确认：观察数据已过期。'});},expiry-received);
          }
        }
      }}
      catch(e){if(ticket===epoch){clearTimer(expiryTimer);publish({snapshot:null,error:'当前状态无法确认：'+e.message});}}
      finally{if(ticket===epoch&&listeners.size)timer=setTimer(refresh,activeResponse||state.snapshot?.session?.active===true?1000:4000);}
    }
    function recover(){try{const pending=JSON.parse(storage().getItem(key)||'null');publish({pending,notice:pending?'上次操作结果待核对，不会自动重发。请核对当前状态后确认。':''});}catch{publish({pending:{invalid:true},notice:'无法读取持久恢复记录，操作已停用。'});}}
    const controller={snapshot:()=>state,subscribe(fn){listeners.add(fn);if(listeners.size===1){recover();refresh();}return()=>{listeners.delete(fn);if(!listeners.size){clearTimer(timer);clearTimer(expiryTimer);epoch++;publish({snapshot:null});}};},refresh,
      acknowledge(){if(!state.snapshot||state.busy)return;try{storage().removeItem(key);publish({pending:null,notice:''});}catch{publish({notice:'无法保存核对结果。'});}},
      async action(action,tool){
        const s=state.snapshot;if(!s||state.busy||state.pending)return;
        const cap=runtimeActions.find(a=>a[0]===action)?.[1];
        if(action==='tool'){
          if(typeof tool!=='string'||!tool||s.capabilities?.tools?.[tool]!==true)return;
        }else{
          // A tool capability must never authorize a different action (e.g. RUN).
          if(tool!==undefined)return;
          const hmi=runtimeToolActions(s).find(item=>item.id==='hmi'&&item.action===action);
          if(cap?s.capabilities?.[cap]!==true:hmi?.allowed!==true)return;
        }
        const body={projectId,sessionId:s.session?.id??s.sessionId??null,action,client:'dsh-'+crypto.randomUUID(),sequence:1,expires:now()/1000+12,...(tool?{tool}:{})};
        try{storage().setItem(key,JSON.stringify(body));}catch{publish({notice:'无法保存操作身份，本次未发送。'});return;}
        publish({busy:true,pending:body,notice:'正在处理…'});
        try{const result=await api('action',body,30000);if(!result.ok)throw new Error('服务未确认结果');storage().removeItem(key);publish({pending:null,notice:'操作已登记，请核对最新状态。'});}
        catch(e){if(definitiveFailure(e)){try{storage().removeItem(key);publish({pending:null});}catch{}}publish({notice:definitiveFailure(e)?e.message:'操作结果待核对，不会自动重发。'});}
        finally{publish({busy:false,snapshot:null});if(listeners.size)refresh({invalidate:true});}
      },dispose(){listeners.clear();clearTimer(timer);clearTimer(expiryTimer);epoch++;publish({snapshot:null,lastRuntimeOwner:null});}
    };projects.set(projectId,controller);return controller;
  },dispose(){projects.forEach(c=>c.dispose());projects.clear();}};
}
