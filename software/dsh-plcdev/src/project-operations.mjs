import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import path from 'node:path';

const ID=/^[a-z][a-z0-9-]{0,63}$/;
const REQUEST=/^[A-Za-z0-9_-]{1,100}$/;
const rec=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(status,code,error)=>({status,body:{ok:false,code,error}});
const text=(v,max)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const absolute=v=>text(v,2048)&&path.isAbsolute(v);
const folderName=v=>text(v,80)&&!/[<>:"/\\|?*]/.test(v)&&!['.','..'].includes(v)&&!/[. ]$/.test(v)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(v);
const fields=(v,required,optional=[])=>rec(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const has=(v,k)=>Object.hasOwn(v,k);
const canonical=v=>Array.isArray(v)?v.map(canonical):rec(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;

// Structural checks precede dispatch. The engineering backend applies its full
// domain validation, active-owner fence and configuration-revision check.
export function validateProjectOperation(v){
 const base=['requestId','projectId','sessionId','action'];
 if(!rec(v)||!REQUEST.test(v.requestId||'')||!ID.test(v.projectId||'')||!(v.sessionId===null||typeof v.sessionId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v.sessionId)))return false;
 if(v.action==='project-create')return fields(v,[...base,'name','parent','language','simulation'],['source'])&&folderName(v.name)&&absolute(v.parent)&&['ld','st'].includes(v.language)&&['none','oip','factoryio'].includes(v.simulation)&&(!has(v,'source')||absolute(v.source));
 if(v.action==='project-open')return fields(v,[...base,'manifestPath'])&&absolute(v.manifestPath);
 const revision=v.configurationRevision===null||typeof v.configurationRevision==='string'&&/^[0-9a-f]{16}$/.test(v.configurationRevision);
 if(v.action==='project-oip-configure')return fields(v,[...base,'configurationRevision','source'])&&revision&&absolute(v.source);
 if(v.action==='project-configure')return fields(v,[...base,'configurationRevision'],['hmiSource','oipSource','bindingsSource','bindings'])&&revision&&['hmiSource','oipSource','bindingsSource'].every(k=>!has(v,k)||absolute(v[k]))&&(!has(v,'bindings')||rec(v.bindings))&&(has(v,'bindings')!==has(v,'bindingsSource'));
 if(v.action==='project-interface-configure'){
  if(!fields(v,[...base,'configurationRevision','definition'],['hmiSource'])||!revision||has(v,'hmiSource')&&!absolute(v.hmiSource))return false;
  const d=v.definition;
  return fields(d,['schemaVersion','protocol','variables','operations'],['title','description'])&&d.schemaVersion===1&&d.protocol==='project-interface-v1'&&Array.isArray(d.variables)&&d.variables.length>0&&d.variables.length<=128&&Array.isArray(d.operations)&&d.operations.length<=128&&d.variables.every(x=>fields(x,['id','label','path','type','access','aiVisible'],['min','max','unit']))&&d.operations.every(x=>fields(x,['id','label','kind','variable','enabled','aiVisible'],['value','valueFrom','durationMs']));
 }
 return false;
}

// A durable intent is committed before dispatch. Unknown outcomes are never
// retried, including after process restart or a dropped response.
export function createProjectOperations({controllerFile,bridge}){
 const file=join(dirname(controllerFile),'dsh-project-operations.sqlite');
 function db(){mkdirSync(dirname(file),{recursive:true});const d=new DatabaseSync(file);d.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL)');return d;}
 function use(fn){const d=db();try{return fn(d);}finally{d.close();}}
 function rowResult(row,duplicate=false){return {status:200,body:{ok:true,requestId:row.request_id,projectId:row.project_id,action:row.action,state:row.state,...(row.result?{result:JSON.parse(row.result)}:{}),...(duplicate?{duplicate:true}:{})}};}
 return {
  async handle(method,raw,body){
   try{
    const url=new URL(raw,'http://127.0.0.1');
    if(url.pathname!=='/api/plcdev/project-operations'||url.hash)return fail(404,'not_found','未知工程操作接口。');
    if(method==='GET'){
     if([...url.searchParams.keys()].some(k=>k!=='requestId')||url.searchParams.getAll('requestId').length!==1||!REQUEST.test(url.searchParams.get('requestId')||''))return fail(400,'invalid_request','请求编号无效。');
     const row=use(d=>d.prepare('SELECT * FROM operations WHERE request_id=?').get(url.searchParams.get('requestId')));
     return row?rowResult(row):fail(404,'not_found','没有找到此请求记录。');
    }
    if(method!=='POST'||url.search||!validateProjectOperation(body)||Buffer.byteLength(JSON.stringify(body))>100000)return fail(400,'invalid_request','工程操作字段无效。');
    const copy=JSON.parse(JSON.stringify(body));
    const fingerprint=createHash('sha256').update(JSON.stringify(canonical(copy))).digest('hex');
    const inserted=use(d=>{d.exec('BEGIN IMMEDIATE');try{let r=d.prepare('SELECT * FROM operations WHERE request_id=?').get(copy.requestId);if(!r){d.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(copy.requestId,fingerprint,copy.projectId,copy.action,'unknown',null,new Date().toISOString());r=d.prepare('SELECT * FROM operations WHERE request_id=?').get(copy.requestId);d.exec('COMMIT');return {row:r,inserted:true};}d.exec('COMMIT');return {row:r,inserted:false};}catch(e){d.exec('ROLLBACK');throw e;}});
    if(inserted.row.fingerprint!==fingerprint)return fail(409,'request_conflict','请求编号已用于不同的工程操作。');
    if(!inserted.inserted)return rowResult(inserted.row,true);
    const {requestId,...rest}=copy;
    const result=await bridge.projectOperation({...rest,client:'dsh-catalog-'+randomUUID(),sequence:1,expires:Date.now()/1000+12});
    if(result?.status===200&&result.body?.ok===true&&result.body?.project?.id===result.body?.projectId&&ID.test(result.body.projectId||'')&&(!['project-configure','project-interface-configure','project-oip-configure'].includes(copy.action)||result.body.projectId===copy.projectId)){
      // Store the confirmed receipt, not the submitted definition or credentials.
      use(d=>d.prepare('UPDATE operations SET state=?,result=? WHERE request_id=?').run('confirmed',JSON.stringify(result.body),requestId));
    }
    return rowResult(use(d=>d.prepare('SELECT * FROM operations WHERE request_id=?').get(requestId)));
   }catch{return fail(503,'operation_unavailable','操作结果无法确认；保留原请求编号，重新读取回执和工程目录，不要重复提交。');}
  }
 };
}
