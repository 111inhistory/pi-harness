# Harness 参数配置

Harness 使用 `harness.json` 配置执行限额、检索参数和 Subagent 的指定提示词段落。`subagent-routing.toml` 配置角色及其候选 Preset；模型、thinking、工具与 Codemode 配置复用 Preset。Pi 原生设置继续使用 Pi 的配置入口。

配置示例见 [`config/harness.json`](../config/harness.json)。数值、列表配置采用当前默认值；`prompts.common` 与 `prompts.inherited` 的空对象表示不修改内置正文，并非展开后的默认正文。生产默认值统一定义在 `src/harness-config.ts`。仓库里的示例不会自动写入用户目录。

## 配置位置与生效时间

加载顺序是内置默认值、全局配置、受信项目配置：

| 层级 | 位置 |
| --- | --- |
| 全局 | Pi 用户目录中的 `harness.json`；目录由 Pi 解析，包含 `PI_CODING_AGENT_DIR` 覆盖 |
| 项目 | 当前工作目录的 `.pi/harness.json`，仅在项目信任后读取 |

缺少文件时使用前一层值。普通对象按字段合并；提示词段落按后文的替换与追加顺序应用。未知字段、类型错误、无效数值或不完整的新深度 Budget 会报错，消息包含来源和字段路径。无效配置不静默回退。

每份存在的 `harness.json` 都必须声明顶层 `"version": 1`。Harness 独立校验两层文件的版本，再合并设置。项目层不能声明 `classifier`、`shell.approval`、`btw`、`codemode`、`capability.search`、`subagent.routingRetry` 或 `subagent.inheritedToolWaitMs`。即使配置块为空，Harness 也会拒绝项目层的这些字段。

**迁移旧文件。** 停止 Pi 后，执行 `npm run migrate:config-v1 -- --agent-dir DIR [--project-dir DIR]` 预检；确认后添加 `--apply`。若项目文件包含仅限全局的字段，脚本报告违规路径且不写入。迁移逐文件替换，生成 `.pre-config-v1` 备份并拒绝覆盖同名备份。若中途失败，先检查原文件与备份，再决定是否继续。

一个根服务使用一份配置快照。子会话使用同一份快照。Main 的 Harness、Hook 文件、Shell 规则和 Shell 环境缓存按会话、工作目录与项目信任状态隔离；同一范围内切换分支会保留缓存。使用 `/reload` 或开始新会话可读取编辑后的配置。修改文件不会改变已运行 Job 的计数、期限或活跃名额。

`/config reload` 只刷新已安装的 `hooks.toml` 和 Shell 规则文件。命令逐项报告 `updated`、`unchanged`、`failed` 或 `skipped`。审批关闭或没有配置规则文件时，跳过 Shell 规则读取。读取或校验失败时，同一范围内已有的有效快照继续使用；没有有效快照时，该项不可用。命令不锁定文件，外部编辑器分步保存可能导致本次刷新失败。若工作目录或项目信任状态改变，原根拒绝创建和唤醒 Subagent，使用 `/reload` 重建根配置。

`subagent-routing.toml` 仍在每次新建 Fresh Subagent 时实时重读，不因 Harness 参数快照而改变。提示词资产的 ESM 缓存规则仍见[提示词说明](../prompts/README.md)。

## Subagent

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `subagent.maxDepth` | 2 | 新工作允许的最大深度；Main 为 0，直接子节点为 1 |
| `subagent.maxActiveBatches` | 4 | 每个父节点的活跃直接子 batch 上限；同批任一成员仍在执行时占用一个名额 |
| `subagent.maxActiveSubagents` | 7 | 每个父节点的活跃直接子 Agent 总上限，包含 Fresh 与 Inherited |
| `subagent.maxActiveInheritedSubagents` | 3 | 总上限内 Inherited 直接子 Agent 的子上限 |
| `subagent.budgetsByDepth` | Depth 1、Depth 2 | 每层的模型调用次数、活跃时长和总存活时间 |
| `subagent.inheritedToolWaitMs` | 10,000 | Harness 等待捕获的 Inherited 工具完成注册的时长，单位为毫秒 |

`running`、`stopping` 和 `finalizing` 都占用活跃名额；Job 完全终结后才释放名额。所有 batch 成员均已空闲后，释放活跃 batch 名额，但保留 batch 身份与成员关系。列表默认每组显示 4 项，显示窗口独立于活跃上限；使用 `subagent_list({all:true})` 查看完整树。

