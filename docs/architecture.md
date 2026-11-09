# 当前架构

公开行为以[接口契约](interface-contract.md)为准。本文描述代码中的职责和边界。存储字段见[存储说明](subagent-storage.md)，配置参数见[Harness 参数配置](harness-configuration.md)，验收缺口见[已知问题](known-issues.md)。

## 插件注册

`extensions/` 只保留公开注册入口：`subagent.ts`、`capability.ts`、`btw.ts`、`result-rendering.ts`、`preset.ts` 和可选的 `shell-preflight.ts`。包清单按结果渲染、Subagent、Capability、独立问答、模型 Preset 的顺序加载默认入口。Capability 的完整装配位于 `src/capability/extension.ts`；子会话直接复用它，不从公开入口重复装配根工具。模型 Preset 的装配位于 `src/preset/*` 与 `extensions/preset.ts`。

入口分开，底层仍共享。Pi 给每个扩展不同的 API 对象；`harness-config.ts` 与 `capability/scope.ts` 通过同一 ResourceLoader 的原生事件总线取得共享配置提供者和资格状态，保留各自 API 的局部引用，不建立进程全局会话注册表。不同 ResourceLoader 的总线隔离；子会话继续通过显式父资格链和配置快照继承。异步 Shell 仍依附 Subagent 的资源生命周期。

