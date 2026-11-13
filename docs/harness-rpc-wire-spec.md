# Harness RPC 线协议规范

本文件是 Harness 独立 RPC 端点的语言无关协议规范，面向其他语言的解析器实现者。协议版本为 1。规范性产物是本文、生成的 `schemas/harness-rpc.schema.json`、生成的 `schemas/harness-rpc.manifest.json` 与 [`schemas/fixtures/harness-rpc/`](../schemas/fixtures/harness-rpc/)；Git 追踪定义源码、夹具和 [`schemas/SHA256SUMS`](../schemas/SHA256SUMS)，两个 JSON 由本地命令或 GitHub Actions 生成并核对 SHA-256，分发入口见 [Harness RPC Schema](harness-rpc-schema.md)。TypeScript 的 `src/harness-rpc/schema.ts` 只用于生成 schema 与仓库 CI，不是其他语言的运行时依赖。

本文只描述已实现行为，不新增方法、字段、状态或兼容回退。JSON Schema 的 `$defs` 细节见 [Harness RPC Schema](harness-rpc-schema.md)。

## 1. 范围与非目标

端点与 Pi 原生 RPC 并行：原生 RPC 继续负责 Main 的输入、执行流、模型与会话操作；本端点负责工具目录与权限、子 Agent 控制、Job 历史与子会话执行流。

非目标：

- 不复制 Main 的 prompt、steer、abort、队列、模型设置、压缩、会话切换。
- 不提供协议层认证、压缩、TLS、请求取消、批量请求、断点续传或结果重放。
- 不定义完整的上游 Pi 事件模型；原生事件保持 Pi 的 `AgentSessionEvent` 语义。
- 不绑定实现语言，也不提供 Python／Rust／Go SDK 或代码生成框架。

## 2. 传输

### 2.1 端点与发现

- 仅在根宿主运行模式为 `rpc` 时创建；TUI、print、JSON 模式与内部 SDK 子会话不创建。
- 一个根宿主一个端点。地址为 `<socketRoot>/<session-uid>/harness-rpc.sock`（Unix）或同目录派生的 Named Pipe（Windows）。
- 同目录的 `harness-rpc.json` 是发现记录：

```json
{
  "protocolVersion": 1,
  "address": "/tmp/pi-harness/session-demo/harness-rpc.sock",
  "sessionId": "session-demo",
  "pid": 4242,
  "startedAt": "2026-01-01T00:00:00.000Z"
}
```

客户端先读取发现记录，再连接 `address`。记录在会话关闭时删除；连接失败可能表示端点已退役。

### 2.2 字节流与 UTF-8

- 连接是字节流，帧编码为 UTF-8。发送方不得写 BOM。
- 接收方必须使用流式 UTF-8 解码器，不能假设一次 `read` 得到一个完整字符或一个完整帧；多字节字符可能跨读取边界。
- 非法 UTF-8 的行为取决于解码器；实现可能替换为 U+FFFD，随后 JSON 解析可能失败。协议不承诺对非法 UTF-8 做修复。
- 服务器输出为紧凑 JSON 加 `\n`；客户端必须接受任意合法 JSON 空白，不依赖紧凑格式。

### 2.3 分帧

- 帧是换行分隔的 JSON（NDJSON）：一个 JSON 对象后跟 `\n`。
- 空行忽略；`\r\n` 可接受，实现会去掉行尾 `\r`。
- 只有读到 `\n` 才处理该行；连接结束时未以 `\n` 结尾的残留字节不构成帧。
- 没有长度前缀、没有帧头、没有压缩。数组、字符串、数字等非对象 JSON 不是合法请求帧。
- 实现没有输入行长度上限；不要把“无上限”当作可依赖的容量承诺。服务器对未发送积压默认上限为 4 MiB，超限会断开连接并释放订阅；客户端必须处理 EOF。

### 2.4 顺序与并发

- 每个连接内的请求按到达顺序串行处理，响应按请求顺序写出。
- 订阅事件在请求处理之外推送，可能与响应交错；同一连接的事件与响应不保证全局因果顺序。
- 本端点与 Pi 原生 RPC 是两个通道，不承诺跨通道的全局消息顺序。客户端不能仅按接收先后推断操作因果。
- 每个端点最多只持有一个客户端连接。多余的连接在未分派请求前即被关闭；当前连接不会被顶替。
- 槽位在 socket 实际关闭时释放。FIN 会停止推送事件，但在仍有未决处理或待写出响应时继续保留所有权。端点退役时会强制关闭所持连接。客户端可在关闭后建立替换连接；既有订阅不会转移或重放。

