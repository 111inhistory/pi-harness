# Windows 原生适配方案

状态：IPC 代码适配已实施，Windows 实机尚未验证。本文保留后续验证计划。

已实施：平台地址与清理模块、注册表 key、pipe mkdir 跳过、IPC 工具描述、现有 SDK 测试的平台断言、PowerShell checker 的 UTF-8 输入输出。文件存储与模型路由没有平台专用重写。

平台模块为 `src/subagent-ipc-unix.mjs`、`src/subagent-ipc-windows.mjs`；`src/subagent-ipc.mjs` 按系统选择。server／client 的 Node net 调用、NDJSON、身份绑定和广播业务仍在 `src/subagent-socket.mjs` 共用。

基线：`331a0c8`。目标是在原生 Windows 中运行 Pi Harness，不要求 WSL。WSL 继续走现有 Linux 路径，不算原生 Windows 验收。

## 1. 结论

采用 Windows Named Pipe 替代 Unix Domain Socket。继续使用 Node 的 `net.createServer()` 和 `net.connect()`。

Windows 适配只修改端点地址、端点清理、写入入口、Shell 和平台测试。不要重写 Subagent runtime、Capability 或路由器。

保留以下业务规则：

- NDJSON、UTF-8 分片解码、单向投递和 host 绑定发送者。
- Main 上行入口、直接父级上行和直接 children 广播。
- depth、每父活跃上限、停止／复活和双轨历史。
- 父级工具资格、角色黑名单、显式 `enableTools` 和原生 Skill 包筛选。
- `write` 静态支持文件和 IPC；`msg_write` 只支持 IPC，按角色配置启用。
- 不增加 ACK、握手、收件箱、自动重试、TCP 回退或新权限框架。

## 2. 已查到的阻塞点

以下结论来自当前源码，不代表 Windows 测试结果。

| 位置 | 当前行为 | Windows 适配要求 |
|---|---|---|
| `src/subagent-socket.mjs` | 默认目录为 `/tmp/pi-subagents` | 集中定义平台默认值；Windows 使用 `os.tmpdir()` 作为命名隔离输入 |
| `extensions/subagent.mjs` | 再次写死同一个 `/tmp` 默认值 | 复用 socket 模块默认值，不留两份默认值 |
| socket 地址函数 | 用文件目录拼接 `.sock` 路径 | Windows 返回 Named Pipe 地址，不返回普通磁盘路径 |
| 两个 server 创建函数 | 先 mkdir、unlink，再 listen | Named Pipe 不执行 mkdir、exists、unlink |
| `registeredSockets` | 插入和查找均用 `path.resolve()` | 使用同一个 IPC 地址 key 函数，不把 pipe 当文件路径 |
| Socket-aware WriteOperations | 返回真实文件系统 mkdir | Native write 在写入前调用 mkdir；pipe 的父命名空间不得传给文件系统 |
| `msg_write` | 描述仅限 Unix Socket；按 `.sock` 判断 | 描述本机 IPC；识别 Named Pipe 地址 |
| SDK 测试 fixture | 对端点调用 `stat().isSocket()` | 改为监听状态／连接检查；pipe 不是文件 |
| 原生工具移植 | 部分兼容逻辑列举固定原生工具名 | 验证 Windows SDK 的实际工具注册表，不能漏掉其原生 PowerShell 工具 |
| Shell preflight | 已识别 Bash、PowerShell，使用 Node spawn | 保留现有实现，实测编码、解析和超时终止 |

`src/subagent-storage.mjs` 已用 Node 路径函数组织会话文件。存储模块不是首要重写对象，但 seed 的 rename、文件锁和恢复仍需在 Windows 验证。

## 3. IPC 地址与生命周期

### 3.1 地址格式

Linux 保留现有文件地址。Windows 使用平坦 pipe 名，不模拟文件目录树。

示例：

