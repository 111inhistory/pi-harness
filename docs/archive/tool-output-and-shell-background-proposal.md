# 工具输出裁剪与 Shell 自动转后台提案

本文件保留实施前的设计与验收计划。当前行为见[异步 Shell](../async-shell.md)；相关验收遗漏见[教训 L008](../../LESSONS.md)。

## 当前问题

- Pi 原生 Bash 和 PowerShell 在前台保留最后 2,000 行或 50 KiB。Managed Shell 在等待窗口内结束时却返回日志的第一个 32 KiB 分块（且无行数上限），退出前的诊断可能不在正文里。
- 后台启动和 `job_stop` 的模型正文为裸 JSON，且缺少底层已有的 `truncated` 标记与续读信息；完成通知（`async-shell-result`）直接序列化整份 `ShellResult`，未说明命令为何转入后台、`timeout` 是否仍然有效。
- 显式提供 `timeout` 而未请求后台时，当前行为走原生前台一直等待终态。同时，受管 `bash` 继承了 Pi SDK 的 `outputSchema`，却未返回 `structuredContent`，导致 `codemode` 内调用 `tools.bash` 时原生回退返回对象、受管路径返回字符串且非零退出直接抛错。
- TUI 侧直接渲染后台启动与 `job_stop` 的裸 JSON；`bash`／`powershell` 调用头未显示 `background` 与 `pty`；`async-shell-result` 仅渲染 `shell.output`，丢弃了 `exitCode`、`message`（如 `internal_error` 清理警告）、`truncated` 与 `logPath`，且折叠前会先渲染整份输出；受管前台等待期间没有实时输出预览。

## 输出裁剪

提供可主动调用的纯文本裁剪原语，以**行数和 UTF-8 字节数双限**为准，先达到任一上限就停止。输出生产者决定取头、取尾、保留头尾或顺序分页，并负责提供合适的完整输出入口。复用 Pi 已公开的裁剪能力；不新增全局 `tool_result` hook，不在工具结果进入历史后裁剪。避免对已经被上游裁过的结果再裁一次。

| 输出 | 策略 |
| --- | --- |
| Pi 原生工具 | 保留 SDK 的策略及续读语义。 |
| Managed Shell 前台结果 | 与 Pi 原生 Bash／PowerShell 对齐：保留最后 2,000 行且最多 50 KiB。确定同步交付后，从完整日志做有界尾读；不能从当前首块恢复尾部，也不把整份日志读入内存。 |
| 后台 Job 的模型侧输出 | 显式后台、自动转后台、完成通知和 `job_stop` 统一在本次新增的未读区间内取内容；保留现有 32 KiB 单块上限并增加 2,000 行上限。未读区间超限时采用**头 + 尾**保留（兼顾开头根因与末尾诊断），尾注给出 `output.log` 路径与全局 1-based 行号，不向模型暴露字节 `cursor`，也不新增 `job_poll` 工具。不假设末尾展示行已完整换行，续读建议行号允许与最后展示行重叠 1 行。 |
| 独立 `pi-job` CLI 的 `poll`／`read` | 保持按字节游标顺序向后取的契约；保留现有 32 KiB 单块上限并增加 2,000 行上限。游标指向本块实际读到的位置，不跳过未读内容。前台尾部预算不抬高后台分块上限。 |
| 其他工具 | `codemode` 等长文本按需调用通用裁剪（替换当前按 UTF-16 字符硬切），保留各自有用的片段和完整输出入口。结构化结果按条目限制或分页，不截断 JSON 字符串来冒充完整结果。 |
| TUI | 为展示独立选择行数和大小预算，由结构化 `details` 驱动。区分展开已返回内容与读取完整日志；不应先渲染整份无界输出再折叠，也不应因此改动模型正文。 |

模型可见结果在首次返回时定稿；后续输出作为新结果交付，重启回放同一条结果时不重新裁剪。Shell 底层继续持有完整日志和消费游标，TS 负责组装模型正文、`structuredContent` 和 TUI 所需的结构化 `details`，不再由各处各自决定读哪一段。

## 前台等待上限

`timeout` 限制命令的总运行时间；等待上限只决定当前工具调用何时交出 Job。拟引入 `shell.maxForegroundWaitMs`，默认 `180000`（180 秒）。配置校验应要求 `shell.autoBackgroundAfterMs <= shell.maxForegroundWaitMs`。

| 调用方式 | 行为 |
| --- | --- |
| `background: true` | 启动后立即返回 Job。指定了 `timeout` 就继续按它限制总运行时间。 |
| 未给 `timeout`，也未显式后台 | 继续使用 `shell.autoBackgroundAfterMs`（默认 60 秒）。窗口内结束则返回前台结果；仍在运行则转后台。 |
| 给了 `timeout` 且 `timeout * 1000 <= shell.maxForegroundWaitMs`，未显式后台 | 直接等待终态并返回前台结果，避免到期瞬间先转后台再紧接推送 `timed_out` 完成通知。 |
| 给了 `timeout` 且 `timeout * 1000 > shell.maxForegroundWaitMs`，未显式后台 | 窗口内终止则返回前台结果。如果达到 `shell.maxForegroundWaitMs` 时仍在运行，返回同一个 Job。`timeout` 从启动起计时，转后台不重置。 |

只有支持 managed Job 的执行路径才做交接。保留当前原生前台回退，不因等待超时重启命令；完成通知仍由原任务交付，不为已同步返回的终态补发通知。同步更新 `bash`／`powershell` 的工具参数说明与 `prompts/async-shell.json`，明确 `timeout` 与前台等待上限的关系。

## 模型可见返回

