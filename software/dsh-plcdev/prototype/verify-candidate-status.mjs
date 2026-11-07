// Focused follow-up for candidate property wording, using real offline UI transitions.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const stage=resolve(root,process.argv[2]||'outputs/plcdev-dsh-prototype/20261101-horizontal');
const {JSDOM,VirtualConsole}=createRequire(resolve(root,'software/eez-studio-zh/package.json'))('jsdom');
const html=await readFile(resolve(stage,'plcdev-dsh-prototype.html'),'utf8'),key='plcdev-dsh-native-integration-v2',checks=[],errors=[];
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',e=>{if(!e.message.includes('CSS'))errors.push(e.message);});
const wait=()=>new Promise(resolve=>setTimeout(resolve,65));
function open(saved){return new JSDOM(html,{url:'https://prototype.invalid/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(win){if(saved)win.localStorage.setItem(key,saved);}});}
let dom=open(),failure;
const doc=()=>dom.window.document;
async function click(label){const b=[...doc().querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label)||[...doc().querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(label));assert.ok(b,'Missing button '+label);assert.ok(!b.disabled);b.click();await wait();}
async function candidate(){await click('候选成果');doc().querySelector('[data-resource="candidate"]').click();await wait();}
function status(){return [...doc().querySelectorAll('.hx-property-grid > div')].find(el=>el.querySelector('dt')?.textContent==='候选状态')?.querySelector('dd')?.textContent;}
function check(label,expected){assert.equal(status(),expected,label);checks.push(label);}
try{
 await wait();await candidate();check('Review candidate identifies unapplied review state','待审阅 · 未应用');
 await click('审阅候选成果');await click('保留候选');await click('工程总览');await candidate();check('Kept candidate still requires compilation','已保留 · 待编译');
 await click('审阅候选成果');await click('撤销保留');await click('关闭审阅栏');
 const input=doc().querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,'目标改为 6 件，延时 2 秒');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await wait();await click('发送工程需求');await click('工程总览');await candidate();check('Generating task is not labeled ready for review','生成中 · 尚未形成候选');
 const saved=dom.window.localStorage.getItem(key);dom.window.close();dom=open(saved);await wait();await candidate();check('Reloaded interrupted task identifies paused state','已暂停 · 返回对话可继续');
 assert.equal(errors.length,0);
}catch(e){failure=e;errors.push(e.stack||String(e));}
finally{dom.window.close();const report={date:'2026-11-01',scope:'Focused offline DOM follow-up after candidate status wording change; no live service or layout validation',passed:checks.length,complete:!failure,htmlSha256:createHash('sha256').update(html).digest('hex'),checks,errors};await writeFile(resolve(stage,'candidate-status-checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
if(failure)throw failure;
