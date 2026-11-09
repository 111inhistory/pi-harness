# 历史文档归档

本目录保留实现前的提案、被替代的契约、已完成变更和历史调查。归档不是当前要求，也不表示对应功能已删除。当前入口见[文档导航](../README.md)。

## 已落地方案与调查

| 文档 | 归档原因与当前入口 |
| --- | --- |
| [Harness 配置与提示词提案](harness-configuration-and-prompts.md) | 配置与段落定制已实现，使用[配置说明](../harness-configuration.md) |
| [Capability 反馈精简与交付筛选](capability-mcp-readiness.md) | 反馈投影、交付筛选与沙箱规则已实现，使用[接口契约](../interface-contract.md) |
| [父 Subagent 等待保活设计](subagent-parent-hold-design.md) | parent-hold 已实现，使用[当前架构](../architecture.md) |
| [Capability 与 MCP 现场排查](capability-mcp-registration-investigation.md) | 保存脱敏现象与被后续核对修正的推断，未修复项见[已知问题](../known-issues.md) |
| [Subagent 状态命令提案](subagent-status-command-proposal.md) | `/subagent` 命令已实现，使用[接口契约](../interface-contract.md) |
| [Capability 原生工具暴露行为提案](capability-native-exposure-proposal.md) | 保留原生 exposure 与 only 语义已实现，使用[接口契约](../interface-contract.md) |
| [Capability 启用可达性提案](capability-activation-reachability-proposal.md) | 无调用入口时拒绝成员、partial 与用户 warning 已实现，使用[接口契约](../interface-contract.md) |
| [Capability 延迟 schema 提案](capability-lazy-schemas-proposal.md) | `capability.lazySchemas` 已实现，默认关闭，使用[配置说明](../harness-configuration.md) |
| [模型 Preset 提案](model-presets-proposal.md) | 模型切换、专属指引、工具修饰符与模式生效已实现；保留运行期边界，使用[接口契约](../interface-contract.md) |
| [已修复问题记录](resolved-issues.md) | 保存修复时的证据和验证范围；当前缺陷见[已知问题](../known-issues.md) |

## 旧契约与候选设计

| 文档 | 主题 |
| --- | --- |
| [Capability 与 Job Budget 初稿](capability-and-job-budget-design.md) | 执行预算和内部检索的早期方案 |
| [Capability 与 Job Budget 第二稿](capability-and-job-budget-design-v2.md) | 后续候选预算方案 |
| [Capability 批量协议草案](capability-batch-draft.md) | 批量检索协议讨论 |
| [Subagent 生命周期设计](subagent-lifecycle-design.md) | 早期生命周期和职责划分 |
| [Subagent 旧契约](subagent-contract.md) | 已被当前接口契约替代的工具、路由和状态说明 |
| [模型可见工具旧方案](model-facing-tools.md) | 旧资源协议与工具投影方案 |
| [交互 MVP 范围](interaction-mvp-scope.md) | 早期交互方案，不表示用户入口已交付 |
| [Subagent／Capability 清单](subagent-capability-checklist.md) | 历史实施与验收清单 |
| [Subagent 路由实验说明](subagent-routing-experiment.md) | 早期分类器实验与候选方向 |
| [Windows 适配计划](windows-adaptation-plan.md) | 适配前的计划和旧接口示例 |
| [Shell Preflight 旧设计](shell-preflight.md) | 独立附加扩展的历史设计 |
| [Codex 前缀缓存调查](codex-prefix-cache-research.md) | 特定环境下的历史缓存观察 |

历史正文可能包含旧函数名、旧格式和当时的待办。保留这些内容是为了追溯设计，不据此恢复旧接口、兼容层或已撤回机制。
