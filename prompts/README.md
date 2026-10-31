# 提示词资产

本目录存放本项目维护的模型提示词资产，所有提示词资产均为 JSON 对象文件。`README.md` 为维护者文档，不是提示词资产。

JSON 仅为存储格式，不改变面向模型的排版、空白或装配方式。所有字符串字段解码后均保持原始文本与末尾换行。

`src/prompt-text.mjs` 提供两种读取方式：
- `promptText(name)`：保留的底层文本读取函数，按固定文件名读取 UTF-8 原始文本，不做 trim 或模板引擎处理。
- `promptString(name, field)`：严格字符串字段读取函数，解析 JSON 并获取指定字段的字符串，缺失或非字符串类型抛出 `TypeError`，不做 trim 或静默回退。

| 文件 | 字段 / 内容 | 说明 |
| --- | --- | --- |
| `capability-discovery.json` | `system`<br>`user` | 内部检索 Agent 的系统补充与启动检索的用户提示词 |
| `subagent-tools.json` | `instructions`<br>工具描述及参数说明 | Subagent 命名空间的使用规则、创建／列表／停止／消息工具说明与参数文本 |
| `subagent-turns.json` | `context`、`inheritedContext`<br>turn 标题与续跑控制 | 子 Agent 的身份、直接父节点和消息地址说明；任务标题、消息归属与续跑控制 |
| `execution-budget.json` | `warning` | 共享 Budget 的软阈值收尾提示 |
| `capability-tools.json` | 工具说明与参数定义 | Capability 公开工具与内部 `capability_step` 的说明及参数文本 |
| `capability-policy.json` | 策略条目与指引 | 检索执行边界、预算收尾及分支记忆的指引 |
| `native-discovery.json` | 原生工具声明 | Codemode 与原生 MCP 适配器维护的工具说明 |

## 内容与逻辑的边界

- 正文、标题和行为指引放在本目录的 JSON 资产中。参数类型、工具名、权限检查、终态裁定和动态数据装配留在代码中。
- `src/subagent/prompt.ts` 组装任务和续跑文本。路由与执行共用任务组装函数，避免两边文字不一致。
- `subagent-turns.json` 中的 `context` 字符串只有三个固定占位符：`{agentId}`、`{parentId}`、`{parentSocket}`。代码逐项插入宿主数据，不解释数据中的替换符或代码。
- 角色说明、路由分类指令和模型偏好继续来自用户的 `subagent-routing.json`。仓库示例在 `config/subagent-routing.json`，不另建一份角色正文。
- 上游 SDK 或已选工具自身的动态说明，不复制到本目录。UI 标签、协议枚举和运行错误也不作为提示词外置。

## 修改与校验

JSON 中的正文字符串逐字读取，保留原字符与换行。修改文案时应验证字段传播、身份替换和调用行为；测试不应锁定具体正文句子。

1. 修改对应 JSON 资产。
2. 运行 `npm run check`，检查文字及调用契约回归。
3. 重启 Pi 进程后使用更新的资产。

正文在模块初始化时读取。本项目不提供热更新框架；受 ESM 依赖缓存影响，不能承诺 `/reload` 会重新读取全部资产。