## 3. 信封与判别

客户端到服务器只有一个信封：

```json
{ "id": "req-1", "method": "harness.info", "params": { } }
```

- `id`：字符串或数字，客户端选择；服务器原样回显。
- `method`：非空字符串。
- `params`：可选；缺失或 `null` 都按空对象处理。具体方法仍会校验必填字段。
- 未知字段被 transport 忽略；客户端不应依赖服务器拒绝额外字段。

服务器到客户端有两种信封：

```json
{ "id": "req-1", "ok": true, "result": { } }
```

```json
{ "id": null, "ok": false, "error": { "code": "invalid_request", "message": "Frame is not valid JSON." } }
```

```json
{ "event": { "subscription": "sub-1", "seq": 1, "payload": { } } }
```

判别规则：

| 方向 | 判别 | 说明 |
| --- | --- | --- |
| 客户端 → 服务器 | 有 `method` | 请求；`id` 与 `method` 必需 |
| 服务器 → 客户端 | 有布尔 `ok` | 响应；`ok:true` 带 `result`，`ok:false` 带 `error` |
| 服务器 → 客户端 | 有对象 `event` | 订阅事件；没有 `id` |

响应与事件不会同时出现；服务器不会发送同时带 `ok` 与 `event` 的帧。客户端应拒绝既无 `method` 也无 `ok`／`event` 的对象、数组和原始值。`id:null` 只出现在响应中，表示请求无法解析或缺少合法 `id`；请求的 `id` 不能为 `null`。

## 4. 请求关联与生命周期

- 客户端维护 `id → 待处理请求` 映射。响应按请求顺序到达，但客户端应按 `id` 关联，不按位置。
- `id` 用字符串最稳妥。JSON 数字是 IEEE-754 双精度：超过 2^53 的整数、`-0` 等值在解析/回显时可能不精确；需要精确关联时使用字符串。
- 请求缺少合法 `id` 或 `method`：返回 `invalid_request`；`id` 无法确定时为 `null`。`id` 合法但 `method` 未知：返回 `method_not_found` 并回显 `id`。
- 结构有效性分两层：`RpcRequest` 只要求 `id`／`method`／可选 `params`；未知 `method` 是结构有效的通用请求，dispatch 返回 `method_not_found`。`MethodRequest` 是严格 schema，只接受 18 个已实现方法；未知方法在严格校验中失败。不要把“严格 schema 不匹配”误报为“帧结构非法”。
- 方法处理器通常要求 `params` 为对象；数组、字符串等返回 `invalid_request`。`harness.info` 与 `agents.tree` 忽略 `params`，schema 仍按对象／缺失／`null` 约束。`params` 为 `null` 等价于缺失。
- 协议没有请求取消、超时或重试。客户端断开只解除观察，不取消子任务、不关闭 Pi。
- 控制输入的结果未知时（异常、超时、断连），不得自动重发；断连不证明输入未入队。
- 同一连接可以并发发出多个请求，但服务器串行处理；客户端不要依赖交错执行。

## 5. 方法映射

方法名、参数 `$defs`、结果 `$defs` 与 `paramsRequired` 由生成的 `schemas/harness-rpc.manifest.json` 的 `methods` 给出；JSON Schema 的 `x-methods` 是同一份映射。响应不带方法名，客户端按请求 `method` 选择结果 schema。

