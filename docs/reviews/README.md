# 审查与调查记录

本目录保存代码审查、测试审查和问题调查，不保存当前产品契约。目标与要求见[项目目标](../00-scope.md)和[接口契约](../interface-contract.md)，当前模块边界见[架构说明](../architecture.md)，数据格式见[存储说明](../subagent-storage.md)。

## 记录目录

| 资料 | 内容 | 证据边界 |
| --- | --- | --- |
| [旧历史批量迁移记录](subagent-migration-batch.md) | 10 个非当前根会话原地迁移、当前主会话与 Fork 迁移至新会话，4.2 GB 全局备份留存 | 真实 SessionManager 加载、v2 状态折叠与历史区间读取；不修改生产代码识别 v1 |
| [单个旧历史迁移：人工验收](subagent-migration-smoke.md) | 离线迁移后的单样本真实 Gemini 续跑，定位临时进程的 undici 代理问题 | 真实 SessionManager 恢复、subagent_list 读取与真实 msg_write 唤醒续跑通过；OAuth 正常刷新由 SDK 自行处理 |
| [Subagent 插件内存收敛](subagent-memory-review.md) | v2 适配层接入、引用释放及撤回消息合并 | 2026-10-25 全仓离线检查通过：317 项测试（315 通过、0 失败、2 环境跳过）；不代表真实提供方或 Windows 验收 |
| [存储 v2 半成品复核](subagent-storage-v2-groundwork-review.md) | 适配层断接、持久化退化、内存回收和历史区间问题 | 只读代码检查与三个隔离探针；没有修改存储实现或操作真实会话 |
| [核心实现验证记录](implementation-check.md) | 此前测试检查点，以及协议删除与 Work 隔离的验证边界 | Linux、Node.js 22.23.4、Pi SDK 1.4.0；不表示当前存储 v2 已可用 |
| [OpenAI 原生压缩兼容性调查](native-compaction-review.md) | 原生压缩兼容缺陷与上游查重；作者决定暂缓处理 | 已运行安装版本的序列化器、请求构造器和回放处理函数；端点返回值为合成数据，未调用真实压缩端点 |
| [提示词正文外置](prompt-extraction-review.md) | Capability、Subagent、Budget 和原生发现适配器的正文外置 | 工具声明字节快照及文本、schema、离线 SDK 回归通过；不等于模型语义评估完成 |
| [Steer 消息写入前能否更新](steer-message-update-review.md) | 队列 API、公开 `message_end` 替换与实际历史写入的区别 | 七个真实 SDK 离线对照；验证模型、内存历史和磁盘内容，也复现替换后的异步间隔 |
| [消息与终态通知的投递边界验证](message-delivery-review.md) | 原生批次、取消／代次竞态、草稿覆盖与空闲唤醒 | 已有真实 SDK 离线对照与候选守卫；尚未接入产品，提交观察与真正分支替换仍待组合回归 |
| [核心架构 Review](architecture-review.md) | 状态所有权、生命周期、IPC 和 Capability 的代码证据 | 包含已复现缺陷、静态控制流判断和未证实风险；候选职责划分不是产品决定 |
| [测试价值 Review](test-review.md) | 测试统计、旧契约断言、保留价值和漏测场景 | 用例数是实际统计；价值分类是初步审查，不是有效测试占比 |

## 阅读规则

- 区分作者报告、静态分析、离线复现和真实端点验证。
- 引用实验结论时，应保留依赖版本、环境和适用条件。
- 未复现不表示问题不存在；局部通过也不表示完整用户链路通过。
- 审查记录中的修改方向应经确认后进入契约或架构文档。
- 后续实验推翻旧判断时，应注明被修正的范围，不静默扩大旧结论。
- 历史调查保留：此前关于消息合并、队列探针和草稿替换的实验（如 `message-delivery-review.md`、`steer-message-update-review.md`）保留为历史追溯记录；当前实现已撤回合并，全面采用独立逐条原生 steer 投递。
- 真实模型与 OAuth 边界：`subagent-migration-smoke.md` 中曾定位临时验收进程 undici 代理缺失问题，配置代理后真实续跑成功；常规在线 Gemini 冒烟（`sub_32`）使用 `gemini-3.8-flash` 返回 `GEMINI_SMOKE_OK` 未复现异常。不根据独立 SDK 临时环境将普通 Pi OAuth 判定为永久损坏或已修复，未请求 OAuth 永久性改动。
- 压力测试边界：Linux 长时间压力测试子 Agent 此前因模型提供方提前终止而失败，未取得完整长压测结果，不宣称已完成。

## 复现材料

[复现材料目录](reproductions/README.md)保存本轮脚本快照与输出。脚本依赖记录中的本机路径和安装版本，不属于项目运行依赖或默认测试集。

运行复现材料前，先阅读环境说明。材料不包含真实凭据，不访问真实模型端点。
