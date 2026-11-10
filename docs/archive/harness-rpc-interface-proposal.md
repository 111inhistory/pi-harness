# Harness RPC 独立接口提案

## 状态与目标

状态：首批接口已落地，提案归档。本文保留实现前的设计与当时待定项；「下一组接口」未交付且处于功能冻结，不构成后续实施授权。当前行为见[接口契约](../interface-contract.md)和[线协议](../harness-rpc-wire-spec.md)；已发现缺陷与当前改写要求见[审计及改写计划](../reviews/rpc-permission-audit.md)。归档不表示所有验收项通过。

客户端继续通过 Pi 原生 RPC 控制和读取 Main 会话。Harness 为原生 RPC 未覆盖的工具信息、子 Agent 控制、消息历史和执行流提供独立结构化接口。客户端不应执行 Slash 命令后解析面向人的文本。

新增端点复用现有受管 IPC 的创建、归属校验与清理机制，使用独立地址和协议。现有 `Main`、Agent、广播和异步 Shell 消息端点保留各自职责。

## 当前实现与核查依据

核查对象为本项目代码和安装的 Pi 1.5.0。以下结论来自静态实现审阅；此前的 RPC 子进程冒烟仅验证扩展加载、部分命令与 UI 子协议，不证明本提案中的独立接口已可用。

| 当前事实 | 依据 |
| --- | --- |
| Pi 原生 RPC 提供 Main 控制、状态查询和执行流 | Pi `docs/rpc.md`、`docs/rpc-commands.md`、`dist/modes/rpc/rpc-mode.js` |
| Pi RPC 只订阅当前 Main 会话，未按子 Agent 或 Job 路由事件 | `rpc-mode.js` 中当前会话的订阅 |
| Pi 1.5.0 没有公开的扩展 RPC 请求／事件注册接口；未知请求由固定分发逻辑拒绝 | Pi `dist/core/extensions/types.d.ts`、`rpc-mode.js` |
| RPC 模式将扩展普通 stdout 写入转向 stderr | Pi `dist/core/output-guard.js` |
| 现有消息端点处理消息投递和专用异步 Shell 帧，不支持通用查询和订阅 | [listeners.ts](../../src/subagent/listeners.ts)、[socket.ts](../../src/ipc/socket.ts) |
| 子会话已有原生事件订阅，但没有外部执行流接口 | [native-runner.ts](../../src/subagent/native-runner.ts)、[native-types.ts](../../src/subagent/native-types.ts) |
| 已有历史区间读取；展示文件不是完整原生消息协议 | [actor-sessions.ts](../../src/subagent/actor-sessions.ts)、[view.ts](../../src/subagent/view.ts) |

Pi 依赖中的路径相对于 `@earendil-works/pi-coding-agent` 包。升级 Pi 后应重新核对扩展入口与事件格式，不将 1.5.0 的限制视为永久限制。

## 双通道边界

```text
客户端
  ├─ Pi 原生 RPC：stdin / stdout
  │    └─ Main 输入、执行流、模型设置、会话操作与原生查询
  └─ Harness 独立接口：Unix Socket / Windows Named Pipe
       └─ 工具目录、子 Agent 控制、执行记录与子会话事件
```

Pi 已提供的接口继续走原生 RPC。Harness 不复制 Main 的 prompt、steer、follow-up、abort、队列管理、模型与 thinking 设置、压缩、重试、新建／切换／fork／clone 会话及原生消息查询。

`get_commands` 是 Slash 命令、Skill 和模板目录，不是工具目录。`get_tree` 是 Main 的 entry 树，不是 Subagent 树。Main 的原生消息查询和事件流不覆盖独立子会话。

两个通道不承诺跨通道的全局消息顺序。Harness 响应与事件应携带会话及执行归属；客户端不能仅按两个通道的接收先后推断操作因果。

## 启用条件与资源生命周期

新增 Harness 接口端点仅在根宿主的实际运行模式为 `rpc` 时开启。判断应使用 Pi 提供的运行模式，不扫描命令行字符串，也不通过 `hasUI` 推断。

