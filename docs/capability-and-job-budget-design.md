# Capability、协议读写与 Job Budget

## 状态

本文是当前契约。v2 草稿新增的内部检索 Agent、来源选择、匹配层次与两个命中状态已整合于此；旧的公开 `request` 参数和“不启动内部 Agent”描述不再适用。

已实现无参 Capability（调用阻塞等待内部检索 Agent）、本地三路检索、npm 元数据检索、协议读写、按深度 Job Budget，以及 Subagent 的 Jev 路由、同 ID continuation、直接子级广播、类型化完成通知和原生会话恢复，见 [Subagent 契约](subagent-contract.md)。Subagent 的 blocking／`waiting` 与同步等待暂缓；安装审批控制面不在本轮。

## 边界

- 主 Agent 只调用 `capability({})`，不传需求、查询、角色、模型、thinking、来源或 Budget；调用阻塞，返回前内部检索已经结束。
- 内部检索 Agent 继承调用方的原生会话：原始 SessionManager 条目、系统提示词与当前模型，而不是压平后的文本投影。继承的对话是资料，不是发给内部 Agent 的系统指令。
- 内部 Agent 运行在调用方解析出的同一物理模型上，兼容增量工具和中途 system 消息的 Responses 模型沿用父 thinking，其它模型用 low；调用方选择虚拟模型时复用产生该 `capability` 调用的物理模型身份，无法证明身份就显式失败，不重路由。
- Skill 发现通过 Pi 原生包管理器只读解析已配置、已安装资源（缺失包 skip），再读取原生前言；不依赖当前会话加载或提示词曝光，getCommands() 仅补充 CLI／扩展路径。遵守 manifest、过滤及项目信任，不安装、更新或执行扩展。
- 内部 Agent 只有 `capability_search` 与 `submit_result` 可执行。兼容 Responses 保留父工具声明为阻断占位工具（无父执行句柄），其它模型只声明两个工具；均不能执行 Shell、文件写入或其它 Tool／MCP。
- Capability 只检索并返回校验过的真实候选，不执行、下载、安装、启用或连接任何能力；宿主仅把选中的、已经注册且可见的工具用原生 active-tool API 声明为 active，这不是安装、注册或连接代码。Tool／MCP 调用继续走原有入口。
- 内部会话使用内存 SettingsManager，并清空 packages／extensions／skills／prompts／themes 的来源列表：运行中不触发任何包安装，也不可能把偏好写回调用方或用户的设置文件。
- `write` 的协议写入本轮只用于 Agent 通信，不是通用工具调用入口。
- Job Budget 是宿主策略，不进入模型可调参数；`work` 仍独立于 Subagent，Job 完成不隐式启动 Main。

# Capability

## 公开接口与内部执行

```js
capability({})

const capabilityParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
```

工具协议保留空对象外壳，语义上无参数。旧的 `{request: "..."}` 被拒绝，不保留兼容执行路径。

```text
capability({})
  → 调用方原生会话条目 + 系统提示词 + 当前模型（同一物理模型，兼容 Responses 保留父 thinking，其它用 low）
  → 隔离的内部 Pi AgentSession（仅两个固定工具可执行）
  → capability_search(query, src)，按结果继续检索
  → submit_result(refs)
  → 宿主校验、激活选中工具并返回真实候选元数据
```

内部会话只允许两个工具执行；兼容 Responses 可保留父声明，但其执行器一律拒绝调用，不携带父工具句柄。不将两个内部工具注册到父会话，也不通过公开 `task` 递归创建自身：

```js
capability_search({ query: "Firefox 已有登录态", src: "local" })
submit_result({ refs: ["skill://firefox-existing-profile"] })
```

`capability_search` 只有两个必填字段：非空 `query: string` 与 `src: "local" | "remote" | "all"`，拒绝额外字段。`query` 可以是关键词或先前结果的精确 Ref。`submit_result` 只接受 `refs: string[]`；宿主拒绝本次搜索没有返回过的 Ref。至少完成一次检索才允许提交空数组；查询失败不能伪装为正常无命中。