| 方法 | `params` 必需 | 结果 | 语义 |
| --- | --- | --- | --- |
| `harness.info` | 否 | `HarnessInfoResult` | 协议版本、根会话、进程 |
| `tools.catalog` | 否 | `ToolCatalogResult` | 当前作用域候选工具；默认排除 `disabled` |
| `tools.detail` | 是 | `ToolDetail` | 单个已注册工具；可显示 `disabled` |
| `tools.enable` | 是 | `EnableResult` | 用户启用工具或分组；与 `/capability enable` 共用领域操作 |
| `tools.permission.query` | 否 | `ToolPermissionQueryResult` | 派生四态视图与管理条目；无来源/命中规则 |
| `tools.permission.enable` | 是 | `ToolPermissionSetResult` | 显式启用 |
| `tools.permission.disable` | 是 | `ToolPermissionSetResult` | 显式禁用 |
| `tools.permission.reset` | 是 | `ToolPermissionResetResult` | 解除显式规则 |
| `agents.tree` | 否 | `AgentsTreeResult` | 根 Agent 树；可为 `null` |
| `jobs.list` | 否 | `JobsListResult` | Job 列表；可按 `jobIds` 过滤 |
| `jobs.get` | 是 | `JobGetResult` | Job 视图与可空终态记录 |
| `jobs.result` | 是 | `JobRecordView` | 已结算结果；未结算与不存在分别报错 |
| `subagent.create` | 是 | `CreatedAgents` | 创建子任务；宿主绑定身份、cwd、会话与容量 |
| `subagent.stop` | 是 | `StopResult` | 请求取消；区分请求与最终退出 |
| `message.send` | 是 | `MessageSendResult` | 按受管 IPC 地址投递、续跑或广播 |
| `history.read` | 是 | `HistoryReadResult` | 原生历史区间；running Job 返回已产生区间 |
| `stream.subscribe` | 是 | `StreamSubscribeResult` | 订阅子会话执行流并返回读取边界 |
| `stream.unsubscribe` | 是 | `StreamUnsubscribeResult` | 解除订阅 |

`paramsRequired:false` 的方法接受缺失或 `null` 的 `params`；`paramsRequired:true` 的方法要求 `params` 是对象。

## 6. 值模型：可选、null、数字与不透明载荷

- 只使用 JSON 值：对象、数组、字符串、数字、布尔、`null`。没有 `undefined`、`NaN`、`Infinity`。
- **可选**表示字段可能不存在；**可空**表示字段存在但值为 `null`。两者不同。例如 `JobView.stopping` 可选，`JobRecordView.history` 可空。
- 重要 null：
  - `RpcResponse.id` 可为 `null`；请求 `id` 不行。
  - `recordError` 为 `null` 表示记录写入成功；字符串表示失败。
  - `JobRecordView.error`、`history`、`budget`、`previousJobId` 可为 `null`。
  - `jobs.get.record` 为 `null` 表示 Job 尚无终态记录，不等于 Job 不存在。
  - `history.read.available:false` 是明确不可用；`bounds.startEntryId:null` 是合法分支开头，不是“未开始”。
  - `stream.boundary.history` 与 `partial` 可为 `null`。
  - `ToolDetail.parameters` 与 `promptGuidelines` 可为 `null`。
- 数字字段：`seq`、`pid`、`protocolVersion`、`round`、`total`、`modelCalls`、`activeTimeMs` 是整数；`id` 是字符串或数字。大整数按 IEEE-754 处理，精确关联用字符串。
- 不透明载荷：`JobRecordView.result`、`ToolDetail.parameters`、`stream` 的 `messages`／`partial`／`entries`、原生事件中未知字段。解析器必须保留原始 JSON，不要按本地猜测拒绝未知字段。
- 响应对象是精确形状；请求与原生/不透明载荷可能包含额外字段。

## 7. 错误与部分结果

- 错误只出现在 `ok:false` 响应中；没有错误事件。连接断开是传输层事实，不是方法错误。
- `error.code` 是字符串。稳定集合包括 `invalid_request`、`method_not_found`、`not_found`、`not_ready`、`unavailable`、`internal`；端口还会产生 `invalid_target`、`unmanaged_endpoint`、`unknown_endpoint`。
- `internal` 表示未预期失败。当前实现中领域 `SubagentError`（如 `unknown_agent`、`invalid_batch`）没有映射为结构化 code，而是归为 `internal`；这是已知差异，不要把它当作稳定的领域错误码。
- `error.detail` 可选，结构由产生错误的操作决定；解析器应保留原始 JSON。
- 部分结果不是错误：`subagent.create` 的 `items`/`warnings`、`message.send` 广播的 `sent`/`errors`、权限写的 `skipped`/`unresolved`、`reset` 的 `notManaged`/`stillManaged` 都在 `ok:true` 结果中。
- 权限写操作先写记录再应用效果；`recordError` 非 `null` 表示记录未写入，相关效果未应用（fail-closed）。`tools.enable` 同样经 `setToolPermission`，记录失败时 `changed` 为空。
- `disable` 的 `removedActive` 是立即移出 active 的工具；`pendingCompaction` 是等待下一次 compaction 才解除声明的工具。二者不是同一状态。
- 结果未知的控制输入不得自动重放；客户端应让用户或上层决定是否重新发起。

