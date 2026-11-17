import test from 'node:test';
import assert from 'node:assert/strict';
import {showLegacyModel} from '../src/legacy-model-catalog.mjs';
import {createProjectModelAdapter,MODEL_ID,MODEL_PROVIDER} from '../src/model-adapter.mjs';

test('legacy entry remains only for an unmigrated live session or missing verified host model',async()=>{
 const agent={session:{requestHeader:()=>({config:{provider:'plcdev-deepseek',model:'project-agent'}})}};
 let live=[],pending=null,providers=[],models=[];
 const ctx={llm:{listProviders:()=>providers,listModels:async()=>models},agents:{list:()=>live},sessionProjections:{stateOf:()=>({pending})}};
 assert.equal(await showLegacyModel(ctx),true,'No native model: do not strand existing profiles');
 providers=[{id:'deepseek-official'}];models=[{provider:'deepseek-official',id:'deepseek-flash'}];
 assert.equal(await showLegacyModel(ctx),false,'Verified native host route, no legacy session');
 live=[agent];assert.equal(await showLegacyModel(ctx),true,'Last used route of a live session stays visible');
 pending={provider:'deepseek-official',model:'deepseek-v4-pro'};assert.equal(await showLegacyModel(ctx),false,'Explicit next selection overrides last used route');
 models=[{provider:'deepseek-official',id:'unverified-future-model'}];assert.equal(await showLegacyModel(ctx),true,'Unknown model is not compatibility evidence');
 ctx.llm.listModels=async()=>{throw Error('catalog unavailable');};assert.equal(await showLegacyModel(ctx),true,'Catalog failures fail open for legacy continuity');
 assert.equal(await showLegacyModel({}),true,'Missing host interfaces must not hide the only route');
});

test('legacy adapter keeps exact routing when compatibility catalog visibility changes',async()=>{
 let show=true;const adapter=createProjectModelAdapter({bridge:{},conversations:{},showLegacy:async()=>show});
 assert.match((await adapter.listModels(MODEL_PROVIDER))[0].name,/旧版.*兼容/);
 show=false;assert.deepEqual(await adapter.listModels(MODEL_PROVIDER),[]);
 assert.equal((await adapter.resolveModel(MODEL_PROVIDER,MODEL_ID)).id,MODEL_ID);
});
