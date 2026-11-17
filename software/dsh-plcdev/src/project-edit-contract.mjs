// Transport validation only. The native executors own their tool schemas
// and editing semantics. Python verifies ownership, saved/parent hashes and
// cross-resource constraints before publication.
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&v.length>0&&v.length<=120&&!/[\x00-\x1f]/.test(v);
const label=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/[\x00-\x1f<>]/.test(v);
const bytes=v=>new TextEncoder().encode(v).length;
const nativeCalls=(calls,min=1)=>Array.isArray(calls)&&calls.length>=min&&calls.length<=64&&calls.every(call=>exact(call,['name','input'])&&typeof call.name==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(call.name)&&record(call.input));
const nativeBatch=change=>exact(change,['kind','calls'])&&nativeCalls(change.calls);
export function validProjectEditPlan(plan){
  if(!exact(plan,['schemaVersion','changes'])||plan.schemaVersion!==1||!Array.isArray(plan.changes)||!plan.changes.length||plan.changes.length>32)return false;
  try {if(bytes(JSON.stringify(plan))>524288)return false;}catch{return false;}
  const nativeBatches=plan.changes.filter(change=>change?.kind==='openplc-tools').length;
  if(nativeBatches>1||(nativeBatches&&plan.changes.some(change=>change?.kind==='plc-source')))return false;
  const oipBatches=plan.changes.filter(change=>['oip-tools','oip-create-scene'].includes(change?.kind)).length;
  if(oipBatches>1||(oipBatches&&plan.changes.some(change=>['oip-part-name','oip-conveyor-speed'].includes(change?.kind))))return false;
  return plan.changes.every(change=>{
    switch(change?.kind){
      case 'openplc-tools':
      case 'oip-tools':return nativeBatch(change);
      case 'oip-create-scene':return exact(change,['kind','name','calls'])&&label(change.name,80)&&nativeCalls(change.calls,0);
      case 'plc-source':return exact(change,['kind','path','expectedHash','content'])&&typeof change.path==='string'&&change.path.length<=240&&/\.st$/i.test(change.path)&&!/[\\:\x00-\x1f]/.test(change.path)&&!change.path.startsWith('/')&&!change.path.split('/').some(p=>!p||p==='.'||p==='..')&&/^[a-f0-9]{64}$/.test(change.expectedHash||'')&&typeof change.content==='string'&&change.content.trim().length>0&&bytes(change.content)<=131072;
      case 'interface':return exact(change,['kind','definition'])&&record(change.definition);
      case 'hmi-view-name':return exact(change,['kind','viewId','name'])&&id(change.viewId)&&label(change.name,80);
      case 'hmi-static-text':return exact(change,['kind','viewId','elementId','text'])&&id(change.viewId)&&/^PLCD_[A-Za-z0-9_-]{1,100}$/.test(change.elementId||'')&&label(change.text,160);
      case 'hmi-readonly-value':return exact(change,['kind','viewId','signalId'])&&id(change.viewId)&&id(change.signalId);
      case 'oip-part-name':return exact(change,['kind','partId','name'])&&id(change.partId)&&label(change.name,80);
      case 'oip-conveyor-speed':return exact(change,['kind','partId','value'])&&id(change.partId)&&typeof change.value==='number'&&Number.isFinite(change.value)&&change.value>=0.1&&change.value<=3;
      default:return false;
    }
  });
}
export function validProjectEditSubmission(value){
  if(!exact(value,['schemaVersion','plan','route'])||value.schemaVersion!==1||!exact(value.route,['provider','model'])||!Object.values(value.route).every(v=>typeof v==='string'&&v.length>0&&v.length<=160)||!validProjectEditPlan(value.plan))return false;
  return bytes(JSON.stringify(value))<=524288;
}