## 8. 工具管理模型

管理与运行时事实分开：

- `not managed`：没有管理条目；不是第三个字面量。
- `enabled` / `disabled`：显式管理态，写入分支记录。
- `permission`：派生四态 `enabled`、`disabled`、`active`、`inactive`。
- `managed`：是否存在显式管理条目。
- `registered`：宿主已注册；`eligible`：当前作用域允许进入候选目录；`active`：当前激活集成员。三者是独立运行时事实，不由 `permission` 推导。

目标形式：

| 形式 | 例 | 匹配 |
| --- | --- | --- |
| 精确工具名 | `read` | 同名工具 |
| MCP server | `mcp://git` | 该 server 的成员 |
| namespace | `namespace://subagent` | 该 namespace 的成员 |
| prefix | `mcp__prod__*` | 名称前缀匹配；config 默认使用 |

`id` 为 `${kind}:${name}`；`kind` 为 `tool`、`mcp`、`namespace`、`prefix`。

`tools.catalog` 默认排除 `disabled`；`tools.detail` 仍可显示被禁用的已注册工具。`tools.permission.query` 只返回派生 `entries` 与用户管理数据 `managed`，不返回来源、命中规则或解释。写操作的逐项字段见 `ToolPermissionSetResult` 与 `ToolPermissionResetResult`；不要把 `enabled` 当成 `active`，也不要把 `active` 当成显式启用。

## 9. 订阅、快照与增量交接

### 9.1 订阅响应

`stream.subscribe` 返回：

```json
{
  "subscription": "sub-1",
  "jobId": "job-1",
  "agentId": "agent-1",
  "rootSessionId": "session-demo",
  "live": true,
  "boundary": {
    "status": "running",
    "round": 1,
    "history": { "startEntryId": "e1", "endEntryId": "e2" },
    "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "already said" } ] } ],
    "partial": null
  }
}
```

`boundary` 是订阅建立时的读取边界：已产生消息、当前累计 partial、历史区间、Job 状态与轮次。`live` 表示是否挂上实时源；已终态 Job 仍返回真实快照，但不再补发终态事件。

### 9.2 事件

```json
{ "event": { "subscription": "sub-1", "seq": 1, "payload": { "kind": "session", "rootSessionId": "session-demo", "jobId": "job-1", "agentId": "agent-1", "event": { "type": "message_start" } } } }
```

```json
{ "event": { "subscription": "sub-1", "seq": 2, "payload": { "kind": "job", "rootSessionId": "session-demo", "jobId": "job-1", "agentId": "agent-1", "status": "completed" } } }
```

- `seq` 是**每连接**单调递增的整数，从 1 开始；不是每订阅独立序号。多个订阅在同一连接上共享 `seq` 空间，事件会交错。
- 客户端按 `subscription` 分发；同一订阅内按接收顺序处理。不要假设某订阅的 `seq` 连续；只有观察整个连接的所有事件时才谈缺口。
- `kind:"session"` 的 `event` 是 Pi 原生事件；`kind:"job"` 是 Harness Job 终态，独立于原生 `agent_end`/`agent_settled`。
- 已终态 Job 的 `stream.subscribe` 不再补发 `kind:"job"`；状态在 `boundary.status`。

### 9.3 快照／增量交接与事件先于响应

服务器不承诺 `stream.subscribe` 响应先于事件。实现顺序是：

1. `stream.subscribe` 在返回前分配 subscription id 并注册原生监听器；监听器只注册、不重放。
2. 紧接着同步读取 live snapshot 并构造 boundary；这一段没有 `await`，原生事件不能在注册与快照之间插入。
3. handler 返回后 transport 才写响应；在这段等待窗口内到达的事件会先写出，且已携带 subscription id。

因此：

- boundary 是“注册后、响应前”的快照；窗口内到达的事件发生在 boundary 读取之后，属于快照后的增量，不会与 boundary 重复。
- 客户端必须按 `event.subscription` 缓冲事件，直到收到携带该 subscription 的响应与 boundary；然后先渲染 `boundary.messages` 与 `boundary.partial`，再按 `seq` 应用缓冲事件。
- 不要在响应前丢弃事件，也不要假设响应先到。若事件到达时 subscription id 未知（例如实现违约），保留原始帧并报告协议错误。
- 事件与响应可能交错；`seq` 是每连接序号，按 `seq` 排序，不按接收顺序推断边界。

