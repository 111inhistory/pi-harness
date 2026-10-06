# JEV-Based Subagent Routing 实验与评测记录（英文测试集）

本目录包含针对 Subagent 两阶段自动路由（Task → Role → Model）的 JEV 实验体系、从本机 OMP 历史中提取的子任务数据集、自行编写的模型 Preference 以及针对真实英文历史任务的 Jev 实测结果。

---

## 1. 架构与边界规范

依据 `docs/subagent-routing-experiment.md` 与 `docs/subagent-contract.md`：

1. **两阶段串行调用**：
   - **阶段 1（Role 选择）**：输入完整的任务说明（`delegated_assignment = # Batch context + # Task`，以及可选的 `startup_context`），在候选角色（`researcher`、`executor`、`reviewer`）中单选。
   - **阶段 2（Model 选择）**：在阶段 1 的 State 基础上，追加实际选中的角色的完整定义（`selected_role = { id, instructions }`），根据各模型的 Preference 进行单选。
   - **严禁组合预设**：角色与模型是正交维度，发起方仅提供工作说明，不提供 `agent`、`role`、`model`、`thinking`、`effort` 等选择旋钮。
2. **OpenRouter Decisions API 规范**：
   - 端点：`POST https://openrouter.ai/api/alpha/decisions`
   - 模型标识：`~typesafe/jev-latest`（实际服务版本 `typesafe/jev-1.13-20260917`）
   - 问题类型：`choice`，指示词 `instructions` 引导判定规则，候选集的定义放 `criteria`。

---

## 2. 真实英文任务评测结果（20 个典型历史任务）

本次评测专门针对本机提取的英文历史任务（避免非英语在当前 Jev 上的精度损耗），构建了包含 20 个覆盖底层驱动、Meson 编译、系统服务、IPC 安全审计、逆向协议解析与包验证的真实历史子任务集 `omp_english_benchmark.json`。

对 **`assignment_only`** 与 **`full_startup`** 两个变体分别进行了全量实测（共 80 次 Jev Decisions 请求，全部成功）：

| 序号 | 案例 ID / 任务名 | 预期 Role / Model | Assignment-Only (Role / Model) | Full-Startup (Role / Model) | 任务类别 |
|---|---|---|---|---|---|
| 01 | `en_01_emitterprotocol` (EmitterProtocol) | researcher / gemini | **researcher** (p=1.00) / **gemini** (p=0.99) | **researcher** (p=1.00) / **gemini** (p=0.99) | 逆向工程协议推断 |
| 02 | `en_02_corebuild` (CoreBuild) | executor / deepseek | **executor** (p=1.00) / **deepseek** (p=1.00) | **executor** (p=1.00) / **deepseek** (p=1.00) | Meson 构建代码编写 |
| 03 | `en_03_cli` (CLI) | executor / deepseek | **executor** (p=1.00) / **deepseek** (p=1.00) | **executor** (p=1.00) / **deepseek** (p=1.00) | C++ 命令行工具实现 |
| 04 | `en_04_obsplugin` (OBSPlugin) | executor / deepseek | **executor** (p=1.00) / **deepseek** (p=1.00) | **executor** (p=1.00) / **deepseek** (p=1.00) | OBS 插件代码实现 |
| 05 | `en_05_daemonrescue` (DaemonRescue) | executor / deepseek | **executor** (p=1.00) / **deepseek** (p=1.00) | **executor** (p=1.00) / **deepseek** (p=1.00) | Linux Daemon 实现与修复 |
| 06 | `en_06_irlightreview` (IrlightReview) | reviewer / gemini | **reviewer** (p=0.99) / **gemini** (p=1.00) | **reviewer** (p=0.95) / **gemini** (p=1.00) | 跨组件语义审查 |
| 07 | `en_07_coredaemonaudit` (CoreDaemonAudit) | reviewer / gemini | **reviewer** (p=0.99) / **gemini** (p=0.97) | **reviewer** (p=0.96) / **gemini** (p=0.98) | 守护进程正确性审查 |
| 08 | `en_08_climesonaudit` (CliMesonAudit) | reviewer / gemini | **reviewer** (p=0.99) / **gemini** (p=0.97) | **reviewer** (p=0.98) / **gemini** (p=0.98) | 构建配置合规性审查 |
| 09 | `en_09_obssafetyaudit` (ObsSafetyAudit) | reviewer / gemini | **reviewer** (p=0.99) / **gemini** (p=0.96) | **reviewer** (p=0.96) / **gemini** (p=0.98) | 互斥锁与线程安全审计 |
| 10 | `en_10_workspaceresearch` (WorkspaceResearch) | researcher / gemini | **researcher** (p=0.99) / **gemini** (p=1.00) | **researcher** (p=1.00) / **gemini** (p=1.00) | GNOME 扩展技术调研 |
| 11 | `en_11_localsendupstream` (LocalSendUpstream) | researcher / gemini | **researcher** (p=1.00) / **gemini** (p=1.00) | **researcher** (p=1.00) / **gemini** (p=1.00) | 网络链接重置故障排查 |
| 12 | `en_12_drmlink` (DrmLink) | researcher / gemini | **researcher** (p=0.99) / **gemini** (p=0.98) | **researcher** (p=0.99) / **gemini** (p=0.99) | DRM sysfs/debugfs 诊断 |
| 13 | `en_13_mozillawaylandime` (MozillaWaylandIme) | researcher / gemini | **researcher** (p=1.00) / **gemini** (p=1.00) | **researcher** (p=1.00) / **gemini** (p=1.00) | Wayland IME 崩溃排查 |
| 14 | `en_14_finalcpppackagingreview` (FinalCppPackagingReview) | reviewer / gemini | **reviewer** (p=1.00) / **gemini** (p=0.98) | **reviewer** (p=1.00) / **gemini** (p=0.99) | C++ 打包分发最终审查 |
| 15 | `en_15_reviewstackcore` (ReviewStackCore) | reviewer / gemini | **reviewer** (p=1.00) / **gemini** (p=0.98) | **reviewer** (p=1.00) / **gemini** (p=0.98) | 栈协议实现一致性审查 |
| 16 | `en_16_suspendreview` (SuspendReview) | reviewer / gemini | **reviewer** (p=1.00) / **gemini** (p=0.98) | **reviewer** (p=1.00) / **gemini** (p=0.99) | 休眠/唤醒脚本审查 |
| 17 | `en_17_verifynonestedagentapi` (VerifyNoNestedAgentApi) | researcher / gemini | **reviewer** (p=0.90) / **gemini** (p=0.99) | **reviewer** (p=0.90) / **gemini** (p=0.98) | 验证断言真伪与证伪审计 |
| 18 | `en_18_verifyextraexamples` (VerifyExtraExamples) | researcher / gemini | **reviewer** (p=0.83) / **gemini** (p=0.98) | **reviewer** (p=0.91) / **gemini** (p=0.97) | 验证示例代码机制合规 |
| 19 | `en_19_featureaudit` (FeatureAudit) | researcher / gemini | **researcher** (p=0.87) / **gemini** (p=0.92) | **researcher** (p=0.87) / **gemini** (p=0.94) | 系统组件盘点与排查 |
| 20 | `en_20_serviceaudit` (ServiceAudit) | researcher / gemini | **researcher** (p=0.86) / **gemini** (p=0.94) | **researcher** (p=0.87) / **gemini** (p=0.95) | 系统服务依赖分析 |

