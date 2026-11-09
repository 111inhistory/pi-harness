# 提案：模型 Preset 与模型专属指引

状态：已实现（已归档，运行期边界见文末）。应用于 Capability 的 [原生暴露行为](capability-native-exposure-proposal.md)、[启用可达性检查](capability-activation-reachability-proposal.md) 和 [可选延迟 schema](capability-lazy-schemas-proposal.md) 之上；原文保留设计背景，不构成当前接口契约。

## 范围

Preset 用于模型切换、thinking 设置、模型专属指引和工具配置。plan／review 不做成 Preset；需要时通过独立 Skill 启用。

本提案不重启此前暂缓的 [Agent Preset 与 Seed 会话提案](../reviews/agent-presets-proposal.md)。旧提案中的预定义角色、Seed、外部编排和权限组合不属于本轮范围。

## 已确定的配置方向

- 工具配置采用原生 `+工具`／`-工具` 形式，在基础集合上增减。
- 工具集合与 Codemode 声明模式分别配置。only 模式不修改工具集合。
- 模型指引针对模型调用特征，不承担 plan／review 等工作角色。
- Preset 复用 Capability 的 exposure、执行资格和 lazySchemas 行为，不新增平行实现。
- 配置加载不授予 manual 工具权限，现有用户授权入口仍有效。

## 配置草案

建议使用全局 `presets.json` 和受信项目 `.pi/presets.json`，项目同名项整体覆盖。以下字段为候选格式，接入原生设置 API 时应核实命名：

```json
{
  "fast": {
    "description": "日常模型配置",
    "model": {
      "provider": "fake-provider",
      "id": "fast-model"
    },
    "thinkingLevel": "medium",
    "tools": ["+codemode", "-bash"],
    "codemode": { "mode": "only" },
    "instructions": "该模型的专属调用指引。"
  }
}
```

工具修饰符应复用原生语法与解析，不能另造全量直接声明名单。每次应用应基于同一基础配置计算修饰符，避免 A → B 与直接应用 B 产生不同的基础工具集合。已发现工具、分支记忆和基础集合的组合规则需在实现前核对。

lazySchemas 保留在 Harness Capability 配置中，默认不为每个 Preset 复制一份。Preset 切换 Codemode 模式后，Capability 按生效条件决定是否采用延迟 schema。

## 交互草案

| 入口 | 用途 |
| --- | --- |
| `/preset` | 选择命名配置，显示模型与 thinking 摘要 |
| `/preset NAME` | 应用指定配置 |
| `--preset NAME` | 启动时选择配置 |
| `/preset clear` | 清除当前 Preset；恢复语义需在实现前确定 |

状态栏显示当前 Preset。选择应在会话空闲时应用，配置和模型检查通过后再报告成功。不要照搬参考插件中模型切换失败却继续提示激活成功的处理。

## 提示词与恢复

模型专属指引应使用结构化系统段落，沿用现有增量更新与分支回放机制，不覆盖整份 system prompt。切换时替换本提案拥有的指引段落，保留历史位置。

Preset 选择与清除应写入当前分支。resume、tree、fork 和 reload 应恢复分支对应状态，不能只读取最后一条全会话记录。

以下细节尚未由本轮讨论确定，实施前需要给出具体行为：

- 手动 `/model` 或修改 thinking 后，Preset 名称、专属指引和工具模式如何变化。
- clear 恢复哪些字段；恢复到基础配置还是应用前状态。
- Preset 应用与 CLI 显式模型、thinking、工具参数的优先级。
- 配置编辑后，历史分支恢复使用记录的快照还是当前定义。
- 主会话配置对 Fresh／Inherited Subagent 的影响；不得静默覆盖现有路由。

## 参考与验收

可参考 Pi 的 `examples/extensions/preset.ts` 和社区 [@richardgill/pi-preset](https://pi.dev/packages/@richardgill/pi-preset)。交互形式可复用；工具激活快照、全量 system prompt 拼接和权限恢复语义需按 Harness 契约重新处理。

验收覆盖模型切换失败、thinking 支持范围、工具修饰符、模式切换、提示词段落、分支恢复及多次切换的一致性。在线模型行为与缓存命中需要另行验证。

## 实现边界（P4）

- `model`／`thinkingLevel`／`tools`／`instructions` 在 `/preset NAME` 或 `--preset NAME` 时实时生效。
- `codemode.mode` 受 SDK 限制无法运行时切换：公开 `ExtensionContext`／`ExtensionAPI` 不暴露 settings 写入，`SettingsManager` 也没有 `setCodemodeMode`。Preset 只把该字段记入分支快照用于可复现，应用时不写设置；与当前 Settings 不一致时发 warning 且绝不报成功。需要该模式时在 settings 设置，启动或重载后生效。
- 分支快照保存应用时解析结果（provider／id、thinking、最终工具集合、instructions、codemode）；resume／tree／fork／reload 按快照恢复；`/preset clear` 只写 null 快照并停止管理，不回滚 model／thinking／tools。
- 工具 `+name`／`-name` 始终基于同一基础集合计算，先 A 后 B 与直接应用 B 结果一致。
- 真实 TUI 下的 `/preset` 选择器与 `--preset` 交互尚未在自动化中覆盖（`createAgentSession` 公开选项不注入 extension flag），列为需手动验收。
