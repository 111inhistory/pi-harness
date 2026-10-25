# 复现脚本与输出

本目录保存问题调查中的脚本快照，不属于产品代码或默认测试集。

边界脚本中的许可与代次守卫是候选算法，不是产品实现。负向对照观察到事件丢失或取消后提交，不表示脚本执行失败，也不表示产品已经修复。

## 材料

| 脚本 | 输出 | 验证对象 |
| --- | --- | --- |
| `native-session-memory.mjs` | `native-session-memory.json` | 原生 manager、浅数组、深拷贝和 dispose 后持有引用的 GC 对照；不调用模型 |
| `native-compaction-replay.mjs` | `native-compaction-replay.log` | 原生压缩插件的请求构造、回放比对和实际请求处理函数 |
| `steer-message-update.mjs` | `steer-message-update.jsonl` | 七个含断言的对照：原对象／队列引用修改、公开消息替换、出队后更新、用户消息隔离与异步间隔；检查磁盘历史 |
| `notification-steer.mjs` | `notification-steer.jsonl` | 当前通知格式通过 Pi steer 路径投递，验证忙碌、空闲和中断结束后的行为与附加信息保留 |
| `message-delivery.mjs` | `message-delivery.jsonl` | Main 执行工具期间的消息合并、原生历史与空闲唤醒 |
| `message-boundaries.mjs` | `message-boundaries.jsonl` | 最终回复后的继续、取消／退役竞态、草稿覆盖和空闲唤醒守卫；含断言 |
| `local-compaction-capability.mjs` | `local-compaction-capability.jsonl` | 本地压缩前后的工具声明、实际执行和直接／嵌套发现记忆 |

## 环境与限制

记录时间为 2026-10-24。脚本依赖本机 Pi `1.4.0`。原生压缩脚本另依赖压缩插件 `0.7.4`，消息投递与边界脚本不依赖该插件。源码中保留本轮调查的绝对路径。跨机器运行前应核对这些路径与版本。

脚本使用模拟模型输出；原生压缩测试另用合成压缩项。构造 Codex 请求的脚本在 `onPayload` 阶段中止；消息投递脚本直接替换模拟 stream，不发送网络请求，也不使用真实凭据。

脚本可能创建 `/tmp/` 下的隔离认证文件或临时目录，不修改项目实现、第三方插件或用户配置。输出只代表记录中的验证场景，不代表真实模型行为或真实压缩端点已经验证。

## 运行

在上述环境中执行：

```bash
node --expose-gc --max-old-space-size=256 docs/reviews/reproductions/native-session-memory.mjs
node docs/reviews/reproductions/native-compaction-replay.mjs
node docs/reviews/reproductions/local-compaction-capability.mjs
node docs/reviews/reproductions/message-delivery.mjs
node docs/reviews/reproductions/message-boundaries.mjs
node docs/reviews/reproductions/notification-steer.mjs
node docs/reviews/reproductions/steer-message-update.mjs
```

先阅读[原生压缩调查](../native-compaction-review.md)或[消息投递验证](../message-delivery-review.md)，再解释对应输出。