## 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| `harness-config.ts` | 外部配置读取、合成与校验；根配置快照和指定提示词段落 | 路由角色、Pi 原生设置、运行中 Job 变更 |
| `runtime.ts` | Actor 拓扑、Job 状态机、活跃名额控制（Fresh 与 Inherited 独立父节点名额池）、停止原因、续跑准入、中断恢复、终态事件与单一 Budget 监控（监控 lifetime 与 active hard 截止时间，`startActive` 时重置，`stop`/`finalize`/`end` 时清理） | SDK Session、Socket、原生文件解析 |
| `native-runner.ts` | Session 执行句柄生命周期、输入准入、在途 steer 协调、原生输入缓冲、本地就绪（local readiness）判定与资源清理 | 裁定 Job 状态、决定空闲唤醒、写根终态 |
| `actor-sessions.ts` | Actor 角色／模型身份记录、原生 manager 引用与已记录锚点、身份补丁 | Job 状态和停止排序 |
| `native-session.ts` | Settings、ResourceLoader、子扩展装配及 SDK 会话创建（Fresh／Inherited 均独立加载扩展与 MCP 后端，Inherited 恢复捕获白名单并对异步 MCP 提供有界等待，默认 10 秒） | 路由、任务结果裁决 |
| `root-service.ts` | 组装上述模块，根事件写入、历史视图、内存超限临时文件管理（进程正常退出清理）和故障锁存 | 第二套 Job 状态机 |
| `extension.ts`、`lifecycle.ts` | SDK 生命周期钩子、代次隔离、退役期限和资源隔离 | 伪造物理退出、重跑已结束任务 |
| `surface.ts`、`message-write.ts` | 工具声明、调用方身份绑定、输入捕获、专用 `msg_write` 消息工具（`write` 为 SDK 原生文件工具完全保持不变） | 持有全局注册表或执行循环 |
| `command.ts`、`status-view.ts` | `/subagent` 命令注册、参数解析、错误呈现与列表文本渲染 | Job 状态、准入或消息投递 |
| `capability/command.ts`、`capability/catalog.ts`、`capability/enable.ts`、`capability/activation.ts` | `/capability` 目录浏览与用户启用、按实时注册表解析启用目标、激活与可达性判定（发现、命令与跨会话回复工具加载共用） | 检索会话、路由、Subagent 状态 |
| `capability/admission.ts` | 单次操作的工具准入视图：一次解析作用域链与分支记录，提供 `declares`（声明）、`admits`（执行）、`admitsManual` 与 `admitsServer` | 跨请求缓存、第二套权限服务、改写激活集 |
| `capability/lazy-schemas.ts`、`capability/codemode-mode.ts` | lazySchemas ref 解析与组归属、生效 Codemode 模式（预设记录在分支上的覆盖，回退到 Pi 设置） | 改变启用集合、授权或工具 exposure；写入 Pi 原生设置 |
| `src/preset/*`、`extensions/preset.ts` | 模型 Preset 配置加载与合并、解析、模型／thinking／工具应用、分支快照与 instructions 段落、`/preset` 与 `--preset` | Capability 检索、Subagent 路由、Pi 原生设置写入 |
| `listeners.ts`、`ipc/` | 端点目录、监听、NDJSON 分帧、平台资源归属校验，以及“端点属于哪个 session 命名空间”的地址分类（Unix 为目录包含，Windows 为管道名前缀） | 用显示窗口决定可达性、另写广播状态机、用文件系统路径推断管道归属 |
| `session-peers.ts`、`session-directory.ts` | 根持有的跨 session 操作对象、连接与目录名称同步；目录发布、存活校验与归属删除，受管 `Main` 寻址、复合发送者身份与单帧写入 | 根代次、压缩闸门、Runtime、认证协议或跨主机调度 |
| `native-delivery.ts`、`delivery.ts` | 独立通知封装、检查原生交接结果、明确拒收后的保留会话追加 | 模型已读回执、自动重发或消息合并 |
| `btw/command.ts`、`btw/session.ts`、`btw/panel.ts` | `/btw` 命令、内存继承会话、工具阻断和临时问答面板；关闭与根生命周期清理 | Actor／Job、持久化问答或主会话消息写入 |
| `inherited-context.ts` | 共享分支捕获，在清理未决工具前锁定物理模型，并捕获独立的出站缓存标识 | 伪造身份或跨分支泄漏 |
| `provider-session.ts`、`session-transcript.ts` | 按明确模型能力判断原生追加路径，组装尾部指令与工具声明；请求编码交给 Pi | 路由、执行授权、手写协议请求 |
| `session-cache.ts`、`session-cache-runtime.ts` | Main 最终 payload 缓存标识观察、Responses 继承适配、原生分支记录与生命周期围栏 | 改写本地 Session ID、账号路由或保证缓存命中 |
| `async-shell/cli.ts`、`async-shell/tmux.ts`、`async-shell/output.ts` | 异步命令接口、每任务终端资源、完整 PTY 日志、增量过滤输出和完成回调 | Agent 拓扑、模型轮次或执行授权 |
| `async-shell/platform*.ts` | POSIX tmux Socket／Windows psmux label、终端启动与输入、进程归属查询、Windows batch 参数传输 | 任务状态、输出游标或通知路由 |
| `async-shell/host.ts`、`async-shell/surface.ts` | 每次 Shell 的调用者环境、执行代次归属、未完成任务登记与取消 | tmux 状态机、消息工具授予或跨主机调度 |
| `prompt-section-journal.ts`、`tool-guidance.ts`、`tool-prompt-updates.ts`、`capability/tool-instructions.ts` | 初始指引随工具声明投影；分支记录保存正文与落点，变更在上下文尾部追加系统更新 | 用最新资产覆盖历史指引、授予执行权限或移除工具 |

`subagent_create` 在本批 Runner 本地就绪后返回。本地就绪包括路由完成、会话创建、扩展与工具配置完成、初始输入就绪和 IPC 监听就绪。返回项包含 `id`、`socket`、`role` 与 `model`。它不等待首次模型流分发，也不把 `running` 当作启动成功证明。注册后的启动失败不会撤销同批其他节点，也不自动重试。运行时 Job 注册和执行状态仍由 Runtime 独立管理。

Runtime 的 `job.status` 是领域事实。Runner 的输入准入栅栏表示原生句柄是否还能接收消息，不表示 Job 已停止。取消后，Job 仍占用 Actor 与名额，直到原生执行退出并完成收尾。

配置由 `harness-config.ts` 统一解析，按默认、全局、受信项目顺序合成。Root 使用配置快照并传给子会话；Subagent 深度、Fresh 与 Inherited 独立父节点活跃名额、各层 Budget、重试和提示词段落，以及 Capability 检索与 Codemode 参数均从该快照读取。已有 Job 保留原 Budget。边界和字段见[Harness 参数配置](harness-configuration.md)。

