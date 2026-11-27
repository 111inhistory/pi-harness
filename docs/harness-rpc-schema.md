# Harness RPC Schema

本文是 [Harness RPC 线协议规范](harness-rpc-wire-spec.md) 的 schema 附录：说明机器可读 schema、manifest、夹具入口和校验方式。协议语义（传输、信封、关联、订阅交接、解析器／组装器分工）以线协议规范为准；本页不新增协议字段或状态模型。当前协议版本为 2。

## 入口与生成

| 资产 | 路径 | 作用 |
| --- | --- | --- |
| JSON Schema（生成物） | `schemas/harness-rpc.schema.json` | 对外校验入口，JSON Schema 2020-12，共享定义在 `$defs`；由本地命令或 CI 生成，不追踪生成文件 |
| 方法与夹具清单（生成物） | `schemas/harness-rpc.manifest.json` | 传输、信封、方法映射、订阅与夹具索引 |
| 生成物校验和 | [`schemas/SHA256SUMS`](../schemas/SHA256SUMS) | Git 追踪的 SHA-256 清单，记录两个生成文件的精确字节 |
| 语言无关夹具 | [`schemas/fixtures/harness-rpc/`](../schemas/fixtures/harness-rpc/) | `valid/`、`invalid/`、`transport/` 与 `manifest.json` |
| Schema 源码 | [`src/harness-rpc/schema.ts`](../src/harness-rpc/schema.ts) | 唯一定义源；TypeScript 仅用于生成与 CI |
| 生成与一致性检查 | [`scripts/check-rpc-schema.mjs`](../scripts/check-rpc-schema.mjs) | 校验夹具与 SHA-256；通过后生成 JSON，`--write` 同时更新校验和 |
| 实现一致性测试 | [`test/typed/harness-rpc-schema.test.ts`](../test/typed/harness-rpc-schema.test.ts) | 用真实 router 与端口输出校验 `$defs` |

```sh
npm run check:rpc-schema   # 校验定义和夹具，对比 SHA-256，然后生成两个 JSON
npm run schema:rpc         # 有意修改协议后，重新生成 JSON 并更新 SHA256SUMS
sha256sum --check schemas/SHA256SUMS
```

`npm run check` 已包含 `check:rpc-schema`，干净 checkout 无需预先生成 JSON。Git 只追踪定义源码、夹具和 `SHA256SUMS`；生成器按固定依赖版本、对象顺序、两空格缩进、UTF-8 与 LF 序列化。协议修改后运行 `schema:rpc`，审查源码与本地生成物差异，再提交更新的校验和；普通检查不会改写校验和，缺失或不匹配会失败。

[Harness RPC schema 工作流](../.github/workflows/harness-rpc-schema.yml) 在 push、pull request 和手动触发时，分别在 Ubuntu 与 Windows runner 上用 `npm ci` 安装锁定依赖，运行完整基准检查、`sha256sum --check` 与文档／JSON 检查。成功后由 Ubuntu job 在 GitHub Actions 运行页面提供 `harness-rpc-protocol-<commit SHA>` artifact，包含生成的两个 JSON、校验和、协议文档与语言无关夹具；其他语言的解析库可以直接下载使用。仓库没有自动 Release 发布流程。

## 帧与校验

文档顶层 `oneOf` 覆盖三个方向的帧；方法参数与结果通过 `$defs` 复用，不按方法复制结构。

| 校验目标 | 引用 | 说明 |
| --- | --- | --- |
| 任意帧 | 顶层 `oneOf` | `RpcRequest`、`RpcResponse`、`RpcEventFrame` 三选一 |
| 客户端请求（严格） | `#/$defs/MethodRequest` | 按 `method` 字面量区分已实现的方法；要求必填参数的方法缺少 `params` 时校验失败 |
| 客户端请求（通用） | `#/$defs/RpcRequest` | 只校验 `id`、`method`、可选 `params`；未知请求字段被 transport 忽略 |
| 响应 | `#/$defs/RpcResponse` | `ok:true` 携带 `result`；`ok:false` 携带 `error`；`id` 可为 `null` |
| 订阅帧 | `#/$defs/RpcEventFrame` | `{event:{subscription,seq,payload}}`；`seq` 从 1 起、每连接单调 |
| 执行流事件载荷 | `#/$defs/StreamEventPayload` | `session` 或 `job` 两类；由 `stream.subscribe` 推送 |
| Approval 事件载荷 | `#/$defs/ApprovalsEvent` | `kind:"approvals"`；由 `approvals.subscribe` 推送 |
| Main 事件载荷 | `#/$defs/MainEventPayload` | `kind:"main"`；由 `main.subscribe` 推送，`event` 为 opaque SDK/扩展事件 |
| 发现记录 | `#/$defs/HarnessRpcRecord` | `harness-rpc.json` 的机器可读内容 |

