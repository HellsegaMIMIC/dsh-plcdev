// Offline presentation/authorization checks, not an AI generation or compiler claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {packages,buildTools} from './dependencies.mjs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewActionRequest, readReviewPending, reviewPendingKey, recoverConversationRequest } from '../src/client/conversation-client.mjs';
const projectId='user-'+'a'.repeat(32), taskId='task-'+'b'.repeat(32), digest='c'.repeat(64), source='d'.repeat(64), kept='e'.repeat(64);
const target={projectId,taskId};
const task=(status='awaiting_review')=>({projectId,taskId,status,workflow:'joint-ai-v1',projectRevision:source,candidate:{candidateDigest:digest},retention:{revision:kept}});
test('review actions pin exact conversation, task, digest and source or retained revision',()=>{
  assert.equal(reviewActionRequest('conversation-a',task(),target,'keep','r1').expectedRevision,source);
  assert.equal(reviewActionRequest('conversation-a',task('kept'),target,'compile','r2').expectedRevision,kept);
  assert.equal(reviewActionRequest('conversation-a',task('compiled'),target,'compile','r3').candidateDigest,digest);
  for(const action of ['keep','undo','compile'])assert.equal(reviewActionRequest('conversation-a',task(),{...target,projectId:'other'},action,'r1'),null);
  assert.equal(reviewActionRequest('conversation-a',task('kept'),target,'undo','r1'),null);
  assert.equal(reviewActionRequest('conversation-a',task(),target,'compile','r1'),null);
  assert.equal(reviewActionRequest('conversation-a',task(),target,'run','r1'),null);
  assert.equal(reviewActionRequest('conversation-a',{...task(),workflow:'count-rename-v1'},target,'keep','r1'),null);
});

test('three-member generation uses the same pinned human review boundary and never offers Runtime tools',()=>{
  const generated=status=>({...task(status),workflow:'team-generation-v1'});
  assert.equal(reviewActionRequest('conversation-a',generated('awaiting_review'),target,'keep','g1').expectedRevision,source);
  assert.equal(reviewActionRequest('conversation-a',generated('awaiting_review'),target,'undo','g2').candidateDigest,digest);
  assert.equal(reviewActionRequest('conversation-a',generated('kept'),target,'compile','g3').expectedRevision,kept);
  for(const action of ['keep','undo','compile'])assert.equal(reviewActionRequest('conversation-a',generated('components_ready'),target,action,'g4'),null);
  assert.equal(reviewActionRequest('conversation-a',generated('kept'),target,'undo','g5'),null);
  assert.equal(reviewActionRequest('conversation-a',generated('compiled'),target,'run','g6'),null);
});
test('unknown review keeps original request ID even when current task state advanced',()=>{
  const body=reviewActionRequest('conversation-a',task(),target,'keep','original-id');
  const store=new Map(),storage={getItem:k=>store.get(k)||null};
  store.set(reviewPendingKey('conversation-a',target),JSON.stringify(body));
  assert.deepEqual(readReviewPending(storage,'conversation-a',target),body);
  assert.equal(readReviewPending(storage,'conversation-b',target),null);
  store.set(reviewPendingKey('conversation-a',target),JSON.stringify({...body,projectId:'other'}));
  assert.throws(()=>readReviewPending(storage,'conversation-a',target),/无效/);
});
test('recovering a native joint request cannot silently downgrade its workflow',()=>{
  const original={conversationId:'conversation-a',projectId,expectedVersion:1,request:'批次计数联合候选',expectedRevision:source,executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'native-123',workflow:'joint-ai-v1'};
  assert.equal(recoverConversationRequest(original,'conversation-a').workflow,'joint-ai-v1');
  assert.equal(recoverConversationRequest({...original,workflow:'unexpected'},'conversation-a'),null);
});

