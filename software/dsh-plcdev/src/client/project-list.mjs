export function projectLocation(project) {
  const path = typeof project?.manifestPath === 'string' ? project.manifestPath.trim() : '';
  if (!path) return '目录未提供';
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}
export function projectModifiedTime(project) {
  const value=project?.modifiedAt;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
  const stamp=Date.parse(value);
  return Number.isFinite(stamp)&&stamp>0?stamp:null;
}

export function projectModifiedLabel(project) {
  const stamp=projectModifiedTime(project);
  return stamp===null?'修改时间未提供':'修改于 '+new Intl.DateTimeFormat('zh-CN',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).format(stamp);
}

const names=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const roleNames={plc:['plc'],hmi:['hmi'],scene:['scene','场景','仿真','仿真场景']};
export function filterProjects(projects, query, {tool='all',sort='modified'}={}) {
  const term = String(query || '').trim().toLocaleLowerCase();
  const roles=roleNames[tool];
  return (Array.isArray(projects)?projects:[]).filter(p =>
    (!term || [p.name, p.manifestPath, projectLocation(p)].some(v => String(v || '').toLocaleLowerCase().includes(term)))&&
    (!roles||Array.isArray(p.toolchain)&&p.toolchain.some(entry=>roles.includes(String(entry.role||'').trim().toLowerCase())))
  ).sort((a,b)=>{
    if(sort==='modified'){
      const aTime=projectModifiedTime(a),bTime=projectModifiedTime(b);
      if(aTime!==bTime)return (bTime??-1)-(aTime??-1);
    }
    return names.compare(a.name||'',b.name||'')||names.compare(a.id||'',b.id||'');
  });
}
