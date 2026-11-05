# Capability enable: request cache boundary

审查材料，描述 `/capability enable` 重写后请求前缀的实际行为、代码级证据、按兼容位划分的分支，以及尚未决定与尚未实测的部分。这里没有真实 provider 的缓存计费数据。当前有效契约以 [interface-contract](../interface-contract.md) 与 [capability-prompt-memory](../capability-prompt-memory.md) 为准。

## 问题

旧实现在用户启用工具后把 `manual` 记录并入请求投影。该记录没有工具调用锚点，于是被合并进头部系统提示词：

```
output[0] = { ...messages[0], sections: { ...messages[0].sections, capabilities: render(baseline) } }
```

这**改写了已有的头部系统消息**：请求的第一条消息内容变了，而不是在末尾追加。头部是 provider 缓存前缀的起点，因此这种改动至少会让旧前缀不再逐字节相同。旧实现的验收只检查了中间投影函数的输出形状，没有检查供应商收到的序列化请求，因此没有暴露这一点。

## 实际请求管线（Pi 1.5.0）

按调用顺序追踪 `@earendil-works/pi-coding-agent@1.5.0` 与 `@earendil-works/pi-ai@1.5.0`：

1. `setActiveToolsByName(names)` → `_setActiveTools` → `_applyToolLoadout`
   - 已激活工具保持原有顺序，新激活工具追加（`dist/core/agent-session.js`，`[...kept, ...requested]`）。
   - 随后 `_rebuildSystemPrompt(names)` 只重建 `_baseSystemPromptOptions`，不写任何 transcript。
2. `_prepareRun` → `before_agent_start` → `_preparePromptAndToolLoadout`
   - `options.selectedTools = _applyToolLoadout(...)`：loadout 是权威。
   - `diffSystemPromptSections(getCurrentSystemMessage(messages).sections, buildSystemPromptSections(options))`：只有**变化的段落**成为补丁。
   - 补丁是一条**新的** system 消息，`messages.unshift(updateMessage)` 只插在该轮新增消息的最前面，即追加在已有历史之后。
3. `agent-loop` 的 `declareToolChanges`
   - 工具差异写成 `toolsAdded`／`toolsRemoved`，放在**插入到第一个非 system pending 消息之前的新 system 消息**上，同样不修改头部。
4. `streamAssistantResponse` → `convertToLlm` → `normalizeContext` → `streamFunction(model, llmContext, ...)`
5. 各 API 适配器先调用 `resolveTranscript(context, compat.supportsMidConvoSystemMessages)`：
   - `true`：后续 system 消息原地保留，头部不变。
   - `false`：`collapseSystemMessages` 把全部 system 消息重放成**一个**头部，于是任何后续段落补丁都会改变头部文本。

结论：**transcript 层永远是追加**（1–3 步都不改头部）。头部是否被改写只取决于第 5 步的 `supportsMidConvoSystemMessages`。

## 已实现的行为

用户启用工具不再产生任何请求记忆：

- `manual` 记录只作为分支授权（`discovery-record.ts`），不进入 `capabilityPromptTranscript`。投影只渲染发现结果的 `tools`／`mcp`／`skills`／`guidance`。
- 被授权工具的接口由原生工具声明提供，投影再写一次只会重复描述并改写头部。
- 启用路径因此只有两种请求差异：工具声明追加；若该工具声明了 `promptSnippet`／`promptGuidelines`，Pi 自己修补 `<tools>`／`<rules>` 段落。

## 声明放置与提示词段落的分支

两个独立的兼容位决定两件事，必须分开看：

**A. 工具声明放在哪里**（`resolveTranscriptTools` 与各适配器）：

| 兼容位（`compat`） | 自带 1.5.0 数据中的条目数 | 声明放置 |
| --- | --- | --- |
| `supportsMidConvoToolChanges: true`（`anthropic-messages`） | 7 | 后续工具以原地 `tool_definition` 块声明，顶层工具字段保持初始集合 |
| `supportsAdditionalTools` 或 `supportsToolSearch`（`openai-responses` 25、`openai-codex-responses` 8） | 33 | `resolveTranscriptTools` 的 `additions`／`changes`：追加在原地 |
| `supportsMidConvoToolAdditions: true`（`openai-completions`） | 17 | 追加在原地 |
| 以上皆无 | 其余条目 | 顶层工具字段就是当前工具集，每次变化重写该字段 |

`src/responses-tool-prefix.ts` 的 `supportsAdditiveResponses` 只覆盖第二行的一部分（`openai-responses`／`openai-codex-responses`／`azure-openai-responses` 且 `supportsMidConvoSystemMessages === true` 且声明了 `supportsAdditionalTools` 或 `supportsToolSearch`），把权限变化留在原位。

**B. 中途 system 段落是否原地保留**（`resolveTranscript`）：

