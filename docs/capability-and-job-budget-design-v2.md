# Capability Broker 与 Job Budget 设计草稿（已整合）

## 状态

本草稿中新增的内部检索 Agent、`capability_search`／`submit_result`、来源选择、匹配层次和两个命中状态，已整合到 [当前契约](capability-and-job-budget-design.md) 并实现。当前公开工具为无参 `capability({})`，资源通过协议 `read` 读取，Agent 消息通过 `write` 发送。

以下正文保留修改过程，不再作为当前接口或实现状态依据。它包含尚未同步的旧 `request` Schema、“不创建内部 Agent”等段落；这些冲突由当前契约取代，不代表兼容接口或额外实现路径。原草稿内容未删除，后续维护以当前契约为准。

## 目标

1. 向模型提供一个低认知负担的 `capability` 工具：调用方只需用自然语言说清需求。
2. 每次 Capability 检索都并行检查 Tool、MCP 和 Skill，返回一系列工具、MCP 和 Skill 命中。
3. 为所有 Subagent Job 提供 Harness 控制、模型不可配置的资源预算：Budget 属于 Harness 内部层级，除 Soft 收尾提示外不向模型暴露，也不允许模型提高、重置或选择 Budget Profile，既阻止失控执行，又不妨碍长时间编码、Review 或研究任务。
4. 搜索、下载审查、安装和启用严格分权；模型不能批准自己提出的安装。

## 非目标

- `capability` 只做检索，不执行选中的能力：这条的目的在于避免工具名 `capability` 让主模型误以为它可以直接执行某项能力。
- `capability` 不负责自动安装、启用或更新第三方包。
- Job Budget 按场景固定限死，不随任务内容调整。

## 已有实现边界

当前实现有以下约束：

- `work` 是独立工具，与 Subagent 无关。
- `task` 创建 deferred Job；blocking、持久化恢复和完整消息机制尚未落地。
- Inherited Subagent 会复制创建时的父会话上下文快照。
- Pi 当前公开 API 不提供其他 Extension 工具的 execute handle；不能把任意 Extension Tool 直接移植进子 Session。
- 当前约束为每个父节点最多 4 个活跃直接子 Agent；不另设全局 Job 并发上限。

暴露面分两层：主 Agent 只看到 `capability`；实际执行检索的 Agent 暴露 `capability_search`（检索）与 `submit_result`（提交结果）两个工具，不提供 `task` 入口，也不会通过模型可见的 `task` 递归调用自己。

# Capability Broker

## 公开调用

模型只提供一个自然语言需求：

```json
{
  "request": "使用我当前已登录并装有扩展的 Firefox 完成网页操作"
}
```

模型可见 Schema：

```js
const capabilityParameters = {
  type: "object",
  properties: {
    request: {
      type: "string",
      minLength: 1,
      description: "Describe the capability or outcome you need.",
    },
  },
  required: ["request"],
  additionalProperties: false,
};
```

该接口在语义上只接受一个字符串。保留对象外壳是为了兼容要求工具参数根节点为 object 的模型工具协议。

以下字段不得出现在公开 Schema 中：

- 搜索类别开关；
- 每类候选数量；
- 模型轮次、工具调用、超时或费用限制；
- Budget Profile；
- 安装、启用或自动执行开关。

Tool、MCP、Skill 三路检索是固定行为，不由模型选择。

建议工具描述：

> Discover capabilities for an intended outcome. Searches local tools, MCP servers and tools, and procedural skills concurrently, always returning all three result classes. Skills may add prerequisites, prohibitions, procedures, workarounds, and verification steps to matching tools or MCP capabilities. Discovery never installs, enables, or executes third-party code.

## capability_search 接口

`capability_search` 只暴露给实际执行检索的 Agent，Schema 两个必填字段：

```js
const capabilitySearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description:
        "Keywords for the capability you need, or a ref from an earlier result " +
        "(tool:read, mcp:firefox-devtools/list_pages, skill:firefox-existing-profile) for exact lookup.",
    },
    src: {
      type: "string",
      enum: ["local", "remote", "all"],
      description:
        "local: registered tools, MCP servers and local skills. " +
        "remote: uninstalled marketplace packages, returned as an installation request. " +
        "all: both, local hits first.",
    },
  },
  required: ["query", "src"],
  additionalProperties: false,
};
```

