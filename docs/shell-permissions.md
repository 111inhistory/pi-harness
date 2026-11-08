# Shell 权限与预检查

本功能在 Shell 命令实际执行前完成语法预检查和可选的人工／自动审批。语法预检查与权限审批是两个独立开关：关闭权限审批不会关闭语法预检查，关闭语法预检查也不会关闭权限审批。

本功能通过可选入口 `extensions/shell-preflight.ts` 加载。默认 Harness 包不加载该入口；需要时按 Pi 的扩展加载方式单独启用。

## 配置

```json
{
  "shell": {
    "preflight": true,
    "approval": {
      "enabled": false,
      "mode": "auto",
      "command": [],
      "ruleFiles": [],
      "commandTimeoutMs": 10000,
      "manualTimeoutMs": 30000,
      "notificationUrl": "",
      "reviewer": {
        "enabled": true,
        "provider": "openai-codex",
        "model": "codex-auto-review",
        "timeoutMs": 90000
      }
    }
  }
}
```

| 字段 | 默认值 | 行为 |
| --- | --- | --- |
| `shell.preflight` | `true` | 对模型调用的 `bash`／`powershell` 工具和聊天框 `!` 命令执行语法预检查。 |
| `shell.approval.enabled` | `false` | 启用权限审批。关闭时仍会执行语法预检查。 |
| `shell.approval.mode` | `auto` | 没有已保存模式选择时使用的默认值：`ask`、`auto` 或 `yolo`。 |
| `shell.approval.command` | `[]` | 静态命令策略程序及参数。为空时进入后续自动审查或人工审批。 |
| `shell.approval.ruleFiles` | `[]` | 静态策略读取的规则文件路径列表。 |
| `shell.approval.commandTimeoutMs` | `10000` | 单次静态策略程序的运行上限。 |
| `shell.approval.manualTimeoutMs` | `30000` | 人工审批倒计时。超时按拒绝处理。 |
| `shell.approval.notificationUrl` | `""` | 人工审批展示时发送通知的 HTTP(S) URL；空字符串关闭。 |
| `shell.approval.reviewer.enabled` | `true` | 在 `auto` 模式下允许模型自动审查接管静态策略留下的待审批命令。 |
| `shell.approval.reviewer.provider` | `openai-codex` | 自动审查使用的 Pi 供应商。 |
| `shell.approval.reviewer.model` | `codex-auto-review` | 自动审查使用的模型。 |
| `shell.approval.reviewer.timeoutMs` | `90000` | 单次自动审查的总超时。 |

配置层按 Harness 的全局与受信项目规则合并。修改配置后按 Harness 配置的生效方式重新加载扩展。

规则来源通过 `shell.approval.ruleFiles` 文件路径列表配置（不再支持内联 rules 字段）。相对路径基于定义它的 `harness.json` 目录解析，绝对路径原样保留；多层配置按数组整层替换，不跨层拼接。

规则文件在首次使用时读取并缓存。修改规则文件后，在会话中执行 `/reload` 或切换会话树／重启生成新配置快照后生效。未启用审批或处于 `yolo` 模式时跳过规则加载。

加载器按顺序逐个读取 UTF-8 文件正文（不解析 glob 或目录），且目标必须为普通文件（指向普通文件的符号链接有效，拒绝目录与特殊文件）。若文件不存在、为目录或读取失败，抛出包含具体路径的英文错误并直接阻止命令执行，不转交自动审查或人工审批。

## 执行顺序

模型调用 Shell 工具时，扩展按以下顺序检查：

1. 如果 `shell.preflight` 为 `true`，先执行语法预检查。失败时命令不执行。
2. 如果 `shell.approval.enabled` 为 `false` 或当前模式为 `yolo`，跳过权限审批。
3. 其余情况先运行静态命令策略。
4. 静态策略保留待审批时，`auto` 模式可以在人工审批前调用自动审查。
5. 静态策略、自动审查或人工审批不允许时，命令不执行，拒绝原因返回当前 Agent。

聊天框中的 `!`／`!!` 命令属于用户显式发起的 Shell 输入。扩展只对这类命令执行语法预检查，不再要求权限审批。

