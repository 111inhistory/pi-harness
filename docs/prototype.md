# 运行 `work` 实现

当前实现使用 `work-mvp.md` 确认的递归 `attach + items[] + desc[]` 批量 API。`src/work.mjs`、JSONL CLI 和 Pi `work` Extension 共用同一个 dispatcher。

Subagent 不在此 CLI 中模拟；真实 Pi 子 Session 由 `extensions/subagent.mjs` 创建。

## 演示

```bash
npm run demo
```

## 冒烟检查

```bash
npm run smoke
```

## JSONL 交互

```bash
npm run cli
```

每行输入一个结构化操作请求：

```json
{"tool":"work","action":"add","attach":"root","items":[{"title":"验证交互","desc":["记录目标"],"items":[{"kind":"branch","title":"备用路线"}]}]}
{"tool":"work","action":"show","id":"root","depth":2}
{"tool":"work","action":"desc.add","nodeId":"w1","content":"记录这条工作的验证思路。"}
{"tool":"work","action":"desc.query","nodeId":"w1","query":"验证"}
{"tool":"work","action":"desc.delete","nodeId":"w1","entryId":2}
```

`work.show` 直接输出多行纯文本树；其他 `work` 操作暂时返回 JSON。

进程结束后所有状态丢失，这是本轮刻意保留的限制。
