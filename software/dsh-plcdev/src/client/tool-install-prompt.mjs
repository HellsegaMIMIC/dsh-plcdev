import {toolDistributions,toolInstallGroups} from './tool-distributions.mjs';

const INSTALL_GUIDE='https://github.com/HellsegaMIMIC/dsh-plcdev/blob/main/docs/INSTALL.md';
const TOOL_RELEASE='v2026.11.17-preview.1';

const requirements={
  openplc:[
    '优先 OpenPLC 4.3.2 的 DSH 中文编辑预览。便携 ZIP 只提供编辑预览，不包含完整编译工具链；不要把 EXE 可打开当作 AI 编辑、编译或运行均已可用。',
    'DSH 共用原生编辑工具还需要匹配的公开适配源码位于当前 PLCdev 根目录的 software/openplc-editor-zh，并安装其锁定依赖、检查 scripts/build-agent-tools.cjs 与 scripts/agent-tools-sources.json。已有源码目录先核对，不能直接覆盖。分别按编辑器和工程服务各自的 README/engines 选择 Node/Python，不假定同一版本适合所有构建。',
    '编译与运行另需匹配的 OpenPLC Runtime 和 MSYS；本次先核对这些依赖，缺项明确列出。tools.editor 应指向实际的 OpenPLC Editor.exe。',
  ],
  fuxa:[
    '优先 FUXA 1.3.5 中文与集成补丁包。它是首次需联网的安装包，不包含 Node.js/FUXA 二进制；按包内 README 和锁文件安装，不能换成 npm latest。',
    'tools.fuxaPackage 指向包含 main.js 的实际 FUXA 包目录。集成权限检查还依赖匹配的原生文件指纹，以及 software/openplc-editor-zh 中锁定的 TypeScript/JSDOM；缺少时先核对公开 OpenPLC 适配源码说明。独立 FUXA profile 与 PLCdev 工程 profile 分开保留。',
  ],
  oip:[
    '优先我们的 OIP 中文补丁与适配说明，但 DSH 桥接要求官方原版 2026.11.9 的精确文件指纹。官方下载为滚动版本，不能假定当前下载仍是 2026.11.9；找不到匹配版本就报告阻塞，不改版本号、不跳过哈希校验。',
    '原版、中文副本、DSH 受管桥接副本必须分开。tools.oipExecutable 配置匹配的原版 EXE，不能填已汉化或已桥接的副本；中文副本修改主进程后不能假定兼容 DSH 桥接。保留原安装和独立 profile，不启动场景。',
    '检查当前 PLCdev/OIP 适配代码是否仍固定 F 盘临时路径；没有对应盘符时明确列为适配缺口，不伪造盘符或擅自迁移状态，也不把安装文件存在说成桥接已可用。',
  ],
  runtime:[
    'OpenPLC Runtime 是 PLC 执行环境，属于必要运行依赖，并不是 OpenPLC Editor。当前记录的核查基线为 v4.3.0；先对照当前 PLCdev 适配说明和官方 README 确认兼容版本，不能把任意最新 Runtime 当作已兼容。',
    'tools.runtime 应指向安装中的 openplc-runtime 目录，检查 VERSION、core、scripts 及所需构建入口；不要填编辑器 EXE。核对配套 MSYS 是否齐全。保留现有 state.runtimeOwnerDirectory，不改目录绕过占用。此次不启动 Runtime 或装载程序。',
  ],
  msys:[
    '准备与已选 OpenPLC Runtime Windows 版本匹配的 MSYS 和构建工具。它不包含在 DSH 编辑便携包中，不能仅安装任意 MSYS2 就宣布兼容；按照 Runtime 官方安装说明和当前 PLCdev 适配要求核对。',
    'tools.msys 指向实际 msys64 目录，检查 usr/bin 下的 bash、g++、cmake 和 make；核对 Runtime 的构建脚本需要的其他依赖。只做入口、版本与环境检查，此次不编译/装载用户程序或运行 PLC。',
  ],
};

function toolSection(tool){
  const sources=[`说明：${tool.installation||`${tool.repository}/releases/tag/${TOOL_RELEASE}`}`];
  if(tool.download)sources.push(`下载入口：${tool.download}`);
  if(tool.id==='oip')sources.push(`官方原版来源：${tool.official}`);
  return [`${tool.name}：`,...requirements[tool.id],...sources].join('\n');
}

/** Copyable instructions only: no I/O, credentials, installation or execution. */
export function buildToolInstallPrompt(toolId='all'){
  if(typeof toolId!=='string'||toolId!=='all'&&!Object.hasOwn(requirements,toolId))throw new RangeError('不支持的工具安装范围。');
  const group=toolInstallGroups.find(tool=>tool.id===toolId);
  const selected=toolId==='all'?toolDistributions:toolDistributions.filter(tool=>group?group.members.includes(tool.id):tool.id===toolId);
  const scope=toolId==='all'?'PLCdev 的 OpenPLC、FUXA、OIP、OpenPLC Runtime 和配套 MSYS':group?.name||selected[0].name;
  return [
    `请帮我检测并补齐 ${scope}，完成下载、安装和 PLCdev 本机路径配置。先检测再补缺，复用兼容的已有安装，不重新安装整套环境。`,
    `1. 先定位当前 DSH 使用的 PLCdev 根目录，读取真实 README、安装说明、工具发行说明及环境配置脚本。公开安装说明：${INSTALL_GUIDE}。不要切换或覆盖当前工程；单项安装只处理所选工具及必要依赖，其他缺项列出即可。`,
    '2. 只读检查已有工具版本、入口、当前本机配置和可用磁盘。下载、构建和缓存优先选择空间足够的非系统盘；检测到 F 盘时可优先使用，但不要假定每台电脑都有 F 盘。有合适目录就沿用，没有合适目录或有路径冲突时先询问我。不要复制说明中的维护者安装路径。',
    '3. 使用下列固定发行来源，先读对应 README/Release 和安装脚本，再下载缺项并核对版本、发行校验和或签名。没有提供校验依据的项目明确标为未核验；版本或指纹不匹配时停止该项，不能绕过检查。',
    ...selected.map(toolSection),
    '4. 保全已有工程、候选、会话、profile 和本机设置；修改配置前保留可恢复副本。不要覆盖整个环境配置、迁移用户数据、替换日常 DSH profile，或读取、复制、展示模型密钥/登录凭据。若安装器将升级已有组件、覆盖目录或启动运行服务，先说明具体影响并取得确认。',
    `5. 按本仓库实际支持的环境配置方式，将检测到的真实路径写入本机配置（通常为 outputs/local/environment.json）；仅更新本次相关 tools 字段：${selected.map(tool=>tool.key).join('、')}，其余字段保留。优先使用现有配置入口/脚本；确需编辑 JSON 时由你校验并完成，不要求我手写。已有配置不重复执行会拒绝覆盖的 init；默认配置中的路径只是线索，不能直接当作实际安装位置。`,
    '6. 完成后重新进行只读环境检测，逐项汇报工具、版本、实际目录、来源/校验结果、入口检查和未解决依赖。仅确认安装入口与环境，不擅自启动真实 PLC Runtime、装载/下载程序、强制 I/O、运行 OIP 场景或操作硬件；不要把“入口已找到”写成“编译/运行验收通过”。',
  ].join('\n\n');
}
