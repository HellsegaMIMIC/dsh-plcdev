# 第三方来源与范围

2026-11-07 核对；不将上游统一重新授权。

| 上游 | 基线／许可证 | 本包处理 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 0.2.1-rc.5；[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) | 依赖锁，外部安装，无 profile／node_modules |
| [FUXA](https://github.com/frangoteam/FUXA) | 1.3.5；[MIT](https://github.com/frangoteam/FUXA/blob/master/LICENSE) | 接口、小补丁和 lock，上游权利保留 |
| [OpenPLC Editor](https://github.com/Autonomy-Logic/openplc-editor) | 4.3.2／定制 r4；[GPL-3.0](https://github.com/Autonomy-Logic/openplc-editor/blob/development/LICENSE) | 不打包 EXE／整个 fork；独立记录差异和复建缺口 |
| [OpenPLC Runtime](https://github.com/Autonomy-Logic/openplc-runtime) | 本机 v4.3.0；以安装版对应上游许可为准 | 外部安装，不重新授权上游 |
| OIP | 本机 2026.10.29 | 不打包程序、内置部件、模型或 SDK 文档 |
| EEZ／Factory I/O | 历史可选适配 | 不打包 EXE／商业场景 |
| npm／Python 依赖 | 各自 lock 的固定版本与许可证 | 包管理器安装，分别适用原许可 |

商标、产品名与 logo 仅识别集成目标，不暗示官方背书。两张原始 logo 已按本地上游 GPL 源码来源保留原字节及许可，来源和指纹见 docs/ASSET-PROVENANCE.md；编辑器补丁保留上游 GPL 许可。根许可不覆盖商标权或改变原有权利。
