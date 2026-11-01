# Pi Harness

Pi Harness 是基于 Pi SDK 构建的 Coding Agent 增强插件，提供能力按需发现、树状 Subagent 编排与受管本地 IPC 通信。

本项目将单会话工具调用扩展为树状协作系统。主 Agent 可自主发现资源、并发派生子任务并协调执行。

## 核心能力

- **Capability 按需发现**：主 Agent 在遇到能力缺口时检索本地 Skill、Tool 与 MCP 工具。选中资源按会话分支保存，后续请求从规范记录重建能力指引。
- **Subagent 树状编排**：主 Agent 可并发创建子任务，支持角色与候选模型路由；提供层级 Budget、最大深度与活跃子节点限额；父 Agent 在当前 Job 内等待直接子节点交付（parent-hold），无需忙轮询或外部唤醒。
- **受管本地 IPC 通信**：提供专用的纯文本 `msg_write` 消息工具；宿主处理传输分帧与发送者身份绑定；Unix 平台使用独立 UID 的 Unix Socket，Windows 平台使用命名管道。
- **Shell Preflight（可选）**：拦截并校验聊天框命令，Windows 下通过 PowerShell AST 语法检查后分发，防止选错 Shell。

## 快速开始

### 1. 环境准备

Pi Harness 要求 Node.js `>= 22.19.0`。执行以下命令安装依赖：

```bash
npm ci
```

### 2. 配置模型与 Fresh 路由

先通过 Pi 原生机制配置模型与认证。Harness 不管理或保存模型凭据。

Fresh 子任务需要 Pi 用户目录中的 `subagent-routing.json`。默认用户目录为 `~/.pi/agent/`；设置 `PI_CODING_AGENT_DIR` 时使用指定目录。以 [路由示例](config/subagent-routing.json) 为模板，按实际模型目录填写分类器、角色和候选模型；已有配置时编辑原文件。

仓库示例不会作为缺失配置的运行时回退。示例中的提供方与模型也不保证在你的环境可用。

### 3. 启动本地 Pi

在仓库目录中显式加载 Harness：

```bash
./node_modules/.bin/pi -e ./extensions/harness.ts
```

需要 Shell Preflight 时，可再添加 `-e ./extensions/shell-preflight.ts`。从其他目录使用时，应把扩展路径改为实际绝对路径。

### 4. 按需修改参数

[config/harness.json](config/harness.json) 提供完整默认值示例。全局配置位于 Pi 用户目录的 `harness.json`，受信项目还可使用 `.pi/harness.json` 覆盖指定字段；没有文件时使用内置默认值。字段和生效边界见 [Harness 参数配置](docs/harness-configuration.md)。

## 典型工作流

1. **按需发现能力**：主 Agent 分析任务。仅在缺少特定工具、领域规则或指引时调用 `capability` 补足，避免重复检索已就绪资源。
2. **派生独立子任务**：主 Agent 调用 `subagent_create` 并发创建子 Agent；系统根据任务目标自动路由分配角色与候选模型。
3. **事件驱动等待**：无需轮询等待工具。父 Subagent 仍有活跃直接子节点时，在同一 Job 内等待通知；Main 由宿主投递的终态通知继续处理结果。
4. **协作与续跑**：通过 `msg_write` 向受管端点发送消息。运行中的节点在当前轮处理消息；已停止节点在限额允许时启动新轮。

子任务共享工作目录，应按文件边界分工。需要隔离同文件修改、对照分支或测试状态时，可另用 worktree。

## 工具速查

主 Agent 与子 Agent 通过以下工具交互：

| 工具名称 | 适用角色 | 说明 |
| --- | --- | --- |
| `capability` | Main／未达最大深度的 Subagent | 按需检索本地 Skill、Tool 与 MCP 工具，筛选后激活并注入分支记忆 |
| `subagent_create` | Main／未达最大深度的 Subagent | 并发创建子 Agent 任务，等待本地初始化就绪后返回 ID 与通信端点 |
| `subagent_list` | Main／全部 Subagent | 查询拓扑树状态、通信端点与可用的持久化历史路径 |
| `subagent_stop` | Main／未达最大深度的 Subagent | 请求取消指定 Subagent 的执行 |
| `msg_write` | 子 Agent 默认 / 主 Agent 按需 | 向受管 IPC 地址发送纯文本消息；主 Agent 默认不启用该工具，通过 Capability 启用整个 subagent 命名空间后激活 |

任务完成后，宿主会自动向父 Agent 发送终态通知，携带本轮最终执行文本。

## 开发与验证

项目提供以下代码、类型与配置验证脚本：

```bash
# 类型检查
npm run typecheck

# 运行类型化核心测试套件
npm run test:typed

# 完整门禁（类型检查 + 全套测试）
npm run check

# 配置与提示词 JSON 有效性自检
node --input-type=module -e 'import {readFileSync} from "node:fs"; for (const f of ["config/harness.json","config/subagent-routing.json","prompts/subagent-tools.json","prompts/subagent-turns.json","prompts/capability-tools.json"]) JSON.parse(readFileSync(f,"utf8"))'
```

## 现有限制

- **仅限本地搜索**：远端 Capability 候选需要用户审批界面；审批流程完成前，当前仅搜索本地已注册资源，不搜索远端。
- **暂无独立用户界面**：当前通过面向模型的 `subagent_list` 接口查看与控制子 Agent，面向用户的独立 UI 尚未交付。
- **无 MCP 自动重连系统**：Harness 只检索当前已成功注册的 MCP 工具，不维护外部 MCP 服务的重连守护；连接恢复使用 Pi 原生机制与 `/mcp reconnect`。
- **SDK 白名单记录差异**：在 SDK `1.4.0` 严格白名单下，部分 MCP 工具可能被拒绝激活，导致先记录的分支选择与实际激活工具存在差异。
- **离线回归验证边界**：当前自动化回归基于真实 Pi SDK 与本地模拟模型，不代表真实模型提供方的在线多轮长时压测。
- **Work 处于实验状态**：Work 方案集中在 `experiments/work/` 目录，未进入主线加载与测试。

## 文档导航

- [项目目标与范围](docs/00-scope.md)：项目定位、设计原则和非目标
- [接口契约](docs/interface-contract.md)：使用流程、工具参数与运行时行为契约
- [当前架构](docs/architecture.md)：模块职责、所有权划分与代次资源隔离
- [存储 v2 与历史说明](docs/subagent-storage.md)：事件结构、文件归属与恢复边界
- [能力提示词记忆规范](docs/capability-prompt-memory.md)：分支条目持久化与权限过滤
- [Harness 参数配置](docs/harness-configuration.md)：全局与项目参数、Budget 与提示词段落定制
- [已知问题与验收边界](docs/known-issues.md)：未实现功能、待验收场景与现有限制
- [文档目录](docs/README.md)：文档架构与阅读索引
- [提示词资产说明](prompts/README.md)：提示词文件清单、数据装配与修改方式