- `message_update` 的线上投影丢弃顶层 `message` 与 `assistantMessageEvent.partial`，保留 `usage` 与 `assistantMessageEvent`（文本/推理/工具参数增量）。客户端需要自己的消息组装器：`message_start`/`message_end` 提供完整消息边界，delta 事件累积到本地消息。
- `toolcall_start` 额外提供 `id` 与 `toolName`；后续 `tool_execution_*` 用 `toolCallId` 与（存在时）`parentToolCallId` 关联。不要把参数生成事件与工具执行事件合并。
- `agent_end`/`agent_settled` 不是 Harness Job 终态；Job 可能继续消费停放输入或等待子任务。最终状态以 `kind:"job"` 或 `boundary.status` 为准。
- `stream.unsubscribe` 返回 `{removed:boolean}`。`removed:true` 后应忽略该订阅的后续事件；由于事件与响应可能交错，响应到达前已写出的事件仍可能合法。
- 断连会释放订阅，但不会取消 Job。重新订阅会得到新的快照；没有 resume token，也没有事件重放。

## 10. 解析器与有状态组装器的分工

### 10.1 一致性级别

| 级别 | 范围 | 夹具标记 |
| --- | --- | --- |
| L1 framing | 字节流 → 完整帧：UTF-8、NDJSON、CRLF、空行、跨读取切分 | `framing` |
| L2 envelope | 帧 → 请求／响应／事件：判别、`id`／`method`、错误信封 | `envelope` |
| L3 payload | 结果形状：工具管理、历史／流边界、部分结果 | `payload` |
| L4 stateful | 请求关联、订阅表、`seq`、快照／增量交接 | `stateful` + `scenarios` |

L1、L2 可用静态夹具验收；L3 用结果夹具；L4 需要运行时 harness，夹具只提供序列与期望，不替代真实端点。

### 10.2 无状态解码参考流程

```text
buffer = ""
on_bytes(chunk):
  buffer += utf8_decode_streaming(chunk)
  while "\n" in buffer:
    line, buffer = split_first(buffer, "\n")
    line = strip_trailing_cr(line)
    if line.trim() == "": continue
    value = json_parse(line)
    if value is not object: emit_invalid()
    else if "method" in value: emit_request(value)
    else if "ok" in value: emit_response(value)
    else if "event" in value: emit_event(value)
    else: emit_invalid()
on_eof():
  if buffer.trim() != "": emit_incomplete(buffer)  # not a frame
```

### 10.3 有状态组装参考状态

```text
pending: map id -> method
subscriptions: map subscription -> {jobId, agentId, rootSessionId, lastSeq, terminal}

on_response(frame):
  req = pending.remove(frame.id)
  if req is unknown: log/ignore
  if frame.ok == false: surface_error(frame.error)
  else if req.method == "stream.subscribe":
    subscriptions[frame.result.subscription] = {..., lastSeq: 0, terminal: null}
  else: deliver_result(req.method, frame.result)

on_event(frame):
  sub = subscriptions[frame.event.subscription]
  if sub is unknown: ignore
  if frame.event.seq <= sub.lastSeq: ignore  # duplicate/out-of-order
  sub.lastSeq = frame.event.seq
  payload = frame.event.payload
  if payload.kind == "session": assemble_native_event(payload.event)
  else if payload.kind == "job": sub.terminal = payload.status

on_unsubscribe_ok(subscription): subscriptions.remove(subscription)
```

`seq` 是每连接序号；每订阅 `lastSeq` 只用于排序，不能检测该订阅的缺口。

纯解析器（无业务状态）必须能完成：

- 流式 UTF-8 解码与 `\n` 分帧；忽略空行与行尾 `\r`。
- JSON 解析；拒绝非对象请求帧。
- 信封判别：请求 `method`、响应 `ok`、事件 `event`。
- 读取 `id`、`method`、`params`、`ok`、`result`、`error`、`event.subscription`、`event.seq`、`event.payload.kind`。
- 按方法查 `manifest.methods`，选择参数/结果 `$defs` 做可选校验。
- 保留不透明载荷（`result`、`parameters`、`messages`、`partial`、`entries`、未知原生事件字段）的原始 JSON。

有状态组装器（需要 Pi 事件知识）还必须维护：

