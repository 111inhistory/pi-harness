# 已知问题与验收边界

本页区分已知缺陷、未交付功能、待验收场景和设计限制。当前行为见[接口契约](interface-contract.md)，模块职责见[当前架构](architecture.md)。历史修复与排查记录见[归档目录](archive/README.md)和[审查目录](reviews/README.md)。

## 已知缺陷

### 严格工具 allowlist 下的激活记忆不一致

Pi SDK `1.5.0` 可能保留 MCP 注册，却拒绝激活不匹配 allowlist 的成员。例如 allowlist 只列出 `read`、`write`、`capability`，既不匹配目标 `mcp__*` 工具，也不保留隐藏的 `tool_search`。SDK 没有公开的激活资格预检接口，激活调用可以静默省略成员。

Capability 按实际激活集筛选公开结果，返回失败或部分成功。但先写入的 `capability-discovery` 规范记录仍可能包含未激活成员。激活调用抛出异常时也可能出现这类差异。该记录不授予执行权限，却可能让请求记忆提示一个未启用工具。

恢复办法是让 allowlist 显式匹配所需 MCP 工具，或使用保留默认工具的配置后重新发现。仅凭隐藏的 `tool_search` 是否存在，不能判断全部工具的激活资格。回归见 [capability-allowlist-mask.test.ts](../test/typed/capability-allowlist-mask.test.ts)。

这项缺陷尚未修复，也不是 `harness.json` 中的可选策略。修复需要明确 SDK 激活资格或调整记录协议；当前没有激活探针、回滚或补偿状态机。

## 未交付功能

| 项目 | 当前边界 |
| --- | --- |
| 用户交互界面 | `/subagent` 已提供查看、停止和会话连接；可视化／交互式任务管理界面及通过用户命令直接向子 Agent 发送消息仍未交付 |
| Capability 远端审批 | 内部搜索只使用本地来源；没有远端审批界面，也不搜索、安装或自动加载远端候选 |
| 仅提供资源的 MCP 服务器发现 | 没有工具的 MCP 服务器不作为独立发现项 |
| Work | 保留在 `experiments/work/`，不由主线扩展加载；交付形态未确定 |

## 待验收场景

默认回归使用真实 Pi SDK、本地模拟模型和离线 MCP 子进程。离线通过不等于真实提供方、多轮模型行为或长期运行验收。

- **Inherited 在线工具调用与压缩**：基础注册、延迟 MCP 和 Responses 声明链已有离线回归；动态激活后多轮调用、原生压缩后的实际工具调用仍需在线验收。
- **真实提供方的输入与行为**：精简 step 反馈的 JSON 完整性和大小已在模型请求中验证；提供方是否额外截断、角色选择质量和多轮遵循情况仍需实测。
- **长期资源与竞态**：退役、落盘失败和部分代次竞态已有回归；长时间压力、监听资源耗尽、强制终止点和插件取消导航的组合仍未完整覆盖。
- **跨 session 消息**：目录发布、原生 session name、存活校验、单帧写入、未知 session 拒绝与远端错误码透传已有两平台离线回归。Windows 的双 SDK 进程已验证显式连接、双向消息、忙时交接、原生压缩、树导航、reload 后继续收发和退出清理；真实提供方多轮行为、长期互发与资源压力仍需实测。IPC 目录必须保持本机私有：记录里的 `pid` 只在本机解释，跨机共享 `socketRoot` 不在设计范围内；跨机共享 durable session 历史不受此限制。
- **Manual 能力在线组合**：完整 SDK 会话（真实 `createAgentSession`、真实 stdio MCP 子进程、离线模型）覆盖未授权声明／执行／Codemode、`/capability enable` 授权后的 manual MCP 与资源读取资格、Main／子作用域隔离。真实提供方的缓存计费、真实资源读取、启用后 MCP 断连和长时间运行仍未验收。
- **Capability lazy schema**：离线 SDK 用例验证命中组 schema 不进入独立声明也不进入 Codemode 目录、`describeTool` 可取完整接口且脚本可执行、后续内部继承检索不重发这些 schema。真实提供方缓存命中、多轮模型遵循和长期保持未验收。
- **模型 Preset**：`/preset`、`--preset` 的模型切换、thinking、工具修饰符基于稳定基线、instructions 段落投影、分支指令快照恢复、`codemode.mode` 生效覆盖已有离线单测与离线 SDK 冒烟；真实 TUI 下的 `/preset` 选择器与 `--preset` 命令交互、真实提供方的模型切换与在线缓存仍未验收。
- **异步 Shell**：Linux tmux 与原生 Windows psmux 已通过真实 SDK 的离线回归，Windows 覆盖 Bash／PowerShell 入口、Main／Subagent 回调和取消清理。真实提供方多轮运行、长时压力与 Windows 进程查询不可用的故障注入仍未验收。Windows PowerShell SDK 用例曾报告一次未保留完整断言日志的偶发失败，尚未归因；最终基线通过不能证明该现象已修复，详见[平台验收记录](reviews/async-shell-platform-acceptance.md)。
- **平台与用户边界**：Linux 与 Windows 的完整离线套件已运行；macOS 实机、多用户切换与管道权限隔离尚未验收。

