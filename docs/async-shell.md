# 异步 Shell

`pi-job` 在真实终端中运行命令：POSIX 使用 tmux，Windows 使用 psmux 的原生 ConPTY。CLI 返回任务 ID、状态和增量输出；任务继续运行时，调用 Agent 可以结束当前模型轮次，宿主会在完成后送入结果。

## 安装

需要项目要求的 Node.js 版本与 Go 1.27+ 工具链。CLI 是原生 Go 二进制；POSIX 主机使用 tmux，Windows 使用原生 ConPTY 后端 psmux 3.4.0 或更新版本，可通过 winget 安装和更新：

```powershell
winget install --id marlocarlo.psmux --exact
winget upgrade --id marlocarlo.psmux --exact
```

从 Harness 仓库安装 CLI 和 Skill：

```sh
npm ci
npm run install:async-shell
```

安装命令构建原生 `dist/pi-job`（Windows 为 `dist/pi-job.exe`）。POSIX 在 Pi 用户目录的 `bin/pi-job` 创建指向该二进制的链接；Windows 将 `pi-job.exe` 安装到 `bin/`，并生成 PowerShell、cmd 和 Bash 启动入口。两者都会安装 [pi-job Skill](../skills/pi-job/SKILL.md) 到用户目录的 `skills/pi-job`（Windows 使用目录联接）。Pi 用户目录遵循 `PI_CODING_AGENT_DIR`，默认是 `~/.pi/agent`。Pi 内置 Shell 会将该目录加入 PATH。更新代码后重新执行安装命令，并重启 Pi 加载新版宿主与提示词；`/reload` 不保证刷新全部依赖。

加载 Harness 后，Agent 通过原有 Bash／PowerShell 工具调用 CLI；无需启用额外的模型工具。Windows 后端明确调用 `psmux.exe`。psmux 的 winget 包还提供 `tmux` 别名，与其他 tmux 发行版并存时，安装或更新可能改写 `tmux.exe` 入口；Harness 的后端选择不受该别名影响。Shell 工具指引直接提供 `PI_CODING_AGENT_DIR` 环境变量下的相对入口 `skills/pi-job/SKILL.md`，模型使用前按需读取；Shell 子进程始终提供解析后的 `PI_CODING_AGENT_DIR`，提示词不展开本机绝对路径。已提供的 Skill 入口可直接读取，无需先检索；Skill 仍可通过 Capability 发现，也可显式使用 `/skill:pi-job`。以 Pi package 安装仓库时，manifest 同样声明了 Skill 资源。普通终端也可以执行构建产物，未设置宿主回调环境时以独立模式运行。

## 创建与查询

```sh
pi-job create -- npm run build
pi-job create --wait 5s --timeout 10m -- npm run build
pi-job create --cwd /tmp/project -- npm run build
pi-job poll TASK_ID
pi-job read TASK_ID
pi-job cancel TASK_ID
```

任务 ID 统一为 `job_<8 位小写十六进制>`，例如 `job_3f8a1c2d`；创建时原子占用目录，碰撞时另取 ID，不覆盖已有任务。后续命令直接使用返回的 ID。

`--cwd <dir>` 指定任务工作目录；未指定时使用调用 CLI 时的当前目录。`--wait` 控制本次调用等待多久，默认 5s；`--wait 0` 在命令启动后立即返回。到期后任务继续运行。`--timeout` 控制任务本身的运行上限。等待窗口内完成时直接返回结果，不额外发送完成通知。

`poll` 不等待新输出，默认读取尚未返回的增量。结果包含 `id`、`status`、`exitCode`、`output`、`cursor`、`logPath` 和 `truncated`。游标是过滤后日志的 UTF-8 字节偏移。每次 `output` 最多 32 KiB，累计日志保留；`truncated` 表示本次没有容纳全部输出，可继续查询或读取日志文件。任务已进入终态时，也应继续读取尚未返回的输出。

`internal_error` 表示 pi-job 自身发生内部异常，与命令返回非零的 `failed` 区分。结果的 `message` 提醒模型：清理仅尽力而为，不应假定命令已停止或资源已清理，应先检查任务再采取行动。

`create`、`poll`、`send`、`key`、`cancel` 和自动完成通知共享默认消费游标，回调或其他调用可能先取走输出。需要独立回读时使用 `read --cursor OFFSET`；`read` 不推进默认游标。`cancel` 返回当次尚未消费的输出，清理失败时返回非零退出码；无法确认资源退出时，宿主继续保留归属围栏。

任务状态、原始 PTY 日志与过滤后的文本日志保存在任务根目录下的 `<任务ID>/`。默认根目录为 `os.tmpdir()/pi-async-shell-<uid>/`；连接宿主时，CLI 沿用宿主分配的固定根目录，子进程修改 `TMPDIR`／`TEMP` 不改变任务定位。Windows 通常使用 `%TEMP%/pi-async-shell-0/<任务ID>/`，其中 `0` 是缺少 Unix UID 时的目录后缀。每个任务使用独立 tmux server 或 psmux `-L pi-job-<任务ID>` 命名空间，不使用当前用户正在操作的会话。