- 待处理请求表（`id → method`）与超时/断连策略。
- 订阅表（`subscription → job/agent/root`）与 `seq` 排序。
- 快照边界、消息组装（文本/推理/工具调用）、`toolCallId`/`parentToolCallId` 关联。
- Job 终态与原生 `agent_end`/`agent_settled` 的区分。
- 取消订阅后的忽略规则、断连后的重订阅策略。
- 部分结果聚合（`items`/`warnings`、`sent`/`errors`、`skipped`/`unresolved`）。
- 控制输入“结果未知”时不自动重放。

解析器可以在不理解 Pi 原生事件的情况下校验帧；组装器不能。

## 11. 上游 Pi 定义与不透明载荷

协议不复制上游模型；下表是已测试的安装版本与类型定义位置（包内相对路径，行号对应安装的 1.5.0 产物）：

| 线上定义 | 上游类型 | 包与版本 | 定义位置 |
| --- | --- | --- | --- |
| `NativeSessionEvent` | `AgentSessionEvent` | `@earendil-works/pi-coding-agent@1.5.0` | `dist/core/agent-session.d.ts:49`（`dist/index.d.ts:3` 再导出） |
| `NativeMessage` | `AgentMessage` | `@earendil-works/pi-agent-core@1.5.0` | `dist/types.d.ts:322` |
| `NativeMessage` 的 assistant 形态 | `AssistantMessage` | `@earendil-works/pi-ai@1.5.0` | `dist/types.d.ts:375` |
| `NativePartial` | `AssistantMessage` | `@earendil-works/pi-ai@1.5.0` | `dist/types.d.ts:375` |
| `message_update.assistantMessageEvent` | `AssistantMessageEvent` | `@earendil-works/pi-ai@1.5.0` | `dist/types.d.ts:585` |
| `usage` | `Usage` | `@earendil-works/pi-ai@1.5.0` | `dist/types.d.ts:285` |
| `ToolDetail.parameters` | `ToolInfo["parameters"]` | `@earendil-works/pi-coding-agent@1.5.0` | `dist/core/extensions/types.d.ts:1600`（`dist/index.d.ts:8` 再导出） |
| `NativeEntry` | `FileEntry` | `@earendil-works/pi-coding-agent@1.5.0` | `dist/core/session-manager.d.ts:130`（`dist/index.d.ts:21` 再导出） |
| `JobRecordView.result` | Runtime 领域结果 | — | 类型不固定；保留原始 JSON |

`NativeSessionEvent` 的 `message_update` 投影（仅 `message.role === "assistant"`）：

- 原生：`{ type:"message_update", message: AgentMessage, assistantMessageEvent: AssistantMessageEvent }`。
- 线上：`{ type:"message_update", usage: Usage, assistantMessageEvent: ProjectedAssistantMessageEvent }`。
- 顶层 `message` 被移除；`usage` 取自 `message.usage`。
- `assistantMessageEvent.partial` 被移除；其余字段保留。
- `toolcall_start` 在 `partial.content[contentIndex]` 是 `toolCall` 时增加 `id` 与 `toolName`；无法解析时这两个键省略（JSON 序列化会丢弃 `undefined`）。
- 非 assistant 的 `message_update` 原样透传，不做上述投影。

| `assistantMessageEvent.type` | 线上字段 |
| --- | --- |
| `start` | `type` |
| `text_start` / `thinking_start` | `type`, `contentIndex` |
| `text_delta` / `thinking_delta` / `toolcall_delta` | `type`, `contentIndex`, `delta` |
| `text_end` / `thinking_end` | `type`, `contentIndex`, `content` |
| `toolcall_start` | `type`, `contentIndex`, `id?`, `toolName?` |
| `toolcall_end` | `type`, `contentIndex`, `toolCall` |
| `done` | `type`, `reason`, `message` |
| `error` | `type`, `reason`, `error` |

原生事件还包括 `message_start`/`message_end`（保留完整 `message`）、`tool_execution_start`/`update`/`end`（`toolCallId`，工具内调用可带 `parentToolCallId`）、`agent_end`/`agent_settled`、压缩/重试/队列事件；具体类型以 `AgentSessionEvent` 为准。协议不复制这些定义，也不要求解析器认识所有 `type`；未知 `type` 必须原样保留。

## 12. 夹具

语言无关夹具位于 [`schemas/fixtures/harness-rpc/`](../schemas/fixtures/harness-rpc/)：