现有在线样本只证明记录中的具体场景，不替代当前调用链的完整验收。

## 依赖边界

ModelRuntime 桥依赖 SDK 的内部结构，升级 SDK 时应复核。子会话收尾通过 `takeQueuedMessages` 读取原生待处理队列；该辅助函数临时切换队列模式并使用探针，不能把当前实现概括为完全没有队列探针。

`src/` 与 `extensions/` 生产代码使用严格 TypeScript；`scripts/` 与部分历史测试仍为 MJS。配置和提示词刷新规则见[Harness 参数配置](harness-configuration.md)与[提示词资产](../prompts/README.md)。

## 设计限制

这些限制描述当前行为，不自动转为新增功能承诺：

- **恢复与写入**：Shutdown 不可取消。强制退出或清理失败可能留下原生对话而没有根终态，下次按中断恢复。没有跨文件事务，也不支持多个进程同时写同一根会话。
- **导航取消**：导航尝试会先停止子 Job。后续插件取消导航时，已停止的 Job 不回滚或自动重跑。
- **消息交接**：异常、断连或超时不证明消息未入队，不自动重发。普通消息和子节点通知可触发模型请求，本项目不合并不同事件。跨 session 消息的 session 记录与 `from` 都是同用户本机进程的声明，不是认证；进程异常退出可能留下已失效的 session 记录，读取时按 pid 存活过滤，pid 复用时可能短暂误报。同一 durable session 不支持多进程同时打开；目录记录按 session ID 归属，重复打开时较早退出的进程可能删除后者记录。
- **异步 Shell 日志与恢复**：输出是终端转录。Windows ConPTY 可能折行和重绘，过滤文本可能含额外换行或重复字符。monitor 被外部强制杀死后没有自动恢复或通知补发；任务日志不自动按保留期清理，长期运行会持续增长。命令与增量读取说明见[异步 Shell](async-shell.md)。
- **能力记忆**：发现记录按分支累计，角色排除仍优先；请求投影重新核对当前资格。记录能否恢复依赖规范条目仍在当前分支，激活成功性另受上面的已知缺陷限制。
- **模型 Preset 与 Codemode 模式**：`codemode.mode` 无公开运行时写入通道，Preset 以分支记录覆盖本会话 Capability 的生效模式（原生 Codemode 工具与 lazySchemas 读取），从下一次请求生效；它只改变声明投影，不改变启用集合、授权或工具 exposure，也不影响其他读取 Pi `settings.codemode.mode` 的组件。`/preset clear` 只停止管理，不回滚 model／thinking／tools。恢复时依赖 Pi 原生运行状态，不强制重放 Preset 快照；应用后尚未发起请求就退出，工具集可能恢复为上次请求记录的 loadout。
- **MCP 发现与连接**：Capability 只搜索当前已注册工具，不等待全部后端，也不主动重连。注册或激活不表示服务持续在线；连接恢复沿用 Pi 原生行为和用户命令。
- **刷新边界**：根服务使用配置快照，已有 Job 保留原 Budget。提示词正文受 ESM 缓存影响，重启 Pi 是明确生效方式，`/reload` 不保证刷新全部依赖。
- **工具集变化与提示词缓存**：工具与 system 更新由 Pi 原生编码，并按模型 compat 选择追加路径。Chat Completions 的工具追加需要明确开启中途 system 消息与工具新增两个兼容位；标准端点仍重发顶层工具列表。同名 schema 更新在仅支持新增的路径可能重建前缀，未支持中途 system 消息的模型会折叠指引到头部。描述与共同指引变化使用增量段落，压缩则允许重建并收缩工具 checkpoint。详情见[Provider 传输行为](provider-transports.md)。前缀稳定和缓存标识相同不保证实际命中；不添加缓存断点或 TTL 策略。
- **缓存标识验收边界**：Main 在共享 ModelRuntime 边界观察最终 payload hook 结果，Inherited 与 Capability 检索会话通过自身 `streamFunction` wrapper 观察；有效 Responses key 按分支保存。离线回归覆盖钩子顺序、继承、落盘恢复、共享运行时和退役回调。任意第三方插件组合及真实服务商的长期缓存复用未全面验收；相同 key 不保证命中，详见[Provider 传输行为](provider-transports.md)。