## 审批模式

| 模式 | 静态策略 | 自动审查 | 人工审批 |
| --- | --- | --- | --- |
| `ask` | 先执行 | 不执行 | 策略允许时直接执行；策略拒绝时阻止；其余交由人工。 |
| `auto` | 先执行 | 策略待审批且 reviewer 启用时执行 | 自动审查允许时直接执行；拒绝时阻止；失败、不可用或无法决定时交由人工。 |
| `yolo` | 跳过 | 跳过 | 跳过；语法预检查仍独立生效。 |

`ask` 与 `auto` 都直接执行策略明确允许的命令，阻止策略明确拒绝的命令。`Ask` 不调用自动审查；未配置允许规则时，普通 Shell 工具调用都会进入人工审批，下文列出的 `pi-job` 控制操作与用户手动 `!` 输入除外。`auto` 的人工兜底覆盖自动审查不可用、模型无法解析、供应商调用失败和超时。

人工审批使用 Pi 的原生阻塞状态和通知。审批界面显示来源 Agent、目标 Shell、工作目录、完整命令和审批原因；命令较长时可在对话框内滚动。默认按 `Enter` 或 `y` 允许一次，按 `Esc` 或 `n` 拒绝，倒计时结束按拒绝处理。没有可用 TUI 时不会弹出审批，命令按拒绝处理。

## 静态命令策略

`shell.approval.command` 是程序及参数数组，不经过 Shell 字符串拼接。每次审批启动一个策略进程，工作目录使用命令的 `cwd`，并通过标准输入接收一个 JSON 对象：

```json
{
  "version": 1,
  "shell": "/usr/bin/bash",
  "command": "实际要执行的命令",
  "cwd": "/tmp/project",
  "platform": "posix",
  "source": "Main",
  "rules": ["项目规则"]
}
```

策略程序应向标准输出写入一个 JSON 对象：

```json
{ "decision": "allow", "reason": "命中只读命令规则" }
```

`decision` 只接受 `allow`、`deny` 或 `review`。`reason` 会进入后续自动审查或人工审批。程序退出码非零、输出不是合法 JSON、字段不完整、启动失败或超过 `commandTimeoutMs` 时，Harness 将其视为 `review`。

策略进程不会收到宿主为异步 Shell 注入的 Actor、Socket 和任务根环境变量。Harness 读取 `ruleFiles` 指定的各规则文件 UTF-8 正文后按顺序传入标准输入的 `rules` 数组，WASM 与策略程序接收的数据结构保持不变。

## Codex WASM 策略程序

独立分析器通过 `vendor/codex-command-policy` 子模块固定版本，包含已构建的 WASM。正常运行只需要 Node.js；重新构建分析器才需要 Rust 与 WASI 工具链。

```sh
git submodule update --init --recursive
```

将静态策略指向该命令行入口，例如：

```json
{
  "shell": {
    "approval": {
      "enabled": true,
      "command": ["node", "/path/to/pi-harness/vendor/codex-command-policy/bin/codex-command-policy.mjs"],
      "ruleFiles": ["/path/to/pi-harness/rules/codex.rules"]
    }
  }
}
```

请将示例路径替换为实际安装路径。未匹配规则的命令返回 `review`；只有显式允许规则返回 `allow`，显式禁止规则返回 `deny`。`rm -rf` 的危险识别影响原因说明，不构成无条件禁止。

Harness 使用同一份 WASM 的 `parse` 操作提取 `pi-job create` 参数，不从可配置策略程序推断解析器。解析构件不可用、语法动态或上下文含目录／环境变更时，保留原命令交后续审批。

## 自动审查

自动审查复用 `@mzwing/pi-permission-auto-review/review` 的公开审查接口和 Codex Guardian 策略，不复制该包的提示词。审查调用通过当前父会话的 Pi 模型运行时完成，因此沿用父会话已注册的供应商、虚拟模型和凭据。

自动审查按以下规则运行：

