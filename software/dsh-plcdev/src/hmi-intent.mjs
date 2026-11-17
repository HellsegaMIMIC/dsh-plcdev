// This narrow parser mirrors the saved-version TaskService HMI intent contract.
// A rejected or ambiguous request must be rephrased rather than guessed.
const unscoped=/^\s*(?:把|将)(静态文字|文字|画面名称)(\s*ID\s*)?([“"])([^“”"\r\n]+)([”"])(?:改为|改成|设置为|设为|替换为)([“"])([^“”"\r\n]+)([”"])[。.!！]?\s*$/u;
const scoped=/^\s*(?:把|将)画面\s*ID\s*([“"])([^“”"\r\n]+)([”"])的(静态文字|文字)(\s*ID\s*)?([“"])([^“”"\r\n]+)([”"])(?:改为|改成|设置为|设为|替换为)([“"])([^“”"\r\n]+)([”"])[。.!！]?\s*$/u;
const paired=(open,close)=>open==='“'?close==='”':open==='"'&&close==='"';
export function parseHmiIntent(workflow,request){
  if(typeof request!=='string'||request.length>4000)return null;
  const type=workflow==='hmi-static-text-v1'?'文字':workflow==='hmi-view-name-v1'?'画面名称':null;
  if(!type)return null;
  let match=unscoped.exec(request),kind,idMode,oldValue,newValue,viewId=null;
  if(match){kind=match[1];idMode=!!match[2];oldValue=match[4];newValue=match[7];if(!paired(match[3],match[5])||!paired(match[6],match[8]))return null;}
  else {match=scoped.exec(request);if(!match||type!=='文字')return null;viewId=match[2];kind=match[4];idMode=!!match[5];oldValue=match[7];newValue=match[10];if(!paired(match[1],match[3])||!paired(match[6],match[8])||!paired(match[9],match[11]))return null;}
  if(type==='文字'&&kind==='静态文字')kind='文字';
  else if(type==='文字'&&kind==='文字'&&!idMode)return null;
  if(kind!==type||!oldValue.trim()||!newValue.trim()||newValue!==newValue.trim()||/[\x00-\x1f]/.test(oldValue+newValue))return null;
  return {type,idMode,oldValue,newValue,viewId};
}
export function matchesHmiIntent(workflow,request,plan,targets){
  const intent=parseHmiIntent(workflow,request);if(!intent||!plan||!Array.isArray(targets))return false;
  const value=intent.type==='文字'?plan.text:plan.name;if(value!==intent.newValue)return false;
  let matches;
  if(intent.type==='文字'){
    matches=targets.filter(row=>row&&typeof row.viewId==='string'&&typeof row.elementId==='string'&&typeof row.text==='string'&&(intent.idMode?row.elementId===intent.oldValue:row.text===intent.oldValue)&&(intent.viewId===null||row.viewId===intent.viewId));
    return matches.length===1&&(intent.idMode||matches[0].ambiguousText===false)&&matches[0].viewId===plan.viewId&&matches[0].elementId===plan.elementId&&matches[0].text!==intent.newValue;
  }
  matches=targets.filter(row=>row&&typeof row.id==='string'&&typeof row.name==='string'&&(intent.idMode?row.id===intent.oldValue:row.name===intent.oldValue));
  return matches.length===1&&(intent.idMode||matches[0].ambiguousName===false)&&matches[0].id===plan.viewId&&matches[0].name!==intent.newValue;
}
// Bridge/outbox can enforce syntax and named IDs without treating a client
// supplied target list as authority. TaskService rechecks the saved project.
export function matchesHmiPlan(workflow,request,plan){
  if(workflow==='hmi-readonly-value-v1')return matchesReadonlyValueIntent(request,plan);
  const intent=parseHmiIntent(workflow,request);if(!intent||!plan||typeof plan!=='object')return false;
  if(intent.type==='文字')return plan.text===intent.newValue&&(!intent.idMode||plan.elementId===intent.oldValue)&&(intent.viewId===null||plan.viewId===intent.viewId);
  return plan.name===intent.newValue&&(!intent.idMode||plan.viewId===intent.oldValue);
}

export function matchesReadonlyValueIntent(request,plan,targets){
  if(typeof request!=='string'||request.length>4000||!plan||Object.keys(plan).sort().join(',')!=='signalId,viewId')return false;
  const match=/^\s*在画面 ID“([^“”\r\n]+)”添加信号 ID“([^“”\r\n]+)”的只读数值显示[。.!！]?\s*$/u.exec(request);
  if(!match||Object.values(plan).some(v=>typeof v!=='string'||v.length<1||v.length>120||/[\x00-\x1f]/.test(v))||match[1]!==plan.viewId||match[2]!==plan.signalId)return false;
  return targets===undefined||Array.isArray(targets)&&targets.filter(t=>t?.viewId===plan.viewId&&t?.signalId===plan.signalId).length===1;
}

// Revision intent is pinned to the parent's verified target and current value.
// The task service still verifies uniqueness against the actual parent files.
export function matchesHmiRevisionIntent(workflow,request,plan,revision){
  const intent=parseHmiIntent(workflow,request),target=revision?.target,current=revision?.previousSummary?.after;
  if(!intent||!target||revision.workflow!==workflow||typeof current!=='string'||!matchesHmiPlan(workflow,request,plan)||plan.viewId!==target.viewId)return false;
  if(intent.type==='文字'&&plan.elementId!==target.elementId)return false;
  const targetId=intent.type==='文字'?target.elementId:target.viewId;
  return (intent.idMode?intent.oldValue===targetId:intent.oldValue===current)&&intent.newValue!==current;
}
