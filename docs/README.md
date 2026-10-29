# 文档目录

当前目标、接口要求与架构说明留在本目录。代码审查、测试审查和问题调查放在 `reviews/`。过时设计放在 `archive/`。

当前 Subagent 调用链由 TS 应用模块装配，MJS 入口仅重导出；不是全仓 TS 迁移。宿主消息直接返回 Runtime 回执，外部 Socket 保留。存储 v2、旧历史迁移、备份和迁移工具按既定决定保留。提示词文件见 [`prompts/`](../prompts/README.md)。默认回归使用真实 SDK 与本地模拟模型；此前真实在线样本不代替新调用链的提供方验收。未验证项见[已知问题](known-issues.md)。

## 当前入口

| 文档 | 用途 |
| --- | --- |
| [项目目标与整理范围](00-scope.md) | 作者确认的核心目标和整理范围 |
| [接口契约](interface-contract.md) | 已确认的使用流程、当前接口、目标要求与已落地实现 |
| [当前架构](architecture.md) | 状态所有权、依赖方向、模块职责与已确认行为 |
| [存储 v2 与离线迁移](subagent-storage.md) | 当前事件字段、文件归属、历史视图、恢复和迁移边界 |
| [提示词正文](../prompts/README.md) | 提示词文件清单、数据装配与修改生效方式 |
| [能力提示词记忆规范](capability-prompt-memory.md) | 分支规范条目持久化、嵌套调用保留、旧记录回退与动态权限过滤 |
| [已知问题与待定事项](known-issues.md) | 问题状态与调查记录入口 |
| [文档写作约定](writing-guide.md) | 语言规则、事实分类和术语 |

## 环境与扩展装配

- 运行环境：Node.js `>=22.19.0`。
- SDK 依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-codemode` 和 `@earendil-works/pi-coding-agent` 均锁定为 `1.4.0`。`undici` 单独覆盖为 `8.12.2`，修复锁定 SDK 的传递依赖告警，不升级或降级 SDK。
- 安装与校验：使用 `npm ci` 安装固定依赖，使用 `npm run check` 执行类型检查（`tsc --noEmit`）与测试套件；已有 Windows / PowerShell 平台用例在 Linux 跳过。
- 扩展装配：`extensions/harness.ts` 配套注册 Subagent、Capability 和原生 MCP 适配器。该入口禁止原生目录发现，保留选中工具的执行；Shell Preflight（`extensions/shell-preflight.mjs`）保持独立配置与使用。

## 暂缓的 Work 方案

Work 的代码、测试、演示和设计集中在 [`experiments/work/`](../experiments/work/README.md)。Work 能力仍有需求，但交付形态未定，不默认认定为 Pi 插件。主线不加载 Work，也不执行它的测试；实验目录给出独立运行命令。

## 升级注意事项

- 通用资源 URI 协议已删除。Skill 返回绝对物理路径，使用原生 `read`；工具接口通过返回值或原生声明提供。`write` 仍有受管消息适配：普通文件走 SDK，非受管 Socket／Named Pipe 拒绝连接。
- 使用 `extensions/harness.ts` 启用完整发现边界。该入口替换 CLI 中可替换的原生扩展，无须修改 SDK。Codemode 仍可启用，但不提供 `searchTools`；接口查询只查看当前启用且允许的工具。改动对重新加载后的扩展生效，本轮不改用户全局配置。
- Fresh 路由候选直接配置 `"thinking": "low"`、`"medium"` 或 `"high"`。旧的 `thinking.min`／`thinking.max` 配置需改成单个值；Inherited 继续继承父会话的强度。
- Unix 默认 Socket 根目录按有效用户 ID 隔离。自定义根目录应归当前用户所有，权限为 `0700`，且不能是符号链接。不要通过放宽权限共享端点。
- Unix 端点发布要求文件系统支持 Socket 硬链接。不支持时启动失败，不回退到可能覆盖活跃端点的重命名操作。Windows 命名管道不使用这套文件系统规则。
- 作者已撤回消息合并。事件独立交接，用户清除终态后不重发。子会话收尾仍使用原生队列保留辅助函数，不能概括为没有队列探针。语义和限制见[当前架构](architecture.md)。
- 存储 v2 运行时忽略 v1 快照条目，不在运行时转换。旧 `src/subagent-history.mjs` 及过时测试已移除，保留 Job-view 测试覆盖。历史数据已通过离线脚本完成迁移（见[批量迁移记录](reviews/subagent-migration-batch.md)），4.2 GB 全局备份已留存。离线迁移脚本暂不急于清理，不构成当前阻断。
- 提示词正文、工具和参数说明已移至 `prompts/`。代码保留动态装配、参数结构与权限判断，不新增模板框架。正文在模块初始化时读取，修改后应重启 Pi，不能承诺 `/reload` 绕过 ESM 依赖缓存。

## 审查与调查记录

[审查目录](reviews/README.md)收录代码审查、测试审查和问题调查，包含实验结果与验证范围。

审查记录回答“发现了什么问题、证据是什么”，不自动决定“产品应怎样工作”。其中的候选方案和后续验证项，不视为已批准的架构要求。

## 能力发现记忆说明

`capability-prompt-memory.md` 规范当前能力提示词记忆机制。该机制以分支上的 `capability-discovery` 自定义条目为规范记录（通过 `pi.appendEntry` 写入）。它保留嵌套工具调用结果，对缺少规范记录的历史会话回退到 `toolResult`，并在每次请求时动态校验工具权限。

## 归档规则

`archive/` 保留旧内容，只供显式追溯。维护者和 Agent 不应默认读取归档来推断当前需求、接口约束或架构决定。

归档不表示旧文档中的每句话都错误，也不表示代码中的对应行为已经删除。后续若采用旧内容，应先核对，再写入当前文档。

归档文件可能包含失效路径、旧状态和相互冲突的要求。本轮未逐项修复历史内容。
