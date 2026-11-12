# Pi Harness

让 Pi 按需找到工具，把任务分给多个 Agent，并在不同会话之间协作。

你可以直接描述目标，例如：

> 帮我排查这个问题。让一个 Agent 查调用链，另一个检查相关测试，最后由你汇总并修复。按文件分工，避免同时修改同一个文件。

Harness 为 Pi 增加按需工具发现、并行委派和独立问答能力。你仍在原来的 Pi 对话里工作，主 Agent 负责分工、沟通和汇总。

## 能做什么

- **按需使用工具和 Skill**：Agent 搜索当前环境已注册的工具、MCP 工具和本地 Skill，选中后继续完成任务。你也可以用命令直接启用工具。
- **并行处理任务**：子 Agent 可以独立研究、审查或修改代码，也可以继续拆分任务。执行深度、并发数量和运行预算可配置。
- **沿用对话或独立开始**：需要已有背景的任务可以继承当前上下文；独立任务可以从新的上下文开始，并按配置选择角色和模型。
- **跨会话协作**：把另一个正在运行的 Pi 会话介绍给当前 Agent，之后按你的要求互相发消息。连接本身不会向对方发送消息。
- **查看和停止任务**：在对话中查看子任务状态，必要时停止指定任务或全部子任务。

子 Agent 共享工作目录。并行改代码时应按文件分工；需要隔离修改或测试状态时，使用不同 worktree。

## 许可证

本项目采用 [Mozilla Public License 2.0](LICENSE)。依赖及保留的第三方代码按各自许可证分发。

