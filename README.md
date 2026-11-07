# DSH PLCdev Workbench

DSH 中的 PLC＋HMI 工程开发工作台。通过 DeepSeek Harness 原生插件、对话工具和团队接口，连接本机 OpenPLC、FUXA 及受支持的 OIP 工程。

**0.5.0 · Windows 开发预览。** 这是插件和本地工程服务源码，不包含上游安装包。维护者同机验收已有结果，新用户全新电脑安装尚未验收。许可证为 GPL-3.0-only；第三方材料保留原许可。

## 已有能力

- 工程资源、保存版本、任务、候选和运行实例视图；对话显式关联工程。
- PLC／HMI／OIP 专业成员分别提交产物，Lead 组装候选；人工审阅后保留新 UUID 或撤销。
- 用户工程声明 BOOL／INT／REAL 变量与操作，生成可编辑 FUXA 原生画面。
- 本机编译、显式运行／停止、Runtime 归属锁、版本失效、编译诊断与工具身份检查。
- 保存重开、同机环境恢复，以及停止后工程移动与工具归属迁移。

默认不调用模型、不准备或运行 PLC。模型操作需使用者配置凭据并按本次用途和材料授权，仓库不包含凭据或历史授权。

## 发布范围

本仓库只发布插件、配套工程服务、安装与接口文档及自动化测试。**不包含案例工程、PLC 工艺程序、HMI 画面或 OIP 场景。** 默认工程清单为空，请先登记自己的工程，再启动 DSH 工作台。测试中的最小内存／临时目录夹具不构成演示工程。

## 开始

先读 [安装说明](docs/INSTALL.md)。源码检查不需要模型、Runtime 或 OIP：

```powershell
npm ci
npm run build
npm test
python -B -X utf8 -m unittest discover -s tools -p test_project_interface.py
python -B -X utf8 -m unittest discover -s tools -p test_plcdev_environment.py
python -B -X utf8 tools/verify_source_release.py .
```

实际编译运行需要另行配置本机工具链。部分候选路径仍依赖定制 OpenPLC CLI 与源码依赖，缺失时拒绝操作，不能将源码测试视为完整安装通过。

[开发状态](docs/STATUS.md) · [架构](docs/ARCHITECTURE.md) · [隐私与发布范围](docs/PRIVACY.md) · [贡献](CONTRIBUTING.md)。

跨机、长期后台可靠性、实体硬件、实时性和课堂验收未执行；本项目和软件停止逻辑不得用作人员安全功能。

## 许可

本项目原创代码按 GPL-3.0-only 授权，见根 LICENSE。[许可准备状态](LICENSE-CHOICE.md)、[第三方说明](THIRD_PARTY_NOTICES.md)。不附带上游安装包，不代表其官方项目。