- TUI、print 和 JSON 模式不创建、不监听、不发布新增端点。
- 此条件仅限制本提案新增的接口端点，不关闭其他模式已有的消息投递与异步 Shell 端点。
- 一个 RPC 根宿主提供一个 Harness 接口端点。客户端通过 Agent 与 Job 标识访问子任务，不为每个子 Agent 新建监控端点。
- 内部 SDK 子会话不因父进程处于 RPC 模式而再次开启接口端点。根宿主身份与运行模式应共同决定装配范围。
- 客户端取消订阅或断开连接只解除观察，不取消子任务、不关闭 Pi，也不改变任务的模型输入。
- 根会话切换、fork、reload 或退役期间，接口应拒绝访问旧服务；旧订阅终止，不能自动改指向新根。新根就绪后由客户端明确查询或订阅。
- Pi 关闭时停止接收新请求，解除订阅并清理新增端点。资源清理沿用现有归属检查；退役超时不表示底层资源已经退出。

新增端点不应与现有 `Main.sock`、Agent、广播端点共用地址，不应把查询或订阅编码为消息 `content`。底层复用 [createOwnedServer](../../src/ipc/endpoint.ts) 及平台适配，继续遵守 Unix Socket 的 UID、`dev`／`ino` 核对及 Windows Named Pipe 的归属要求。

接口端点创建失败应向接入方明确报告，不能宣称已提供 Harness 接口。是否阻止整个 RPC 宿主启动，应在实现前确定。

## 消息职责

| 类别 | 语义 | 要求 |
| --- | --- | --- |
| 控制请求与响应 | 改变状态或投递业务输入 | 关联请求标识，返回结构化结果和错误，保留部分成功 |
| 信息查询与响应 | 读取当前作用域数据 | 不触发模型、授权、连接介绍或配置应用 |
| 订阅请求与响应 | 建立或解除指定 Job 的观察 | 返回订阅标识及明确的读取边界 |
| 订阅事件 | 持续提供子会话原生执行事件和结束信息 | 携带订阅、根会话、Agent 与 Job 归属 |

接口应直接调用领域 API。Slash 命令可以调用同一份领域操作并渲染文本；程序接口不应复用 Slash handler 或解析 `notify`、状态栏、Markdown、日志。

控制响应、查询结果和观察事件不应写入 Main 的对话、分支条目或 TUI。控制操作本身的业务输入与原有副作用仍需保留：向子 Agent 发任务是其输入；介绍其他会话给 Main 会增加联系人上下文。这些操作不等于无副作用查询。

## 首批接口范围

以下是能力清单，不固定协议方法名、字段命名或完整 schema。

### 工具信息

| 查询／控制 | 最小数据与语义 | 可复用代码 |
| --- | --- | --- |
| 工具目录 | 名称、描述、分类、namespace／server、资格、激活及三态管理状态 | [catalog.ts](../../src/capability/catalog.ts)、[tool-catalog.ts](../../src/capability/tool-catalog.ts)、[admission.ts](../../src/capability/admission.ts) |
| 工具详情 | 参数 schema、描述、exposure、namespace；仅在来源支持时提供返回 schema | 原生 `ToolInfo` 及工具 catalog |
| 用户启用工具或分组 | 支持工具、MCP 分组及 namespace；返回启用、已启用、跳过、未解析目标和记录失败 | [enable.ts](../../src/capability/enable.ts) |
| 工具管理查询、显式启用、显式禁用及解除管理 | 将统一三态领域操作的结果适配为 RPC 响应 | 依赖[工具权限管理提案](tool-permission-management-proposal.md)中的共享领域 API |

工具状态应分别表达：

- `registered`：宿主已注册，不保证当前作用域允许使用。
- `eligible`：当前作用域允许进入候选目录。
- `active`：当前激活集成员。
- 管理状态：`not managed`、显式启用、显式禁用；共用一份权威管理数据。

