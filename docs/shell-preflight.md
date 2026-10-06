# Shell Preflight

## 状态

第一版实现位于：

- `src/shell-preflight.mjs`：Shell 识别和语法检查；
- `extensions/shell-preflight.mjs`：Pi `tool_call` / `user_bash` 接入；
- `test/shell-preflight.test.mjs`：检测、语法错误和不执行命令的回归检查。

开发时直接加载：

```bash
/home/skwj111/pi-harness/pi --extension /code/pi-harness/extensions/shell-preflight.mjs
```

## 行为

扩展在实际执行之前检查：

- 模型调用的 `bash` 工具；
- 模型调用的 `powershell` 工具；
- 用户输入的 `!` / `!!` Bash 命令。

`bash` 和 `!` 使用扩展在当前 Session 首次检查时读取的 Pi `shellPath`；未配置时使用 Pi 自己的 `getShellConfig()` 解析结果。`shellCommandPrefix` 与待执行命令拼接后一起检查，这与 Pi 对 Bash 工具和用户命令的拼接方式一致。修改 Shell 设置后需要重新加载扩展，使 Preflight 与 Pi 重建后的工具配置同时更新。

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