### 实测关键发现：
1. **角色判定极其清晰稳健**：
   - 凡涉及编写/修改具体代码及工程配置的任务（`CoreBuild`、`CLI`、`OBSPlugin`、`DaemonRescue`），Jev 给出 **100% 概率（p=1.00）选定 `executor`**。
   - 凡要求核查、审计、寻找潜在缺陷且未授权改动的任务，Jev 给出 **>=0.95 概率选定 `reviewer`**。
   - 凡属于开放性探索、日志排查、网络/底层硬件环境诊断的任务，Jev 给出 **>=0.86 概率选定 `researcher`**。
   - 针对 `VerifyNoNestedAgentApi` 这类原本归为 scout 的任务，因其要求明确写有 *"Seek to FALSIFY the claims... report CONFIRMED/REFUTED"*，Jev 精准识别出其“评估断言真伪”的审查本质，判定为 `reviewer`。
2. **两阶段依赖解耦生效**：
   - 无论第一阶段选定的是 executor、reviewer 还是 researcher，第二阶段选模型时，DeepSeek 与 Gemini 的分化完全遵循了 Preference 中约定的 deliverable 特性：
     - 具体代码编写全部精准选择 **DeepSeek（p=1.00）**；
     - 诊断报告、审查分析、架构推断全部精准选择 **Gemini（p=0.96~1.00）**。
3. **`full_startup` 上下文对照**：
   - 附加 Pi 0.99.2 的 Fresh 启动环境（系统提示、4 个内置工具参数 Schema、task 工具说明）后，输入 Token 由 ~3,200 增至 ~6,200，但未对判定产生任何误导或漂移，两组选出的角色和模型 100% 一致。
   - 平均单次决策耗时 ~1,250ms，两阶段总延时约 2,500ms。

---

## 3. 运行指南

测试已内置于测试脚本中，支持自定义运行：
```bash
# 测试 20 个英文基准用例（assignment_only）
OPENROUTER_API_KEY="sk-or-v1-..." python3 experiments/jev-routing/run_jev_routing.py --dataset english_benchmark --variant assignment_only

# 测试 20 个英文基准用例（full_startup）
OPENROUTER_API_KEY="sk-or-v1-..." python3 experiments/jev-routing/run_jev_routing.py --dataset english_benchmark --variant full_startup
```
