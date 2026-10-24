# OpenAI 原生压缩兼容性调查

## 当前处理决定

作者决定暂不向上游提 issue，也不在本项目继续修复或替换压缩插件。压缩方案由作者另行处理。

本页与复现材料保留调查事实。本项目继续推进独立的架构工作，不将压缩兼容修复作为前置条件。若作者恢复本项工作，再核对依赖版本和上游状态。

## 作者后续补充：Magpie

作者确认，其研究的 Magpie 方案可以保留 `additional_tools`。压缩策略等配置在 Magpie 中完成，不属于本项目的职责。

Magpie 可以与本项目同时使用。作者认为两者互补、使用门槛较低，但尚未决定是否采用。本项目不因此增加 Magpie 依赖或集成工作。

本节记录作者提供的信息，不表示本轮另做了 Magpie 端点验证。

## 结论与范围

**已复现原生压缩回放被当前 Responses 工具声明阻断的问题。** 不能用此前 Pi 本地压缩通过的结果，推断原生端点链路正确。

作者描述的现象不是调用时报 `Tool not found`，而是 Main 在 Capability 再次返回前不再使用此前发现的能力。作者说明使用 OpenAI 原生压缩。

本轮验证对象（2026-10-24）：

- Pi SDK、Pi AI：本机安装版本均为 `1.4.0`。
- 模型描述：`openai-codex/gpt-6.1-sol`，支持中途系统消息和 `additional_tools`。
- 配置中的原生压缩包：`@lll9p/pi-better-compaction@0.7.4`。
- 当前工作区的 Capability 请求投影代码。

测试使用真实 SDK 的请求构造器、已安装压缩插件的序列化和回放函数，以及真实 `before_provider_request` 处理函数。端点响应使用合成的不透明压缩项，不发送网络请求，也不使用真实凭据。

结果确认本地链路的结构性缺陷，尚未证明作者那次实际运行发生了完全相同的失败。本轮没有测试真实模型是否重新选择工具，也没有读取或解密压缩内容。

## 问题一：构造压缩请求时漏掉工具声明与请求投影

当前 Pi Responses 把工具定义放在 `input` 中的 `additional_tools` 项，而不一定放在顶层 `tools`。

压缩插件有两处不同假设：

- `src/request-context-cache.ts:35–37` 只缓存顶层 `payload.tools`，没有提取 `input.additional_tools`。
- `src/serializer.ts:166–213` 只序列化用户、助手和工具结果，跳过系统消息及其工具声明和 section 更新。

插件的 `src/extension-runtime.ts:334–367` 又通过 `ctx.getSystemPrompt()` 与原生会话上下文构造压缩输入。项目的 `<capabilities>` 属于请求期投影，并不直接包含在 `ctx.getSystemPrompt()` 中。

最小测试结果：

| 检查点 | 结果 |
| --- | --- |
| 正常请求存在 `additional_tools` | 是 |
| 正常请求存在 `<capabilities>` | 是 |
| 插件构造的压缩请求包含顶层工具定义 | 否 |
| 插件构造的压缩输入包含 `additional_tools` | 否 |
| 插件构造的压缩请求包含 `<capabilities>` | 否 |

Capability 的工具正文还可能省略已经声明的完整接口，因而不能假定压缩器可以从普通工具结果重建所有接口和共同指引。

## 问题二：原生回放校验拒绝 `additional_tools`

插件的 `src/payload-rewrite.ts:307–335` 提取新的 system／developer 前言，再用本地序列化器生成预期输入。该序列化器没有生成 `additional_tools`，实际输入却含有该项。

`src/payload-rewrite.ts:508–520` 的输入比对因此返回 `expected-pi-replay-mismatch`。部分含中途 system／developer 更新的布局，还可能先返回 `unsupported-instructions`。

插件在 `src/extension-runtime.ts` 的 `handleBeforeProviderRequest` 中遇到比对失败后返回 `undefined`。这表示沿用 Pi 原请求，不是使用不透明压缩窗口。

对于没有可读摘要的原生压缩，Pi 保存的摘要只是 `[OpenAI native compaction checkpoint]`。如果原生回放被跳过，下一次请求就可能只保留占位摘要，而没有携带压缩后的历史。

### 实际处理函数验证

| 输入 | 返回原生回放覆盖 | 最终候选含不透明压缩项 | 最终候选含占位摘要 |
| --- | --- | --- | --- |
| 当前 SDK 的真实声明布局 | 否 | 否 | 是 |
| 仅去掉 `additional_tools` 的诊断对照 | 是 | 是 | 否 |

对照输入仅用于定位比对失败的原因，不是修复方案。直接删除工具声明会破坏工具可用性。