`#/$defs` 内的引用由 JSON Schema 解析器处理；用 TypeBox 校验时，把 `$defs` 与 `$ref` 放在同一个根对象中（测试与脚本使用 `harnessRpcSchemaRef(name)`）。

## 方法映射

`x-methods` 与 `HARNESS_RPC_METHOD_SCHEMAS` 给出方法到 `$defs` 的映射；`check:rpc-schema` 校验它与 `RPC_METHODS` 完全一致。

| 方法 | 参数 `$defs` | 结果 `$defs` |
| --- | --- | --- |
| `harness.info` | `NoParams` | `HarnessInfoResult` |
| `tools.catalog` | `ToolsCatalogParams` | `ToolCatalogResult` |
| `tools.detail` | `ToolsDetailParams` | `ToolDetail` |
| `tools.base.add` | `TargetsParams` | `ToolWriteResult` |
| `tools.base.remove` | `TargetsParams` | `ToolWriteResult` |
| `tools.base.list` | `NoParams` | `ToolBaseListResult` |
| `tools.activate` | `TargetsParams` | `ToolWriteResult` |
| `tools.deactivate` | `TargetsParams` | `ToolWriteResult` |
| `tools.blacklist.add` | `TargetsParams` | `ToolWriteResult` |
| `tools.blacklist.remove` | `TargetsParams` | `ToolWriteResult` |
| `tools.blacklist.list` | `NoParams` | `ToolBlacklistListResult` |
| `agents.tree` | `NoParams` | `AgentsTreeResult` |
| `jobs.list` | `JobsListParams` | `JobsListResult` |
| `jobs.get` | `JobIdParams` | `JobGetResult` |
| `jobs.result` | `JobIdParams` | `JobRecordView` |
| `subagent.create` | `SubagentCreateParams` | `CreatedBatch` |
| `subagent.signal` | `SubagentSignalParams` | `SignalResult` |
| `message.send` | `MessageSendParams` | `MessageSendResult` |
| `history.read` | `JobIdParams` | `HistoryReadResult` |
| `stream.subscribe` | `JobIdParams` | `StreamSubscribeResult` |
| `stream.unsubscribe` | `StreamUnsubscribeParams` | `StreamUnsubscribeResult` |
| `presets.catalog` | `NoParams` | `PresetsCatalogResult` |
| `presets.current` | `NoParams` | `PresetsCurrentResult` |
| `hooks.current` | `NoParams` | `HooksCurrentResult` |
| `hooks.stats` | `NoParams` | `HooksStatsResult` |
| `presets.apply` | `PresetApplyParams` | `PresetApplyOutcome` |
| `presets.clear` | `NoParams` | `PresetClearOutcome` |
| `approvals.list` | `NoParams` | `ApprovalsListResult` |
| `approvals.mode.get` | `NoParams` | `ApprovalModeGetResult` |
| `approvals.mode.set` | `ApprovalModeSetParams` | `ApprovalModeSetResult` |
| `approvals.get` | `ApprovalIdParams` | `ApprovalsGetResult` |
| `approvals.respond` | `ApprovalRespondParams` | `ShellApprovalRespondResult` |
| `approvals.subscribe` | `NoParams` | `ApprovalsSubscribeResult` |
| `sessions.list` | `NoParams` | `SessionsListResult` |
| `sessions.connect` | `SessionsConnectParams` | `SessionConnect` |
| `main.state` | `NoParams` | `MainStateResult` |
| `main.input` | `MainInputParams` | `MainInputResult` |
| `main.interrupt` | `NoParams` | `MainRequestedResult` |
| `main.compact` | `MainCompactParams` | `MainCompactResult` |
| `main.navigate` | `MainNavigateParams` | `MainOutcomeResult` |
| `main.reload` | `NoParams` | `MainRequestedResult` |
| `main.new` | `MainNewParams` | `MainOutcomeResult` |
| `main.switch` | `MainSwitchParams` | `MainOutcomeResult` |
| `main.fork` | `MainForkParams` | `MainOutcomeResult` |
| `main.subscribe` | `NoParams` | `MainSubscribeResult` |

响应本身不携带方法名；客户端按请求 `id` 关联后，用上表选择结果定义。`RpcSuccessResponse.result` 在通用 schema 中是开放值，严格结果校验使用方法映射。

## 工具管理模型与目标形式

schema 与实现使用同一套集合模型，不把成员关系压成单一状态枚举：

