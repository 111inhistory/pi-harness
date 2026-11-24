# 异步 Shell

Shell Job 支持普通子进程和终端两种执行方式。终端使用 POSIX tmux 或 Windows psmux 的原生 ConPTY。任务继续运行时，调用 Agent 可以结束当前模型轮次，由宿主送入完成结果。

## 安装

构建需要项目要求的 Node.js 版本与 Go 1.27+ 工具链。普通 Job 不依赖终端复用器。PTY Job 在 POSIX 使用 tmux，在 Windows 使用 psmux 3.4.0 或更新版本，可通过 winget 安装和更新：

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

加载 Harness 后，Agent 通过 Bash／PowerShell 启动 Job，通过 `job_stop`、`job_send`、`job_key` 控制自己拥有的 Job。Windows PTY 后端调用 `psmux.exe`，不使用 winget 提供的 `tmux` 别名。普通终端也可使用独立的 `pi-job` CLI；`/skill:pi-job` 提供其用法。

## 创建与查询

### 模型工具

通过 `bash` 或 Windows 上的 `powershell` 直接运行命令。`timeout` 限制命令的总运行时间；`shell.maxForegroundWaitMs`（默认 180 秒）只决定本次调用等待多久就交出 Job。未提供 `timeout` 时，普通调用先等待 `shell.autoBackgroundAfterMs`（默认 60 秒）；仍在运行就返回 Job ID 和日志路径，原命令继续执行。`background: true` 在启动后立即返回 Job；同时提供 `timeout` 时，超时仍限制 Job 的执行时间。提供 `timeout` 且 `timeout * 1000` 不超过 `shell.maxForegroundWaitMs` 时，调用等待终态并返回前台结果。提供更长的 `timeout` 时，窗口内结束就返回前台结果；达到等待上限仍在运行则返回同一个 Job，`timeout` 从启动起计时，转后台不重置。

前台结果与 Pi 原生 Bash／PowerShell 对齐：保留最后 2,000 行且最多 50 KiB。同步交付确定后，从完整日志做有界尾读；不从首个输出分块恢复尾部，也不把整份日志读入内存。截断时说明已显示范围与完整日志路径，尾部诊断仍在正文中；退出码非零时保留输出，并附上退出码说明。

显式后台、自动转后台、完成通知和 `job_stop` 的模型正文先用一句话报告状态，再给出本次新增未读区间内的输出。该区间最多 32 KiB 且最多 2,000 行；超出时保留头部和尾部，省略中间部分。截断说明给出 `output.log` 路径与全局 1-based 行号，不向模型暴露字节游标；模型用 `read` 的 `offset` 按行续读，建议行号允许与最后展示行重叠 1 行，避免末尾行尚未换行时丢内容。没有截断时保留 `Output log:` 入口，日志路径只出现一次。显式后台不附自动转后台建议；自动转后台提示使用实际等待窗口，并说明仍生效的 `timeout`（如有）。同步返回的终态不补发完成通知，异步完成只通知一次；`internal_error` 的清理警告 `message` 放在正文醒目位置，不随输出截断丢失。

`pty` 默认 `false`：普通子进程使用管道输出，stdin 为 EOF。POSIX 停止操作只针对 Job 的进程组，不能清理自行脱离该进程组的进程。`pty: true` 使用 PTY／ConPTY。用 `read` 按行查看返回的临时日志路径；`job_stop(id)` 停止当前执行拥有的 Job，首句只报告实际终态，任务已先自然结束时按实际终态报告，有用时附退出码或失败原因。`job_send(id, text, enter?)` 与 `job_key(id, key)` 仅接受该执行拥有的 PTY Job；`enter` 默认 `false`。模型无需使用 CLI 的 `poll` 或字节游标。

受管 `bash`／`powershell` 保留 SDK 的 `outputSchema`，并向 `codemode` 等程序化调用方返回统一的 `structuredContent`：`output` 为本次交付的过滤输出（最多 1 MiB，不含截断尾注），并包含 `truncated`、`full_output_path`（截断、转后台或 `internal_error` 时）、`exit_code`（运行中或未产生退出码时为 `null`）、`wall_time_seconds`、`status`，以及显式后台或自动转后台时的 `job_id`。非零退出在 `codemode` 中 resolve 该对象而不抛错；脚本用 `status === 'running'` 与 `job_id` 判断是否已转后台。`structuredContent` 只服务程序化调用方，不进入模型正文或持久化历史。

Windows 非 PTY 后端使用 Job Object：先确认运行器已经加入，再启动命令；停止时确认 Job 内进程全部退出。系统禁止加入 Job Object 时启动失败，不退回到无管控执行。依赖 stdin 传入命令的 Shell（如旧版 WSL Bash）保留原生前台传输方式，但不能启动受管 Job。未安装 Go 后端或宿主不可用时，普通调用仍可使用 SDK 前台执行；显式后台或 PTY 请求则报错。

### 独立 CLI

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

`poll` 不等待新输出，默认读取尚未返回的增量。结果包含任务 ID、状态、退出码、输出、游标、日志路径及截断提示。游标是过滤后日志的 UTF-8 字节偏移，指向本块实际读到的位置，不跳过未读内容。每次输出最多 32 KiB 或 2,000 行，先达到任一上限就停止；前台尾部预算不抬高该分块上限。截断表示本次没有容纳全部输出，可继续查询或读取日志文件。任务已进入终态时，也应继续读取尚未返回的输出。

