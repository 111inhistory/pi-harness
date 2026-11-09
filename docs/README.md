# 文档导航

项目介绍与启动步骤见[项目 README](../README.md)。本目录保存当前范围、接口、配置、架构和已知限制。历史设计与审查材料分别放在 `archive/` 和 `reviews/`。

## 当前文档

| 文档 | 阅读目的 |
| --- | --- |
| [项目范围](00-scope.md) | 核心目标、主线边界和未交付功能 |
| [接口契约](interface-contract.md) | Capability、Subagent、消息与结果的公开行为 |
| [Harness 参数配置](harness-configuration.md) | 全局与受信项目配置、Budget、检索参数和提示词定制 |
| [Shell 权限审批](shell-permissions.md) | Ask、Auto Approve、YOLO、静态策略与人工审批通知 |
| [异步 Shell](async-shell.md) | POSIX tmux／Windows psmux 任务、增量输出、终端输入和结果归属 |
| [当前架构](architecture.md) | 模块职责、生命周期、资源归属和写入边界 |
| [存储 v2](subagent-storage.md) | 根分支事件、原生子会话、恢复和视图 |
| [能力提示词记忆](capability-prompt-memory.md) | 规范记录、请求投影、压缩淘汰和权限过滤 |
| [Provider 传输行为](provider-transports.md) | 增量工具 compat、描述与 schema 更新、缓存标识边界 |
| [提示词资产](../prompts/README.md) | 资产字段、段落装配和修改生效规则 |
| [已知问题与验收边界](known-issues.md) | 已知缺陷、未交付功能、待验收场景和设计限制 |
| [文档写作约定](writing-guide.md) | 术语、事实分类和写作规则 |

配置示例见 [harness.json](../config/harness.json)、[subagent-routing.json](../config/subagent-routing.json) 和 [presets.json](../config/presets.json)。前二者配置执行限额、指定提示词段落与角色路由；`presets.json` 配置模型 Preset。Pi 模型认证与原生设置继续由 Pi 管理。

## 历史与实验

- [归档目录](archive/README.md)：已完成或被替代的提案、旧契约和历史调查。归档内容不作为当前需求或实现依据。
- [审查目录](reviews/README.md)：代码审查、测试审查和复现材料。结论受记录中的代码版本与验证范围限制。
- [Work 实验](../experiments/work/README.md)：暂缓的 Work 方案，不由主线扩展加载，也不进入默认测试集。
- [Jev 路由实验](../experiments/jev-routing/README.md)：路由评估脚本与样本，不能替代当前角色配置或在线选择质量验收。

## 维护规则

当前文档描述有效行为和实际限制，不保存阶段进度、已完成迁移清单或实现前的待确认事项。功能落地后，应把提案移入归档，并从当前文档说明入口。

审查记录保留检查时的证据，不自动成为架构要求。引用旧结论前，应核对当前代码；已失效的源码路径只作为历史标识，不伪装成可用接口。

已知问题应区分缺陷、未交付功能、待验收场景与设计限制。修复经过验证后移入历史记录；展示层输出、模型请求内容和真实提供方行为应分别说明验证边界。
