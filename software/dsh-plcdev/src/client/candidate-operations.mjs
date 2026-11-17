import {artifactSummary,candidateChanges} from './conversation-client.mjs';
import {nativeToolEvidence,nativeCheckSummary} from '../native-tool-evidence.mjs';

const tools=[['openplc','OpenPLC','PLC'],['fuxa','FUXA','HMI'],['oip','OIP','场景'],['project','工程关联','工程']];
const labels={queued:'等待处理',running:'正在修改',generating:'正在修改',failed:'修改未完成',awaiting_review:'待确认',kept:'已保留',compiled:'已保留 · 编译通过',compile_failed:'已保留 · 编译失败',discarded:'已撤销',superseded:'已有后续修改',no_change:'无净变化',unknown_outcome:'结果待核对',conflict:'版本冲突',keeping:'正在保留',discarding:'正在撤销',compiling:'正在编译'};
export function resultStatus(task){return task?.supersededBy?'已有后续修改':labels[task?.status]||'状态待核对';}

/** File attribution follows the supported project formats, not model prose. */
export function resultFileTool(path){
  if(typeof path!=='string')return 'project';
  const normalized=path.replaceAll('\\','/').toLowerCase();
  if(/\.(?:st|ld|fbd|sfc|il)$/.test(normalized)||/(?:^|\/)plc\//.test(normalized))return 'openplc';
  if(/\.fuxap$/.test(normalized)||/(?:^|\/)hmi\//.test(normalized))return 'fuxa';
  if(/(?:^|\/)oip\//.test(normalized)||/\.(?:tscn|scn)$/.test(normalized))return 'oip';
  return 'project';
}

/**
 * A candidate contains verified file differences and server-authored component
 * receipts. Native operation and check rows are shown only when published.
 * Count changed files; never call this number successful tool executions.
 */
export function candidateOperationGroups(task){
  const changes=candidateChanges(task);
  const components=Array.isArray(task?.candidate?.components)?task.candidate.components:[];
  return tools.flatMap(([tool,name,mark])=>{
    const evidence=components.filter(component=>component?.tool===tool).map(nativeToolEvidence);
    const operations=evidence.flatMap(item=>item.operations||[]),checks=evidence.flatMap(item=>item.checks||[]);
    const summaries=components.filter(component=>component?.tool===tool).map(component=>artifactSummary(component.summary)).filter(Boolean);
    if(!summaries.length&&tool==='fuxa'&&/^hmi-/.test(task?.workflow||'')){
      const summary=artifactSummary(task?.candidate?.summary);if(summary)summaries.push(summary);
    }
    const files=(changes||[]).filter(change=>resultFileTool(change.path)===tool).map(change=>({...change,kind:change.beforeSha256===null?'新增':change.afterSha256===null?'移除':'修改'}));
    if(!summaries.length&&!files.length&&!operations.length&&!checks.length)return [];
    return [{tool,name,mark,summaries,operations,checks,checkLabel:nativeCheckSummary(checks),files,countLabel:files.length?files.length+' 个文件变化':'结果摘要',filesKnown:changes!==null}];
  });
}