## 创建、执行与恢复

Fresh 在自己的 Job Budget 内路由。初始工具使用 Pi 默认工具与已配置扩展，并合并路由角色的 `enableTools`；`excludeTools` 始终排除，不另设内置工具白名单。Fresh 与 Inherited 均独立加载已配置的扩展与 MCP 后端（`noExtensions: false`），并运行扩展的启动与关闭钩子，仅排除 `subagent.ts`、`capability.ts`、`btw.ts` 根注册入口，由子会话自己的 surface 与 Capability 装配替代；结果渲染入口可继续加载。子会话的资源过滤保留用户与项目设置各自的路径作用域，不写回配置文件。

Inherited 在捕获时通过父会话生成该调用的 assistant 消息锁定底层物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由。Inherited 独立加载配置的扩展与 MCP 后端。它恢复捕获的工具白名单、系统提示词与思考强度。白名单仅限可重新创建的文件型扩展工具与 MCP 工具，父会话专属诊断工具不传递。若继承的 MCP 工具尚未完成异步注册，按 `subagent.inheritedToolWaitMs` 有界等待，默认最多 10 秒，超时则抛出 `inherited_tool_unavailable`。路由完成的 Actor 在续跑时沿用已记录身份，不重新选择角色。

Runner 通过 `openSubagentExecution` 获得 SDK Session。共享执行句柄负责 abort 和 cleanup；Root 不用超时竞争强制 dispose 一个仍在执行的 Session。

父 Subagent 回复结束后，若直接子节点仍处于 `running`、`stopping` 或 `finalizing`，或当前执行仍持有未完成的异步 Shell 任务，Runner 保留会话并等待事件，不结束当前 Job。Runtime 暂停活跃时间并重排到 lifetime 截止时间；消息、子节点通知或最后一项工作结束会唤醒原循环，恢复活跃时间后重排 deadline。队列和所属工作均为空才正常收尾，期间不分配新 Job 或 Budget。取消会释放等待；失败或取消后的晚到子节点通知只追加保留历史。

异步 Shell 的注册与完成走所属 Actor 的受管端点，通过执行代次标识与普通 Agent 消息区分。完成结果先进入原生输入队列，再撤销未完成登记并唤醒 Runner；不伪造发送者，不创建续跑 Job。子会话关闭与 Root 退役取消所持任务，底层资源未退出时不释放归属围栏。命令接口见[异步 Shell](async-shell.md)。

Runtime 先尝试投递子节点终态，再发最后子节点结束的唤醒信号。信号不创建执行轮次，模型不需要轮询或调用等待工具。显式消息仍可将停止节点唤醒为新轮次。

恢复分两部分：Actor 层读取原生文件、解析身份和历史区间；Runtime 校验完整拓扑与 Job 关系，再统一裁定未结束 Job 为 `job_interrupted`。适配层不预先改写终态或另算停止排序。恢复不会自动重跑或重发旧通知。

持久化 Actor 在结束后解除 manager 引用，下次按需打开。纯内存 Actor 保留唯一的原生对话，不能套用文件型 Actor 的释放规则。

## 消息与回执

### 宿主工具

```text
msg_write
  → 当前调用方的受管端点解析
  → Runtime.sendMessage
  → 检查单点交接或广播结果
  → 成功返回纯文本提示，或抛出工具错误
```

`write` 是 SDK 原生文件工具，完全保持原生行为，不被 harness 拦截或覆写；IPC 消息发送由专用工具 `msg_write` 承担。

Main 默认不激活 `msg_write`（`defaultActive: false`）。收到跨 session 消息时，宿主在触发模型轮次前自动激活 `msg_write`，让 Main 能直接回复；这只加载回复工具，不写能力记录，其余 `subagent` 工具仍由 Capability 选中命名空间后激活。所有子会话依据深度分配工具集，显式保持激活 `msg_write`。非叶子深度子节点拥有 `subagent_create`、`subagent_list`、`subagent_stop`、`capability` 与 `msg_write`；叶子深度子节点仅保留 `subagent_list` 与 `msg_write`。

