# 审查与复现记录

本目录保存检查时的代码证据、测试结果和候选建议，不保存当前产品契约。当前行为见[接口契约](../interface-contract.md)，模块边界见[当前架构](../architecture.md)，未修复项见[已知问题](../known-issues.md)。

## 记录目录

| 记录 | 检查主题 |
| --- | --- |
| [架构与实现审查：2026-10-25](architecture-implementation-review-2026-10-25.md) | 消息回执、Socket、状态职责、持久化与提示词 |
| [项目审计](project-audit-2026-10.md) | 生命周期、资源归属、模块边界与迁移建议 |
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
| [Capability 启用重写交接计划](capability-enable-rewrite-plan.md) | 重写范围、实现步骤与验收要求 |
| [共享 Provider 与继承上下文设计](shared-provider-context-design.md) | Capability／Subagent 共用适配、独立缓存标识、工具追加与伪移除的设计和边界 |
| [Capability 启用与缓存边界](capability-enable-cache.md) | 请求前缀稳定性、提供方转换分档与未解决限制 |
| [Agent 发现与通信提案](agent-discovery-communication-proposal.md) | 有范围的 peer 可见性、通信后启用 `agent_list`、统一消息身份；尚未实施 |
| [独立外部编排提案](session-orchestration-proposal.md) | 独立项目拥有管理与调度，轻量 Pi 负责决策；不在 Harness 内实现，不依赖 preset |
| [Capability 原生工具暴露行为提案](capability-native-exposure-proposal.md) | 保留原生 exposure 与 only 语义，清理 MCP 临时适配；已实现 |
| [Capability 启用可达性提案](capability-activation-reachability-proposal.md) | 无调用入口时拒绝成员，向模型报告部分失败并向用户显示 warning；已实现 |
| [Capability 延迟 schema 提案](capability-lazy-schemas-proposal.md) | 仅在启用 Codemode 的 only 模式按 MCP／namespace 延迟 schema；默认关闭，已实现 |
| [模型 Preset 提案](model-presets-proposal.md) | 模型切换、模型专属指引与原生工具修饰符；已实现（codemode.mode 运行时切换受限，见文末边界） |
| [Agent Preset 暂缓提案](agent-presets-proposal.md) | 预定义 role、配置组合与 Seed-fork 调研；继续暂缓，与模型 Preset 分开 |
| [尾部文本工具接口与 fallback 提案](text-tool-interfaces-fallback-proposal.md) | 官方 DS 文本声明实验与网关转换证据；未实现，配置与 fallback 尚未明确想清楚 |

## 使用边界

- 结论只覆盖记录中的代码版本、环境和操作，不默认描述当前实现。
- 区分现场报告、静态控制流分析、离线复现和真实提供方验证。
- 已复现缺陷可能已修复；未复现风险也不自动成为新增保护机制的要求。
- 原生事件投递、parent-hold、Budget 和配置规则以当前文档为准，不从旧审查恢复已撤回的消息合并或通知自动续跑方案。
- 测试数量与在线样本属于历史证据，不能作为当前全套通过或长期压力验收的承诺。

## 复现材料

[复现材料](reproductions/README.md)保存部分调查使用的脚本和输出快照，不进入默认测试集。运行前应核对脚本依赖、输入路径和 SDK 版本；旧脚本不是受支持的生产接口。

历史提案和被替代的契约见[归档目录](../archive/README.md)。