- BASE 是会话基线成员，DYNAMIC 是用户或 Capability 发现激活的动态成员，BLACKLIST 是无视前两者的禁止项。有效请求成员为 `(base ∪ dynamic) − blacklist`，仍受注册、作用域与 SDK 限制。
- `ToolAccessEntry` 分别报告 `base`、`dynamic`、`active`、`blacklisted`、`activatable`、`usable`；`active` 只是 SDK 激活集事实。`blacklistSources` 报告 `startup`、`preset`、`branch` 中当前贡献禁止的来源。
- `tools.catalog` 默认返回当前有效成员（含 dynamic）；`includeActivatable` 在当前请求成员上展开可自加载的已注册/作用域合格工具；`includeUsable` 过滤为当前真正可调用集合。两者同时使用时只列 usable ∪ activatable，不包含不可用的请求基线成员。黑名单成员即使属于 base 也不是 usable。
- `ToolTarget` 的 `kind` 为 `tool`、`mcp`、`namespace` 或 `prefix`；目标形式分别为精确工具名、`mcp://server`、`namespace://name` 与 config 默认的 `foo*`。`id` 是 `${kind}:${name}`。
- 六个写方法共用 `ToolWriteResult`，以 `action` 区分；`changed`、`selected`、`noSchema`、`schema`、`schemaWithheld`、`containers`、`excluded`、`rejected`、`alreadySet`、`unresolved`、`skipped`、`activated`、`alreadyActive`、`removedActive`、`pendingCompaction`、`noticed`、`notRequested`、`stillBlacklisted` 与 `remainingSources` 都是独立事实。`containers` 单独报告已加载的 namespace/MCP 容器与本次选中的具体成员，不伪装为工具；`excluded` 只表示本次选择排除的精确工具名，不是黑名单或成员移除；`noSchema`/`schema` 是本次选中的具体工具请求的按工具模式（无策略写入时为空），`schemaWithheld` 只列当前实际被投影隐藏的 schema；`stillBlacklisted` 保留原始本地禁令，`banOverridden` 列出被显式选择覆盖的 `startup`／Preset 原始禁令；手动 `branch` 禁令是硬围栏，任何 BASE/DYNAMIC 成员都不覆盖它，只有 `blacklist remove` 解除。`rejected` 非空表示整批在选择校验阶段被拒绝，未写记录、未应用效果，`reason` 仅用于 `no_schema_unsupported`。`blacklist remove` 不清除当前 Preset 的 `-tool` 贡献，也不解除 SDK 限制。`recordError` 表示记录写入失败且未应用效果；`effectError` 表示记录已持久化但 SDK 效果调用失败，不回滚或重试。

## 可选、null、错误与部分结果

- 请求 `params` 在通用 envelope 中可选；方法 schema 对必填参数的方法要求 `params`。transport 把缺失或 `null` 的 `params` 当作空对象。
- `RpcResponseId` 为 `id` 或 `null`；无法解析或缺少合法 `id` 的请求返回 `id:null`。
- 错误分支固定为 `{id, ok:false, error:{code,message,detail?}}`。`code` 是开放字符串；稳定集合见 `RPC_ERROR`，端口还会返回 `invalid_target`、`unmanaged_endpoint`、`unknown_endpoint`；`presets.apply` 的过期预览使用 `preset_version_mismatch`，`detail` 为 `{expectedVersion,currentVersion}`。领域 `SubagentError` 与 `MainControlError` 的 code/message 会保留，仅有真正未预期异常使用 `internal`。
- 部分结果不折叠为整体失败：`subagent.create` 成功返回已登记 `items` 与 `warnings`；启动失败使用 `start_failed`，`error.detail` 含 `registered` 与每个失败的 `{agentId, code, message}`；`message.send` 的广播回执保留 `sent` 与逐接收者 `errors`；权限写操作的 `skipped`/`unresolved` 与 `recordError` 分开。
- `recordError` 为 `string|null`；非 `null` 表示权限记录未写入，相关效果未应用。
- `jobs.get.record` 为 `JobRecordView|null`；运行中 Job 可能还没有终态记录。
- `presets.current` 的 `preset`、`status`、`currentVersion` 可为 `null`；无激活 Preset 时三者同为 `null`，`changes` 为空数组。`presets.apply` 的 `contentHash` 为 `null` 表示没有生效版本。
- `history.read` 是 `HistoryReadResult` 联合：`available:false` 只带 `reason:"history_unavailable"`；`available:true` 带 `live`、`bounds` 与 `entries`。`bounds.startEntryId` 可为 `null`，表示从分支开头读取，不是“未开始”。
- `stream.subscribe` 的 `boundary.history` 可为 `null`，`boundary.partial` 可为 `null`；`live` 表示是否挂上实时源。已终态 Job 的边界仍返回真实快照，但不再补发终态事件。
- `RpcEventEnvelope.seq` 是每连接单调序号，不是每订阅独立序号。