`msg_write` 仅限 IPC 地址（Unix Socket / Windows Named Pipe），非 IPC 目标直接报错拒绝。宿主消息不再绕本进程 Socket 回环；Runtime 交接结果只在内部检查，不作为工具回执返回。消息成功返回纯文本（`Successfully sent message to ...`），`details: undefined`，不增加 ACK、`to` 或 `jobId`。拒收、超时或广播部分失败使工具抛错，不自动重发；失败不保证消息尚未送达。

广播只面向发送者的全部直接子节点。每个接收者沿用普通发送的准入和续跑规则。任一接收者失败，工具即报错并指出失败接收者，不返回成功的写入结果，也不重发已成功的接收者。

### 外部 Socket

```text
外部进程 → 自有端点 → NDJSON 结构检查 → Runtime.sendMessage
```

报文应显式提供非空 `from` 和字符串 `content`，不回退为 Main。广播端点还检查声明的发送者是否为该端点的父节点。本项目信任同用户本机进程，不另建认证协议。

每个 NDJSON 请求处理结束后，成功返回空行，失败只返回错误的 `code`（如有）和 `message`；外部 IPC 广播失败在响应中保留失败接收者列表及原因，普通 IPC 错误不向调用方泄漏内部任意状态细节。`writeSocket` 等待结果再返回；超时或断连表示结果未知，不自动重发。正常返回不表示模型已读或任务完成。

跨 session 消息走同一条接收路径，且只做 Main 之间的交互。发送侧由 `session-directory.ts` 解析目标 session 的 Socket 目录并写入一帧 `{from: "<session-uid>:Main", content}`；接收侧 `listeners.ts` 只在该根的 `Main` 端点接受此类帧，在 IPC 边界解析 `from` 的复合身份，用共享目录核对 uid 是否为存活 session，按该记录推导回复地址后交给 Runtime。Runtime 只接受宿主解析出的外部发送者描述，不自行读目录；外部发送者只能是 Main，接收者也只能是 Main。

发现由同一目录提供：`RootService.initialize` 在监听就绪后发布记录（含原生 session name），`retire` 按记录归属删除。跨 session 没有独立地址协议：目标就是对方 `Main` 的受管端点地址（Unix Socket 文件或 Windows Named Pipe），接收端在 IPC 边界解析 `<uid>:Main` 复合身份。地址是否属于某个 session 的端点命名空间由 `ipc/` 平台适配层判定（`belongsToNamespace`），`RootService.sessionEndpoint` 只保留 Main-to-Main 的业务准入；分类不构成端点归属或授权。