普通目录默认列出 eligible 工具。registered 全量目录不默认暴露。active 不代表显式启用，也不保证工具在 Codemode／lazy schema 模式下作为独立声明出现。

模型发现继续走现有 Capability 路径，不自动改变用户管理状态。统一管理规则、操作和跨入口生效要求见[工具权限管理提案](tool-permission-management-proposal.md)。本提案只负责 RPC 适配，不另建 manual 与 blacklist 两套接口和数据；领域能力可独立在 TUI 使用，不受 RPC 端点启用条件限制。

### 子 Agent 与执行轮次

| 查询／控制 | 最小数据与语义 | 可复用代码 |
| --- | --- | --- |
| Agent 列表／树 | Agent 标识、父节点、名称、深度、Fresh／Inherited 类型及状态 | [runtime.ts](../../src/subagent/runtime.ts)、[root-service.ts](../../src/subagent/root-service.ts) |
| Job 列表／详情 | Job、Agent、状态、前序执行关系、错误及预算 | Runtime 的 jobs 查询 |
| 单次结果 | 状态、结果、错误、轮次、预算和历史可用性 | Runtime 的 jobRecord 查询 |
| 创建子任务 | 批次输入、本地就绪结果、已登记项和失败项 | RootService.create 及现有上下文捕获 |
| 停止指定／全部子任务 | 逐项取消结果，区分请求取消与最终退出 | RootService.stop、Runtime.cancelJob |
| 投递指令／续跑／广播 | 投递回执及逐接收者结果 | 现有消息准入、续跑和广播领域操作 |

程序查询不沿用 TUI 的每组显示窗口。结果尚未可用、Job 不存在和读取失败应分别表达，不能都返回空结果。

创建入口由宿主绑定父身份、根会话、工作目录、继承快照和深度／容量限制。客户端不提供可信身份或原始 inherited entries。注册后的本地准备失败可能保留 Agent，应结构化返回已登记项，不能暗示整批无副作用。

续跑复用现有消息投递路径，不新增无输入 resume 状态机。取消成功不代表底层会话已退出。投递接管不代表模型已读或回复。异常、超时与断连不证明输入尚未入队，客户端不能自动重放结果未知的控制输入。

所有操作通过当前根服务解析器进入，不缓存退役前的 RootService 绕过代次和准入围栏。

### 消息历史与执行流

提供读取指定 Job 历史、订阅后续事件和取消订阅三个接口。历史与实时流应明确衔接边界，覆盖订阅时正在生成的消息；需要时由订阅建立过程提供当前执行快照，不要求客户端读取文件后猜测增量起点。

| 内容 | 原生事件或数据 |
| --- | --- |
| 推理块 | `thinking_start`、`thinking_delta`、`thinking_end` |
| 输出块 | `text_start`、`text_delta`、`text_end` |
| 工具调用参数生成 | `toolcall_start`、`toolcall_delta`、`toolcall_end` |
| 工具实际执行、进度与结果 | `tool_execution_start`、`tool_execution_update`、`tool_execution_end` |
| 完整消息 | `message_start`、`message_end`，保留内容、usage 和 stopReason |
| 会话边界、压缩和重试 | 原生 AgentSessionEvent；另行明确 Harness Job 终态 |

实时数据源是子会话自己的 `AgentSession.subscribe()`。实现应保留完整原生事件类型，沿用 Pi RPC 的 JSON 投影语义，避免每次 delta 重复发送累计 `partial`。工具调用保留 `toolCallId` 和存在时的 `parentToolCallId`。

推理仅提供供应商实际返回的内容。工具调用生成与工具实际执行分别表达，不能只保留其中一类。

`agent_end`、`agent_settled` 与 Harness Job 最终结束不是同一边界。Job 可能继续消费停放输入或等待子任务，最终状态以现有 Runtime 判定为准。

