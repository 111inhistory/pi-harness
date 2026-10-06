# Subagent 公开契约

## 状态与范围

本文件是当前公开行为基线。实现可以替换，但外部语义需要显式修订，不能由实现悄悄改变。

实现位于 `src/subagent-runtime.mjs`、`src/subagent-routing.mjs`、`src/subagent-storage.mjs` 和 `extensions/subagent.mjs`。子任务使用 Pi `createAgentSession()`：支持 Fresh／Inherited 原子批次、短统一 ID（Job 与 Agent 概念耦合）、deferred Job、并发与派生限制、取消／`stopping`、Job Budget、通过 write Unix Socket 实现单向消息投递与自动通知、双轨历史（Compacted Markdown + Clean JSONL），以及原生会话持久化与恢复。

本轮决策：

- Fresh 自动路由直接使用 Pi 内置 TypeSafe／OpenRouter 的 Jev，不另造请求、鉴权或通用分类器框架。
- 结构化结果返回不做，不保留 `outputSchema`／`schemaMode` 目标。
- blocking、`waiting` 与同步等待暂缓；所有任务仍为 deferred，不提供 `wait` 接口，直接 `stop` 后读取历史。
- 废除原虚拟协议（Protocol IO 及 `agent://`、`history://`），Pi 原生工具回归纯粹文件系统；通信下沉到 Unix Domain Socket（NDJSON），原生 `write` 工具通过更换 write backend 适配 Socket 单向投递。
- 双轨历史直接暴露物理路径给发起者：Compacted Markdown（参考 OMP，供 LLM 读）与 Clean JSONL（去流式碎片，供 grep/rg/jq 检索）。
- 消息通过向 Socket 写入自动投递给对应 Agent，无需额外设计通知总线；仅在 subagent 异常时由宿主向上层抛出 Notification。
- 广播必须分层次，不能只叫笼统的 `all`：严格按拓扑深度隔离，只发给发送者的直接子级（Main 发给 Depth 1，Depth 1 发给自己的 Depth 2），不跨层递归，不发给兄弟或祖先。
- 持久化复用 Pi 的 SessionManager JSONL 与根会话 custom entry，不另写数据库或日志引擎。
- worktree／文件系统隔离不在当前计划内。DeepSeek Search 是现成插件，由用户自行安装，本模块不增加安装或接入代码。

## 核心边界

1. Agent 与 Job 概念完全耦合，使用统一简短 ID。层次化命名规范：Depth 1 为 `sub_01` ~ `sub_04`；Depth 2 由父级 ID 派生，为 `<parentId>_01` ~ `<parentId>_04`（如 `sub_01_01`），直观清晰且天然防止冲突。显式写入可使已 stop 的 Agent 自动 revive 续跑。
2. Fresh 不继承父聊天历史；Inherited 只复制创建时的有效上下文，之后不自动同步，也不复制文件系统。
3. 调用方提交工作说明，角色、模型、thinking 与工具装载由 Harness 决定，不是公开旋钮。
4. Subagent 与 `work` 独立：创建、结束、失败或取消均不隐式修改工作项，也不自动编排下一步。
5. 通信采用 Unix Domain Socket 单向投递，不走双向连接应答；子 Agent 进展与产出通过双轨历史文件读取。
6. 完成事件是结果事实，不是继续执行的授权；失败、取消与重启都不自动重试工作。
7. 双轨历史物理文件可重复读取；stop 后写 socket 自动 revive 续跑，在已有历史文件上以 append-only 追加写入，不产生碎片化多重历史文件。

## `subagent_create`（原 `task` 批量创建入口）

唯一的批量创建入口：

```json
{
  "context": "这一批任务共享的显式背景。",
  "tasks": [
    { "name": "InspectParser", "task": "检查解析器的错误恢复行为并返回问题清单。" },
    { "name": "ContinueDesign", "task": "基于当前讨论继续检查契约。", "inheritContext": true }
  ]
}
```

```ts
type TaskBatch = {
  context?: string;
  tasks: {
    name?: string;
    task: string;
    inheritContext?: boolean;
  }[];
};
```

