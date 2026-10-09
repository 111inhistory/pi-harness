# 模型可见的工具说明

## 写法

沿用 Pi 原生 `read`／`edit`／`write` 的格式，不新增全局提示词框架：

- **description**：这个工具做什么、返回什么；会不会等待。
- **参数 description**：字段含义、默认值、必要输入。
- **promptSnippet**：一句话用途，进入 Pi 的工具摘要。
- **promptGuidelines**：少量直接的操作规则，进入 Pi 的规则区。

工具说明使用简短英文；任务和材料保留调用方的原文。不为某个模型另写一套协议，也不假设某个模型会自行读懂仓库的设计文档。自定义系统提示词可能替代 Pi 默认的工具摘要和规则区，工具 description 和参数说明仍是模型理解调用方法的重要入口。

## Subagent 的操作顺序

`subagent_create`／`subagent_list`／`subagent_stop` 属于原生 `subagent` namespace，主会话默认注册但不激活；Depth 1 的 Fresh／Inherited 显式启用这些控制工具与 Capability。Capability 将整组作为一个候选发现并返回，选中后一起激活可直接声明的成员。Depth 2 只有 list 控制工具，没有 Capability／create／stop；写入工具按角色配置启用。

共同说明保存在 namespace.instructions；激活成员后，原生提示词会去重展示同一份操作规则。`write` 覆盖原生同名工具，静态支持文件和 Socket 写入；`msg_write` 是同一 backend 的 Socket-only 替代形态，默认不启用。researcher／reviewer 在角色配置中通过 `enableTools: ["msg_write"]` 额外启用它，executor 使用 `write`，不额外启用 msg_write。不根据启用列表动态改变 write 的实现。

1. 用 `subagent_create` 提交独立任务；每个任务说明交付物、范围和验证要求。
2. Fresh 不继承聊天历史，必要信息放在 `task` 或共享的 `context` 中。需要父会话快照时才用 `inheritContext: true`。
3. 保存返回的统一 `id`、`socket` 和 `history` 路径。create／list 不返回 name、depth、parentSocket 或 Budget；list 额外保留 parentId。创建不会等待结果，也不会在正常完成时唤醒父 Agent。
4. 需要进度或结果时调用 `subagent_list`，不要在紧密循环中反复查询。默认展示直接父级、peers（含自己）及自己的 children，每组当前最多 4 个，活跃优先、最近停止的补齐。Main 还展开已展示的活跃子节点；不展开停止节点或 peer 的 children。`all: true` 展示 Main 和全部历史节点，无范围或数量筛选；`id` 只在所选范围内过滤。
5. `stopped` 表示这一轮已结束，不表示成功；读取 `history.summary` 看结果，读取 `history.cleanJsonl` 检索完整消息。
6. `subagent_stop` 用于取消不再需要的工作，不是收集结果的前置操作。返回 `stopping`／`finalizing` 时仍未结束。

子 Agent 共享工作目录，避免同时修改同一文件。每个父节点最多 4 个活跃直接子节点，最多两层；没有全局并发上限或任务队列。

## 消息示例

将 `path` 替换为工具返回的实际 Socket 路径：

```json
{
  "path": "<returned socket>",
  "content": "{\"content\":\"Please check the tests and report the result.\"}\n"
}
```

向直接父级发送时，path 使用子 Agent 上下文给出的 parentSocket；Depth 1 的父级是 Main，收件地址为 `/tmp/pi-subagents/<uid>/Main.sock`，不是向下广播的 main/children.sock。显式消息可唤醒空闲 Main，忙碌时原生 steer；Depth 2 向其 Depth 1 父级的 socket 投递。

这是 `msg_write` 的参数，不是普通文件内容约定：

- 一行一个 JSON 对象，消息文字放在 `content`。
- 不提供 `from` 或 `to`：宿主绑定发送者，Socket 路径决定接收者。
- 写入成功不代表任务完成或接收者已经处理消息。
- 写入 `stopped` Agent 的 Socket 会启动新一轮；不要向 `stopping`／`finalizing` Agent 投递。
- `children.sock` 只广播给其所属 Agent 的直接子节点；不能使用别人的广播端点。
- 普通文件仍遵循原生 write 语义：新建或完整覆盖，局部修改用 edit。