## 原生事件与不透明载荷

以下载荷由 Pi 或领域拥有，schema 只描述外层与引用，不重定义上游模型：

| 定义 | 上游／语义 |
| --- | --- |
| `NativeSessionEvent` | `@earendil-works/pi-coding-agent@1.6.1` 的 `AgentSessionEvent`（`dist/core/agent-session.d.ts:49`，`dist/index.d.ts:3` 再导出）。除 `message_update` 外原样透传；assistant `message_update` 移除顶层 `message` 与 `assistantMessageEvent.partial`，保留 `usage`，`toolcall_start` 在可解析时增加 `id`/`toolName` |
| `NativeMessage` | `@earendil-works/pi-agent-core@1.6.1` 的 `AgentMessage`（`dist/types.d.ts:322`）；assistant 形态为 `@earendil-works/pi-ai@1.6.1` 的 `AssistantMessage`（`dist/types.d.ts:385`） |
| `NativePartial` | `@earendil-works/pi-ai@1.6.1` 的 `AssistantMessage`（`dist/types.d.ts:385`）；订阅边界中的累计 partial，或 `null` |
| `NativeEntry` | `@earendil-works/pi-coding-agent@1.6.1` 的 `FileEntry`（`dist/core/session-manager.d.ts:130`，`dist/index.d.ts:21` 再导出）；`history.read.entries` |
| `ToolDetail.parameters` | `@earendil-works/pi-coding-agent@1.6.1` 的 `ToolInfo["parameters"]`（`dist/core/extensions/types.d.ts:1630`，`dist/index.d.ts:8` 再导出）；TypeBox／JSON Schema 对象，或 `null` |
| `JobRecordView.result` | Runtime 记录的领域结果值，类型不固定 |
| `MainEventPayload.event` | Pi `AgentSessionEvent` 或 Main `input_error`，类型不固定；保留原始 JSON |
| `MainCompactResult.result` | Pi SDK compaction result；保留原始 JSON |
| `DetailedAgentHistory` | Job 历史文件路径；`summary`、`cleanJsonl` 必有，其他路径键可扩展 |

`message_update` 的 `assistantMessageEvent` 为 `@earendil-works/pi-ai@1.6.1` 的 `AssistantMessageEvent`（`dist/types.d.ts:600`），`usage` 为 `Usage`（`dist/types.d.ts:295`）。投影后的逐类型字段表见 [线协议规范第 11 节](harness-rpc-wire-spec.md#11-上游-pi-定义与不透明载荷)；本页不重复上游模型。

`stream` 的 `messages`、`partial` 与 `entries` 使用上述不透明定义，避免把 Pi 的原生消息模型复制进本协议。

## 实现与契约差异

当前 schema 与 router/ports 的线上输出一致，没有需要保留的实现差异。`message.send` 的跨会话回执 `{ok:true, delivered:"session", to}` 仍在 `MessageSendResult` 联合中；接口契约方法表未逐字命名该分支。

## 验证

- `npm run check:rpc-schema`：核对已实现的方法与 `$defs` 覆盖一致；`MethodRequest` 每个方法恰好一个分支；`$ref` 均可解析；样例请求／响应／事件／发现记录通过 TypeBox 校验；`valid/`、`invalid/`、`transport/`、`stateful/` 夹具按 manifest 声明验证（含 `conformance` 标签、`nativeValidity` 标签、`conversation` 逐帧 schema 与 `scenarios` 有状态序列）；`strict` 对话还校验上游 `AssistantMessage`/`Usage`/`toolCall` 必填字段；schema 与 manifest 的生成字节匹配 Git 追踪的 SHA-256。
- `test/typed/harness-rpc-schema.test.ts`：用真实 `createRouter`、工具端口、子 Agent 端口、历史端口与执行流端口产生结果，逐个方法校验 `$defs`；覆盖 `record:null`、`history_unavailable`、`stream` 的 `session`/`job` 事件、广播与跨会话回执、错误 envelope 与全部方法请求。
- 夹具是普通 JSON/NDJSON，其他语言可直接读取；`scripts/check-rpc-schema.mjs` 只是仓库 CI，不是跨语言运行时。
- 传输、实际 SDK 宿主与 CLI 子进程测试使用平台地址生成器，Windows 对应真实 Named Pipe；平台验收以 CI 结果为准。真实在线供应商多轮不在这些离线测试的覆盖范围。
