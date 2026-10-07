# Codex／OpenAI 前缀缓存调查

调查日期：2026-10-07。只调查与离线请求截获，未使用用户凭据或真实模型额度，未修改保活实现。

## 结论

先维护可复用的请求前缀，再处理到期刷新。请求前缀变化造成的 miss，不能靠心跳解决。

必须区分 OpenAI API key 请求与 ChatGPT 登录请求。当前 Pi 的 provider 名称 `openai` 也不能单独证明使用 API key：其 Responses adapter 会检测凭据类型并省略登录端点不支持的参数。

不能直接把当前 Pi 的 `maxTokens: 1` 重放当成安全的 Codex 保活：Codex adapter 不发送输出限制，OpenAI adapter 在 ChatGPT 登录模式下也会省略输出限制。

## 官方规则：当前模型与旧模型不同

来源：[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)。以下是 API 文档，不能未经验证就承诺 ChatGPT 订阅端点支持所有相同参数或采用相同额度计费。

### GPT-5.6 及之后

- 默认隐式缓存；最低 1,024 可见输入 token。
- `prompt_cache_options.ttl` 当前仅支持 `"30m"`，也是默认值。
- 匹配前缀最近写入或复用后，至少 30 分钟内仍可复用；命中会刷新寿命，不再收取该前缀的写入费用。
- `prompt_cache_options.prewarm: true` 可以预热已知上下文，不生成输出。实际写入的 token 仍按 cache-write 计费。
- 允许显式断点；显式模式没有断点则不写缓存。隐式模式在符合条件的消息结尾设置断点，包括 user 和一组连续工具返回中的最后一条。
- cache write 为普通输入费率的 1.25 倍；多数模型 read 为 0.1 倍，当前 GPT-6.1 Sol 为 0.05 倍。
- `prompt_cache_key` 不再是优化路由的必要条件，但可以区分缓存核算组。组内仍应保持 key 稳定，不必为每个线程都创建新的核算组。

### 较早模型

- 最低缓存长度与断点间隔因模型和请求设置而异，不能统一套用新模型规则。
- `in_memory` 通常闲置 5–10 分钟，最多一小时。
- `24h` 通常约 30 分钟，最长可保留 24 小时，不等于保证存活 24 小时。
- `prompt_cache_key` 有助于缓存路由，但不保证固定落在某一机器。

## 什么会影响前缀

缓存的是服务端完整渲染后的上下文，不只是用户能看到的聊天文本。

需要稳定的内容包括：

- 模型；
- 工具名称、描述、schema、顺序和工具指令；
- developer／system 指令；
- 早期会话消息及工具结果；
- reasoning effort、verbosity、parallel_tool_calls 和输出格式等相关设置。

当前文档说明 GPT-6 可以通过追加 `configuration_update` 改变 reasoning effort，同时保持请求级 effort 不变，以保留此前前缀。不能据此假定当前 Pi 已使用该方式。

“保活”请求必须读取将来真正需要的同一长前缀。发送独立的 hello／noop 不能刷新另一份长会话的 KV 缓存。WebSocket ping 保持连接，也不等于刷新模型 KV 缓存。

## Codex 官方源码