不提供类别开关、候选数量、匹配模式、激活或安装开关：本地固定三路并行、远程单路，数量由 `CAPABILITY_LIMITS` 固定，激活与安装由宿主和用户决定。

### 三个来源

- `src: "local"`：只查会话工具表、MCP 桥接工具表和本地 Skill 目录，不发起网络请求。无命中由 `missingCapabilities` 表达。
- `src: "remote"`：只查市场元数据。返回未安装的候选本身就是向用户提出安装请求；检索侧不下载、不安装、不启用，批准与安装仍由用户完成。已经安装的包不混进结果。
- `src: "all"`：本地三路与远程单路并发执行，本地命中排在前、远程候选排在后。远程分支必须有有限超时；失败或超时不取消本地分支，只写入 `warnings` 并把状态降为 `partial`，不得表示成“市场里没有”。

不设“本地无命中才查市场”的隐含策略：需要这种行为就先调用 `local`，无命中再调用 `remote`。每个取值只有一个确定语义。

### 两个状态

命中只有两个状态：`available`（本地已可用）与 `needs_approval`（远程未安装，待批准）。`src: "all"` 的结果会同时包含两种状态，因此状态必须逐条给出；不细分激活、连接或正文可读性。

### 匹配与排序

匹配是确定性的两层，没有模式字段，也不引入模型或向量排序：

1. 精确层：`query` 本身是上次结果里的 ref 时按 ref 解析；否则与工具名、MCP 服务器／工具名、Skill 名、包名做标识符级匹配。
2. 召回层：拉丁词与中文 bigram 的 token 重叠，按字段权重打分；token 相等之外允许前缀命中（`devtool` → `devtools`）。
3. 兜底层：完全无命中时才允许单字符编辑距离的近似命中，且必须标注为模糊。

宿主内部命中带 `match`（`ref` / `name` / `token` / `fuzzy`）标注精度；这些排序诊断不属于 Main 的工具正文，也不由检索 Agent 填写。排序为：本地优先 → 名称／标题命中优先 → 分数 → ref 稳定序；模糊命中不得排在精确命中之前。

远程结果上限 5 条（`CAPABILITY_LIMITS.remote`），与本地三路的 `tools`／`mcp`／`skills` 上限同属 Harness 固定值。

## 处理流水线

```text
request
  → 规范化意图
  → 并行检索
      ├─ Tool Search
      ├─ MCP Search
      └─ Skill Search
  → Skill 正文二阶段读取
  → Caveat 提取和跨类绑定
  → 确定性 Caveat／执行步骤合成
  → 宿主校验引用
  → 结构化结果
```

三路检索必须使用 `Promise.allSettled` 或等价机制并发运行：

- 任一路失败不取消另外两路；
- 失败写入 `warnings`；
- 失败不能被表示成该类“没有结果”；
- 返回值始终保留 `tools`、`mcp`、`skills` 三个字段。

检索、意图规范化、跨类绑定、排序和执行步骤生成都使用确定性代码；不启动额外 Planner 模型，也不让三个子模型重复读取注册表。

## Tool 检索

Tool 分支读取当前 Session 的完整工具注册表和激活状态，至少匹配：

- 工具名；
- description；
- 参数名和参数 description；
- builtin、extension、sdk 或 mcp 等来源；
- 当前是否 active；
- source path/origin 等可用来源信息。

Tool 检索只返回能力元数据，不依赖工具 execute handle，也不执行工具。

## MCP 检索

MCP 分支同时保留服务器身份和服务器工具身份：

```ts
type MCPRef = `mcp:${string}` | `mcp:${string}/${string}`;
```

候选至少包含：

```ts
type MCPHit = {
  ref: MCPRef;
  server: string;
  tool?: string;
  active: boolean;
  connectionState: "connected" | "connecting" | "disconnected" | "unknown";
};
```