内部会话的系统提示词是调用方的系统提示词加上固定的检索规则；调用方没有可继承提示词时只用检索规则。继承用原生条目重建会话，保留 provider 返回的 thinking 与签名、已完成的 tool call／tool result，不压平为文本；仅移除尚未完成的父调用，避免子会话带入悬空调用。这里保留的是会话里真实存在的原生块，不是 provider 隐藏、无法读取的推理。调用方在 `capability` 工具调用处阻塞，直到内部执行结束。同一物理模型是 Capability 的专门决定，不扩展到仍未实现的自动角色／模型路由设计（见 [Subagent 契约](subagent-contract.md)）。

成功提交立即结束内部执行，不额外增加一次收尾规划调用。未提交、模型错误、取消与预算耗尽均显式失败，不回退到另一种搜索或模型，内部 Session 始终释放。

## 来源与匹配

| `src` | 行为 |
|---|---|
| `local` | Tool、MCP、Skill 固定三路并发，只读注册信息和 Skill 文件 |
| `remote` | 只查未安装的 npm `pi-package` 包元数据 |
| `all` | 本地三路与远程分支并发；结果结构中本地在前，远程在后 |

没有隐含“本地无命中才联网”策略；需要时先查 `local` 再查 `remote`。不提供类别、数量、匹配模式、激活或安装开关；激活是返回后的宿主行为，不是调用参数。

远程来源目前限于 npm `pi-package` 生态，不宣称覆盖所有 MCP／Skill 市场。过滤已安装包；未安装候选表示向用户提出安装请求，不表示已获批准。远程分支有 10 秒超时并支持取消；失败时 `all` 降为 `partial`，`remote` 单独失败为 `failed`，不会取消本地分支。只有明确的不存在响应可表示无命中，网络／权限／服务器错误不能表示成“市场里没有”。

搜索返回精确版本、说明、来源与可用发布信息；读取 npm Ref 再取得 manifest、tarball URL、integrity 和依赖概览。只读取元数据，不下载归档或执行安装脚本。

匹配采用确定性层次，不增加排序模型：

1. Ref 精确解析，或工具、服务器、Skill、包名的标识符匹配。
2. 拉丁词与中文 bigram 的字段加权重叠、token 前缀匹配。
3. 所有本地组均无主要命中时，才做单字符编辑距离 fuzzy 兜底；远程只在自身无主要命中时兜底。

内部检索以 `match` 标记精度；主要匹配优先，再按分数与 Ref 稳定排序。`match`／`score`／`reason` 和诊断 `warnings` 由宿主生成，只保留在内部检索与 details，不交给 Main 的 capability 工具正文；检索 Agent 仅提交 refs，不填写这些字段。固定上限为 Tool 8、MCP 8、Skill 6、远程包 5；Skill 候选正文读取数最多 6。正文、Caveat 与 warning 另有固定长度／数量上限，调用方不可覆盖。

## 本地资源与返回值

Tool 搜索读取名称、description、参数说明和来源，不依赖执行 handle。`hidden` 工具和 `disableModelInvocation` Skill 不进入模型搜索或协议读取。

MCP 保留服务器级和工具级身份，优先使用明确 provenance，缺失时使用 Pi 的 namespace／桥接名称。无法解析时给 warning，不编造服务器名；注册信息不是连接健康检查，不输出推断的 `connectionState`。

Skill 先按名称与 description 召回，再读取候选正文。精确 Ref 可读正文；不可读会显式报错或保留候选并给 warning，不以空正文冒充成功。Skill 的 `bindsTo`／`caveats` 可引用真实命中并提供约束，但不是执行授权，也不能替代完整 Skill。旧的自动生成 `executionPlan` 已移除。

