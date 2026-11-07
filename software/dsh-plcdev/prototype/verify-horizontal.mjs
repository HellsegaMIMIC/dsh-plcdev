// Key user flows in an offline DOM. This does not validate browser layout or production services.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const stage=resolve(root,process.argv[2]||'outputs/plcdev-dsh-prototype/20261101-horizontal');
const {JSDOM,VirtualConsole}=createRequire(resolve(root,'software/eez-studio-zh/package.json'))('jsdom');
const html=await readFile(resolve(stage,'plcdev-dsh-prototype.html'),'utf8');
const key='plcdev-dsh-native-integration-v2',checks=[],errors=[];
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>{if(!error.message.includes('CSS'))errors.push(error.message);});
const wait=(ms=55)=>new Promise(done=>setTimeout(done,ms));
function open(restored,hash=''){return new JSDOM(html,{url:'https://prototype.invalid/'+hash,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(win){if(restored)win.localStorage.setItem(key,restored);}});}
let dom=open();
const doc=()=>dom.window.document;
const state=()=>JSON.parse(dom.window.localStorage.getItem(key));
const menu=()=>doc().querySelector('.hx-resource-menu');
const info=()=>doc().querySelector('.hx-info');
const node=id=>doc().querySelector(`[data-node="${id}"]`);
const edge=id=>doc().querySelector(`[data-edge="${id}"]`);
const projectSelect=()=>doc().querySelector('select[aria-label="选择工程"]');
function check(label,value){assert.ok(value,label);checks.push(label);}
function button(label,scope=doc()){
 const buttons=[...scope.querySelectorAll('button')];
 return buttons.find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label)||buttons.find(b=>b.textContent.trim().startsWith(label));
}
async function click(label,scope=doc()){
 const b=button(label,scope);assert.ok(b,'Missing button: '+label);assert.equal(b.disabled,false,'Disabled button: '+label);b.click();await wait();
}
async function selectProject(id){const select=projectSelect();assert.ok(select,'Project selector');select.value=id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait();}
async function chooseResource(category,id){await click(category);const item=menu()?.querySelector(`[data-resource="${id}"]`);assert.ok(item,'Resource '+id);item.click();await wait();}
async function submit(text){const input=doc().querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();await click('发送工程需求');}
let failure;
try{
 await wait(140);
 check('Overview starts on A with four associated instances and no conversation composer',projectSelect()?.value==='a'&&['plc','runtime','hmi','scene'].every(node)&&!doc().querySelector('textarea'));
 const originalA=JSON.stringify(state().sessions.main);
 await click('PLC 程序');
 check('PLC resource menu exposes program and function block',menu()?.querySelector('[data-resource="main"]')&&menu()?.querySelector('[data-resource="fb"]'));
 await click('HMI 画面');
 check('Opening another horizontal category replaces the previous menu',doc().querySelectorAll('.hx-resource-menu').length===1&&menu().querySelector('[data-resource="hmi"]')&&!menu().querySelector('[data-resource="main"]'));
 doc().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait();
 check('Escape dismisses the horizontal resource menu',!menu());
 await click('PLC 程序');doc().body.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true}));await wait();
 check('Clicking outside dismisses the resource menu',!menu());
 await chooseResource('PLC 程序','main');
 check('Main program selection highlights PLC and identifies the precise resource',node('plc').classList.contains('is-selected')&&doc().querySelector('.hx-property-heading h3').textContent==='Main.ld'&&!info().classList.contains('is-collapsed'));
 await chooseResource('PLC 程序','fb');
 check('Function block selection keeps PLC focus and changes its resource detail',node('plc').classList.contains('is-selected')&&doc().querySelector('.hx-property-heading h3').textContent==='DelayStartFB.ld');
 node('hmi').click();await wait();
 check('Selecting the HMI instance highlights its horizontal category and exact resource',node('hmi').classList.contains('is-selected')&&doc().querySelector('.hx-property-heading h3').textContent==='BatchPanel.fuxap'&&doc().querySelector('.hx-resource-trigger.is-active').textContent.includes('HMI 画面')&&!node('plc').classList.contains('is-selected'));
 edge('hmi-link').click();await wait();
 check('Selecting a communication link identifies endpoints and disconnected quality',edge('hmi-link').classList.contains('is-selected')&&node('runtime').classList.contains('is-related')&&node('hmi').classList.contains('is-related')&&/未连接|未建立/.test(info().textContent));
 await click('收起信息区');
 check('Information panel collapses while topology remains available',info().classList.contains('is-collapsed')&&!!node('runtime'));
 await chooseResource('PLC 程序','main');
 check('Selecting a resource reopens its properties',!info().classList.contains('is-collapsed')&&info().textContent.includes('Main.ld'));
 let resizer=doc().querySelector('[aria-label="调整信息区高度"]');const originalHeight=Number(resizer.getAttribute('aria-valuenow'));
 resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));await wait();
 check('Keyboard resizing changes the information height within its declared bounds',Number(doc().querySelector('[aria-label="调整信息区高度"]').getAttribute('aria-valuenow'))>originalHeight);
 await click('变量监视');
 check('Disconnected monitor does not pretend to show live values',/未连接|尚未连接/.test(info().textContent)&&/—|--/.test(info().textContent));
 await click('开发环境');await click('查看 FUXA 就绪详情');await click('模拟连接异常');await click('关闭开发环境');
 check('Environment failure updates the A HMI instance without connecting Runtime',node('hmi').textContent.includes('服务异常')&&node('runtime').textContent.includes('未连接'));
 await selectProject('b');
 check('Viewing B does not rebind A conversation or move its candidate',projectSelect().value==='b'&&JSON.stringify(state().sessions.main)===originalA&&state().sessions.second.binding===null);
 check('B omits its unassociated scene instance and communication edge',!node('scene')&&!edge('io-link')&&['plc','runtime','hmi'].every(node));
 check('A HMI service failure does not leak into B',node('hmi').textContent.includes('服务待启动')&&!node('hmi').textContent.includes('服务异常'));
 await click('仿真场景');await click('关联输送带场景（演示）');
 check('Associating B scene creates only its own topology node and link',!!node('scene')&&!!edge('io-link')&&JSON.stringify(state().sessions.main)===originalA);
 await selectProject('a');
 check('Returning to A retains its own scene and HMI state',projectSelect().value==='a'&&!!node('scene')&&!!edge('io-link')&&node('hmi').textContent.includes('服务异常'));
 await selectProject('b');
 check('B scene association survives another project round trip',!!node('scene')&&!!edge('io-link'));
 await click('进入工程对话');
 check('Explicit project entry opens an independent B conversation',state().sessions.second.binding==='b'&&state().sessions.second.tasks.length===0&&state().sessions.main.binding==='a'&&doc().querySelector('.ni-empty'));
 await submit('目标改为 4 件，延时 2 秒');await wait(3900);
 check('B generation stays in B and preserves A result',state().sessions.second.tasks[0]?.project==='b'&&state().sessions.second.tasks[0]?.target===4&&JSON.stringify(state().sessions.main)===originalA);
 await click('工程总览');await selectProject('a');await chooseResource('候选成果','candidate');await click('审阅候选成果');
 check('Candidate resource opens its owning A conversation and review',doc().querySelector('.ni-review-title')?.textContent.includes('输送带 A 线')&&doc().querySelector('.ni-context-dock')?.textContent.includes('输送带 A 线'));
 await click('保留候选');
 check('Keep marks A candidate without changing B ownership',state().sessions.main.tasks[0].phase==='kept'&&state().sessions.second.tasks[0].target===4&&doc().querySelector('.ni-review-title').textContent.includes('v12'));
 await click('撤销保留');check('Undo returns A candidate to review',state().sessions.main.tasks[0].phase==='review');
 await click('关闭审阅栏');await submit('目标改为 8 件，延时 0 秒');
 check('Conversation modification preserves zero delay and task identity',state().sessions.main.tasks[0].target===8&&state().sessions.main.tasks[0].delay===0&&state().sessions.main.tasks[0].id==='T-014');
 const persisted=dom.window.localStorage.getItem(key);dom.window.close();dom=open(persisted,'#conversation');await wait(120);
 check('Reload keeps separate candidate ownership and pauses interrupted generation',state().sessions.main.tasks[0].phase==='paused'&&state().sessions.main.tasks[0].target===8&&state().sessions.second.tasks[0].project==='b');
 check('No script errors',errors.length===0);
}catch(error){failure=error;errors.push(error.stack||String(error));}
finally{
 dom.window.close();
 const report={date:'2026-11-01',scope:'Offline React build and JSDOM user-flow checks only; no browser layout, production DSH, model, external application, compiler, Runtime or hardware validation',passed:checks.length,complete:!failure,htmlSha256:createHash('sha256').update(html).digest('hex'),checks,errors};
 await writeFile(resolve(stage,'interaction-checks.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:checks.length,complete:!failure,errors,report:resolve(stage,'interaction-checks.json')}));
}
if(failure)throw failure;
