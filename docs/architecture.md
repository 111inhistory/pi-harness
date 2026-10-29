# 当前架构

公开行为以[接口契约](interface-contract.md)为准。本文描述代码中的职责和边界，不是重写计划，也不表示全部边界已验证。存储字段见[存储说明](subagent-storage.md)，验收缺口见[已知问题](known-issues.md)。

## 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| `runtime.ts` | Actor 拓扑、Job 状态、名额、停止原因、续跑准入、中断恢复与终态事件 | SDK Session、Socket、原生文件解析 |
| `native-runner.ts` | Session 执行句柄、输入准入、在途 steer、原生输入缓冲和清理 | 裁定 Job 状态、决定空闲唤醒、写根终态 |
| `actor-sessions.ts` | Actor 的角色／模型身份、原生 manager 与已记录锚点、身份补丁 | Job 状态和停止排序 |
| `native-session.ts` | Settings、ResourceLoader、子扩展装配及 SDK 会话创建 | 路由、任务结果裁决 |
| `root-service.ts` | 组装上述模块，根事件写入、历史视图和故障锁存 | 第二套 Job 状态机 |
| `extension.ts`、`lifecycle.ts` | SDK 生命周期钩子、代次、退役期限和资源隔离 | 伪造物理退出、重跑已结束任务 |
| `surface.ts`、`message-write.ts` | 工具声明、调用方身份、输入捕获、原生文件写入与消息回执 | 持有全局注册表或执行循环 |
| `listeners.ts`、`ipc/` | 端点目录、监听、报文结构和平台资源归属 | 用显示窗口决定可达性、另写广播状态机 |
| `native-delivery.ts`、`delivery.ts` | 独立通知封装、检查原生交接结果、明确拒收后的保留会话追加 | 模型已读回执、自动重发或消息合并 |

Runtime 的 `job.status` 是领域事实。Runner 的输入准入栅栏表示原生句柄是否还能接收消息，不表示 Job 已停止。取消后，Job 仍占用 Actor 与名额，直到原生执行退出并完成收尾。

## 创建、执行与恢复

Fresh 在自己的 Job Budget 内路由；Inherited 保留捕获的模型、thinking、系统提示词与可移植工具。路由完成的 Actor 在续跑时沿用已记录身份，不重新选择角色。

Runner 通过 `openSubagentExecution` 获得 SDK Session。共享执行句柄负责 abort 和 cleanup；Root 不用超时竞争强制 dispose 一个仍在执行的 Session。

恢复分两部分：Actor 层读取原生文件、解析身份和历史区间；Runtime 校验完整拓扑与 Job 关系，再统一裁定未结束 Job 为 `job_interrupted`。适配层不预先改写终态或另算停止排序。恢复不会自动重跑或重发旧通知。

持久化 Actor 在结束后解除 manager 引用，下次按需打开。纯内存 Actor 保留唯一的原生对话，不能套用文件型 Actor 的释放规则。

## 消息与回执

### 宿主工具

```text
write / msg_write
  → 当前调用方的受管端点解析
  → Runtime.sendMessage
  → 单个接收回执，或广播 sent / errors
  → 工具结果
```

宿主消息不再绕本进程 Socket 回环。SDK `WriteOperations.writeFile` 没有回执返回值，因此工具执行层单独捕获并返回 Runtime 结果；每次执行有独立捕获，不共享并发回执。

普通文件仍由 SDK 处理路径展开、写入和逐路径变更队列，不要求 Subagent 服务可用。IPC 保留目录不能作为普通文件目录。非受管 Unix Socket 与 Windows Named Pipe 被拒绝，不能借 `write` 连接任意服务。

广播只面向发送者的全部直接子节点。每个接收者沿用普通发送的准入和续跑规则。部分失败逐项返回，不重发已成功的接收者。

### 外部 Socket

```text
外部进程 → 自有端点 → NDJSON 结构检查 → Runtime.sendMessage
```

报文应显式提供非空 `from` 和字符串 `content`，不回退为 Main。广播端点还检查声明的发送者是否为该端点的父节点。本项目信任同用户本机进程，不另建认证协议。

每个 NDJSON 请求处理结束后，成功返回空行，失败只返回错误的 `code`（如有）和 `message`。`writeSocket` 等待结果再返回；超时或断连表示结果未知，不自动重发。正常返回不表示模型已读或任务完成。

监听由当前根注册表决定，覆盖已停止但可续跑的 Actor，不复用 `subagent_list` 的每组四项显示窗口。大量累计 Actor 会增加监听资源占用；系统资源不足会报告错误，不把它解释成 Actor 不存在。

### 原生交接

运行中的输入交给原生 steer。SDK 尚未就绪或暂时空闲时，输入由该 Job 的 Runner 持有；缓冲不代表模型已经读取。事件交给 SDK 后，插件不因用户清队列而重放。

通知路径检查实际交接结果，不把同步 `accepted` 标志当作成功。只有明确尚未交出的拒收，才能追加到保留会话。任意 SDK 异常不能证明未入队；这类错误可见，但不会盲目重发。

普通消息和终态是独立原生事件。一次模型请求可消费多个原生事件，不要求每个事件单独请求一次模型。

## 退役、树切换与写入权限

根服务区分两个权限：是否接收新命令，以及是否仍拥有原根分支的写入权。开始退役后拒绝新命令，但在原上下文仍有效时，允许已存在 Job 完成终态落盘。