```ts
type CapabilityHit = {
  ref: string;
  name: string;
  description: string;
  kind: "tool" | "mcp" | "skill" | "package";
  status: "available" | "needs_approval";
  // 各类真实元数据，如参数、来源、版本、Skill 约束。
};
type CapabilityResult = {
  status: "ok" | "partial" | "failed";
  tools: CapabilityHit[];
  mcp: CapabilityHit[];
  skills: CapabilityHit[];
  remote: CapabilityHit[];
  missingCapabilities: string[];
};
```

上面是 Main 可见结果；宿主的 broker 结果与 details 另保留匹配诊断和 warnings。空 bindsTo／caveats 省略，非空关联和约束作为指导保留，不代表权限。

命中只有本地 `available` 和未安装包 `needs_approval` 两种状态。`available` 表示本地已注册、可发现；必要的真实注册信息可通过 `read` 查询。返回成功后，宿主把选中的、已注册且非 hidden 的工具（含 MCP 工具）用 Pi 原生 active-tool API 声明为 active，并保留原有 active 集合；hidden 工具与失去注册的工具带 warning 跳过，服务器级 `mcp://` Ref 不对应单个工具，不做激活。这是工具激活，不是安装、启用或连接：不下载、不注册、不启动任何代码，也不代表 MCP 服务器在线。最终返回内部 Agent 选择且宿主确认存在的候选；status／missingCapabilities 保留可见状态，搜索降级与错误诊断留在 details。

# 协议读写

普通路径继续使用 Pi 原生文件工具。只有显式 `<scheme>://` 前缀进入协议路由器；`file:` 单冒号形式（例如 `file:notes`）是普通文件路径，不是 URL 简写。显式 `file://` URL 折算为它指名的路径，和裸路径走同一个原生 read／write 定义。

| 地址 | `read` | `write` |
|---|---|---|
| `tool://<name>` | 工具元数据与参数 | 拒绝 |
| `mcp://<server>[/<tool>]` | MCP 元数据 | 拒绝 |
| `skill://<name>` | Skill 正文 | 拒绝 |
| `npm://<package>@<version>` | 精确包元数据 | 拒绝 |
| `agent://` | 会话内 Agent 名册 | 拒绝 |
| `agent://<id>` | 不被后续回复覆盖的初始结果 | 发送纯文本消息 |
| `history://<id>` | 锚定原生条目的各 Job 历史 | 拒绝 |
| `agent://Main` | 不作为 Subagent 结果地址 | 向 Main 发消息 |
| `agent://all` | 拒绝：广播地址只写 | 只向发送者的直接子 Agent 广播；`all` 不是合法 Actor ID |

名称段按需 percent encoding，例如 scoped npm 包名中的 `/`。未注册 scheme 的读取与任何非 `agent://` 的协议写入都在触碰文件系统前显式失败；畸形 `://` 前缀同样拒绝，不回退成磁盘路径。旧的 `tool:name`、`mcp:server/tool`、`skill:name` 不是新接口的别名。

```js
read({ path: "tool://read" })
read({ path: "skill://firefox-existing-profile", offset: 1, limit: 200 })
read({ path: "file:///abs/path/notes.md" })
write({ path: "agent://agent_7f3c21e4-01", content: "请检查实际调用路径并回复发现。" })
write({ path: "agent://Main", content: "核验已完成，结果见我的任务产物。" })
```

协议资源以文本读取，沿用原生 `offset`／`limit` 与输出截断；普通图片仍走原生文件读取（含 auto-resize 设置），cwd、审批与 abort signal 保持原生语义。路由按会话隔离，`/reload` 后重新注册。

`write agent://<id>` 的发送者由宿主按会话表面绑定，不从正文解析；写入返回最小结果 `{ ok, to, jobId }`，含义是消息已进入投递路径（运行中的 Job 接过、排队 Job 启动时接收，或 idle Agent 被唤醒为新 Job），不等待模型回复，也没有 message id、送达状态、handover 或收件箱记录。若原生运行恰好在投递中结束，运行时只对后继状态做一次新判定：Agent 已 idle 就以新 Job 承接，否则返回 `agent_busy`。`stopping`（取消或预算终止后等待原生运行退出）直接拒绝新写入；失败或取消不自动重试，初始结果不变。详细拓扑与状态见 [Subagent 契约](subagent-contract.md)。