历史应读取 Job 的原生 entry 区间及原生消息，不解析 `views/` 展示文件。memory-only 会话需接入现有内存 manager 的只读路径，或明确报告历史不可用；不能把当前文件型区间读取直接宣称为全部历史支持。

原生存储保存完成消息，不保存每个 token delta 和工具中间进度。本提案不新增完整 delta 持久化。订阅者异常或断连不应影响任务执行；慢客户端的积压上限和断开策略需在协议实现前明确，不能让观察阻塞模型执行，也不能静默丢弃后假装事件完整。

## 下一组接口

| 能力 | 边界 |
| --- | --- |
| 当前有效 Capability | 结合分支发现、三态管理、淘汰和当前资格，不直接返回历史记录冒充有效状态 |
| Preset 目录、当前管理状态、应用与清除 | 区分应用快照和实际模型／工具状态；清除管理不回滚模型与工具 |
| Shell 权限查询与模式设置 | 读取实际生效模式，设置仅作用于后续请求，不解析状态栏文本 |
| Shell 人工审批请求与回答 | 独立请求生命周期及批准／拒绝响应，不以切换 YOLO 代替逐次审批 |
| 活跃会话目录、介绍与跨 Main 消息 | 纯目录查询与授权／追加联系人上下文分开；不允许伪造发送者 |
| 前端所需限制 | 读取当前有效配置中的深度、并发及预算，不暴露全量配置原文 |

本提案不增加 `/btw` 的程序化产品接口，不建设外部进程调度服务，不默认暴露内部提示词投影、BM25 参数、epoch、存储布局、Shell token 或 notification URL。

## 实现前待定项

以下细节尚未确定，不作为已实现或已确认的协议：

1. 新增端点的地址命名、发布和机器可读发现方式。发现不依赖 Slash 命令，不向 Pi 原生 stdout 注入未定义记录；非 RPC 模式不发布此接口。
2. 协议版本、请求／响应／事件 schema、错误码，以及客户端如何关联同一个 Pi 宿主与当前根会话。
3. 根切换或 reload 时端点地址是否保持不变，以及客户端怎样确认新根就绪；旧根请求和订阅必须有明确结束结果。
4. 历史与 live 快照的衔接、订阅事件顺序、取消订阅边界和慢客户端策略。
5. 端点装配模块、所需扩展未加载时的结构化不可用结果，以及启动失败策略。

## 验收要求

后续实现应使用真实 Pi RPC 子进程或真实 SDK 会话与离线模型验证，不用 Slash handler 夹具替代协议链路。

- 模式矩阵：RPC 根宿主创建唯一新增端点；TUI、print、JSON 及内部 SDK 子会话均不创建、不发布该端点。现有业务消息端点不受此门禁影响。
- 双通道：原生 Pi RPC 仍可使用，Harness 查询和控制均返回结构化结果，无需解析 UI 通知。
- 工具信息：目录、详情和启用遵守当前作用域与三态管理，active 不冒充显式启用。
- 权限管理适配：RPC 调用统一领域 API，保留逐项结果及生效范围，不另定义规则；跨入口行为按[工具权限管理提案](tool-permission-management-proposal.md)验收。
- 任务控制：覆盖部分创建、取消后仍在退出、续跑及结果未知的投递；不自动重发。
- 子会话执行流：覆盖文本、可见推理、工具参数生成、工具执行和嵌套调用关联；事件归属正确，Main 历史不增加监控消息，TUI 不收到监控渲染。
- 历史与 live：覆盖持久化和内存会话、流式中途订阅、完成后读取、取消订阅及断连，不要求回放未保存的中间 delta。
- 生命周期：覆盖会话切换、reload、关闭、旧代次回调、客户端慢读和端点清理，观察失败不改变任务结果。
- 平台：分别验证 Unix Socket 和 Windows Named Pipe；未具备环境时明确标记未测。

当前只完成代码与协议盘点。以上验收项均是后续实现要求，不是本次测试结论。实施后应将生效行为同步到[接口契约](../interface-contract.md)和[当前架构](../architecture.md)。
