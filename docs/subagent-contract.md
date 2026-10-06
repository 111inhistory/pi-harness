# Subagent 公开契约

## 状态与范围

本文件是当前公开行为基线。实现可以替换，但外部语义需要显式修订，不能由实现悄悄改变。

实现位于 `src/subagent-runtime.mjs`、`src/subagent-routing.mjs`、`src/subagent-storage.mjs` 及相关模块。子任务使用 Pi `createAgentSession()`：支持 Fresh／Inherited 原子批次、deferred Job、并发与派生限制、取消／`stopping`、Job Budget、类型化完成通知，以及原生会话持久化与恢复。

本轮核心设计演进：

- **极简控制原语**：仅暴露 **`create`**、**`list`**、**`stop`** 三个核心操作，不引入 `wait` / 同步阻塞等待；父 Agent 通过通知感知进度，或随时 `stop` 并拉取历史。
- **废弃虚拟协议 IO**：彻底移除 `protocol-io` 及 `agent://`、`history://` 假文件协议，Pi 原生 `read`/`write` 保持 100% 纯净。
- **IPC 通信通道**：子 Agent 运行时暴露 **Unix Domain Socket**，采用 **NDJSON (Newline-Delimited JSON)** 作为双向报文格式；轻量状态与完成事件通过 **Notification** 投递。
- **双轨历史规范（Dual History Tracks）**：
  1. **Compacted Markdown**（参考 OMP 设计）：高密度的执行与工具摘要，专门面向 LLM 快速消费。
  2. **Clean JSONL**（面向 grep / rg / jq）：剥离逐 token 流式碎片，保留完整结构化调用与结果，方便快速定位与排查。
- **Capability 归一化**：Capability 本身作为阻塞式 **Inherited Subagent** 运行，不再独立维护微 Agent 框架或虚拟协议。
- **自动路由与预算**：Fresh 自动路由依然使用内置 Jev；两层 4×4 拓扑与 Job Budget 保持严格约束。
- worktree／文件系统隔离不在当前计划内。

## 核心边界

1. **会话与实体**：Agent 是可寻址、保留上下文的会话实体；Job 是该 Agent 的一次执行。
2. **Fresh vs Inherited**：Fresh 不继承父聊天历史；Inherited 克隆创建时父会话的有效上下文快照，之后独立演进，互不自动同步，共享工作目录。
3. **零侵入性**：Subagent 与 `work` 彻底解耦；创建、结束、失败或取消均不隐式修改 `work` 树。
4. **无需 Wait 语义**：任务默认 deferred 执行；父 Agent 无需在原地阻塞等待，需要终结时直接 `stop`，随后读取双轨历史。
5. **真实 I/O**：拒绝一切“假装成文件”的虚拟协议方案。

---

## 核心生命周期接口

Subagent 系统仅对外暴露三个正交的生命周期原语：

### 1. `create`（原 `task` 批量创建入口）

原子创建一批子任务会话：

```json
{
  "context": "这一批任务共享的显式背景说明。",
  "tasks": [
    { "name": "ParserAudit", "task": "检查解析器的错误恢复行为并报告问题。" },
    { "name": "DesignFollowup", "task": "基于当前讨论继续推演模块契约。", "inheritContext": true }
  ]
}
```

```ts
type SubagentCreateBatch = {
  context?: string;
  tasks: {
    name?: string;
    task: string;
    inheritContext?: boolean;
  }[];
};
```

- **参数规则**：
  - `tasks` 数组不能为空。`task` 为具体指令，`context` 为批次共享背景。
  - `inheritContext: true` 创建 Inherited Subagent（克隆父上下文快照）；未设置（默认）则为 Fresh Subagent（走 Jev 自动路由）。
  - 不接受手工指定 `model`、`thinking`、`role` 等参数；路由策略由 Harness 内置 Jev 全权决定。
- **原子性与校验**：
  - 先校验拓扑准入（4×4 上限）与参数完整性，校验通过后原子注册。
- **返回值**：
  - 返回每个子任务的稳定唯一 ID、初始状态及通信 Socket 路径：

```json
{
  "items": [
    {
      "name": "ParserAudit",
      "agentId": "agent_7f3c21e4b9a2-01",
      "jobId": "job_7f3c21e4b9a2-01",
      "status": "running",
      "socketPath": "/tmp/pi-subagents/agent_7f3c21e4b9a2-01.sock"
    }
  ]
}
```

### 2. `list`（状态与花名册查询）

查询当前活跃及历史的 Subagent / Job 状态：

```json
{
  "agentId": "agent_7f3c21e4b9a2-01" // 可选，为空则返回全局花名册
}
```

- 返回内容包括：
  - Agent 层次深度（Depth 1 / Depth 2）。
  - 当前状态（`queued` / `running` / `stopping` / `completed` / `failed` / `cancelled`）。
  - 已消耗预算（Model Calls / Active Time）与额度信息。
  - 双轨历史文件的本地存储路径。

### 3. `stop`（中止与取消）

优雅停止正在运行或排队中的子任务：

```json
{
  "jobId": "job_7f3c21e4b9a2-01"
}
```