- 只有 `shell.approval.reviewer.enabled` 为 `true` 且当前模式为 `auto` 时才调用。
- 默认使用 `openai-codex` 供应商的 `codex-auto-review` 模型。`codex-auto-review` 是从该供应商已有模型派生的隐藏模型；派生失败时不会改用其他模型。
- 审查输入包含待执行命令、工作目录、来源 Agent、审批原因和当前分支上下文。
- 审查返回 `allow` 时命令执行；返回 `deny` 时命令不执行；缺少结果、结果无效、供应商失败、超时或审查不可用时交由人工。
- 调用方取消会取消正在进行的审查。审查请求不重试。

自动审查包声明 Node.js 24 或更新版本。Harness 基础运行要求仍为 Node.js 22.19 或更新版本；在 Node.js 22 上，自动审查显式不可用并转人工，不影响语法预检查和人工审批。

可选包未安装、入口无法加载或模型无法解析时，结果同样是人工兜底，不会变成允许。安装自动审查包时，npm 可能同时安装它声明的 peer 依赖；本功能只调用其 `review` 公共入口，不加载或执行权限系统的扩展入口。

## 命令入口与状态

扩展加载后，`/permissions` 查看或切换当前会话的审批模式：

```text
/permissions ask
/permissions auto
/permissions yolo
```

不带参数时，TUI 打开模式选择器并显示当前模式；非交互模式显示当前模式与切换用法。输入 `/permissions ` 后可补全 `ask`、`auto`、`yolo`，补全项包含模式名称与行为说明。

显式选择的模式保存到当前会话分支，并对后续请求生效。resume 与 `/reload` 恢复该分支最近一次选择；树切换恢复目标分支的选择，fork 沿用分支已有记录。新会话或没有选择记录的分支使用 `shell.approval.mode` 默认值。保存失败时保留原模式并显示错误。

`notificationUrl` 配置人工审批通知。审批界面实际展示时发送一次 HTTP POST，JSON 正文为 `{"title":"Shell approval required","body":"..."}`；正文包含来源 Agent、工作目录与最多 300 列的命令摘要。队列等待期间不发送，无人工界面时也不发送。请求不阻塞审批，3 秒超时，不重试、不跟随重定向；失败只显示英文警告，不改变审批结果。

Bark 可填写 `https://api.day.app/<device-key>`，自建服务替换域名即可。Bark 的通知分组等参数可以放在 URL 查询串中，例如 `?group=Pi`。其他接收端只需接受同样的 `{title, body}` JSON。默认空字符串关闭；将实际设备密钥保存在本机配置中。修改后执行 `/reload`。

权限界面统一使用英文，不提供语言切换。页脚显示 `Permissions: Ask`、`Permissions: Auto Approve` 或 `Permissions: YOLO`；自动审查期间显示 `Permissions: Auto Approve (reviewing)`，人工兜底时显示 `(manual fallback)`。进入自动审查的命令在审查结束后发送一条通知，说明命令摘要以及允许、拒绝或转人工的结果；静态规则直接决定的命令不发送自动审查通知。

Subagent 的 Shell 工具调用会回到所属根会话执行同一套检查。根会话处于人工审批时，Subagent 的当前等待状态由 Harness 保留，审批结束后继续。

## 边界

- 本功能检查 Shell 命令和权限决策，不提供文件系统沙箱，不改变 `read`、`write`、`edit` 等文件工具的原生权限。
- 语法预检查只判断 Shell 语法，不判断命令是否安全、是否存在或执行后是否成功。
- 静态命令策略由外部程序决定规则语义。Harness 不内置命令白名单，也不把空策略当作允许。
- 自动审查是可选能力，不保证在所有平台或所有 Pi 认证状态下可用。
- `pi-job create` 由 Harness 使用 Tree-sitter WASM 提取实际 argv 和工作目录后审批；同一条复合命令的其他执行动作也参与判断，待人工确认的内容合并为一次请求。`pi-job send`、`key`、`poll`、`read`、`cancel` 跳过权限审批。带引号 heredoc 的 `send/key` 输入正文保持不透明；外层 Shell 中的动态求值仍按原命令审查。
- 真实模型供应商的多轮行为、长时压力和 Windows 实机审批界面仍需按实际环境验收。
