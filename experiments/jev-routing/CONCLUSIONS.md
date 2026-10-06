# Jev-Based Subagent 两阶段自动路由实验评测结论报告

## 采纳状态

用户已确认本轮实验效果足够，路由方案已据此并入 [Subagent 主契约](../../docs/subagent-contract.md) 和 [总体范围](../../docs/00-scope.md)。本报告保留实验过程与结果；这次合并不代表自动路由已经接入 Harness，也不要求继续扩大测试。早期英文提示词与实验记录见 [路由实验附件](../../docs/subagent-routing-experiment.md)。

## 1. 实验背景与设计原则

根据本仓库公开契约（`docs/subagent-contract.md`）与路由设计记录（`docs/subagent-routing-experiment.md`）：

- **发起方零旋钮**：任务发起模型仅提交客观工作描述（`context` + `task`），不暴露 `agent`、`role`、`model`、`thinking`、`effort` 或工具清单。
- **两阶段串行依赖决策**：
  - **阶段 1（Role 选择）**：`state = { delegated_assignment, startup_context? }`，在三个候选角色（`researcher`、`executor`、`reviewer`）中单选。
  - **阶段 2（Model 选择）**：在阶段 1 的 State 基础上追加实际选中的角色全文（`selected_role = { id, instructions }`），根据各候选模型的 Preference 独立单选。
  - **正交独立**：严禁 `(model, role)` 组合枚举与静态预设。
- **决策接口**：调用 OpenRouter Decisions API（`POST https://openrouter.ai/api/alpha/decisions`），模型别名使用 `~typesafe/jev-latest`（实际服务版本 `typesafe/jev-1.13-20260917`）。

---

## 2. 本机 OMP 历史工具调用提取与机制挖掘

### 2.1 历史提示词提取统计
扫描本机 `~/.omp/stats.db` 及历史会话文件（`~/.omp/agent/sessions/**/*.jsonl`），共提取出历史 `task` 批量工具调用 **216 次**，解析出 **418 个** 真实子任务：
- **发起模型分布**：`gpt-5.6-sol` (148), `deepseek-v4-flash-vision-exp` (20), `gemini-3.8-flash` (17), `gpt-6-astra` (13), `deepseek-v4-flash` (10), `deepseek-v4-pro` (5), `gpt-5.6-luna` (3)。
- **历史分配 Agent 分布**：`scout` (211), 默认缺省/task (64), `memory-curator`/`skill-curator` (44), `reviewer`/`security-reviewer` (39), `librarian` (28), `designer`/`sonic` (32)。

### 2.2 OMP 历史分派机制挖掘 vs Jev 两阶段路由
经查验本机 `~/.omp/agent/config.yml`（第 47~56 行）：
```yaml
task:
  agentModelOverrides:
    reviewer: openai-codex/gpt-5.6-sol:medium
    scout: google-antigravity/gemini-3.8-flash:low
    task: deepseek/deepseek-v4-flash-vision-exp
    security-reviewer: google-antigravity/claude-sonnet-4-6:high
```
**关键发现**：
- OMP 历史采用**人工指定标签 + 查表静态映射**（如指定 `scout` 永远给 Gemini Flash，未指定标签永远走默认的 DeepSeek Vision）。
- 这导致历史会话多次出现不合理分派：
  1. **英文设计文档由 DeepSeek 撰写**：在 `RoutingDocAuthor` 中，因发起方需要写入文件而未指定 agent，OMP 走默认 `task` 硬绑定了 `deepseek-v4-flash-vision-exp`，其自然语言润色与英文阐述明显偏弱。
  2. **严格证伪审计被泛化为 Scout**：在 `VerifyNoNestedAgentApi` 中，任务明确要求“证伪断言、汇报 CONFIRMED/REFUTED”，但发起方随手标了 `agent: "scout"`，被降级为低算力模型。
  3. **Jev 两阶段动态路由完全修正了上述缺陷**：发起方无需猜选标签，Jev 根据实际交付物性质精准定角色，再根据模型 Preference 定模型。

---

## 3. 自定义模型 Preference 设计（`model_preferences.json`）

依据本地使用经验撰写，严格遵循四段式结构与明确边界：
- **Gemini Candidate**：
  - 核心优势：自然语言阐述、跨模块长上下文代码阅读、系统级隐式缺陷与边缘条件诊断、编写与重构技术文档。
  - 相对局限：在严格语法检查、复杂多 hunk 补丁实现与断言修复时，生成正确 patch 的可靠度略逊于 DeepSeek。
  - Tie-break：以解释、排查、文档撰写为核心目标时优先（即使角色是 executor）；严禁因需要预先读文件就偏向 Gemini。