三项限额独立配置，并同时约束每个父节点的直接子节点。例如，同批 6 个 Fresh Agent 占用 1 个 batch 和 6 个 Agent 名额；Inherited 还占用子上限，不另获额外容量。batch 编号在 session 内统一分配，不改变按父节点计数的准入范围。降低上限不会停止已在运行的子节点；创建与显式消息唤醒空闲 Agent 都重新检查准入，不因既有身份绕过限额。

最大深度同时控制工具派生资格、叶节点工具和 Budget。新增深度应提供完整的 `modelCalls`、`activeTimeMs` 和 `lifetimeMs`，不能隐式复用最后一层。已有层的部分字段可以覆盖。

降低最大深度不删除历史 Actor，也不把历史拓扑当作损坏。超过新限制的 Actor 不能启动新工作或新轮次。

### Budget

```json
{
  "version": 1,
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
| `shell.autoBackgroundAfterMs` | `60000` | 未指定执行超时或显式后台时，Shell 自动转入后台前的等待时间（毫秒） |
| `shell.maxForegroundWaitMs` | `180000` | 未显式后台时，Shell 调用等待终态的上限（毫秒）；`timeout` 更长时到期返回运行中的 Job |
| `shell.approval.enabled` | `false` | 启用 Shell 权限审批 |
| `shell.approval.mode` | `auto` | 没有分支模式记录时的默认值：`ask`、`auto` 或 `yolo` |
| `shell.approval.command` | `[]` | 静态判断程序及参数数组；空数组表示交给后续审批 |
| `shell.approval.ruleFiles` | `[]` | 传给静态判断程序的规则文件路径列表。相对路径基于全局 `harness.json` 所在目录。规则在首次需要时读取并缓存。用 `/config reload` 刷新后续审批使用的规则；在途审批保留原规则和模式。首次读取失败时阻止命令；审批关闭或处于 YOLO 模式时，命令执行路径跳过读取。 |
| `shell.approval.commandTimeoutMs` | `10000` | 静态判断程序超时，单位毫秒 |
| `shell.approval.manualTimeoutMs` | `30000` | 人工界面显示后的审批期限，单位毫秒 |
| `shell.approval.notificationUrl` | `""` | 人工审批展示时发送 JSON POST 的 HTTP(S) URL，空字符串关闭 |
| `shell.approval.reviewer.enabled` | `true` | Auto Approve 是否使用可选自动审查 |
| `shell.approval.reviewer.provider` | `openai-codex` | 审查模型提供方 |
| `shell.approval.reviewer.model` | `codex-auto-review` | 审查模型；不会静默替换为其他模型 |
| `shell.approval.reviewer.timeoutMs` | `90000` | 自动审查超时，单位毫秒 |

`shell.autoBackgroundAfterMs` 不得超过 `shell.maxForegroundWaitMs`，否则配置校验失败。等待上限只决定工具调用何时交出 Job；`timeout` 始终限制命令的总运行时间，转后台不重置。

`Ask` 使用明确规则，其余请求交用户；`Auto Approve` 在规则之外调用自动审查，失败时转人工；`YOLO` 跳过权限审批，仍遵守语法检查开关。`/permissions ask|auto|yolo` 保存当前分支的模式选择，并对后续请求生效；resume 与 `/reload` 恢复选择，没有记录时才使用配置默认值。页脚显示当前模式。人工审批超时、取消或无交互界面均不执行命令。

可选自动审查包要求 Node.js 24 或更新版本；Node.js 22 仍支持基础功能，并将需要自动审查的请求转人工。审批覆盖 Bash、PowerShell 与 `pi-job create`，不提供文件工具权限或操作系统沙箱。

## 提示词定制

仅开放 `subagent.prompts.common` 和 `subagent.prompts.inherited` 两段。每段可提供 `replace`、`append`，值都是普通字符串：

```json
{
  "version": 1,
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

## Hooks

Main 读取 `<agentDir>/hooks.toml`、当前分支已应用的 Preset Hook 快照，以及受信项目的 `.pi/hooks.toml`。三层按此顺序合成，同 ID 整条替换；`enabled = false` 可关闭低层规则。合成后按 ID 字典序执行，单条规则内的 `actions` 保留声明顺序。全局与项目文件按需读取；修改后用 `/config reload` 刷新。Preset 的非空 `hooks` 随应用写入分支快照并参与版本哈希，`/preset` 会提示版本变动。

每份独立的 `hooks.toml` 声明顶层 `version = 1`，规则放在 `[hooks.<id>]` 下。只声明版本时规则集为空。旧的无版本 TOML 可用 `migrate:config-v1` 离线迁移。

```toml
version = 1

[hooks.prefer-read]
on = "tool_result"
when = '''tool == 'bash' && shellStandalone(input.command, ['sed', 'head', 'tail'])'''
actions = [{ type = "injectHint", text = "Use read to inspect file contents." }]
[hooks.prefer-read.repeat]
maxTriggers = 1
resetOnCompaction = true
```

Preset 在 `[presets.<name>.hooks.<rule-id>]` 下使用同一规则结构。`before_agent_start` 可匹配用户输入 `prompt`；`tool_result` 可匹配 `tool`、`nested`、`input.<path>`、`result.isError`、`result.truncated`、`result.errorKind`、`result.output` 和 `result.outputChars`。两类均可匹配 `model.provider`、`model.id`、`preset` 及 `turn.modelCalls`、`turn.toolCalls`、`turn.nestedToolCalls`、`turn.toolErrors`。比较不做隐式类型转换；未知值在 `when` 中保持未知，只有布尔真触发。辅助函数包括 `contains`、`exists`、`regex`、`inWorkspace`、`shellStandalone` 和 `shellHasCommand`。Shell 匹配只识别可确认的 POSIX 简单命令，不能当作权限检查。`regex` 使用线性匹配，模式最多 256 字符且不支持 `{…}` 重复语法；只开放 `i`、`m` 两个 flags。

- `injectHint` 接受 `text` 与可选 `display`，默认隐藏；嵌套工具命中的提示合并到顶层已执行工具结果边界。
- `injectSection` 只用于独立的 `before_agent_start` 规则，接受 `text`，不与 `repeat`、其他动作或完整自定义提示词共用。
- `activate` 以 `targets` 指定工具名、`mcp://server` 或 `namespace://name`；由 Capability 验证权限。
- `discoverCapability` 可带短 `hint`，由 Capability 后台执行；轮结束后仍可向原分支静默提交，切分支则取消。

`repeat.maxTriggers` 和 `repeat.cooldownTurns` 必须同时满足（未设置的项不限）。冷却按分支持久化的真实用户输入推进；在运行中交付的用户消息也推进冷却，已有运行的 `turn.*` 统计仍沿用原起点。`resetOnCompaction = true` 在成功压缩后清空本规则的次数和冷却记录。提示的 repeat 记录随原生消息持久化；激活与发现按动作被接受的位置记账，即使触发动作时用户消息还未落盘。单条规则的总时限默认取 `harness.json` 的 `hooks.timeoutMs`（5,000 ms），可用规则的 `timeoutMs` 收紧，且 Capability 自身的预算仍可更早结束。

### 后台分类

`classify` 规则在 `when` 命中后使用 `classifier.models` 的有序候选。候选为空时，会话加载会提示并跳过分类规则，其余规则仍可运行。每会话最多两个异步 Hook，每轮最多四次实际 SDK 分类器调用；同 ID 同时只运行一次，资源槽在底层清理完成后释放。

```toml
version = 1

[hooks.classify-review]
on = "tool_result"
when = "tool == 'read'"

[hooks.classify-review.classify]
kind = "choice"
question = "Choose implementation when the observed file is an implementation file, otherwise other."
choices = ["implementation", "other"]
include = ["result"]

[hooks.classify-review.onChoice]
implementation = [{ type = "injectHint", text = "Check the public contract before editing the implementation." }]
```

- `bool` 在肯定概率大于 `0.5` 时选择 `actions`；`score` 在得分达到 `minScore` 时选择 `actions`，分数与阈值范围为 `[0, 1]`。`choice` 要求有序、唯一的 `choices`，并由 `onChoice` 映射到静态动作数组。未配置动作的合法答案只作观察。畸形答案不触发动作，也不消耗 `repeat`。
- 分类规则不支持 `injectSection`。分类后的 `injectHint` 仅在同轮后续已执行的顶层工具结果边界投递，不主动唤醒模型；轮结束时丢弃待投递提示。`activate` 与 `discoverCapability` 可在原轮结束后向仍有效的分支静默提交。分类、候选切换、动作执行与等待提示投递共享同一个单调时限。
- 分类默认仅发送结构化事实。`include` 可显式加入 `prompt`（仅启动事件）、`result`（仅工具结果）、`recentInputs`、`recentTools`、`recentToolPreviews`、`toolDirectory`。`recentInputs` 只含最近一次压缩后的用户输入与 peer 投递，最多三条；`recentTools` 最多六条轻量记录，另开 `recentToolPreviews` 才会附带少量允许的搜索参数文本。工具目录只有名称与简短描述。上下文 JSON 上限为 16 KiB（UTF-8），截断带 `clipped`。显式加入正文后，文本可能包含敏感信息，并可能发送给多个配置的分类供应商。

### 会话统计

Main 的 `/hook-stats` 显示当前会话的规则匹配、动作受理、跳过及失败计数，以及工具类别、已知截断、分类器尝试、耗时和 token 用量。它只保留配置的 Hook ID、固定类别和计数；归入 `Other Hook IDs` 的规则不单独保留 ID。统计随会话加载重置，保留在内存中，无需配置。

## Capability

### Budget 与进度

`capability.budget` 使用与 Subagent 相同的结构，默认模型调用 soft 16／hard 20，活跃时间 soft 180,000／hard 360,000 毫秒，总存活时间 600,000 毫秒。

`capability.noSelectionLimit` 默认为 3。没有新增接受 ref 的 step 累计计数，首轮搜索额外保留一次额度；额外额度由这个值推导，不单独配置。

### 压缩淘汰开关

`capability.pruneOnCompaction` 默认为 `true`。工具保护基线优先取当前 Preset 快照的工具选择，没有该选择时取 Pi 默认工具集；切换时保留的动态工具不进入基线。原生会话压缩成功后，若该开关为 `true`，或自上次压缩以来应用 Preset 移除过基线工具，则计算并淘汰窗口期内未使用的 Capability 工具；基线工具、显式禁用工具、`capability` 和 `codemode` 保持保护。基线移除由前后工具选择的差集判断，首次应用与初始基线比较，仅增加工具不触发；这一条件从分支历史推导，只影响下一次成功压缩，不改写该开关。两项条件均为 `false` 时，不写入新的 `capability-prune` 记录、不改变当前激活集合；历史记录不清除，已淘汰工具不自动恢复。

### 默认禁用种子

`capability.blacklist` 默认为空数组，提供启动默认黑名单。支持精确工具名、工具组引用与名字前缀（如 `mcp__prod__*`）。受信项目可以追加禁止项；合并保留全局条目的顺序并去重。项目层的空数组保留全局黑名单。

当前会话按「基线白名单 > 黑名单 > 普通按需激活／发现」计算可用性。`base add` 与 Preset 正项可覆盖本会话的配置、Preset 或分支黑名单，但不删除禁止记录；移除白名单后禁止重新生效。普通 activate、发现和跨会话 connect 不能自行覆盖有效禁止。用户可通过 `/capability blacklist remove <target>` 在当前分支解除同目标的配置默认项；当前 Preset 的禁止记录仍独立存在。祖先禁止、角色／深度与 SDK 限制是外层约束，不能通过子会话白名单绕过。具体行为见[工具权限管理](interface-contract.md#工具权限管理)。

黑名单看有效规则，不看 SDK active 状态：工具因 `defaultActive`、历史恢复或其他扩展而激活，也不能绕过执行检查。已有独立声明按协议保留到成功压缩再移除；没有独立声明的成员立即移出 active。MCP 工具仍需当前请求集合和作用域允许，才能参与调用与资源读取资格。目标匹配读取工具名与命名空间元数据，不从描述推断规则。

### 延迟 schema

`capability.lazySchemas` 默认为空数组，列出需要延迟暴露 schema 的 MCP 服务器、Namespace 或单个工具。每项使用 `mcp://<server>`、`namespace://<name>` 或 `tool://<exact-name>` 引用（成员引用 `mcp://<server>/<tool>` 归并到其 server；精确选择单个工具使用 `tool://`）；未知 scheme 被忽略，后一层配置整体替换前一层，不做合并。

配置是默认策略。`/capability activate` 与 `base add` 中的目标后缀 `[lazy]`／`[no-lazy]` 为选中成员记录显式覆盖，后者也可覆盖配置命中；不带后缀的操作不改写已有策略。容器可组合使用 `[ns,lazy]` 或 `[ns,no-lazy]`，其中 `ns` 要求同批显式成员。成员自身的显式后缀优先于容器给出的策略。选择器分别展示配置命中、显式覆盖和实际 schema 投影状态；配置声明不等于当前模式下已生效。

该配置仅在 Codemode 已启用且生效模式为 `only` 时生效；Codemode 未启用或为 `on` 模式时配置保留但不生效，沿用原生声明方式。生效模式可以来自 Pi 设置，也可由模型 Preset 通过分支记录覆盖（见下节）。命中组的成员仍以名称出现在发现结果与 `describeNamespace` 中，但参数与返回值 schema 不进入原生工具声明，也不内联进 Codemode 描述；模型通过 `describeTool` 读取完整接口后经 Codemode 执行。命中组中 model-only 工具不能经 Codemode 调用，配置命中时应显式报告而不能隐藏其声明。命中组的内部继承检索同样不重发这些 schema。模式切换只改变声明投影，不改变启用集合、授权记录或工具 exposure。未生效的配置本身不是拒绝理由。

`describeTool` 接受工具原名或 Codemode 调用标识，返回参数类型、工具指引与返回值类型；没有输出 schema 的工具声明为 `Promise<string>`，与脚本实际收到的文本一致。MCP 工具保留其原生结果对象类型，包括结构化输出。

### Fresh routing Presets

`subagent-routing.toml` 使用 version 4。每个 role 只包含 `id`、角色 `instructions` 和 `candidates`。候选标签用于分类器选择；值为已有 Preset 名称，或遵循相同 schema 的临时 Preset：

```toml
version = 4

[instructions]
role = "Select the role."
model = "Select the execution preset."

[[roles]]
id = "executor"
instructions = "Complete the authorized change."

[roles.candidates]
standard = "coding"

[roles.candidates.quick]
description = "Small changes with an explicit implementation plan."
thinkingLevel = "medium"
tools = ["-write", "+msg_write"]

[roles.candidates.quick.model]
provider = "fake-provider"
id = "fake-model"

[roles.candidates.quick.codemode]
mode = "only"
```

`[[roles]]` 保持数组顺序；`[roles.candidates.<label>]` 定义临时 Preset，label 含点时使用引号键，如 `[roles.candidates.'model.v2']`。命名 Preset 从 Pi 用户目录的 `presets.toml` 与受信任工作目录的 `.pi/presets.toml` 加载，项目同名项整体替换全局项。候选必须指定 model；可省略 thinkingLevel，由 SDK 使用该子会话的默认强度。单候选跳过第二次分类；多候选使用 Preset 的 description，未配置时使用候选 Preset 名称。角色 instructions 仍独立提供职责，Preset instructions 提供执行指引。

工具配置使用现有 Preset 的 `tools` 修饰语法；基线为子会话自己的默认工具与扩展。显式最终减项作为该 Actor 的执行作用域 denial，后续激活不能绕过；SDK 注册排除只承载固定深度限制，祖先权限与深度限制仍生效。模型、thinking、工具、Codemode 与 Preset 指引通过公共 Preset 解析和应用路径设置，结果与所选定义保存在原生分支和 Actor 身份中；续跑不重新选择或读取变更后的 Preset。子会话不执行 Main 的 `--preset` 启动标志。

**决策模型。** 在全局 `harness.json` 中按顺序配置 `classifier.models`，每项只包含非空 `provider` 和 `id`。默认列表为空；未配置时 Fresh 路由给出明确错误。列表在根会话配置加载时确定，修改后通过 `/reload` 或新根会话生效。路由定义和 Preset 仍在每次创建 Fresh Agent 时重读。

```json
{
  "version": 1,
  "classifier": {
    "models": [{ "provider": "fake-provider", "id": "fake-classifier" }]
  }
}
```

路由每道题按列表顺序尝试。目录中缺失的模型直接跳过；每次实际 SDK 调用消耗一份 Job 模型调用预算，SDK 内部重试关闭。当前模型的暂时错误耗尽 `subagent.routingRetry`，或 SDK 返回结构化不可用证据时，才尝试下一项。取消、预算耗尽和答案无效会结束本次路由。同一道题的任务与上下文可能被发送给多家候选供应商，应仅配置可接收这些数据的模型。

**离线迁移。** 关闭 Pi 后，将 `subagent-routing.toml` v3 的 `[classifier]` 迁入同一目录的 `harness.json`，并将路由升级到 v4：

```sh
npm run migrate:routing-v4 -- --agent-dir /path/to/agent
```

默认只预检，确认后加 `--apply`。已有非空列表只有与旧模型精确匹配的单项才允许继续。脚本先备份需要替换的原文件，再依次写入 `harness.json` 和路由；双文件更新不是原子事务，失败时按脚本提示恢复。迁移完成后重启 Pi。

如果配置仍是 JSON，先运行格式转换，再对 v3 TOML 执行上述离线迁移：

```sh
npm run migrate:config-toml -- presets.json subagent-routing.json
```

默认 dry-run，仅校验并输出转换后的目标路径，不写文件；确认后加 `--apply`。脚本只接受基名为 `presets.json` 或 `subagent-routing.json` 的输入，并以独占方式在相邻位置新建同名 `.toml`；目标已存在时拒绝覆盖，原 `.json` 保留不删。写出前会通过生产 validator、`smol-toml` 解析往返和规范化对象比对，覆盖多行文本、非 ASCII 与含点／空格的名称。

两个迁移命令都会检查候选顺序，因为概率并列时按配置顺序选择。若混用命名引用和内联候选导致序列化会重排，脚本会停止；请按原顺序手动填写目标 TOML 后再验证。

更旧的 version 2 路由配置（`models`、candidate `thinking` 和 role `enableTools`／`excludeTools`）不再被读取，先用旧脚本转换为 version 3 JSON，再执行上述 TOML 迁移：

```sh
node --import tsx scripts/migrate-subagent-routing.mjs subagent-routing-v2.json subagent-routing.json
npm run migrate:config-toml -- subagent-routing.json
```

生产运行期只读取 v4 TOML。

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

脚本显式提供的 `max_output_tokens` 优先于插件默认值。宿主按每 token 4 个 UTF-8 字节估算输出大小，并同时限制为最多 2,000 行。超出任一上限时保留头尾，保存完整输出并返回文件路径。Pi 原生 `codemode.mode` 和 `inlineBudget` 的基准仍来自 Pi 设置，不在这里重复配置；模型 Preset 可在本会话分支上记录一个生效模式覆盖（见下节），只改变声明的 `on`／`only` 投影，不改写 Pi 设置或工具 exposure。

## 模型 Preset

模型 Preset 使用全局 agent 目录的 `presets.toml` 与受信项目的 `.pi/presets.toml`。项目同名项整体覆盖全局。每份文件声明顶层 `version = 1`，再在 `[presets.<name>]` 下定义条目。名称含点或空格时使用引号键，例如 `[presets.'fast.v2']`。`instructions` 可使用多行字符串。旧的无版本 TOML 使用本页的 `migrate:config-v1` 离线迁移；迁移将旧表放进 `presets` 容器，原格式和注释保留在备份中。示例见 [`config/presets.toml`](../config/presets.toml)。每项字段：

| 字段 | 含义 |
| --- | --- |
| `model` | `{ provider, id }`，必须存在于当前模型目录，否则整体不应用并报错 |
| `thinkingLevel` | 思考级别名称，交由 `setThinkingLevel` 应用 |
| `tools` | `+name`／`-name` 叠加有效启动基线；裸名数组替换该层。用户手动 base 选择优先 |
| `codemode` | `{ mode: "on" | "only" }`；在会话分支记录生效模式，只改变声明投影，不写 Pi 设置 |
| `instructions` | 模型专属指引正文，作为独立 system 段落经段落日志增量投影与回放 |

`/preset NAME`、`--preset NAME` 应用，`/preset clear` 撤回 Preset 的分支贡献并保留 model／thinking，`/preset` 打开选择器。命令作用于当前 Main 会话。分支快照与应用语义见[接口契约](interface-contract.md#模型-preset)。

Worker 等待时间、Worker 数量环境变量、预览行数、`ALL_TOOLS` 的短描述格式和诊断正文上限保持现有行为，不作为本轮配置项。

## `/btw`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `btw.panelMinRows` | 8 | 底部问答面板的组件最小行数（不是终端总高度阈值）；高度按终端半屏取目标、以该行数为下限。SDK 不公开实际分配高度，内部按预留 4 行宿主界面估算：终端少于「面板最小行数 + 4」（默认 12 行）时 `/btw` 拒绝打开；这是尽力而为的估算，不保证最终布局高度。 |

面板以终端半屏为目标，不低于组件最小行数，并将「终端行数 − 4」作为可用高度上限。该空间不足组件下限时给出错误提示；打开期间缩小终端到该下限以下同样显示错误行并暂停输入，恢复高度后自动继续。预留的 4 行用于估算宿主间隔、页脚、状态等区域，并非读取 SDK 实际布局。额外 widget 仍可能超过预留量；放大终端或减少 widget 可恢复显示。