完成通知复用 Agent 消息通道，内部类型为 `completion`（普通显式消息为 `message`），原生 custom message 类型为 `agent-completion`；通知不自动启动空闲 Main 或父 Agent。`write agent://all` 对直接子级做一次普通消息扇出，返回逐收件人的成功／错误，不向孙级递归，也没有回执或重试服务。

## Pi 0.99 兼容边界

- Skill 枚举使用 `loadSkills`，不再导入已移除的 `discoverSkills`。
- `read`／`write` 以同名原生工具覆盖与会话 EventBus 组合：保留原生 schema、分页、图片读取、审批、cwd 与 abort 语义，只在描述里追加 URI 支持；裸路径与显式 `file://` URL 继续走原生定义，协议分支只在注册 scheme 上生效。
- 预算在共享的 `agent.streamFunction` 边界预扣：普通对话请求、Compact 摘要请求与 Harness 层的摘要重试各计一次；`agent.prepareRequest` 仍被串接以保留请求投影、鉴权与虚拟模型路由，只负责一次性 Soft 提示，不重复计费。
- Fresh 自动路由的两次 Jev `classify()` 请求各在调用前扣一次同 Job 的 Model Call；不经过聊天 stream，不重复扣数。Capability 不经过 Jev，仍为同一物理模型＋low。
- 内部会话复用父 ModelRuntime。Pi 0.99 无公开 getter，适配层检查 `ctx.modelRegistry.runtime`；不满足时显式报错，不静默新建丢失自定义 Provider／运行时凭据的 Runtime。升级 Pi 时需重新验证此兼容边界。
- Capability 与 Subagent 都用 `captureInheritedContext` 从原始 SessionManager 条目重建继承上下文：复制 header 并换新 Session ID，保留原生分支，去掉尾部未完成的 tool call，并把因此被丢弃的空消息的后续条目重新链接。Capability 内部会话另有内存 SettingsManager 与全禁用的 loader。


# Job Budget

## 原则

Budget 绑定到一个 `jobId` 的完整执行生命周期，而不是绑定单次模型响应。

- Tool 调用后再次请求模型，继续累计同一份 Budget；
- Provider/Harness 重试不回滚已经发生的计费；
- 模型返回最终结果后 Job 进入终态，Budget 结算并冻结；
- 同一 `jobId` 不允许通过再次 prompt 静默获得新 Budget；
- 后续继续同一个 Agent 必须创建新 `jobId`，并记录 `continuedFromJobId`。

Budget 是 Harness 的内部调度策略：不进入 `task` Schema，不从任务文本推断，也不能由模型设置。

## 资源维度

```ts
type BudgetLimit = {
  soft: number;
  hard: number;
};

type JobBudgetProfile = {
  modelCalls: BudgetLimit;
  activeTimeMs: BudgetLimit;
  lifetimeMs: number;
};
```

### Model Calls

每次会话向模型 Provider 发起请求都在共享的 `agent.streamFunction` 边界原子预扣一次 `modelCalls`；普通对话调用、Compact 摘要请求与 Harness 层的摘要重试走同一个边界：

- Provider 返回错误也计一次；
- Provider 在一次请求内部的透明网络重试不重复计数；Harness 让请求再次跨过该边界则计新的一次；
- Tool 结果返回后再次请求模型也计一次；
- 自动／手动 Compact 的摘要请求以及它的重试各计一次，没有绕过预算的摘要路径。

