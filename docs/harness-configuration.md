# Harness 参数配置

Harness 使用 `harness.json` 配置执行限额、检索参数和 Subagent 的指定提示词段落。路由角色、模型、thinking 与角色工具策略继续使用 `subagent-routing.json`。Pi 原生设置继续使用 Pi 的配置入口。

配置示例见 [`config/harness.json`](../config/harness.json)。数值、列表配置采用当前默认值；`prompts.common` 与 `prompts.inherited` 的空对象表示不修改内置正文，并非展开后的默认正文。生产默认值统一定义在 `src/harness-config.ts`。仓库里的示例不会自动写入用户目录。

## 配置位置与生效时间

加载顺序是内置默认值、全局配置、受信项目配置：

| 层级 | 位置 |
| --- | --- |
| 全局 | Pi 用户目录中的 `harness.json`；目录由 Pi 解析，包含 `PI_CODING_AGENT_DIR` 覆盖 |
| 项目 | 当前工作目录的 `.pi/harness.json`，仅在项目信任后读取 |

缺少文件时使用前一层值。普通对象按字段合并；提示词段落按后文的替换与追加顺序应用。未知字段、类型错误、无效数值或不完整的新深度 Budget 会报错，消息包含来源和字段路径。无效配置不静默回退。

一个根服务使用一份配置快照。子会话使用同一份快照，不按子目录重新读取配置。修改文件不会改变已运行 Job 的计数、期限或活跃名额。重启 Pi 是明确的生效方式；会话开始或树切换创建新根服务时重新解析。本文不承诺编辑文件立即生效。

`subagent-routing.json` 保留原有加载规则，不因 Harness 参数快照而改变。提示词资产的 ESM 缓存规则仍见[提示词说明](../prompts/README.md)。

## Subagent

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `subagent.maxDepth` | 2 | 新工作允许的最大深度；Main 为 0，直接子节点为 1 |
| `subagent.maxActiveChildren` | 4 | 每个父节点的活跃 Fresh 直接子节点上限 |
| `subagent.maxActiveInheritedChildren` | 3 | 每个父节点的活跃 Inherited 直接子节点上限 |
| `subagent.budgetsByDepth` | Depth 1、Depth 2 | 每层的模型调用次数、活跃时长和总存活时间 |
| `subagent.inheritedToolWaitMs` | 10,000 | Harness 等待捕获的 Inherited 工具完成注册的时长，单位为毫秒 |

`running`、`stopping` 和 `finalizing` 都占用所属名额池的活跃名额；Job 完全终结后才释放名额。列表默认每组显示 4 项，显示窗口独立于活跃上限；使用 `subagent_list({all:true})` 查看完整树。

Fresh 与 Inherited 直接子节点在同一 Subagent 树内使用独立的父节点名额池，两处名额互不借用：一个父节点可同时持有最多 4 个活跃 Fresh 直接子节点与最多 3 个活跃 Inherited 直接子节点。Inherited 的独立默认限额低于 Fresh，因为 Inherited 子节点需要复制父会话上下文并独立加载扩展与 MCP 栈。深度语义、`subagent.maxDepth`、工具策略与列表显示窗口保持不变。降低名额上限不会停止已在运行的子节点；新批次与复活在占用超过上限时被拒绝，直到占用降到上限以下。

最大深度同时控制工具派生资格、叶节点工具和 Budget。新增深度应提供完整的 `modelCalls`、`activeTimeMs` 和 `lifetimeMs`，不能隐式复用最后一层。已有层的部分字段可以覆盖。

降低最大深度不删除历史 Actor，也不把历史拓扑当作损坏。超过新限制的 Actor 不能启动新工作或新轮次。

### Budget

```json
{
  "subagent": {
    "maxDepth": 3,
    "budgetsByDepth": {
      "3": {
        "modelCalls": { "soft": 24, "hard": 32 },
        "activeTimeMs": { "soft": 600000, "hard": 900000 },
        "lifetimeMs": 3600000
      }
    }
  }
}
```

所有计数和时长均为正整数，soft 不大于 hard。时间单位是毫秒。parent-hold 继续保留同一 Job 和 Budget，等待子节点时暂停活跃计费，总存活时间仍然累计。

`inheritedToolWaitMs` 只改变 Harness 等待已捕获工具注册的窗口，不修改 Pi 后端的连接重试策略。

