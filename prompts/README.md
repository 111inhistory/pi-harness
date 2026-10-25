# 提示词正文

本目录存放本项目维护的模型提示词正文。`src/prompt-text.mjs` 按固定文件名读取 UTF-8 文本，不做 trim、静默回退或模板引擎处理。

| 文件 | 内容 |
| --- | --- |
| `subagent-instructions.md` | Subagent 命名空间的使用规则 |
| `subagent-tools.json` | 创建、列表、停止和消息工具的描述、指引及参数说明 |
| `subagent-context.md` | 子 Agent 的身份、直接父节点和消息地址说明 |
| `subagent-turns.json` | 任务标题、消息归属和续跑说明 |
| `capability-discovery-system.md` | 内部检索 Agent 的系统补充 |
| `capability-discovery-user.md` | 启动检索的用户提示词 |
| `capability-tools.json` | Capability 公开工具及内部检索、提交工具的说明 |
| `capability-policy.json` | 检索范围、提交结束、预算收尾及分支记忆的指引 |
| `native-discovery.json` | Codemode 与原生 MCP 适配器维护的工具说明 |
| `execution-budget-warning.md` | 共享 Budget 的软阈值收尾提示 |

## 内容与逻辑的边界

- 正文、标题和行为指引放在本目录。参数类型、工具名、权限检查、终态裁定和动态数据装配留在代码中。
- `src/subagent-prompt.mjs` 组装任务和续跑文本。路由与执行共用任务组装函数，避免两边文字不一致。
- `subagent-context.md` 只有三个固定占位符：`{agentId}`、`{parentId}`、`{parentSocket}`。代码逐项插入宿主数据，不解释数据中的替换符或代码。
- 角色说明、路由分类指令和模型偏好继续来自用户的 `subagent-routing.json`。仓库示例在 `config/subagent-routing.json`，不另建一份角色正文。
- 上游 SDK 或已选工具自身的动态说明，不复制到本目录。UI 标签、协议枚举和运行错误也不作为提示词外置。

## 修改与校验

正文逐字读取，末尾换行也算提示词内容。修改文案时应检查相关输出断言；本轮外置保留原文、顺序与空白，不借此修改行为。

1. 修改对应资产。
2. 运行 `npm run check`，检查文字及调用契约回归。
3. 重启 Pi 进程后使用更新的资产。

正文在模块初始化时读取。本项目不提供热更新框架；受 ESM 依赖缓存影响，不能承诺 `/reload` 会重新读取全部资产。
