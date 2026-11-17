/** Bound all model-facing context without dropping native schema semantics.
 * Large values become explicit references into the same immutable turn view.
 * The generic reader works for future tool catalogs, scenes and source files. */
import {createHash} from 'node:crypto';
export const CONTEXT_MAX_BYTES=24000;
const opaqueViews=new WeakMap();
const PAGE_DATA_BYTES=16000;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const escape=key=>String(key).replaceAll('~','~0').replaceAll('/','~1');
const childPath=(path,key)=>path+'/'+escape(key);
const kind=value=>Array.isArray(value)?'array':value===null?'null':typeof value;
const count=value=>typeof value==='string'?value.length:value&&typeof value==='object'?Object.keys(value).length:undefined;
function identity(value){
 const out={};
 if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of ['id','name','pouName','path','type','language'])
  if(typeof value[key]==='string'&&value[key].length<=160)out[key]=value[key];
 return out;
}
function publicPath(root,value,path,keyOnly=false){
 if(!keyOnly&&!path.startsWith('@')&&Buffer.byteLength(path,'utf8')<=512)return path;
 let refs=opaqueViews.get(root);if(!refs){refs=new Map();opaqueViews.set(root,refs);}
 const handle='@'+createHash('sha256').update((keyOnly?'key:':'value:')+path).digest('hex');
 refs.set(handle,value);return handle;
}
const checked=result=>{if(bytes(result)>CONTEXT_MAX_BYTES)throw Error('工程详情超出读取预算。');return result;};
function publicKey(root,key,path){return bytes(key)<=256?key:reference(key,path,root,false,true);}
function reference(value,path,root,index=true,keyOnly=false){
 const result={_plcdevRead:{path:publicPath(root,value,path,keyOnly),type:kind(value),...(count(value)!==undefined?{count:count(value)}:{}),bytes:bytes(value)}};
 if(index&&value&&typeof value==='object'){
  const entries=Object.entries(value),items=[];
  for(const [key,item] of entries){
   const pointer=childPath(path,key),row={key:publicKey(root,key,pointer),...identity(item),
    ...(typeof item?.path==='string'&&item.path.length<=160?{sourcePath:item.path}:{}),path:publicPath(root,item,pointer)};
   if(bytes(items)+bytes(row)>3200)break;
   items.push(row);
  }
  result.index=items;
  if(items.length<entries.length)result.indexNextOffset=items.length;
 }
 return result;
}
function replacements(root,arraysOnly,full){
 const found=[];
 function walk(value,path,parent,key){
  if(!value||typeof value!=='object'||value._plcdevRead)return;
  if(parent && (arraysOnly?Array.isArray(value):true)){
   const size=bytes(value);
   if(size>4000){const ref=reference(value,path,full);if(size-bytes(ref)>1000)found.push({parent,key,value,path,size,ref});}
  }
  for(const [k,v] of Object.entries(value)){
   if(typeof v==='string'&&bytes(v)>4000&&!arraysOnly)found.push({parent:value,key:k,value:v,path:childPath(path,k),size:bytes(v),ref:reference(v,childPath(path,k),full,false)});
   else walk(v,childPath(path,k),value,k);
  }
 }
 walk(root,'',null,null);return found.sort((a,b)=>b.size-a.size);
}
export function boundedProjectContext(full){
 if(bytes(full)<=CONTEXT_MAX_BYTES)return full;
 const value=JSON.parse(JSON.stringify(full));
 const read={tool:'plcdev_project_read',contextToken:full.contextToken,
  instructions:'这是工程摘要。_plcdevRead 是未展开数据的读取入口，不是原生工程内容。调用 plcdev_project_read，原样传入 path、contextToken，offset 从 0 开始；按 nextOffset 继续。先读取本轮要用的原生工具 schema、部件参数和目标源码，再提交计划。不要猜省略内容，不需要 grep/read/终端读取宿主保存的大结果。'};
 // Large catalogs are the usual cause; removing their duplication first keeps
 // small actual project/configuration/target data in the first answer.
 for(const arraysOnly of [true,false]){
  while(bytes({...value,contextRead:read})>CONTEXT_MAX_BYTES){
   const candidate=replacements(value,arraysOnly,full)[0];if(!candidate)break;
   candidate.parent[candidate.key]=candidate.ref;
  }
 }
 const result={ok:value.ok,projectId:value.projectId,projectName:value.projectName,
  sourceBasis:value.sourceBasis,projectRevision:value.projectRevision,contextToken:value.contextToken,
  workflowRoute:value.workflowRoute,contextRead:read,...value};
 if(bytes(result)>CONTEXT_MAX_BYTES)throw Error('工程摘要仍超过读取预算，请缩小工程上下文；未返回不完整数据。');
 return result;
}
export function contextValueAt(root,path){
 if(typeof path!=='string'||Buffer.byteLength(path,'utf8')>512)throw Error('工程详情路径无效。');
 if(path.startsWith('@')){
  const refs=opaqueViews.get(root);if(!refs?.has(path))throw Error('工程详情引用已过期或不属于本轮。');return refs.get(path);
 }
 if(path!==''&&!path.startsWith('/')||/~(?![01])/u.test(path))throw Error('工程详情路径无效。');
 let value=root;
 for(const encoded of path===''?[]:path.slice(1).split('/')){
  const key=encoded.replaceAll('~1','/').replaceAll('~0','~');
  if(!value||typeof value!=='object'||!Object.hasOwn(value,key)||Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(key))throw Error('该工程详情不存在，请使用上下文给出的路径。');
  value=value[key];
 }
 return value;
}
export function hasContextReference(value){
 if(!value||typeof value!=='object')return false;
 return Object.hasOwn(value,'_plcdevRead')||Object.values(value).some(hasContextReference);
}
export function readProjectContext(full,{path,offset}){
 if(!Number.isSafeInteger(offset)||offset<0)throw Error('工程详情分页位置无效。');
 const value=contextValueAt(full,path),type=kind(value);
 const base={ok:true,contextToken:full.contextToken,projectId:full.projectId,projectRevision:full.projectRevision,path,type};
 if(offset===0&&bytes(value)<=PAGE_DATA_BYTES)return checked({...base,complete:true,value});
 if(typeof value==='string'){
  if(offset>=value.length)throw Error('工程文本分页位置超出范围。');
  let end=Math.min(offset+2400,value.length);
  if(end<value.length&&/[\uD800-\uDBFF]/u.test(value[end-1]))end--;
  return checked({...base,complete:end===value.length,offset,total:value.length,text:value.slice(offset,end),
   nextOffset:end<value.length?end:null,
   instructions:'这是原始字符串的一段，offset 按 JavaScript 字符串位置计数。按 nextOffset 继续读取并按顺序连接 text，全部读取后才可用作源码；不得把片段当完整内容。'});
 }
 if(!value||typeof value!=='object')throw Error('该值没有后续页面。');
 const all=Object.entries(value);if(offset>=all.length)throw Error('工程详情分页位置超出范围。');
 const entries=[];
 for(const [key,item] of all.slice(offset)){
  const pointer=childPath(path,key),rowKey=publicKey(full,key,pointer);
  // Descendants of opaque handles get their own scoped handles as well.
  const entry=bytes(item)<=6000?{key:rowKey,value:item}:{key:rowKey,...reference(item,pointer,full)};
  if(entries.length&&bytes(entries)+bytes(entry)>PAGE_DATA_BYTES)break;
  if(bytes(entry)>PAGE_DATA_BYTES)throw Error('单项工程索引超出读取预算。');
  entries.push(entry);
 }
 const next=offset+entries.length,result={...base,complete:next===all.length,offset,total:all.length,entries,nextOffset:next<all.length?next:null,
  instructions:'entries 的 value 是原始完整值；_plcdevRead 表示该值尚未读取，继续按其 path 读取，不要猜测。对象按 key 还原，数组按数字 key 还原。'};
 return checked(result);
}
