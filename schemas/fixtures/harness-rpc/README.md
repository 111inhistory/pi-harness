# Harness RPC 语言无关夹具

本目录是 Harness RPC 线协议的测试向量，面向任意语言的解析器实现。夹具是普通 JSON／NDJSON 文本；`schemas/harness-rpc.schema.json` 与 `schemas/harness-rpc.manifest.json` 是生成的机器可读 schema 与方法清单。Git 追踪定义源码、夹具和 `schemas/SHA256SUMS`，不追踪这两个 JSON；运行 `npm run check:rpc-schema` 会校验 SHA-256 并生成本地文件。GitHub Actions 的 Harness RPC schema 工作流提供包含 JSON、校验和、文档与夹具的 artifact，下载入口见 [Schema 附录](../../../docs/harness-rpc-schema.md)。仓库内的 `scripts/check-rpc-schema.mjs` 只是 CI 校验器，不是其他语言的运行时依赖。

## 目录

| 目录 | 内容 |
| --- | --- |
| `valid/` | 合法帧、合法流与合法结果快照 |
| `invalid/` | 非法 JSON、非法信封、缺少必填字段、未知方法、非法事件序号、错误载荷等 |
| `transport/` | 分帧与 UTF-8 向量；`split-utf8.json` 提供原始文本、字节切分点与期望帧 |
| `manifest.json` | 每个夹具的路径、类型、目标 `$defs`、期望有效性与帧数 |

## manifest 条目

```json
{
  "path": "valid/request-harness-info.json",
  "kind": "frame",
  "schema": "MethodRequest",
  "valid": true
}
```

- `conformance`：`framing`、`envelope`、`payload`、`stateful` 之一或多个，对应线协议规范的一致性级别。
- `nativeValidity`：`strict` 表示完整投影原生轨迹；`illustrative` 表示信封有效但原生载荷缩写；`opaque` 表示载荷故意未知。当前只有 `stateful/subscribe-partial-then-deltas` 是 `strict`。
- `kind:"frame"`：文件是一个 JSON 值，按 `schema` 指向的 `$defs` 校验。
- `kind:"stream"`：文件是 NDJSON；按 `\n` 分行，去掉行尾 `\r`，忽略空行；每行按 `schema` 校验。`valid:false` 时 `invalidFrameIndex` 指定应失败的行，其余行应通过。
- `kind:"raw"`：文件不是 JSON；`valid:false` 表示 JSON 解析应失败。
- `kind:"transport"`：文件是分帧向量；按 `text` 的 UTF-8 字节在 `splitByteOffsets` 处切块，拼接后分行解析，结果应与 `expectedFrames` 相同，并逐帧按 `MethodRequest` 校验。
- `kind:"conversation"`：文件是 NDJSON 对话序列；`schemas` 逐帧指定目标 `$defs`，`expected` 指向期望状态文件。当前 `stateful/subscribe-partial-then-deltas.ndjson` 特意把 `seq:1` 事件放在 `stream.subscribe` 响应之前，用于验证客户端缓冲：先按 `subscription` 暂存事件，收到响应/boundary 后再应用。

`lineEnding:"crlf"` 表示夹具使用 CRLF；解析器仍应按 `\n` 分帧并去掉行尾 `\r`。`utf8Split:true` 的 transport 向量要求至少一个切分点落在多字节 UTF-8 序列内部。

## 有状态对话夹具

`stateful/subscribe-partial-then-deltas.ndjson` 的帧顺序是：

1. `stream.subscribe` 请求。
2. `seq:1` 的 `message_update`/`text_delta`（先于响应）。
3. `stream.subscribe` 响应，`boundary.partial` 为 `"Hello wor"`。
4. `seq:2`–`seq:8` 的 `text_end`、工具调用生成/结束、`message_end` 与工具执行事件。
5. `seq:9` 的 `kind:"job"` 终态。

`stateful/subscribe-partial-then-deltas.expected.json` 给出 `ordering.bufferedSeq`、边界文本、组装后的 `text`、工具调用与终态。实现应把 `boundary.partial` 与缓冲的 `seq:1` delta 一起应用，得到 `"Hello world"`；不要丢弃先到的事件，也不要假设响应先到。

该对话的 assistant 消息与 `Usage` 按 `@earendil-works/pi-ai@1.5.0` 的必填字段构造（`api`/`provider`/`model`/`usage`/`stopReason`/`timestamp`，`Usage` 含 `cacheRead`/`cacheWrite`/`totalTokens`/`cost`，`toolCall` 含 `type:"toolCall"`）。其他 `nativeValidity:illustrative` 的 envelope 夹具只用于帧形状，不冒充完整原生消息。

限定：CI 的 `assertUsage`/`assertAssistant` 是选定必填字段检查，不是完整上游 union 校验；本 strict 对话是按 pinned 类型构造的合成 trace，不是完整 SDK 事件捕获。

## scenarios

`manifest.json` 的 `scenarios` 是 L4 有状态序列的机器可读描述：

```json
{
  "name": "subscribe-then-events",
  "conformance": "stateful",
  "steps": [
    { "path": "valid/stream-subscribe-result.json", "schema": "StreamSubscribeResult", "role": "subscribe-result" },
    { "path": "valid/event-session.json", "schema": "RpcEventFrame", "role": "event" },
    { "path": "valid/event-job.json", "schema": "RpcEventFrame", "role": "event" }
  ],
  "expect": { "subscription": "sub-1", "seq": [1, 2], "jobStatus": "completed" }
}
```

它只约束关联与顺序，不规定完整消息组装；文本/推理/工具调用组装需要实现自己的有状态组装器。

## 使用方式

1. 读取 `manifest.json`，逐个夹具加载文件。
2. 按 `kind` 处理；用 `schema` 对应的 `$defs` 做可选校验。
3. 对 `valid:false` 的夹具断言解析或校验失败；对 `valid:true` 的夹具断言通过。
4. `transport/split-utf8.json` 用于验证流式 UTF-8 解码：按字节切分后，多字节字符不能被截断成替换字符。
5. 用真实端点做集成测试；夹具只覆盖协议形状，不覆盖 Job 执行语义。

## 维护

新增夹具后，把它加入 `manifest.json`，并运行：

```sh
npm run check:rpc-schema
```

CI 会检查每个文件都在 manifest 中、每个 manifest 条目都存在、期望有效性与 schema 一致，以及 `transport` 向量确实在 UTF-8 多字节序列内部切分。
