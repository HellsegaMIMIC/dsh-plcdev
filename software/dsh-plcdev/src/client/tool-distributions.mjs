// Download targets are explicit release/install sources; never infer compatibility
// from a file existing locally or a download link being opened.
export const toolDistributions=[
  {id:'openplc',key:'editor',name:'OpenPLC',edition:'4.3.2 · DSH 中文编辑预览（Windows x64，不含完整编译工具链）',kind:'编辑预览包',repository:'https://github.com/HellsegaMIMIC/openplc-editor-dsh',installation:'https://github.com/HellsegaMIMIC/openplc-editor-dsh/releases/tag/v2026.11.17-preview.1',download:'https://github.com/HellsegaMIMIC/openplc-editor-dsh/releases/download/v2026.11.17-preview.1/OpenPLC-Editor-DSH-editing-preview-r2-20261117-windows-x64.zip',official:'https://github.com/Autonomy-Logic/openplc-editor',pathHint:'OpenPLC Editor.exe'},
  {id:'fuxa',key:'fuxaPackage',name:'FUXA',edition:'1.3.5 · 中文与集成版（首次联网安装）',kind:'联网安装包',repository:'https://github.com/HellsegaMIMIC/fuxa-zh',download:'https://github.com/HellsegaMIMIC/fuxa-zh/releases/download/v2026.11.17-preview.1/fuxa-zh-patch-v2026.11.17-preview.1.zip',official:'https://github.com/frangoteam/FUXA',pathHint:'包含 main.js 的 FUXA 安装目录'},
  {id:'oip',key:'oipExecutable',name:'Open Industry Project',edition:'2026.11.9 · 中文补丁与适配源码（需匹配原版）',kind:'汉化补丁',repository:'https://github.com/HellsegaMIMIC/open-industry-project-zh',download:'https://github.com/HellsegaMIMIC/open-industry-project-zh/releases/download/v2026.11.17-preview.1/open-industry-project-zh-patch-v2026.11.17-preview.1.zip',official:'https://www.openindustryproject.org/',pathHint:'官方 2026.11.9 的 Open Industry Project.exe'},
  {id:'runtime',key:'runtime',name:'OpenPLC Runtime',edition:'PLC 执行环境 · 官方 Runtime v4（需匹配本地编译适配）',kind:'官方安装来源',repository:'https://github.com/Autonomy-Logic/openplc-runtime',installation:'https://github.com/Autonomy-Logic/openplc-runtime#readme',download:'https://autonomylogic.com/products/runtime',downloadLabel:'打开官方下载页',official:'https://github.com/Autonomy-Logic/openplc-runtime/releases',pathHint:'Runtime 安装中的 openplc-runtime 目录，包含 VERSION、core 和 scripts；不填编辑器 exe'},
  {id:'msys',key:'msys',name:'PLC 编译环境',edition:'Runtime 配套 MSYS 与构建工具 · 不包含在 DSH 编辑预览包中',kind:'安装说明',repository:'https://github.com/Autonomy-Logic/openplc-runtime',installation:'https://github.com/Autonomy-Logic/openplc-runtime#readme',official:'https://autonomylogic.com/products/runtime',availability:'随匹配的 Runtime Windows 环境准备',pathHint:'匹配 Runtime 的 msys64 目录；检查 usr/bin 下的 bash、g++、cmake 和 make'},
];

// Installation is grouped for users; probes/configuration retain separate identities.
export const toolInstallGroups=toolDistributions.filter(tool=>tool.id!=='msys').map(tool=>({
  ...tool,name:tool.id==='runtime'?'Runtime 与编译依赖':tool.name,
  members:tool.id==='runtime'?['runtime','msys']:[tool.id],
}));

export function validateToolEnvironment(value){
  if(value?.ok!==true||value.schemaVersion!==1||!Array.isArray(value.tools)||value.tools.length<3||value.tools.length>5||typeof value.configPath!=='string'||typeof value.checkedAt!=='string')throw new Error('工具检测结果未获确认。');
  const seen=new Set();
  for(const row of value.tools){
    const definition=toolDistributions.find(tool=>tool.id===row?.id);
    if(!definition||seen.has(row.id)||row.key!==definition.key||!['found','missing','unchecked'].includes(row.state)||row.path!=null&&typeof row.path!=='string'||row.reason!=null&&typeof row.reason!=='string'||row.version!=null&&(typeof row.version!=='string'||row.version.length>80)||row.checks!=null&&(!Array.isArray(row.checks)||row.checks.length>10||row.checks.some(check=>typeof check?.entry!=='string'||check.entry.length>160||!['found','missing','unchecked'].includes(check.state))))throw new Error('工具检测结果未获确认。');
    seen.add(row.id);
  }
  if(['openplc','fuxa','oip'].some(id=>!seen.has(id)))throw new Error('工具检测结果未获确认。');
  return {...value,tools:toolDistributions.map(tool=>value.tools.find(row=>row.id===tool.id)||{id:tool.id,key:tool.key,state:'unchecked',reason:'当前宿主尚未提供运行依赖检测'})};
}