- `tasks` 不得为空，`task` 是独立任务指令，`context` 是该批次的共同背景。
- 不设置 `inheritContext: true` 就是 Fresh；同一批次可以混合 Fresh 与 Inherited。
- 不接受 `agent`、`role`、`model`、`thinking`、`effort`、`provider`、`preference`、`tools` 或结果 Schema；未知字段使整个批次校验失败，没有兼容别名。
- 先校验整个批次和拓扑准入，再原子注册；失败不留下半创建任务。注册后一个 Job 的失败或取消不影响兄弟 Job。
- 输入数组不表示依赖顺序；返回条目保持输入顺序。
- `subagent_create` 不等待路由或任务完成，返回统一短 ID、当时状态、通信 Socket 路径及直接暴露的双轨历史文件路径：

```json
{
  "items": [
    {
      "id": "sub_01",
      "name": "InspectParser",
      "status": "running",
      "socket": "/tmp/pi-subagents/sub_01.sock",
      "history": {
        "summary": ".pi/subagents/sub_01/summary.md",
        "cleanJsonl": ".pi/subagents/sub_01/session.clean.jsonl"
      }
    }
  ]
}
```

条目没有 `delivery` 字段，也不内联完整结果。发起者可通过 write socket 单向投递消息，通过文件系统直接读取 `summary.md` 或对 `session.clean.jsonl` 进行 grep/rg/jq 检索。Inherited 中不能移植的外部扩展工具仍通过 `warnings` 明示，不因移除工具选择参数而静默消失。

## Fresh 自动路由

配置集中在 [`config/subagent-routing.json`](../config/subagent-routing.json)。两次 Jev 请求有串行依赖，不能合并成两个独立问题：第二次必须读到第一次实际选中的完整角色定义。

```mermaid
flowchart TD
  A[原始 context 与 task] --> B[Jev：选择角色]
  B --> C[Jev：原任务加已选角色全文，选择模型]
  C --> D[本地合成 thinking]
  D --> E[原生 Pi 子 Session 执行]
  E --> F[最终文本包含实际困难度与事实理由]
```

### 配置与原生调用

| 项目 | 默认值 |
| --- | --- |
| 分类器 | provider `openrouter`，id `~typesafe/jev-latest` |
| TypeSafe 替代配置 | provider `typesafe`，id `jev-latest` |
| Gemini 候选 | provider `openrouter`，model `~google/gemini-pro-latest` |
| DeepSeek 候选 | provider `openrouter`，model `~deepseek/deepseek-pro-latest` |
| 角色期望 thinking | researcher：medium；executor、reviewer：high |
| 两个候选的策略区间 | low 至 high |

这些 ID 来自本机 Pi 0.99.2 的内置目录；`latest` 别名的实际服务版本由提供商解析，不把别名写成固定模型版本。

调用使用 `ctx.modelRegistry.findOfType("classifier", provider, id)` 与 `ctx.modelRegistry.classify(model, { state, questions }, { signal })`。模型执行使用原生 registry 里的 chat model。凭据由 Pi 管理，本模块不实现 HTTP、密钥存储或提供商切换：默认需要配置 OpenRouter；分类器改成 TypeSafe 后，默认执行候选仍需要 OpenRouter 凭据，除非也修改候选绑定。

配置在模块中读取并缓存；修改配置后重启 Pi 可确保新 Fresh Agent 使用新配置。已有会话继续使用已经选定的角色、实际模型、thinking 与工具，不因配置变化或续跑重新分类。

### 两阶段输入

有非空 `context` 时组装：

```text
# Batch context

<context 原文>

# Task

<task 原文>
```

无背景时使用 `task` 原文。不摘要、不翻译、不裁剪，也不设 CJK 拒绝门槛。

1. **选择角色**：state 为 `{ delegated_assignment }`，单选问题 `role` 的 criteria 是每个角色的完整指令。按实际交付物、范围与授权选择，不预测模型或 thinking。
2. **选择模型**：沿用同一作业文本，追加 `selected_role: { id, instructions }`；`instructions` 是所选角色全文，不是角色标签。问题 `model` 的 criteria 是候选模型 Preference，不再重选角色。

使用原生 choice answer 的有效概率分布取确定性的最大项；并列保持配置顺序。无效回答、分类器错误、取消、预算不足或所选模型不在目录中，都显式失败，不补默认选择、不自动重试或换提供商。

### 角色、Preference 与 thinking

