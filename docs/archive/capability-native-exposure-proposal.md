# 提案：Capability 遵循原生工具暴露行为

状态：已实现（已归档）。本文保留实现时的改动边界，不构成当前接口契约；当前行为见[接口契约](../interface-contract.md)。

## 目标

Capability 应保留原生工具 exposure 与 Codemode 模式的含义。工具启用集合、模型收到的声明和工具执行资格应分别处理。

`codemode.mode: "only"` 只控制声明，不应通过缩减启用集合实现。普通模式和 only 模式都应允许已激活的 deferred 工具直接声明，并允许符合资格的工具通过 Codemode 调用。

## 当前实现与证据

- [MCP 适配器](../../src/capability/native-discovery.ts) 的 `executionTool` 把非 hidden 工具统一改成 deferred。这是移除原生发现入口时留下的临时适配。当前 Harness 已使用自有沙箱。
- [Codemode 适配器](../../src/capability/codemode.ts) 复用原生 `prepareLoadout`，但只让当前已激活、符合资格的工具进入沙箱和查询目录。
- 原生 only 模式隐藏可嵌套调用的 direct 工具，不隐藏已激活的 deferred 工具。
- [现有集成测试](../../test/typed/capability-native-discovery.test.ts) 明确验证 deferred MCP 工具在 only 模式仍直接声明。核查时，两种扩展加载顺序的测试均通过。该行为应保留。
- SDK 将 MCP 配置的 codemode 映射为工具级 deferred，以避免完整目录进入 Codemode description。这项原生转换与 Harness 的统一改写不同，应保留。

## 拟议行为

| 条件 | 原生声明 | Codemode 调用 |
| --- | --- | --- |
| on 模式，已激活的 direct 工具 | 保留 | 按资格允许 |
| on 或 only 模式，已激活的 deferred 工具 | 保留 | 按资格允许 |
| only 模式，可嵌套调用的 direct 工具 | 按原生规则隐藏 | 按资格允许 |
| model-only 工具 | 按原生规则声明 | 不允许嵌套调用 |
| hidden 工具 | 不声明 | 不允许 |
| 未经 Capability 选择的 MCP 工具 | 不声明 | 不允许 |

[按组延迟 schema](capability-lazy-schemas-proposal.md) 是显式配置的例外，默认关闭。only 模式本身不承诺发现工具后所有 API 声明保持不变。

## 改动范围

1. 移除 MCP 适配器对所有非 hidden exposure 的统一改写。保留原生注册得到的 exposure、单工具覆盖及后端连接管理。
2. 保留 Capability 的按需选择、默认激活控制和分支准入。恢复 exposure 不应让未选中的 MCP 工具自动出现在模型目录或执行入口。
3. 复用原生 Codemode loadout 与声明隐藏规则。隐藏声明不应改变工具启用集合或工具自身 exposure。
4. 核对 MCP 重连、延迟注册和 `/mcp` 修改 exposure 后的行为。
5. 修正文档中把启用、声明和执行资格混为一谈的说明。

## 保留的实现

Capability 内部继承检索会话已区分历史声明与执行资格。[检索占位工具](../../src/capability/retrieval-tools.ts) 保留接口，但不会调用父会话的工具。内部检索工具以外的调用继续被拒绝。该机制不需要重写。

原生 `tool_search` 和全局 MCP 资源枚举继续关闭。自有沙箱不重新引入 `searchTools`；模型通过 Capability 发现，通过现有查询接口读取已启用工具。

## 验收

- 覆盖 direct、deferred、model-only、hidden，以及 MCP codemode 配置的原生映射。
- 验证 on／only 切换不增减启用集合，且 deferred 在 only 模式仍直接声明。
- 验证两种扩展加载顺序、重连、延迟注册和 exposure 更新。
- 验证未选中的 MCP 工具、manual 工具和角色拒绝不能绕过现有准入。
- 回归内部继承检索的声明前缀保留与执行隔离。
- 使用真实 SDK 和离线模型检查序列化请求；在线缓存命中不作为离线测试结论。