```text
Linux:
/tmp/pi-subagents/<uid>/Main.sock
/tmp/pi-subagents/<uid>/sub_01.sock
/tmp/pi-subagents/<uid>/sub_01/children.sock

Windows:
\\.\pipe\pi-harness-<namespaceHash>-Main.sock
\\.\pipe\pi-harness-<namespaceHash>-sub_01.sock
\\.\pipe\pi-harness-<namespaceHash>-sub_01-children.sock
```

Unix 的 `<uid>` 沿用当前根 Session UID。Windows 的 `<namespaceHash>` 是实际端点根路径的 12 位 SHA-256 前缀，该路径已包含根 Session UID。哈希区分不同会话、测试工作区或安装目录，不是另一套 Actor ID。

保留 `PI_SUBAGENT_SOCKET_DIR`。在 Linux 上，该值仍是 socket 文件根目录；在 Windows 上，该值参与 pipe 命名隔离，不表示需要创建 pipe 文件。没有该变量时，Windows 的命名隔离输入取 `os.tmpdir()` 下的 `pi-subagents`。

`socket` 返回字段和启动上下文中的 `parentSocket` 不改名。模型把端点地址视为不透明字符串，复制返回值即可。模型不必自行拼接 pipe 名。

### 3.2 最小代码入口

在现有 `src/subagent-socket.mjs` 内集中完成以下工作：

1. 地址函数按平台生成 Unix Socket 或 Named Pipe 地址。
2. 地址识别函数区分 pipe 命名空间与普通文件路径。
3. 注册表 key 函数统一地址比较。

不要为这三项另建 transport factory、provider、事件总线或类层次。

Unix 地址继续按文件路径规范化。pipe 地址不使用通用文件路径规范化；按 Windows pipe 名的比较规则生成 key。大小写变化不能让受管理端点被误判成外部端点，从而绕过 host 的来源绑定。地址比较规则须用 Windows 实测确认。

### 3.3 创建与关闭

- Unix Socket 继续使用现有文件创建和清理逻辑。
- Named Pipe 直接 listen，不调用文件系统 mkdir、stat 或 unlink。
- 关闭 pipe 时关闭 server 和已接受的连接，不删除虚构的磁盘文件。
- listen 失败应报告失败，不能返回一个看似已可用的端点。
- 若 Windows 实测发现发布地址与监听就绪之间存在竞态，只在 host 内等待 `listening` 事件，不增加线上握手或重试。
- 重载时先完成旧 listener 退役，再建立同名 listener。沿用现有 service 生命周期，不添加第二套端点所有权。

监听冲突、连接关闭和进程退出的具体错误码以 Windows 实测为准，不预先写一组猜测的异常回退。

## 4. write 和 msg_write

两种工具继续静态注册，不能根据启用列表动态改变 `write` 的实现。

| 工具 | 普通文件 | Unix Socket / Named Pipe | 启用方式 |
|---|---|---|---|
| `write` | 支持 | 支持 | SDK 默认集合及角色黑名单 |
| `msg_write` | 禁止 | 支持 | researcher／reviewer 的 `enableTools` |

两种工具复用相同的 IPC backend、端点注册表和发送者绑定逻辑。

### 4.1 Native write 的前置步骤

当前 Pi `createWriteToolDefinition()` 在调用 WriteOperations.writeFile 前，先执行文件路径解析和 WriteOperations.mkdir。只修改 `net.connect()` 不足以适配 pipe。

实施前验证：

1. SDK 的路径解析保留 `\\.\pipe\...` 地址，不把地址拼到 cwd。
2. SDK 的 dirname 结果可被现有 adapter 识别为 pipe 命名空间。
3. adapter 对 pipe 命名空间的 mkdir 返回，不执行文件系统创建。
4. adapter 对普通文件的 mkdir 和写入行为保持原样。

若当前 SDK 会改坏 pipe 地址，仅在工具 execute 入口提前识别 pipe，并直接调用共享 IPC 写入函数；普通文件继续委托原生 write。这个分支按地址类型选择 I/O，不按角色或启用列表选择工具实现。

该分支仍应保留取消检查、Socket-only 限制和 host 绑定。不要把 NDJSON 解析、状态检查或广播权限复制到两个 execute 函数中。

