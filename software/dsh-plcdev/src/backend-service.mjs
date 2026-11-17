import {execFile} from 'node:child_process';
import {readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (status, code, error) => ({status, body:{ok:false, connected:false, code, error}});
const launch = (file, args, options) => new Promise((resolve, reject) => {
  // ensure prints a capability-bearing URL. Neither output nor errors may reach
  // a browser, log, or response; only the authenticated health probe is returned.
  execFile(file, args, options, error => error ? reject(error) : resolve());
});
class SetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function configuredPython(root, environment) {
  const load = async file => {
    const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!record(value) || value.schemaVersion !== 1 || (value.tools !== undefined && !record(value.tools))) throw new Error('Invalid environment');
    return value.tools || {};
  };
  let tools;
  try {
    tools = await load(path.join(root, 'config/environment.defaults.json'));
    const selected = path.resolve(root, environment.PLCDEV_ENVIRONMENT_CONFIG || 'outputs/local/environment.json');
    try { tools = {...tools, ...await load(selected)}; }
    catch (error) { if (environment.PLCDEV_ENVIRONMENT_CONFIG || error.code !== 'ENOENT') throw error; }
  } catch { throw new SetupError('backend_environment_invalid', 'PLCdev 本机工具配置无法读取，请检查环境配置。'); }
  // Do not discover an unrelated Python through PATH or download dependencies.
  if (typeof tools.python !== 'string' || !tools.python.trim() || /[\x00-\x1f]/.test(tools.python))
    throw new SetupError('python_not_configured', '尚未配置 PLCdev 使用的 Python，请在本机环境配置中指定 tools.python。');
  let configured = tools.python.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g,
    (match, first, second, third) => environment[first || second || third] ?? match);
  if (/\$|%/.test(configured)) throw new SetupError('python_not_configured', 'PLCdev 的 Python 路径包含未定义的环境变量。');
  try {
    configured = await realpath(path.resolve(root, configured));
    if (!(await stat(configured)).isFile() || (process.platform === 'win32' && path.extname(configured).toLowerCase() !== '.exe')) throw new Error('Invalid executable');
  } catch { throw new SetupError('python_unavailable', '已配置的 Python 不存在，无法启动 PLCdev 后台。'); }
  return configured;
}

/** Explicit browser action only. The bridge remains a process-free proxy. */
export function createBackendService({projectRoot, controllerFile, bridge}, dependencies = {}) {
  const execute = dependencies.launch || launch;
  const environment = {...(dependencies.environment || process.env)};
  const root = path.resolve(projectRoot), descriptor = path.resolve(controllerFile);
  let connecting;
  async function connect() {
    const current = await bridge.handle('GET', '/api/plcdev/health');
    if (current.status === 200) return current;
    // A live but incompatible or foreign backend must never be replaced.
    if (!['controller_unavailable', 'upstream_unavailable'].includes(current.body?.code)) return current;
    try {
      if (path.basename(descriptor) !== 'controller.json') throw new SetupError('backend_configuration_invalid', '后台描述文件必须使用 controller.json；请检查插件配置。');
      const actualRoot = await realpath(root);
      const script = await realpath(path.join(root, 'tools/plcdev_workbench.py'));
      const relative = path.relative(actualRoot, script);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(script)).isFile())
        throw new SetupError('backend_configuration_invalid', '后台启动入口不属于当前 PLCdev 目录，已拒绝启动。');
      const python = await configuredPython(root, environment);
      const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
        !/^(OPENPLC_|PYTHON|MSYSTEM)/i.test(key) && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key.toUpperCase())));
      env.PLCDEV_WORKBENCH_HOME = path.dirname(descriptor);
      // ensure serializes launches and refuses incompatible existing services.
      // It does not prepare, run, stop, or adopt a Runtime session.
      await execute(python, ['-B', '-X', 'utf8', script, 'ensure'], {
        cwd:actualRoot, env, shell:false, windowsHide:true, timeout:35000, maxBuffer:262144,
      });
    } catch (error) {
      if (error instanceof SetupError) return failure(503, error.code, error.message);
      if (error?.killed || error?.code === 'ETIMEDOUT') return failure(503, 'backend_connect_timeout', '后台连接超时，请重新读取状态；未停止任何运行实例。');
      return failure(503, 'backend_launch_failed', 'PLCdev 后台未能启动，请检查本机工具配置和后台日志；未停止任何运行实例。');
    }
    const result = await bridge.handle('GET', '/api/plcdev/health');
    // bridge authenticates the descriptor's root, instance, service and schema.
    return result;
  }
  return Object.freeze({
    async handle(method, rawPath, body) {
      const url = new URL(rawPath, 'http://127.0.0.1');
      if (method !== 'POST' || url.pathname !== '/api/plcdev/backend/connect' || url.search || !record(body) || Object.keys(body).length)
        return failure(400, 'invalid_request', '后台连接操作不接受额外参数。');
      if (!connecting) connecting = connect().finally(() => { connecting = undefined; });
      return connecting;
    },
  });
}
