# 审查与复现记录

本目录保存检查时的代码证据、测试结果和候选建议，不保存当前产品契约。当前行为见[接口契约](../interface-contract.md)，模块边界见[当前架构](../architecture.md)，未修复项见[已知问题](../known-issues.md)。

## 记录目录

| 记录 | 检查主题 |
| --- | --- |
| [RPC 与权限审计及改写计划](rpc-permission-audit.md) | 已复现缺陷、功能冻结、历史共享、兼容性清理、分阶段改写与解除冻结条件 |
| [异步 Shell 平台验收记录](async-shell-platform-acceptance.md) | Linux 与原生 Windows 的全量离线验收基线与限制 |
| [Capability 启用与缓存边界](capability-enable-cache.md) | 请求前缀稳定性、提供方转换分档与未解决限制 |
| [Agent 发现与通信提案](agent-discovery-communication-proposal.md) | 有范围的 peer 可见性、通信后启用 `agent_list`、统一消息身份；尚未实施 |
| [独立外部编排提案](session-orchestration-proposal.md) | 独立项目拥有管理与调度，轻量 Pi 负责决策；不在 Harness 内实现，不依赖 preset |
| [Agent Preset 暂缓提案](agent-presets-proposal.md) | 预定义 role、配置组合与 Seed-fork 调研；继续暂缓，与模型 Preset 分开 |
| [尾部文本工具接口与 fallback 提案](text-tool-interfaces-fallback-proposal.md) | 官方 DS 文本声明实验与网关转换证据；未实现，配置与 fallback 尚未明确想清楚 |

已完成或已过时的历史审查、迁移与验收记录已移至[归档目录](../archive/README.md)。

## 使用边界

- 结论只覆盖记录中的代码版本、环境和操作，不默认描述当前实现。
- 区分现场报告、静态控制流分析、离线复现和真实提供方验证。
- 已复现缺陷可能已修复；未复现风险也不自动成为新增保护机制的要求。
- 原生事件投递、parent-hold、Budget 和配置规则以当前文档为准，不从旧审查恢复已撤回的消息合并或通知自动续跑方案。
- 测试数量与在线样本属于历史证据，不能作为当前全套通过或长期压力验收的承诺。

## 复现材料

[复现材料](reproductions/README.md)保存部分调查使用的脚本和输出快照，不进入默认测试集。运行前应核对脚本依赖、输入路径和 SDK 版本；旧脚本不是受支持的生产接口。

历史提案和被替代的契约见[归档目录](../archive/README.md)。