- 当前配置包含 researcher／executor／reviewer。角色说明涵盖责任、工作方式、权限边界与完成要求；工具装载另由配置给出，Jev 不生成工具配置。
- 研究以理解、诊断、解释和方案为交付物；执行以授权改动为交付物，包括改动内部的调查和验证；审查独立报告问题，不默默代为修复。
- 模型与角色是独立维度，没有固定 `(model, role)` 组合。Preference 记录本地经验中的优势、局限与取舍，不是通用 benchmark 或价格排名。
- 角色期望 thinking 先限制在候选的 `[min, max]` 区间，配置只允许 low／medium／high，自动路径不超过 high；Pi 根据实际模型能力做最终 clamp，不在 Harness 再写一套模型能力规则。
- 完成要求包含实际困难度 low／medium／high 加一句事实理由。它是最终文本的一部分，随结果与历史保存；没有结构化提交、强制解析、第三次分类、presetFit 或自动学习。
- 角色指令与工具装载不是文件系统沙箱；所有 Agent 当前共享工作目录。

实验依据保留在 [路由实验记录](subagent-routing-experiment.md) 和 [后续评测结论](../experiments/jev-routing/CONCLUSIONS.md)：前者 10 案例／40 请求，后者 28 历史案例／112 请求。生产配置复制了后续实验的角色、指令与 Preference，不在运行时依赖实验目录。旧实验与离线集成验证都不能证明候选模型的实时执行质量、中文表现或困难度反馈校准效果。

## 上下文与续跑

### Fresh

初始上下文包含 Pi 基线系统提示词、所选角色全文、内部工具装载，以及该条目的 `context` 与 `task`。模型与 thinking 使用路由结果。Fresh 必须自包含，Harness 不猜测应该补传的父历史或兄弟任务。

### Inherited

`inheritContext: true` 在接受批次时一次性捕获父会话的系统提示词、实际模型、thinking、工具与有效原生历史，包括已经生效的工具结果和 Compact 摘要。

共享的 `captureInheritedContext` 读取 SessionManager header 与当前 branch，为每个子会话生成独立 Session ID，复制原生条目而不压平成文本。保留会话里真实存在的 thinking、签名、已完成 tool call／tool result；只移除尾部尚无结果的调用，若该消息变空则移除并重新链接后续条目。这里不声称获得提供商未暴露的内部推理。

同批子会话从同一时点开始，条目数组独立，只追加自己的任务，之后不与父或兄弟同步。

- 当前仍保留父模型、身份与上下文，不经过 Fresh Jev 路由；未来是否允许重选未定案，本轮不改变继承语义。
- Inherited 不能再创建 Inherited；具有 `task` 权限且深度允许时可以创建 Fresh。
- Pi 公开 API 不提供外部扩展工具的执行句柄，因此目前只移植原生与 Harness 支持的工具，遗漏有明确警告。
- 不复制目录、Git branch 或 worktree，不提供隔离参数。

### 显式续跑与 Revive 治理

向已 `subagent_stop` 或处于 idle 的 Agent 对应的 Unix Socket 写入新消息（NDJSON 报文）时，自动 revive 续跑，取得全新 Budget，并继续已有原生上下文及实际模型、thinking 和 active tools（包括 Capability 激活的工具）。不重走已经完成的角色／模型路由。

已进入历史的原任务不重复注入。若旧运行在排队或初始化时结束、原任务尚未记录，保留初始 seed，并在新的显式消息触发时带入原任务。路由从未成功完成的 Fresh seed 可以在这次新运行中完成首次路由；这不是自动重试。

**防止资源泄漏的硬性治理规则**：
1. **单一稳定 Socket 治理**：每个短 ID（如 `sub_01`）终身只拥有一个唯一的 Socket 文件（`/tmp/pi-subagents/sub_01.sock`）。Agent 处于 stopped 状态时，Socket 由宿主监听器维持接管，收到新写入自动 revive 该会话，严禁每次 revive 创建新 socket 导致 socket 泄漏过量。
2. **单一稳定双轨历史治理**：每个短 ID 终身只对应一对固定的历史文件（`summary.md` 与 `session.clean.jsonl`）。revive 续跑产生的记录以 Append-Only 方式在原有文件末尾追加（Markdown 追加续写小节，JSONL 追加新行），严禁产生多份分裂碎片化的历史文件。

## 调度、状态与 Budget

当前所有 Job 都是 deferred。blocking、混合等待批次、`waiting` 和同步等待暂缓，不提供 `wait` 接口（随时可 `subagent_stop` 并拉取历史）。状态通过 `subagent_list` 查询，历史直接通过双轨文件读取。