`internal_error` 表示 pi-job 自身发生内部异常，与命令返回非零的 `failed` 区分。结果的 `message` 提醒模型：清理仅尽力而为，不应假定命令已停止或资源已清理，应先检查任务再采取行动。

`create`、`poll`、`send`、`key`、`cancel` 和自动完成通知共享默认消费游标，回调或其他调用可能先取走输出。需要独立回读时使用 `read --cursor OFFSET`；`read` 不推进默认游标。`cancel` 返回当次尚未消费的输出，清理失败时返回非零退出码；无法确认资源退出时，宿主继续保留归属围栏。

任务终结与后端资源释放分别确认。正常完成、取消、超时及启动失败均须先确认自有终端后端退出，再清理临时通信资源；不能以控制命令报错或超时推断后端已经退出。POSIX 任务保存分配时的目录身份、绑定时的 Socket 身份和后端进程信息，清理前核对有效 UID、类型及文件身份，不跟随符号链接、不删除替换的端点。归属记录位于任务根目录的私有 `.owners/` 中，不依赖待校验任务目录内的文件证明该目录自身归属。

`closed` 表示正常终结路径已确认清理完成，不只是命令停止输出。无法确认清理时不写入该标记；完成回调报告 `internal_error`，保留宿主任务围栏供关闭清理入口处理，不发送正常完成结果冒充清理成功。monitor panic 沿用异常路径，不承诺写入 `closed`。这套释放不自动重试，也不回收旧任务日志。

任务状态、原始日志与过滤后的文本日志保存在任务根目录下的 `<任务ID>/`。默认根目录为 `os.tmpdir()/pi-async-shell-<uid>/`；连接宿主时沿用宿主分配的固定根目录，子进程修改 `TMPDIR`／`TEMP` 不改变任务定位。Windows 通常使用 `%TEMP%/pi-async-shell-0/<任务ID>/`，其中 `0` 是缺少 Unix UID 时的目录后缀。每个 PTY 任务使用独立 tmux server 或 psmux `-L pi-job-<任务ID>` 命名空间，不使用当前用户正在操作的会话。

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
| `PI_AGENT_SOCKET` | 当前根服务的 `main.sock` 端点地址（Windows 为对应 Named Pipe） |
| `PI_ASYNC_SHELL_TOKEN` | 当前执行代次的归属标识 |
| `PI_ASYNC_SHELL_ROOT` | 宿主分配的任务根目录，供 CLI 和后代进程一致定位 |

wrapper 从环境读取回调地址。注册与完成帧通过同一个根端点送入，携带 `agentId` 与该轮执行的 `token`；根服务验证 Actor 和租约后路由给所属执行。结果不伪装成 Agent 消息，不授予消息工具权限，也不转发给父节点代为处理。

当受管回调宿主无法初始化时，原生 Bash 与 PowerShell 执行仍然可用。wrapper 会清除继承的回调租约并将回调宿主标记为不可用。在此状态下，`pi-job create` 会在分配任务或启动命令前报告失败；普通 Shell 执行以及对既有任务的查询仍可正常使用。Harness 之外的独立 CLI 用法保持原有行为。

Subagent 有未完成 Shell 任务时，Runner 保留当前 Job 和会话，并暂停活动时间预算计时；完成结果先入队，再释放等待。子会话关闭会撤销其执行标识并停止所属任务。根会话切换、分叉、重载或关闭时，旧宿主停止所持任务并保留资源围栏，直到清理结束。

`internal_error` 结束结果等待，资源归属仍保留到原有关闭清理入口；不新增自动恢复或重试。panic 诊断和回调同样尽力而为，不保证异常后一定收到通知。

IPC 投递失败或超时不证明结果未入队，因此不会自动重发未知结果。明确拒收的注册不发送完成回调；注册结果未知时保留原有清理围栏。CLI 的日志可用于后续人工查询。

测试入口会移除继承自真实会话的 Actor、回调地址、执行 token 与任务根目录；CLI 定向测试同样隔离这些环境。回调测试只使用显式创建的测试端点，不向运行测试的真实对话发送事件。

## 验证范围

平台回归使用真实 Pi SDK 和离线模拟模型。Linux 覆盖 tmux 与普通进程；Windows 覆盖 Bash／PowerShell、ConPTY 与 Job Object，后端测试检查取消和超时后的子孙进程清理。macOS 本轮仅做交叉构建。较早版本验收见[平台验收记录](reviews/async-shell-platform-acceptance.md)。真实提供方多轮行为与长时压力仍未验收。

## 当前限制

- 默认增量游标面向同一任务的顺序读取。需要独立回读时传入 `--cursor`；`read` 不推进默认游标。
- monitor 被外部强制杀死后不会自动恢复或补发完成事件。停止所属 Subagent 或退役根会话会清理剩余任务；单独查询日志不会恢复完成通知。
- 过滤器生成文本转录，不实现完整终端屏幕重建。全屏程序、光标移动和已经输出后的行重写可能无法忠实还原，原始 PTY 日志仍保留。
- 已完成任务的日志留在用户私有临时目录中，不自动按保留期删除。长期任务的日志持续增长。
- 新任务的临时 Socket 在确认后端退出后按绑定身份清理，日志目录及根级 `.owners/` 归属记录保留。缺少归属记录的旧任务不推测所有权，也不自动迁移或清理其端点；查询历史不受此规则影响，对这类任务的破坏性清理会明确失败。