### 路由重试

`subagent.routingRetry` 只配置分类器请求的重试策略，不修改角色和模型选择提示词：

| 字段 | 默认值 |
| --- | --- |
| `maxAttempts` | 3 |
| `baseDelayMs` | 500 |
| `maxDelayMs` | 8,000 |
| `jitterRatio` | 0.25 |

`jitterRatio` 的范围为 `0` 到 `1`，最大间隔不小于基础间隔。每次物理请求仍计入原 Job 的 Budget。

## Shell 检查与权限

可选入口 `extensions/shell-preflight.ts` 同时提供语法检查与命令审批。两者独立配置；默认仅做语法检查。子 Agent 使用根会话的模式与审批队列。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `shell.preflight` | `true` | 执行前检查 Shell 语法 |
| `shell.approval.enabled` | `false` | 启用 Shell 权限审批 |
| `shell.approval.mode` | `auto` | 没有分支模式记录时的默认值：`ask`、`auto` 或 `yolo` |
| `shell.approval.command` | `[]` | 静态判断程序及参数数组；空数组表示交给后续审批 |
| `shell.approval.ruleFiles` | `[]` | 传给静态判断程序的规则文件路径列表；相对路径相对于定义该层的 `harness.json` 所在目录解析，多层配置按数组整层替换（不跨层拼接）。规则在根会话首次需要时读取并缓存，修改规则文件在 `/reload` 或创建新根配置快照后生效；读取失败直接阻止命令，未启用或处于 YOLO 模式跳过读取。 |
| `shell.approval.commandTimeoutMs` | `10000` | 静态判断程序超时，单位毫秒 |
| `shell.approval.manualTimeoutMs` | `30000` | 人工界面显示后的审批期限，单位毫秒 |
| `shell.approval.notificationUrl` | `""` | 人工审批展示时发送 JSON POST 的 HTTP(S) URL，空字符串关闭 |
| `shell.approval.reviewer.enabled` | `true` | Auto Approve 是否使用可选自动审查 |
| `shell.approval.reviewer.provider` | `openai-codex` | 审查模型提供方 |
| `shell.approval.reviewer.model` | `codex-auto-review` | 审查模型；不会静默替换为其他模型 |
| `shell.approval.reviewer.timeoutMs` | `90000` | 自动审查超时，单位毫秒 |

`Ask` 使用明确规则，其余请求交用户；`Auto Approve` 在规则之外调用自动审查，失败时转人工；`YOLO` 跳过权限审批，仍遵守语法检查开关。`/permissions ask|auto|yolo` 保存当前分支的模式选择，并对后续请求生效；resume 与 `/reload` 恢复选择，没有记录时才使用配置默认值。页脚显示当前模式。人工审批超时、取消或无交互界面均不执行命令。

可选自动审查包要求 Node.js 24 或更新版本；Node.js 22 仍支持基础功能，并将需要自动审查的请求转人工。审批覆盖 Bash、PowerShell 与 `pi-job create`，不提供文件工具权限或操作系统沙箱。

## 提示词定制

仅开放 `subagent.prompts.common` 和 `subagent.prompts.inherited` 两段。每段可提供 `replace`、`append`，值都是普通字符串：

```json
{
  "subagent": {
    "prompts": {
      "common": {
        "append": "交付结果时说明已验证和未验证的内容。"
      },
      "inherited": {
        "append": "说明父节点接手时需要注意的未完成事项。"
      }
    }
  }
}
```

`common` 的内置正文为空，不额外编写默认要求。`inherited` 的默认正文来自 `prompts/subagent-turns.json` 的 `inheritedContext`。

每段依次应用：内置正文 → 全局 replace → 全局 append → 项目 replace → 项目 append。空 replace 清空截至该层的正文；空 append 不追加。项目 replace 不带回全局的旧追加内容。

当前会话的装配顺序为角色指引、宿主身份段、非空 common，以及仅用于 Inherited 的非空 inherited。默认 common 为空时，原有顺序不变。

宿主身份、父节点地址、通信和自动交付说明继续由宿主装配。自定义字符串不展开变量、执行表达式或导入文件。Inherited 保留捕获的历史和基础 system prompt；替换可定制段落不替换整份历史提示词，也不按字符串查找删除祖先正文。

