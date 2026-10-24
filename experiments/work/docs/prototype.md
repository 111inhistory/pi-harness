# 运行 Work 原型

**本原型暂缓，不属于主线功能。是否做成 Pi 插件尚未决定。**

原型保留 [Work 原型 API](work-mvp.md) 中的递归 `attach + items[] + desc[]` 交互。内存工作树、JSONL CLI 和 Pi 接入实验共用本目录的 dispatcher。

CLI 不模拟 Subagent，也不依赖主线 Capability 或协议路由。以下命令从仓库根目录执行。

## 演示

```bash
node experiments/work/prototype/demo.mjs
```

## 冒烟检查

```bash
node experiments/work/prototype/demo.mjs --assert
```

## JSONL 交互

```bash
node experiments/work/prototype/cli.mjs
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
