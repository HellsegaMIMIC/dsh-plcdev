import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const esbuild = createRequire(resolve(root, '.tools/dsh-host/package.json'))('esbuild');
const reactPackages = createRequire(resolve(root, 'software/eez-studio-zh/package.json'));
const output = resolve(root, process.argv[2] || 'outputs/plcdev-dsh-prototype/20261101-horizontal');
const component = resolve(root, 'software/dsh-plcdev/prototype/src/components/generated/PLCdevDSH.tsx');
const result = await esbuild.build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PLCdevDSH} from ${JSON.stringify(component.replaceAll('\\', '/'))}; createRoot(document.getElementById('plcdev-prototype-root')).render(React.createElement(PLCdevDSH));`,
    resolveDir: root, loader: 'tsx',
  },
  alias: { react: reactPackages.resolve('react'), 'react-dom/client': reactPackages.resolve('react-dom/client') },
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
  outfile: 'prototype.js', minify: true, define: { 'process.env.NODE_ENV': '"production"' },
});
const javascript = result.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = result.outputFiles.find(f => f.path.endsWith('.css')).text.replace(/@import\s+url\([^;]+;/g, '');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PLCdev · DSH 中控交互原型</title>
<style>html,body{margin:0;min-width:320px}body{background:#fff}*{box-sizing:border-box}${css}</style></head>
<body><div id="plcdev-prototype-root"></div><script>${javascript.replaceAll('</script', '<\\/script')}</script></body></html>`;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'plcdev-dsh-prototype.html'), html, 'utf8');
const networkCalls = /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(await readFile(component, 'utf8'));
if (networkCalls) throw new Error('The prototype must remain independent of all service APIs.');
console.log(JSON.stringify({ output: resolve(output, 'plcdev-dsh-prototype.html'), bytes: Buffer.byteLength(html), networkCalls: false, build: 'passed' }));