`subagent_list` 将筛选后的拓扑投影为 `children` 树，省去 `parentId` 和外层 `items`；窗口和展开规则见[接口契约](interface-contract.md#subagent-调用形态)。监听由当前根注册表决定，覆盖已停止但可续跑的 Actor，不复用 `subagent_list` 的每组四项显示窗口。大量累计 Actor 会增加监听资源占用；系统资源不足会报告错误，不把它解释成 Actor 不存在。

### 原生交接

运行中的输入交给原生 steer。SDK 尚未就绪或暂时空闲时，输入由该 Job 的 Runner 持有；缓冲不代表模型已经读取。事件交给 SDK 后，插件不因用户清队列而重放。

Main 压缩期间，Root 持有待投递队列，入队后应答，摘要生成不占用 Socket 应答窗口。闸门放行后顺序尝试 SDK 交接，退役等待生产者结束和队列排空；交接失败报告一次且不重放。丢失代次所有权后不再向 SDK 写入。

直接交接和向子会话的通知路径检查实际交接结果，不把同步 `accepted` 标志当作成功。只有明确尚未交出的拒收，才能追加到保留会话。任意 SDK 异常不能证明未入队；这类错误可见，但不会盲目重发。

普通消息和终态是独立原生事件。一次模型请求可消费多个原生事件，不要求每个事件单独请求一次模型。

## 退役、树切换与写入权限

根服务区分两个权限：是否接收新命令，以及是否仍拥有原根分支的写入权。开始退役后拒绝新命令，但在原上下文仍有效时，允许已存在 Job 完成终态落盘。

`session_before_tree`、`session_before_switch` 和 `session_before_fork` 在 SDK 移动上下文前等待退役。正常路径先停止 Job、写入终态、关闭监听，再允许切换。终态由 Runtime 发布一次；视图写入器不提前抢写终态。

持久化失败会锁存，阻止新工作，也阻止切换被报告为成功。钩子应显式返回 `{ cancel: true }`；SDK 会捕获扩展异常，仅抛错不能阻止切换。UI 报错失败也不能改变取消结果。

退役默认期限为 5 秒。期限只限制调用方等待，不证明原生资源退出。超时后保留资源围栏；只有实际清理完成，才允许新代次使用相同文件。清理失败且无法确认退出时，继续隔离，而非强制开放。

Shutdown 不能取消。退出或替换上下文后，代次失效使旧回调不能经 `pi.appendEntry` 写入新根。强制退出、退役超时或进程终止仍可能需要下次按中断恢复；不承诺跨文件事务或强制退出时的完整终态。

导航尝试会先停止子 Job。若后续插件取消导航，已经停止的 Job 不回滚或重跑；下次根模型运行可重新打开已停止的注册表。旧代次不能通过过渡期间的懒加载重新接收命令。

## 存储与历史视图

根分支用 v2 增量事件保存拓扑、身份补丁、Job 起点与终态；对话在原生子文件中。模块由 `src/subagent/storage.ts` 与 `src/subagent/view.ts` 实现。模型只记录 provider 和 model id，不记录运行时对象或凭据。

终态的模型结果与历史写入状态分开。历史视图失败不改写模型结果，但 `historyState` 与 `historyError` 进入同一份最终事件。视图不参与状态恢复。`result.ts` 沿用 SDK 截断规则，将本轮最终文本直接放入通知；`delivery.ts` 不在终态元数据中重复正文。Root 在终态发布前写入原始 `result.txt`；内存会话（非持久化模式）仅为超限结果写系统临时文件。临时文件由 `temporary-results.ts` 统一管理，在根服务退役或 `/reload` 时保持存活供父节点补读，在 Node.js 进程正常退出时清理。Runtime 通过只读路径端口读取已存在的文件，不负责文件写入。

Runtime 的列表投影没有历史文件写入。Root 列表层可重建缺失视图；每项分别捕获失败，单个损坏文件不阻断其余 Actor 状态。通知只投影路径，不在终态发布过程中重建视图。

Fork 读取记录中的绝对 `sessionFile`，首次写外部文件时复制到自有目录。原生条目 ID 与签名保留，父文件不被改写。Rewind 只改变当前可见分支，分配 ID 仍避开全部分支和已有文件。

v1 转换只存在于独立离线脚本。生产运行时不转换、不恢复旧快照。

## Capability

Capability 通过共享执行句柄创建内部 SDK 会话，不要求公开 Subagent 工具激活。公共会话与检索会话共用 ModelRuntime 桥和 Budget 截止计时，但保留不同业务规则：Subagent 交付任务结果，Capability 交付验证过的 refs。

Capability 与 Subagent 共用 `provider-session.ts` 的能力判断。Responses、Anthropic 与 Chat Completions 的工具和消息编码使用 Pi 原生 provider；Chat Completions 只有在两个明确的 compat 位开启时采用新增工具协议，同名 schema 替换仍可能重建前缀。详情见[Provider 传输行为](provider-transports.md)。Capability 沿用捕获的 thinking level。检索会话保留非 manual 的继承声明，由 tool-call hook 和无父执行句柄的占位工具阻止执行；同时按 `capability.lazySchemas` 将命中组的声明一并排除，避免内部检索重发大型 schema。生效 Codemode 模式由 `capability/codemode-mode.ts` 读取分支上的预设覆盖（回退到 Pi 设置），只改变声明投影，不改变启用集合或授权。Main 与普通 Subagent 在成功压缩后淘汰本窗口未使用的发现成员，重建工具 checkpoint，并在 system 头部固定本次淘汰通知；内部检索与 `/btw` 不独立执行淘汰。

Inherited 与检索会话保留独立本地 Session ID，Responses 请求仅替换原生默认 `prompt_cache_key` 为继承标识；既有自定义 key 与最终 payload hook 优先。`harness-cache-identity` 原生 custom 条目保存分支缓存标识，支持嵌套继承、恢复和续跑。Fresh 默认沿用自己的标识。观察器仅将有效非空字符串 key 写入 lineage；请求暂时使用 `cacheRetention: none` 或最终 payload 缺少 key 不改变继承身份。仅显式记录或安装 `key: null` 才持续禁用，最终 payload hook 仍可覆盖当前请求。Main 通过共享 ModelRuntime 桥观察本会话所有 provider payload hooks 完成后的最终 key，并写入当前分支；会话导航、关闭与已中止请求的围栏阻止晚到写入。观察范围限定于所属会话，摘要和其他会话不计入 Main 请求。

工具指引统一使用增量系统更新。原生工具的 `promptGuidelines` 由 SDK 比较已有状态并追加更新；所有已声明 namespace 的共同 instructions，包括 MCP 与用户直接启用的 namespace，由当前目录提供，首次投递与后续变更追加到当前尾部。静态资产可随首次工具声明初始化，之后不再覆盖历史正文。`prompt-section-journal.ts` 保存已投递的正文、落点与上下文边界：工具指引使用 `harness-tool-guidance`，Capability 记忆使用 `harness-capability-memory`，共用重放逻辑。新发现、嵌套发现与正文变更只追加新版本；清空指引追加原生段落撤销更新。压缩或显式上下文编辑形成新边界时恢复最新状态。Capability 仅在对应 namespace 指引确已投递时省略重复 prose，未投递时保留；判断使用来源身份。Main、内部检索与 `/btw` 继承会话沿分支重放，更新不授予执行权限。

内部引擎为 `src/capability/agent.ts`，外层装配为 `src/capability/extension.ts`，公开注册入口为 `extensions/capability.ts`。唯一内部工具 `capability_step` 先增量接受已见 refs，再并行调用现有 Broker 搜索。内部选择先留在本次 Run，外层结束后统一保存、激活和投影。没有新增选择的 step 累计计数，上限默认为 3 加一次首轮额度，可配置 `capability.noSelectionLimit`；显式 finish 或达到上限后不再发模型请求。异常结束仍可交付此前已选成果，状态为 `partial`。具体语义和 Budget 见[内部批量检索](interface-contract.md#内部批量检索与增量提交)。

本地来源由宿主固定，不再提供内部 `src` 参数。远端审批未实现前不搜索远端、不安装候选、不把远端未搜索解释成不存在资源。

搜索只读取当前已注册且符合权限的工具，不等待全部 MCP 后端，也不为发现主动重连。尚未注册的服务器本次不会成为候选；原生连接完成后可再次搜索。交付前重新核对注册与资格，移除已消失、隐藏或被角色禁止的成员，重算分组数量，再持久化并激活。

`capability_step` 的模型正文与完整诊断分开：首次命中只返回 ref、名称、短描述、类型及必要的路径或工具数量；同次发现的重复命中只返回 `repeatedRefs`。完整成员、接口和共同指引保留在宿主，选择整个 namespace 的语义不变。去重不跨发现调用，不把重复命中解释成空搜索。

本地检索由 `src/capability/broker.ts` 实现，复用 `minisearch@7.2.0`。排序默认使用标准 BM25（`k=0.9`、`b=0.9`、`d=0`），可通过 `capability.search.bm25` 直接配置库参数；默认降低重复词的得分增益并加强字段长度归一化，不自行实现评分公式。切词和小写处理使用库默认行为；不附加 CJK 分词、停用词、前缀匹配或模糊兜底。连续中文不做语言分词，不保证中文子片段、同义词或跨语言召回。

精确工具、命名空间、MCP 引用和 Skill 入口路径独立查找，不参与 BM25 排序。工具按成员建索引，按完整命名空间或 MCP 组返回，组分数取成员最高分；候选上限按组计数。Skill 先按名称和描述召回，默认最多打开 6 个候选文件，将每篇正文的前 60,000 字符加入索引后用同一检索库重排；候选与正文上限由 `capability.search.limits` 配置，详见[Harness 参数配置](harness-configuration.md#capability)。不扫描整个 Skill 目录的正文。字符截断限制索引文本，不是文件读取的字节上限。

Harness 用 `result-rendering.ts` 为没有专用结果渲染器的工具提供统一折叠，包括 Capability、Subagent 控制工具和动态 MCP 工具；已有专用渲染器保持不变。折叠按 10 个终端视觉行计数，不让单行长 JSON 绕过限制；通过原生展开键查看全部已交付内容。全屏模式下，工具结果复用 SDK 的左键切换，Subagent 的 `agent-delivery` 通知通过 `MouseRegion` 支持同样的展开／收起。通知按消息保存显示状态，重绘不重置，展开键切换时以全局状态为准；滚轮和拖动继续交给原生界面。标题保留发送者、状态和轮次。GUI 只展示模型可见的 `content`，不展示完整 `details`；渲染不改写模型输入或历史记录。接口已由原生声明或当前启用的 Codemode 查询入口提供时，模型正文只返回资源引用、名称、数量和接口入口，不重复整组参数；两种入口都不存在时保留调用所需接口。是否已声明依据原生 Codemode `prepareLoadout` 返回的逐工具隐藏列表判断，不按全局 `codemode.mode` 推断。再次选中已激活工具时，正文省略重复接口。部分交付通过有界的 `partialReason` 说明原因，完整诊断保留在 details 中。

Codemode 的 `ALL_TOOLS` 只包含名称和短描述。`describeTool` 按需返回完整参数和指导，`describeNamespace` 返回 namespace 元数据与成员名。目录查询不等待 MCP 就绪；实际嵌套调用继续经过原生 `tool_call` 管线，由原生后端等待对应服务器。沙箱在执行开始时固定工具集合，期间新启用的工具从下一次 Codemode 调用使用。

宿主不从 Skill 文本猜测禁止事项、前置条件、静默失败、绑定关系或执行优先级，也不按未命中词项推断能力缺口。Skill 返回元数据和绝对入口路径，由 Agent 使用原生 `read` 阅读并理解正文。`src/capability/result.ts` 移除模型可见结果中的排序诊断；`src/capability/prompt.ts` 投影分支发现记忆。

`src/capability/command.ts` 解析 `/capability` 的目录浏览与启用参数；`src/capability/enable.ts` 把启用目标在**执行时**对照当前注册表解析（精确工具名、`mcp://<server>`、`namespace://<name>`），先调用共享的 `activation.ts` 激活，再把实际激活的成员以 `manual` 分类写入同一 `capability-discovery` 记录。先激活后记录使记录不会包含被激活阶段静默遮掉的成员；记录写入失败不回滚激活，命令单独报告该失败，缺少记录时 manual 工具在下一次请求被声明剪枝移除。实时解析让 Pi 原生 `/mcp` 重连后注册的工具无需重启或模型发现即可启用。

`capability.manualTools` 的门禁收在 `scope.ts`：根作用域保存名单谓词，任何带父节点的视图在计算 `effective` 与 `allows` 时都排除名单内名字，因此子会话既看不到也不能继承。`tool-catalog.ts` 默认排除名单内工具，只有目录浏览与执行守卫传 `includeManual`；`activation.ts` 对发现路径返回 `manual_only`。

授权判定集中在 `admission.ts` 的单次操作视图：它一次解析作用域链、分支记录（一次扫描同时得到「已选择」与「用户已启用」两个集合）与当前激活集，再提供逐名字谓词。`declares` 用于声明准入（禁用原生工具、MCP 选择、manual 授权，不含作用域），`admits` 在声明规则上叠加作用域，供 Codemode 准入使用，`admitsServer` 判定资源读取。manual 工具必须处于根作用域且当前分支存在 `manual` 记录。

声明裁剪只有一处：`native-discovery.ts` 的 `before_agent_start` 用 `declares` 过滤激活集与 `selectedTools`，同时覆盖 `defaultActive`、历史恢复和其他扩展的激活；`src/capability/extension.ts` 的同一钩子只处理 Skill 段。执行仍分别检查：原生 MCP 的 `tool_call` 用 `declares` 加激活状态，能力侧 `tool_call` 用目录/激活状态加 `admitsManual`。作用域拒绝只关闭执行，不改写分支选择或历史声明。请求投影用 `includeManual` 的目录解析执行视图，Main 可见、子会话仍被作用域排除。

工具资格按设计只增不减，角色排除仍优先。每次同步目录投影只解析一次资格视图；不把快照跨请求或工具调用缓存。资格、注册和激活是三件不同的事。

发现记录按当前分支保存，不重复存储参数 schema；请求投影依据当前声明提供接口。严格工具 allowlist 可能拒绝不匹配的 MCP 成员。当前先写记录、再激活的顺序会让未激活成员残留在规范记忆中，后续投影可能再次展示它们。这是与成功获得能力才应累积的要求不一致的已知缺陷，详见[已知问题](known-issues.md#严格工具-allowlist-下的激活记忆不一致)。

## Shell 执行前检查

可选入口 `extensions/shell-preflight.ts` 装配 `src/shell-approval/extension.ts`。语法检查与权限审批使用独立配置，共用实际 Shell、命令前缀和工作目录。Pi 原生工具继续负责执行、输出和取消。

权限协调器由根会话持有，包含模式、代次取消信号和人工审批队列。子会话不重复加载该入口，通过原生事件总线取得所属根的检查函数；来源身份由宿主传入。等待人工审批通过子会话总线通知 Job 暂停活跃时间计费，总存活期限继续累计。

静态策略 command 从 stdin 接收 JSON，只返回允许、拒绝或待审批。配置只接受 `shell.approval.ruleFiles` 文件路径列表，相对路径以声明它的配置文件所在目录为基准。根会话首次需要规则时读取文件正文并缓存；`/reload` 或新配置快照重新加载。文件加载失败直接阻止执行，不转交模型或人工绕过。WASM 继续接收正文，不访问规则文件。

策略进程启动时清除 Harness 回调环境变量；进程失败、超时或无效输出转待审批。可选自动审查仅导入上游插件的公开 `/review` 模块，通过父 ModelRuntime 调用指定模型；不加载完整权限插件。

人工队列只展示一项，使用 Pi 的权限阻塞状态、可见通知与终端提示音。倒计时从展示开始，超时或取消均拒绝；下一项在原生界面关闭后展示。页脚独立显示权限模式，不替代审批组件。公开配置与边界见 [Shell 权限审批](shell-permissions.md)。

## 代码与未迁移边界

`src/` 与 `extensions/` 生产代码为严格 TypeScript（`storage.ts`、`view.ts`、`routing.ts`、`job-budget.ts`、`pi-job-budget.ts` 位于 `src/subagent/`，`inherited-context.ts` 负责原生继承捕获，`prompt-text.ts` 提供缓存 getter，`skills.ts` 位于 `src/capability/`，`shell-preflight.ts` 位于 `src/` 与 `extensions/`）；`scripts/` 与历史测试用例（`test/*.test.mjs`）保持 MJS。

提示词正文存放在 `prompts/`；代码保留参数结构、动态装配、权限和生命周期判断。运行时只读取原命名的 `subagent-tools.json` 与 `subagent-turns.json`。共同 namespace 指引随工具提供，`create.guideline` 仅挂到 create；所有子会话注入 turns 的 `context`，Fresh 添加路由角色，Fresh 和 Inherited 均添加非空的 common，Inherited 另添加解析后的非空 inherited；后两段可在 `harness.json` 中逐层替换或追加。`native-runner.ts` 按已保留的路由身份识别模式，续跑不因当前 Job 是 continuation 而丢失 Inherited 定位。`prompt.ts` 负责原样拼装，参数说明按工具及数组项嵌套读取。字段与状态见[提示词装配](interface-contract.md#subagent-提示词装配)。正文在模块初始化时读取，修改后应重启 Pi，`/reload` 不保证刷新全部 ESM 依赖。

未交付的功能与待验收边界见[已知问题](known-issues.md)。
