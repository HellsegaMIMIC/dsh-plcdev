# 第三方来源与范围

2026-11-18 更新。维护者有权授权的原创代码采用 MIT；各上游及其派生材料保留原许可证，不由插件统一重新授权。含 OpenPLC GPL 派生代码的组合插件继续 GPL-3.0-only 分发，详见 [许可范围](LICENSE-CHOICE.md)。

| 上游 | 基线／许可证 | 本包处理 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 独立 Web 安装脚本固定 0.2.1-rc.5；日常桌面验证为 0.2.2；[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) | 外部宿主，不包含安装包、profile 或登录数据 |
| [FUXA](https://github.com/frangoteam/FUXA) | 1.3.5；[MIT](https://github.com/frangoteam/FUXA/blob/master/LICENSE) | 接口、小补丁和 lock，上游权利保留 |
| [OpenPLC Editor](https://github.com/Autonomy-Logic/openplc-editor) | [GPL-3.0](https://github.com/Autonomy-Logic/openplc-editor/blob/development/LICENSE)；[DSH 适配源代码](https://github.com/HellsegaMIMIC/openplc-editor-dsh) | 插件包含带来源说明的梯形图只读渲染器；完整编辑器及共享工具执行器源码另行安装，见 docs/EDITOR-DEPENDENCY.md |
| [OpenPLC Runtime](https://github.com/Autonomy-Logic/openplc-runtime) | 本机 v4.3.0；以安装版对应上游许可为准 | 外部安装，不重新授权上游 |
| [Open Industry Project](https://github.com/Open-Industry-Project/Open-Industry-Project) | 桥接固定上游 2026.11.9 的文件哈希 | 不打包程序、内置部件、模型或 SDK 文档；汉化版本与固定哈希桥接的兼容限制见 docs/INSTALL.md |
| EEZ／Factory I/O | 历史可选适配 | 不打包 EXE／商业场景 |
| npm／Python 依赖 | 各自 lock 的固定版本与许可证 | 包管理器安装，分别适用原许可 |

商标、产品名与 logo 仅识别集成目标，不暗示官方背书。资源来源和指纹见 docs/ASSET-PROVENANCE.md；原生梯形图渲染器来源见 software/dsh-plcdev/src/client/native-ladder/README.md。根许可不覆盖商标权或改变原有权利。
