const projectPattern=/^[a-z][a-z0-9-]{0,63}$/;
const revisionPattern=/^[0-9a-f]{64}$/;
const text=(value,max=1000)=>typeof value==='string'&&value.length<=max;
const optionalText=(value,max=1000)=>value===undefined||value===null||text(value,max);
const changeValid=change=>change&&text(change.path,2000)&&['added','removed','changed'].includes(change.kind)&&['hmi-layout','hmi-content','plc','binding','scene','configuration','unknown'].includes(change.scope);
export function validateProjectInspection(value,projectId){
  if(!projectPattern.test(projectId||'')||value?.ok!==true||value.schemaVersion!==1||value.projectId!==projectId||!revisionPattern.test(value.projectRevision||'')||value.source!=='saved-files-only')throw new Error('工程保存资源的身份或版本未确认。');
  if(!Array.isArray(value.resources)||value.resources.length>4000||value.resources.some(row=>!row||!text(row.id,240)||!text(row.kind,80)||!text(row.path,2000)||!revisionPattern.test(row.sha256||'')))throw new Error('工程资源清单未获确认。');
  if(!Array.isArray(value.signals)||value.signals.length>4000||new Set(value.signals.map(row=>row?.id)).size!==value.signals.length||value.signals.some(row=>!row||!text(row.id,240)||!row.id||!optionalText(row.label)||!text(row.path,500)||!text(row.type,80)||!text(row.access,80)||row.source?.kind!=='plc'||!text(row.source?.path,2000)||!Array.isArray(row.hmi)||!Array.isArray(row.scene)||row.hmi.length>2000||row.scene.length>2000||row.hmi.some(use=>!use||!text(use.viewId,240)||!text(use.elementId,240)||!text(use.tagId,240)||!optionalText(use.viewName)||!optionalText(use.label))||row.scene.some(use=>!use||!text(use.id,240)||!optionalText(use.label)||!optionalText(use.direction,80)||!text(use.path,2000))))throw new Error('工程信号关联数据未获确认。');
  const r=value.readback;if(!r||!['untracked','current','changed'].includes(r.state)||!revisionPattern.test(r.observedRevision||'')||r.observedRevision!==value.projectRevision||!(r.baselineRevision===null||revisionPattern.test(r.baselineRevision||''))||!Array.isArray(r.changes)||r.changes.length>4000||r.changes.some(change=>!changeValid(change))||[r.capturedRevision,r.acknowledgedRevision].some(revision=>revision!==null&&!revisionPattern.test(revision||''))||r.lastReview&&(!revisionPattern.test(r.lastReview.fromRevision||'')||!revisionPattern.test(r.lastReview.toRevision||'')||r.lastReview.type!=='layout'||!Array.isArray(r.lastReview.changes)||r.lastReview.changes.some(change=>!changeValid(change))))throw new Error('工程变化记录与当前保存版本不一致。');
  if(value.editorState?.state!=='unknown'||!text(value.editorState?.message,4000)||!value.capabilities||typeof value.capabilities.canCapture!=='boolean'||typeof value.capabilities.canAcknowledgeLayout!=='boolean'||!optionalText(value.capabilities.blockedReason,4000))throw new Error('保存资源的可用操作未获确认。');
  return value;
}
export function inspectionRequest(value,action){
  if(!['capture','acknowledge'].includes(action)||!value)return null;
  validateProjectInspection(value,value.projectId);
  if(action==='capture'&&value.capabilities?.canCapture!==true||action==='acknowledge'&&value.capabilities?.canAcknowledgeLayout!==true)return null;
  return {projectId:value.projectId,action,expectedRevision:value.projectRevision,expectedBaseline:value.readback.baselineRevision};
}
export function signalReference(inspection,signalId){
  validateProjectInspection(inspection,inspection?.projectId);
  const signal=inspection?.signals?.find(row=>row.id===signalId);if(!signal)return null;
  return {projectId:inspection.projectId,signalKey:signal.id,savedRevision:inspection.projectRevision};
}
export function readonlyValueTargets(inspection,signalId,listing){
  const signal=inspection?.signals?.find(row=>row.id===signalId);
  if(!signal||listing?.projectId!==inspection.projectId||listing.projectRevision!==inspection.projectRevision||listing.capabilities?.hmiReadonlyValueCandidate!==true||!Array.isArray(listing.hmiValueTargets)||listing.hmiValueTargets.length>4000)return [];
  const targets=listing.hmiValueTargets.filter(row=>row&&text(row.viewId,240)&&row.viewId&&text(row.signalId,240)&&row.signalId&&optionalText(row.viewName)&&optionalText(row.label)&&row.path===signal.path&&row.type===signal.type);
  const seen=new Set();return targets.filter(row=>{const key=JSON.stringify([row.viewId,row.signalId]);if(seen.has(key))return false;seen.add(key);return true;});
}
