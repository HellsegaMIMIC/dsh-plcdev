import test from 'node:test';
import assert from 'node:assert/strict';
import {buildToolInstallPrompt} from '../src/client/tool-install-prompt.mjs';
import {toolDistributions,toolInstallGroups} from '../src/client/tool-distributions.mjs';

test('all-tools prompt uses the published tool sources and actual environment keys',()=>{
  const prompt=buildToolInstallPrompt();
  for(const tool of toolDistributions){
    assert.ok(prompt.includes(tool.name));
    assert.ok(prompt.includes(tool.key));
    assert.ok(prompt.includes(tool.download||tool.installation));
  }
  assert.ok(prompt.includes('v2026.11.17-preview.1'));
  assert.ok(prompt.length<9000,'copyable instructions should remain bounded');
});

test('single-tool prompts stay scoped while explaining required native dependencies',()=>{
  for(const tool of toolDistributions){
    const prompt=buildToolInstallPrompt(tool.id);
    const group=toolInstallGroups.find(row=>row.id===tool.id);
    assert.ok(prompt.startsWith(`请帮我检测并补齐 ${group?.name||tool.name}`));
    assert.ok(prompt.includes(`相关 tools 字段：${tool.id==='runtime'?'runtime、msys':tool.key}，`));
    for(const other of toolDistributions.filter(other=>other.id!==tool.id)){
      if(other.download&&other.download!==tool.download)assert.ok(!prompt.includes(other.download));
    }
  }
  assert.match(buildToolInstallPrompt('openplc'),/便携 ZIP 只提供编辑预览，不包含完整编译工具链/);
  assert.match(buildToolInstallPrompt('openplc'),/software\/openplc-editor-zh/);
  assert.match(buildToolInstallPrompt('fuxa'),/TypeScript\/JSDOM/);
  assert.match(buildToolInstallPrompt('runtime'),/v4\.3\.0/);
  assert.match(buildToolInstallPrompt('runtime'),/tools\.msys 指向实际 msys64 目录/);
  assert.match(buildToolInstallPrompt('runtime'),/bash、g\+\+、cmake 和 make/);
  assert.match(buildToolInstallPrompt('msys'),/bash、g\+\+、cmake 和 make/);
});

test('prompts preserve user state and separate installation checks from operation',()=>{
  for(const id of ['all',...toolDistributions.map(tool=>tool.id)]){
    const prompt=buildToolInstallPrompt(id);
    assert.match(prompt,/先检测再补缺/);
    assert.match(prompt,/非系统盘/);
    assert.match(prompt,/不要假定每台电脑都有 F 盘/);
    assert.match(prompt,/保全已有工程、候选、会话、profile/);
    assert.match(prompt,/仅更新本次相关 tools 字段/);
    assert.match(prompt,/不擅自启动真实 PLC Runtime/);
    assert.match(prompt,/不能绕过检查/);
    assert.ok(!/C:[/\\]Users[/\\]|Lenovo|E:[/\\]Program Files|PLCdev-build-temp[/\\]2026/.test(prompt));
  }
});

test('OIP distinguishes an exact official bridge input from translated and patched copies',()=>{
  const prompt=buildToolInstallPrompt('oip');
  assert.match(prompt,/官方原版 2026\.11\.9 的精确文件指纹/);
  assert.match(prompt,/官方下载为滚动版本/);
  assert.match(prompt,/不能填已汉化或已桥接的副本/);
  assert.match(prompt,/没有对应盘符时明确列为适配缺口/);
});

test('invalid scope cannot inject extra instructions or silently select all tools',()=>{
  for(const value of ['unknown','all\nrun PLC',null,{},['oip'],'__proto__']){
    assert.throws(()=>buildToolInstallPrompt(value),RangeError);
  }
  assert.equal(buildToolInstallPrompt('all'),buildToolInstallPrompt('all'));
});