## Capability

### Budget 与进度

`capability.budget` 使用与 Subagent 相同的结构，默认模型调用 soft 16／hard 20，活跃时间 soft 180,000／hard 360,000 毫秒，总存活时间 600,000 毫秒。

`capability.noSelectionLimit` 默认为 3。没有新增接受 ref 的 step 累计计数，首轮搜索额外保留一次额度；额外额度由这个值推导，不单独配置。

### 压缩淘汰开关

`capability.pruneOnCompaction` 默认为 `true`。工具保护基线优先取当前 Preset 快照的工具选择，没有该选择时取 Pi 默认工具集；切换时保留的动态工具不进入基线。原生会话压缩成功后，若该开关为 `true`，或自上次压缩以来应用 Preset 移除过基线工具，则计算并淘汰窗口期内未使用的 Capability 工具；基线工具、显式禁用工具、`capability` 和 `codemode` 保持保护。基线移除由前后工具选择的差集判断，首次应用与初始基线比较，仅增加工具不触发；这一条件从分支历史推导，只影响下一次成功压缩，不改写该开关。两项条件均为 `false` 时，不写入新的 `capability-prune` 记录、不改变当前激活集合；历史记录不清除，已淘汰工具不自动恢复。

### 默认禁用种子

`capability.manualTools` 默认为空数组，列出默认禁用（`disabled`）的工具名。每项是精确工具名，或以 `*` 结尾的名字前缀（如 `mcp__prod__*`）。后一层配置整体替换前一层，不做合并。

名单归一为同一 target/state 结构的默认 `disabled` 条目（精确名或 `prefix`），不是独立 matcher 或 rootOnly 策略；`reset` 可将它解除为 `not managed`。模型侧发现与准入按 `disabled` 条目排除，不进入检索候选、不能激活；子会话通过 denial 阻止继承，显式启用本身也是 root-only。用户通过 `/capability enable` 显式启用（无参数打开终端原生选择列表，也可直接给出目标），`/subagent sessions connect` 同样通过用户启用路径为 `msg_write` 授权。启用写入同一份 `capability-tool-permission` 记录，执行权仍按每次请求的当前资格过滤。

显式状态看记录，不看激活状态：名单内工具因 `defaultActive`、历史恢复或其他扩展而激活时，`before_agent_start` 仍会把它从声明中移除，`tool_call` 与 Codemode 准入也会拒绝，直到用户显式启用。已启用的 MCP 工具参与原生 MCP 准入与资源读取资格。名单解析只按名字匹配（精确或 prefix），不读取工具描述、来源或 MCP 服务器名。

### 延迟 schema

`capability.lazySchemas` 默认为空数组，列出需要延迟暴露 schema 的 MCP 服务器或 namespace。每项必须是明确的 `mcp://<server>` 或 `namespace://<name>` 引用（成员引用 `mcp://<server>/<tool>` 归并到其 server）；未知 scheme 被忽略，后一层配置整体替换前一层，不做合并。

该配置仅在 Codemode 已启用且生效模式为 `only` 时生效；Codemode 未启用或为 `on` 模式时配置保留但不生效，沿用原生声明方式。生效模式可以来自 Pi 设置，也可由模型 Preset 通过分支记录覆盖（见下节）。命中组的成员仍以名称出现在发现结果与 `describeNamespace` 中，但参数与返回值 schema 不进入原生工具声明，也不内联进 Codemode 描述；模型通过 `describeTool` 读取完整接口后经 Codemode 执行。命中组中 model-only 工具不能经 Codemode 调用，配置命中时应显式报告而不能隐藏其声明。命中组的内部继承检索同样不重发这些 schema。模式切换只改变声明投影，不改变启用集合、授权记录或工具 exposure。未生效的配置本身不是拒绝理由。

`describeTool` 接受工具原名或 Codemode 调用标识，返回参数类型、工具指引与返回值类型；没有输出 schema 的工具声明为 `Promise<string>`，与脚本实际收到的文本一致。MCP 工具保留其原生结果对象类型，包括结构化输出。

### 搜索

`capability.search.bm25` 直接传给 MiniSearch：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `k` | 0.9 | 词频饱和；较低值减少重复词的得分增益 |
| `b` | 0.9 | 字段长度归一化，范围为 `0` 到 `1` |
| `d` | 0 | BM25+ 的附加项；`0` 使用标准 BM25 |

