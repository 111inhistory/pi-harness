# 提案：only 模式按 MCP／namespace 延迟暴露 schema

状态：已实现。依赖 [原生工具暴露行为修正](capability-native-exposure-proposal.md)。本文描述可选功能，不构成当前接口契约。

## 目标

对用户指定的大型 MCP 或 namespace，先向模型提供工具名称；模型需要具体参数时再调用 Codemode 的 `describeTool`。该功能用于减少整组 schema 对上下文的占用。默认不启用，不承诺提供方实际缓存命中。

## 配置草案

在 `harness.json` 增加列表：

```json
{
  "capability": {
    "lazySchemas": [
      "mcp://large-service",
      "namespace://large-extension"
    ]
  }
}
```

- 默认值为 `[]`。
- 只接受明确的 MCP／namespace ref，复用现有 ref 解析和组归属，不新增模糊匹配或独立工具模式。
- 项目层列表整体替换全局层列表，遵守项目信任和根配置快照规则。
- 配置匹配工具当前的组归属。直接选择某个组内工具也应应用该规则。

## 生效条件

只有 Codemode 已启用且有效 `codemode.mode` 为 only 时生效。

| 会话状态 | 命中配置的工具组 |
| --- | --- |
| Codemode 启用，only 模式 | 延迟暴露 schema |
| Codemode 启用，on 模式 | 配置不生效，沿用原生行为 |
| Codemode 未启用 | 配置不生效，沿用原生行为 |

配置可预先保留。进入 only 后应用规则，离开 only 后恢复原生声明方式。模式切换本身不应改变启用集合、授权记录或工具 exposure。

## 模型可见行为

- Capability 结果保留组标识、所选工具名称、数量和查询入口说明，不展开参数与返回值 schema。
- `describeNamespace` 返回组信息和成员名称；`describeTool` 返回某个工具的完整接口及调用所需指引。
- 命中配置的成员不产生完整的原生工具声明，也不把 schema 内联到 Codemode description。
- 执行仍经自有沙箱、`ctx.executeTool` 和原有权限管线。
- 不存在可用查询及调用入口的工具按 [启用可达性检查](capability-activation-reachability-proposal.md) 处理。未生效的 lazySchemas 配置本身不是拒绝理由。

名称列表属于发现结果，不应为此向 API 发送缺失参数的占位 function schema。

## 当前实现与改动点

[结果投影](../../src/capability/model-result.ts) 已能在接口可查询时省略重复 schema，但同时省掉了组成员列表。应补充名称列表表达，并保留明确的 `describeTool` 提示。

[Codemode loadout](../../src/capability/codemode.ts) 应同时控制命中成员的独立声明与内联目录。只修改 Capability 返回值不能防止 schema 从其他入口进入请求。

内部检索反馈、分支记忆及继承投影也应检查，防止把同一组完整 schema 再次注入调用者上下文。该配置控制对模型的投影，不应通过删除宿主注册的 schema 实现。

model-only 工具不能经 Codemode 调用。配置命中此类成员时，应明确报告不能采用延迟接口方式，不能隐藏声明后让工具失去入口。

## 验收

- 默认空配置与原有行为一致。
- 同时选择命中与未命中的组，确认仅指定组延迟 schema。
- 覆盖整组选择和单成员选择，检查结果保留名称但不展开 schema。
- 捕获最终请求，确认 schema 未进入独立声明或 Codemode 内联目录。
- 验证 describeTool 返回完整接口，实际脚本调用成功。
- 覆盖 on／only、Codemode 开关、重连、分支恢复及内部继承检索。
- 模式切换前后启用集合与授权保持一致；声明投影可按模式改变。