允许使用 `1..hard` 的额度。请求前原子预扣；预扣结果大于 `hard` 时拒绝。第 `hard` 次 Model Call 与之前的调用完全相同：如果响应包含 Tool Call，工具照常执行；工具结束后若 Agent 需要第 `hard + 1` 次 Model Call 来消费结果，该请求在预扣阶段被拒绝，Job 以 `budget_exceeded` 失败。运行时不把最后一次调用特殊化。

### 不限制 Tool Calls

Tool Call 不作为 Budget 维度。不同工具的单次调用工作量没有可比性：一次批量读取可能处理很多文件却只产生一个 Tool Call，一次轻量状态查询也同样计一个。限制 Tool Call 数既不能稳定代表费用，也不能稳定代表副作用或工作量。

Model Call 限制已经约束模型能够发起工具批次的循环次数。具体工具的参数规模、副作用和并发应由该工具自己的 Schema、权限和运行时策略控制，而不是由统一 Tool Call 计数处理。

### Active Time

使用 monotonic clock 统计 Job 处于 `running` 的时间，包括模型请求、工具执行和 Harness 处理。

以下时间不计入：

- 未来显式支持的 `waiting`。

`parked`（目标设计的 Agent 状态，当前未实现）不是 Job 状态；Agent parked 前，其 Job 已经进入终态，Budget 也已经冻结。

`lifetimeMs` 从 Job 创建时开始按 monotonic clock 计算，是独立的绝对资源租约。它没有 soft 阶段；到期后立即 abort 当前执行或等待，将 Job 标记为 `failed`，使用 `termination: "lifetime_expired"` 和 `error.code: "job_expired"`。它用于约束 Job 从注册到执行结束的总寿命，不等于工作预算；当前不设置任务队列或 waiting 状态。

### Token 与费用

V1 记录 Provider 返回的 input/output/cache token 和可用费用信息，但不作为跨 Provider 硬限制。不同 Provider 的 usage、缓存计费和本地模型费用语义不一致，不能用不可靠估算终止 Job。

## 阶段

Budget Phase 只能单向升级：

```text
normal → warning → exhausted
```

```text
phaseForModelCalls(value):
  value < soft          → normal
  soft <= value <= hard → warning

phaseForActiveTime(value):
  value < soft        → normal
  soft <= value < hard → warning
  hard <= value       → exhausted

if lifetimeExpired or rejectedProjectedModelCalls > hard:
  phase = exhausted
else:
  phase = max(
    phaseForModelCalls(modelCalls),
    phaseForActiveTime(activeTimeMs)
  )
```

Phase 只能单向升级；一旦进入 exhausted 就不可回退。`rejectedProjectedModelCalls` 记录被拒绝请求的预计序号，不修改已经实际发生的 `modelCalls`。

计数不会因为一次模型请求结束、一次 Tool Call 完成或 Agent 暂停而重置。

## Soft：Warning

任一维度达到 soft：

- 不终止模型；
- 不禁止正常工具或创建允许深度内的子 Agent；
- 只注入一次控制消息；
- 要求完成当前工作线、停止无关探索并准备返回结果。

```text
Execution resources are becoming limited. Finish the current line of work,
avoid opening unrelated branches, verify the result, and return a final answer.
```

具体数值不需要告诉子模型。Soft 之后的所有 Model Call 继续正常计数，直到模型主动返回最终结果或达到 hard。

## Hard：Exhausted

出现以下任一情况时进入 exhausted：

- 下一次 Model Call 的原子预扣会超过 hard；
- Active Time 达到 hard；
- `lifetimeMs` 到期。

进入 exhausted 后：

- 不再发起模型请求或执行尚未开始的 Tool Call；
- 对正在运行且支持取消的工具发送 abort signal；
- 调用 `session.abort()`；
- 保存 partial history 和已知 partial result；
- Job 以 `budget_exceeded` 结束；`lifetimeMs` 到期例外使用 `job_expired`。

```json
{
  "status": "failed",
  "termination": "budget_exhausted",
  "truncated": true,
  "error": {
    "code": "budget_exceeded",
    "detail": {
      "dimension": "model_calls",
      "soft": 160,
      "hard": 200,
      "observed": 200,
      "rejectedProjected": 201
    }
  }
}
```

