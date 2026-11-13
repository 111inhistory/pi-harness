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
| [Capability 启用重写交接计划](capability-enable-rewrite-plan.md) | enable、实时选择器与 sessions connect 已落地，manual 模型已替代；当前缺陷及改写见[审计计划](../reviews/rpc-permission-audit.md) |
| [工具权限管理提案](tool-permission-management-proposal.md) | 三态接口已落地，旧来源授权与效果一致性仍需修复；归档不表示验收通过，见[审计计划](../reviews/rpc-permission-audit.md) |
| [Harness RPC 独立接口提案](harness-rpc-interface-proposal.md) | 首批独立接口已落地；后续接口不纳入冻结期间范围，当前协议见[线协议](../harness-rpc-wire-spec.md) |
| [Capability 历史 PBT 反例修复](capability-history-pbt.md) | 声明历史与使用记录的具体反例已修复；provider 请求职责与 thinking/cache 设计缺口仍见[已知问题](../known-issues.md) |
| [SDK-free 当前指令快照](sdk-free-snapshots.md) | 已合入主线并完成全量验证，当前契约见[当前架构](../architecture.md)与[能力提示词记忆](../capability-prompt-memory.md) |
| [Parent Coordination PBT 验收](parent-coordination-pbt.md) | 父协调模型测试已合入并验证，当前说明见[测试架构](../testing.md#父协调模型测试) |
| [已修复问题记录](resolved-issues.md) | 保存修复时的证据和验证范围；当前缺陷见[已知问题](../known-issues.md) |

## 历史审查与迁移记录

| 文档 | 主题 |
| --- | --- |
| [架构与实现审查：2026-10-25](architecture-implementation-review-2026-10-25.md) | 消息回执、Socket、状态职责、持久化与提示词 |
| [项目审计（2026-10）](project-audit-2026-10.md) | 生命周期、资源归属、模块边界与迁移建议 |
| [核心架构审查](architecture-review.md) | 状态所有权、IPC、SDK 执行和 Capability |
| [测试价值审查](test-review.md) | 当时的用例统计、旧契约断言和漏测场景 |
| [核心实现检查](implementation-check.md) | 历史检查点、资源协议删除和 Work 隔离 |
| [提示词正文外置](prompt-extraction-review.md) | 资产抽取、字段映射与验证范围 |
| [消息与终态投递调查](message-delivery-review.md) | 原生批次、代次竞态、消息保留和空闲唤醒 |
| [Steer 消息更新调查](steer-message-update-review.md) | 队列、公开事件替换和实际历史写入的差异 |
| [原生压缩调查](native-compaction-review.md) | 特定 SDK 版本的序列化、请求与回放行为 |
| [Subagent 内存审查](subagent-memory-review.md) | 存储 v2 适配、引用释放和当时的内存观察 |
| [存储 v2 过渡实现审查](subagent-storage-v2-groundwork-review.md) | 适配层断接、持久化和历史区间问题 |
| [旧历史批量迁移记录](subagent-migration-batch.md) | 一次离线数据迁移的操作与验证 |
| [迁移样本人工验收](subagent-migration-smoke.md) | 单样本恢复、工具调用和在线续跑 |
| [Manual 能力验收](capability-manual-acceptance.md) | 完整 SDK 会话、在线组合与准入开销 |
| [共享 Provider 与继承上下文设计](shared-provider-context-design.md) | Capability／Subagent 共用适配、独立缓存标识、工具追加与伪移除的设计和边界 |
| [权限算法复核材料](capability-permission-algorithm-review.md) | 已核对并收敛至[审计计划](../reviews/rpc-permission-audit.md) |
| [内存与生命周期复核材料](memory-retention-review.md) | 已核对并收敛至[审计计划](../reviews/rpc-permission-audit.md) |

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
