# 文档目录

当前目标、接口要求与架构草案留在本目录。代码审查、测试审查和问题调查放在 `reviews/`。过时设计放在 `archive/`。

## 当前入口

| 文档 | 用途 |
| --- | --- |
| [项目目标与整理范围](00-scope.md) | 作者确认的核心目标和整理范围 |
| [接口契约](interface-contract.md) | 已确认的使用流程、当前接口、目标要求与已落地实现 |
| [新架构草案](architecture.md) | 总体重写的状态所有权、依赖方向和迁移边界；待确认 |
| [总体架构重写计划](rewrite-plan.md) | 当前阶段、四项已明确选择、实施顺序与重写进展；typed 核心已落地，迁移收尾中 |
| [能力提示词记忆规范](capability-prompt-memory.md) | 分支规范条目持久化、嵌套调用保留、旧记录回退与动态权限过滤 |
| [已知问题与待定事项](known-issues.md) | 问题状态与调查记录入口 |
| [文档写作约定](writing-guide.md) | 语言规则、事实分类和术语 |

## 环境与扩展装配

- 运行环境：Node.js `>=22.19.0`。
- SDK 依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-codemode` 和 `@earendil-works/pi-coding-agent` 均锁定为 `1.4.0`。`undici` 单独覆盖为 `8.12.2`，修复锁定 SDK 的传递依赖告警，不升级或降级 SDK。
- 安装与校验：使用 `npm ci` 安装固定依赖，使用 `npm run check` 执行类型检查（`tsc --noEmit`）与测试套件。
- 扩展装配：`extensions/harness.ts` 配套注册 Subagent、Capability 和原生 MCP 适配器。该入口禁止原生目录发现，保留选中工具的执行；Shell Preflight（`extensions/shell-preflight.mjs`）保持独立配置与使用。

## 升级注意事项

- 使用 `extensions/harness.ts` 启用完整发现边界。该入口替换 CLI 中可替换的原生扩展，无须修改 SDK。Codemode 仍可启用，但不提供 `searchTools`；接口查询只查看当前启用且允许的工具。改动对重新加载后的扩展生效，本轮不改用户全局配置。
- Fresh 路由候选直接配置 `"thinking": "low"`、`"medium"` 或 `"high"`。旧的 `thinking.min`／`thinking.max` 配置需改成单个值；Inherited 继续继承父会话的强度。
- Unix 默认 Socket 根目录按有效用户 ID 隔离。自定义根目录应归当前用户所有，权限为 `0700`，且不能是符号链接。不要通过放宽权限共享端点。
- Unix 端点发布要求文件系统支持 Socket 硬链接。不支持时启动失败，不回退到可能覆盖活跃端点的重命名操作。Windows 命名管道不使用这套文件系统规则。
- Main 的无事件队列清空仍有 SDK 限制，见[已知问题](known-issues.md#自动通知与消息合并)。当前不应将 `npm run check` 描述为全部通过。

## 审查与调查记录

[审查目录](reviews/README.md)收录代码审查、测试审查和问题调查，包含实验结果与验证范围。

审查记录回答“发现了什么问题、证据是什么”，不自动决定“产品应怎样工作”。其中的候选方案和后续验证项，不视为已批准的架构要求。

## 能力发现记忆说明

`capability-prompt-memory.md` 规范当前能力提示词记忆机制。该机制以分支上的 `capability-discovery` 自定义条目为规范记录（通过 `pi.appendEntry` 写入）。它保留嵌套工具调用结果，对缺少规范记录的历史会话回退到 `toolResult`，并在每次请求时动态校验工具权限。

## 归档规则

`archive/` 保留旧内容，只供显式追溯。维护者和 Agent 不应默认读取归档来推断当前需求、接口约束或架构决定。

归档不表示旧文档中的每句话都错误，也不表示代码中的对应行为已经删除。后续若采用旧内容，应先核对，再写入当前文档。

归档文件可能包含失效路径、旧状态和相互冲突的要求。本轮未逐项修复历史内容。
