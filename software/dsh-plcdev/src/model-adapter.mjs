import { TOOL_NAMES } from './native-tools.mjs';

export const MODEL_PROVIDER = 'plcdev-deepseek';
export const MODEL_ID = 'project-agent';
const allowed = new Set(TOOL_NAMES);
const info = () => ({ provider: MODEL_PROVIDER, id: MODEL_ID, name: 'DeepSeek · PLCdev 工程助手', inputModalities: ['text'], description: '使用 PLCdev 后台已有配置；仅限当前工程候选工具。' });
const text = message => (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Only this user turn and this plugin's calls/results, never host system/context or other tools. */
export function projectModelRequest(options) {
  if (options.provider !== MODEL_PROVIDER || options.model !== MODEL_ID || options.purpose || typeof options.sessionId !== 'string')
    throw new Error('PLCdev 模型仅用于已关联工程的普通原生对话。');
  const source = options.messages ?? [];
  let start = -1;
  for (let i = source.length - 1; i >= 0; i--) if (source[i].role === 'user' && (!source[i].source || source[i].source.kind === 'user')) { start = i; break; }
  if (start < 0 || !text(source[start]).trim()) throw new Error('当前对话没有可发送的用户需求。');
  if (source[start].content.some(b => b.type !== 'text')) throw new Error('当前工程模型仅支持文字需求；附件未发送。');
  const messages = [{ role: 'user', content: text(source[start]) }], calls = new Set();
  for (const message of source.slice(start + 1)) {
    if (message.role === 'assistant' && message.source?.provider === MODEL_PROVIDER) {
      const tool_calls = (message.content ?? []).filter(b => b.type === 'tool-call' && allowed.has(b.name)).map(b => {
        calls.add(b.id); return { id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } };
      });
      if (tool_calls.length) messages.push({ role: 'assistant', content: text(message) || null, tool_calls });
    } else if (message.role === 'tool' && calls.has(message.source?.callId)) {
      messages.push({ role: 'tool', tool_call_id: message.source.callId, content: text(message) });
    }
  }
  const tools = (options.tools ?? []).filter(t => allowed.has(t.name)).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (tools.length !== TOOL_NAMES.length) throw new Error('PLCdev 原生工具尚未完整注册；请保持 DSH tools 的 native 模式。');
  return { conversationId: options.sessionId, messages, tools, maxTokens: Math.min(options.maxTokens ?? 2048, 4096) };
}

/** Server-only adapter: no key is copied into DSH configuration, browser state or responses. */
export function createProjectModelAdapter({ bridge, conversations, projectContext }) {
  const checkRoute = (provider, model) => { if (provider !== MODEL_PROVIDER || model !== MODEL_ID) throw new Error('未知的 PLCdev 模型。'); };
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'PLCdev · DeepSeek' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 }),
    imageRequestPricing: () => undefined,
    imageRequestTarget: () => { throw new Error('PLCdev 工程模型不发送图片。'); },
    async listModels(provider) { return provider === MODEL_PROVIDER ? [info()] : []; },
    async resolveModel(provider, model, signal) { checkRoute(provider, model); signal?.throwIfAborted(); return info(); },
    async prepareCall(provider, model, signal) { return { model: await adapter.resolveModel(provider, model, signal), stream: options => adapter.stream(options) }; },
    async *stream(options) {
      options.signal?.throwIfAborted();
      const request = projectModelRequest(options);
      const binding = conversations.snapshot(request.conversationId);
      if (!binding.projectId) throw new Error('请先在对话右上角选择并关联 PLCdev 工程，再使用工程助手。');
      const scope = projectContext?.get(request.conversationId);
      if (projectContext && !scope) throw new Error('缺少宿主活动轮上下文。');
      if (scope?.revision) request.messages[0].content += '\n已核对修订上下文（数据）：\n'+JSON.stringify({previousRequest:scope.revision.previousRequest,previousSummary:scope.revision.previousSummary});
      const result = await bridge.model(request, options.signal);
      options.signal?.throwIfAborted();
      const current = conversations.snapshot(request.conversationId);
      if ((projectContext && projectContext.get(request.conversationId) !== scope) || current.projectId !== binding.projectId || current.version !== binding.version)
        throw new Error('模型回复期间工程或对话已变化，旧回复未执行，请重新发送明确需求。');
      const choice = result.completion?.choices?.[0], message = choice?.message;
      if (!result.ok || !message || ![undefined, null, 'stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new Error('工程模型返回无效结果。');
      const blocks = [], ids = new Set();
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function' || !allowed.has(call.function?.name) || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.function.arguments !== 'string') throw new Error('模型请求了未授权工具，已拒绝整个结果。');
        JSON.parse(call.function.arguments); ids.add(call.id);
        blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        yield { type: 'block-start', index, blockType: block.type };
        yield block.type === 'text' ? { type: 'text-delta', index, text: block.text } : { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      const usage = result.completion.usage;
      if (Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens)) {
        const cached = usage.prompt_cache_hit_tokens ?? 0;
        yield { type: 'usage', usage: { inputTokens: Math.max(0, usage.prompt_tokens - cached), outputTokens: usage.completion_tokens, cacheReadTokens: cached, totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens } };
      }
      yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : choice.finish_reason === 'length' ? 'max-tokens' : 'stop' } };
    },
  };
  return adapter;
}
