'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const TAGS=['count','target','countDisplay','targetDisplay','phase','quality','remainingDisplay','communication','runtime','commandResult','targetDraft','recoveryDraft'];
const ACTIONS={target:1,start:2,stop:3,fault:4,clearFault:5,reset:6,newBatch:7,recover:8};
const DEVICE='d_plcdev_batch',VIEW='v_plcdev_batch';
const tagId=name=>'plcdev_'+name;
const widgetId=w=>(w.type==='value'?'VAL_':w.type==='button'?'HXB_':w.type==='input'?'HXI_':'')+'PLCD_'+w.id;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function strictObject(value,keys,label){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid '+label);}
function integer(n,min,max,label){if(!Number.isInteger(n)||n<min||n>max)throw Error('Invalid '+label);}
function text(value,max,label){if(typeof value!=='string'||value.length>max||/[<>\x00-\x08]/.test(value))throw Error('Invalid '+label);}
function color(value){if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw Error('Invalid color');}
function validate(spec){
 strictObject(spec,['schemaVersion','title','width','height','theme','widgets'],'page');if(spec.schemaVersion!==1)throw Error('Unsupported page schema');text(spec.title,80,'title');if(!spec.title.trim())throw Error('Empty title');integer(spec.width,800,1600,'width');integer(spec.height,500,1000,'height');
 strictObject(spec.theme,['background','foreground','accent'],'theme');for(const key of ['background','foreground','accent'])color(spec.theme[key]);
 if(!Array.isArray(spec.widgets)||spec.widgets.length<8||spec.widgets.length>50)throw Error('Invalid widget count');
 const ids=new Set(),inputs=new Set(),actions=new Set(),bindings=new Set();
 for(const w of spec.widgets){strictObject(w,['id','type','label','x','y','width','height','fontSize','color','tag','action'],'widget');if(!/^[a-z][a-zA-Z0-9_-]{0,39}$/.test(w.id)||ids.has(w.id))throw Error('Invalid/duplicate widget id');ids.add(w.id);if(!['text','value','button','input'].includes(w.type))throw Error('Invalid widget type');text(w.label,100,'label');integer(w.x,0,spec.width,'x');integer(w.y,0,spec.height,'y');integer(w.width,40,1500,'widget width');integer(w.height,20,200,'widget height');if(w.x+w.width>spec.width||w.y+w.height>spec.height)throw Error('Widget outside canvas');if(w.fontSize!==undefined)integer(w.fontSize,12,56,'font size');if(w.color!==undefined)color(w.color);
  if(['value','input'].includes(w.type)){if(!TAGS.includes(w.tag))throw Error('Unknown tag');bindings.add(w.tag);}else if(w.tag!==undefined)throw Error('Only values and inputs bind tags');
  if(w.type==='input'){if(!['targetDraft','recoveryDraft'].includes(w.tag)||inputs.has(w.tag))throw Error('Invalid draft input');inputs.add(w.tag);}
  if(w.type==='button'){if(!Object.hasOwn(ACTIONS,w.action)||actions.has(w.action))throw Error('Unknown/duplicate action');actions.add(w.action);}else if(w.action!==undefined)throw Error('Only buttons have actions');
 }
 for(const tag of ['countDisplay','targetDisplay','phase','quality','communication','commandResult'])if(!bindings.has(tag))throw Error('Missing required binding '+tag);
 if(inputs.size!==2||actions.size!==8)throw Error('The batch page requires two draft inputs and eight commands');return spec;
}
function compile(spec,base,options={}){
 const activeTags=options.TAGS||TAGS,activeDevice=options.DEVICE||DEVICE,activeView=options.VIEW||VIEW,toTag=options.tagId||tagId;
 (options.validate||validate)(spec);const url=new URL(base);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('FUXA must use a plain loopback base URL');
 const tags={};for(const name of activeTags){const definition=options.tagDefinitions?.[name];tags[toTag(name)]={id:toTag(name),name,label:definition?.label||name,type:definition?.type||(['targetDraft','recoveryDraft'].includes(name)?'number':'string'),address:toTag(name),value:'',daq:{enabled:false,changed:false,interval:60},access:definition?.access||(['targetDraft','recoveryDraft'].includes(name)?'readwrite':'read'),init:definition?.init??(name==='targetDraft'?'3':'0')};}
 const device={id:activeDevice,name:options.title||'PLCdev 批次适配',enabled:true,type:'WebAPI',polling:250,property:{getTags:url.origin+'/plcdev/tags',postTags:true},tags};
 const items={},variables={},scripts=[],svg=[];
 svg.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml" width="${spec.width}" height="${spec.height}"><g><title>${esc(options.title||'PLCdev Batch')}</title>`);
 for(const original of spec.widgets){const w=original.type==='input'&&options.inputTag?{...original,tag:options.inputTag(original.tag)}:original;const id=widgetId(w),fg=w.color||spec.theme.foreground,fsiz=w.fontSize||(w.type==='value'?28:16),x=w.x,y=w.y,W=w.width,H=w.height;
  if(w.type==='text'){svg.push(`<text id="${id}" x="${x}" y="${y+Math.min(H,fsiz+3)}" fill="${fg}" font-size="${fsiz}" font-family="sans-serif" stroke-width="0">${esc(w.label)}</text>`);continue;}
  const property={variableId:w.tag?toTag(w.tag):undefined,variable:w.tag||'',variableSrc:w.tag?activeDevice:'',events:[],actions:[],ranges:[],permission:0,permissionRoles:{show:[],enabled:[]}};
  if(w.tag)variables[toTag(w.tag)]={id:toTag(w.tag),name:w.tag,source:activeDevice,value:'',error:0};
  let type,label;
  if(w.type==='value'){
   type='svg-ext-value';label='Value';svg.push(`<text id="lbl_${id}" x="${x}" y="${y+16}" fill="${spec.theme.foreground}" font-size="13" font-family="sans-serif" stroke-width="0">${esc(w.label)}</text><g id="${id}" type="${type}" fill="${fg}" stroke-width="0" font-size="${fsiz}" font-family="sans-serif" text-anchor="start"><text id="value_${id}" x="${x}" y="${y+Math.min(H-2,fsiz+26)}">—</text></g>`);
  }else if(w.type==='button'){
   type='svg-ext-html_button';label='HtmlButton';property.text=w.label;const scriptId='s_plcdev_'+w.action;
   if(!scripts.some(s=>s.id===scriptId))scripts.push({id:scriptId,name:'PLCdev_'+w.action,mode:'CLIENT',parameters:[],code:'return await window.PLCdevHmi.command('+JSON.stringify(w.action)+');',permission:0,permissionRoles:{enabled:[]}});
   property.events=[{type:'click',action:'onRunScript',actparam:scriptId,actoptions:{params:[]}}];
   const bg=w.color||spec.theme.accent;
   svg.push(`<g id="${id}" type="${type}" fill="${bg}" font-size="${fsiz}" font-family="sans-serif" text-anchor="middle"><rect id="rect_${id}" x="${x}" y="${y}" width="${W}" height="${H}" rx="5" stroke-width="0" fill="${bg}"/><foreignObject id="H-HXB_${id}" x="${x}" y="${y}" width="${W}" height="${H}"><button xmlns="http://www.w3.org/1999/xhtml" id="B-HXB_${id}" class="md-btn md-btn-raised" style="width:100%;height:100%;border:0;border-radius:5px;background:${bg};color:#ffffff;font-size:${fsiz}px">${esc(w.label)}</button></foreignObject></g>`);
  }else{
   type='svg-ext-html_input';label='HtmlInput';const input=options.tagDefinitions?.[w.tag]?.input||{min:0,max:32767,step:1};property.options={updated:true,numeric:true,min:input.min,max:input.max,step:input.step,type:'number',readonly:false};
   svg.push(`<text id="lbl_${id}" x="${x}" y="${y+16}" fill="${fg}" font-size="13" font-family="sans-serif" stroke-width="0">${esc(w.label)}</text><g id="${id}" type="${type}" fill="#ffffff" font-size="${fsiz}" font-family="sans-serif"><rect id="rect_${id}" x="${x}" y="${y+24}" width="${W}" height="${Math.max(24,H-24)}" fill="#ffffff" stroke="#cbd5e1"/><foreignObject id="H-HXI_${id}" x="${x}" y="${y+24}" width="${W}" height="${Math.max(24,H-24)}"><input xmlns="http://www.w3.org/1999/xhtml" id="I-HXI_${id}" type="number" min="${input.min}" max="${input.max}" step="${input.step}" style="box-sizing:border-box;width:100%;height:100%;font-size:${fsiz}px;border:1px solid #cbd5e1;padding:5px" value="${options.tagDefinitions?.[w.tag]?.init??(w.tag==='targetDraft'?3:0)}"/></foreignObject></g>`);
  }
  items[id]={id,type,label,name:w.label,property,hide:false,lock:false};
 }
 svg.push('</g></svg>');
 return {version:'1.01',name:spec.title,server:{id:'0',name:'FUXA Server',type:'FuxaServer',property:{},tags:{}},devices:{[activeDevice]:device},hmi:{views:[{id:activeView,name:options.title||'PLCdevBatch',type:'svg',profile:{width:spec.width,height:spec.height,bkcolor:spec.theme.background,margin:12,align:'topCenter',viewRenderDelay:0},items,variables,svgcontent:svg.join('\n'),property:{events:[]}}],layout:{start:activeView,autoresize:true,showdev:true,zoom:'autoresize',inputdialog:'false',hidenavigation:false,show_connection_error:true,navigation:{mode:'over',type:'inline',items:[{text:spec.title,view:activeView,link:'',icon:'dashboard',permission:0}]},header:{title:spec.title,items:[],height:42}}},scripts,clientAccess:{scriptSystemFunctions:[]},charts:[],graphs:[],alarms:[],recipes:[],notifications:[],reports:[],texts:[],languages:{},plugin:[],mapsLocations:[]};
}
function reference(){
 const widgets=[{id:'title',type:'text',label:'输送带批次计数',x:30,y:16,width:1000,height:42,fontSize:28}];
 const defs=[['countDisplay','本批计数'],['targetDisplay','PLC 已接受目标'],['phase','工艺阶段'],['quality','数据质量'],['communication','设备通信'],['runtime','PLC 状态'],['remainingDisplay','启动延时'],['commandResult','命令结果']];
 defs.forEach(([tag,label],i)=>widgets.push({id:tag,type:'value',tag,label,x:30+(i%2)*540,y:80+Math.floor(i/2)*84,width:510,height:70,fontSize:i<2?32:18}));
 widgets.push({id:'targetInput',type:'input',tag:'targetDraft',label:'目标编辑值（回车确认）',x:30,y:430,width:230,height:70},{id:'recoveryInput',type:'input',tag:'recoveryDraft',label:'人工核对数量（回车确认）',x:300,y:430,width:230,height:70});
 Object.keys(ACTIONS).forEach((action,i)=>widgets.push({id:'cmd_'+action,type:'button',action,label:['应用目标','启动／继续','过程停止','注入故障','解除故障','故障复位','新批次','确认数量恢复'][i],x:30+(i%4)*270,y:520+Math.floor(i/4)*62,width:240,height:44,fontSize:16}));
 widgets.push({id:'rule',type:'text',label:'输入后按回车，再应用；断线后核对数量，恢复后另行启动。',x:30,y:650,width:1030,height:28,fontSize:14});
 return {schemaVersion:1,title:'PLCdev 批次计数 · 手工联调参考',width:1120,height:710,theme:{background:'#f4f7fa',foreground:'#183042',accent:'#187a73'},widgets};
}
module.exports={TAGS,ACTIONS,DEVICE,VIEW,tagId,widgetId,validate,compile,reference};
if(require.main===module){const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];const spec=args.includes('--reference')?reference():JSON.parse(fs.readFileSync(value('--spec'),'utf8'));const output=path.resolve(value('--output'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(compile(spec,value('--base')),null,2));console.log(JSON.stringify({ok:true,output,source:args.includes('--reference')?'handwritten-reference':'supplied-spec',widgets:spec.widgets.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')}));}
