# Shell Preflight

## 状态

Shell Preflight 是附加功能，不是项目核心目标。

本文原有行为说明尚未完成本轮核对。下节记录作者报告的 Bug，不表示代码已经修复。

## 已知 Bug

作者报告：Windows 下，聊天框 `!` 命令使用 Bash，而不是预期的 PowerShell（`pwsh`）。本轮尚未在 Windows 复现，根因尚未定位。

入口覆盖和 Shell 选择是两个问题。扩展已覆盖 Agent 的 Shell 工具调用与聊天框命令入口，但入口覆盖不能证明检查或执行时选对了 Shell。

后续修复应分别验证 Agent 的 Bash 调用、Agent 的 PowerShell 调用和聊天框 `!` 命令。检查器应与实际执行器使用同一个 Shell，扩展不应把聊天框命令改到另一个 Shell 执行。

## 实现位置

第一版实现位于：

- `src/shell-preflight.mjs`：Shell 识别和语法检查；
- `extensions/shell-preflight.mjs`：Pi `tool_call` / `user_bash` 接入；
- `test/shell-preflight.test.mjs`：检测、语法错误和不执行命令的回归检查。

开发时直接加载：

```bash
pi --extension /tmp/project/extensions/shell-preflight.mjs
```

## 行为

扩展在实际执行之前检查：

- 模型调用的 `bash` 工具；
- 模型调用的 `powershell` 工具；
- 用户在聊天框输入的 `!`／`!!` 命令。聊天框命令不应一概称为 Bash 命令。

原说明将 `bash` 和 `!` 统一描述为使用 Pi 的 `shellPath`。此处仍待结合 Windows Bug 核对，不能视为预期行为。

按原实现说明，扩展在当前 Session 首次检查时读取 Pi `shellPath`；未配置时使用 Pi 自己的 `getShellConfig()` 解析结果。`shellCommandPrefix` 与待执行命令拼接后一起检查，这与 Pi 对 Bash 工具和用户命令的拼接方式一致。修改 Shell 设置后需要重新加载扩展，使 Preflight 与 Pi 重建后的工具配置同时更新。

语法失败、Shell 不受支持、解析器不存在或检查超时时，命令不会执行，并返回 Shell、失败类别和解析器诊断。

## 支持的 Shell

| 检测名称 | 检查方式 |
| --- | --- |
| `bash` | `bash -n`，脚本通过 stdin 传入 |
| `sh` / `dash` / `ash` / `ksh` / `mksh` | 对应解释器 `-n`，脚本通过 stdin 传入 |
| `zsh` | `zsh -f -n`，禁用用户启动文件并通过 stdin 传入脚本 |
| `fish` | `fish --no-config --no-execute`，禁用配置并通过 stdin 传入脚本 |
| `pwsh` / `powershell` | 固定 PowerShell AST Parser 程序读取 stdin 并调用 `Parser.ParseInput` |

PowerShell 路径带有按 `pwsh` / `powershell` 可执行文件存在性启用的测试；当前 Linux 工作站未安装二者，因此仍需在真实 PowerShell 7 和 Windows PowerShell 5.1 环境各完成一次运行验证。

检查进程使用参数数组启动，`shell: false`。待检查命令只写入子进程 stdin，不拼接进另一个 Shell 命令字符串。

## 边界

- 这里只检查语法，不判断命令是否安全、是否存在或执行后是否成功。
- 不运行 ShellCheck；语义和风格分析以后按真实需求增加。
- 不替代 Pi 的 allow / ask / deny 权限策略。
- 未识别的 Shell 失败关闭，不会绕过检查继续执行。
- 自定义扩展如果把名为 `bash` 的工具路由到远端或不同解释器，必须同步提供实际 Shell 配置；当前实现按本地 Pi 设置解析。
- `tool_call` 处理器按扩展注册顺序运行；会改写 Shell 命令的其他扩展必须加载在本扩展之前，保证检查的是最终命令。
- Pi 的 PowerShell 工具还会在实际命令前添加固定的 UTF-8 输出编码片段；该片段由 Pi 自身维护且不是模型输入，Preflight 只解析模型提交的 PowerShell 内容。
