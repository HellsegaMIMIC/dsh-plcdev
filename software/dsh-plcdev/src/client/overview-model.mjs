import { graphEntities, connectionLabel } from './model.mjs';

export const basename = value => typeof value === 'string' ? value.replace(/\\/g, '/').split('/').pop() : '';
export const displayValue = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function overviewLinks(snapshot) {
  const ids = new Set(graphEntities(snapshot).map(n => n.id));
  const definitions = [['load','编译装载','plc','runtime'],['generate','画面交付','designer','hmi'],['variables','变量读写','hmi','runtime'],['io',snapshot?.links?.io?.details?.protocol || '场景通信','runtime','scene']];
  return definitions.filter(([id,,source,target]) => snapshot?.links?.[id] && ids.has(source) && ids.has(target))
    .map(([id,title,source,target]) => ({id:'link:'+id,key:id,title,source,target,nodes:[source,target],details:snapshot.links[id].details || {}}));
}
export function overviewResources(snapshot, tasks) {
  const entities = graphEntities(snapshot), links = overviewLinks(snapshot), projectId = snapshot?.project?.id;
  const resource = n => ({id:n.id,title:basename(n.path) || n.title,description:n.title + ' · ' + n.role,path:n.path,nodes:[n.id],icon:n.icon});
  // A native HMI file can have both an editor and a runtime view. Count the file once.
  const hmiResources = new Map();
  for (const entity of entities.filter(n => n.id === 'designer' || n.id === 'hmi')) {
    const key=String(entity.path||entity.id).replaceAll('\\','/').toLowerCase();
    const existing=hmiResources.get(key);
    if(existing) existing.nodes.push(entity.id); else hmiResources.set(key,resource(entity));
  }
  return [
    {id:'plc',label:'PLC 程序',icon:'plc',items:entities.filter(n => n.id === 'plc').map(resource)},
    {id:'hmi',label:'HMI 画面',icon:'hmi',items:[...hmiResources.values()]},
    {id:'scene',label:'仿真场景',icon:'scene',items:entities.filter(n => n.id === 'scene').map(resource)},
    {id:'bindings',label:'变量与绑定',icon:'link',items:links.filter(l => ['variables','io'].includes(l.key)).map(l => ({...l,description:l.source+' ↔ '+l.target,path:snapshot?.project?.interfacePath || snapshot?.project?.bindingsPath || l.details?.protocol || '工程通信配置',icon:'link'}))},
    {id:'tasks',label:'候选任务',icon:'tasks',items:typeof projectId === 'string' && tasks?.projectId === projectId && Array.isArray(tasks?.tasks) ? tasks.tasks.filter(t => t.projectId === projectId).map(t => ({id:'task:'+t.taskId,title:t.request || t.taskId,description:t.status,path:t.taskId,nodes:[],icon:'tasks',taskId:t.taskId})) : []},
  ];
}
export function monitoredVariables(snapshot, connected, now = Date.now()) {
  if (!Array.isArray(snapshot?.state?.variables)) return [];
  const stamp = snapshot.state.observedAt;
  const fresh = connected === true && snapshot.observerFresh === true && snapshot.session?.active === true && typeof stamp === 'number' && now - stamp * 1000 >= 0 && now - stamp * 1000 < 2000;
  return snapshot.state.variables.filter(v => v && typeof v.path === 'string').map(v => {
    const quality = v.quality || snapshot.state.dataQuality;
    const live = fresh && quality === 'live' && v.fresh !== false && snapshot.state.telemetryFresh === true && snapshot.state.runtimeState === 'RUNNING';
    const historical = fresh && quality === 'historical' && snapshot.state.runtimeState === 'STOPPED';
    return {path:v.path,type:v.type || v.dataType || '未声明',value:live || historical ? displayValue(v.value) : '—',
      quality:!connected ? '后台未连接' : !fresh ? '数据失效' : historical ? '停止时采样' : live ? '实时采样' : '数据质量未知'};
  });
}
export function overviewConnection(snapshot, key, connected, now = Date.now()) {
  const status = connectionLabel(snapshot,key,connected,now);
  return {...status,label:status.label.replace(/运行会话/g,'运行实例')};
}
