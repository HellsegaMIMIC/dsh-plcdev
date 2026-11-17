# 安装与接入

0.5.9 是 Windows 源码开发预览，维护者基线为 Node 25、Python 3.13、日常 DSH 0.2.2。完整干净电脑安装尚未验收；不要把通过源码测试理解为所有原生工具已可运行。

## 构建与状态目录

在仓库根目录执行 `npm ci` 和 `npm run build`。构建生成 `software/dsh-plcdev/lib/client.js`；`npm test` 使用离线或临时本机回环夹具，不调用模型、启动真实工具或运行 PLC。部分需要原生源码的集成项可能跳过，结果应单独报告。

执行 `python -B tools/plcdev_environment.py init` 后配置本机 `outputs/local/environment.json`。这里的路径只留在本机；不要上传配置、工程索引、候选账本、profile 或凭据。不同检出若共用同一 Runtime，应配置同一个 `state.runtimeOwnerDirectory`，不能换目录规避占用。

大构建和缓存可放在 F 盘。本版 OIP 隔离编辑适配目前仍使用 `F:/PLCdev-build-temp/20261116/oip-native/runs` 和 `F:/PLCdev-build-temp/20261117/oip-editor-runtime`；没有 F 盘的环境尚需配置化适配，不能宣称直接可用。

## 原生工具与下载

| 工具 | 推荐来源 | 当前接入条件 |
| --- | --- | --- |
| OpenPLC Editor | [DSH 适配源码与编辑预览](https://github.com/HellsegaMIMIC/openplc-editor-dsh/releases/tag/v2026.11.17-preview.1) | 共享编辑执行器还需该源码检出位于 `software/openplc-editor-zh`，安装其锁定依赖；便携 EXE 不含完整编译工具链 |
| FUXA | [中文补丁与固定版本安装资料](https://github.com/HellsegaMIMIC/fuxa-zh/releases/tag/v2026.11.17-preview.1) | 固定 1.3.5；权限核查依赖原生文件指纹及 OpenPLC 源码目录中的 TypeScript/JSDOM |
| OIP | [中文补丁与说明](https://github.com/HellsegaMIMIC/open-industry-project-zh/releases/tag/v2026.11.17-preview.1) | DSH 原生编辑桥接目前要求官方 2026.11.9 的精确文件指纹；独立中文补丁修改主进程后，不能直接作为该桥接输入 |
| OpenPLC Runtime | [官方 Runtime](https://github.com/Autonomy-Logic/openplc-runtime) | 本机已核查基线 v4.3.0；Runtime 与 Windows MSYS 编译环境需另行安装并配置 |

DSH 的“工具下载与安装”显示同一组入口和只读检测结果。找到入口只说明文件存在；下载、安装、版本兼容和实际运行是不同步骤。

OpenPLC 源码依赖及准确公开提交见 [EDITOR-DEPENDENCY.md](EDITOR-DEPENDENCY.md)。OIP 原版安装及内置部件不随插件仓库分发；不会仅靠 host/catalog 文件就获得原生编辑能力。可选教学数值模型和商业 Factory I/O 场景也未包含。

## DSH 接入

将构建后的 `software/dsh-plcdev` 作为本地插件安装到日常 DSH，插件配置 `projectRoot` 指向本仓库，`controllerFile` 指向对应本机工程服务描述文件。描述文件含本机能力凭据，不粘贴到聊天或提交 Git。

仓库中的 `install_dsh_workbench.ps1` / `start_dsh_workbench.ps1` 保留独立 Web 开发宿主的旧安装路径，其锁为 DSH 0.2.1-rc.5；它们不是升级日常 0.2.2 桌面的安装程序。不要用它们覆盖已有桌面 profile。插件 tgz 只含插件代码和界面 bundle，本机 Python 工程服务仍需要这份源树。

新会话开启 PLCdev 后选择或创建工程，再提出修改。未发生工程操作前可以关闭；已有工程任务的会话保留工程身份。生成需要宿主和模型支持兼容的 native 工具调用，查看和审阅不依赖生成能力。凭据继续由 DSH 管理，插件不会把密钥复制到 OpenPLC。

“编译并准备”沿用编译和装载流程；准备完成后显式运行 PLC。关闭页面或停用插件不等于停止独立 Runtime。实体下载、强制 I/O 和硬件运行不在本发行验收内。