| `supportsMidConvoSystemMessages` | 自带 1.5.0 数据中的条目数 | 效果 |
| --- | --- | --- |
| `true` | 101 | 段落补丁作为后续 system 消息保留，头部文本不变 |
| 未声明（按 `false` 处理） | 其余条目 | `collapseSystemMessages` 把全部 system 消息重放成一个头部，头部文本随补丁变化 |

两者组合出四种情况，本仓库对每一种都只做同一件事（不写请求记忆）：

| A（声明） | B（段落） | 启用后请求的差异 |
| --- | --- | --- |
| 原地追加 | 原地保留 | 只在末尾新增声明块；头部与前缀不变 |
| 原地追加 | 折叠 | 头部文本变化（Pi 的 `<tools>`／`<rules>` 补丁被重放） |
| 顶层字段 | 原地保留 | 顶层工具字段变化；消息与头部不变 |
| 顶层字段 | 折叠 | 顶层工具字段与头部文本都变化 |

**关于缓存代价**：本文不据此推断哪一档「整段失效」或「没有额外成本」。JSON 字段顺序不能证明 provider 的 token 与缓存前缀布局，Anthropic 的内联工具声明与缓存层级、Responses 的 `additional_tools` 都可能有各自行为。真实影响必须用具体 provider／model／API 的 `cacheRead`／`cacheWrite` 实测，本文没有这类数据。

## 实际链路（Magpie 网关，Codex 上游）

本机实际调用不经过 stock 模型表，而是经 `@x-magpie/pi` 网关插件转给 Codex。链路维护方查到的插件事实：0.5.0 的 `mapping.ts` 不传 `compat`，模型条目 `magpie/gpt-6.1-sol` 的 `api` 是 `openai-responses` 且没有 `compat`。本文没有在本仓库复现该插件，以下按代码推导该配置走哪条分支：

- `getResponsesToolSupport({})` 在 `supportsMidConvoSystemMessages` 与 `supportsToolSearch` 都缺失时返回 `"none"`（`dist/api/openai-responses-shared.js`），于是 `resolveTranscriptTools` 的顶层工具字段就是当前工具集。
- `resolveTranscript(context, undefined)` 与 `convertResponsesMessages` 都按 `supportsMidConvoSystemMessages` 缺失处理，走 `collapseSystemMessages`，头部由全部 system 消息重放。
- `supportsAdditiveResponses` 为 false，`additiveToolTranscript` 不生效；同一判断也让 Capability 内部检索固定使用 `low`。

即：在这条链路上，一次启用会让**同一个请求**的顶层工具字段与头部文本同时变化，两者无法从一次观测里分开。

链路维护方提供的实测日志（同一 session）：

| 阶段 | thinking | cacheRead |
| --- | --- | --- |
| 内部检索首次 | low | 0 |
| 内部检索随后 | low | 209408 |
| 外部 Capability 之后第一个请求 | medium | 210816 |
| 再下一个请求 | medium | 0 |
| 再下一个请求 | medium | 211072 |

**能得出的结论**：该 session 里出现了一次 `cacheRead=0` 的请求，随后回到约 211k，即一次启用带来**一次**失效事件，不是持续失效。

**不能得出的结论**：日志只有一个结果，无法区分这次失效来自「顶层工具字段变化」还是「头部文本变化」，也不能证明其中任一者没有独立成本。本文不据此断言二者中任何一方的代价。

**分离两者的最小对照**：在同一链路上启用一个没有 `promptSnippet`／`promptGuidelines` 的工具（MCP 工具或 `deferred` exposure 的扩展工具）。该场景只改顶层工具字段、头部文本逐字节不变（本文证据段已证明）。若其 `cacheRead` 行为与带 snippet 的工具一致，则失效由工具字段决定，头部改动没有独立成本；若不一致，则头部改动确实独立计价，此时再采用选项 1 并复测。

## 证据

`test/typed/capability-provider-prefix.test.ts`，真实 `createAgentSession` + 真实扩展 + 真实命令 + 离线脚本模型：

- 请求层：启用前的请求消息序列是启用后请求的逐字节前缀；头部 system 消息 deep-equal；工具集恰为「原集合 + 新工具」且顺序保持。
- 供应商转换层（`resolveTranscript`，各 API 适配器的第一个调用）：`mid-convo = true` 时头部与整段前缀逐字节相同；`mid-convo = false` 时对无 snippet 工具头部不变。
- 投影贡献：`wire(projected(...), mode)` 与 `wire(raw, mode)` 在两种模式下都 deep-equal，说明投影对请求的贡献为零。
- 已测量限制：带 `promptSnippet`／`promptGuidelines` 的工具在 `mid-convo = false` 下，折叠头部只有 `tools` 与 `rules` 两个段落变化，且同一断言证明投影不是变化来源。
- 幂等：重复启用不追加消息、不新增记录。