### 4.2 来源绑定与权限

受管理端点仍以 host 注册表判定，不能仅看 `.sock` 后缀、pipe 前缀或 Actor basename。

- 受管理端点拒绝调用方提供 `from`，再注入真实发送者。
- 外部端点不注入 Agent 身份，不触发 Agent 生命周期。
- 广播仍检查发送者是否为该端点所属父级。
- `write` 被禁止时，`msg_write` 不获得普通文件写入能力。
- 角色配置中的工具名不因平台改名。不要自动把 `bash` 替换成 `powershell`。

## 5. 文件、安装与原生资源

### 5.1 文件路径

用 `path`、`os.tmpdir()` 和 Pi 的 agentDir API 生成本机文件路径。源码和部署配置不要写死 `/home/...`。

验证路径条件：

- 用户目录和工作目录含空格、中文。
- 盘符、反斜杠、UNC 文件路径与 pipe 地址不会被资源 URI 解析器混淆。
- 普通文件和 IPC 地址使用各自的比较规则，不统一转小写。
- 测试中的 file URL 用 `fileURLToPath()` 转换，不使用 URL.pathname 作为 Windows 文件路径。

先修复实测失败的位置，不批量重写已使用 Node 路径 API 的模块。

### 5.2 扩展安装

当前机器使用 `.js` 链接到仓库 `.mjs` 的部署方式。Windows 不应把管理员权限或符号链接作为安装前提。

使用 Pi 原生配置引用扩展文件。当前 loader 的自动目录扫描只找 `.js`／`.ts`，但显式文件路径不受该目录扫描限制；可以配置仓库的 `.mjs` 文件路径，无需符号链接。Windows 加载仍需实机验证，不复制生产代码或改 Pi 的包解析器。

原生配置示例（按实际仓库位置修改）：

```json
{
  "extensions": [
    "C:/code/pi-harness/extensions/protocol-io.mjs",
    "C:/code/pi-harness/extensions/capability.mjs",
    "C:/code/pi-harness/extensions/subagent.mjs",
    "C:/code/pi-harness/extensions/shell-preflight.mjs"
  ]
}
```

将角色路由配置放在 Pi 实际 agentDir 下，模型和认证配置继续使用 Pi 原生配置。不复制 Linux 机器的绝对路径或凭据。

Skill 继续通过 Pi 原生 package 配置、解析和过滤发现。Windows 安装不能恢复自定义目录扫描或 Skill 符号链接方案。

### 5.3 会话与历史

保留原生 SessionManager、根分支 checkpoint 和现有双轨历史。不要新建 Windows 专用存储层。

验证 seed 写入后的 rename、原生会话打开、历史追加、停止后 flush 和重载恢复。对共享冲突应报告文件和操作；不要为所有 I/O 添加通用自动重试。

跨操作系统复制会话不是首批支持目标。checkpoint 中的旧 cwd、会话文件位置及工具快照不能只靠替换路径分隔符迁移。

## 6. Shell 与子进程

已有 shell preflight 支持 PowerShell Parser 和多种 Unix Shell。Windows 首先复用 Pi 的 shell 配置及现有 preflight。

- 不要求 WSL Bash。
- 验证 Git Bash 的绝对 executable 路径和工作目录。
- 验证 PowerShell 的中文 stdin、语法错误行号和多行脚本。
- 当前 SDK 源码包含原生 powershell 工具定义，builtin 来源可沿用现有移植规则；Windows 上的默认启用集合和 executable 可用性仍需实测。只有父级实际提供该工具时，子 Agent 才能启用或移植它。
- 检查固定原生工具名列表是否只服务旧 checkpoint 兼容，避免把该列表当成所有平台的工具全集。
- 不增加第二套 PowerShell 执行器。
- 验证 preflight 超时后 checker 实际退出，测试超时后 worker 不残留。

Windows 的进程终止语义不能用 POSIX signal 名称推断。当前 SIGKILL 调用不等于已经证实进程树退出。若实测留下子进程，再针对该调用链修复；不要先引入通用进程树管理框架。