- **DeepSeek Candidate**：
  - 核心优势：具体代码修改、bug 修复、机械性批量重构（改名、接口迁移、结构适配）以及通过测试验证的高可靠度。
  - 相对局限：自然语言阐述与文稿润色较平淡；编辑 Markdown 文件本身不视为代码实现优势。
  - Tie-break：小而机械的代码改动同样算作实现优势（不要求任务看似复杂）；代码修改附带简短说明不削弱其实现优势。

---

## 4. 实测实验一：20 个典型历史英文任务评测

评测包含 20 个覆盖底层驱动、Meson 编译、系统服务、IPC 安全审计、逆向协议解析与包验证的真实历史子任务集 `omp_english_benchmark.json`。双变体（`assignment_only` 与 `full_startup`）共 **80 次 Jev Decisions 请求，100% 成功返回**：

| 案例 ID / 任务名 | 任务核心性质 | Assignment-Only 选定结果 | Full-Startup 选定结果 | 角色与模型概率 |
|---|---|---|---|---|
| `en_01_emitterprotocol` (EmitterProtocol) | 硬件 IR 协议逆向推断 | **researcher / gemini** | **researcher / gemini** | p(role)=1.00, p(model)=0.99 |
| `en_02_corebuild` (CoreBuild) | Meson 构建代码编写 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00 |
| `en_03_cli` (CLI) | C++ 命令行工具代码实现 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00 |
| `en_04_obsplugin` (OBSPlugin) | OBS 插件代码实现 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00 |
| `en_05_daemonrescue` (DaemonRescue) | Linux 守护进程实现与补丁 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00 |
| `en_06_irlightreview` (IrlightReview) | 跨组件协议语义独立审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.99, p(model)=1.00 |
| `en_07_coredaemonaudit` (CoreDaemonAudit) | 守护进程正确性审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.99, p(model)=0.98 |
| `en_08_climesonaudit` (CliMesonAudit) | 构建配置合规性审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.99, p(model)=0.98 |
| `en_09_obssafetyaudit` (ObsSafetyAudit) | 互斥锁与线程安全审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.99, p(model)=0.98 |
| `en_10_workspaceresearch` (WorkspaceResearch) | GNOME 扩展技术调研 | **researcher / gemini** | **researcher / gemini** | p(role)=0.99, p(model)=1.00 |
| `en_11_localsendupstream` (LocalSendUpstream) | 网络故障根因排查 | **researcher / gemini** | **researcher / gemini** | p(role)=1.00, p(model)=1.00 |
| `en_12_drmlink` (DrmLink) | DRM sysfs/debugfs 诊断 | **researcher / gemini** | **researcher / gemini** | p(role)=0.99, p(model)=0.99 |
| `en_13_mozillawaylandime` (MozillaWaylandIme) | Wayland IME 崩溃排查 | **researcher / gemini** | **researcher / gemini** | p(role)=1.00, p(model)=1.00 |
| `en_14_finalcpppackagingreview` (FinalCppPackagingReview) | C++ 打包合规性独立审计 | **reviewer / gemini** | **reviewer / gemini** | p(role)=1.00, p(model)=0.99 |
| `en_15_reviewstackcore` (ReviewStackCore) | 协议栈实现一致性审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=1.00, p(model)=0.98 |
| `en_16_suspendreview` (SuspendReview) | 系统级休眠脚本审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=1.00, p(model)=0.99 |
| `en_17_verifynonestedagentapi` (VerifyNoNestedAgentApi) | 证伪断言与代码机制核验 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.90, p(model)=0.98 |
| `en_18_verifyextraexamples` (VerifyExtraExamples) | 示例代码机制审查核验 | **reviewer / gemini** | **reviewer / gemini** | p(role)=0.91, p(model)=0.97 |
| `en_19_featureaudit` (FeatureAudit) | 系统组件盘点与配置审计 | **researcher / gemini** | **researcher / gemini** | p(role)=0.87, p(model)=0.94 |
| `en_20_serviceaudit` (ServiceAudit) | 系统服务依赖分析与排查 | **researcher / gemini** | **researcher / gemini** | p(role)=0.87, p(model)=0.95 |

---

## 5. 实测实验二：误筛案例纠偏与恢复实测

### 5.1 语言判定逻辑校正
- **原逻辑缺陷**：使用 `any('\u4e00' <= char <= '\u9fff')` 实行字符级一票否决，导致包含个别中文路径或注释的纯英文任务被误杀。
- **校正逻辑**：以正文汉字占总字数的比例（以 20% 为阈值）判定主体语言。统计显示：汉字占比 < 1% 的任务共 226 个，断层极为分明。
- **实施方式（用户确认）**：上述比例筛选与误筛案例恢复已通过临时 Bash 命令实际完成，并非通过修改 `extract_omp_prompts.py` 执行。提取脚本未同步这项规则，不代表修正没有落实；本轮不追加脚本改造或重跑要求。

### 5.2 恢复案例实测（8 个案例，双变体共 32 次 Jev 调用）
包含此前因含有 2 个汉字“放行”而被误筛的 `omp_subtask_0221`，以及同批次相关工程用例：