### 拓扑与并发

- Main 为 depth 0，最多 4 个活跃直接子 Agent。
- 每个 depth-1 Agent 最多 4 个活跃 depth-2 子 Agent；depth 2 不注册 `task`。
- `queued`、`running`、`stopping` 均占父节点的活跃名额。原生运行退出并进入终态后释放。
- 全局执行并发为 4，超出时排队；排队不能绕过每父节点的宽度限制。
- 包含 Main 在内最多 21 个**活跃** Actor；已完成的 idle Actor 可以继续保留，不把它们算作活跃名额。

Agent 状态为 `running`（有非终态 Job）或 `idle`。`parked` 资源策略未实现。

Job 状态为 `queued`、`running`、`stopping`、`completed`、`failed`、`cancelled`。取消运行中的 Job 或触发预算终止时，先进入 `stopping`，直到原生模型／工具退出；期间保留并发槽位并拒绝新消息为 `agent_busy`，不让同一 Agent 重叠运行。

### 每 Job 的固定预算

| 深度 | Model Calls Soft/Hard | Active Time Soft/Hard | Lifetime |
| --- | ---: | ---: | ---: |
| 1 | 160 / 200 | 90 / 120 分钟 | 24 小时 |
| 2 | 48 / 64 | 45 / 60 分钟 | 12 小时 |

- 聊天、Compact 摘要及摘要重试在共享 stream 边界预扣；Fresh 的两次 Jev classify 也各预扣一次同 Job 的 Model Call。Tool Call 不单独计数。
- 第 hard 次可以执行，预计 hard+1 在请求前拒绝。达到 Soft 只提示一次，不暴露具体阈值。
- Active Time 只在持有执行槽位时累计；queued 不计，stopping 等实际退出期间仍计。
- Model Calls／Active Time 超限使用 `budget_exceeded`，lifetime 到期使用 `job_expired`；最终为 failed，不追加收尾模型调用，保留部分结果与历史。
- Budget 不由模型配置，不跨父子聚合；`subagent_list` 只给只读用量、phase 与终态，不暴露 Profile 上限。
- 恢复只保留历史预算快照，不继续跨进程的 monotonic clock；显式续跑是新 Job、新 Budget。

## 通信架构：Write Socket 与 异常 Notification

彻底废弃原先的 `agent://` 与 `protocol-io` 虚拟协议，通信与交互完全收敛。

### 1. Write Socket 单向消息投递

- **单向投递原则**：发起者通过向对应 Subagent 的 Unix Domain Socket（如 `/tmp/pi-subagents/<id>.sock`）单向写入 NDJSON 报文完成消息投递，不走双向连接应答；子 Agent 的产出与进展统一通过双轨历史文件读取。
- **更换 Write Backend**：原生 `write` 工具通过更换其底层的 `WriteOperations`（Pi 原生支持的可拔插选项）适配 Unix Domain Socket。当向 `.sock` 文件写入时，底层使用 `net.connect()` 进行单向 NDJSON 写入；向普通文件写入时，原样使用文件系统写操作。
- **报文格式**：统一采用 **NDJSON（Newline-Delimited JSON，换行分隔的 JSON）**。每条消息必须为完整单行 JSON 并以 `\n` 结尾。
- **自动投递（Notification 内置）**：
  - 发起者向 Socket 投递消息后，由底层的通信监听器自动转发并唤醒对应 Subagent 处理，**不需要额外设计通知总线机制**。

| 目标 Agent 接收状态 | 写入行为 |
| --- | --- |
| `running`（正在执行） | 触发底层原生 steer；若在两轮/工具调用之间，先缓冲并在下一轮排空 |
| `queued` | 缓冲入队，待任务获取执行槽位启动时作为初始追加消息接收 |
| `stopping` | 拒绝写入并报错 `agent_stopping`；需等待其完全退出进入 stopped 后再写入以触发 revive |
| `stopped` / `completed` / `failed` | 自动触发 **revive** 续跑！重新申请槽位，在原有双轨历史中追加写入 |

### 2. 异常 Notification（唯一外部通知例外）

