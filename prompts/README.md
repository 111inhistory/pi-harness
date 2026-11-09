# 提示词资产

本目录存放本项目维护的模型提示词资产，所有提示词资产均为 JSON 对象文件。`README.md` 为维护者文档，不是提示词资产。

JSON 仅为存储格式，不改变面向模型的排版、空白或装配方式。所有字符串字段解码后均保持原始文本与末尾换行。

`src/prompt-text.ts` 提供类型化读取函数：

- `promptText(name)`：读取 UTF-8 原始文本，不做 trim 或模板引擎处理。
- `promptAsset(name)`：解析 JSON 资产为只读对象并缓存。
- `promptField(name, ...fields)`：读取指定的嵌套字段值。
- `promptString(name, ...fields)`：严格读取字符串字段，缺失或非字符串类型抛出 `TypeError`，不做 trim 或静默回退。
- `promptStrings(name, ...fields)`：严格读取字符串数组字段，缺失或包含非字符串成员时抛出 `TypeError`。

| 文件 | 字段 / 内容 | 说明 |
| --- | --- | --- |
| `btw.json` | `system`、`toolsBlocked` | 独立问答的附加指令与模型收到的工具阻断说明 |
| `async-shell.json` | `guideline` | Shell 工具的 pi-job Skill 入口提示，使用环境变量与相对路径 |
| `capability-discovery.json` | `system`<br>`user` | 内部检索 Agent 的系统补充与启动检索的用户提示词 |
| `subagent-tools.json` | `instructions`<br>工具描述及参数说明 | Subagent 命名空间的使用规则、创建／列表／停止／消息工具说明与参数文本 |
| `subagent-turns.json` | `context`、`inheritedContext`<br>turn 标题、跨 session 消息标题与续跑控制 | 子 Agent 的身份、直接父节点和消息地址说明；任务标题、消息归属、跨 session 发送者与回复地址标题、续跑控制与 Inherited 默认上下文指引 |
| `execution-budget.json` | `warning` | 共享 Budget 的软阈值收尾提示 |
| `capability-tools.json` | 工具说明与参数定义 | Capability 公开工具与内部 `capability_step` 的说明及参数文本 |
| `capability-policy.json` | 策略条目与指引 | 检索执行边界、预算收尾及分支记忆的指引 |
| `native-discovery.json` | 原生工具声明 | Codemode 与原生 MCP 适配器维护的工具说明 |

## 内容与逻辑的边界

- 内置正文、标题和行为指引存放在本目录的 JSON 资产中。参数类型、工具名、权限检查、终态裁定和动态数据装配留在代码中。
- `src/subagent/prompt.ts` 组装任务和续跑文本。路由与执行共用任务组装函数，避免两边文字不一致。
- 宿主上下文固定：`subagent-turns.json` 中的 `context` 字符串仅含三个固定占位符：`{agentId}`、`{parentId}`、`{parentSocket}`。代码逐项替换为真实字符串，不解释替换值中的占位符或代码。任务组装（`composeAssignment`）与续跑控制（`continuationControlPrompt`）保持固定格式。
- 角色说明与偏好：来自用户的 `subagent-routing.json`。仓库示例在 `config/subagent-routing.json`，不另设内部角色正文。
- 提示词定制边界：`harness.json` 仅开放 `subagent.prompts.common` 与 `subagent.prompts.inherited` 两段，支持逐层 `replace` 与 `append`，详见 [Harness 提示词定制](../docs/harness-configuration.md#提示词定制)。`common` 内置默认值为空字符串；`inherited` 内置默认值取自 `subagent-turns.json` 的 `inheritedContext`。
- 子会话装配顺序：依次为路由角色指引、宿主身份段（`childContext`）、非空 `common`，以及仅用于 Inherited 模式的非空 `inherited`。`common` 默认为空时，装配顺序保持为角色、宿主身份与继承指引。
- 提示词段落装配不改写已捕获的历史，也不把历史重写为新的任务正文。快照捕获仍会移除 Harness 内部条目和末尾尚未完成的工具调用，并为子会话分配独立 session ID。
- 上游 SDK 或已选工具自身的动态说明，不复制到本目录。UI 标签、协议枚举和运行错误也不作为提示词外置。

## 修改与校验

JSON 中的正文字符串逐字读取，保留原字符与换行。修改文案时应验证字段传播、身份替换和调用行为；测试不应锁定具体正文句子。

1. 修改对应 JSON 资产。
2. 运行 `npm run check`，检查文字及调用契约回归。
3. 重启 Pi 进程后使用更新的资产。

正文在模块初始化时读取。本项目不提供热更新框架；受 ESM 依赖缓存影响，`/reload` 不保证重新读取全部资产。
