# v0.5.11-preview.1

Original code is licensed MIT; the combined plugin includes GPL-derived code and remains GPL-3.0-only. Third-party licenses and notices are preserved. See LICENSE-CHOICE.md for scope.

本版集中整理许可和版本发布，工程功能沿用 0.5.10：

- 有权授权的原创代码改为 MIT；OpenPLC GPL 派生代码保留原许可，组合插件继续 GPL-3.0-only 分发。包内新增 MIT 原文与 NOTICE，具体范围见 LICENSE-CHOICE.md。
- 首页加入用途、架构图与干净演示截图；Releases 统一管理版本、源码、插件附件与校验文件，版本目录说明历史修订关系。
- 不覆盖旧标签或旧安装包，不包含本机正在开发的 EEZ 适配。工具链完整安装、真实 Runtime 故障恢复、实时性和硬件验收仍保留原边界。

下载 Assets 中命名的源码 ZIP 与插件 TGZ，并分别核对 SHA-256。TGZ 仍需匹配的源码工程服务；DSH、原生工具、Runtime 和编译依赖另行准备。

包含同工程 PLC/HMI/OIP 候选流程、运行关系和统一事件。插件 tgz 仍需配合本仓库的工程服务源码及匹配的原生工具，不是整套工具链安装程序。

Includes the DSH plugin, local engineering services, integration adapters, dependency locks, installation/architecture/status documentation, and automated checks.

**No user/example projects, HMI screens or OIP scenes are included.** The built-in project registry is empty. Create or import your own project. The single tests/fixtures/native-ladder.ld file is synthetic renderer test data, not an installed application program.

Local staged verification: Node: 712 tests, 690 passed, 22 skipped; Python: 128 tests, 128 passed, 0 skipped. npm install/build and source manifest/privacy checks completed successfully. Full logs remain private; docs/validation.json records exits, counts and log hashes.

Known limits: Windows maintainer baseline; clean-machine integrated install unverified; native candidate/permission paths require custom OpenPLC source/toolchain prerequisites. Concrete teaching simulation models and third-party scene assets are excluded. Historical Runtime validation is not a new hardware, real-time or classroom acceptance. No model calls or PLC execution were performed for this release.