## 7. 测试与验证

复用 `test/` 与 `test-support/subagent-sdk-scenario.mjs`。不新建专项验收框架。

### 7.1 不需要 Windows 的检查

- 地址函数生成 Windows pipe 字符串及 Linux socket 路径。
- 两类地址的注册表 key 和广播地址不会冲突。
- URI 与盘符识别、配置读取和角色黑名单检查。
- 本轮 Linux 全量回归。

这些检查不能替代真实 Windows I/O。

### 7.2 真实 Windows 检查

在 Windows 原生 Node 进程中复用现有场景：

1. 文件写入、通用 write 的 IPC 写入、Socket-only msg_write 拒绝普通文件。
2. researcher／reviewer 显式启用 msg_write，executor 使用 write。
3. 子 Agent 向 Main 投递；空闲唤醒与忙碌 steer。
4. depth 2 向父级投递；父级停止后复活，发送者身份保持。
5. 直接 children 广播；兄弟、祖先和跨层广播不越界。
6. UTF-8 分片、多条 NDJSON、来源伪造拒绝。
7. stopping／finalizing、停止后历史可读、完整 listener 退役。
8. 4×4 并发、默认 list 与 all 模式、工具权限和原生 Skill 包筛选。
9. 重载、进程退出、同名端点重新建立、端点冲突报错。
10. 含中文与空格的路径、Shell 解析和 checker 超时退出。

将现有 `stat().isSocket()` 断言改为平台对应的监听／连接检查。Unix 专用的文件残留检查继续保留，但只在 Unix 运行。不要跳过整个 Windows Socket suite。

使用 `npm test` 或 Node test runner；不要要求 Windows 安装 GNU timeout。继续用测试超时和 child_process timeout 限制测试时长。

如仓库后续接入 CI，运行现有 suite 的 Windows job 即可。首次记录应包含 Windows、Node、Pi SDK 和 Shell 的实际版本；不把某个未测试版本标成最低支持版本。

## 8. 权限边界与未验证项

Named Pipe 的默认 ACL 和远程访问条件尚未在本项目验证。生成 `\\.\pipe\...` 本机地址，不等于已经限制其他用户或 SMB 客户端。

首批目标是单用户本机运行，不承诺跨用户安全隔离。上线前应验证其他账户的访问行为。若产品要求多用户隔离，另行决定 ACL 实现；不要用新的消息握手或假称 host 来源绑定就是 OS 身份认证。

Node 官方 IPC 文档作为实施参考：<https://nodejs.org/api/net.html#ipc-support>。本次在线文档检索未成功，方案中的平台行为须在实施时核对官方文档，并用 Windows 实测确认。

## 9. 后续验证顺序

代码已使用原生 write 的原有路径解析和 mutation queue。Win32 路径测试确认生成的 pipe 地址及 dirname 可保留；现有 adapter 对 pipe 父命名空间不执行 mkdir。没有增加提前绕过原生 write 的 execute 分支。

`test/subagent-ipc.test.mjs` 包含仅在真实 Windows 执行的 native write → Named Pipe 检查；在 Linux 上跳过该项，不将路径模拟测试当成实机成功。现有 Socket 与 SDK suite 没有整体跳过 Windows。

实施和验证按以下顺序收敛：

1. 完成短验证：Named Pipe listen/connect/close、SDK 路径解析与 mkdir、原生 Shell 工具注册表。
2. 修改 socket 模块的地址生成、地址 key 和 Unix-only 文件操作。
3. 修改 extension 的默认值、注册表调用点及两种工具的地址描述。
4. 修复 Windows 实测失败的文件、Shell 或资源路径代码。
5. 改造现有测试中的 Unix-only 断言，运行 Windows 与 Linux suite。
6. 写明安装方式、已测试版本和已知限制，再声明 Windows 支持。

回滚时撤销上述平台差异，不改 Actor／Job 状态机、模型 Preference 或路由配置。Windows 与 Linux 可以使用同一仓库；两种 OS 不共享同一个活跃 Session 的 IPC listener。
