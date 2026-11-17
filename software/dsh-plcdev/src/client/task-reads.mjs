import {conversationApi,validateBinding} from './conversation-client.mjs';
import {validateTasks,validateSnapshot} from './model.mjs';

// Cached records are display evidence only. Full task/binding reads reuse only
// an identical request already in flight; completed data never grants actions.
export function createTaskReads({api=conversationApi,maxProjects=24}={}){
  const records=new Map(),pending=new Map(),epochs=new Map(),listeners=new Map(),recordOrder=new Map(),snapshots=new Map();
  let disposed=false,sequence=0;
  const generation=key=>epochs.get(key)||0;
  function remember(projectId,tasks,order){
    if(order<(recordOrder.get(projectId)||0))return;
    const value={projectId,tasks:tasks.map(task=>{
      const {editingInput,planningInput,...candidate}=task.candidate||{};
      return {...task,...(task.candidate?{candidate}:{})};
    })};
    recordOrder.set(projectId,order);records.delete(projectId);records.set(projectId,value);
    while(records.size>maxProjects)records.delete(records.keys().next().value);
    listeners.get(projectId)?.forEach(fn=>fn(value));return value;
  }
  function read(key,loader){
    if(disposed)return Promise.reject(new Error('工程记录读取器已关闭。'));
    if(pending.has(key))return pending.get(key);
    const ticket=generation(key);
    const request=Promise.resolve().then(()=>loader(()=>!disposed&&generation(key)===ticket)).finally(()=>{
      if(pending.get(key)===request)pending.delete(key);
    });
    pending.set(key,request);return request;
  }
  return {
    peekRecords:projectId=>records.get(projectId)||null,
    subscribeRecords(projectId,fn){
      if(!listeners.has(projectId))listeners.set(projectId,new Set());
      const active=listeners.get(projectId);active.add(fn);
      return()=>{active.delete(fn);if(!active.size)listeners.delete(projectId);};
    },
    readRecords(projectId){return read('records:'+projectId,async current=>{
      const order=++sequence;
      const value=await api('task-records?project='+encodeURIComponent(projectId),undefined,60000);
      if(value?.projectId!==projectId||!Array.isArray(value.tasks)||value.tasks.some(task=>task?.projectId!==projectId||typeof task.taskId!=='string'))throw new Error('调整记录的工程身份无法确认。');
      if(current())remember(projectId,value.tasks,order);return value;
    });},
    readTasks(projectId){return read('tasks:'+projectId,async current=>{
      const order=++sequence;
      const value=validateTasks(await api('task-state?project='+encodeURIComponent(projectId),undefined,60000),projectId);
      if(current())remember(projectId,value.tasks,order);return value;
    });},
    readBinding(sessionId){return read('binding:'+sessionId,async()=>validateBinding(await api('conversations?conversationId='+encodeURIComponent(sessionId)),sessionId));},
    // Sync badges are display evidence. Brief reuse avoids one expensive status
    // read per historical card; no mutation derives authority from this cache.
    readSnapshot(projectId){
      const cached=snapshots.get(projectId);if(cached&&Date.now()-cached.at<2000)return Promise.resolve(cached.value);
      return read('snapshot:'+projectId,async current=>{
        const value=validateSnapshot(await api('status?project='+encodeURIComponent(projectId)),projectId);
        if(current()){snapshots.delete(projectId);snapshots.set(projectId,{at:Date.now(),value});while(snapshots.size>maxProjects)snapshots.delete(snapshots.keys().next().value);}
        return value;
      });
    },
    invalidate(projectId,sessionId){
      snapshots.delete(projectId);
      for(const key of ['records:'+projectId,'tasks:'+projectId,'snapshot:'+projectId,...(sessionId?['binding:'+sessionId]:[])]){
        epochs.set(key,generation(key)+1);pending.delete(key);
      }
    },
    dispose(){disposed=true;records.clear();pending.clear();epochs.clear();listeners.clear();recordOrder.clear();snapshots.clear();},
  };
}

// Scope caches to this plugin's contexts (or the actual window for isolated
// embeddings). No disk cache, cross-account cache, or second task database.
const scopes=new WeakMap();
export function taskReadsFor(contexts){
  const scope=contexts&&typeof contexts==='object'?contexts:window;
  if(!scopes.has(scope))scopes.set(scope,createTaskReads());
  return scopes.get(scope);
}
