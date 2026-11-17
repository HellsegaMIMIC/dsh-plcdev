# 许可范围

2026-11-18，维护者明确选择：**有权授权的原创代码改为 MIT；含 GPL 代码的组合包继续遵守 GPL。** MIT 和 GPL 都是开源许可证，当前项目不是“整包纯 MIT”，也不是允许整包任选 MIT 或 GPL 的双重许可。

| 范围 | 许可与对应文件 |
| --- | --- |
| 本独立仓库中维护者有权授权的原创插件代码、配套服务、脚本及文档 | MIT；根 [LICENSE](LICENSE)、[MIT 原文副本](LICENSES/MIT-original.txt) |
| 内置 OpenPLC 派生梯形图渲染代码及样式 | 保留 GPL 与原依赖声明；见 [来源与边界](software/dsh-plcdev/src/client/native-ladder/README.md)、[GPL 原文](LICENSES/GPL-3.0.txt) |
| 将上述代码打包在一起的插件和组合分发 | 继续按 GPL-3.0-only 分发，并保留 MIT 版权声明；插件 [LICENSE](software/dsh-plcdev/LICENSE) 仍为 GPL |
| 其他第三方代码、补丁、图标及标志 | 保留各自原版权与许可，见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [资源来源](docs/ASSET-PROVENANCE.md) |

根 LICENSE 的 MIT 授权只覆盖上述原创部分，不覆盖第三方或第三方派生材料。特别是 `software/dsh-plcdev/src/client/native-ladder/generated.cjs`、`generated-css.mjs` 及其 OpenPLC 来源代码，不能作为 MIT 原创代码抽取；源码中的工具图标、Lucide 派生标记及依赖声明也不被根许可替换。原生工具本身继续采用上游许可。

单独复用独立的 MIT 原创部分时，可以按 MIT 使用、修改、商用和再分发，保留版权及许可声明。若同时分发 GPL 派生代码构成的组合程序，仍须遵守 GPL 的源码提供及其他要求；保留 MIT 声明不会免除这些义务。

因此根与插件 `package.json` 的 `license` 字段继续写 `GPL-3.0-only`，表示当前组合分发；`plcdevLicensing.originalCode` 单独记录 `MIT`。插件包同时包含 GPL 的 `LICENSE`、原创授权的 `LICENSE-MIT.txt` 和说明边界的 `NOTICE`。

2026-11-07 首发及既有标签、ZIP、TGZ 按当时 GPL 记录保留，不覆盖旧发行或撤回已授予的 GPL 权利。本次授权不统一改变私人 PLCdev 工作区或其他独立仓库的许可，也不替无权代表的第三方重新授权。

DSH／FUXA 外部安装不包含在源码包中；不打包 OIP 内置部件、模型或商业场景。独立用户工程不会仅因使用本工具自动受 GPL 约束，包含或衍生自 GPL 代码时另按该代码许可处理。

依据：[OSI MIT](https://opensource.org/license/mit)、[OSI GPLv3](https://opensource.org/license/gpl-3-0)、[GNU 关于兼容许可证组合的说明](https://www.gnu.org/licenses/gpl-faq.en.html#WhatDoesCompatMean)。
