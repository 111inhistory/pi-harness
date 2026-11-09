# 提案：Capability 启用时检查调用入口并提示部分失败

状态：已实现（已归档）。与 [原生工具暴露行为修正](capability-native-exposure-proposal.md) 一起完成，为 [延迟 schema](capability-lazy-schemas-proposal.md) 提供统一检查。

## 目标

Capability 应拒绝启用当前会话没有可用调用入口的工具。模型应收到具体原因，用户应看到汇总 warning。可用工具与 Skill 不应因其他成员不可用而被一并丢弃。

## 判断规则

检查实际声明与调用路径，不根据 deferred 标签一概拒绝。

| 情况 | 处理 |
| --- | --- |
| deferred 工具能直接声明，Codemode 未启用 | 正常启用 |
| 工具只有 Codemode 调用路径，但 Codemode 未启用或不符合当前资格 | 拒绝该成员 |
| lazySchemas 配置存在，但当前不处于启用 Codemode 的 only 模式 | 配置不生效，按原生入口判断 |
| 工具被 hidden、manual 策略或作用域拒绝 | 保留现有拒绝原因 |

原生 only 模式不能作为“没有 Codemode 就不能使用 deferred”的依据。工具必须满足自身执行资格，Codemode 也必须满足当前会话资格。

## 返回与界面

- 部分选择可用时，返回 partial，保留成功项，列出未启用的工具或组及原因。
- 没有可用工具且没有成功 Skill 时，返回失败。
- 模型提示应说明“部分工具／MCP／namespace 无法启用，因为当前未启用可用的 Codemode 入口”等具体原因。
- 用户界面显示一条汇总 warning。分组展示原因，避免为大型 namespace 的每个成员分别刷屏。
- 界面与模型提示正文使用英文，遵守仓库语言约定。
- 不自动启用 Codemode，不静默把间接工具提升为直接声明。原生 MCP 自己的自动激活行为仍按原生配置运行。

## 改动范围

[激活入口](../../src/capability/activation.ts) 提供共用的可达性判断及拒绝原因。[模型发现](../../src/capability/extension.ts) 与 [用户启用](../../src/capability/enable.ts) 使用同一规则，并分别渲染结果。

模型发现应在写入成功选择记录与激活前排除已知不可达成员，避免把未启用工具记录为可用。SDK 激活后的实际集合仍需读取，以处理现有激活掩码。

不扩大为本轮的通用事务、自动回滚或历史授权撤销机制。后续模式变化仍由实时执行准入检查。

## 验收

- 验证无 Codemode 时正常 deferred 工具仍能启用和直接调用。
- 验证实际依赖 Codemode 的成员被拒绝，且没有成功选择记录。
- 验证部分成功、全部失败、工具失败但 Skill 成功三种返回。
- 验证模型结果与用户 warning 一致，警告按组汇总。
- 验证模型发现和 `/capability enable` 的判断一致。
- 验证现有 manual、MCP 选择、作用域与激活掩码拒绝原因不被覆盖。
