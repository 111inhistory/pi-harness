# Manual 能力验收记录：完整 SDK、在线组合与准入开销

记录日期：2026-11-03。代码基线：分支 `feat/subagent-cross-session`（含 `feat/capability-manual-enable` 的 manual 能力），准入收敛提交 `97ccc3e`。

本页保存检查时的证据与运行方式，不描述当前产品契约。当前行为见[接口契约](../interface-contract.md)与[Harness 参数配置](../harness-configuration.md)。

## 1. 完整 SDK 离线验收

测试文件：`test/typed/capability-manual-sdk.test.ts`。它不是 handler 装配测试：用例通过真实 `createAgentSession` 建立会话，经 `DefaultResourceLoader` 加载真实 harness 装配，`capability.manualTools` 从临时 agent 目录的 `harness.json` 读取，MCP 服务是 `test-support/synthetic-mcp-server.mjs` 的**真实 stdio 子进程**（换行分隔 JSON-RPC 2.0），只有模型是离线脚本。

覆盖的场景：

| 场景 | 断言 |
| --- | --- |
| `defaultActive` manual 工具未授权 | 首个请求不声明该工具；SDK 激活集在 `before_agent_start` 后被裁剪；模型强制发起的直接调用返回 `Tool manual_fixture not found` |
| 未授权时 Codemode | `ALL_TOOLS` 不含该工具，`describeTool` 返回空，脚本内调用被拒绝 |
| 用户命令启用 | 通过真实会话的已注册命令与 `createCommandContext()` 执行 `/capability enable`，通知为 `Enabled: ...`，三个名字进入激活集 |
| 启用后可达 | 下一请求声明 manual 工具、manual MCP 工具与 `read_mcp_resource`；直接调用返回 `MANUAL_FIXTURE_EXECUTED`；MCP 工具经真实子进程返回 `MCP_DEPLOY_EXECUTED`；Codemode 脚本可调用两者 |
| manual MCP 选择与资源读取 | `read_mcp_resource` 对已启用服务器返回 `SYNTHETIC_MCP_RESOURCE`，对未选择服务器仍被拒绝 |
| Main / 子作用域隔离 | 第二个真实 SDK 会话经 `setCapabilityParent` 挂在同一根下，**注册与根相同的 `manual_fixture` 和 `mcp__manual_fixture__deploy`**（断言两者确实注册），分支携带根的 `manual` 记录：子会话不声明这两个工具、投影中无 `"category":"manual"`、直接调用被拒绝 |

运行方式与结果：

```sh
node --import tsx --test test/typed/capability-manual-sdk.test.ts
# ok 1 - full SDK: manual tools stay unreachable until /capability enable, then work in Main only
# duration_ms ~280
```

负向对照（未提交变异代码，运行后已还原）：

- 把 `admitsManual` 临时改为恒真，用例在第一条断言（未授权工具不得声明）失败；
- 同时放宽子作用域 manual 资格（`scope.ts` 不再为非根节点剔除 manual 名字，且 `admitsManual` 不再要求 `scope.root`），用例在「a child scope never declares a manual tool」失败。两层各自都能独立拦截，只有同时放宽才会暴露，说明子作用域用例确实依赖被检查的资格规则，而不是目录里恰好没有该工具。

## 2. 在线组合

入口：`scripts/verify-capability-manual-online.mjs`。它用真实 `createAgentSession`、真实提供方模型与 `mcp.json` 中真实 MCP 服务器运行同一契约；manual 名单以内存配置注入，不修改 `harness.json`；MCP 日志写入临时目录；不写会话文件；**不调用任何 MCP 工具**，只列出并激活，因此在线运行没有服务器副作用。

```sh
node --import tsx scripts/verify-capability-manual-online.mjs [--agent-dir DIR] [--model PROVIDER/ID] [--server NAME]
```

本次运行（本机已有配置，未改动任何文件）：

```text
[info] provider=deepseek model=deepseek-flash server=video_ffmpeg agentDir=...
[info] before enable: active=6 fixtureActive=false
[info] /capability enable -> info
[info] manual_fixture executed through the real model
[info] MCP tools activated without calls: 12; resource reader not registered by this server
[pass] manual gating and /capability enable verified online; no MCP tool was called
```