- `valid/`：合法帧与流。
- `invalid/`：非法帧、非法 JSON、错误信封、非法事件序号等；未知方法另有 `valid/unknown-method-request.json`（结构有效、dispatch 拒绝）与 `invalid/unknown-method-method-request.json`（不是受支持的 `MethodRequest`）。
- `transport/`：分帧与 UTF-8 向量；`split-utf8.json` 验证多字节字符跨读取，`split-frame.json` 验证 CRLF、空行与 JSON token 内部切分。
- `stateful/`：`subscribe-partial-then-deltas.ndjson` + `.expected.json`；包含事件先于 `stream.subscribe` 响应、`boundary.partial`、文本/工具增量、`message_end` 与 Job 终态，以及期望的组装文本/工具调用/终态。
- `manifest.json`：每个夹具的路径、类型（`frame`/`stream`/`raw`/`transport`/`conversation`）、`conformance` 级别、目标 `$defs`、期望有效性与帧数；`conversation` 用 `schemas` 逐帧指定目标、`expected` 指向期望文件；`scenarios` 给出有状态序列及期望 `subscription`／`seq`／`jobStatus`。

夹具是普通 JSON/NDJSON 文本，不依赖 TypeScript。`scripts/check-rpc-schema.mjs` 只是仓库 CI 校验器；其他语言可以直接读取夹具与 `manifest.json` 做自己的测试。`transport` 向量的 `utf8Split:true` 要求至少一个切分点落在多字节 UTF-8 序列内部。`manifest.json` 的 `nativeValidity` 区分 `strict`（完整投影原生轨迹）、`illustrative`（信封有效但原生载荷缩写）与 `opaque`（载荷故意未知）；只有 `stateful/subscribe-partial-then-deltas` 是 `strict`。限定：`strict` 对话仍是按 pinned 类型构造的合成 trace；CI 只做选定必填字段检查，不是完整上游 union 校验，也不是完整 SDK 事件捕获。

## 13. 实现一个解析器还需要什么

在选定语言后，至少需要：

1. 平台传输：Unix domain socket 或 Windows Named Pipe 的连接、读写与 EOF 处理。
2. 流式 UTF-8 解码器与按 `\n` 分帧；处理 CRLF、空行与跨读取的多字节字符。
3. JSON 解析器；决定大数字策略（建议 `id` 用字符串，整数保持精确）。
4. 信封判别、`id` 关联表、方法分派与可选 schema 校验。
5. 有状态组装器：订阅表、`seq` 排序、消息/工具调用组装、Job 终态、取消订阅/断连策略。
6. 错误映射与“结果未知不重放”策略；`internal` 与结构化 code 的区分。
7. 用 `valid/`、`invalid/`、`transport/` 夹具做单元测试；用真实端点做集成测试。
8. 平台验收：Unix 与 Windows Named Pipe 分别验证；未具备环境时明确标记未测。

尚未选择实现语言，因此没有生成 SDK、代码生成框架或语言特定包装层。`manifest.json` 与 JSON Schema 可作为未来生成器的输入。

## 14. 已知限制与差异

- 实现没有输入行长度上限；服务器未发送积压默认 4 MiB，超限断开。不要把它当作可靠的大帧传输。
- 非法 UTF-8 可能被解码器替换为 U+FFFD，协议不做修复。
- 领域 `SubagentError` 目前归为 `internal`，不保留领域错误码；`subagent.create` 的本地启动失败在领域层抛 `SubagentError("start_failed")`，线上 `code` 仍是 `internal`，已登记项只在 message 中，没有结构化失败项。
- `message.send` 的跨会话回执 `{ok:true, delivered:"session", path}` 在实现中存在，接口契约方法表未逐字命名。
- `tools.catalog.filter/category`、`permission.query.expr` 在适配层把非字符串当作未提供；schema 要求字符串。
- `history.read`/`stream.subscribe` 的 `status` 实际是 `JobStatus`，端口类型写 `string`。
- `seq` 是每连接而非每订阅；没有每订阅缺口检测。
- 没有协议级取消、重订阅 resume token、压缩、认证或版本协商；`harness.info.protocolVersion` 只报告当前版本。
- Windows Named Pipe 实机与真实在线供应商多轮未验证。

上述差异按实际行为记录，不编码成新的协议承诺；详见 [Harness RPC Schema](harness-rpc-schema.md#实现与契约差异)。