- **行为**：
  - 若任务处于 `queued`，立即移出队列并标记为 `cancelled`。
  - 若任务处于 `running`，向子任务发送中止信号并置入 `stopping` 状态，等待底层当前工具或模型请求安全退出，完成后释放并发槽位并落盘历史。
  - 任务停止后，父 Agent 即可随时直接检索并读取该子任务的双轨历史。

---

## 通信架构：Unix Domain Socket 与 Notification

彻底废弃原先的 `agent://` 与 `protocol-io` 虚拟协议，通信下沉为真实的 IPC 与系统通知。

### 1. Unix Domain Socket (UDS)

- **路径规则**：每个活跃 Subagent 启动时在系统运行时目录创建专用 Socket，例如：
  `/tmp/pi-subagents/<agentId>.sock`（或 `$PI_CODING_AGENT_DIR/run/<agentId>.sock`）。
- **报文协议**：统一采用 **NDJSON（Newline-Delimited JSON，换行分隔的 JSON）**。
- **报文格式示例**：
  ```json
  {"type": "message", "content": "请重点检查第 42 行的边界处理", "timestamp": 1712000000}
  {"type": "steer", "content": "停止当前搜索，转向测试覆盖分析", "timestamp": 1712000010}
  ```
- **特性支持**：
  - 真实的双向全双工通道。
  - 天然具备操作系统的背压控制（Backpressure）。
  - 对端异常崩溃时触发断开通知，避免无感知死锁。

### 2. 轻量级 Notification

- 状态跃变（如进入 `running`、遇到断点/需审批事件、达到终态）时，子 Agent 向父会话投递原生 typed notification。
- **通知原则**：
  - 通知是只读事件通知，不附带海量聊天正文，不自动触发父 Agent 轮次（`triggerTurn: false`）。
  - 父 Agent 在下一次正常轮次中，或通过外部观察可感知该通知。

---

## 双轨历史规范（Dual History Tracks）

每个子 Agent 产生的历史不再抽象为虚拟 URL，而是以物理文件清晰落盘为两种互补的形态：

```
.pi/subagents/<agentId>/
  ├── summary.md        # Compacted Markdown 历史（LLM 消费友好）
  └── session.clean.jsonl # Clean JSONL 历史（grep / rg / jq 检索友好）
```

### 1. Compacted Markdown 历史（参考 OMP 设计）

- **设计目标**：高信息密度、低 Token 占用、结构清晰，直接作为 Markdown 供 LLM 或人类阅读。
- **结构规范**：
  - **元数据头**：任务目标、角色/模型标签、执行时长、消耗 Model Calls / Tokens。
  - **关键行动日志**：以列表/小节形式浓缩列出执行了哪些核心工具、修改了哪些文件、遇到何种警告。
  - **核心产出与结论**：子 Agent 的最终输出与发现总结。

### 2. Clean JSONL 历史（grep / rg / jq 友好）

- **设计目标**：结构化、行式存储、剔除流式碎片。
- **规范与清洗规则**：
  - 剥离所有逐 token 的流式 delta / stream chunk 事件。
  - 仅保留完整的语义行：
    ```json
    {"type":"message_start","role":"assistant","timestamp":1712000000}
    {"type":"tool_call","tool":"bash","input":{"command":"npm test"},"toolCallId":"call-1"}
    {"type":"tool_result","tool":"bash","toolCallId":"call-1","isError":false,"details":{"exitCode":0}}
    {"type":"message_end","role":"assistant","content":"全部测试通过"}
    ```
  - **工具链友好度**：
    - 使用 `rg 'tool_result.*isError":true'` 秒级搜索错误。
    - 使用 `jq 'select(.isError == true)'` 精确提取异常详情。

---

## Capability 归一化规范

原先独立的 Capability Broker 与内部微会话模型彻底归一：

1. **定位**：`capability` 无参工具本质是一个**阻塞式运行的 Inherited Subagent**。
2. **执行流程**：
   - 触发后，克隆父 Agent 当前快照，以继承上下文启动。
   - 在子上下文中并发执行对已注册 Tools、MCP Servers、Skills 以及 npm 远端元数据的检索。
   - 将匹配与激活建议汇总格式化为一份标准的 Markdown 报告。
   - 子会话完成退出，向父 Agent 返回该 Markdown 结果。
3. **零虚拟协议**：不再注册 `tool://`, `mcp://`, `skill://`, `npm://`，所有读取行为直接基于工具返回的标准 Markdown 渲染。

---

## 拓扑、并发与 Budget 硬约束

- **两层 4×4 派生限制**：
  - Main（Depth 0）最多允许 4 个活跃 Depth 1 子 Agent。
  - Depth 1 最多允许 4 个活跃 Depth 2 子 Agent；Depth 2 禁止继续派生。
- **并发控制**：
  - 全局执行并发上限为 4，超出限制的任务自动在队列（`queued`）等待。
- **硬性 Budget 上限**：
  - **Depth 1**：Soft 160 / Hard 200 Model Calls；Active Time Soft 90 / Hard 120 分钟；Lifetime 24 小时。
  - **Depth 2**：Soft 48 / Hard 64 Model Calls；Active Time Soft 45 / Hard 60 分钟；Lifetime 12 小时。
  - 超出 Hard 阈值时触发 `budget_exceeded` 熔断，安全停止子任务并冻结历史。
