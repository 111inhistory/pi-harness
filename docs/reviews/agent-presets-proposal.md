# 暂缓提案：Agent Preset 与 Seed 会话

状态：已被用户暂缓。本文属于调研记录与未来设计候选，不构成当前接口契约或实现任务。必需的会话操作与 cron 工作在[独立外部编排提案](session-orchestration-proposal.md)中独立定义；常规 peer 发现则在[Agent 发现与通信提案](agent-discovery-communication-proposal.md)中定义。

## 范围边界

不应将 preset 文件、角色模板目录（catalog）、preset 选择器、热切换 profile、Seed 生成或 Seed 编译器作为会话编排的一部分进行实现。新会话可以通过显式的 cwd、task、原生名称和附加指令启动，使用现有的 Pi 模型和资源配置。Manual 工具继续通过当前的 capability 路径启用。无论是会话创建还是调度，都不依赖本提案。

当该工作重启时，应在实现前先确定配置表示形式与授权行为。下文细节保留此前的讨论记录；并不推翻暂缓结论。

## 组合构成

preset 组合了预定义的 role 提示词、model/thinking 配置以及预期的工具配置（loadout）。概念定义如下：

```json
{
  "name":"orchestrator",
  "role":"coordinator",
  "enableTools":[
    "agent_list","msg_write",
    "session_create","session_resume","session_list",
    "session_connect","session_poll","session_stop","cron"
  ]
}
```

此示例为候选组合示例，既非最终的文件 schema，也不代表这些工具已经实现。

role 提示词陈述职责、工作方式与职权边界。当前 task 与之保持分离。编排者（orchestrator）不必普遍是审查者或只读执行者；默认 preset 可以省略编辑工具，但这属于角色选择，而非对所有编排者的内置约束。

语义一致时，复用 role 提示词资产和模型配置。不应仅仅为了共享提示词正文就让 Main preset 选择走一遍 Fresh 角色分类器。不应在 preset 和路由文件中重复维护相同的 role 提示词。

preset 定义仅凭加载并不能授予权限。显式的用户选择会展示将被启用的 manual capability，并走现有的用户启用／记录路径。自动发现 preset 或选择 Subagent 路由角色不能授予外部编排职权。角色拒绝（Role denials）与 Main-only 约束继续优先生效。

指令必须使用结构化提示词组合，而不应照搬示例扩展中的全量 system 提示词替换方式。

当前的 manual 授权模型是只追加（append-only）的。切换 preset 名称不能声称撤销了授权或恢复了原始安全状态。初始交付可倾向于为专用的编排会话选择 preset；可逆切换需要独立的设计决策。原生会话名称用于标记执行；preset 名称用于标识配置。

不应将编排者暴露为可自动选择的 Fresh Subagent 角色。拥有外部控制权的后台编排者需要显式的职权设计，而不能作为子级范围排除规则（child-scope exclusion）的例外特权。

## 将 Seed 会话 fork 作为 preset 构建选项

一份独立的调研报告提议将 preset 表示为干净的原生 seed 会话并对其进行 fork。这是一个有价值的构建选项，但完整重放目前尚不能替代运行时的资源／提示词设置。

在已安装的 SDK 中验证了以下事实：

- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` 创建新的会话头／身份标识，并复制所有非头部 entry。它不会变基（rebase）entry 内部的任意字符串或清理项目路径，复制的 entry 时间戳也不会重置。
- SDK 能恢复 model/thinking 信息及记录的工具配置。工具恢复仍取决于工具注册、显式工具选项、当前排除规则以及异步后端的可用性。
- 下一次运行会根据当前的资源加载器与 hook 重建结构化提示词分段。目标提示词中缺失的历史分段会被提示词 diff 显式删除。
- 在隔离的真实 SDK／离线模型检查中注入了 `SEED_ROLE_MARKER` 前导内容、`role` 分段和 `read` 声明，随后执行 fork 并发起 prompt。初始激活集合与首次请求均包含 `read`；首次请求包含 `seedRolePresent:false` 与 `roleSection:null`。因此，对于该启动路径而言，“仅凭 fork 即可保留角色”的预设立场不成立。
- Harness 将 manual 选择作为 `result.manual` 存储在 `customType: "capability-discovery"` 内。当前并不存在单独的 `capability-manual` 记录。复制这些 entry 仅保留了分支数据；并不会注册工具或覆盖角色准入资格。
- 原生 `SessionManager` 的命名接口为 `appendSessionInfo`；`setSessionName` 属于更高层级的 session/extension API。

奥卡姆剃刀裁决：将 Seed 作为唯一 preset 格式的判定为**先证明可行**（Prove first）。暂不以此断言替代配置／角色设计。Seed 可以保留选定的对话骨架或 few-shot 上下文并创建独立的执行，而当前的 role/resource 设置则用于确立目标提示词和已注册工具。不应为了避免调用原生 SDK 配置 API 而去照搬示例扩展的全量提示词替换，或生造一个 Seed 编译器。

用户选择且受信的 Seed 可能携带刻意设计的授权，但选择过程必须向新的 Main 会话展示并授予这些权限。加载或发现任意 seed 并不代表获得授权。fork 一个正在工作的会话还会复制所有的 Subagent Harness 事件、自定义联系人及其他历史：应使用显式构建的干净骨架，而不能假设 fork 会自动剥除执行包袱。

采纳 Seed 前的验收要求：测试首次请求与后续轮次、`/tree`/reload、工具延迟注册、被排除工具、模型覆盖、目标 cwd／路径清理、授权来源（provenance）和分支恢复。创建独立会话是有价值的历史隔离手段；但它不是操作系统级隔离，也不构成新的安全边界。

## 人工入口，同样暂缓

未来的 `/preset` 命令应支持浏览具名 profile，并展示预定义的 role 提示词、模型选择和预期的工具授权。用户针对新会话／专用会话的显式选择可以通过现有的启用路径应用所展示的 manual 授权。加载 profile 绝不能自动授予工具。

列表必须支持原生键盘选择、过滤、焦点／输入法（IME）以及无副作用的取消。热切换和基线恢复仍属独立决策，因为当前的 manual 授权模型是只追加的。在首期 session/cron 实现中，不需要 `/preset` 命令或 `preset` 参数。

## 应保留的调研结论

| 来源 | 有益实践 | 边界限制 |
| --- | --- | --- |
| Pi `examples/extensions/preset.ts` | 具名 model/thinking/tool/instruction 组合以及原生选择 UI | 它只是扩展示例，并非内置权限系统。全量提示词替换与激活集合快照不能作为权限回滚机制。 |
| [OpenCode agents](https://opencode.ai/docs/agents/) | 区分主身份（primary persona）与 Subagent，区分提示词与强制权限 | 不应照搬其权限／配置引擎。 |
| Harness 现有 role 定义 | 角色指令和模型配置已有明确归属 | 复用提示词不需要让显式的 Main preset 选择走自动 Fresh 路由。 |

## 奥卡姆剃刀处置

原则：保留对未来有价值的区分，但不让其成为当前目标的依赖项。此处未予审查项：会话生命周期、peer 可见性与定时器的实现。

| 概念 | 裁决 | 原因 |
| --- | --- | --- |
| Preset 实现 | 暂缓（Defer） | 用户已明确暂缓；会话编排无需 profile 即可工作。 |
| 预定义 role 提示词 | 保留（Keep） | 保留未来需求：职责与工作方式不是工具列表或 task 文本。这并不授权现在去实现新目录。 |
| 重复的 role/model 来源 | 合并（Merge） | 工作重启时，在语义匹配处复用现有资产。 |
| Seed 作为唯一 profile 表示形式 | 先证明可行（Prove first） | 经测试的默认启动会清除历史 role 分段；完整的运行时恢复尚未得到证明。 |
| 热切换／可逆权限 | 先证明可行（Prove first） | 只追加授权不能被静默重新解释为可撤销状态。 |
| Seed 编译器／配置框架 | 暂缓（Defer） | 目前不存在已验证的表示形式需求足以证明再加一层抽象的合理性。 |

保留 manual 授权、角色排除、稳定的会话身份以及忠实反映事实的 SDK 恢复语义。未来的 profile 不能以简化为名绕过这些机制。
