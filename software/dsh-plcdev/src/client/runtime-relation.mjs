import {connectionLabel,runtimeObservationFresh} from './model.mjs';
import {runtimeEventIssues} from './runtime-events.mjs';

const short=value=>typeof value==='string'&&value?value.slice(0,8):null;
export function runtimeEnvironment(snapshot,environment){
  return ['runtime','msys'].map(id=>{
    const probe=environment?.tools?.find(row=>row.id===id);
    const dependency=snapshot?.dependencies?.find(row=>row.id===id);
    const state=probe?.state??(dependency?.available===true?'partial':dependency?.available===false?'missing':'unchecked');
    return {id,label:id==='runtime'?'OpenPLC Runtime':'编译依赖',state,labelState:{found:'入口已找到',partial:'基本入口已找到',missing:'入口未找到',unchecked:'未检测'}[state]||'未检测',version:probe?.version||null};
  });
}

/** Current observation is the only authority for current RUN/connection status.
 * Saved project revisions and compiled PLC hashes are deliberately not compared.
 */
export function runtimeRelation(snapshot,{environment=null,projectRevision=null,now=Date.now()}={}){
  const s=snapshot,known=!!s,active=s?.session?.active===true;
  const fresh=runtimeObservationFresh(s,now);
  const phase=s?.session?.phase||s?.phase;
  const building=phase==='building'||s?.components?.runtime?.state==='preparing',stopping=phase==='stopping';
  const load=s?.links?.load?.state;
  const stale=active&&load==='stale',configurationChanged=active&&s?.projectChanged===true&&!stale;
  const current=fresh&&load==='current';
  const hash=short(s?.session?.programHash);
  const env=runtimeEnvironment(s,environment);
  const missing=env.some(row=>row.state==='missing');
  const revision=known?short(projectRevision):null;
  const runtimeValue=!known?'状态未确认':building?'正在准备':stopping?'正在结束':active&&!fresh?'运行状态未知':fresh&&s.state.runtimeState==='RUNNING'?'RUN · 运行中':fresh&&s.state.runtimeState==='STOPPED'?'STOP · 已停止':active?'执行状态未知':phase==='fault'?'准备或运行异常':phase==='ended'?'已结束':'尚未准备';
  const runtimeTone=!known?'muted':phase==='fault'?'warning':building||stopping?'active':active&&!fresh?'warning':stale||configurationChanged?'warning':fresh&&s.state.runtimeState==='RUNNING'?'good':'muted';
  const runtimeNote=!known?'刷新后核对当前实例':stopping?'等待所属运行实例退出':active&&!fresh?'最后确认的装载信息仅供参考':stale?'当前装载未包含新的 PLC 修改':configurationChanged?'工程配置已变化，需重新准备实例':current?'已装载当前 PLC 程序':active?'装载关系待核对':'编译并准备后，再显式运行';
  let compileValue='尚无已确认编译产物',compileNote='编译并准备包含编译与装载',compileTone='muted';
  if(!known){compileValue='编译状态未确认';compileNote='等待工程服务状态';}
  else if(building){compileValue='编译与准备中';compileNote='不会自动运行 PLC';compileTone='active';}
  else if(active&&hash){compileValue=fresh?'已生成装载程序':'上次装载的编译产物';compileNote=fresh?'用于当前实例的 PLC 程序':'来自上次确认的装载信息';compileTone=stale?'warning':fresh?'good':'muted';}
  else if(missing){compileValue='运行依赖未齐备';compileNote='先检查运行环境';compileTone='warning';}
  const p=s?.project||{},hmiConfigured=!!(p.hmi||p.configuration?.hmiFile||p.hmiExecutable),sceneConfigured=!!(p.scene||p.configuration?.sceneFile);
  const fuxa=['fuxa-oip','fuxa-local'].includes(p.defaultMode);
  const hmiLink=hmiConfigured&&s?.links?.variables?.source==='hmi'?connectionLabel(s,'variables',known,now):{label:hmiConfigured?'通信未确认':'工程未配置画面',tone:'muted'};
  const ioLink=sceneConfigured?connectionLabel(s,'io',known,now):{label:'工程未配置场景',tone:'muted'};
  const tone=value=>value==='warn'?'warning':value;
  return {environment:env,missing,stale,configurationChanged,active,fresh,building,revision,
    nodes:[
      {id:'project',source:'plcdev',title:'工程程序',value:revision?'已保存 '+revision:known?'已保存工程':'工程状态未确认',note:'保存不会自动更新运行实例',tone:'muted',icon:'plc'},
      {id:'compiler',source:'compiler',title:'编译产物',value:compileValue,note:compileNote,tone:compileTone,icon:'plc'},
      {id:'runtime',source:'runtime',title:'OpenPLC Runtime',value:runtimeValue,note:runtimeNote,tone:runtimeTone,icon:'runtime'},
      {id:'hmi',source:'fuxa',title:fuxa?'FUXA':'HMI 画面',value:hmiLink.label,note:hmiConfigured?'画面通信与 PLC 执行分别核对':'可在工程中创建或关联画面',tone:tone(hmiLink.tone),icon:fuxa?'fuxa':'hmi'},
      {id:'oip',source:'oip',title:fuxa?'Open Industry Project':'仿真场景',value:ioLink.label,note:sceneConfigured?'打开场景不代表运行联动已接通':'可在工程中创建或关联场景',tone:tone(ioLink.tone),icon:fuxa?'oip':'scene'},
    ],
    wires:{compile:building?'active':current?'good':'muted',load:building?'active':stale||configurationChanged?'warning':current?'good':'muted',hmi:hmiLink.tone==='good'?'good':'muted',oip:ioLink.tone==='good'?'good':'muted'},
  };
}

export function currentRuntimeIssues(value,snapshot,projectRevision=null){
  if(!value||value.projectId!==snapshot?.project?.id||!Array.isArray(value.events))return {};
  const sid=snapshot?.session?.id||null;
  return runtimeEventIssues({...value,currentSessionId:sid,projectRevision:projectRevision||value.projectRevision});
}
