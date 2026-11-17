import { createProjectContext } from './project-context.mjs';
import { authenticatedDesktopRequest } from './desktop-auth.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createBridge } from './bridge.mjs';
import { createBackendService } from './backend-service.mjs';
import { createToolEnvironment } from './tool-environment.mjs';
import { createProjectOperations } from './project-operations.mjs';
import { createConversationRoutes } from './conversations.mjs';
import { createNativeTools, TOOL_NAMES } from './native-tools.mjs';
import { createProjectModelAdapter, MODEL_PROVIDER } from './model-adapter.mjs';
import { showLegacyModel } from './legacy-model-catalog.mjs';
import { createTeamIntegration, TEAM_PROVIDER } from './teams.mjs';
import { createTeamToolAdmission } from './team-tool-admission.mjs';
import { createEditorBridge } from './editor-bridge.mjs';

export const name = 'dsh-plcdev';
export const inject = ['webServer', 'tools', 'llm', 'agents', 'sessionProjections', 'systemPrompt'];
const pluginVersion = createRequire(import.meta.url)('../package.json').version;

// Mirror the host list's visibility, without inventing titles or parentage.
// Unknown origin values fail closed instead of counting new host session types
// as user conversations.
export function hostSessionCatalog(records) {
  if (!Array.isArray(records)) throw new Error('Host session catalog invalid');
  return records.filter(row => row?.live === true || typeof row?.header?.cwd === 'string').map(row => {
    if (!row.header || (row.header.origin !== undefined && row.header.origin !== 'subagent'))
      throw new Error('Host session origin unknown');
    return { id: row.header.id, kind: row.header.origin === 'subagent' ? 'child' : 'main' };
  });
}

