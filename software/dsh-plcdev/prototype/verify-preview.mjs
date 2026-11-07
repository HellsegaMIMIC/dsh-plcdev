// Offline interaction checks for the design only. JSDOM is not browser layout QA.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packages = createRequire(resolve(root, 'software/eez-studio-zh/package.json'));
const { JSDOM, VirtualConsole } = packages('jsdom');
const dir = resolve(root, process.argv[2] || 'outputs/plcdev-dsh-prototype/20261031');
const html = await readFile(resolve(dir, 'plcdev-dsh-prototype.html'), 'utf8');
const checks = [], errors = [];
const console = new VirtualConsole();
console.on('jsdomError', e => { if (!e.message.includes('CSS')) errors.push(e.message); });
const wait = (ms=30) => new Promise(r=>setTimeout(r,ms));
function openPage(restored) {
  return new JSDOM(html, { url: 'https://prototype.invalid/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console, beforeParse(win) { if (restored) win.localStorage.setItem('plcdev-dsh-magicpath-prototype-v1', restored); } });
}
let dom = openPage();
await wait(80);
const state = () => JSON.parse(dom.window.localStorage.getItem('plcdev-dsh-magicpath-prototype-v1'));
const current = () => state().flows[state().project];
const doc = () => dom.window.document;
async function click(label) {
  const button = [...doc().querySelectorAll('button')].find(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
  assert.ok(button, `Button ${label} exists`); assert.equal(button.disabled,false,`Button ${label} is enabled`);
  button.click(); await wait();
}
function check(label, condition) { assert.ok(condition,label); checks.push(label); }
async function submit(value) {
  const input=doc().querySelector('textarea');
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,value);
  input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  await wait(); await click('发送需求');
}

check('Initial candidate and HMI render', current().phase==='review' && doc().querySelector('.pd-hmi-preview'));
await click('PLC 逻辑');
check('PLC tab contains candidate delay and count',doc().querySelector('.pd-ladder').textContent.includes('T#3s') && doc().querySelector('.pd-ladder').textContent.includes('5'));
await click('变量与场景');
check('Binding table shows the same target',doc().querySelector('.pd-binding-table').textContent.includes('HMI 目标 5 件'));
await click('保留这组候选');
check('Keep only marks candidate',current().phase==='kept' && doc().querySelector('.pd-project-meta').textContent.includes('v12'));
await click('撤销保留');
check('Undo returns candidate to review',current().phase==='review');
await submit('目标改为 8 件');
check('Feedback enters generating state',current().phase==='generating');
await click('暂停任务'); const pausedStep=current().step;
await wait(1150);
check('Pause preserves progress',current().phase==='paused' && current().step===pausedStep);
await click('继续生成'); await wait(4300);
check('Generation completes with target 8',current().phase==='review' && current().target===8);
await click('PLC 逻辑');
check('Updated PLC preview contains target 8',doc().querySelector('.pd-ladder').textContent.includes('8'));
await click('变量与场景');
check('Updated binding contains target 8',doc().querySelector('.pd-binding-table').textContent.includes('HMI 目标 8 件'));
await click('画面预览');
check('Updated HMI contains target 08',doc().querySelector('.pd-hmi-values').textContent.includes('/ 08'));
await submit('延时 0 秒'); await wait(4300);
check('Zero delay is accepted',current().delay===0 && current().phase==='review');
const persisted=dom.window.localStorage.getItem('plcdev-dsh-magicpath-prototype-v1'); dom.window.close(); dom=openPage(persisted); await wait(80);
check('Reopen retains zero delay and target',current().delay===0 && current().target===8);
await click('批次计数 · B 线');
check('Project B has an independent empty state',current().phase==='empty' && doc().querySelector('.pd-empty'));
await click('输送带 · 批次计数');
check('Returning to A retains candidate',current().target===8 && current().phase==='review');
await click('连接拓扑');
check('Topology distinguishes runtime state',doc().querySelector('.pd-runtime-path').textContent.includes('通信未建立'));
await click('演示选项'); await click('演示生成失败与重试'); await wait(3300);
check('Simulated failure is explicit',current().phase==='error' && doc().querySelector('.pd-generation-error'));
await click('重试当前步骤'); await wait(2300);
check('Retry reaches review',current().phase==='review' && current().fail===false);
await click('演示选项'); await click('演示连接中断');
check('Disconnected state prevents keep',doc().querySelector('.pd-disconnect') && [...doc().querySelectorAll('button')].some(b=>b.textContent.includes('保留这组候选')&&b.disabled));
await click('恢复连接');
check('Recovery enables review actions',[...doc().querySelectorAll('button')].some(b=>b.textContent.includes('保留这组候选')&&!b.disabled));
check('No script errors',errors.length===0);
dom.window.close();
await writeFile(resolve(dir,'interaction-checks.json'),JSON.stringify({date:'2026-11-01',scope:'Offline React interaction checks in JSDOM; no real browser layout, production service, AI, compiler, Runtime or hardware validation',passed:checks.length,checks,errors},null,2));
process.stdout.write(JSON.stringify({passed:checks.length,errors,report:resolve(dir,'interaction-checks.json')})+'\n');