运行中的 Job 在取消、预算终止或 lifetime 到期后先进入 `stopping`：原生运行已收到停止请求（abort 工具与 `session.abort()`），但仍在退出；Job 保持并发与拓扑槽位，拒绝新写入（`agent_busy`），直到原生运行退出才发布唯一的终态 payload，避免未退出的会话与后继 Job 重叠，也避免读者看到之后还会变化的 payload。

## 结果语义

模型在任意一次允许的 Model Call 中返回最终文本：

```json
{
  "status": "completed",
  "termination": "model_final",
  "truncated": false
}
```

模型没有在额度内返回最终文本，或者时间限制终止执行：

```json
{
  "status": "failed",
  "termination": "budget_exhausted",
  "truncated": true,
  "error": {
    "code": "budget_exceeded"
  }
}
```

运行时不追加额外的收尾模型调用。失败就是失败；调用方可以读取 partial result 和 `history://`，再决定是否创建新的 continuation Job。

## 按嵌套深度选择 Profile

普通 `task` 无法预知任务是编码、Review、研究还是简单查询，因此第一层 Subagent 使用很高的安全天花板，只防止失控。第二层 Subsubagent 使用独立但仍足够宽裕的 Profile。Profile 只由 Harness 根据 Agent 深度选择，不分析任务文本、角色、模型或 thinking 档位。

| 维度 | 第一层 Soft | 第一层 Hard | 第二层 Soft | 第二层 Hard |
|---|---:|---:|---:|---:|
| Model Calls | 160 | 200 | 48 | 64 |
| Active Time | 90 分钟 | 120 分钟 | 45 分钟 | 60 分钟 |
| 绝对生命周期 | — | 24 小时 | — | 12 小时 |

```js
const JOB_BUDGET_BY_DEPTH = Object.freeze({
  1: {
    modelCalls: { soft: 160, hard: 200 },
    activeTimeMs: {
      soft: 90 * 60_000,
      hard: 120 * 60_000,
    },
    lifetimeMs: 24 * 60 * 60_000,
  },
  2: {
    modelCalls: { soft: 48, hard: 64 },
    activeTimeMs: {
      soft: 45 * 60_000,
      hard: 60 * 60_000,
    },
    lifetimeMs: 12 * 60 * 60_000,
  },
});
```

## Capability 内部执行

内部 Capability Agent 使用独立 Profile，不复用调用方 Job 的账本：Model Calls soft/hard 为 6/8，Active Time 为 60/120 秒，绝对 lifetime 为 300 秒；计数同样在共享 provider stream 边界进行。检索候选数和正文长度另受 `CAPABILITY_LIMITS` 限制。调用方阻塞等待这一步；成功提交即终止，错误、取消和预算耗尽不追加收尾调用或回退搜索。所有数值由 Harness 固定，不进入公开 Schema。

## 固定派生深度与并发宽度

Subagent 派生拓扑固定为两层，不维护跨整棵树的 model/tool 聚合额度：

```text
Main Agent（depth 0）
  └─ 最多 4 个 Subagent（depth 1）
       └─ 每个最多 4 个 Subsubagent（depth 2）
            └─ 禁止继续创建
```

因此一个根会话最多同时存在：

```text
1 + 4 + 4 × 4 = 21 agents
```

约束定义：

- `depth 0` 的主 Agent 可以创建 `depth 1` Agent；
- 每个 `depth 0` Agent 最多有 4 个活跃直接子 Agent；
- `depth 1` Agent 可以创建 `depth 2` Agent；
- 每个 `depth 1` Agent 最多有 4 个活跃直接子 Agent；
- `depth 2` Agent 不注册 `task` 创建入口，不能继续派生；
- 限制按父 Agent 的活跃直接子节点计算，不是生命周期累计创建数；
- `running`、`stopping` 和 `finalizing` 都占用一个活跃子节点名额；
- `completed`、`failed`、`cancelled` 不占用名额；
- 创建或 revive 会导致活跃直接子节点超过 4 时，整个请求在注册前原子拒绝；
- 子节点进入终态并等原生运行退出后释放名额，父 Agent 可以再创建新的子节点；
- 一批 `task` 条目不得部分创建后再因宽度限制失败。