- **触发条件**：仅在 Subagent 出现非预期异常（如进程崩溃、工具致命失败、单调时间硬超时、超出 Model Call 预算被硬熔断）时触发。
- **机制**：由 Harness 宿主监控层捕获后，向上层父会话抛出轻量级的错误 Notification，告知发起者该 Subagent 异常终结及其退出原因。发起者随后可查阅 `summary.md` 或检索 `session.clean.jsonl` 排查详情。

### 3. 分层次直接子级广播（Hierarchical Direct-Child Broadcast）

广播必须具备清晰的层次界限，**不能只叫笼统的全局 `all`**，以防止全局越权与混淆：

- **分层端点规范**：
  - **Main（Depth 0 发起者）**：广播端点为 `/tmp/pi-subagents/main/children.sock`（或目标短名 `children`），仅广播给其直接子级（Depth 1 全体活跃 Agent）。
  - **Depth 1 Agent（如 `sub_01`）**：广播端点为其专属子级端点 `/tmp/pi-subagents/sub_01/children.sock`（或 `sub_01:children`），仅广播给它自己派生的直接子级（Depth 2 全体活跃 Agent）。
  - **Depth 2 Agent**：禁止派生子 Agent，因此不存在下级广播端点。
- **广播行为**：
  - 向对应的 `children.sock` 单向写入 NDJSON 报文后，宿主原子获取发送者**当前直接子 Agent** 的列表快照，并逐一并发投递；
  - 严格禁止跨层递归扩散（Main 绝不直接穿透广播到 Depth 2）；禁止向父级或平级兄弟广播；
  - 没有子节点时视为空成功返回；部分子节点处于 stopped 状态时，写入同样触发其以原 ID 进行 revive。

## 持久化、分支与 `/reload`

### 存储位置

- 根会话通过 `pi.appendEntry("subagent-state", checkpoint)` 保存注册表、Job、不可变初始结果、预算快照和 Actor 配置。这是非模型上下文元数据，恢复时只读取 `ctx.sessionManager.getBranch()` 上的最新 checkpoint，不合并废弃分支。
- 子会话位于 `<agentDir>/subagent-sessions/<rootSessionId>/<id>.jsonl`，使用 Pi 原生 SessionManager 读取和追加。
- Inherited 的精确捕获分支只做一次标准 Pi JSONL seed 落盘；随后完全交给原生会话管理。根 checkpoint 只保留 seed 引用与长度，不递归内嵌完整父历史。
- Job 历史保存原生 start/end entry 边界；Actor 保存自己的当前 leaf。读取历史使用原生 `getBranch()`，不把文件追加顺序当成上下文分支。
- SDK 明确使用 in-memory 根会话时不写这些文件，也不承诺重启恢复。

### 恢复规则

- `/reload` 或重新打开同一持久化根会话，恢复相同 Actor／Job ID、初始结果、模型、thinking、工具、角色与原生上下文。
- 新创建的 ID 使用新的随机命名空间，废弃分支或旧运行实例的地址不会意外命中另一个新 Actor。其它根会话不通过猜 ID 获得访问。
- 恢复以选中根分支的 checkpoint 为准：子会话回到对应 leaf，不带入后来废弃分支的轮次。原生文件中超出 checkpoint 的尾部不会自动被采纳或重放。
- 原生消息结束时更新历史边界和 checkpoint；首次任务已记录与否也按保存的分支判断，不能根据另一个分支的消息清除待发送任务。
- 恢复时的 queued／running／stopping Job 变为 `failed`，错误为 `interrupted`；不自动重跑模型、工具或副作用。用户／Agent 的新显式消息才创建续跑 Job。
- 正常生命周期切换先停止旧服务并等待原生 Job 实际退出，再暴露新服务；旧回调不能污染后来的根会话，也不能与同一 Actor 的新运行重叠。
- checkpoint 或 seed 损坏、文件缺失、原生 leaf 不存在时显式报错，不悄悄初始化空上下文。存储写入失败会报告，不把内存里的已发生副作用伪装成已回滚。
- `/reload` 重新注册当前 Session 的协议路由；每个会话拥有独立 EventBus，不泄漏到兄弟会话。

## `subagent_list`、`subagent_stop` 与结果读取

生命周期控制与查询收敛为两项核心操作：

```
Main/Subagent
  ├── 状态查询 ──────> subagent_list(id?)
  ├── 优雅停止 ──────> subagent_stop(id)
  └── 结果/进展读取 ──> read / grep 文件: summary.md & session.clean.jsonl
```