不能只保留桥接后的工具名。Skill 经常约束整个服务器的启动方式、连接方式或生命周期，需要稳定的服务器级 Ref。

## Skill 检索

Skill 使用两阶段检索：

1. 使用 `name + description` 做廉价召回；
2. 对候选读取正文，用服务器名、工具名、参数名、命令行标志、端口、错误名和操作动词做二阶段匹配。

只检索 description 不足以保证正确性。description 是主动召回面，正文才承载完整过程和约束。

```ts
type SkillHit = {
  ref: `skill:${string}`;
  name: string;
  description: string;
  bindsTo: Array<ToolRef | MCPRef>;
  caveats: Caveat[];
};
```

## Skill 绑定和 Caveat

Skill 不是另一种可执行 Tool。它是对 Tool/MCP 的知识覆盖层：

```ts
type Caveat = {
  id: string;
  kind:
    | "prohibition"
    | "precondition"
    | "procedure"
    | "workaround"
    | "verification"
    | "note";
  targets: Array<ToolRef | MCPRef>;
  summary: string;
  failureVisibility: "silent" | "self-describing" | "unknown";
  sources: Array<{
    skill: string;
    filePath: string;
    section?: string;
    where: "description" | "body";
  }>;
};
```

优先级从高到低为：

1. 静默失败的 prohibition/precondition；
2. 未知可见性的 prohibition/precondition；
3. procedure/verification；
4. 错误本身已经说明修复办法的 workaround；
5. note。

Caveat 使用正文中明确出现的服务器 ID、工具名、参数名、标志、端口或 API 名作为身份锚点。相同锚点集合的 description/body 提取结果合并为一个 Caveat，保留所有来源，避免同一规则重复展示。

## 返回结构

```ts
type CapabilityResult = {
  status: "ok" | "partial" | "failed";
  request: string;
  intent: string;
  tools: ToolHit[];
  mcp: MCPHit[];
  skills: SkillHit[];
  caveats: Caveat[];
  bindings: Array<{
    skill: `skill:${string}`;
    targets: Array<ToolRef | MCPRef>;
  }>;
  executionPlan: string[];
  missingCapabilities: string[];
  warnings: string[];
};
```

宿主必须验证结果中的每个 Ref 都来自本次检索结果。Planner 不能制造不存在的工具、服务器或 Skill。

## Firefox 示例

需求“使用已有登录态和扩展的 Firefox”应同时得到：

- Tool：负责外部启动 Firefox、检查端口等本机操作；
- MCP：`firefox-devtools` 及用于验证连接的 `list_pages` 等工具；
- Skill：说明 `restart_firefox/profilePath` 会触发隔离 Profile，以及必须先外部启动、再用 `--connect-existing` 接管的流程。

Skill 应向 MCP 绑定至少以下静默失败 Caveat：

```text
不得把用户真实 Profile 直接传给 restart_firefox/profilePath；
它会在指定路径下创建 firefox_devtools_mcp_profile，且不会迁移
Cookie、登录态和扩展。应先外部启动目标 Profile，并暴露
Marionette 2828 与远程调试端口，再由 MCP 使用 --connect-existing 接管。
```

这类知识不能从原始 MCP Schema 稳定获得，因此不能让 Tool/MCP 命中替代 Skill 命中。

## 确定性结果合成

当前插件不创建内部 Planner Session。Broker 只使用本次并行检索得到的候选：

- 以名称、description、参数说明和 Skill 正文做确定性排序；
- 只有 Skill 文本明确出现 Tool/MCP 身份锚点时才建立绑定；
- 从带锚点的正文中提取 prohibition、precondition、procedure、workaround、verification 和 note；
- 静默失败的 prohibition/precondition 优先；
- `executionPlan` 仅引用本次结果中的 Ref；
- 所有候选数、正文读取长度和结果数组都有 Harness 固定上限。

这条实现路径比额外模型规划更便宜、可复现，也消除了 Planner 伪造 Ref 的入口。若未来引入语义 Planner，必须保持同一公开 Schema、宿主 Ref 校验和独立内部 Budget，不能替换当前确定性安全边界。

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

