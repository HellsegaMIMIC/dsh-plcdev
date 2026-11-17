// Presentation state only. It must never authorize binding, review or Runtime operations.
export const WORKSPACE_KEY='plcdev.dsh.workspace.v2';
export const workspaceViews=['resources','runtime','sessions','settings'];
const projectPattern=/^[a-z][a-z0-9-]{0,63}$/;
const taskPattern=/^task-[0-9a-f]{32}$/;
const sessionPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export function workspaceLocation(value){
  if(!value||!projectPattern.test(value.projectId||''))return null;
  const selected=typeof value.selected==='string'&&value.selected.length<=240?value.selected:null;
  const review=value.review&&value.review.projectId===value.projectId&&taskPattern.test(value.review.taskId||'')&&sessionPattern.test(value.review.sessionId||'')?{projectId:value.projectId,taskId:value.review.taskId,sessionId:value.review.sessionId}:null;
  return {projectId:value.projectId,view:workspaceViews.includes(value.view)?value.view:'resources',selected,review,scroll:Number.isFinite(value.scroll)?Math.max(0,Math.min(100000,value.scroll)):0};
}
export function readWorkspace(storage){
  const empty={schemaVersion:1,catalog:true,current:null,positions:{}};
  try{
    const value=JSON.parse(storage.getItem(WORKSPACE_KEY)||'null');if(value?.schemaVersion!==1)return empty;
    const positions={};for(const [key,entry] of Object.entries(value.positions||{}).slice(-50)){const location=workspaceLocation(entry);if(location&&key===location.projectId+':'+location.view)positions[key]=location;}
    return {schemaVersion:1,catalog:value.catalog===true,current:workspaceLocation(value.current),positions};
  }catch{return empty;}
}
export function rememberWorkspace(storage,previous,current,catalog){
  const location=workspaceLocation(current);if(!location)return previous;
  const positions={...previous.positions},key=location.projectId+':'+location.view;
  delete positions[key];positions[key]=location;
  const value={schemaVersion:1,catalog:catalog===true,current:location,positions:Object.fromEntries(Object.entries(positions).slice(-50))};
  try{storage.setItem(WORKSPACE_KEY,JSON.stringify(value));}catch{/* A display bookmark must not block project operations. */}
  return value;
}
export function projectLocationFor(state,projectId,view){
  if(!projectPattern.test(projectId||''))return null;
  const latest=Object.values(state.positions||{}).filter(value=>value.projectId===projectId).at(-1);
  const chosen=workspaceViews.includes(view)?view:state.current?.projectId===projectId?state.current.view:latest?.view||'resources';
  return workspaceLocation(state.positions?.[projectId+':'+chosen]||{projectId,view:chosen});
}