### 1. `subagent_list`

查询当前活跃及历史的 Subagent 状态与花名册：

```json
{
  "id": "sub_01" // 可选，省略则列出当前根会话下的全部 Agent
}
```

返回值示例：

```json
{
  "items": [
    {
      "id": "sub_01",
      "name": "InspectParser",
      "depth": 1,
      "parentId": "main",
      "status": "running",
      "budget": {
        "modelCalls": 12,
        "activeTimeMs": 45000,
        "phase": "normal"
      },
      "socket": "/tmp/pi-subagents/sub_01.sock",
      "history": {
        "summary": ".pi/subagents/sub_01/summary.md",
        "cleanJsonl": ".pi/subagents/sub_01/session.clean.jsonl"
      }
    }
  ]
}
```

### 2. `subagent_stop`

优雅停止指定短 ID 的任务：

```json
{
  "id": "sub_01"
}
```

- **行为**：
  - 若任务处于 `queued`，立即移出队列并标记为 `cancelled`；
  - 若任务处于 `running`，向子任务发送中止信号并置入 `stopping` 状态，等待底层当前工具或模型请求安全退出，完成后释放并发槽位并刷盘双轨历史；
  - 任务停止后，发起者即可直接读取暴露的 `summary.md` 或 `session.clean.jsonl`；
  - 不删除 Agent 实例，不回滚已经发生的外部副作用；随后向该 Agent 的 Socket 写入消息即可直接触发 revive。

### 3. 结果与历史读取

不提供 `wait` 同步等待接口，发起者随时可直接 `subagent_stop` 并读取历史。

结果与历史直接通过双轨物理文件读取，由 Harness 宿主在子会话生命周期内维护：

- **Compacted Markdown（`summary.md`）**：参考 OMP 风格，由宿主在各轮次及进入终态时浓缩维护任务目标、关键工具调用摘要与核心产出，专供 LLM 低成本阅读理解。
- **Clean JSONL（`session.clean.jsonl`）**：由宿主在各事件发生时即时 Append 落盘，剥离 token-by-token 流式碎片，保留完整结构化记录（`message_start`、`tool_call`、`tool_result`、`message_end`），专供 `grep`、`rg` 与 `jq` 高效定位排查。
- 历史文件支持重复读取；stop 后写 socket 自动 revive 续跑，在已有文件上以 Append-Only 追加写入，不产生多重文件碎片化。
- 结构化结果校验不在契约中；最终答案保持原始文本。

## 错误与未做事项

输入／权限／拓扑校验在注册前失败；注册后的路由、启动或执行失败只影响对应 Job。被拒绝的消息不进入待投递状态。失败会话保留错误与已有历史，不自动重试；停止中的 Agent 必须先实际退出才能被显式唤醒。

当前不做：结构化结果、worktree 隔离、消息回执／收件箱／handover、自动级联取消、自动多 Agent 编排、未来分类器适配框架，以及 DeepSeek Search 的替代实现或安装代码。

暂缓：blocking／waiting／同步等待，以及 parked／资源回收策略。仍需实际使用评估的事项包括真实模型质量、Prompt Cache 的费用与安全复用、底层工具取消能力和长期会话保留边界。Inherited 是否允许重新路由仍未定案；本轮保留既有继承行为。

Shell 服务、Watcher、调试器等后台进程不属于 Agent Job，本模块不代替 tmux Skill 或其它进程管理机制。

## 验证边界

本机 Pi 0.99.2 的离线 SDK 场景使用真实会话、工具调用、消息与持久化流程，模型响应由本地脚本提供，禁止网络：覆盖两阶段路由、模型选择与预算、签名块继承、两层广播边界、类型化非唤醒通知、`/reload`，以及新进程恢复与中断后显式续跑。审阅修复后额外验证：空闲 Actor 的完成通知经立即 reload 保留、异步通知失败不泄漏拒绝、连续十轮已接受消息完整排空、损坏 Actor 记录拒绝恢复，以及 active-time 硬限先进入 stopping 并拒绝消息、等待原生退出后才发布失败。Runtime／存储回归检查还覆盖启动句柄尚未返回时的预算终止与继承历史不重复序列化。原生文件 I/O、Capability 同模型 low 与 Compact 预算还有此前独立离线验证。

这些验证不产生真实调用费用，也不声称验证了提供商在线鉴权、实时模型质量或生产部署。