用一句话交代发生了什么，再附必要信息，而不是输出 JSON 字段表。后台相关正文保留 Job ID、输出和可用的日志入口；退出码、失败原因、截断行范围按结果需要出现。首句已表达运行状态时不另列 `Status: running`；未产生的退出码和 `Truncated: no` 不显示。

**长 `timeout` 触发自动转后台（输出超限，头 + 尾保留）：**

```text
Job job_1234abcd backgrounded after 180s wait. The original 600s timeout still applies.
Use background: true to return immediately instead of waiting on a long timeout.

<head output>
... [omitted lines 201-1800] ...
<tail output>

[Output truncated: showing lines 1-200 and 1801-2000 of 2000. Use read on /tmp/project/job_1234abcd/output.log from line 200 (omitted middle) or line 2000 (further output).]
```

**无 `timeout` 触发自动转后台（无截断）：**

```text
Job job_1234abcd backgrounded after 60s wait.
Set timeout to limit runtime, or use background: true to return immediately.

Output log: /tmp/project/job_1234abcd/output.log
```

- 两种自动转后台提示都使用实际等待窗口。存在省略或未返回输出时，把 `output.log` 路径和全局 1-based 行号放在 Pi 风格的截断提示里，不暴露字节 `cursor`；续读建议行号允许重叠 1 行，以防最后一行尚未换行完毕；日志路径只出现一次。没有截断时，保留 `Output log:` 入口，不加截断提示。
- 显式 `background: true` 不附自动转后台建议。
- 完成通知和 `job_stop` 的首句只报告实际终态（例如 `job_stop` 遇到任务已抢先自然结束时按实际终态报告），有用的退出码或失败原因才附上，不重复启动提示；`internal_error` 的清理警告 `message` 应置于正文醒目位置，不随输出截断丢失。
- 完成通知若为增量输出且超限，头 + 尾作用于本次新增的未读区间，截断提示中的行号仍对应 `output.log` 的全局 1-based 行号，以与 `read` 的 `offset` 对齐。
- 前台文本继续采用 Pi 风格的尾部截断说明。

## `codemode` 的 `structuredContent`

`bash` 与 `powershell` 保留面向 `codemode` 的 `outputSchema` 与 `structuredContent`，并在原 Pi SDK 结构上做最小字段调整，使原生回退、受管前台和转后台返回统一契约：

```ts
{
  output: string;            // 原始过滤输出（上限 1 MiB，不含截断尾注）
  truncated: boolean;
  full_output_path?: string; // 截断或转后台时的 output.log 路径
  exit_code: number | null;  // running / timed_out / cancelled / internal_error 为 null
  wall_time_seconds: number;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'internal_error';
  job_id?: string;           // 显式后台或自动转后台时携带
}
```

- 非零退出在 `codemode` 中继续 resolve 该对象而不抛错；脚本通过 `status === 'running'` 与 `job_id` 判断命令是否已转后台。
- `structuredContent` 仅用于程序化调用方，不进入模型对话正文或持久化历史。

## TUI 展示

TUI 由结构化 `details` 驱动渲染，不再把裸 JSON 展示给用户，也不通过改写模型正文实现折叠。

- **工具调用头**：`bash`／`powershell` 的 `renderCall` 在原有 `(timeout Ns)` 基础上补充 `background` 与 `pty` 标记。
- **受管前台等待期预览**：等待窗口内定时对 `output.log` 做有界尾读并通过 `onUpdate` 推送 TUI 尾部预览（仅用于展示，不进入模型上下文），避免带 `timeout` 的命令迁入受管路径后在最长 180 秒内缺少实时输出。
- **转后台与后台启动结果**：展开为「自然语言状态说明（Job ID、运行状态、等待窗口与仍生效的 `timeout`）+ 正常多行输出预览（按 TUI 行预算折叠，展开查看完整已返回片段）+ 截断与 `output.log` 路径尾注」，避免折叠把状态首句隐藏。
- **`job_stop` 与 `async-shell-result` 通知卡片**：脱离裸 JSON。标题或状态行显示 `id`、`status` 与非空 `exitCode`；正文置顶显示非空 `message`（如 `internal_error` 警告），再展示正常多行输出预览（空输出显示占位文本），底部按需显示截断提示与 `logPath`。折叠前不应先排版整份无界输出，终态通知预览宜优先保留尾部关键信息。
- **范围边界**：常驻全局活跃后台 Job 列表状态栏不在本提案范围内。

## 验收

- 分别构造超行数、超字节数、含多字节字符及末尾未换行的输出。前台仍能看见尾部错误；后台模型正文对未读区间做头 + 尾保留并给出准确的全局 1-based 行号，按建议行号重叠 1 行 `read` 不丢内容；独立 `pi-job poll`／`read` 的字节游标连续、不重复跳过。
- 通过真实工具入口验证无 `timeout` 自动转后台、长 `timeout` 自动转后台、`timeout <= maxForegroundWaitMs` 前台终止，以及显式后台。确认只执行一次，交接后仍按原时限停止；同步结束无额外通知，异步完成只通知一次；`autoBackgroundAfterMs > maxForegroundWaitMs` 触发配置校验失败。
- 验证 `codemode` 内调用 `tools.bash` 在原生回退、受管前台（含非零退出）、显式后台与自动转后台下均返回符合 `outputSchema` 的 `structuredContent`。
- 核对 TUI 展示：调用头显示 `background`／`pty`；受管前台等待期有实时尾部预览；转后台、显式后台、`job_stop` 与 `async-shell-result` 均展示自然语言状态说明、正常多行输出与 `exitCode`／`message`／`logPath`，无裸 JSON。
- 大输出首次发送并落盘后，重启对比同一条结果在 Responses 请求中的表示。该验收验证裁剪不会改写历史，不把它当作已解决线上 `prefix_mismatch` 的证明。
