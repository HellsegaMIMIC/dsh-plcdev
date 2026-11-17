import {conversationApi} from './conversation-client.mjs';
import {validateSnapshot,runtimeObservationFresh} from './model.mjs';

const validId=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);

// These records are navigation hints only. RuntimePane and the backend retain
// all operation permissions, ownership checks and unknown-outcome handling.
export function activityFromSnapshot(snapshot,now=Date.now()){
  const s=validateSnapshot(snapshot,snapshot?.project?.id),session=s.session;
  const transitioning=['building','stopping'].includes(s.phase);
  if(!validId(s.project.id)||!session?.active&&!transitioning)return null;
  if(session?.projectId!==s.project.id||!transitioning&&(typeof session.id!=='string'||!session.id))return null;
  const at=s.state?.observedAt,fresh=runtimeObservationFresh(s,now);
  const state=s.phase==='building'?'preparing':s.phase==='stopping'?'stopping':
    fresh&&s.state?.runtimeState==='RUNNING'?'running':
    fresh&&s.state?.runtimeState==='STOPPED'?'stopped':'unknown';
  return {projectId:s.project.id,projectName:s.project.name||'工程名称未提供',sessionId:session.id||null,state,
    observedAt:now,expiresAt:fresh?at*1000+2000:now+5000};
}

export function activityTargets(snapshot){
  const s=validateSnapshot(snapshot),ids=new Set();
  const available=new Set(s.projects.filter(p=>validId(p?.id)).map(p=>p.id));
  const add=id=>{if(available.has(id))ids.add(id);};
  if(s.session?.active||['building','stopping'].includes(s.phase))add(s.project.id);
  for(const session of s.otherSessions||[])if(session?.active||['building','stopping'].includes(session?.phase))add(session.projectId);
  if(s.runtimeOwner?.state!=='unknown'&&validId(s.runtimeOwner?.projectId))add(s.runtimeOwner.projectId);
  return [...ids].slice(0,16);
}

export function activityLabel(item,now=Date.now()){
  if(now>=item.expiresAt)return '运行状态待核对';
  return {running:'PLC 运行中',stopped:'实例就绪 · PLC 已停止',preparing:'正在准备实例',stopping:'正在结束实例',unknown:'运行状态待核对'}[item.state]||'运行状态待核对';
}

export function createRuntimeActivity({api=conversationApi,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let state={items:[],error:'',loading:false},timer,epoch=0,disposed=false;
  const listeners=new Set();
  const publish=patch=>{state={...state,...patch};for(const listener of listeners)listener();};
  async function refresh(){
    if(disposed)return;
    clearTimer(timer);const ticket=++epoch;
    publish({loading:true});
    try{
      const base=validateSnapshot(await api('status'));
      const targets=activityTargets(base);
      const outcomes=await Promise.allSettled(targets.map(async id=>{
        const value=id===base.project.id?base:validateSnapshot(await api('status?project='+encodeURIComponent(id)),id);
        return activityFromSnapshot(value,now());
      }));
      if(ticket!==epoch||disposed)return;
      const items=[];
      outcomes.forEach((result,index)=>{
        if(result.status==='fulfilled'){if(result.value)items.push(result.value);}
        else{const previous=state.items.find(item=>item.projectId===targets[index]);
          if(previous)items.push({...previous,state:'unknown',expiresAt:now()});}
      });
      publish({items,error:outcomes.some(result=>result.status==='rejected')?'部分运行状态无法确认':'',loading:false});
    }catch(error){
      if(ticket!==epoch||disposed)return;
      publish({items:state.items.map(item=>({...item,state:'unknown',expiresAt:now()})),error:error?.message||'运行状态无法确认',loading:false});
    }finally{
      if(ticket===epoch&&!disposed&&listeners.size)timer=setTimer(refresh,state.items.length?1000:4000);
    }
  }
  return {snapshot:()=>state,subscribe(listener){
    if(disposed)return ()=>{};
    listeners.add(listener);if(listeners.size===1)refresh();
    return ()=>{listeners.delete(listener);if(!listeners.size){clearTimer(timer);epoch++;}};
  },refresh,dispose(){disposed=true;epoch++;clearTimer(timer);listeners.clear();}};
}
