# 异步 Shell 平台验收记录

代码与测试基线为 `861bb19`。验收使用真实 Pi SDK `1.5.0`、本地模拟模型和真实终端后端；没有调用真实模型提供方。当前使用契约见[异步 Shell](../async-shell.md)。

## 全量结果

两端均执行 `npm run check`，包含 `tsc --noEmit` 和完整测试套件。

| 平台 | 终端后端 | 测试总数 | 通过 | 跳过 | 失败 | 取消 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Linux | tmux | 772 | 766 | 6 | 0 | 0 |
| Windows 11 | psmux 3.4.0，原生 ConPTY | 773 | 757 | 16 | 0 | 0 |

跳过项包含平台专用用例。Linux 跳过 Windows ACL、batch 与 ConPTY 等用例；Windows 跳过 Unix Socket 文件与权限语义等用例。Windows 上通过移除 PATH 制造进程查询不可用的用例也跳过：系统目录仍可解析 PowerShell，验收没有增加生产测试开关。

## 已验证范围

- CLI：真实 TTY、参数字面传递、空格及中文路径、非零退出、超时、取消、任务命名空间隔离。
- 输入：58 KiB 混合 Unicode 与元字符正文通过 stdin 和命名 buffer 传递，接收长度、完整内容和 SHA-256 相等；超出 64 KiB 的输入被拒绝。LF 与独立 Enter 分别验证。
- 输出：完整日志保留、32 KiB 的单次 `output` 上限、终态后继续读取、默认消费游标、显式回读和并发读取。Windows 另验证 ConPTY 折行及重绘。
- 宿主：注册与完成事件、同步返回与异步通知的分工、Main 回调、Subagent 保留同一 Job 后续跑、停止 Subagent 时清理所属任务。
- Windows SDK：Bash 与 PowerShell 两个入口分别通过；最终定向验收为 2 项通过、0 失败。
- 安装：PowerShell、cmd、Git Bash 启动入口实测通过；PowerShell 的 Unicode 参数与多行管道输入通过；重复安装和全局 Skill 目录发现通过。
- 目录与进程归属：Windows 私有目录 ACL 接受与宽泛 Allow 拒绝均有原生验证；进程归属查询区分已证明归属、已证明不存在或不匹配，以及查询失败。

SDK 的命令使用显式放行文件结束，Main 的异步完成验证不依赖固定运行时长。安装后的 PowerShell 入口在原生调用期间使用 UTF-8 解码，并恢复调用前的控制台编码。

验收结束时没有终端后端、任务 Node 进程或任务命名管道残留。任务日志与探针材料保留，未作为仓库资产提交。

## 未归因现象

Windows 验收执行者曾报告一次 PowerShell SDK 用例失败。该次命令只保留了测试名称、耗时和汇总，完整断言正文被过滤，无法恢复。任务目录显示该轮的两个命令已完成、取消任务已收尾，Main 的交付模式为异步。

这些记录不能确定失败断言或根因，也不能将该失败归因于 Main 命令的固定延时假设。最终基线的定向 SDK 与全量检查均通过；该结果不证明此前的偶发失败已修复。再次出现时应保留完整 stdout、stderr 和相关任务状态后定位。

## 2026-11-11 复查：Windows Bash SDK 首轮让出超时

集成基线 `b4cdbd9` 的 Windows 全量检查为 1,167 项、1,148 通过、1 失败、18 跳过。唯一失败是 `test/async-shell-sdk.test.mjs` 的 Bash 用例，报错 `Timed out waiting for child model yielding after create`（耗时 6.5 秒，场景内固定轮询 3 秒）。PowerShell 用例随后通过。

保留的失败任务 `job_6abdcba8`（任务根 `%TEMP%/pi-async-shell-0`）在测试临时目录下创建后 11 毫秒进入 failed 终态，`output.log` 记录 `async-shell: The async-shell host did not accept a frame: connect ENOENT \\.\pipe\pi-harness-d1fc24ed-sub_01.sock`。

复查结论：

- 超时的直接原因是场景内固定 3 秒的 `waitForCondition`：它把子会话启动、模型首轮、Shell 启动和 `pi-job` 启动都算进同一预算，而产品没有承诺 3 秒期限。空闲重复中子会话创建到让出约 1.72 秒，冷启动并行时余量不足。
- 强制不存在的回调管道只能证明该注册拒绝会作为错误工具结果送达模型并触发 `Shell failed` 断言（约 4.1 秒），不能证明 `b4cdbd9` 那次 `ENOENT` 的因果顺序。用临时环境开关把实际 Shell 命令延迟 4 秒（未提交）后，旧轮询在 3 秒预算处超时（用例总耗时 5.5–5.8 秒）；延迟命令的落地标记未出现，说明测试运行器在子进程退出时结束了它还存活的 Shell，未观察到“晚到注册”建立任务目录，因此“旧轮询超时→关闭监听→晚到注册被拒”的假设未能复现。
- 因此 `ENOENT` 的管道可用性原因仍未证明；保留证据，不改动生产注册或重试路径。

同步修复（仅测试生命周期）：

- `test/typed/support/async-shell-sdk-scenario.ts` 用脚本模型回调实际产生的 Shell 结果轮次解析每个子会话的让出信号（成功让出与 `shell.isError` 都解析），`assert.equal(shellFailure, null, ...)` 仍紧接在等待之后，错误会以 `Shell failed` 暴露而不是变成有效让出；Main 完成与第二个子会话使用同类信号。
- 外层测试 30 秒、子进程 25 秒与命令 `--timeout 20s` 期限不变；没有管道预检、预热、重跑或重试；执行、argv、环境与单次投递断言不变。
- 确定性验证：同一环境开关下把实际 Shell 命令延迟 4 秒，新信号等待真实回调后通过（17.5 秒），证明信号可越过旧 3 秒且无提前拆除。
- 运行结果：Linux 文件 1/1；Windows VM 完整文件 2/2（Bash 9.0 秒、PowerShell 11.0 秒）；8 文件冷并行突发 67 项、63 通过、4 跳过。

## 验证边界

本次结果不覆盖真实提供方的多轮在线行为、长时压力、macOS 实机、多用户隔离，以及 Windows 进程查询不可用的故障注入。ConPTY 的输出是终端渲染流，折行和单元格重绘可能产生额外换行或重复字符；验收没有把它当成程序原始 stdout 的逐字节副本。
