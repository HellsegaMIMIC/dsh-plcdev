// An open acknowledgement is not proof that OIP loaded the saved version.
// Display synchronization only for the exact saved project revision.
export function oipResultState(task,observation){
  if(!task?.retention?.keptProjectId)return null;
  if(!/^[a-f0-9]{64}$/.test(task.retention.revision||''))return {state:'unknown',label:'显示版本待核对'};
  if(observation?.state==='pending_confirmation')return {state:'pending_confirmation',label:'等待 OIP 确认',message:observation.message||'请在 OIP 确认打开工程。'};
  if(!observation)return {state:'unknown',label:'显示版本待核对'};
  if(observation.state==='not_open')return {state:'not_open',label:'尚未打开',message:observation.message||'可在 OIP 查看已保留的场景。'};
  if(observation.state==='blocked')return {state:'blocked',label:'同步待处理',message:observation.message||'请先在 OIP 处理未保存修改。'};
  if(observation.state==='synced'&&observation.revision===task.retention.revision)return {state:'synced',label:'已同步保留版本'};
  if(observation.state==='synced')return {state:'historical',label:'OIP 显示其他版本',message:'请从这条结果打开对应的保留版本。'};
  return {state:'unknown',label:'显示版本待核对',message:typeof observation.message==='string'?observation.message:undefined};
}

export function oipPreviewState(launch,observation){
  if(!launch||launch.target!=='candidate')return null;
  if(observation?.state==='synced'&&/^[a-f0-9]{64}$/.test(launch.observationRevision||'')&&observation.revision===launch.observationRevision)return {state:'synced',label:'候选预览已载入'};
  if(observation?.state==='pending_confirmation')return {state:'pending_confirmation',label:'等待 OIP 确认',message:observation.message||'请在 OIP 确认打开工程。'};
  return {state:observation?.state==='blocked'?'blocked':'unknown',label:observation?.state==='blocked'?'预览待处理':'预览载入待核对',message:typeof observation?.message==='string'?observation.message:undefined};
}

export async function readOipResourceObservation(api,conversationId,launch){
  const keys=['projectId','taskId','candidateDigest','target','tool','launchId'];
  if(!launch||keys.some(key=>typeof launch[key]!=='string')||launch.tool!=='oip')throw new Error('OIP 预览身份尚未确认。');
  const request=Object.fromEntries(keys.map(key=>[key,launch[key]]));
  const result=await api('conversations/result-resource-status',{conversationId,...request},15000);
  if(result?.ok!==true||keys.some(key=>result[key]!==request[key])||result.observationRevision!==launch.observationRevision)throw new Error('OIP 预览回读不属于这次打开。');
  return result.toolSync?.oip||{state:'unknown'};
}
