# Subagent 存储 v2 半成品复核

> 历史审查记录：结论仅覆盖检查时的代码与环境。当前行为见[接口契约](../interface-contract.md)，未修复项见[已知问题](../known-issues.md)。

> 本文保留接入前的检查结论，不代表最新工作树。后续接入与验证见[插件内存收敛](subagent-memory-review.md)。

## 范围与结论

**当前存储 v2 尚未接通，不应恢复真实 Subagent 运行。** Capability 本次只验证了隔离的资源发现与文件读取，不据此声明其实际执行后端可用。

本次先完成资源协议删除与 Work 隔离，再只读检查存储代码。没有调用当前会话的 Capability 或 Subagent 工具，没有修改存储生产代码，也没有转换、清理或打开用户真实会话文件。

当时的审查依据是原始存储提案及工作树中的存储、Runtime、继承捕获、历史视图和适配层，检查点为 WIP 提交 `3f6eba6`。原提案仅在 Git 历史中追溯，不再作为当前文档入口；现行格式见[存储说明](../subagent-storage.md)。该 WIP 提交同时包含此前整理和部分存储改动，不能把全部差异都归为存储 v2。

文档中的文件大小和 2.8 GiB 堆用量来自此前实测，本次没有重新测量真实会话。

## 已接入与未接入

| 部分 | 当前代码 | 边界 |
| --- | --- | --- |
| 继承捕获 | `src/inherited-context.mjs:112` 排除 `subagent-*` 记录 | 已切断继承时复制宿主记账的一条路径 |
| 根分支存储 | `src/subagent-storage.mjs` 提供事件折叠、文件位置、写时复制、ID 扫描和读取缓存 | 适配层仍使用旧接口 |
| Runtime | 接收 `onEvent`、`prepareInherited`、`isIdTaken` 等接口，持久化 spec 排除对话条目 | 适配层未提供新回调 |
| Job 历史视图 | `src/subagent-view.mjs` 提供按 Job 的派生视图 | 适配层仍导入旧 `subagent-history.mjs` |
| 旧会话转换 | 提案规定独立转换脚本 | 当前未见转换脚本；本次未运行旧裁剪脚本 |

## 已确认的问题

### 1. P0：持久化会静默退化为内存模式

`src/subagent-storage.mjs:195–200` 要求 `readEntries` 才将存储标为 durable。`extensions/subagent.mjs:401–412` 没有提供该字段。

隔离构造探针结果：

```json
{"durableWithCurrentOptions":false,"durableWithReadEntries":true}
```

因此，只补一个事件回调还不够。应同时对接全分支扫描，否则持久化、跨分支 ID 防复用也不能成立。

### 2. P0：事件写入、恢复与文件接口尚未迁移

- `extensions/subagent.mjs:379` 仍传 `onStateChange`；Runtime 构造器在 `src/subagent-runtime.mjs:313–358` 接收的是 `onEvent`。
- 适配层仍调用 `hydrate`、`save`、`childSessionFile`、`hasSessionFile` 和 `readHistory` 等旧接口。
- 新存储导出的是 `append`、`childFile`、`openForAppend`、`readSlice` 等接口，见 `src/subagent-storage.mjs:407–425`。

当前不能把“根会话不再写全量快照”视为修复成功：也可能是新持久化根本没有启用。类型检查通过不能证明这组 JavaScript 接口已经对齐。

### 3. P1：内存回收路径仍是旧实现

`extensions/subagent.mjs:1552–1569` 仍把完整 `SessionManager` 留在 `retained`。Job 退出时仍刷新 descriptor，未切换到只保留元数据的模式。

此外，适配层没有提供 `prepareInherited`。Runtime 在 `src/subagent-runtime.mjs:436–439` 回退到逐子任务调用 `copyInheritedEntries`；该函数在 `:155–159` 使用 `structuredClone`。

继承捕获过滤宿主事件是有效改动，但不能代替种子落盘后释放、Job 结束后释放会话和移除多份对话副本。OOM 修复仍未闭合。

### 4. P1：中断历史结束位置可能跨越下一个 Job

`src/subagent-storage.mjs:380–393` 将起点标记的所有后代都当作同一 Job 的历史。后续 Job 的起点标记也是前一 Job 的后代，因此不能单靠祖先关系区分轮次。

隔离条目序列：

```text
job1-start → job1-last → job2-start → job2-last
```

调用 `interruptedEnd(file, "job1-start")` 实际返回 `job2-last`。Rewind 到 Job 1 尚未终态的位置后恢复，可能把已放弃分支上的后续 Job 对话算进 Job 1。

本探针使用临时文件和注入的条目读取器，不是真实 SDK 端到端验证。实现接入前应明确停止于后续 Job 标记的规则，再补真实 SessionManager 分支回归。

### 5. P2：身份更新语义与提案不一致

提案第 4.1 节规定身份变化只写变化字段。`src/subagent-storage.mjs:160–165` 却整条替换 `actor.record`，并在缺少 anchor 时设为 null。

隔离探针先写入 file、tools、anchor，再只更新 model；折叠结果只剩 model，anchor 为 null。

应先确定身份事件是完整替换还是字段补丁。如果采用补丁，应保留未更新字段；如果采用完整替换，应修正文档并核对大字段重复写入量。不要让适配层和折叠器各自解释。

## 后续接入顺序（待确认）

1. 固定 v2 事件和身份更新语义，验证 durable 判定与全分支 ID 占用。
2. 完整迁移适配层的创建、恢复、续跑、通知追加和事件写入，不混用旧快照接口。
3. 接入种子物化、完成后的会话释放和按 Job 历史视图，关闭剩余内存副本路径。
4. 用隔离的真实 SessionManager 文件验证 Rewind、Fork、写时复制、中断区间及写入失败。
5. 断言文件增长量和堆用量，不只断言任务能完成。真实会话转换应另行离线执行，先 dry-run 和备份。

本次没有实施上述步骤，也没有为旧接口添加兼容层。