固定版本：[client.rs，c9253c4](https://github.com/openai/codex/blob/c9253c4977e485d6a098282ad583a6db9585d7ff/codex-rs/core/src/client.rs)。该文件最新提交时间为 2026-10-05。

- 使用 session metadata／显式 override 构造 cache key；部分内部调用会按来源与 parent thread 分组，不是所有调用都简单使用新 thread ID。
- 源码明确指出 ChatGPT 从 Responses `session-id` header 派生 cache affinity。
- WebSocket prewarm 使用 `response.create` 和 `generate: false`，然后复用连接与 `previous_response_id`。
- 源码将这次 prewarm 定义为 connection setup，而非 inference request。不能把它直接等同于 API 的 `prompt_cache_options.prewarm`，更不能仅凭请求成功就证明长前缀 TTL 得到刷新。

不要为共享 cache key 随意把多个 Agent 的真实 Session ID 改成相同值；当前 Pi 的 Session ID 还参与连接与增量续接状态管理。

## 当前安装的 Pi 实现

检查范围：`node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js`、`dist/core/sdk.js`，以及 `@earendil-works/pi-ai/dist/api/openai*-responses.js`。

### 保活器

- 重放上次模型请求的 context／options，仅调整 `maxTokens: 1`、重试和取消信号。
- 刷新间隔是 TTL 的 90%，至少预留 10 秒；30 分钟 TTL 对应 27 分钟。
- 默认 streaming 模式在 Agent settle 后停止；idle 模式最多到最后真实请求开始后的 30 分钟；执行中最多一小时。保活成功不延长这些固定窗口。
- 需要模型 `promptCache.short/long` 元数据；所检查的内置 GPT-6.1 Sol 条目没有该字段，因此不应假定设置 idle 就一定有保活。
- 用目录美元费率估算收益，idle 续用概率固定 0.15，最低预期节省 0.05 美元。这不是订阅额度的精确模型。
- 记录成功保活的 usage，但没有专门根据“预期长前缀实际命中多少”判断这次刷新是否有效。

### 请求截获结果

使用假凭据，`onPayload` 截获后立即停止，禁止实际网络请求：

| 路径 | 输入选项 | 最终输出上限 |
| --- | --- | --- |
| `openai-codex-responses` | `maxTokens: 1` | 没有 `max_output_tokens` |
| `openai-responses`，API key 形式 | `maxTokens: 1` | `max_output_tokens: 16` |
| `openai-responses`，ChatGPT 登录形式 | `maxTokens: 1` | adapter 省略输出限制 |

这意味着 Codex 登录路径的原生重放可能继续推理／生成较长内容；虽然不会由 Agent loop 执行其工具调用，也不写入聊天历史，生成本身仍可能消耗额度。

## 工具变化：不能一概认为都会破坏缓存

当前 Pi 在兼容模型上支持会话中的增量工具声明。

离线核对 `resolveTranscriptTools`：

- 纯追加工具：保留初始顶层 tools，在后续消息中加入 `additional_tools`／工具加载记录，能保留早期前缀。
- 移除工具或修改同名工具定义：回退到当前完整 tools 列表，可能改变服务端靠前的前缀。

因此之前“加入 active 一定导致全量 cache miss”的说法不成立。不过 Codemode 已可间接调用的工具，没有必要为了执行而额外直接激活。

Capability 内部会话还会改变工具集合并固定 thinking low；它是否能复用主会话长前缀，必须比较实际 provider payload，不能只依据“继承历史、使用同一物理模型”推断。当前 SDK 会给其独立会话分配 Session ID，缓存核算／路由也应一并检查。

## 建议的最小策略

1. 固定 Main 的核心工具与 Codemode 声明；场景相关 preference、Skill 和背景放进 Capability 工具结果追加，不反复改写初始提示词。
2. 模型和请求级 reasoning 设置保持稳定；不要为便宜的保活临时改 low，否则可能换了前缀。
3. 对确认支持新缓存协议的 API key 路径，优先采用不生成输出的 `prewarm`，读取同一请求前缀与匹配设置；30 分钟 TTL 可在约 25–27 分钟刷新。
4. 真实请求命中即刷新寿命，不需要同时发送保活。不要为空闲的所有子 Agent 各启动无限刷新。
5. 对 ChatGPT 登录路径，先验证其支持的无生成请求是否真的刷新 KV 缓存及如何报告 usage；在此之前不直接开启当前 one-token 重放策略。
6. 记录实际输入、cached、cache-write、输出／reasoning token、请求前缀摘要与刷新时间。区分到期 miss 与请求结构变化的 miss；前缀不匹配时不要靠提高保活频率补救。
7. 设定有限的工作时段；暂停长期使用、会话切换、压缩或退出时停止，不做全天后台保活。

推荐先验证一条主会话的刷新与后续真实命中，再决定是否调整原生保活器。当前调查没有启用保活、修改配置或产生真实模型请求。