Platform status: Linux and Windows have offline test evidence. macOS CI currently fails; the project does not claim macOS compatibility. See [known issues](docs/known-issues.md#macos-compatibility-is-not-established).

## 开始使用

需要 Node.js **22.19.0 或更新版本**。当前适配 Pi **1.5.0**。跨会话协作支持 Linux 和原生 Windows；异步 Shell 在 POSIX 上使用 tmux，在 Windows 上使用 psmux。

### 安装与启动

```sh
git clone https://github.com/111inhistory/pi-harness.git
cd pi-harness
npm ci
npx pi -e ./extensions/result-rendering.ts \
  -e ./extensions/subagent.ts \
  -e ./extensions/capability.ts \
  -e ./extensions/btw.ts \
  -e ./extensions/preset.ts
```

先在 Pi 中配置可用模型与认证。Harness 使用 Pi 已有的模型配置，不单独管理凭据。

上面的命令在仓库目录中启动。要在自己的项目中使用，从项目目录启动 Pi，并把 `-e` 后的路径换成 Harness 扩展的绝对路径，例如：

```sh
pi -e /path/to/pi-harness/extensions/result-rendering.ts \
  -e /path/to/pi-harness/extensions/subagent.ts \
  -e /path/to/pi-harness/extensions/capability.ts \
  -e /path/to/pi-harness/extensions/btw.ts \
  -e /path/to/pi-harness/extensions/preset.ts
```

### 持久注册

推荐把仓库作为 Pi 本地包安装，由 `package.json` 维护默认入口与 Skill：

```sh
pi install /path/to/pi-harness
```

Pi 会在用户设置的 `packages` 中登记该目录。更新仓库后，重新启动 Pi 或执行 `/reload` 即可加载当前入口。请同时删除 `extensions` 中指向此包的重复入口；从旧版本迁移时移除 `extensions/harness.ts`。可选的 Shell 检查与权限审批仍通过独立的 `-e` 或 `extensions` 条目加载。

只希望试用或选择部分插件时，可使用上面的 `-e` 命令；`pi config` 可配置包内各资源的启用状态。

### 插件入口

| 入口 | 职责 |
| --- | --- |
| [subagent.ts](extensions/subagent.ts) | 子任务、会话通信与依附其生命周期的异步 Shell |
| [capability.ts](extensions/capability.ts) | Capability 发现、启用、权限投影、MCP 装配与 Main 最终出站缓存标识观察 |
| [btw.ts](extensions/btw.ts) | `/btw` 独立问答 |
| [preset.ts](extensions/preset.ts) | 模型 Preset 切换、专属指引与工具修饰符 |
| [result-rendering.ts](extensions/result-rendering.ts) | 工具结果与消息的折叠显示 |
| [shell-preflight.ts](extensions/shell-preflight.ts) | 可选的 Shell 语法检查、权限模式与人工审批 |

包配置默认加载结果渲染、Subagent、Capability、独立问答与模型 Preset；Shell Preflight 单独启用。Subagent 与 Capability 通常一起加载，注册入口分开，底层继续共享执行能力、配置与权限状态。独立问答、模型 Preset 和结果渲染可按需选择。未加载 Capability 入口时，不安装 Main 最终出站缓存标识观察器。

已有配置若显式引用 `extensions/harness.ts`，请替换为所需的上述入口；该聚合入口已移除。

### 配置独立子任务的模型

独立开始的子任务（Fresh）需要 `subagent-routing.json`。将 [路由示例](config/subagent-routing.json) 作为模板，放入 Pi 用户目录，并把分类器、角色和候选模型改成你实际可用的配置。已有文件时直接编辑，不要覆盖自己的设置。

Pi 用户目录默认为 `~/.pi/agent/`；设置 `PI_CODING_AGENT_DIR` 时使用指定目录。仓库示例不会在配置缺失时自动代替用户配置。

继承当前对话的子任务使用父会话的模型和上下文。两种任务的详细区别见[接口说明](docs/interface-contract.md)。

## 常用操作

### 让 Agent 分工

直接告诉主 Agent 要完成什么，以及分工边界：

> 检查这次改动。分别审查接口行为和错误处理，两个任务都只读，最后给我合并后的结论。

> 实现这个功能。把互不重叠的文件分给子 Agent，等结果回来后完成集成和测试。

子任务结束后会通知父 Agent，无需你反复询问状态。还想继续同一个子任务时，可以让主 Agent 给它发送后续要求。

### 查看和停止子任务

| 命令 | 用途 |
| --- | --- |
| `/subagent` 或 `/subagent list` | 查看当前会话的子任务树和状态 |
| `/subagent list --all` | 查看包含已停止任务的树 |
| `/subagent stop <id>` | 停止指定子 Agent |
| `/subagent stop --all` | 停止当前会话的全部子 Agent |

### 查找和启用工具

通常由 Agent 在需要时调用 `capability`。你也可以直接操作：

| 命令 | 用途 |
| --- | --- |
| `/capability` | 浏览当前可用工具 |
| `/capability list mcp` | 只看 MCP 工具；也支持 `tool`、`namespace` 和筛选词 |
| `/capability enable` | 打开选择列表，选中即启用 |
| `/capability enable <工具名>` | 启用指定工具，可一次填写多个目标 |
| `/capability enable mcp://<服务器名>` | 启用该 MCP 服务器当前已注册的工具 |
| `/capability enable namespace://<名称>` | 启用指定工具组 |

命令支持 Tab 补全。通过 Pi 原生 `/mcp` 命令重连后，新注册的工具可以直接浏览和启用，不需要重启 Harness。

如需把某些工具保留给用户明确授权，可在 `capability.manualTools` 中配置。模型发现不会推荐这些工具，子会话也不会继承。详细配置见[Harness 参数配置](docs/harness-configuration.md)。

### 切换模型 Preset

在全局 agent 目录或受信项目 `.pi/` 放置 `presets.json`，每项可配置模型、thinking、工具 `+/-` 修饰符、专属指引和 Codemode 模式。命令：

| 命令 | 用途 |
| --- | --- |
| `/preset` | 打开列表选择 Preset |
| `/preset <名称>` | 应用指定 Preset |
| `/preset clear` | 停止管理（不回滚当前 model／thinking／tools） |
| `--preset <名称>` | 启动时应用 |

Preset 只作用于当前会话，不改变子任务路由。`codemode.mode` 通过本会话分支记录生效，只改变工具声明投影；定义与边界见[接口契约](docs/interface-contract.md#模型-preset)和[Harness 参数配置](docs/harness-configuration.md#模型-preset)。

### 临时问个问题

使用 `/btw` 在终端底部打开独立问答面板，或用 `/btw 为什么这里需要等待？` 直接提问。面板沿用打开时的对话背景和模型，可以继续追问，所有工具调用均被阻断。临时问答不会写入主对话，也不进入子任务列表。

面板停靠在底部、占满宽度，高度目标为终端半屏，首选最小高度为 8 行（可用 `btw.panelMinRows` 配置），主对话仍在它上方可见可滚动；关闭后恢复主输入框。终端行数少于「最小行数 + 1」（默认 9 行）时，`/btw` 会报错而不是把面板压扁；打开期间把终端缩小到该下限以下，面板改为一行错误提示，恢复高度后自动继续。回答区可独立滚动（鼠标滚轮或 PgUp／PgDn，溢出时显示滚动条）：停在底部会跟随新文本，向上阅读时不会被打断，滚回底部继续跟随。SDK 的页脚、状态栏或 widget 可能挤占空间并裁切面板底部，放大终端可恢复显示。该命令只在 fullscreen 渲染下可用。

Enter 提问，Shift+Enter 换行，Ctrl+C 取消当前侧边回答，Esc 关闭面板并丢弃临时问答。关闭面板不会取消主任务。该命令仅支持交互式终端。

### 异步运行命令

在主机安装终端后端：POSIX 使用 tmux；Windows 使用 winget 安装 `marlocarlo.psmux`。然后从 Harness 仓库执行：

```sh
npm run install:async-shell
```

随后 Agent 可以通过 Bash／PowerShell 使用 `pi-job create --wait 5s -- COMMAND ARGS`：短任务直接返回结果，长任务返回 ID 并继续运行。`pi-job poll ID` 默认读取新增输出，完成结果自动送回发起任务的 Agent。多行输入支持 Bash heredoc 和 PowerShell here-string。更新代码后重新安装 CLI，并重启 Pi 加载新版。安装、输入和生命周期说明见[异步 Shell](docs/async-shell.md)。

### 连接另一个 Pi 会话

在同一台机器、同一系统用户下启动另一个加载 Harness 的 Pi 会话，然后执行：

```text
/subagent sessions
/subagent sessions connect <uid 或完整 session ID>
```

`connect` 后按 Tab 可选择存活会话，也可按会话名筛选。命令会把目标名称、目录和通信地址交给当前 Agent，并启用 `msg_write`。连接不会唤醒对方，也不会自动发问候消息。

随后你可以说：

> 让刚连接的会话 echo 一下。

> 请把这个问题发给刚连接的会话，让它只读检查相关实现，收到回复后汇总给我。

对方需要保持运行。跨会话协作支持同一机器、同一系统用户下的 Linux 和原生 Windows 会话。

## 配置和使用边界

大多数参数有默认值。需要调整并发、深度或运行预算时，在 Pi 用户目录创建 `harness.json`；受信项目也可使用 `.pi/harness.json` 覆盖指定字段。参考[配置示例](config/harness.json)和[配置说明](docs/harness-configuration.md)。

使用时还需注意：

- Capability 当前只搜索本地 Skill 和已注册工具，不会替你安装远端资源。
- MCP 连接由 Pi 管理，Harness 不提供独立的重连服务。
- 工具启用按当前会话分支记录；没有停用、移除或重置命令。
- 共享工作目录不等于修改隔离；停止任务也不会撤销已经写入的文件。
- 缓存复用取决于模型、提供方和请求内容，不能保证命中或固定节省比例。

可选的 Shell 检查会在执行前检查聊天框与工具调用里的命令；额外加载 `extensions/shell-preflight.ts` 后，可通过 `shell.approval.enabled` 启用 Ask、Auto Approve 和 YOLO 权限模式。语法检查与权限审批独立开关，配置见 [Harness 参数配置](docs/harness-configuration.md)。

## 更多资料

- [Harness 参数配置](docs/harness-configuration.md)：调整并发、预算和提示词
- [异步 Shell](docs/async-shell.md)：POSIX tmux／Windows psmux 任务、增量输出和终端输入
- [接口说明](docs/interface-contract.md)：命令、工具及具体行为
- [已知问题](docs/known-issues.md)：平台限制与尚未验收的场景
- [文档目录](docs/README.md)：架构、存储和其他开发资料

参与开发时，运行 `npm run check` 验证类型和测试，运行 `npm run check:json`、`npm run check:docs` 检查配置和文档。代码贡献前请阅读 [AGENTS.md](AGENTS.md)。
