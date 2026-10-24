# Work：暂缓的能力探索

**Work 能力仍有需求，但当前方案暂缓。是否做成 Pi 插件尚未决定。**

本目录集中保存工作树、交互原型、测试和设计记录。代码不属于主线运行时，也不由 `extensions/harness.ts` 加载。保留 Pi 接入文件只供实验，不表示已经确定交付形态。

## 已保留的能力

- 用递归 TODO 和分支记录工作结构。
- 用稳定节点 ID 查看工作项和切换查看焦点。
- 在节点上添加、删除和查询说明条目。
- 输出局部或完整的纯文本树。

原型只记录工作，不执行任务，不启动 Subagent。数据仅保存在内存中，进程退出后丢失。状态转换、传播规则和持久化尚未完成，不应作为既有能力使用。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/work.mjs` | 独立的内存工作树与 dispatcher |
| `prototype/` | JSONL CLI 和演示 |
| `extensions/work.mjs` | 未定案的 Pi 接入实验 |
| `test/work.test.mjs` | 原型行为测试 |
| `docs/work-mvp.md` | 保留的 API 与未决设计 |
| `docs/prototype.md` | 运行说明与 JSONL 示例 |

## 显式运行

以下命令从仓库根目录执行，不加载主线扩展。

查看演示：

```sh
node experiments/work/prototype/demo.mjs
```

检查演示断言：

```sh
node experiments/work/prototype/demo.mjs --assert
```

运行原型测试：

```sh
node --test experiments/work/test/work.test.mjs
```

启动 JSONL 交互：

```sh
node experiments/work/prototype/cli.mjs
```

每行输入一个请求，例如：

```json
{"tool":"work","action":"add","attach":"root","items":[{"title":"探索交付形态"}]}
{"tool":"work","action":"show","id":"root","full":true}
```

## 后续决策

恢复开发前，先确认交付形态及其实际使用场景。Pi 插件、独立工具和其他接入方式均未定案。现有原型用于保留证据与验证交互，不要求后续实现沿用全部 API、文件布局或状态模型。