`test/typed/capability-mcp-reconnect.test.ts` 与 `test/typed/cross-session-reply-activation.test.ts` 覆盖非缓存部分（实时注册表、收信激活）。

## 剩余头部重写的定位与修复选项

**触发链**（`pi-coding-agent` 1.5.0）：`_rebuildSystemPrompt` 收集所有已注册工具的 `promptSnippet`／`promptGuidelines` → `buildSystemPromptSections` 只把 `selectedTools` 中带 snippet 的工具列进 `<tools>`，把其 guidelines 列进 `<rules>` → 工具激活后 `diffSystemPromptSections` 产生 `tools`／`rules` 补丁（一条新的 system 消息，追加在已有历史之后）→ `resolveTranscript` 在 `supportsMidConvoSystemMessages !== true` 时把这条补丁重放进头部。

只有同时声明了 `promptSnippet`／`promptGuidelines` 的工具会进入这两个段落。本仓库内 `defaultActive: false` 且带这两个字段的工具：

| 工具 | 位置 | 何时中途激活 |
| --- | --- | --- |
| `subagent_create`、`subagent_list`、`subagent_stop` | `src/subagent/surface.ts` | Capability 发现选中 Subagent 命名空间时 |
| `msg_write` | `src/subagent/message-write.ts` | Capability 发现选中，或收到跨 session 消息时 |

`capability`（`extensions/capability.ts`）也带 snippet，但注册即激活，属于首个请求的初始 loadout。`codemode`、MCP 工具与 `read_mcp_resource` 没有 `promptSnippet`／`promptGuidelines`，激活不产生段落补丁。

**修复选项**（均不改 `node_modules`，也不写死模型 `compat`）：

1. **把动态工具的指引放进声明**（不丢指引）：让可能中途激活的工具不再声明 `promptSnippet`／`promptGuidelines`，把同一段文字并入 `description`。声明在该次请求本就是新增，`<tools>`／`<rules>` 永远不因它变化，头部对所有传输稳定。代价：该工具不再出现在 `<tools>` 一行摘要与 `<rules>` 中，指引改由声明承载。影响 `subagent_create`／`list`／`stop` 与 `msg_write`，即所有 Subagent 提示词，属提示词契约变更。
2. **冻结段落**（机制已验证，但丢指引）：在 `before_agent_start` 中对「首个请求之后才激活」的工具删除 `toolSnippets`／`toolGuidelines` 条目，且只在 `compat.supportsMidConvoSystemMessages !== true` 时执行。`emitBeforeAgentStart` 通过 `normalizeBuildSystemPromptOptions` 克隆选项，因此这是每次请求的局部改动，不污染 `_baseSystemPromptOptions`，可重复执行。`test/typed/capability-provider-prefix.test.ts` 的第三个用例证明冻结后 `changedSections` 为空、工具声明仍追加、折叠头部逐字节不变；但它按设计丢掉该工具的 `<tools>` 行与 `<rules>` 指引。
3. **上游最小改动**（需 SDK 维护者，不由本仓库实施）：让 `collapseSystemMessages` 在传输不支持中途 system 消息时，把 `sections` 补丁渲染成追加的普通消息而不是重放头部；或让 `<tools>`／`<rules>` 段落不随 loadout 变化。

**当前状态**：实现保持「不写请求记忆」，头部重写只可能来自上表这两个工具；本仓库尚未实施选项 1 或 2，等待决策，因此不声明该场景已修复，也不声明头部重写对缓存的影响已量化。选项 1 已在工作区之外的独立探针上验证过一次（改动 `msg_write` 的 description 后，启用前后的 system 文本在 `resolveTranscript` 的两种模式下都逐字节相同，原始指引完整位于新声明中）；该探针不在本仓库，落地时需要在此仓库补上对应回归。

## 未测

- 真实供应商的 `cacheRead`／`cacheWrite` 数值。本仓库没有做过在线缓存测量；本文的请求结论都来自序列化请求比较，不是计费数据。上文「实际链路」的数字由链路维护方提供，本仓库未复现该插件，也未在本文所述对照上取值。
- 「分离两者的最小对照」尚未执行。
- Windows 命名管道下的跨 session 收信路径。

## 被取代的中间方案

删除实现阶段曾尝试用分支条目时间戳给 `manual` 记录定位锚点，让补丁追加在启用点之后而不是并入头部。该方案在只接受单一系统提示的传输上仍会被 `collapseSystemMessages` 折叠进头部，因此没有解决根因；同时它把展示位置与授权语义绑在一起。当前实现删除了时间戳解析（`StoredDiscovery.timestamp`），因为 `manual` 记录不再参与投影，时间戳没有消费者。
