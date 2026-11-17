import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateOperationGroups,resultFileTool,resultStatus} from '../src/client/candidate-operations.mjs';
import {reviewStages} from '../src/client/conversation-client.mjs';
import {previewUrl,editorOpenRequest} from '../src/client/result-flow.mjs';
import {oipResultState,oipPreviewState,readOipResourceObservation} from '../src/client/oip-result-state.mjs';

const source='a'.repeat(64),changed='b'.repeat(64),projectId='user-'+'c'.repeat(32),taskId='task-'+'d'.repeat(32);
const task={projectId,taskId,workflow:'project-edit-v1',status:'awaiting_review',candidate:{candidateDigest:changed,components:[{tool:'openplc',summary:'OpenPLC 共享编辑：create_pou、update_variable、write_ladder'},{tool:'fuxa',summary:'修改画面文字：main-view'}],changes:[{path:'plc/pous/programs/main.ld',beforeSha256:source,afterSha256:changed},{path:'plc/pous/functions/Scale.st',beforeSha256:null,afterSha256:changed},{path:'hmi/main.fuxap',beforeSha256:source,afterSha256:changed},{path:'interface.json',beforeSha256:source,afterSha256:changed}]}};

test('tool groups count verified changed files, never infer tool-call counts from prose',()=>{
 const rows=candidateOperationGroups(task);
 assert.deepEqual(rows.map(row=>row.tool),['openplc','fuxa','project']);
 assert.equal(rows[0].countLabel,'2 个文件变化');assert.equal(rows[0].summaries[0],task.candidate.components[0].summary);
 assert.equal(rows[0].files[1].kind,'新增');assert.equal(rows[2].files[0].path,'interface.json');
 assert.equal(rows.some(row=>row.tool==='oip'),false);
 assert.equal(resultFileTool('oip/scene.json'),'oip');assert.equal(resultFileTool('integration/r1/hmi/main.fuxap'),'fuxa');
});
test('missing or malformed file evidence cannot claim an empty diff or successful edit count',()=>{
 const incomplete={...task,candidate:{...task.candidate,changes:[{path:'a.st',beforeSha256:'bad',afterSha256:changed}]}};
 const rows=candidateOperationGroups(incomplete);assert.equal(rows[0].filesKnown,false);assert.equal(rows[0].countLabel,'结果摘要');assert.equal(rows[0].files.length,0);
 assert.equal(candidateOperationGroups({...task,candidate:{}}).length,0);
 assert.equal(resultStatus({...task,supersededBy:'task-new'}),'已有后续修改');
});
test('same-project retention needs its explicit scope and saved revision; legacy copies remain valid',()=>{
 const saved={...task,status:'kept',retention:{keptProjectId:projectId,revision:source,completionScope:'saved-project-version'}};
 assert.equal(reviewStages(saved).retainedProjectId,projectId);assert.equal(editorOpenRequest('chat-a',saved).target,'retained');
 assert.equal(reviewStages({...saved,retention:{...saved.retention,completionScope:undefined}}).retainedProjectId,null);
 assert.equal(reviewStages({...saved,retention:{...saved.retention,revision:'unknown'}}).retainedProjectId,null);
 assert.equal(reviewStages({...saved,retention:{keptProjectId:'user-copy'}}).retainedProjectId,'user-copy');
});
test('historical read-only preview is available without reopening a discarded or superseded editor target',()=>{
 for(const status of ['discarded','superseded']){
  const history={...task,status};const url=new URL(previewUrl('chat-a',history),'https://local.test/');
  assert.equal(url.searchParams.get('taskId'),taskId);assert.equal(url.searchParams.get('candidateDigest'),changed);
  assert.throws(()=>editorOpenRequest('chat-a',history),/尚不可预览/);
 }
 assert.throws(()=>previewUrl('chat-a',{...task,candidate:{candidateDigest:'wrong'}}),/身份尚未确认/);
});
test('OIP operation and check evidence stays separate from PLC compilation',()=>{
 const row=candidateOperationGroups({...task,status:'compiled',compilation:{status:'compiled'},candidate:{...task.candidate,components:[{tool:'oip',summary:'scene',operations:[{name:'update_part',summary:'修改输送带速度'}],checks:[{id:'scene',label:'场景结构',status:'passed'},{id:'binding',label:'绑定检查',status:'warning',summary:'未连接 PLC'}]}]}}).find(row=>row.tool==='oip');
 assert.equal(row.checkLabel,'原生检查需注意');assert.deepEqual(row.operations,[{name:'update_part',summary:'修改输送带速度'}]);assert.equal(row.countLabel,'结果摘要');
 const missing=candidateOperationGroups({...task,status:'compiled',candidate:{components:[{tool:'oip',summary:'legacy scene'}]}}).find(row=>row.tool==='oip');assert.equal(missing.checkLabel,'');
 const malformed=candidateOperationGroups({...task,candidate:{components:[{tool:'oip',checks:[{id:'x',label:'检查',status:'success'}]}]}}).find(row=>row.tool==='oip');assert.equal(malformed.checkLabel,'原生检查未完成');
});
test('OIP sync requires the exact saved revision and never treats a popup acknowledgement as loading',()=>{
 const saved={...task,retention:{keptProjectId:projectId,revision:source,completionScope:'saved-project-version'}};
 assert.equal(oipResultState(task,{state:'synced',revision:source}),null);
 assert.equal(oipResultState(saved,{state:'synced',revision:source}).state,'synced');
 assert.equal(oipResultState(saved,{state:'synced',revision:changed}).state,'historical');
 assert.equal(oipResultState(saved,{state:'synced'}).state,'historical');
 assert.equal(oipResultState(saved,{state:'pending_confirmation'}).label,'等待 OIP 确认');
 assert.equal(oipResultState(saved,{state:'blocked',message:'存在未保存编辑'}).message,'存在未保存编辑');
 assert.equal(oipResultState(saved,{state:'unknown',message:'请在 OIP 确认'}).state,'unknown');
});
test('candidate observations verify launch and preview revision instead of borrowing the saved project status',async()=>{
 const launch={projectId,taskId,candidateDigest:changed,target:'candidate',tool:'oip',launchId:'editor-'+'e'.repeat(32),observationRevision:source};
 const sync={state:'synced',revision:source},result={ok:true,...launch,toolSync:{oip:sync}};
 assert.deepEqual(await readOipResourceObservation(async()=>result,'chat',launch),sync);
 for(const field of ['projectId','taskId','candidateDigest','launchId','target','observationRevision'])await assert.rejects(readOipResourceObservation(async()=>({...result,[field]:'other'}),'chat',launch),/不属于/);
 assert.equal(oipPreviewState(launch,sync).label,'候选预览已载入');assert.equal(oipPreviewState(launch,{...sync,revision:changed}).state,'unknown');
});
