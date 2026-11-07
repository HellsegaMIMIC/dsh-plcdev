'use strict';
// A project's declared interface is the only source of HMI/AI capabilities.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const legacy=require('./native-project.cjs');
const ID=/^[A-Za-z_][A-Za-z0-9_]{0,39}$/,BAD=new Set(['__proto__','prototype','constructor']);
const DEVICE='d_plcdev_project',VIEW='v_plcdev_project',FLOAT32=3.4028234663852886e38;
const copy=x=>JSON.parse(JSON.stringify(x));
function object(x,allowed,required,label){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(x,k)))throw Error('Invalid '+label);}
function text(x,max,label,empty=false){if(typeof x!=='string'||(!empty&&!x.trim())||[...x].length>max||/[<>\x00-\x1f]/.test(x))throw Error('Invalid '+label);}
function id(x){if(typeof x!=='string'||!ID.test(x)||BAD.has(x.toLowerCase()))throw Error('Invalid interface id');}
function typed(variable,value){
 if(variable.type==='BOOL'){if(typeof value!=='boolean')throw Error('BOOL value required');return value;}
 if(typeof value!=='number'||!Number.isFinite(value)||!Number.isFinite(Math.fround(value)))throw Error('Finite IEC value required');
 if(variable.type==='INT'&&(!Number.isInteger(value)||value< -32768||value>32767))throw Error('INT value outside range');
 if(variable.min!==undefined&&value<variable.min||variable.max!==undefined&&value>variable.max)throw Error('Value outside declared range');
 return value;
}
function validateContract(raw){
 object(raw,['schemaVersion','protocol','title','description','variables','operations'],['schemaVersion','protocol','variables','operations'],'interface');
 if(raw.schemaVersion!==1||raw.protocol!=='project-interface-v1')throw Error('Unsupported project interface');
 if(raw.title!==undefined)text(raw.title,80,'interface title');if(raw.description!==undefined)text(raw.description,500,'interface description',true);
 if(!Array.isArray(raw.variables)||!raw.variables.length||raw.variables.length>128||!Array.isArray(raw.operations)||raw.operations.length>128)throw Error('Interface collection size');
 const variables=new Map(),paths=new Set(),variableIds=new Set();
 for(const v of raw.variables){
  object(v,['id','label','path','type','access','aiVisible','min','max','unit'],['id','label','path','type','access','aiVisible'],'variable');id(v.id);text(v.label,80,'variable label');
  if(variableIds.has(v.id.toLowerCase()))throw Error('Duplicate variable id');variableIds.add(v.id.toLowerCase());
  if(typeof v.path!=='string'||v.path.length>200||!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(v.path)||/[^\x00-\x7f]/.test(v.path)||paths.has(v.path.toUpperCase()))throw Error('Invalid/duplicate PLC path');
  if(!['BOOL','INT','REAL'].includes(v.type)||!['read','readwrite'].includes(v.access)||typeof v.aiVisible!=='boolean')throw Error('Invalid variable type or access');
  if(v.unit!==undefined)text(v.unit,24,'unit',true);
  if((v.min===undefined)!==(v.max===undefined))throw Error('Numeric limits must be paired');
  if(v.type==='BOOL'&&(v.min!==undefined||v.max!==undefined))throw Error('BOOL cannot have numeric limits');
  for(const k of ['min','max'])if(v[k]!==undefined)typed({...v,min:undefined,max:undefined},v[k]);
  if(v.min!==undefined&&v.max!==undefined&&v.min>v.max)throw Error('Invalid variable limits');
  if(v.access==='readwrite'&&v.type!=='BOOL'&&(v.min===undefined||v.max===undefined))throw Error('Writable numeric variables need explicit limits');
  variables.set(v.id,v);paths.add(v.path.toUpperCase());
 }
 const ids=new Set();for(const op of raw.operations){
  object(op,['id','label','kind','variable','value','valueFrom','durationMs','enabled','aiVisible'],['id','label','kind','variable','enabled','aiVisible'],'operation');id(op.id);text(op.label,80,'operation label');
  if(ids.has(op.id.toLowerCase()))throw Error('Duplicate operation id');ids.add(op.id.toLowerCase());
  const v=variables.get(op.variable);if(!v||v.access!=='readwrite')throw Error('Operation needs declared writable variable');
  if(typeof op.enabled!=='boolean'||typeof op.aiVisible!=='boolean'||!['write','pulse'].includes(op.kind))throw Error('Invalid operation permissions');
  if(op.kind==='pulse'){
   if(v.type!=='BOOL'||op.value!==true||op.valueFrom!==undefined||!Number.isInteger(op.durationMs)||op.durationMs<100||op.durationMs>2000)throw Error('Pulse needs BOOL true and 100–2000 ms duration');
  }else{
   if(op.durationMs!==undefined||Object.hasOwn(op,'value')===Object.hasOwn(op,'valueFrom'))throw Error('Write needs exactly one value source');
   if(op.valueFrom!==undefined&&op.valueFrom!=='input')throw Error('Unknown value source');
   if(Object.hasOwn(op,'value'))typed(v,op.value);
  }
 }
 return copy(raw);
}
function publicContract(raw){const c=validateContract(raw),visible=new Set(c.variables.filter(v=>v.aiVisible).map(v=>v.id));return {schemaVersion:1,protocol:c.protocol,title:c.title||'工程画面',...(c.description?{description:c.description}:{}),variables:c.variables.filter(v=>visible.has(v.id)).map(({id,label,type,access,min,max,unit})=>({id,label,type,access,...(min===undefined?{}:{min}),...(max===undefined?{}:{max}),...(unit===undefined?{}:{unit})})),operations:c.operations.filter(o=>o.enabled&&o.aiVisible&&visible.has(o.variable)).map(({id,label,kind,variable,valueFrom})=>({id,label,kind,variable,...(valueFrom?{valueFrom}:{})}))};}
function schema(raw){
 const c=publicContract(raw),s=JSON.parse(fs.readFileSync(path.join(__dirname,'model-schema.json'),'utf8'));
 s.properties.widgets.minItems=1;const p=s.properties.widgets.items.properties;p.tag=c.variables.length?{enum:c.variables.map(v=>v.id)}:{not:{}};p.action=c.operations.length?{enum:c.operations.map(o=>o.id)}:{not:{}};
 const inputIds=[...new Set(c.operations.filter(o=>o.valueFrom==='input').map(o=>o.variable))];
 s.properties.widgets.items.allOf=[{if:{properties:{type:{const:'input'}}},then:{required:['tag'],properties:{tag:inputIds.length?{enum:inputIds}:{not:{}}}}},{if:{properties:{type:{const:'value'}}},then:{required:['tag']}},{if:{properties:{type:{const:'button'}}},then:{required:['action']}}];return s;
}
function modelRequestSystem(raw){return '你是 PLCdev 的工业 HMI 页面设计助手。只输出严格符合 JSON Schema 的 JSON，不输出代码、HTML、SVG、URL 或解释。\n控件为 text/value/button/input。value.tag 引用工程变量；input.tag 引用允许输入操作的变量，只编辑本机草稿，按回车确认后需点击声明操作按钮才提交。button.action 只能引用已授权操作。变量值与草稿必须区分。显示标签、单位、范围，不创造变量或操作。按需选择控件，不要求固定工艺或全部变量出现。\n模型没有 PLC 操作权限。不要承诺硬件安全、持续运行或已验证。布局完整落在画布内，不重叠。所有文字不得含 < >。\n工程可用接口（只有显示元数据和授权能力，不含 PLC 路径、地址或凭据）：\n'+JSON.stringify(publicContract(raw))+'\nJSON Schema:\n'+JSON.stringify(schema(raw));}
const draftKey=id=>'$'+id;
const tagId=name=>name.startsWith('$')?'plcdev_draft_'+name.slice(1):'plcdev_var_'+name;
function forContract(raw){
 const contract=validateContract(raw),publicView=publicContract(contract),variables=new Map(contract.variables.map(v=>[v.id,v]));
 const allowedOperations=contract.operations.filter(o=>o.enabled),operations=new Map(allowedOperations.map(o=>[o.id,o]));
 const draftVariables=[...new Set(allowedOperations.filter(o=>o.valueFrom==='input').map(o=>o.variable))];
 const visible=new Set(publicView.variables.map(v=>v.id)),aiOperations=new Set(publicView.operations.map(o=>o.id));
 const TAGS=[...variables.keys(),...draftVariables.map(draftKey)],ACTIONS=Object.fromEntries(allowedOperations.map(o=>[o.id,o.id]));
 function validate(spec,{ai=true}={}){
  object(spec,['schemaVersion','title','width','height','theme','widgets'],['schemaVersion','title','width','height','theme','widgets'],'page');
  if(spec.schemaVersion!==1)throw Error('Unsupported page schema');text(spec.title,80,'title');
  if(!Number.isInteger(spec.width)||spec.width<800||spec.width>1600||!Number.isInteger(spec.height)||spec.height<500||spec.height>1000)throw Error('Invalid canvas');
  object(spec.theme,['background','foreground','accent'],['background','foreground','accent'],'theme');for(const v of Object.values(spec.theme))if(typeof v!=='string'||!/^#[a-f0-9]{6}$/i.test(v))throw Error('Invalid color');
  if(!Array.isArray(spec.widgets)||!spec.widgets.length||spec.widgets.length>50)throw Error('Invalid widget count');
  const ids=new Set();for(const w of spec.widgets){
   object(w,['id','type','label','x','y','width','height','fontSize','color','tag','action'],['id','type','label','x','y','width','height'],'widget');
   if(typeof w.id!=='string'||!/^[a-z][a-zA-Z0-9_-]{0,39}$/.test(w.id)||ids.has(w.id))throw Error('Invalid widget id');ids.add(w.id);
   if(!['text','value','input','button'].includes(w.type)||typeof w.label!=='string'||w.label.length>100||/[<>\x00-\x1f]/.test(w.label))throw Error('Invalid widget');
   for(const k of ['x','y','width','height'])if(!Number.isInteger(w[k]))throw Error('Invalid widget geometry');
   if(w.x<0||w.y<0||w.width<40||w.width>1500||w.height<20||w.height>200||w.x+w.width>spec.width||w.y+w.height>spec.height)throw Error('Widget outside canvas');
   if(w.fontSize!==undefined&&(!Number.isInteger(w.fontSize)||w.fontSize<12||w.fontSize>56))throw Error('Invalid font size');
   if(w.color!==undefined&&!/^#[a-f0-9]{6}$/i.test(w.color))throw Error('Invalid color');
   if(['value','input'].includes(w.type)){if(!variables.has(w.tag)||(ai&&!visible.has(w.tag)))throw Error('Unknown or AI-hidden variable');}
   else if(w.tag!==undefined)throw Error('Only values/inputs may bind variables');
   if(w.type==='input'&&(!draftVariables.includes(w.tag)||(ai&&!publicView.operations.some(o=>o.variable===w.tag&&o.valueFrom==='input'))))throw Error('Input is not authorized');
   if(w.type==='button'){if(!operations.has(w.action)||(ai&&!aiOperations.has(w.action)))throw Error('Operation disabled or unavailable to AI');}
   else if(w.action!==undefined)throw Error('Only buttons may invoke operations');
  }return spec;
 }
 function draftValue(key,value){const ident=key.startsWith('$')?key.slice(1):key;if(!draftVariables.includes(ident))throw Error('Draft write is not authorized');const variable=variables.get(ident);if(variable.type==='BOOL'){if(value==='true'||value===1||value==='1')value=true;else if(value==='false'||value===0||value==='0')value=false;}else if(typeof value==='string'&&value.trim()!=='')value=Number(value);return typed(variable,value);}
 const drafts=Object.fromEntries(draftVariables.map(ident=>{const v=variables.get(ident);return[draftKey(ident),v.type==='BOOL'?false:Math.max(v.min,Math.min(v.max,0))];}));
 function operationValue(action,value,currentDrafts){const op=operations.get(action);if(!op)throw Error('Operation disabled or unknown');const variable=variables.get(op.variable);if(op.valueFrom==='input'){const selected=value===undefined?currentDrafts[draftKey(op.variable)]:value;return typed(variable,selected);}if(value!==undefined&&value!==op.value)throw Error('Fixed operation value cannot be changed');return op.value;}
 function compile(spec,base,options={}){return legacy.compile(spec,base,{validate:s=>validate(s,options),TAGS,DEVICE,VIEW,tagId,inputTag:draftKey,title:contract.title||'PLCdev Project',tagDefinitions:Object.fromEntries(TAGS.map(key=>{const isDraft=key.startsWith('$'),v=variables.get(isDraft?key.slice(1):key);return[key,{label:v.label+(isDraft?' · 编辑值':''),type:isDraft?'number':'string',access:isDraft?'readwrite':'read',init:isDraft?String(Number(drafts[key])):'',...(isDraft?{input:{min:v.type==='BOOL'?0:v.min,max:v.type==='BOOL'?1:v.max,step:v.type==='REAL'?'any':1}}:{})}];}))});}
 function reference(){const widgets=[{id:'title',type:'text',label:contract.title||'工程变量与操作',x:30,y:20,width:1120,height:42,fontSize:28}];let y=90;for(const [i,v]of publicView.variables.slice(0,12).entries()){widgets.push({id:'value_'+i,type:'value',tag:v.id,label:(v.label+(v.unit?' / '+v.unit:'')).slice(0,100),x:30+(i%3)*390,y:y+Math.floor(i/3)*76,width:360,height:66});}y+=Math.ceil(Math.min(12,publicView.variables.length)/3)*76+20;const inputs=[...new Set(publicView.operations.filter(o=>o.valueFrom==='input').map(o=>o.variable))].slice(0,8);for(const [i,ident]of inputs.entries())widgets.push({id:'input_'+i,type:'input',tag:ident,label:variables.get(ident).label+' · 编辑值（回车确认）',x:30+(i%3)*390,y:y+Math.floor(i/3)*76,width:360,height:66});y+=Math.ceil(inputs.length/3)*76+20;for(const [i,op]of publicView.operations.slice(0,12).entries())widgets.push({id:'action_'+i,type:'button',action:op.id,label:op.label,x:30+(i%4)*290,y:y+Math.floor(i/4)*60,width:260,height:44});y+=Math.ceil(Math.min(12,publicView.operations.length)/4)*60+20;widgets.push({id:'notice',type:'text',label:'输入只改变编辑值；点击对应操作后核对 PLC 应答。数据失效时不能操作。',x:30,y,width:1140,height:30,fontSize:14});return{schemaVersion:1,title:contract.title||'PLCdev 工程接口',width:1220,height:Math.max(500,y+50),theme:{background:'#f4f7fa',foreground:'#183042',accent:'#187a73'},widgets};}
 return {contract,publicContract:publicView,TAGS,ACTIONS,DEVICE,VIEW,tagId,widgetId:legacy.widgetId,validate,compile,reference,drafts,draftVariables,variables,operations,draftValue,operationValue};
}
function safeSvg(svg){
 if(typeof svg!=='string'||svg.length>8*1024*1024||/<!|<\?/.test(svg))throw Error('Unsafe SVG declaration');
 const names=new Set('svg g title desc text tspan rect path line polyline polygon circle ellipse defs linearGradient radialGradient stop clipPath mask use image foreignObject button input div span br'.split(' '));
 const decode=s=>s.replace(/&#(?:x([\da-f]+)|(\d+));/gi,(_,h,d)=>String.fromCodePoint(parseInt(h||d,h?16:10))).replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
 for(const m of svg.matchAll(/<\/?([^\s/>]+)([^>]*)>/g)){let tag=m[1].split(':').at(-1);if(['button','input','div','span','br'].includes(tag.toLowerCase()))tag=tag.toLowerCase();if(!names.has(tag))throw Error('Unsafe SVG element');let attrs=m[2].replace(/\/\s*$/,'');const matcher=/([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;let rest=attrs;for(const a of attrs.matchAll(matcher)){rest=rest.replace(a[0],'');const key=a[1].split(':').at(-1).toLowerCase(),value=decode(a[2].slice(1,-1));if(key.startsWith('on')||['src','srcdoc','formaction'].includes(key)||/[\\]/.test(value))throw Error('Unsafe SVG attribute');if(key==='href'&&!value.startsWith('#')&&!(tag==='image'&&/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value)))throw Error('External SVG resource');if(/@import|expression\s*\(|javascript\s*:|behavior\s*:/i.test(value))throw Error('Unsafe SVG CSS');for(const ref of value.matchAll(/url\s*\(\s*([^)]*)\)/gi))if(!ref[1].trim().replace(/^['"]|['"]$/g,'').startsWith('#'))throw Error('External SVG URL');}if(rest.trim())throw Error('Malformed SVG attributes');}
}
function validateProject(project,raw){
 const api=forContract(raw),device=project?.devices?.[DEVICE];
 function noCredentials(value){if(Array.isArray(value))value.forEach(noCredentials);else if(value&&typeof value==='object')for(const [key,x]of Object.entries(value)){if(x&&['password','apikey','encryptedapikey','token','authorization','cookie','headers','privatekey','secret'].includes(key.toLowerCase().replace(/[_-]/g,'')))throw Error('Credential fields are not project configuration');noCredentials(x);}}
 noCredentials(project);if(Object.keys(project?.server?.tags||{}).length||Object.keys(project?.server?.property||{}).length||JSON.stringify(project?.clientAccess?.scriptSystemFunctions||[])!=='[]')throw Error('Undeclared native server capability');if(project?.version!=='1.01'||!device||Object.keys(project.devices).length!==1||device.id!==DEVICE||device.type!=='WebAPI'||device.enabled!==true)throw Error('Project interface device mismatch');
 const endpoint=device.property?.getTags;if(endpoint!=='/plcdev/tags'){let u;try{u=new URL(endpoint);}catch{}if(!u||u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/plcdev/tags'||u.search||u.hash)throw Error('Invalid project endpoint');}
 object(device.property,['getTags','postTags'],['getTags','postTags'],'device property');if(device.property.postTags!==true)throw Error('Draft interface missing');
 const tags=new Map(api.TAGS.map(key=>[tagId(key),key]));if(!device.tags||!Object.keys(device.tags).length)throw Error('Missing interface tags');
 for(const [ident,t]of Object.entries(device.tags)){const key=tags.get(ident);if(!key||t.id!==ident||t.address!==ident||t.name!==key||t.access!==(key.startsWith('$')?'readwrite':'read')||t.type!==(key.startsWith('$')?'number':'string')||t.daq?.enabled!==false)throw Error('Undeclared tag or write access');}
 const scripts=new Set();for(const s of project.scripts||[]){object(s,['id','name','mode','parameters','code','permission','permissionRoles'],['id','mode','parameters','code'],'script');const action=s.id?.replace(/^s_plcdev_/,'');if(!api.operations.has(action)||s.id!=='s_plcdev_'+action||s.mode!=='CLIENT'||JSON.stringify(s.parameters)!=='[]'||s.code!=='return await window.PLCdevHmi.command('+JSON.stringify(action)+');')throw Error('Undeclared operation script');if(scripts.has(s.id))throw Error('Duplicate operation script');scripts.add(s.id);}
 function walk(value){if(Array.isArray(value)){for(const x of value)walk(x);}else if(value&&typeof value==='object')for(const [key,x]of Object.entries(value)){const normalized=key.toLowerCase().replace(/[_-]/g,'');if(x&&['password','apikey','encryptedapikey','token','authorization','cookie','headers','expression','javascript','privatekey','secret'].includes(normalized))throw Error('Unapproved executable or credential field');if(key==='code'||key==='script'){if(x)throw Error('Unexpected code field');}if(key==='events'){if(!Array.isArray(x))throw Error('Invalid events');for(const e of x){object(e,['type','action','actparam','actoptions'],['type','action','actparam'],'event');if(e.type!=='click'||e.action!=='onRunScript'||!scripts.has(e.actparam)||JSON.stringify(e.actoptions||{params:[]})!==JSON.stringify({params:[]}))throw Error('Undeclared event');}}if(['variableId','variableId2'].includes(key)&&x&&(!tags.has(x)||!Object.hasOwn(device.tags,x)))throw Error('Unknown variable binding');if(['variableSrc','source'].includes(key)&&x&&x!==DEVICE)throw Error('External variable source');if(['href','url','link','address'].includes(key)&&x)throw Error('External visual address');walk(x);}}
 if(!Array.isArray(project.hmi?.views)||!project.hmi.views.length)throw Error('Missing native views');for(const view of project.hmi.views){safeSvg(view.svgcontent);walk(view);for(const [ident,v]of Object.entries(view.variables||{})){if(!Object.hasOwn(device.tags,ident)||v.id!==ident||v.source!==DEVICE)throw Error('Incomplete view variable binding');}for(const item of Object.values(view.items||{})){if(item.type==='svg-ext-html_input'){const key=tags.get(item.property?.variableId);if(!key?.startsWith('$'))throw Error('Input may only edit a declared draft');}}}walk(project.hmi.layout||{});
 for(const key of ['charts','graphs','alarms','recipes','notifications','reports','plugin','mapsLocations'])if(Array.isArray(project[key])?project[key].length:project[key]&&Object.keys(project[key]).length)throw Error('Unsupported external native feature');
 return true;
}
module.exports={validateContract,publicContract,schema,modelRequestSystem,forContract,validateProject,typed,DEVICE,VIEW};
if(require.main===module){try{const args=process.argv.slice(2),value=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined,file=value('--contract');const contract=validateContract(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));if(args[0]==='system')process.stdout.write(modelRequestSystem(contract));else if(args[0]==='validate-project'){validateProject(JSON.parse(fs.readFileSync(value('--project'),'utf8').replace(/^\uFEFF/,'')),contract);console.log(JSON.stringify({ok:true}));}else if(args[0]==='reference'){const api=forContract(contract),project=api.compile(api.reference(),value('--base')||'http://127.0.0.1:18810/');project.devices[DEVICE].property.getTags='/plcdev/tags';validateProject(project,contract);const output=value('--output');fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(project,null,2)+'\n');console.log(JSON.stringify({ok:true,source:'deterministic-reference',output}));}else throw Error('Unknown interface command');}catch(e){console.error(e.message);process.exitCode=1;}}
