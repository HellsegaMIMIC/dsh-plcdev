import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, appendFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const name = 'plcdev-development-model';
export const inject = ['llm', 'agents', 'workingDirectory', 'tools'];
export const PROVIDER = 'plcdev-development';
export const MODEL = 'plugin-developer';
export const TOOLS = ['cordis_inspect_list','cordis_inspect_query','read','write','edit','pwsh','skill','plugin_manager'];
const text = message => (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const canonical = value => realpathSync.native(value).replaceAll('\\','/').toLowerCase();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only host-owned session/directory metadata may be passed as execution. */
export function validateDevelopmentContext(scope, execution) {
  if (scope.externalModelApproved !== true || !scope.approvedSessionId ||
      !Number.isSafeInteger(scope.approvedSessionCreatedAt) ||
      execution?.sessionId !== scope.approvedSessionId ||
      execution.createdAt !== scope.approvedSessionCreatedAt || execution.isSeeded !== false)
    throw new Error('Development session is not explicitly approved.');
  if (!isAbsolute(scope.workspace || '') || !isAbsolute(execution.cwd || '') ||
      canonical(execution.cwd) !== canonical(scope.workspace))
    throw new Error('Development session working directory changed.');
}

/** Recheck at dispatch, after native approval queues and any workspace changes. */
export function createExecutionGate(readScope, readExecution) {
  const initialSession = readScope().approvedSessionId;
  const pending = new Map(), protectedSessions = new Set(initialSession ? [initialSession] : []);
  const key = (id, callId) => JSON.stringify([id, callId]);
  function verify(id) {
    const scope = readScope(), execution = readExecution(id);
    if (execution?.sessionId !== id) throw new Error('Native development session is unavailable.');
    validateDevelopmentContext(scope, execution);
    protectedSessions.add(id);
    return {scope, execution, scopeDigest:digest(scope)};
  }
  return {
    verify,
    admit(id, call, scopeDigest) {
      const current = verify(id);
      if (current.scopeDigest !== scopeDigest) throw new Error('Development authorization changed during the model request.');
      const args = validateCall(call, current.scope);
      const normalized = {...call, function:{...call.function, arguments:JSON.stringify(args)}};
      pending.set(key(id,call.id), {name:call.function.name, argsDigest:digest(args), scopeDigest});
      return normalized;
    },
    guard(exec) {
      const id = exec.agent?.session?.id;
      if (!protectedSessions.has(id)) return;
      try {
        const current = verify(id), record = pending.get(key(id,exec.callId));
        if (!record || record.name !== exec.name || record.scopeDigest !== current.scopeDigest || record.argsDigest !== digest(exec.arguments))
          throw new Error('Development tool call is not admitted for this session.');
        const normalized = validateCall({type:'function',function:{name:exec.name,arguments:JSON.stringify(exec.arguments)}},current.scope);
        if (digest(normalized) !== record.argsDigest) throw new Error('Development execution path changed.');
      } catch (error) { return error.message; }
    },
    finish(exec) { pending.delete(key(exec.agent?.session?.id,exec.callId)); },
  };
}

/** Validate before a model call reaches the native Agent loop/tool executor. */
export function validateCall(call, scope) {
  if (call.type !== 'function' || !TOOLS.includes(call.function?.name)) throw new Error('Development tool is outside the scoped route.');
  const args = JSON.parse(call.function.arguments), tool = call.function.name;
  if (args.sandbox_permissions && args.sandbox_permissions !== 'use_default') throw new Error('Model cannot request broader access.');
  if (['read','write','edit'].includes(tool)) {
    if (!isAbsolute(scope.workspace || '') || typeof args.file_path !== 'string' || !args.file_path) throw new Error('An explicit development file is required.');
    const candidate = resolve(scope.workspace, args.file_path ?? '');
    const allowed = tool === 'read' ? scope.readFiles : scope.writeFiles;
    // Existing, explicitly staged files only; no new arbitrary paths or symlink escape.
    if (!allowed.some(file => canonical(file) === canonical(candidate))) throw new Error('Development file is outside the staged file list.');
    args.file_path = realpathSync.native(candidate);
  } else if (tool === 'pwsh') {
    if (!scope.commands.includes(args.command?.trim()) || canonical(resolve(scope.workspace,args.workdir || '.')) !== canonical(scope.workspace) || args.run_in_background)
      throw new Error('Only the declared local build/package commands are allowed.');
    args.workdir = realpathSync.native(scope.workspace);
  } else if (tool === 'skill') {
    if (args.name !== 'cordis-plugin-development') throw new Error('Only the official plugin development skill is in scope.');
  } else if (tool === 'plugin_manager') {
    if (!['list_plugins','list_bundles'].includes(args.action)) throw new Error('Installation is performed explicitly after code review.');
  }
  return args;
}

export function developmentRequest(options, scope, execution) {
  if (options.provider !== PROVIDER || options.model !== MODEL || options.purpose || typeof options.sessionId !== 'string') throw new Error('Development route requires a native user conversation.');
  if (execution?.sessionId !== options.sessionId) throw new Error('Native development session is unavailable.');
  validateDevelopmentContext(scope, execution);
  const messages = [], calls = new Set();
  // Only this development provider's text and its allowlisted tool results.
  // Host system context, other conversations, attachments and engineering tools are excluded.
  for (const message of options.messages ?? []) {
    if (message.role === 'user' && (!message.source || message.source.kind === 'user')) {
      if (message.content.some(b => b.type !== 'text')) throw new Error('Development route accepts text only.');
      messages.push({role:'user',content:text(message)});
    } else if (message.role === 'assistant' && message.source?.provider === PROVIDER) {
      const tool_calls = (message.content ?? []).filter(b => b.type === 'tool-call').map(b => {
        const call = {id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}};
        validateCall(call,scope); calls.add(b.id); return call;
      });
      if (tool_calls.length || text(message)) messages.push({role:'assistant',content:text(message)||null,...(tool_calls.length?{tool_calls}:{})});
    } else if (message.role === 'tool' && calls.has(message.source?.callId)) {
      messages.push({role:'tool',tool_call_id:message.source.callId,content:text(message)});
    }
  }
  const tools = (options.tools ?? []).filter(t => TOOLS.includes(t.name)).map(t => ({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));
  if (!['cordis_inspect_list','cordis_inspect_query','read','edit','pwsh','plugin_manager'].every(name=>tools.some(t=>t.function.name===name))) throw new Error('Select the native creation (cordis) mode to use this model.');
  return {conversationId:options.sessionId,sessionCreatedAt:execution.createdAt,workspace:realpathSync.native(execution.cwd),messages,tools,maxTokens:8192};
}

export function apply(ctx, config) {
  if (!config.scopeFile || !config.python || !config.broker) throw new Error('Development route requires an explicit isolated scope.');
  const readScope = () => JSON.parse(readFileSync(config.scopeFile,'utf8').replace(/^\uFEFF/,''));
  const scope = readScope();
  if (scope.kind !== 'plcdev-plugin-p1' || !scope.workspace) throw new Error('Invalid plugin development scope.');
  const gate = createExecutionGate(readScope, id => {
    const agent = ctx.agents.get(id);
    if (!agent) return null;
    return {sessionId:agent.session.id,createdAt:agent.session.header.createdAt,
      isSeeded:agent.session.header.isSeeded,cwd:ctx.workingDirectory.get(agent.session)};
  });
  ctx.effect(()=>ctx.tools.guard(exec=>gate.guard(exec)));
  ctx.on('tools/result',exec=>gate.finish(exec));
  const info = {provider:PROVIDER,id:MODEL,name:'DeepSeek · PLCdev 插件开发（隔离）',inputModalities:['text'],contextWindow:128000,maxTokens:8192};
  const adapter = {
    providerInfo:provider=>({id:provider,name:'PLCdev 插件开发（隔离）'}),
    providerRetryPolicy:()=>({mode:'normal',maxRetries:0,retryableCodes:[],initialDelayMs:500,maxDelayMs:1000,jitterRatio:0}),
    imageRequestPricing:()=>undefined,
    imageRequestTarget:()=>{throw new Error('No image upload in development scope.');},
    async listModels(provider){return provider===PROVIDER?[info]:[];},
    async resolveModel(provider,model,signal){signal?.throwIfAborted();if(provider!==PROVIDER||model!==MODEL)throw new Error('Unknown development route.');return info;},
    async prepareCall(provider,model,signal){return {model:await adapter.resolveModel(provider,model,signal),stream:options=>adapter.stream(options)};},
    async *stream(options){
      options.signal?.throwIfAborted();
      const approved = gate.verify(options.sessionId);
      const request = developmentRequest(options,approved.scope,approved.execution);
      const result = await new Promise((done,reject)=>{
        const child=spawn(config.python,['-B','-X','utf8',config.broker,'--scope',config.scopeFile],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal:options.signal});
        let output='',size=0;
        child.stdout.on('data',data=>{size+=data.length;if(size>2097152)child.kill();else output+=data.toString('utf8');});
        child.stderr.resume();
        child.on('error',()=>reject(new Error('Development broker could not start.')));
        child.on('close',code=>{try{const value=JSON.parse(output);if(code!==0||!value.ok)throw new Error(value.error||'Development call failed.');done(value);}catch(error){reject(error);}});
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
      });
      const message=result.completion?.choices?.[0]?.message;
      if (!message) throw new Error('Development model returned no message.');
      const latest=gate.verify(options.sessionId);
      if(latest.scopeDigest!==approved.scopeDigest)throw new Error('Development authorization changed during the model request.');
      const calls=(message.tool_calls??[]).map(call=>gate.admit(options.sessionId,call,approved.scopeDigest));
      appendFileSync(approved.scope.traceFile,JSON.stringify({event:'model_response',conversationId:request.conversationId,at:new Date().toISOString(),calls:calls.map(c=>({id:c.id,name:c.function.name,argsDigest:createHash('sha256').update(c.function.arguments).digest('hex')})),usage:result.completion.usage})+'\n');
      const blocks=[];
      if(message.content)blocks.push({type:'text',text:message.content});
      for(const call of calls)blocks.push({type:'tool-call',id:call.id,name:call.function.name,arguments:call.function.arguments});
      for(let index=0;index<blocks.length;index++){
        const block=blocks[index];yield {type:'block-start',index,blockType:block.type};
        yield block.type==='text'?{type:'text-delta',index,text:block.text}:{type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};
        yield {type:'block-end',index,block};
      }
      const usage=result.completion.usage;
      if(usage)yield {type:'usage',usage:{inputTokens:Math.max(0,usage.prompt_tokens-(usage.prompt_cache_hit_tokens??0)),outputTokens:usage.completion_tokens,cacheReadTokens:usage.prompt_cache_hit_tokens??0,totalTokens:usage.total_tokens}};
      yield {type:'finish',reason:{kind:blocks.some(b=>b.type==='tool-call')?'tool-calls':result.completion.choices[0].finish_reason==='length'?'max-tokens':'stop'}};
    },
  };
  ctx.effect(()=>ctx.llm.registerAdapter([PROVIDER],adapter));
}
