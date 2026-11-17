# 版本发布与下载

**[打开 GitHub Releases](https://github.com/HellsegaMIMIC/dsh-plcdev/releases)** · [当前预览版 v0.5.12-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.12-preview.1) · [完整更新记录](CHANGELOG.md)

GitHub Releases 是本项目的统一版本发布入口。每个版本有独立标签、更新说明、下载附件和验证范围。当前均为开发预览，不标记为稳定版。

## 选择版本

| 版本 | 定位 | 主要变化 |
| --- | --- | --- |
| [v0.5.12-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.12-preview.1) | 当前预览 | 对话侧栏编译、运行、监视与事件入口；共用工程状态与操作保护 |
| [v0.5.11-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.11-preview.1) | 历史预览 | 原创代码 MIT、组合包保留 GPL；首页配图与版本入口；工程功能沿用 0.5.10 |
| [v0.5.10-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.10-preview.1) | 历史预览 | 工程筛选、最近修改排序与工具准备界面；原 GPL 许可记录 |
| [v0.5.9-preview.2](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.9-preview.2) | 历史修订 | 全页一致性清理，修正 Windows 短路径测试 |
| [v0.5.9-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.9-preview.1) | 已有后续修订 | 该版 CI 出现 Windows 短路径测试失败；保留原包与证据，优先选择 preview.2 或更新版本 |
| [v0.5.0-preview.2](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.0-preview.2) | 早期源码预览 | 首发后的路径测试修订，仅提供源码附件 |
| [v0.5.0-preview.1](https://github.com/HellsegaMIMIC/dsh-plcdev/releases/tag/v0.5.0-preview.1) | 已有后续修订 | 最初源码发行，保留用于历史追溯 |

## 下载哪些文件

| 附件 | 用途 |
| --- | --- |
| `dsh-plcdev-<版本>-source-preview.<序号>.zip` | 经过检查的源码树、本机工程服务、文档与清单 |
| `dsh-plcdev-<版本>.tgz` | DSH 插件包，含构建后的界面；仍需匹配的源码工程服务和原生工具 |
| 对应的 `.sha256` | 检查下载文件完整性 |

优先使用每版 **Assets** 中上述命名的附件。GitHub 自动生成的 `Source code (zip/tar.gz)` 是标签快照，不是插件安装包。新电脑准备与升级步骤见 [安装说明](docs/INSTALL.md)；升级前保全用户工程及本机配置。

例如，在 PowerShell 中核对下载的插件包：

```powershell
Get-FileHash .\dsh-plcdev-0.5.12.tgz -Algorithm SHA256
Get-Content .\dsh-plcdev-0.5.12.tgz.sha256
```

两处的哈希应一致。源码 ZIP 同样可核对。

## 后续版本规则

- 使用 `v<主版本>.<次版本>.<修订>-preview.<序号>` 标签。新的变更使用新标签，不移动旧标签或覆盖旧附件。
- 每版说明写清变化、许可证范围、测试结果、安装条件和未验证事项。
- 先检查独立导出源码及插件包，再发布源码 ZIP、插件 TGZ 和各自的 SHA-256 文件；跟进该提交的 GitHub Source checks。
- 修订版在说明中指出取代哪一版，旧版本继续保留。稳定性未完成验收前保持 prerelease。
- 新许可从本版的具体授权范围解释，不重写旧发行记录。原创 MIT 和组合 GPL 的区别见 [许可范围](LICENSE-CHOICE.md)。
