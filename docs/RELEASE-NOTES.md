# v0.5.12-preview.1

Original code is licensed MIT; the combined plugin includes GPL-derived code and remains GPL-3.0-only. Third-party licenses and notices are preserved. See LICENSE-CHOICE.md for scope.

## 本版变化

- 对话右侧直接提供“编译并准备”“运行 PLC”“停止 PLC”和“结束运行实例”，不必离开当前对话。
- 侧栏内切换“工程资源 / 运行与监视”，查看运行关系、变量和统一运行事件；提供已配置画面、仿真场景的打开入口。
- 与工程页共用运行状态和操作保护；编译面向已保存版本，不自动保留候选或启动 PLC。切换页签保留资源状态，收敛重复标题和装饰。

- 公开安装包的 OIP 工作目录和 Factory I/O 路径可按本机配置。

## 验证与边界

- 维护者已核对日常 DSH 侧栏及窄屏、浅深主题布局；本次发行以独立公开源码树重新构建和离线测试的结果为准。
- 本版未进行真实编译、PLC 执行或三维联动验收。通用 OIP 与 PLC 联动运行尚未接通，界面明确显示限制。
- EEZ 通用适配仍独立开发，不包含在本次发行中。原有 MIT / 组合 GPL 许可范围保持不变。

包含同工程 PLC/HMI/OIP 候选流程、运行关系和统一事件。插件 tgz 仍需配合本仓库的工程服务源码及匹配的原生工具，不是整套工具链安装程序。

Includes the DSH plugin, local engineering services, integration adapters, dependency locks, installation/architecture/status documentation, and automated checks.

**No user/example projects, HMI screens or OIP scenes are included.** The built-in project registry is empty. Create or import your own project. The single tests/fixtures/native-ladder.ld file is synthetic renderer test data, not an installed application program.

Local staged verification: Node: 722 tests, 700 passed, 22 skipped; Python: 128 tests, 128 passed, 0 skipped. npm install/build and source manifest/privacy checks completed successfully. Full logs remain private; docs/validation.json records exits, counts and log hashes.

Known limits: Windows maintainer baseline; clean-machine integrated install unverified; native candidate/permission paths require custom OpenPLC source/toolchain prerequisites. Concrete teaching simulation models and third-party scene assets are excluded. Historical Runtime validation is not a new hardware, real-time or classroom acceptance. No model calls or PLC execution were performed for this release.