21 是包含 Main 的拓扑活跃 Actor 上限。没有独立的全局 Job 并发限制；4 个 Depth 1 和 16 个 Depth 2 可以同时执行。每个父节点仍最多 4 个活跃直接子节点，stopping／finalizing 未结束前仍占该名额。

新 Job 根据其 Agent 的固定深度选择 `JOB_BUDGET_BY_DEPTH[depth]`。同一个 Agent 的 continuation Job 仍使用该深度的 Profile；不存在父子共享或跨树累计的 Budget。

## 创建、暂停、取消与续跑

| 事件 | Budget 行为 |
|---|---|
| Job 已注册、adapter 尚未调用 | 不计 Active Time，不另设排队状态 |
| Job 获得执行槽位 | 开始或恢复 Active Time |
| Tool 完成后继续模型循环 | 不重置 |
| Provider 错误后 Harness 重试 | 不回滚 |
| Job 进入 `stopping` | Active Time 继续到原生运行退出，其他计数保留 |
| 模型返回最终结果 | 结算并冻结 |
| 用户 `hub cancel` | 终止，不返还额度 |
| 同一 Agent 创建 continuation Job | 新 Job、新 Budget，仍按该 Agent 深度选择 Profile |
| 子 Agent 创建子 Job | 子 Job 按自己的嵌套深度取得独立 Budget |
| `/reload`／重新打开持久化根会话 | 恢复相同 ID、结果与历史预算快照；中断的非终态 Job 标记为 `failed / interrupted`，不继续旧时钟或自动执行 |

取消、预算终止与 lifetime 到期都先在 `stopping` 里等原生运行退出，终态 payload 只发布一次。持久化根会话复用 Pi custom entry 与子会话 JSONL 保存注册表、历史边界和预算快照；显式消息才会创建新 continuation Job 与新 Budget，不把重启后的时间计入旧 monotonic clock。内存模式仍是临时会话。

## 模型可见性与观测

Budget 不进入 `task` Schema，模型不能：

- 选择 Profile；
- 查询后提高额度；
- 在任务参数中覆盖额度；
- 重置计数；
- 通过返回中间答案继续同一 Job。

Soft 阶段允许 Harness 向子模型注入一次不含具体数字的收尾指令，这是控制执行所必需的运行时反馈，不是公开配置面。

`hub jobs` 可以提供只读用量：

```json
{
  "budget": {
    "phase": "warning",
    "modelCalls": 161,
    "activeTimeMs": 1842000
  }
}
```

默认快照不公开 Profile 上限，Budget 终态错误也会移除 soft/hard 数值；这些配置仅保留在 Harness 内部诊断状态。

# Marketplace 审批

Capability 搜索与安装分为三道门：

当前只实现第一道门；以下下载审批、安装审批与命令仍是目标控制面，不是已注册的插件命令。

1. **元数据检索**：无需批准；只读取包名、版本、发布者、manifest、tarball URL、integrity 和依赖概览。返回的未安装候选视为安装请求，等待用户批准。
2. **下载供静态审查**：需要人工批准；绑定精确版本和 integrity，下载到隔离目录，不执行 lifecycle scripts。
3. **安装与启用**：再次单独批准；任何版本、哈希或依赖解析变化都会使旧批准失效。

模型只能创建 Proposal，不能批准自己的 Proposal。无交互环境 fail closed。

建议控制面：

```text
/capability proposals
/capability inspect <proposal-id>
/capability approve-download <proposal-id>
/capability approve-install <proposal-id>
/capability reject <proposal-id>
/capability revoke <package>
```

