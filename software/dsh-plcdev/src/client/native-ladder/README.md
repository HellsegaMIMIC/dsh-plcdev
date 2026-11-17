# OpenPLC 只读梯形图差异适配

许可边界（2026-11-18）：本项目新增的 MIT 原创授权不改变 OpenPLC 来源代码及其派生产物的许可。`generated.cjs`、`generated-css.mjs` 保留 GPL 及其中各依赖声明；包含这些内容的组合插件继续 GPL-3.0-only 分发。维护者有权授权的独立原创胶合代码按插件目录的 `LICENSE-MIT.txt` 提供；对上游代码的修改及派生部分仍按其原许可。具体来源和字节指纹继续以 `provenance.json` 为准。

正式 DSH 的 `NativeLadderPreview` 从归属及摘要已核对的 `conversations/preview` 接口接收实际 `.ld` 文本。此目录复用 OpenPLC `GraphicalDiffViewer`、`computeGraphicalDiff`、ReactFlow 和原生图形原子，不包含 demo 配置生成器，也没有磁盘、IPC、编辑器 store 或 Runtime 能力。

普通插件构建直接使用 `generated.cjs` 和 `generated-css.mjs`，不要求安装 OpenPLC 源码。维护者需要刷新上游适配时，在完整 PLCdev 工作区执行：

```powershell
node software/dsh-plcdev/build-native-ladder.mjs
node --test software/dsh-plcdev/tests/native-ladder-preview.test.mjs
```

重建读取本机 `software/openplc-editor-zh` 原生源码及已有依赖，不修改原生源码、不访问网络。`provenance.json` 记录输入源码与产物 SHA256。来源许可沿用 OpenPLC Editor GPL-3.0；依赖许可保留在生成脚本末尾。React、React JSX runtime 和 ReactDOM 由宿主提供，生成物使用 CommonJS，确保最终插件或浏览器测试构建能够继续解析这些静态依赖。

适配仅有：只读 port、中文标签、LD 分支补传原生已有的 edge diff map、语义指纹纳入触点／线圈的字符串 variant。后两项分别避免连线变化漏色及常开／常闭变化漏报；构建遇到上游结构变化会失败，需重新核查。

缺少基线、文件截断、无效结构或绘制错误时明确提示不能显示，不生成替代图。新增／删除文件使用经过接口确认的空侧；只读图形仍展示真实文件内容。气泡按改动网络翻页，按原生图宽适配，只由外层正文纵向滚动；放大由用户显式选择。

测试样本 `tests/fixtures/native-ladder.ld` 来自本项目原生 builder 与保存序列化器生成的合成测试文件（`docs/demos/native-ladder-fixtures/open-lamp.ld`）。它只用于测试：生产展示不导入该文件，也不根据固定三个布尔开关生成图形。DOM 测试使用合成尺寸，不等于实际浏览器视觉验收。
