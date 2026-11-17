// Display only the executor's bounded receipts, never raw native payloads.
const text=(value,max=1200)=>typeof value==='string'?value.slice(0,max):'';
export function nativeToolEvidence(component){
  const operations=(Array.isArray(component?.operations)?component.operations:[]).slice(0,64)
    .filter(row=>row&&typeof row.name==='string'&&typeof row.summary==='string')
    .map(row=>({name:text(row.name,80),summary:text(row.summary)}));
  const checks=(Array.isArray(component?.checks)?component.checks:[]).slice(0,64)
    .filter(row=>row&&typeof row.id==='string'&&typeof row.label==='string')
    .map(row=>({id:text(row.id,80),label:text(row.label,160),
      status:['passed','failed','warning','skipped'].includes(row.status)?row.status:'unknown',
      ...(typeof row.summary==='string'?{summary:text(row.summary)}:{})}));
  return {...(operations.length?{operations}:{}),...(checks.length?{checks}:{}),
    ...(typeof component?.nativeVersion==='string'?{nativeVersion:text(component.nativeVersion,80)}:{})};
}

export const nativeCheckLabel=status=>({passed:'通过',failed:'未通过',warning:'需注意',skipped:'未检查',unknown:'待核对'}[status]||'待核对');
export function nativeCheckSummary(checks){
  if(!checks?.length)return '';
  if(checks.some(row=>row.status==='failed'))return '原生检查未通过';
  if(checks.some(row=>row.status==='warning'))return '原生检查需注意';
  if(checks.some(row=>row.status!=='passed'))return '原生检查未完成';
  return '原生检查通过';
}