下载审查阶段不得调用可能执行 lifecycle scripts 的普通包安装流程。

# 实现落点

- `src/capability-broker.mjs`：确定性搜索、错误隔离、Skill 正文与 URI 解析。
- `src/capability-marketplace.mjs`：有界 npm 元数据读取与已安装包过滤。
- `src/capability-agent.mjs`：内部工具、候选引用校验、提交生命周期与内部 Profile 执行。
- `extensions/capability.mjs`：无参入口、继承上下文、同物理模型解析、隔离 Pi Session、选中工具激活与能力 readers。
- `src/inherited-context.mjs`：Capability 与 Subagent 共享的原生上下文快照。
- `src/protocol-io.mjs`／`extensions/protocol-io.mjs`：协议组合与原生文件工具覆盖。
- `src/job-budget.mjs`：Pi 无关的 Budget 状态机、计数与深度 Profile。
- `src/pi-job-budget.mjs`：Pi 0.99 provider stream 边界的共享预扣与 Soft 提示适配。
- `src/subagent-runtime.mjs`：拓扑、队列、Job、消息、continuation 与快照。
- `extensions/subagent.mjs`：真实 Pi 执行、消息投递、中止与会话保留。

# 验收条件

## Capability

- 公开调用只接受 `{}`；内部两个工具不泄漏到父会话。
- 内部会话继承调用方原生条目、系统提示词与物理模型；虚拟模型选择按产生调用的物理身份复用，兼容 Responses 保留父 thinking，其它用 low，不重路由。
- 原生 thinking／签名块原样保留，不经文本压平。
- 调用阻塞到内部执行结束；模型／预算不由调用方选择。
- 本地三路并发；远程失败不取消本地，不把错误伪装成无命中。
- 返回结构保留四类数组；宿主拒绝本次未检索到的提交 Ref。
- 成功提交立即结束；内部模型失败或预算耗尽显式失败。
- 宿主只激活已注册、非 hidden 的选中工具并保留原 active 集合；不安装、不启用、不连接代码。
- `read` 支持注册 URI，裸路径与 `file://` 保持原生；`write` 协议只发送 Agent 消息且无回执状态。
- 普通文件行为保持原生；未知／只读协议写入不产生磁盘副作用。
- 搜索不执行、下载、安装或启用任何能力。

## Budget

- `task` 的模型可见 Schema 不新增 Budget 字段。
- 每次聊天 Provider 请求（含 Compact 摘要与摘要重试）在共享 stream 边界预扣；Fresh 路由的两次 native classify 分别预扣；超过 hard 的请求在发送前被拒绝。
- Tool Call 不作为统一 Budget 维度；参数规模、副作用和并发由具体工具控制。
- Active Time 从 adapter 启动开始累计；取消、预算终止与 lifetime 到期等待实际退出，尚未调用 adapter 则直接统一收尾。
- `lifetimeMs` 到期会以 `job_expired` 终止 running Job，包括初始化期间。
- Soft 只提示一次；Hard 可靠中止，不追加额外的收尾模型调用。
- 模型正常返回后 Job 终止，不能在同一 Job 上重置 Budget。
- 取消或 Budget 终止不会级联到批次中其他任务。
- 主 Agent 最多 4 个活跃直接子 Agent，每个第一层 Subagent 最多 4 个活跃直接子 Agent。
- 第二层 Subsubagent 不能继续创建 Agent，单个根会话最多 21 个活跃 Agent。
- 每个 Job 只使用由自身嵌套深度决定的独立 Budget，不维护跨树聚合额度。
- partial history 在取消、超时和 Budget 耗尽后仍可读取；终态 payload 在原生运行退出后只发布一次。
- 持久化会话恢复后旧 Agent／Job ID 与不可变结果仍可读；非终态 Job 不自动重跑，显式消息以新 Job、新 Budget 续跑。内存会话不承诺恢复。