| 案例 ID / 任务名 | 核心任务内容 | Assignment-Only 选定 | Full-Startup 选定 | 置信概率与特征 |
|---|---|---|---|---|
| **`omp_subtask_0221` (CodeReviewer)** | i915 驱动离线更新管道代码审查 | **reviewer / gemini** | **reviewer / gemini** | **p(role)=1.00, p(model)=0.99。正文中含 2 个汉字“放行”，Jev 完全不受干扰，满置信选定** |
| `omp_subtask_0252` (FixSourceIntegrity) | 构建校验代码缺陷修复 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00，坚决导向 DeepSeek |
| `omp_subtask_0262` (ImplementStackCore) | 内核协议栈核心实现 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00，代码编写导向 DeepSeek |
| `omp_subtask_0390` (UpdateSuspendDoc) | S3 休眠技术文档修订 | **executor / gemini** | **executor / gemini** | **p(role)=1.00, p(model)=0.99。产生文件修改，但为文档写作，Jev 精准选 Gemini** |
| `omp_subtask_0060` (DscPatchReview) | 内核 DSC 补丁独立审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=1.00, p(model)=0.97，独立审查选定 Gemini |
| `omp_subtask_0065` (ReviewUdevRule) | Linux udev 规则独立合规审查 | **reviewer / gemini** | **reviewer / gemini** | p(role)=1.00, p(model)=0.99，规则合规审查选定 Gemini |
| `omp_subtask_0325` (NiriSpawnBehavior) | Wayland IPC 事件机制调研 | **researcher / gemini** | **researcher / gemini** | p(role)=1.00, p(model)=1.00，机制推断选定 Gemini |
| `omp_subtask_0318` (AdaptThinkingPatch) | Thinking 逻辑适配代码补丁 | **executor / deepseek** | **executor / deepseek** | p(role)=1.00, p(model)=1.00，代码改动选定 DeepSeek |

---

## 6. 核心结论与洞察

1. **Jev 两阶段自动路由具备极高判定稳健度**：
   - 累计对 **28 个真实历史案例**（双变体共 **112 次 Decisions API 请求**）进行了实测，HTTP 状态码 100% 为 200，无一例语法报错或格式解析异常。
   - 判定置信度极高：角色阶段绝大多数 p >= 0.95，模型阶段绝大多数 p >= 0.98。
2. **两阶段依赖与自编 Preference 完全生效**：
   - **代码修改与构建实现**：全部以 p=1.00 满分选定 DeepSeek。
   - **技术文档编写（Markdown）**：虽然角色是 executor，但第二阶段依然以 p=0.99 选定 Gemini，印证了“Markdown 文本写作非代码实现优势”的有效性。
   - **事实核查与证伪审计**：准确归入 reviewer，打破了发起方习惯随手给 scout 的局限。
3. **零散中文容错能力得到证实**：
   - `omp_subtask_0221` 含有中文字符“放行”，但由于主干结构和技术说明全为英文，Jev 保持了 1.00 满置信判定，证明不需要对包含微量中文术语的英文任务进行过激筛除。
4. **上下文注入（`full_startup`）无负面漂移**：
   - 输入 Token 从 ~3,200 增至 ~6,200，在所有案例中未发生任何角色或模型的判定漂移，28/28 案例两组对照结果 100% 吻合。
   - 单次两阶段决策总时延约 2.4 ~ 2.8 秒，单次两阶段总开销约 0.00015 美元。

---

## 7. 交付工件清单

所有新增文件均保存在 `experiments/jev-routing/`，未改动仓库既有文件：

| 文件路径 | 说明 |
|---|---|
| `CONCLUSIONS.md` | 本结论报告 |
| `README.md` | 实验套件使用指南与参数说明 |
| `extract_omp_prompts.py` | OMP 历史工具调用提示词提取脚本 |
| `omp_subagent_prompts_all.json` | 418 条全量历史子任务提示词原始数据集 |
| `omp_english_benchmark.json` | 20 个典型历史英文任务测试集 |
| `recovered_english_cases.json` | 包含误筛用例在内的 8 个恢复任务测试集 |
| `role_definitions.json` | `researcher` / `executor` / `reviewer` 三角色标准定义 |
| `routing_instructions.json` | 阶段 1 与阶段 2 Jev 决策指引提示词 |
| `model_preferences.json` | 自编的 Gemini / DeepSeek 比较证据与边界偏好 |
| `startup_context.json` | Pi 0.99.2 Fresh 启动环境元数据与工具定义 |
| `run_jev_routing.py` | 支持 OpenRouter Decisions API 的自动化测试脚本 |
| `results/run_20261001_181443.json` | 20 案例 assignment_only 实测产物 |
| `results/run_20261001_181542.json` | 20 案例 full_startup 实测产物 |
| `results/run_20261001_182845.json` | 8 恢复案例双变体实测产物 |