/** This plugin owns only HTTP routes; the independent controller owns Runtime. */
export function apply(ctx, config) {
  const fixed = Object.freeze({ controllerFile: config.controllerFile, projectRoot: config.projectRoot, timeoutMs: config.timeoutMs });
  const bridge = createBridge(fixed);
  const backendService = createBackendService({...fixed, bridge});
  const toolEnvironment = createToolEnvironment(fixed);
  const projectOperations = createProjectOperations({controllerFile: fixed.controllerFile, bridge});
  let sessionCatalog;
  ctx.inject(['sessionQuery'], catalogCtx => {
    sessionCatalog = catalogCtx.sessionQuery;
    catalogCtx.effect(() => () => { sessionCatalog = undefined; });
  });
  const conversations = createConversationRoutes({ controllerFile: fixed.controllerFile, bridge,
    visibleSessions: async () => {
      const service = sessionCatalog;
      if (typeof service?.listSessions !== 'function') throw new Error('Host session catalog unavailable');
      const records = await service.listSessions();
      if (service !== sessionCatalog || !Array.isArray(records)) throw new Error('Host session catalog changed');
      // Match DSH's own list visibility: attached sessions or persisted sessions
      // with a cwd. The durable origin identifies child sessions; a fork alone
      // does not make a user session a subagent.
      return hostSessionCatalog(records);
    } });
  let editorHost,editorBridge;
  const projectContext = createProjectContext({ ctx, conversations, getEditorPromptBinding:(id,rpcId)=>editorBridge?.promptBinding(id,rpcId) });
  ctx.inject(['sessionController','sessionQuery','sessions','sessionPersistence','agents','sessionProjections','workspaceRegistry'], editorCtx => {
    editorHost=editorCtx;
    editorCtx.effect(()=>()=>{if(editorHost===editorCtx)editorHost=undefined;});
  });
  editorBridge=createEditorBridge({controllerFile:fixed.controllerFile,bridge,conversations,getHost:()=>editorHost,getOrigin:()=>ctx.webServer.getOrigin(),getToolNotice:id=>projectContext.notice(id)});
  ctx.on('agent/assistant-stream',payload=>editorBridge.stream(payload));
  ctx.effect(()=>()=>editorBridge.dispose());
  for (const tool of createNativeTools({ bridge, conversations, projectContext })) ctx.effect(() => ctx.tools.register(tool,projectContext.toolRegistrationOptions));
  ctx.effect(() => ctx.llm.registerAdapter([MODEL_PROVIDER], createProjectModelAdapter({ bridge, conversations, projectContext,showLegacy:()=>showLegacyModel(ctx) })));
  ctx.inject(['agentTeams', 'agents', 'sessionProjections', 'sessions', 'sessionPersistence'], teamCtx => {
    const team = createTeamIntegration({ ctx: teamCtx, bridge, conversations });
    const admission=createTeamToolAdmission({ctx:teamCtx,team});
    for (const tool of team.tools) teamCtx.effect(() => teamCtx.tools.register(tool,admission.registrationOptions(tool.name)));
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
        const editorNative=path.startsWith('/api/plcdev/editor-bridge/');
        const editorGrant=editorNative?editorBridge.authenticate(req):null;
        if(editorNative&&!editorGrant){reply(401,{ok:false,code:'editor_connection_expired',error:'编辑器关联已失效，请从 DSH 工程重新打开。'});return;}
        if (['/api/plcdev/tool-environment','/api/plcdev/conversations/project','/api/plcdev/conversations/editor-navigation','/api/plcdev/conversations/editor-status','/api/plcdev/conversations/preview','/api/plcdev/project-operations','/api/plcdev/fuxa-recovery','/api/plcdev/project-inspection','/api/plcdev/runtime-events'].includes(path) && req.method === 'GET') {
          // Project-wide association enumeration needs a browser same-origin
          // request or the authenticated desktop owner, not an unmarked local GET.
          let browserOwner = req.headers.origin === origin;
          if (!browserOwner && req.headers['sec-fetch-site'] === 'same-origin' && typeof req.headers.referer === 'string') {
            try { browserOwner = new URL(req.headers.referer).origin === origin; } catch { /* reject */ }
          }
          if (!browserOwner && !authenticatedDesktopRequest(req, nativeConnection)) {
            reply(403, { error: '读取工程关联、操作回执或旧预览状态需要同源页面或已认证的桌面用户。' }); return;
          }
        }
        const assets = { '/api/plcdev/assets/openplc-logo.png': 'openplc-logo.png',
          '/api/plcdev/assets/eez-studio-logo.png': 'eez-studio-logo.png' };
        if (req.method === 'GET' && assets[path]) {
          reply(200, await readFile(resolve(fixed.projectRoot, 'software/workbench/assets', assets[path])), 'image/png'); return;
        }
        let body;
        if (req.method === 'POST') {
          if ((!editorGrant && req.headers.origin !== origin && !authenticatedDesktopRequest(req,nativeConnection)) || req.headers['content-type'] !== 'application/json') {
            reply(403, { error: '操作需要同源 JSON 请求。' }); return;
          }
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            const limit=['/api/plcdev/conversations/tasks','/api/plcdev/tasks'].includes(path)?1048576:131072;
            if (size > limit) { reply(413, { error: '请求过长。' }); return; }
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { reply(400, { error: '无效 JSON。' }); return; }
        }
        const editorRoutes=['/api/plcdev/conversations/editor-open','/api/plcdev/conversations/result-resource-open','/api/plcdev/conversations/result-resource-status','/api/plcdev/conversations/editor-session','/api/plcdev/conversations/editor-status','/api/plcdev/conversations/preview','/api/plcdev/conversations/editor-navigation'];
        const result = editorNative
          ? await editorBridge.native(req.method,path.slice('/api/plcdev/editor-bridge'.length),body,editorGrant)
          : editorRoutes.includes(path)
          ? await editorBridge.handle(req.method,req.url,body)
          : path === '/api/plcdev/tool-environment'
          ? await toolEnvironment.handle(req.method, req.url)
          : path === '/api/plcdev/backend/connect'
          ? await backendService.handle(req.method, req.url, body)
          : path === '/api/plcdev/project-operations'
          ? await projectOperations.handle(req.method, req.url, body)
          : path.startsWith('/api/plcdev/conversations')
          ? await conversations.handle(req.method, req.url, body)
          : await bridge.handle(req.method, req.url, body);
        if (path === '/api/plcdev/conversations' && result.status === 200)
          result.body = {...result.body, modelCapability:projectContext.notice(result.body.conversationId)};
        if (path === '/api/plcdev/health') result.body = { ...result.body, hostInstance, hostPid: process.pid, pluginVersion, conversationApiVersion: 1, nativeAgent: { modelIndependent:true, legacyRouteAvailable:true, tools: TOOL_NAMES.length } };
        reply(result.status, result.body);
      } catch {
        reply(503, { error: 'PLCdev 连接未就绪，请检查独立后台。' });
      }
    },
  }));
}