`k`、`d` 为非负有限数。MiniSearch 以不同词项数量计算字段长度，不直接以字符数计算。配置不引入字段拆分、语言分词或模型重排。精确引用仍独立查找，不参与 BM25 排序。

`capability.search.limits` 的字段如下：

| 字段 | 默认值 | 单位 |
| --- | --- | --- |
| `tools` | 8 | 每条查询的独立工具或 namespace 数量 |
| `mcp` | 8 | 每条查询的 MCP 组数量 |
| `skills` | 6 | 每条查询的 Skill 返回数量上限 |
| `skillBodies` | 6 | 读取正文参与重排的 Skill 候选数 |
| `requestTokens` | 128 | 默认切词后的查询词项数，不是模型 token 数 |
| `descriptionChars` | 240 | 工具／分组候选摘要的描述字符数 |
| `skillBodyChars` | 60,000 | 每个 Skill 加入索引的正文字符数，不是文件读取字节数 |

这些值均为正整数。Skill 返回数量同时受 `skills` 和 `skillBodies` 约束。候选上限不截断选中 namespace 的成员。

配置不改变本地搜索范围、同次发现去重、JSON 完整性、权限检查和交付筛选。失败激活的记忆残留属于独立 defect，不是可配置策略，见[已知问题](known-issues.md)。

## Codemode

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `codemode.memoryLimitBytes` | 268,435,456 | Harness 沙箱内存上限，单位为字节 |
| `codemode.defaultMaxOutputTokens` | 10,000 | 未显式指定时的输出 token 上限 |

脚本显式提供的 `max_output_tokens` 优先于插件默认值。宿主沿用每 token 4 字符的输出估算，超限时保存完整文件并返回路径。Pi 原生 `codemode.mode` 和 `inlineBudget` 的基准仍来自 Pi 设置，不在这里重复配置；模型 Preset 可在本会话分支上记录一个生效模式覆盖（见下节），只改变声明的 `on`／`only` 投影，不改写 Pi 设置或工具 exposure。

## 模型 Preset

模型 Preset 使用独立配置文件，不写在 `harness.json`：全局 agent 目录的 `presets.json`，以及受信项目的 `.pi/presets.json`；项目同名项整体覆盖全局。每项字段：

| 字段 | 含义 |
| --- | --- |
| `model` | `{ provider, id }`，必须存在于当前模型目录，否则整体不应用并报错 |
| `thinkingLevel` | 思考级别名称，交由 `setThinkingLevel` 应用 |
| `tools` | 原生 `+name`／`-name`／裸名数组；始终基于会话首次启动捕获的初始工具集（含默认启用扩展工具）计算，跨 reload 不被前一个 Preset 污染，先 A 后 B 与直接应用 B 一致 |
| `codemode` | `{ mode: "on" | "only" }`；在会话分支记录生效模式，只改变声明投影，不写 Pi 设置 |
| `instructions` | 模型专属指引正文，作为独立 system 段落经段落日志增量投影与回放 |

`/preset NAME`、`--preset NAME` 应用，`/preset clear` 停止管理（不回滚 model／thinking／tools），`/preset` 打开选择器。Preset 只作用于当前 Main 会话，不改 Fresh／Inherited Subagent 路由。分支快照与应用语义见[接口契约](interface-contract.md#模型-preset)。

Worker 等待时间、Worker 数量环境变量、预览行数、`ALL_TOOLS` 的短描述格式和诊断正文上限保持现有行为，不作为本轮配置项。

## `/btw`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `btw.panelMinRows` | 8 | 底部问答面板的首选最小行数；终端行数不足「最小行数 + 1」时 `/btw` 拒绝打开并报错 |

面板的高度为终端半屏，不低于该首选最小行数，并按终端行数发出高度请求。终端行数少于「最小行数 + 1」时不会把面板压缩到不可读，而是给出错误提示（尽力而为的检查，不承诺 SDK 布局实际给出的高度）；面板打开期间缩小终端到该下限以下同样显示错误行并暂停输入，恢复高度后自动继续。SDK 的间隔行、页脚、状态行与 widget 会共同占用空间，可能裁切面板底部；放大终端或减少 widget 可恢复显示。
