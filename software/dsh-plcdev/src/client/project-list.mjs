export function projectLocation(project) {
  const path = typeof project?.manifestPath === 'string' ? project.manifestPath.trim() : '';
  if (!path) return '目录未提供';
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}
export function filterProjects(projects, query) {
  const term = String(query || '').trim().toLocaleLowerCase();
  return projects.filter(p => !term || [p.name, p.manifestPath, projectLocation(p)].some(v => String(v || '').toLocaleLowerCase().includes(term)));
}