每次 Harness 向模型 Provider 发起请求前计一次 `modelCalls`：

- Provider 返回错误也计一次；
- Provider 内部透明网络重试由 Provider 自己处理，不重复计数；
- Harness 显式重新发起请求则计新的一次；
- Tool 结果返回后再次请求模型也计一次。

允许使用 `1..hard` 的额度。请求前原子预扣；预扣结果大于 `hard` 时拒绝。第 `hard` 次 Model Call 与之前的调用完全相同：如果响应包含 Tool Call，工具照常执行；工具结束后若 Agent 需要第 `hard + 1` 次 Model Call 来消费结果，该请求在预扣阶段被拒绝，Job 以 `budget_exceeded` 失败。运行时不把最后一次调用特殊化。

### 不限制 Tool Calls

Tool Call 不作为 Budget 维度。不同工具的单次调用工作量没有可比性：一次批量读取可能处理很多文件却只产生一个 Tool Call，一次轻量状态查询也同样计一个。限制 Tool Call 数既不能稳定代表费用，也不能稳定代表副作用或工作量。

Model Call 限制已经约束模型能够发起工具批次的循环次数。具体工具的参数规模、副作用和并发应由该工具自己的 Schema、权限和运行时策略控制，而不是由统一 Tool Call 计数处理。

### Active Time

使用 monotonic clock 统计 Job 处于 `running` 的时间，包括模型请求、工具执行和 Harness 处理。

以下时间不计入：

- 未来显式支持的 `waiting`。

`parked` 是 Agent 状态，不是 Job 状态。Agent parked 前，其 Job 已经进入终态，Budget 也已经冻结。

`lifetimeMs` 从 Job 创建时开始按 monotonic clock 计算，是独立的绝对资源租约。它没有 soft 阶段；到期后立即 abort 当前执行或等待，将 Job 标记为 `failed`，使用 `termination: "lifetime_expired"` 和 `error.code: "job_expired"`。它用于约束 Job 从注册到执行结束的总寿命，不等于工作预算；当前不设置任务队列，waiting 仍非当前实现。

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

如果正在运行的工具不能立即取消，Job 进入内部 `cancelling` 状态；实际 Session 结束前仍占用并发槽位，避免真实并发数超过上限。

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

普通 `task` 无法预知任务是编码、Review、研究还是简单查询，因此第一层 Subagent 使用很高的安全天花板，只防止失控。第二层 Subsubagent 使用独立但仍足够宽裕的 Profile。Profile 只由 Harness 根据 Agent 深度选择，不分析任务文本、Agent 名称或 `effort`；`effort` 只表示推理强度。

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

当前 Capability Broker 只执行有界的确定性检索与正文读取，不发起额外 Model Call，因此没有独立 Planner Budget。所有候选数、Skill 正文长度、Caveat 和计划项数量由 `CAPABILITY_LIMITS` 固定限制；调用方不能覆盖。若未来增加内部 Planner，再为该内部路径定义独立 Profile，不能复用或消耗调用方 Subagent Job 的 Budget。

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
- `running`、`waiting` 和 `cancelling` 都占用一个活跃子节点名额（waiting 为目标设计，非当前实现）；
- `completed`、`failed`、`cancelled` 和 `parked` 不占用名额；
- 创建或 revive 会导致活跃直接子节点超过 4 时，整个请求在注册前原子拒绝；
- 子节点进入终态或 parked 后释放名额，父 Agent 可以再创建新的子节点；
- 一批 `task` 条目不得部分创建后再因宽度限制失败。

21 是包含 Main 的拓扑活跃 Actor 上限。没有独立的全局 Job 并发限制；4 个 Depth 1 和 16 个 Depth 2 可以同时执行。每个父节点仍最多 4 个活跃直接子节点，stopping／finalizing 未结束前仍占该名额。

新 Job 根据其 Agent 的固定深度选择 `JOB_BUDGET_BY_DEPTH[depth]`。同一个 Agent 的 continuation Job 仍使用该深度的 Profile；不存在父子共享或跨树累计的 Budget。

