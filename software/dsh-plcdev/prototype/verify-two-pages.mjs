// Checks navigation and candidate ownership in an offline DOM; not layout or production validation.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const stage=resolve(root,process.argv[2]||'outputs/plcdev-dsh-prototype/20261101-two-pages');
const {JSDOM,VirtualConsole}=createRequire(resolve(root,'software/eez-studio-zh/package.json'))('jsdom');
const html=await readFile(resolve(stage,'plcdev-dsh-prototype.html'),'utf8');
const key='plcdev-dsh-native-integration-v2',checks=[],errors=[];
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>{if(!error.message.includes('CSS'))errors.push(error.message);});
const wait=(ms=50)=>new Promise(done=>setTimeout(done,ms));
function open(restored,hash=''){return new JSDOM(html,{url:'https://prototype.invalid/'+hash,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(win){if(restored)win.localStorage.setItem(key,restored);}});}
let dom=open();
const doc=()=>dom.window.document;
const state=()=>JSON.parse(dom.window.localStorage.getItem(key));
const focus=()=>doc().querySelector('.ni-project-focus');
const toolStatus=id=>doc().querySelector(`[data-tool="${id}"] .ni-tool-badge`).textContent.trim();
function check(label,value){assert.ok(value,label);checks.push(label);}
async function click(label,scope=doc()){
 const button=[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
 assert.ok(button,'Missing button: '+label);assert.equal(button.disabled,false,'Disabled button: '+label);button.click();await wait();
}
async function selectProject(id){const button=doc().querySelector('#overview-tab-'+id);assert.ok(button);button.click();await wait();}
async function submit(text){const input=doc().querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();await click('发送工程需求');}
try{
 await wait(100);
 check('Overview opens on A with no conversation composer',focus().textContent.includes('输送带 A 线')&&!doc().querySelector('textarea')&&dom.window.location.hash==='#overview');
 check('Optional tools do not form a global readiness gate',doc().querySelector('.ni-toolchain-heading').textContent.includes('按需准备')&&!doc().querySelector('.ni-toolchain-heading').textContent.includes('/ 3'));
 const originalA=JSON.stringify(state().sessions.main);
 await selectProject('b');
 check('Selecting B changes the viewed project without rebinding A conversation',focus().textContent.includes('输送带 B 线')&&JSON.stringify(state().sessions.main)===originalA&&state().sessions.second.binding===null);
 check('Viewed B has its own tool state',toolStatus('fuxa')==='已就绪'&&toolStatus('oip')==='已就绪');
 await click('返回当前对话');
 check('Returning to the current conversation keeps A context and result',dom.window.location.hash==='#conversation'&&doc().querySelector('.ni-context-dock').textContent.includes('输送带 A 线')&&doc().querySelector('.ni-artifact-card').textContent.includes('T-014'));
 await click('工程总览');
 await click('查看 FUXA 就绪详情');await click('模拟连接异常');
 check('A simulated FUXA failure leaves Runtime disconnected',toolStatus('fuxa')==='连接异常'&&toolStatus('runtime')==='未连接');
 await selectProject('b');check('A service failure does not leak into B',toolStatus('fuxa')==='已就绪');
 await selectProject('a');check('Selecting A again restores its own service state',toolStatus('fuxa')==='连接异常');
 await selectProject('b');await click('进入工程对话');
 check('Explicit entry associates B with a separate conversation',state().sessions.second.binding==='b'&&state().sessions.second.tasks.length===0&&state().sessions.main.binding==='a'&&doc().querySelector('.ni-empty'));
 await submit('目标改为 4 件，延时 2 秒');await wait(3900);
 check('B generation creates only B result and preserves A',state().sessions.second.tasks[0].project==='b'&&state().sessions.second.tasks[0].target===4&&JSON.stringify(state().sessions.main)===originalA);
 await click('工程总览');await selectProject('a');await click('查看成果');
 check('Overview result opens its owning A conversation and review',doc().querySelector('.ni-review-title').textContent.includes('输送带 A 线')&&doc().querySelector('.ni-context-dock').textContent.includes('输送带 A 线')&&doc().querySelectorAll('.ni-artifact-card').length===1);
 await click('保留候选');
 check('Keeping A candidate preserves source version and B ownership',state().sessions.main.tasks[0].phase==='kept'&&doc().querySelector('.ni-review-title').textContent.includes('v12')&&state().sessions.second.tasks[0].target===4);
 await click('撤销保留');check('Undo returns A candidate to review',state().sessions.main.tasks[0].phase==='review');
 await click('关闭审阅栏');
 dom.window.location.hash='#overview';await wait();
 check('Overview hash shows the project page',!!doc().querySelector('.ni-engineering-home')&&!doc().querySelector('textarea'));
 dom.window.location.hash='#conversation';await wait();
 check('Conversation hash restores one composer and same A result',doc().querySelectorAll('textarea').length===1&&doc().querySelector('.ni-artifact-card').textContent.includes('T-014'));
 await submit('目标改为 8 件，延时 0 秒');
 check('Conversation modifications retain zero delay and candidate identity',state().sessions.main.tasks[0].target===8&&state().sessions.main.tasks[0].delay===0&&state().sessions.main.tasks[0].id==='T-014');
 const persisted=dom.window.localStorage.getItem(key);dom.window.close();dom=open(persisted,'#conversation');await wait(100);
 check('Reopen pauses unfinished A generation and preserves distinct B task',state().sessions.main.tasks[0].phase==='paused'&&state().sessions.main.tasks[0].target===8&&state().sessions.second.tasks[0].project==='b'&&state().sessions.second.tasks[0].target===4);
 await click('工程总览');await selectProject('b');await click('进入工程对话');
 check('Reopened B conversation contains only B result',doc().querySelectorAll('.ni-artifact-card').length===1&&doc().querySelector('.ni-artifact-card').textContent.includes('输送带 B 线')&&!doc().querySelector('.ni-artifact-card').textContent.includes('T-014'));
 check('No script errors',errors.length===0);
 await writeFile(resolve(stage,'interaction-checks.json'),JSON.stringify({date:'2026-11-01',scope:'Offline build and JSDOM interaction only; no browser layout, production DSH, external software, model, compiler, Runtime or hardware validation',passed:checks.length,checks,errors},null,2));
 console.log(JSON.stringify({passed:checks.length,errors,report:resolve(stage,'interaction-checks.json')}));
}finally{dom.window.close();}