## 其他工具

- `work`：记录和查看工作树，不执行任务。focus 只改变查看焦点。
- `capability`：无参数，根据当前会话发现值得复用的指导与能力，也用于补齐能力缺口。不要等到基础工具失败才查找成熟方案，也不要求每次工具调用前都检索。

### Capability 的主旨

优先复用已有的方法、规则、偏好、固定背景和说明，以及适合任务的工具／MCP，避免从头摸索或搭建替代方案。Word 编辑、PPT 创建等任务尤其应考虑是否已有成熟资源。

Skill 按宽泛的任务指导理解，而不只是操作教程。相关指导和工具入口应一起选择；主 Agent 读取指导，将其与具体工具接口结合使用，不能只按工具作者的通用描述判断当前场景的用法。

Skill 发现默认只走 Capability；除非用户明确要求文件系统或网络搜索，不手动扫描本地目录、已安装仓库、其它 Agent profile 或网络来找 Skill。泛泛的“找找有哪些 Skill”不授权绕过 Capability 的配置筛选；未命中时报告缺口或询问配置，不自行寻找被过滤的 Skill。读取返回的 Skill ref 及其链接的说明不算另起发现搜索。这是主 Agent 提示词规则，不增加 Bash／网络工具的运行时封禁。

任务级指导与工具发现统一走 Capability；通过 Codemode 使用陌生工具时，先用 describeTool／describeNamespace 查看接口。不另起 searchTools 发现流程。这只是模型使用规则，原生 searchTools 函数仍然存在，不增加运行时禁用或权限控制，也不要求每次调用已知工具前重新检索。

内部检索先搜索本地指导与能力，再为尚未覆盖的需求搜索远端包元数据。返回聚焦的互补 refs，不堆砌所有相关候选。一个 namespace 是一个候选，包含全部可达成员与共同 instructions；hidden 成员不返回。所有原生 namespace 都使用 `namespace://<name>`，包括 MCP namespace；只有没有原生 namespace 的 MCP 工具才按 server 归组，使用 `mcp://<server>`。成员命中会回到整组，最终提交整组 ref。每次搜索的 Tool／MCP 上限均按候选组计数，不截断组内成员。

当前检索源是已注册工具、MCP、已配置且已安装的 Skill 资源与 npm 包元数据。Skill 索引使用 Pi 原生 DefaultPackageManager.resolve(skip) 只读解析已有资源，再以原生 loadSkills 读取前言和正文；包括包 manifest 声明、显式路径及默认目录。getCommands() 的 skill 来源只补充临时／扩展提供的已加载路径，不再作为唯一索引，因此当前会话未加载 Skill、noSkills 或清空基础提示词不影响已配置资源的发现。遵守包 manifest、过滤、项目信任，disable-model-invocation 的 Skill 仍不向模型提供。缺失包跳过，不安装、拉取、更新或执行扩展代码。实现：`src/capability-skills.mjs`。

加载和模型可见性分离：Capability 在 before_agent_start 清空原生 systemPromptOptions.skills，不向基础提示词注入 available_skills 名称、描述和路径；Capability 的已配置资源索引独立保留，按任务发现，不以命令清单是否非空作为前提。没有关闭 noSkills，也不改第三方 SKILL.md。已有会话中的旧系统提示或发现结果仍在历史里，验证首次发现必须使用新会话。

独立存放的 rule／preference／background 并未因此自动接入索引；返回的指导是已有资源的引用，不是新增的偏好提取结果字段。

Capability 在执行前检测 Subagent namespace 的 list／stop 已注册且非 hidden，不要求成员已经 active，也不要求 Depth 2 存在 create。缺少依赖时直接返回失败，不启动内部检索、不消耗模型调用。Capability 只安装只读资源入口，通用 write 和 Socket-only msg_write 由 Subagent 静态注册；不依赖扩展加载顺序。Depth 2 保留权限守卫和资源读取入口，但不注册 Capability 发现工具。