脚本快照见[原生压缩复现脚本](reproductions/native-compaction-replay.mjs)，输出见[原生压缩验证输出](reproductions/native-compaction-replay.log)。环境与运行方式见[复现材料说明](reproductions/README.md)。

## 与“工具丢失”的关系

工具仍可能存在于宿主注册表和 API 声明中，但模型收到的任务历史和能力使用线索已经改变。因此，调用未报错不代表压缩链路正确。

当前 Capability 记忆投影在最小测试中仍能把本地选择重新放入 `instructions`。但这不能修复整段不透明历史未回放的问题，也不能证明模型保留了此前的使用背景。

上述缺陷可以造成语义上下文丢失，构成可报告的兼容问题。本项当前搁置，不表示已经修复。是否完整解释作者报告的行为，仍应以相同插件配置下的最终请求和任务场景验证。

## 另外确认的独立问题

- `src/responses-tool-prefix.mjs:41–42` 丢弃同名新版工具描述和 Schema。当前 SDK 原生支持替换声明，不应以旧版缓存策略阻断更新。
- `src/capability-prompt.mjs:60–61` 只读取直接 Capability 工具结果。嵌套调用不保存该结果的 `details`，因此发现记忆在压缩前就可能缺失。
- 空闲时激活工具、但尚未运行声明步骤就重载，会丢失未记录的激活。该路径不同于完成正常工具轮次后的普通压缩，不作为本次原生端点问题的根因。

## 供架构讨论参考的约束候选

以下条目是从实验得到的修改方向，不替代当前接口契约，也不表示方案已经批准。

- 检索结果累积、宿主工具状态和最终 API 声明分别有明确来源。
- 成功选择由宿主记录，不依赖外层工具正文能否持久化内部结果。
- 原生压缩与回放识别当前 SDK 的声明布局，不假定所有工具在顶层 `tools`。
- 请求期指引与原生压缩插件的后置改写协调，检查最终请求而不是只检查改写前投影。
- 原生窗口无法回放时，不把占位摘要当成完整恢复，也不让 Main 通过重新 Capability 掩盖历史丢失。
- 保持不透明端点输出的完整性，不通过改写加密项或盲目剪裁输出修复问题。

## 上游 issue 与 PR 查重

本轮通过 `gh` 核对仓库全部开放和已关闭的 3 个 issue、8 个 PR，以及 issue／PR 会话评论。仓库为 `lll9p/pi-better-compaction`。

```bash
gh issue list --repo lll9p/pi-better-compaction --state all --limit 100 --json number,title,state,url,body
gh pr list --repo lll9p/pi-better-compaction --state all --limit 100 --json number,title,state,url,body
gh api 'repos/lll9p/pi-better-compaction/issues/comments?per_page=100' --paginate
```

**未找到直接覆盖 `additional_tools` 导致原生回放失败的报告。** 公开搜索索引未命中，但该结果没有用于判断仓库不存在 issue；最终判断依据是仓库直接查询。

| 记录 | 查询时状态 | 内容与本次缺陷的区别 |
| --- | --- | --- |
| [PR #5：Preserve native replay with pruned tool outputs](https://github.com/lll9p/pi-better-compaction/pull/5) | 已合并 | 工具结果被裁剪后，按调用 ID 比对；其他消息仍要求精确匹配。未覆盖 `additional_tools` 声明 |
| [Issue #6：system 消息引起序列化崩溃](https://github.com/lll9p/pi-better-compaction/issues/6)／[PR #7](https://github.com/lll9p/pi-better-compaction/pull/7) | 已关闭／已合并 | 修复把 system 消息当工具结果的崩溃。PR 选择跳过 system 消息，并认为 `instructions` 已包含系统指引；本次发现请求期 section 与工具声明不满足这个假设 |
| [PR #10：切换模型后的原生检查点警告](https://github.com/lll9p/pi-better-compaction/pull/10) | 已合并 | 明确记录未回放窗口时只剩占位摘要与保留消息的后果。触发条件是模型切换，不是本次同模型下的输入比对失败 |
| [Issue #11：Codex 的 `ctc_` 工具调用 ID 不兼容](https://github.com/lll9p/pi-better-compaction/issues/11) | 已关闭 | 序列化后的 `function_call` 使用不匹配的 item ID，导致 HTTP 400。维护者评论称已在 main 的 `74a4b71` 修复；未覆盖本次声明与回放问题 |

查重结果支持单独报告，但作者已决定暂不提 issue。本轮没有创建 issue、评论或 PR。

## 若恢复本项工作

届时先建立插件与当前 SDK 的组合回归，再讨论修改边界。回归应检查最终请求中的声明、指引、压缩项和新消息，并断言不重新调用 Capability。

真实模型行为测试再检查 Main 是否继续使用既有能力，不能只让模拟模型强制调用指定工具后就宣称问题修复。

本轮未修改项目实现、第三方插件或用户配置。