## 创建、暂停、恢复和续跑

| 事件 | Budget 行为 |
|---|---|
| Job 已注册、adapter 尚未调用 | 不计 Active Time，不另设排队状态 |
| Job 获得执行槽位 | 开始或恢复 Active Time |
| Tool 完成后继续模型循环 | 不重置 |
| Provider 错误后 Harness 重试 | 不回滚 |
| Job 进入 `waiting` | 暂停 Active Time，其他计数保留 |
| Job 从 `waiting` 恢复 | 继续原计数 |
| `/reload` 后恢复同一个 Job | 从持久化账本继续，不重置 |
| 模型返回最终结果 | 结算并冻结 |
| 用户 `hub cancel` | 终止，不返还额度 |
| 同一 Agent 创建 continuation Job | 新 Job、新 Budget，仍按该 Agent 深度选择 Profile |
| 子 Agent 创建子 Job | 子 Job 按自己的嵌套深度取得独立 Budget |

如果恢复时 Budget 账本缺失，必须 fail closed，不能把已经执行过的 Job 当作零消耗继续。

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

1. **元数据检索**：无需批准；只读取包名、版本、发布者、manifest、tarball URL、integrity 和依赖概览。检索返回的每个未安装候选都视为一次安装请求，等待用户批准。
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

```text
extensions/
  capability.mjs
  subagent.mjs
src/
  capability-broker.mjs
  job-budget.mjs
  subagent-runtime.mjs
test/
  capability-broker.test.mjs
  job-budget.test.mjs
  subagent-runtime.test.mjs
```

职责边界：

- `job-budget.mjs`：Pi 无关的状态机、计数、阶段转换和按深度 Profile。
- `subagent-runtime.mjs`：Agent 深度、每父节点活跃子节点、每 Job Budget、lifetime 与公开快照。
- `extensions/subagent.mjs`：模型请求预扣、Soft 注入、Active Time 定时和 `session.abort()`。
- `capability-broker.mjs`：三路并行检索、错误隔离、二阶段 Skill 正文读取、绑定、Caveat 和宿主 Ref 校验。
- `extensions/capability.mjs`：将 Broker 连接到 Pi 工具注册表、MCP provenance 和 Skill discovery。

# 验收条件

## Capability

- 调用方只需提供 `request` 字符串。
- 每次调用都并行执行 Tool、MCP、Skill 三路检索。
- 任一路失败时另外两路结果仍返回，状态为 `partial` 并包含 warning。
- 返回值始终分别包含 `tools`、`mcp`、`skills`。
- Skill 可为 Tool/MCP 添加 Caveat 和执行步骤。
- Broker 的绑定和执行步骤不能返回候选集中不存在的 Ref。
- 搜索过程不执行、安装或启用任何能力。

## Budget

- `task` 的模型可见 Schema 不新增 Budget 字段。
- Model Call 在 Provider 请求前计数。
- Tool Call 不作为统一 Budget 维度；参数规模、副作用和并发由具体工具控制。
- 尚未调用 adapter 或目标设计的 waiting 不消耗 Active Time；`parked` 只属于 Agent，不属于 Job。
- `lifetimeMs` 到期会以 `job_expired` 终止 running Job；waiting 仍非当前实现。
- Soft 只提示一次；Hard 可靠中止，不追加额外的收尾模型调用。
- 模型正常返回后 Job 终止，不能在同一 Job 上重置 Budget。
- 取消或 Budget 终止不会级联到批次中其他任务。
- 主 Agent 最多 4 个活跃直接子 Agent，每个第一层 Subagent 最多 4 个活跃直接子 Agent。
- 第二层 Subsubagent 不能继续创建 Agent，单个根会话最多 21 个活跃 Agent。
- 每个 Job 只使用由自身嵌套深度决定的独立 Budget，不维护跨树聚合额度。
- partial history 在取消、超时和 Budget 耗尽后仍可读取。
- 恢复 Job 时沿用持久化 Budget；账本缺失时拒绝恢复。
