# 安装与启动

这是源码开发预览。已验环境为 Windows、Python 3.13、Node 25；插件声明 Node >=24，其他主版本未作为当前本机基线验收。

## 只构建插件

在仓库根目录执行 `npm ci`、`npm run build`、`npm test`。根 lock 固定 esbuild 0.25.12；安装访问 npm，不调用模型或运行 PLC。

## 本机工具

需外部安装 DSH、FUXA 1.3.5、OpenPLC Runtime v4.3.0 与 Windows MSYS。随附 DSH 安装锁固定 0.2.1-rc.5，模型解耦已在该版正式 AgentLoop 中离线验证；真实对话与 A/B 模型切换验收使用桌面 0.2.2-rc.1 的独立配置。当前编辑器基线为 OpenPLC Editor 4.3.2 的定制 r4 分发；原始上游同版本不保证具备全部 CLI 和解析修复。

```powershell
python -B tools/plcdev_environment.py init
```

编辑生成的 `outputs/local/environment.json`，填入本机 editor、runtime、msys、python、pythonEnvironment 等路径。`config/environment.example.json` 只有示例路径。同机多个检出必须将 `state.runtimeOwnerDirectory` 指向同一个绝对目录；不要删锁或换目录规避占用。

```powershell
python -m venv .tools/workbench-agent-venv
python -m pip --python .tools/workbench-agent-venv install -r config/workbench-python.lock.txt
python -B -X utf8 tools/install_fuxa.py
./tools/install_dsh_workbench.ps1 -ProfileDirectory "$PWD/outputs/dsh-home"
python -B -X utf8 tools/manage_workbench_projects.py --state "$PWD/outputs/first-workbench" import --source "C:/MyProjects/OwnPLC/project.json" --parent "C:/MyProjects/Workbench" --name OwnProject
./tools/start_dsh_workbench.ps1 -StateDirectory "$PWD/outputs/first-workbench" -ProfileDirectory "$PWD/outputs/dsh-home" -Port 55110
```

使用与 venv 匹配的普通基础 Python。DSH／FUXA 按固定 npm lock 安装；这些锁来自维护者基线，联网全新安装尚未完成发行验收。这里导入你自己已有的原生 OpenPLC 工程，只复制源码并生成新 UUID；已存在的目标工程目录拒绝覆盖，不调用模型或运行 PLC。公开包没有案例，请将示例路径替换为自己的项目路径，先成功登记一个工程，再启动后台。也可用同一命令的 open --manifest 入口登记自己已有的 .plcdev。create 入口新建空白工程需要支持 CLI 的定制编辑器。

## 在对话中修改工程

1. 在对话头部选择已登记的工程，使用 DSH 原生输入框提出修改需求。
2. 当前模型读取工程工具并提交修改计划；从消息中的成果入口打开右侧审阅，核对修改内容及源版本。
3. 确认后创建修改副本。打开副本只改变查看对象，点击“用于后续对话”才改变对话工程。
4. 对支持继续修改的候选，在审阅页选择“继续修改”，返回原生输入框提出新要求。当前确定性修订支持标题变更，其他修改范围由实际能力决定。

无需切换到旧“DeepSeek · PLCdev 工程助手”条目。当前模型及预设需要开放兼容的 native 工具调用；请求没有工程工具时会提示限制，不自动替换模型。普通聊天、查看和审阅已有成果仍可使用。真实验证限官方 DeepSeek 适配器的 `deepseek-flash` 与 `deepseek-v4-pro`；其他模型、跨供应商和 PTC 需要单独核验。宿主中的模型凭据留在宿主，后台候选生成不接收这些密钥。

切换模型保留已绑定工程、候选及修订关系。已提交或结果未知的请求按原编号恢复，不因换模型重新生成；同一轮尚未提交时更换模型或追加需求会使旧轮上下文失效，已提交的后台任务仍按原记录处理。

## 编译与运行

在右侧工程页或 DSH 侧栏的 PLCdev 工作台打开 PLC／FUXA；编译准备成功并核对 STOP 后显式运行。监视页面的输入先回车确认草稿，点击应用才写 PLC。结束时停止工艺、停止 PLC、结束所属会话；关闭网页不是停止 Runtime。

## 依赖缺口

部分候选 CLI 仍读取 `software/openplc-editor-zh` 的 TypeScript、worker、JSDOM 和定制编辑器；权限门禁核对固定 FUXA 与编辑器源码依赖指纹。缺失时拒绝操作，不应删除检查。本包未混入整个 fork、node_modules 或 EXE。

`docs/editor-working-tree.patch` 只记录维护者当前编辑器工作树差异和 base commit，尚未证明覆盖所有历史定制，不能单独代表完整 r4 安装。见 `docs/EDITOR-DEPENDENCY.md`。

OIP 为可选外部安装，此分发没有任何案例或场景。EEZ／Factory I/O 历史适配保留代码，但商业场景、HMI EXE 和第三方模型未打包，相关入口可显示不可用。
