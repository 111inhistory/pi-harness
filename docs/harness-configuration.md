# Harness 参数配置

Harness 使用 `harness.json` 配置执行限额、检索参数和 Subagent 的指定提示词段落。路由角色、模型、thinking 与角色工具策略继续使用 `subagent-routing.json`。Pi 原生设置继续使用 Pi 的配置入口。

完整示例见 [`config/harness.json`](../config/harness.json)。示例保留当前默认值；生产默认值统一定义在 `src/harness-config.ts`。仓库里的示例不会自动写入用户目录。

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

脚本显式提供的 `max_output_tokens` 优先于插件默认值。宿主沿用每 token 4 字符的输出估算，超限时保存完整文件并返回路径。Pi 原生的 `codemode.mode` 和 `inlineBudget` 仍使用 Pi 设置，不在这里重复配置。

Worker 等待时间、Worker 数量环境变量、预览行数、`ALL_TOOLS` 的短描述格式和诊断正文上限保持现有行为，不作为本轮配置项。