Windows 按实际目录 ACL 验证私有性，共享临时目录中的宽泛访问授权会被拒绝，Harness 不会自动改写已有目录权限。

## 输入

`create --` 后的内容按可执行文件与参数传递。Windows 上宜使用 PowerShell 7；使用 Git Bash 调用原生程序时，路径参数宜使用 `C:/project/script.mjs` 形式，复杂脚本宜写入文件后调用，避免在 `-e` 正文中嵌入反斜杠路径。需要 Shell 语法时显式启动 Shell：

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

`send` 每次接收最多 64 KiB 的 UTF-8 正文，超限时拒绝。`send --enter` 可在文本后显式发送 Enter。heredoc 和 PowerShell 管道产生的换行是输入的一部分；目标程序如何解释换行与粘贴，由其终端模式决定。Windows 控制台的规范模式可能等到 CR／Enter 才提交一行；raw mode 下 LF 可原样送达，CRLF 在 Windows 终端路径中可能折叠为 LF，单独的 Enter 送入 CR。按键名称遵循 tmux `send-keys`。

Windows 的 `.cmd`／`.bat` 目标经 `cmd.exe` 启动并转义参数，包括 `npm` 等 PATH／PATHEXT 启动器；这类目标不接受含裸 CR／LF 的参数。需要传递这类正文时使用可执行程序或 stdin。批处理脚本文本仍按 cmd 的代码页解释；引用脚本自身目录时可使用 `%~dp0`，避免在脚本内写入非 ASCII 绝对路径字面量。

命令和输入正文不删除 Shell 特殊字符。模型看到的输出会过滤终端控制序列，原始日志保留 PTY 字节。PTY 会合并终端上的 stdout 与 stderr，且程序可能因检测到终端而改变输出格式；过滤文本不是原始 stdout 的逐字节副本。Windows ConPTY 会按面板宽度折行，并可能重发屏幕单元格，因此过滤文本可能出现额外换行或重复字符。需要程序原始字节流时，让程序写入日志文件再读取。

## Harness 接入

宿主在每次 Bash／PowerShell 执行时注入当前调用者的环境：

| 变量 | 含义 |
| --- | --- |
| `PI_AGENT_ID` | 当前 Actor，Main 或 Subagent ID |
| `PI_AGENT_SOCKET` | 当前 Actor 的受管端点地址 |
| `PI_ASYNC_SHELL_TOKEN` | 当前执行代次的归属标识 |
| `PI_ASYNC_SHELL_ROOT` | 宿主分配的任务根目录，供 CLI 和后代进程一致定位 |

wrapper 从环境读取回调地址。注册与完成事件进入同一个 Actor 端点，由宿主按异步 Shell 协议接收。结果不伪装成 Agent 消息，不授予消息工具权限，也不转发给父节点代为处理。

Native Bash and PowerShell execution remains available when the managed callback host cannot initialize. The wrapper clears inherited callback leases and marks the callback host unavailable. In this state, `pi-job create` reports the failure before allocating a task or starting a command; ordinary shell execution and queries of existing tasks remain available. Standalone CLI use outside the Harness retains its existing behavior.

Subagent 有未完成 Shell 任务时，Runner 保留当前 Job 和会话，并暂停活动时间预算计时；完成结果先入队，再释放等待。子会话关闭会撤销其执行标识并停止所属任务。根会话切换、分叉、重载或关闭时，旧宿主停止所持任务并保留资源围栏，直到清理结束。

`internal_error` 结束结果等待，资源归属仍保留到原有关闭清理入口；不新增自动恢复或重试。panic 诊断和回调同样尽力而为，不保证异常后一定收到通知。

IPC 投递失败或超时不证明结果未入队，因此不会自动重发未知结果。明确拒收的注册不发送完成回调；注册结果未知时保留原有清理围栏。CLI 的日志可用于后续人工查询。

测试入口会移除继承自真实会话的 Actor、回调地址、执行 token 与任务根目录；CLI 定向测试同样隔离这些环境。回调测试只使用显式创建的测试端点，不向运行测试的真实对话发送事件。

## 验证范围

Linux 与原生 Windows 已通过真实 Pi SDK、离线模拟模型和真实终端后端的回归。Windows 验证了 Bash／PowerShell 两个宿主入口、Main／Subagent 完成回调、取消清理、Unicode 参数、大块输入和增量输出。版本基线、完整结果及未归因现象见[平台验收记录](reviews/async-shell-platform-acceptance.md)。真实提供方多轮行为与长时压力仍未验收。

## 当前限制

- 默认增量游标面向同一任务的顺序读取。需要独立回读时传入 `--cursor`；`read` 不推进默认游标。
- monitor 被外部强制杀死后不会自动恢复或补发完成事件。停止所属 Subagent 或退役根会话会清理剩余任务；单独查询日志不会恢复完成通知。
- 过滤器生成文本转录，不实现完整终端屏幕重建。全屏程序、光标移动和已经输出后的行重写可能无法忠实还原，原始 PTY 日志仍保留。
- 已完成任务的日志留在用户私有临时目录中，不自动按保留期删除。长期任务的日志持续增长。
