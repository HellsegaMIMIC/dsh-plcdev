# v0.5.9-preview.2

DSH PLCdev Workbench source development preview, licensed GPL-3.0-only.

本版清理工程页、结果卡、调整记录、设置与运行页的旧入口和重复状态；同工程保留、历史编译回执及运行采样采用一致表述，修复 HMI 图片错误提示竞态。

修订版还修正 Windows 短路径环境下的启动路径测试，按真实文件身份核对，保留启动命令与描述文件归属检查；工程启动实现未改动。

包含同工程 PLC/HMI/OIP 候选流程、运行关系和统一事件。插件 tgz 仍需配合本仓库的工程服务源码及匹配的原生工具，不是整套工具链安装程序。

Includes the DSH plugin, local engineering services, integration adapters, dependency locks, installation/architecture/status documentation, and automated checks.

**No user/example projects, HMI screens or OIP scenes are included.** The built-in project registry is empty. Create or import your own project. The single tests/fixtures/native-ladder.ld file is synthetic renderer test data, not an installed application program.

Local staged verification: Node: 700 tests, 678 passed, 22 skipped; Python: 117 tests, 117 passed, 0 skipped. npm install/build and source manifest/privacy checks completed successfully. Full logs remain private; docs/validation.json records exits, counts and log hashes.

Known limits: Windows maintainer baseline; clean-machine integrated install unverified; native candidate/permission paths require custom OpenPLC source/toolchain prerequisites. Concrete teaching simulation models and third-party scene assets are excluded. Historical Runtime validation is not a new hardware, real-time or classroom acceptance. No model calls or PLC execution were performed for this release.
