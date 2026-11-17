import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const own=createRequire(import.meta.url);
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const legacy=createRequire(resolve(root, 'software/eez-studio-zh/package.json'));
export function packages(name) {
  try { return own(name); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return legacy(name);
  }
}
packages.resolve=(name)=>{try{return own.resolve(name);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;return legacy.resolve(name);}};
let build;
try { ({build}=own('esbuild')); }
catch(error) {
  if(error.code!=='MODULE_NOT_FOUND')throw error;
  ({build}=createRequire(process.env.PLCDEV_DSH_BUILD_PACKAGE || resolve(root,'.tools/dsh-host/package.json'))('esbuild'));
}
// Browser test bundles share host React, including native viewer subpath imports.
export const buildTools={build:options=>build({...options,external:options.platform==='node'&&options.external?.includes('react')?[...new Set([...options.external,'react-dom'])]:options.external,alias:options.platform==='browser'?{
  'react/jsx-runtime':packages.resolve('react/jsx-runtime'),
  'react-dom':packages.resolve('react-dom'),
  'react-dom/client':packages.resolve('react-dom/client'),
  ...options.alias,
}:options.alias})};