同机其他服务器（`computer-use-linux`、`firefox-devtools`、`splayer-next`）在 20 秒内未注册工具，未用于本次证据；入口会以退出码 2 报告缺失依赖（无模型认证、无 `mcp.json` 服务器等）而不创建配置。

在线证据只覆盖这一次运行：单个提供方、单个 MCP 服务器、两轮模型调用。它证明的是连接、注册、manual 门禁、命令启用和本地 fixture 工具的真实模型调用；**没有调用任何真实 MCP 工具**（只列出并激活），也没有做真实资源读取。以下仍未验证：真实 MCP 工具调用、其他提供方的多轮遵循情况、`read_mcp_resource` 的真实资源读取（本次服务器未注册资源读取工具）、启用后 MCP 断连的行为、长时间运行。

## 3. 准入开销

脚本：`scripts/capability-admission-bench.mjs`（无基准依赖、无缓存、无遥测）。两个对照臂读取**同一组合法分支记录**、使用**同一个准入规则**（普通工具看作用域，MCP 工具还要在分支选择里，manual 工具还要用户记录且仅限根作用域），只在解析次数上不同：

- `per-name`：收敛前的形状，每个工具名解析一次作用域并完整扫描一次分支记录（本脚本内的参考实现，不进入产品代码）；
- `per-operation`：当前实现，`createToolAdmission` 每次操作解析一次，逐名字复用谓词。

分支记录是 `discoveryRecords` 真正解析的 `{type:"custom", customType:"capability-discovery", data:{version:1, result:{status:"ok", …}}}` 形状，每场景先断言解析条数等于记录数、两臂准入名字集合完全相同，再计时。样本覆盖普通工具、MCP 成员和 manual 工具（根作用域设置 `manual_*` 策略，每三条记录有一条用户启用），因此两臂的准入集合随记录数与深度变化（例如 60 工具/50 记录：根 47 个、深度 3 为 40 个）。

样本：普通工具数 20/60/150（目录总工具数 60/180/450），分支记录数 0/10/50，作用域深度 1/3；每次 10 次预热 + 60 次迭代，取中位数。

```sh
node --import tsx scripts/capability-admission-bench.mjs
```

| 深度 | 工具 | 记录 | 两臂准入 | per-name ms | per-operation ms | per-name 读次数 | per-operation 读次数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 60 | 0 | 20 | 0.216 | 0.013 | getAll 60，分支扫描 60 | getAll 2，getActive 1，分支扫描 1 |
| 1 | 180 | 10 | 74 | 2.143 | 0.022 | getAll 180，分支扫描 180 | 同上 |
| 1 | 450 | 50 | 217 | 21.574 | 0.078 | getAll 450，分支扫描 450 | 同上 |
| 3 | 60 | 0 | 20 | 0.575 | 0.016 | getAll 180，分支扫描 60 | getAll 4，getActive 1，分支扫描 1 |
| 3 | 180 | 50 | 110 | 10.654 | 0.072 | getAll 540，分支扫描 180 | 同上 |
| 3 | 450 | 50 | 200 | 46.442 | 0.145 | getAll 1350，分支扫描 450 | 同上 |

读次数结论：`per-operation` 的目录读取只随作用域深度线性增长（深度 + 1 次 `getAllTools`、1 次 `getActiveTools`、1 次分支扫描），不随工具数或记录数增长；`per-name` 的读取随工具数线性增长，且每个名字都重扫一次分支。

耗时结论与局限：同一台机器、同一进程内的中位数，样本为合成工具与合成记录，未控制 GC 与 JIT，也没有跨机器数据。固定读次数不等于恒定总耗时：`per-operation` 的耗时仍随工具数缓增（450 工具约 0.08–0.15 ms），只是从平方级降为线性级。该表是参考实现对照，只用于确认收敛没有引入退化，不作为性能承诺。

## 4. 未覆盖

- Windows：manual 门禁的代码路径与平台无关，但未在 Windows 实机运行；跨 session 协调在 Windows 明确未实现。
- 真实 MCP 工具调用（离线用真实 stdio 子进程调用，在线只做注册与激活）、真实 MCP 服务器的资源读取、断连后重新启用、以及启用记录残留的补偿行为。
- 多提供方、长时压测与真实多进程并发。