`session_before_tree`、`session_before_switch` 和 `session_before_fork` 在 SDK 移动上下文前等待退役。正常路径先停止 Job、写入终态、关闭监听，再允许切换。终态由 Runtime 发布一次；视图写入器不提前抢写终态。

持久化失败会锁存，阻止新工作，也阻止切换被报告为成功。钩子应显式返回 `{ cancel: true }`；SDK 会捕获扩展异常，仅抛错不能阻止切换。UI 报错失败也不能改变取消结果。

退役默认期限为 5 秒。期限只限制调用方等待，不证明原生资源退出。超时后保留资源栅栏；只有实际清理完成，才允许新代次使用相同文件。清理失败且无法确认退出时，继续隔离，而非强制开放。

Shutdown 不能取消。退出或替换上下文后，代次失效使旧回调不能经 `pi.appendEntry` 写入新根。强制退出、退役超时或进程终止仍可能需要下次按中断恢复；不承诺跨文件事务或强制退出时的完整终态。

导航尝试会先停止子 Job。若后续插件取消导航，已经停止的 Job 不回滚或重跑；下次根模型运行可重新打开已停止的注册表。旧代次不能通过过渡期间的懒加载重新接收命令。

## 存储与历史视图

根分支用 v2 增量事件保存拓扑、身份补丁、Job 起点与终态；对话在原生子文件中。模型只记录 provider/id，不记录运行时对象或凭据。

终态的模型结果与历史写入状态分开。历史视图失败不改写模型结果，但 `historyState`／`historyError` 进入同一份最终事件。视图不参与状态恢复。

Runtime 的列表投影没有历史文件写入。Root 列表层可重建缺失视图；每项分别捕获失败，单个损坏文件不阻断其余 Actor 状态。通知只投影路径，不在终态发布过程中重建视图。

Fork 读取记录中的绝对 `sessionFile`，首次写外部文件时复制到自有目录。原生条目 ID 与签名保留，父文件不被改写。Rewind 只改变当前可见分支，分配 ID 仍避开全部分支和已有文件。

v1 转换只存在于独立离线脚本。生产运行时不转换、不恢复旧快照。用户原件、迁移副本和备份按既定决定保留；迁移工具暂不清理。

## Capability

Capability 通过共享执行句柄创建内部 SDK 会话，不要求公开 Subagent 工具激活。公共会话与检索会话共用 ModelRuntime 桥和 Budget 截止计时，但保留不同业务规则：Subagent 交付任务结果，Capability 交付验证过的 refs。

内部搜索 schema、参数说明和执行都只允许 `local`。远端审批未实现前不搜索远端、不安装候选、不把远端未搜索解释成不存在资源。

本地检索由 `src/capability/broker.ts` 实现，复用 `minisearch@7.2.0`。排序使用标准 BM25（设置 MiniSearch 的 `d=0`），不自行实现评分公式。切词和小写处理使用库默认行为；不附加 CJK 分词、停用词、前缀匹配或模糊兜底。连续中文不做语言分词，不保证中文子片段、同义词或跨语言召回。

精确工具／命名空间／MCP 引用和 Skill 入口路径独立查找，不参与 BM25 排序。工具按成员建索引，按完整命名空间或 MCP 组返回，组分数取成员最高分；候选上限按组计数。Skill 先按名称和描述召回，最多打开 6 个候选文件，将每篇正文的前 60,000 字符加入索引后用同一检索库重排，不扫描整个 Skill 目录的正文。字符截断限制索引文本，不是文件读取的字节上限。

宿主不从 Skill 文本猜测禁止事项、前置条件、静默失败、绑定关系或执行优先级，也不按未命中词项推断能力缺口。Skill 返回元数据和绝对入口路径，由 Agent 使用原生 `read` 阅读并理解正文。`src/capability/result.ts` 移除模型可见结果中的排序诊断；`src/capability/prompt.ts` 投影分支发现记忆。

工具资格按设计只增不减，角色排除仍优先。每次同步目录投影只解析一次资格视图；不把快照跨请求或工具调用缓存。资格、注册和激活是三件不同的事。

发现记录按当前分支保存，不重复存储参数 schema；请求投影依据当前声明提供接口。外部压缩插件的兼容逻辑尚未删减，不能把共享声明投影和执行隔离一并当作无用兼容删除。

## 代码与未迁移边界

原 Subagent／Runtime／Socket／平台 MJS 重导出入口已删除。`extensions/harness.ts` 直接装配 `src/subagent/extension.ts`，业务模块见上表。

`subagent-storage.mjs`、`subagent-routing.mjs`、`subagent-view.mjs`、`job-budget.mjs`、继承捕获及部分 Capability 实现仍是 JavaScript。它们不因调用方改为 TS 就自动获得严格类型保证；跨边界输入在 TS 消费端校验。不是全仓 TS 迁移。

提示词正文在 `prompts/`；代码保留参数结构、动态装配、权限和生命周期判断。正文在模块初始化时读取，修改后应重启 Pi，不承诺 `/reload` 刷新全部 ESM 依赖。

Windows 11 虚拟机已验证 Shell Preflight、Named Pipe 和 36 项离线 SDK 场景。用户查看界面、远端审批、完整 Windows 场景和多用户验证仍未交付。默认回归、局部 SDK 场景和单次真实模型调用都不能替代完整边界审计或长时间压力验收。