子 Agent 的 tool／MCP 资格白名单受直接父级约束。父级新增可用能力向下扩展资格，不自动复制执行句柄或启用工具；只在子会话已注册时可发现与激活。角色仅配置必填的 roles[].excludeTools 黑名单，按完整工具名拒绝工具（不接受 glob），空数组表示无额外拒绝；旧 roles[].tools 不再接受。可选 roles[].enableTools 指定额外启用的完整工具名；缺省为空。Fresh 从 SDK 默认启用集合开始，加上 enableTools 与该层级的 Harness 控制工具，并受父级资格及角色黑名单过滤。黑名单优先。白名单只增不减，Skill 不受父级工具范围限制。停止父级采用保留的工具元数据，复活后采用新会话 API，不调用旧 stale Pi ctx。

搜索时移除已 active 的独立工具（包括原生和 SDK additionalTools）；namespace 仍可返回共同指导。资源 schema 读取不受“已启用”过滤影响。

选中 namespace 会将可直接声明的成员一起激活；codemode／deferred 成员本来可间接调用，不额外激活。模型可见结果的 tools／mcp 只保留本次激活前尚未 active 的接口，不重复列出 read、write、codemode 等现有工具。部分成员已 active 时只列剩余成员；整组已 active 时工具列表为空，但共同 instructions 放入 guidance。Skill 和任务指导不受这项过滤影响，完整检索选择仍留在 details。Main 的工具正文不返回 match、score、reason 或 warnings；这些是宿主排序／诊断字段，不由内部 Agent 填写。内部 Agent 只提交所需资源 refs。空 bindsTo／caveats 省略，非空关联／约束指导保留。`needs_approval` 候选仍会随选中结果返回，不代表安装或执行授权，尚未实现仅通知用户的分流。

### Responses 增量声明与返回精简

具体模型须使用 Responses adapter，并同时支持中途 system 消息与 additional tools／tool-search 加载。只看 API 名称不足以启用优化。

- Main 的请求投影保留工具首次声明；停用改成后置“不可调用”说明，重新启用不重复声明。同名描述更新（如 Codemode loadout 变化）改成后置接口更新提示，避免 Pi 回退到顶层完整 tools。持久化的原生权限变化仍保留，不修改历史文件。
- 执行集不因保留声明而扩张。Pi 对缺失工具的直接／嵌套调用会拒绝；Capability 的 tool_call handler 另检查当前注册、exposure 与 active 状态。Codemode／deferred 不需要 active 即可间接调用。
- 内部检索保留父声明的阻断占位工具，不持有父执行句柄；只允许两个检索工具执行。兼容的 Responses 沿用父 thinking，其它模型继续用 low。
- 对全部成员实际 active 的选中候选，模型结果省略通用描述和成员接口列表，保留 ref、namespace、instructions 与适用指导；完整结果仍在 details 和协议读取入口。未直接激活的 deferred／codemode 候选不压缩。Codemode only 模式保守地返回完整候选。
- 新接口仍由 Pi 原生转换成 additional_tools 或 tool_search_output，本扩展不手工拼接供应商 HTTP payload。
- Main 的投影只对当前具体兼容模型生效，不猜测尚未路由的虚拟模型。压缩、强制替换系统提示词、切换模型或其它扩展的后续投影仍可能改变前缀。没有新增保活、共享 Session ID 或缓存命中保证。

实现：`src/responses-tool-prefix.mjs`。真实离线 SDK 回归包含 Codemode 描述变化、内部越权调用、停用后直接／脚本调用、重新启用和最终 Responses 消息转换。

## 维护与验证

实际说明在 `extensions/subagent.mjs`、`extensions/work.mjs`、`extensions/capability.mjs`、`src/capability-broker.mjs` 和 `src/capability-agent.mjs`。

测试检查工具注册后的语义，并使用真实 SDK 验证 Main 和 Fresh 子 Agent 实际看到的提示内容。离线测试不证明任何真实模型的理解或执行质量；这些需要安装后的试用确认。此轮不修改路由候选模型或模型 Preference。