test('native review buttons issue explicit pinned actions and disable undo after retaining',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const deps=packages;
  const {build}=buildTools;
  const React=deps('react'),{JSDOM,VirtualConsole}=deps('jsdom');
  const prior={window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator,fetch:globalThis.fetch};
  const errors=[],posts=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:55112',pretendToBeVisual:true,virtualConsole:vc});
  for(const key of ['window','document','navigator'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});
  const {createRoot}=deps('react-dom/client');let current={...task(),request:'联合样例',retention:undefined},savedRevision=source;
  globalThis.fetch=async(url,options={})=>{
    const u=new URL(url,'http://127.0.0.1:55112');
    if(!options.body)return {ok:true,status:200,json:async()=>({projectId,projectRevision:savedRevision,tasks:[current]})};
    const body=JSON.parse(options.body);posts.push({path:u.pathname,body});assert.equal(u.pathname,'/api/plcdev/conversations/review');
    if(body.action==='keep')current={...current,status:'kept',retention:{revision:kept,keptProjectId:'user-retained'}};
    if(body.action==='compile')current={...current,status:'compiled',compilation:{status:'compiled'}};
    return {ok:true,status:202,json:async()=>({ok:true,projectId,taskId,candidateDigest:digest,task:current})};
  };
  const bundle=await build({entryPoints:[resolve(root,'software/dsh-plcdev/src/client/Conversation.tsx')],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(deps,module,module.exports);
  const reactRoot=createRoot(dom.window.document.getElementById('root')),wait=()=>new Promise(done=>setTimeout(done,110));
  const button=label=>{const found=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(found,label);return found;};
  try{
    reactRoot.render(React.createElement(module.exports.ConversationReview,{sessionId:'chat-review',onOverview:()=>{},useTabInfo:()=>({tab:{navigation:{params:target}}})}));await wait();
    assert.equal(posts.length,0);assert.equal(button('创建修改副本').disabled,false);assert.equal(button('放弃这次修改').disabled,false);assert.equal(button('编译保留版本').disabled,true);
    assert.ok(dom.window.document.body.textContent.includes('工程名称未能确认'),'Missing name metadata does not hide a valid task');
    savedRevision='f'.repeat(64);button('刷新').click();await wait();
    assert.equal(button('创建修改副本').disabled,true);assert.equal(button('放弃这次修改').disabled,false);
    assert.ok(dom.window.document.body.textContent.includes('旧候选不能保留'));assert.equal(posts.length,0);
    savedRevision=source;button('刷新').click();await wait();
    button('创建修改副本').click();await wait();
    assert.equal(posts[0].body.expectedRevision,source);assert.equal(posts[0].body.conversationId,'chat-review');assert.equal(posts[0].body.candidateDigest,digest);
    assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='放弃这次修改'),false);assert.equal(button('创建修改副本').disabled,true);assert.equal(button('编译保留版本').disabled,false);
    button('编译保留版本').click();await wait();assert.equal(posts[1].body.expectedRevision,kept);assert.equal(posts[1].body.taskId,taskId);
    assert.ok(dom.window.document.body.textContent.includes('编译通过'));assert.equal(posts.some(p=>p.path.includes('/action')),false);assert.deepEqual(errors,[]);
    current={...current,status:'conflict',reason:'保留工程版本已变化'};button('刷新').click();await wait();
    assert.ok(dom.window.document.body.textContent.includes('本次操作版本冲突'));
    assert.ok(dom.window.document.body.textContent.includes('历史编译通过（旧版本回执），不代表本次操作成功。'));
    assert.equal([...dom.window.document.querySelectorAll('h3')].some(e=>e.textContent==='编译通过'),false);
    assert.equal(button('编译保留版本').disabled,true);assert.equal(current.compilation.status,'compiled');
    const reviews=[];
    reactRoot.render(React.createElement(module.exports.NativeToolCard,{phase:'result',toolName:'plcdev_propose_joint',block:{content:[{type:'text',text:JSON.stringify({task:current})}],isError:false},onReviewTask:value=>reviews.push(value)}));await wait();
    button('查看更改').click();await wait();assert.deepEqual(reviews,[target],'Tool result navigates through its injected session action without owner sessionId props');
    current={...task(),workflow:'team-analysis-v1',status:'analysis_ready',candidate:undefined,retention:undefined,
      teamAnalysis:{rootSessionId:'native-lead',members:[{role:'plc',sessionId:'native-plc',nativeTaskId:'t1',instruction:'检查参数',reportDigest:digest,report:{summary:'目标范围分析',findings:['PLC 明确校验范围'],unverified:['未运行实测']}}]}};
    reactRoot.render(React.createElement(module.exports.ConversationReview,{sessionId:'chat-review',useTabInfo:()=>({tab:{navigation:{params:target}}}),onOverview:()=>{}}));await wait();
    assert.ok(dom.window.document.body.textContent.includes('PLCdev 团队分析'));
    assert.ok(dom.window.document.body.textContent.includes('目标范围分析'));
    assert.ok(dom.window.document.body.textContent.includes('编译和 Runtime 验证未执行'));
    assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>/保留|编译|打开候选/.test(b.textContent)),false);
    assert.equal(dom.window.document.body.textContent.includes('此任务为既有规则候选'),false);
    const selected=[];
    current={...task(),workflow:'team-generation-v1',request:'三端独立生成',retention:undefined,teamAnalysis:{rootSessionId:'native-lead',members:['plc','hmi','oip'].map(role=>({role,sessionId:'native-'+role,instruction:role+' 专业产物',componentDigest:digest,reportDigest:digest,report:{summary:role+' 原生产物回执',findings:['独立产物已生成'],unverified:['编译运行未测']}}))}};
    reactRoot.render(React.createElement(module.exports.ConversationReview,{sessionId:'chat-review',useTabInfo:()=>({tab:{navigation:{params:target}}}),onOverview:()=>{},onRetainedProject:id=>selected.push(id)}));
    await wait();button('刷新').click();await wait();
    assert.ok(dom.window.document.body.textContent.includes('PLC／HMI／OIP 独立产物'));
    assert.ok(dom.window.document.body.textContent.includes('不是静态分析或运行证据'));
    assert.equal(button('创建修改副本').disabled,false);button('创建修改副本').click();await wait();
    const beforeNavigation=posts.length;button('打开修改副本').click();await wait();
    assert.deepEqual(selected,['user-retained']);assert.equal(posts.length,beforeNavigation,'Runtime navigation must not send commands');
    assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='放弃这次修改'),false);assert.equal(button('编译保留版本').disabled,false);
    assert.equal(dom.window.document.body.textContent.includes('此任务为既有规则候选'),false);
  }finally{reactRoot.unmount();dom.window.close();for(const [key,value]of Object.entries(prior))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
});
