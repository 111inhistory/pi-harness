# 异步 Shell

`pi-job` 在 tmux 的真实终端中运行命令。CLI 返回任务 ID、状态和增量输出；任务继续运行时，调用 Agent 可以结束当前模型轮次，宿主会在完成后送入结果。

## 安装

需要项目要求的 Node.js 版本。POSIX 主机使用 tmux；Windows 使用原生 ConPTY 后端 psmux 3.4.0 或更新版本，可通过 winget 安装和更新：

```powershell
winget install --id marlocarlo.psmux --exact
winget upgrade --id marlocarlo.psmux --exact
```

从 Harness 仓库安装 CLI 和 Skill：

```sh
npm ci
npm run install:async-shell
```

安装命令构建 `dist/pi-job.mjs`。POSIX 在 Pi 用户目录的 `bin/pi-job` 创建指向构建产物的链接；Windows 将 bundle 安装到 `bin/pi-job.mjs`，并生成 PowerShell、cmd 和 Bash 启动入口。两者都会安装 [pi-job Skill](../skills/pi-job/SKILL.md) 到用户目录的 `skills/pi-job`（Windows 使用目录联接）。Pi 用户目录遵循 `PI_CODING_AGENT_DIR`，默认是 `~/.pi/agent`。Pi 内置 Shell 会将该目录加入 PATH。更新代码后重新执行安装命令。

加载 Harness 后，Agent 通过原有 Bash／PowerShell 工具调用 CLI；无需启用额外的模型工具。Windows 后端明确调用 `psmux.exe`，不依赖其他发行版的 `tmux.exe` 别名。Skill 可通过 Capability 发现，也可显式使用 `/skill:pi-job`。以 Pi package 安装仓库时，manifest 同样声明了 Skill 资源。普通终端也可以执行构建产物，未设置宿主回调环境时以独立模式运行。

## 创建与查询

```sh
pi-job create -- npm run build
pi-job create --wait 5s --timeout 10m -- npm run build
pi-job poll TASK_ID
pi-job read TASK_ID
pi-job cancel TASK_ID
```

`--wait` 控制本次调用等待多久，到期后任务继续运行。`--timeout` 控制任务本身的运行上限。等待窗口内完成时直接返回结果，不额外发送完成通知。

`poll` 不等待新输出，默认读取尚未返回的增量。结果包含 `id`、`status`、`exitCode`、`output`、`cursor`、`logPath` 和 `truncated`。游标是过滤后日志的 UTF-8 字节偏移。单次响应有长度上限，累计日志保留；`truncated` 表示本次没有容纳全部输出，可继续查询或读取日志文件。

任务状态、原始 PTY 日志与过滤后的文本日志保存在 `os.tmpdir()/pi-async-shell-<uid>/<任务ID>/`。Windows 通常使用 `%TEMP%/pi-async-shell-0/<任务ID>/`，其中 `0` 是缺少 Unix UID 时的目录后缀。每个任务使用独立 tmux server 或 psmux `-L pi-job-<任务ID>` 命名空间，不使用当前用户正在操作的会话。

Windows 按实际目录 ACL 验证私有性，共享临时目录中的宽泛访问授权会被拒绝，Harness 不会自动改写已有目录权限。

## 输入

`create --` 后的内容按可执行文件与参数传递。需要 Shell 语法时显式启动 Shell：

```sh
pi-job create -- bash -c 'printf "%s\n" "$PWD"; npm run build'
```

使用加引号的 heredoc 提交多行文本，防止调用方 Bash 展开变量与命令替换：

```sh
pi-job send TASK_ID <<'EOF'
first line
literal "$value" and $(command)
EOF

pi-job key TASK_ID Enter
pi-job key TASK_ID C-c
```

PowerShell 可用字面 here-string：

```powershell
@'
first line
literal "$value" and $(command)
'@ | pi-job send TASK_ID
pi-job key TASK_ID Enter
```

`send --enter` 可在文本后显式发送 Enter。heredoc 和 PowerShell 管道产生的换行是输入的一部分；目标程序如何解释换行与粘贴，由其终端模式决定。Windows 控制台的规范模式可能等到 CR／Enter 才提交一行，并产生 CRLF；raw mode 的行为由程序控制。按键名称遵循 tmux `send-keys`。

Windows 的 `.cmd`／`.bat` 目标经 `cmd.exe` 启动并转义参数，包括 `npm` 等 PATH／PATHEXT 启动器；这类目标不接受含裸 CR／LF 的参数。需要传递这类正文时使用可执行程序或 stdin。

命令和输入正文不删除 Shell 特殊字符。模型看到的输出会过滤终端控制序列，原始日志保留 PTY 字节。PTY 会合并终端上的 stdout 与 stderr，且程序可能因检测到终端而改变输出格式；过滤文本不是原始 stdout 的逐字节副本。

## Harness 接入

宿主在每次 Bash／PowerShell 执行时注入当前调用者的环境：

| 变量 | 含义 |
| --- | --- |
| `PI_AGENT_ID` | 当前 Actor，Main 或 Subagent ID |
| `PI_AGENT_SOCKET` | 当前 Actor 的受管端点地址 |
| `PI_ASYNC_SHELL_TOKEN` | 当前执行代次的归属标识 |

wrapper 从环境读取回调地址。注册与完成事件进入同一个 Actor 端点，由宿主按异步 Shell 协议接收。结果不伪装成 Agent 消息，不授予消息工具权限，也不转发给父节点代为处理。

Subagent 有未完成 Shell 任务时，Runner 保留当前 Job 和会话，并暂停活动时间预算计时；完成结果先入队，再释放等待。子会话关闭会撤销其执行标识并停止所属任务。根会话切换、分叉、重载或关闭时，旧宿主停止所持任务并保留资源围栏，直到清理结束。

IPC 投递失败或超时不证明结果未入队，因此不会自动重发未知结果。CLI 的日志可用于后续人工查询。

## 当前限制

- 默认增量游标面向同一任务的顺序读取。需要独立回读时传入 `--cursor`；`read` 不推进默认游标。
- monitor 被外部强制杀死后不会自动恢复或补发完成事件。停止所属 Subagent 或退役根会话会清理剩余任务；单独查询日志不会恢复完成通知。
- 过滤器生成文本转录，不实现完整终端屏幕重建。全屏程序、光标移动和已经输出后的行重写可能无法忠实还原，原始 PTY 日志仍保留。
- 已完成任务的日志留在用户私有临时目录中，不自动按保留期删除。长期任务的日志持续增长。
