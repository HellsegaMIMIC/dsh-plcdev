import {conversationApi} from './conversation-client.mjs';

export const runtimeEventSources=Object.freeze({compiler:'OpenPLC 编译',runtime:'PLC Runtime',fuxa:'FUXA',oip:'OIP 检查',plcdev:'PLCdev'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=160)=>typeof value==='string'&&value.length<=max;
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const optional=(value,check)=>value===null||value===undefined||check(value);
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export function validateRuntimeEvents(value,projectId){
  const fail=()=>{throw new Error('运行事件的工程归属或数据格式无法核对。');};
  if(!object(value)||value.schemaVersion!==1||value.projectId!==projectId||!time(value.observedAt)||
    !optional(value.currentSessionId,v=>text(v))||!optional(value.projectRevision,digest)||
    !Array.isArray(value.events)||value.events.length>600||!Array.isArray(value.sources)||value.sources.length>8)fail();
  const ids=new Set();
  for(const event of value.events){
    if(!object(event)||!text(event.id)||!event.id||ids.has(event.id)||!Object.hasOwn(runtimeEventSources,event.source)||
      !['error','warning','info'].includes(event.severity)||!['active','resolved','recorded'].includes(event.status)||
      !text(event.phase,100)||!text(event.summary,1000)||!optional(event.detail,v=>text(v,12000))||!optional(event.raw,v=>text(v,32768))||
      !time(event.firstAt)||!time(event.lastAt)||event.lastAt<event.firstAt||!optional(event.resolvedAt,time)||
      !Number.isSafeInteger(event.count)||event.count<1||!optional(event.sessionId,v=>text(v))||
      !optional(event.projectRevision,digest)||!optional(event.programHash,v=>text(v,160))||
      !optional(event.origin,v=>text(v,1000)||object(v)))fail();
    if(event.variables!==undefined&&(!Array.isArray(event.variables)||event.variables.length>128||event.variables.some(v=>!object(v)||!text(v.name??v.path,240)||!optional(v.quality,q=>text(q,240))||JSON.stringify(v.value??null).length>2000)))fail();
    ids.add(event.id);
  }
  const sources=new Set();
  for(const source of value.sources){
    if(!object(source)||!Object.hasOwn(runtimeEventSources,source.id)||sources.has(source.id)||
      !['available','partial','unavailable'].includes(source.state)||!text(source.label,240)||!optional(source.reason,v=>text(v,2000)))fail();
    sources.add(source.id);
  }
  return value;
}
export function filterRuntimeEvents(value,{source='all',issuesOnly=false,scope='current'}={}){
  return (value?.events||[]).filter(event=>(source==='all'||event.source===source)&&(!issuesOnly||event.severity!=='info')&&
    (scope==='all'||(event.sessionId?!!value.currentSessionId&&event.sessionId===value.currentSessionId:!event.projectRevision||!value?.projectRevision||event.projectRevision===value.projectRevision)))
    .slice().sort((a,b)=>b.lastAt-a.lastAt||b.firstAt-a.firstAt||a.id.localeCompare(b.id));
}
export function runtimeEventIssues(value){
  const counts=Object.fromEntries(Object.keys(runtimeEventSources).map(key=>[key,0]));
  for(const event of filterRuntimeEvents(value))if(event.status==='active'&&event.severity!=='info'&&
    (!!event.sessionId||!event.projectRevision||!!value?.projectRevision&&event.projectRevision===value.projectRevision))counts[event.source]++;
  return counts;
}
export function createRuntimeEventReader(projectId,{api=conversationApi,setTimer=setTimeout,clearTimer=clearTimeout,interval=5000,now=Date.now}={}){
  if(typeof projectId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(projectId))throw new Error('请选择已登记的工程。');
  let state={value:null,error:'',busy:false,receivedAt:null},epoch=0,timer,inflight=null,disposed=false;
  const listeners=new Set(),publish=patch=>{state={...state,...patch};listeners.forEach(listener=>listener());};
  function refresh(){
    if(disposed)return Promise.resolve();
    if(inflight)return inflight;
    clearTimer(timer);const ticket=++epoch;publish({busy:true});
    inflight=(async()=>{
      try{const value=validateRuntimeEvents(await api('runtime-events?project='+encodeURIComponent(projectId),undefined,10000),projectId);if(!disposed&&ticket===epoch)publish({value,error:'',receivedAt:now()});}
      catch(error){if(!disposed&&ticket===epoch)publish({error:error.message||'运行事件暂时无法读取。'});}
      finally{if(!disposed&&ticket===epoch){inflight=null;publish({busy:false});if(listeners.size)timer=setTimer(refresh,interval);}}
    })();return inflight;
  }
  return {snapshot:()=>state,refresh,subscribe(listener){if(disposed)return()=>{};listeners.add(listener);if(listeners.size===1)void refresh();return()=>{listeners.delete(listener);if(!listeners.size){clearTimer(timer);epoch++;inflight=null;state={...state,busy:false};}};},dispose(){disposed=true;epoch++;clearTimer(timer);listeners.clear();}};
}
