# v0.5.10-preview.1

DSH PLCdev Workbench source development preview, licensed GPL-3.0-only.

本版整理工程查找和工具准备界面，包含 `0.5.9-preview.2` 之后的试用修复：

- 工程目录与会话工程选择支持名称／路径搜索、PLC／HMI／仿真内容筛选，默认按最近修改排序，也可按名称排序。修改时间来自已保存的源文件，未知置底；不会因为筛选而切换会话工程。
- 设置页优先展示工具配置与下载；下载和本机状态收敛为紧凑格子，版本、路径及要求按需展开，手动配置默认折叠。
- 增加可复制的 DSH Agent 安装提示词；Runtime 与编译依赖共用入口、分别检测，并在同一份提示词中准备。复制不会自动发送消息或执行安装。
- 移除整页紫色侧线和下载弹窗外层灰色遮罩，修复弹窗定位、运行页签点击高亮及目录文字对齐；保留键盘焦点与返回行为。

既有 PLC／FUXA／OIP 的同工程修改、审阅、保留、撤销和运行事件流程继续保留。本版没有新增 EEZ Studio 的统一适配能力。完整新电脑安装、原生工具草稿回收、通用 OIP 实时联动及最新真实 Runtime 故障验收仍未完成。

包含同工程 PLC/HMI/OIP 候选流程、运行关系和统一事件。插件 tgz 仍需配合本仓库的工程服务源码及匹配的原生工具，不是整套工具链安装程序。

Includes the DSH plugin, local engineering services, integration adapters, dependency locks, installation/architecture/status documentation, and automated checks.

**No user/example projects, HMI screens or OIP scenes are included.** The built-in project registry is empty. Create or import your own project. The single tests/fixtures/native-ladder.ld file is synthetic renderer test data, not an installed application program.

Local staged verification: Node: 712 tests, 690 passed, 22 skipped; Python: 128 tests, 128 passed, 0 skipped. npm install/build and source manifest/privacy checks completed successfully. Full logs remain private; docs/validation.json records exits, counts and log hashes.

Known limits: Windows maintainer baseline; clean-machine integrated install unverified; native candidate/permission paths require custom OpenPLC source/toolchain prerequisites. Concrete teaching simulation models and third-party scene assets are excluded. Historical Runtime validation is not a new hardware, real-time or classroom acceptance. No model calls or PLC execution were performed for this release.
