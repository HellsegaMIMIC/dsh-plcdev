import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const root = dirname(fileURLToPath(import.meta.url));
let build;
try { ({ build } = createRequire(import.meta.url)('esbuild')); }
catch { ({ build } = createRequire(process.env.PLCDEV_DSH_BUILD_PACKAGE || resolve(root, '../../.tools/dsh-host/package.json'))('esbuild')); }
const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  outfile: resolve(root, 'lib/client.js'), bundle: true, format: 'cjs',
  platform: 'browser', target: 'es2022', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-plcdev", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
await mkdir(resolve(root, 'lib'), { recursive: true });
for (const output of result.outputFiles) await writeFile(output.path, output.contents);
