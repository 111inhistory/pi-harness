# Provider 传输行为

Harness 使用 Pi 原生的序列化、认证和流处理。传输能力由 `src/provider-session.ts` 按模型的准确 `api` 和明确的 `compat` 字段判断，不根据模型名称或网关 URL 开启增量工具协议。

## 工具与指引更新

| 传输方式 | 所需兼容位 | 工具行为 |
| --- | --- | --- |
| Responses | `supportsMidConvoSystemMessages` 与 `supportsAdditionalTools` | 原生新增工具与同名接口更新 |
| Responses 工具搜索 | `supportsToolSearch` | 原生新增；同名替换可能需要重建头部 |
| Anthropic Messages | `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolChanges` | 原生新增工具与同名接口更新 |
| Chat Completions 扩展 | `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolAdditions` | 仅新增名称，Pi 编码为携带工具声明的 system 消息 |
| 标准 Chat Completions | 未开启工具追加扩展 | 当前工具序列化到顶层 `tools` 数组 |

Chat Completions 的两个标志必须都明确为 `true`。携带工具的 system 消息是服务商扩展，不属于标准 Chat Completions。只有实际端点支持该格式时才能开启；Responses 和 Anthropic 的兼容位不能为 Chat Completions 模型开启此能力。

实现了这项扩展的端点可使用以下模型配置：

```json
{
  "api": "openai-completions",
  "compat": {
    "supportsMidConvoSystemMessages": true,
    "supportsMidConvoToolAdditions": true
  }
}
```

`supportsMidConvoSystemMessages` 同时决定指引更新是否保留在历史位置。未开启时，Pi 把 system 更新折叠到头部提示词。该文本能力与增量工具声明彼此独立。

`toolAdditions` 与 `toolSameNameUpdates` 只描述原生工具声明能力。文本工具伪新增不在本模型内，也未实现；未来启用需要模型级检测和服务端验证，不能只凭供应商或 API 判断。

Harness renders current namespace instructions at the request tail. Native `promptGuidelines`, descriptions, tool declarations and schema updates remain SDK-owned. Harness stores no description baseline or placement record and emits no separate description-correction layer. Earlier instruction versions are not replayed.

Current text is resent on each request. A complete forced prompt can suppress Harness sections under the existing SDK hook order. Historical instruction placement and whole-request prefix continuity are not guaranteed; serializers may fold tail system messages into the head.

参数或其他真实接口发生变化时，保留原生声明。Harness 不隐藏接口变化，也不保留过时 schema 继续执行。仅支持新增的传输路径遇到同名替换时，可能把工具重新折叠到顶层列表，从而改变请求前缀。描述文本不能代替 schema 更新。

Current loadout and permission state determine declaration availability; Harness does not suppress native removal updates to preserve a historical prefix. Execution admission remains authoritative. Successful compaction can remove unused discovered tools; see [compaction pruning](capability-prompt-memory.md#压缩与未使用能力淘汰)。

## 对话中 effort

`providerSessionPolicy(model, request?)` 为精确 `api` 和显式 `compat` 返回 `midConversationEffort`。该字段只描述原生编码器是否可用于同模型 effort 变更，不承诺缓存命中，也不代表任意后置 payload hook 之后的结果。

| 路径 | 条件 | 原生行为 |
| --- | --- | --- |
| `openai-responses` | `supportsMidConvoEffort`、有效非 `off` level、解析后的请求 URL 不是官方 OpenAI sign-in | 追加 `configuration_update`；请求级 `reasoning.effort` 保持固定 |
| 官方 OpenAI Responses sign-in | `provider=openai`、解析后的 `baseUrl` 为官方 URL、实际 `apiKey` 不以 `sk-` 开头 | 抑制 `configuration_update`，改为改变请求级 effort |
| `azure-openai-responses` | 即使 compat 为 true | 没有 `configuration_update` 编码器，改变请求级 effort |
| `openai-codex-responses` | 即使 compat 为 true | 没有 `configuration_update` 编码器，改变请求级 effort；其 WebSocket continuation 重置是另一项行为 |
| `anthropic-messages` | `supportsMidConvoEffort` 且 thinking enabled | 历史/尾部 effort marker，请求级 `output_config.effort` 保持固定 |
| `anthropic-messages` off | thinking disabled | 发送 disabled，不发送 effort marker |
| `openai-completions` | 任意 | 没有 `supportsMidConvoEffort` 编码器 |

`midConversationEffort` 的 `unverified` 表示该 API 有编码器，但调用方没有提供判定所需的 request facts；消费方必须按不支持处理，直到补充事实后重新求值。缺少整个 `auth` 对象表示尚未解析；已解析的 `auth: {}` 表示没有 `baseUrl` 覆盖且没有 API key（例如 header-only）。实际请求 URL 按 SDK 规则取 truthy 的 `auth.baseUrl` 覆盖 `model.baseUrl`，随后才由原生适配器判定 sign-in。因此 `provider=openai` 的 `openai-responses` 即使目录 URL 是自定义网关，也需要已解析的 auth facts，因为该 URL 可能被覆盖；`provider!=openai` 不可能满足 sign-in 判定，不需要 auth facts。有效 thinking level 必须由调用方提供，不能用原始请求值代替 SDK clamp 后的值。

消费方必须提供 SDK clamp 后的有效 thinking，并在 `provider=openai` 的 `openai-responses` 路径上提供已解析 auth；该层不提供 auth 缓存、存储、stream wrapper 或刷新策略，也不保留或记录凭据。普通 Preset 的显式 thinking 仍必须按用户选择生效，独立于任何自动检索偏好。

## 缓存标识

Responses 缓存标识取所有 provider payload hooks 完成后的最终出站 `prompt_cache_key`。Main 在有效非空 key 变化时写入原生分支；继承会话使用该记录，同时保留独立的原生 Session ID。重新打开 Main 时恢复分支记录。已中止或已退役的请求不能更新替代上下文。暂时缺少 key 不表示永久禁用缓存。

Main 观察器使用既有 ModelRuntime 桥，只观察所属会话请求 ID 对应的流量。摘要请求和其他会话不会记为 Main 请求。子会话继续使用自身的 payload 适配。

Chat Completions 缓存参数继续由 SDK 管理。上述工具兼容位不表示允许注入 `prompt_cache_key`、修改会话路由请求头或开启长时保留。SDK 的 `supportsLongCacheRetention`、`cacheControlFormat` 和会话亲和性兼容字段各有独立含义。Harness 不新增 Chat Completions 缓存 key 兼容字段，也不根据端点名称推断。

缓存标识一致、请求前缀稳定和实际观察到缓存命中是不同事实。压缩会主动重建前缀；实际复用仍取决于服务商路由、缓存策略和缓存寿命。

## 验证边界

离线测试捕获当前安装版本中 Responses、Anthropic、Azure Responses、Codex Responses 和 Chat Completions 原生序列化器的请求。验证范围包括前缀保留、标准 Chat Completions 字段、明确开启的工具追加、描述更新、真实 schema 替换、继承执行阻断、压缩淘汰，以及 managed effort、sign-in 抑制、disabled thinking 和各 API 的 effort 编码器边界。这些测试不能证明任意网关都实现可选格式，也不保证在线缓存命中。

服务商参考资料：[OpenAI 提示词缓存](https://developers.openai.com/api/docs/guides/prompt-caching)、[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)、[DeepSeek 上下文缓存](https://api-docs.deepseek.com/guides/kv_cache/)。
