import {resultFileTool} from './candidate-operations.mjs';

// Bound untrusted file data before passing it to the original, read-only renderer.
export function parseLadderSource(text){
 if(typeof text!=='string'||text.length>524288)return null;
 const end=text.match(/\b(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i);
 if(!end||end.index===undefined)return null;
 const body=text.slice(0,end.index),start=body.lastIndexOf('END_VAR');
 if(start<0)return null;
 try{
  let graph=JSON.parse(body.slice(start+7).trim());if(typeof graph==='string')graph=JSON.parse(graph);
  if(!Array.isArray(graph?.rungs)||graph.rungs.length>128)return null;
  let total=0;
  for(const rung of graph.rungs){
   if(!rung||!Array.isArray(rung.nodes)||!Array.isArray(rung.edges)||(total+=rung.nodes.length+rung.edges.length)>6000)return null;
   const ids=new Set();
   for(const node of rung.nodes){
    if(!node||typeof node.id!=='string'||!node.id||ids.has(node.id)||!node.position||!Number.isFinite(node.position.x)||!Number.isFinite(node.position.y))return null;
    ids.add(node.id);
   }
   for(const edge of rung.edges)if(!edge||typeof edge.id!=='string'||!ids.has(edge.source)||!ids.has(edge.target))return null;
  }
  return graph;
 }catch{return null;}
}
export function graphicalPreview(file){
 if(!file||file.kind!=='ld'||typeof file.path!=='string'||!file.path.toLowerCase().endsWith('.ld')||file.path.includes('..')||/^[\\/]|^[A-Za-z]:|[\u0000-\u001f]/.test(file.path))return {error:'这不是可预览的梯形图文件。'};
 if(file.truncated)return {error:'文件超出预览范围，请在 OpenPLC 查看。'};
 if(file.beforeUnavailable)return {error:'旧基线不可用，无法显示前后对比。'};
 const absentBefore=file.beforeSha256===null,absentAfter=file.afterSha256===null;
 const before=typeof file.beforeText==='string'?file.beforeText:null,after=typeof file.afterText==='string'?file.afterText:null;
 if(!(absentBefore&&before==='')&&!parseLadderSource(before)||!(absentAfter&&after==='')&&!parseLadderSource(after))
  return {error:'无法解析这份梯形图，请在 OpenPLC 查看。'};
 return {before:before||'',after:after||'',path:file.path};
}
export function previewTool(file){
 if(file?.kind==='ld'||file?.kind==='st')return 'openplc';
 const tool=resultFileTool(file?.path);
 return tool==='project'?null:tool;
}
export function previewFiles(value,tool){
 return (value?.files||[]).filter(file=>!tool||previewTool(file)===tool);
}

