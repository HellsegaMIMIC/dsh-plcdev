import { createProjectContext } from './project-context.mjs';
import { authenticatedDesktopRequest } from './desktop-auth.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createBridge } from './bridge.mjs';
import { createConversationRoutes } from './conversations.mjs';
import { createNativeTools } from './native-tools.mjs';
import { createProjectModelAdapter, MODEL_PROVIDER } from './model-adapter.mjs';
import { createTeamIntegration, TEAM_PROVIDER } from './teams.mjs';

export const name = 'dsh-plcdev';
export const inject = ['webServer', 'tools', 'llm', 'agents', 'sessionProjections', 'systemPrompt'];
const pluginVersion = createRequire(import.meta.url)('../package.json').version;

/** This plugin owns only HTTP routes; the independent controller owns Runtime. */
export function apply(ctx, config) {
  const fixed = Object.freeze({ controllerFile: config.controllerFile, projectRoot: config.projectRoot, timeoutMs: config.timeoutMs });
  const bridge = createBridge(fixed);
  const conversations = createConversationRoutes({ controllerFile: fixed.controllerFile, bridge });
  const projectContext = createProjectContext({ ctx, conversations });
  for (const tool of createNativeTools({ bridge, conversations, projectContext })) ctx.effect(() => ctx.tools.register(tool));
  ctx.effect(() => ctx.llm.registerAdapter([MODEL_PROVIDER], createProjectModelAdapter({ bridge, conversations, projectContext })));
  ctx.inject(['agentTeams', 'agents', 'sessionProjections', 'sessions', 'sessionPersistence'], teamCtx => {
    const team = createTeamIntegration({ ctx: teamCtx, bridge, conversations });
    for (const tool of team.tools) teamCtx.effect(() => teamCtx.tools.register(tool));
    teamCtx.effect(() => teamCtx.tools.guard(team.guard));
    teamCtx.effect(() => teamCtx.llm.registerAdapter([TEAM_PROVIDER], team.adapter));
  });
  let nativeConnection;
  ctx.inject(['connection'], nativeCtx => { nativeConnection=nativeCtx.connection; nativeCtx.effect(()=>()=>{nativeConnection=undefined;}); });
  const hostInstance = randomUUID();
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/plcdev',
    async handler(req, res) {
      const reply = (status, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff' });
        res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      try {
        if (config.controllerFile !== fixed.controllerFile || config.projectRoot !== fixed.projectRoot || config.timeoutMs !== fixed.timeoutMs) {
          reply(409, { error: 'PLCdev 插件配置已变化，请重新加载插件后继续。' }); return;
        }
        const origin = ctx.webServer.getOrigin();
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || req.headers.host !== new URL(origin).host ||
            (req.headers.origin && req.headers.origin !== origin) ||
            (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
          reply(403, { error: '只允许本机工作台同源访问。' }); return;
        }
        const path = new URL(req.url, origin).pathname;
        const assets = { '/api/plcdev/assets/openplc-logo.png': 'openplc-logo.png',
          '/api/plcdev/assets/eez-studio-logo.png': 'eez-studio-logo.png' };
        if (req.method === 'GET' && assets[path]) {
          reply(200, await readFile(resolve(fixed.projectRoot, 'software/workbench/assets', assets[path])), 'image/png'); return;
        }
        let body;
        if (req.method === 'POST') {
          if ((req.headers.origin !== origin && !authenticatedDesktopRequest(req,nativeConnection)) || req.headers['content-type'] !== 'application/json') {
            reply(403, { error: '操作需要同源 JSON 请求。' }); return;
          }
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 131072) { reply(413, { error: '请求过长。' }); return; }
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { reply(400, { error: '无效 JSON。' }); return; }
        }
        const result = path.startsWith('/api/plcdev/conversations')
          ? await conversations.handle(req.method, req.url, body)
          : await bridge.handle(req.method, req.url, body);
        if (path === '/api/plcdev/conversations' && result.status === 200)
          result.body = {...result.body, modelCapability:projectContext.notice(result.body.conversationId)};
        if (path === '/api/plcdev/health') result.body = { ...result.body, hostInstance, hostPid: process.pid, pluginVersion, conversationApiVersion: 1, nativeAgent: { provider: MODEL_PROVIDER, model: 'project-agent', tools: 3 } };
        reply(result.status, result.body);
      } catch {
        reply(503, { error: 'PLCdev 连接未就绪，请检查独立后台。' });
      }
    },
  }));
}
