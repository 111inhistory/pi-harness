# JEV 模型 Preference 实验归档（2026-10-08）

保存本次 15 轮实验，不再依赖临时目录中的结果文件。**实验仅调用 JEV 分类器，没有执行被选中的 Gemini／DeepSeek／Sol，因此不是执行模型质量评测。** 当前用户路由配置没有在归档时修改；未提交。

## 索引

| 目录 | 主要变更 | Gemini | DS | Sol | 成功／失败 |
|---|---|---:|---:|---:|---:|
| `00-all-cases` | 最初未做语言筛选的基线 | 9 | 358 | 105 | 472／0 |
| `01-language-filtered` | 语言筛选后的 Preference 纠偏 | 56 | 132 | 85 | 273／0 |
| `02-scope` | 扩大 DS 推断 scope | 5 | 183 | 85 | 273／0 |
| `03-user-preferences` | 用户重写 Preference | 3 | 185 | 85 | 273／0 |
| `04-text-preference` | 调整文本偏好 | 3 | 185 | 85 | 273／0 |
| `05-no-hallucination-comparison` | 删除双方幻觉比较 | 37 | 151 | 85 | 273／0 |
| `06-common-vs-deep` | common／deep investigation | 23 | 165 | 85 | 273／0 |
| `07-no-ds-investigation` | 删除 DS 调查优势 | 136 | 52 | 85 | 273／0 |
| `08-misleading-direction-limit` | Gemini 复杂调查可能误导 | 136 | 52 | 85 | 273／0 |
| `09-may-not-suitable` | may not be suitable 对照 | 135 | 53 | 85 | 273／0 |
| `10-not-suitable` | not suitable 对照 | 133 | 55 | 85 | 273／0 |
| `11-universal` | DS universal | 128 | 60 | 85 | 273／0 |
| `12-broadly-applicable` | DS broadly applicable across task types | 118 | 70 | 85 | 273／0 |
| `13-guidance-and-prose` | 放宽指引条件、强化 DS 表达缺点 | 128 | 60 | 85 | 273／0 |
| `14-final-partial` | Gemini straightforward to moderately complex；DS all task types | 127 | 54 | 85 | **266／7** |

`manifest.json` 包含每轮 summary、成功案例的角色／模型交叉计数、源文件位置及未压缩内容 SHA-256。各目录的 `config.json` 是当轮真实配置快照；文字差异以它为准，不以目录名概括代替。

## 数据和方法

- 案例来自上两级目录的五个数据集：`original_cases.json`、`omp_subagent_benchmark_cases.json`、`omp_english_benchmark.json`、`recovered_english_cases.json`、`omp_subagent_prompts_all.json`。
- 合计 472 条，跨数据集重复保留，不能当成 472 个独立任务。
- 后续各轮使用完整 `delegated_assignment` 的 U+4E00..U+9FFF 汉字数／全部 Unicode codepoints（含空白及代码）；排除比例 ≥ 20% 的 199 条，保留相同 273 条。这是机械语言筛选，不保证每条都是纯英文。
- 角色输入未变，各轮逐条校验请求相同后复用已支付的角色响应。重新真实调用模型选择；85 条 reviewer 为 singleton Sol/high，跳过第二次分类。每轮新请求 188 次；无自动重试。
- 每轮固定抽样 seed：`d0b7b878b45c919039dca6a1889717b2`，按 SHA-256(seed|dataset|id) 排序取 20 条，无结果导向重抽。
- 主机按有效概率 argmax 选择，平票按候选顺序。响应里的 raw choice 与主机结果可能不同。
- `summary.apiRequests` 包括复用的调用记录，不是新增 HTTP 请求数；新增请求见 `newApiRequests`，新增费用见 `additionalCostUsd`。最初全量基线的 `costUsd` 包括第一次 472 条角色请求费用。
- 全部轮次记录的费用合计 **$0.197635704**，不重复计算复用角色响应；以响应 usage 为依据，并非账单核对。

## 最后一轮是不完整实验

7 条模型请求返回 HTTP 529 `system_overloaded` / `high traffic`：

- `omp_subtask_0147` WpsScale
- `omp_subtask_0155` GeneralGenUpscalers
- `omp_subtask_0177` PowerPolicyScout
- `omp_subtask_0205` WorkerPackager
- `omp_subtask_0220` FinalizeControlAgent
- `omp_subtask_0328` DirectSpawnScopes
- `omp_subtask_0360` VFIOMigrationStopContract

**没有补测这 7 条，也没有用旧结果填充。** 补测脚本当时仅准备，未发出请求，不列为已运行实验。最后一轮只有 266 条可用，与上一版同一成功子集对照为 Gemini 124→127、DS 57→54、Sol 85→85；不能直接用 266 条分布与完整 273 条比较。

## 解读边界

- 分布变化、置信度和历史角色标签都不是准确率。旧 scout 曾直接使用 Gemini，是用户实际分派习惯，不是执行质量的标准答案。
- 常规收集、盘点、上游查找可以适配 Gemini；复杂因果／正确性分析在不同 Preference 下出现大幅摆动。
- `complicated investigation` 没有稳定划出期望边界；删除 DS 的调查优势后，researcher 曾全部选 Gemini。扩大 DS 适用范围又使部分调查回到 DS。
- 这些结果不足以证明 JEV 不理解复杂度，也不足以证明任何模型在这些任务上表现更好。
- 多轮同时修改了多个词句，不能单独归因；未做同配置重复试验来估计随机波动。用户决定停止继续调参，当前版本够用。

## 文件与安全

原始结果、JSONL、抽样、角色响应和运行日志采用 gzip 无损压缩；`config.json`、`summary.json`、筛选及分析资料保留为可读文件。示例：

```bash
gzip -dc 14-final-partial/results.json.gz | less
```

`run.mjs` 和分析脚本是原始执行留档，**保留当时的绝对路径，不应直接原地重跑**。复查以已保存的配置、完整请求／响应及 SHA-256 为依据；若要重新执行，需先另设输出目录并重定向输入路径。最初角色响应缺 SDK `stopReason` 包装的失败日志也保留；修正后通过精确请求校验复用原响应，未把 HTTP 200 的封装失败当成新成功调用。

归档前对所有源文件检查真实密钥特征；未保存临时密钥或实际 Authorization 值。脚本中的 Authorization 构造只是读取 stdin 的运行逻辑，不包含凭据。不要为复跑把密钥写进脚本、命令文件或版本库。
