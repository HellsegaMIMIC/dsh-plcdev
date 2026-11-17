// Offline host integration adapter: execute the installed, hash-inspected
// SessionController.prompt and SessionCommandController.prompt without mounting
// the remote gateway/UI services. Only attachment admission (plain text) and
// disk snapshot persistence are fixture infrastructure; the actual native Agent,
// inbox, event log, model loop, executor and PLCdev tools remain in use.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export async function nativeSessionHost({require,ctx,agent,dir}) {
  const {default:SessionQuery}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-query')).href);
  await ctx.plugin(SessionQuery);
  const {WorkspaceRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-workspace')).href);
  // Exercise the installed registry's canonical path and header validation.
  // Its storage table is a fixture; registration/membership methods are real.
  const workspaceRegistry=new WorkspaceRegistry(ctx),records=new Map();
  workspaceRegistry.table={get:id=>records.get(id),put:async(id,value)=>{records.set(id,value);return value;},
    delete:async id=>records.delete(id),update:async(id,fn)=>{const next=fn(records.get(id));records.set(id,next);return next;}};
  workspaceRegistry.global={set:async()=>{}};
  workspaceRegistry.state={initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]};
  const workspace=await workspaceRegistry.create(dir,'Offline editor project');
  await workspace.attachSession(agent.id);assert.ok(workspace.sessionIds.includes(agent.id));
  assert.equal((await workspaceRegistry.create(dir,'Do not duplicate')).id,workspace.id);
  const entry=require.resolve('@deepseek-ai/dsh-api-session-controller');
  const source=await readFile(entry,'utf8');
  assert.ok(/(?:class SessionCommandController|SessionCommandController = class)/.test(source));
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const access=path.join(path.dirname(entry),'plcdev-test-access.mjs');
  // An export-only shim; no prompt implementation is replaced.
  await writeFile(access,source+'\nexport { SessionCommandController };\n');
  const {SessionController,SessionCommandController}=await import(pathToFileURL(access).href);
  const promptContext={agents:ctx.agents,attachments:{admitPromptContent:async content=>content},
    fileUploads:{resolve(){throw Error('No attachments in this fixture');},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})}};
  const commands=new SessionCommandController(promptContext,{resolveAgent:async id=>{
    assert.equal(id,agent.id);return {agent};
  }},dir);
  const native={ctx:promptContext,commands};
  let promptCalls=0;
  const snapshot=path.join(dir,'editor-session-log.json');
  return {sourceHash,entry,get promptCalls(){return promptCalls;},
    agents:ctx.agents,sessionProjections:ctx.sessionProjections,workspaceRegistry,
    sessionQuery:ctx.sessionQuery,
    sessionController:{resolveAgent:async id=>{assert.equal(id,agent.id);return {agent};},
      prompt:async(request,signal)=>{promptCalls++;return SessionController.prototype.prompt.call(native,request,signal);},
      cancel:request=>commands.cancel(request)},
    sessions:{get:id=>id===agent.id?agent.session:undefined,flush:async session=>{
      assert.equal(session,agent.session);await writeFile(snapshot,JSON.stringify({header:session.header,events:session.snapshotEvents()}));return true;
    }},
    sessionPersistence:{open:async id=>{assert.equal(id,agent.id);const saved=JSON.parse(await readFile(snapshot,'utf8'));return {header:saved.header,read:async()=>({events:saved.events}),close:async()=>{}};}}
  };
}
