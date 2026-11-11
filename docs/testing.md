# 测试架构与设计关联

测试应保护一条可陈述的设计契约，或防止一个实际发现的缺陷复发。测试数量、内部函数数量和提交数量不作为覆盖充分的依据。

## 测试的两类依据

| 类别 | 依据 | 断言目标 |
| --- | --- | --- |
| design | 当前有效文档的具体章节 | 在公开输入和生命周期下，产品遵守约定的行为 |
| regression | 实际缺陷的触发条件、可见失败和证据记录 | 原来的失败条件不再导致该缺陷 |

设计测试与回归测试可以共用执行文件。回归属于已有契约时，优先扩展原用例。SDK、IPC、文件系统和纯逻辑是执行环境，不应仅为标记“验收”而重复同一行为。

一个行为文件应围绕稳定的契约或生命周期组织。内部函数拆分不要求增加对应测试文件。强边界包括外部输入、持久化恢复、跨会话资源归属、代次隔离和交接结果未知；这些边界需要覆盖实际故障条件。

## 测试价值评审

新增或修改测试时，应说明保护的设计章节或已发现的问题，以及现有测试未覆盖的独立条件。

以下用例应合并、改写或删除：

- 期望值由被测实现的同一计算过程生成，没有独立的行为依据。
- 仅比较夹具自行写入和自行读出的值，产品路径没有参与。
- 假 host 跳过真实入口，却把辅助函数组合测试称为 SDK 或完整生命周期验收。
- 只断言内部调用顺序、固定字段复制或与实现等价的条件，没有对应契约。
- 同一输入和失败条件在多个层次重复断言，但不能发现额外故障。

纯逻辑测试仍可用于复杂算法或状态转换。使用真实 SDK 也不自动证明测试有价值。评审应检查断言是否能在目标行为被破坏时失败；修复实际缺陷时，宜验证回归在修复前失败、修复后通过。

## Complexity and resource verification

For changes whose work grows with history, tools, rules, actors or subscriptions, state the relevant input sizes and assess the complete call path. Count replay, catalog reads, matching, sorting, serialization and synchronous I/O across nested callers. Separate one-time initialization from work repeated per tool, request or event; include event-loop stalls when the same process owns the TUI. Complexity notation is a model, not evidence of a severity level. Confirm the trigger and user-visible impact before adding indices, batching or caches.

Assess three different memory costs:

| Cost | Evidence to collect |
| --- | --- |
| Allocation volume | Repeated arrays, object projections, serialization and temporary buffers created during an operation, even when later collected |
| Peak live memory | Source history, copies, projections, buffers and concurrent children/requests held at the same time; include backing data kept alive by shared slices or closures |
| Retained memory | Objects still reachable after the owning operation or subscription is released, with intended durable/live-session state accounted for |

Model growth against the right population: current active subscriptions, historical subscription count, live actors or all retained actors are different bounds. A collection growing with required durable actors is not automatically a leak; an accumulation proportional to canceled subscriptions is not bounded by active subscribers. A faster cache may retain histories or sessions indefinitely. Record both the saved work and the retained-data bound before choosing it.

For lifecycle changes, identify the strong-reference chain and the owner that breaks it. Include maps/sets, closure captures, unresolved Promise continuations, event emitters, sockets and request queues. Verify applicable completion, cancellation, unsubscribe, disconnect, partial-startup failure and root-retirement paths. Distinguish suppression of late delivery from removal of callbacks and waiters. Preserve ownership fences until the underlying session or resource has actually exited; weakening a fence is not a memory fix.

Use deterministic assertions for teardown where possible, such as detached listeners, removed waiters, closed owned handles and unchanged active-observer counts across repeated subscribe/cancel cycles. Those assertions support, but do not alone prove, whole-object collectability. For suspected retention, use isolated process measurements, heap/reference inspection or explicit-GC diagnostics with event-loop turns. Account for references held by the diagnostic itself: `WeakRef.deref()` can keep an object alive for the current job. A `WeakMap` entry only stops retaining its key through that map; another strong path can retain the key and its graph. Do not rely on finalizer timing to release resources or make normal tests depend on prompt collection.

Measure comparable phases and workloads. RSS can remain high after objects are collected because of allocator behavior; a single RSS increase does not establish a leak. Report heap, external/buffer memory and process peak RSS as applicable, alongside the objects intentionally alive at each phase. Distinguish post-operation memory with a child still alive from post-disposal recovery. Use repeat samples and the same SDK/runtime and workload for revision comparisons; keep noisy wall-clock, CPU and memory benchmarks opt-in. Add inexpensive operation-count regressions only for demonstrated excess work, through the relevant production entry point, and verify that they fail before the fix. Select evidence according to the changed resource boundary rather than requiring a full heap/performance exercise for every edit.

## Test runner concurrency and process isolation

Pi Harness uses Node's test runner through `scripts/test.mjs`. Test files already run in separate worker processes, with Node's default concurrency of `max(1, os.availableParallelism() - 1)`. Each worker has its own heap, module cache and environment; filesystem paths, ports and external processes still require explicit isolation.

Within a file, tests remain serial unless a parent suite enables concurrency. The independent subprocess scenarios in `test/subagent-integration-real.test.mjs` and `test/async-shell-sdk.test.mjs` use parent suites capped at two concurrent scenarios. Each scenario owns a temporary working directory, agent directory and IPC namespace. Assertions and cleanup remain in force. Ordinary SDK subprocesses have a 30-second exit deadline and a 45-second outer deadline. Suites that mutate in-process globals or share fixture resources remain serial within their file.

The scenario cap applies within each of those two files; it is not a global process or CPU cap. Full-suite timing should be compared on the same host because other file workers still run concurrently.

## Native lifecycle model tests

`test/typed/native-lifecycle-model.test.ts` runs generated histories through the real RootService, runtime, Pi SDK, managed IPC, actor storage and durable Job views. The model and shared SDK fixture use strict TypeScript. Each subprocess has private working, agent and socket directories, a 120-second process exit deadline and a 150-second outer deadline.

Each sample starts one Fresh and one Inherited Actor. `fast-check` generates up to 32 commands: Main writes, native peer tool calls, SDK enqueue-then-throw faults, cancellation, varied provider results, continuation and reload. Expected lifecycle state, accepted messages and Job lineage come from the generated operations. Assertions check actual durable transcripts, sender attribution, terminal results/notices, inherited context and immutable previous Job artifacts. The model contains no copy of the production transition algorithm. Fifty histories run by default; `PI_PBT_RUNS` selects a larger local sample.

`fc.scheduler` varies explicitly scheduled provider-release boundaries when both Actors settle. Native SDK, IPC and filesystem work after those boundaries runs normally; the scheduler does not control arbitrary kernel or timer interleavings. Provider errors, empty replies, thinking-only replies and cancellation are generated outcomes. An unexpected assertion failure remains a failure and is shrunk by `fast-check`.

Failures print a seed, property path and command `replayPath`. Replay with `PI_PBT_SEED=<seed> PI_PBT_PATH=<path> PI_PBT_COMMAND_PATH=<replayPath> node --import tsx --test test/typed/native-lifecycle-model.test.ts`. Keep the printed scheduler expression when reproducing a scheduling-specific failure. Reload uses the existing SessionManager and does not claim fresh-process recovery coverage.

## Capability history model tests

`test/typed/capability-history-model.test.ts` generates histories of description/schema replacement, discovery, permission commands, backend calls, compaction and durable reopen. Discovery uses the real Capability retrieval SDK and local broker; permission commands enter through `AgentSession.prompt`. The external provider and compaction summary are scripted. Request observations use the installed additive Responses serializer. This model does not claim Chat Completions, Anthropic, MCP or nested Codemode coverage.

The model generates up to 24 commands per history and runs 50 histories by default. It checks execution authority, active declarations, current schema/description and serialized prefix stability within a checkpoint. `PI_PBT_RUNS`, `PI_PBT_SEED`, `PI_PBT_PATH` and `PI_PBT_COMMAND_PATH` control sample size and replay, with the same usage as the native model. Both models print the actual seed and run/shrink counts even on success. PBT subprocesses have 120-second deadlines with 150-second outer limits.

The complete property currently exposes unresolved production prefix failures. Minimal traces, replay commands, source-level causes and model-validation limits are recorded in [Capability history counterexamples](reviews/capability-history-pbt.md). The failing histories remain ordinary test failures; they are not skipped, retried or marked as expected failures.

## 文档与测试登记

`test/contracts.json` 记录行为依据，格式为：

```json
{
  "version": 1,
  "contracts": [
    {
      "id": "capability.lazy-schemas",
      "kind": "design",
      "docs": [
        { "path": "docs/harness-configuration.md", "heading": "### 延迟 schema" }
      ],
      "tests": ["test/typed/capability-lazy-schemas-sdk.test.ts"]
    }
  ],
  "reviews": {}
}
```

示例中的标题用于说明结构，实际登记应使用目标文档当前存在的完整标题行。

- `id` 使用小写字母、数字、点和连字符，并在清单中唯一。
- `kind` 为 design 或 regression。regression 另需 `failure` 字符串，说明实际触发条件和用户可见失败；`docs` 指向缺陷证据章节，可位于 `docs/reviews/`。
- `docs` 选择 Markdown 的完整 ATX 标题行，例如 `## 创建与查询`。范围包含该节及子节，直到下一个同级或更高级标题。代码围栏内的标题不参与定位。同名标题有歧义时拒绝登记。
- `tests` 使用明确的行为测试文件路径，不使用 glob。一个契约可关联多个文件；一个文件可关联多个契约，但每个关联都应有独立依据。
- 生产代码路径不参与文档联动。关联依据来自设计行为，代码文件划分不能证明文档是否需要更新。
- 不为满足登记而创建逐函数文档，也不以一个全仓库契约兜住无关测试。

## 提交前关联检查

`.githooks/pre-commit` 调用 `scripts/check-test-contracts.mjs --staged`。程序只读 Git 的 HEAD 与 index，不读取未暂存的文档、测试或清单内容，不自动写文件，也不运行全套测试。

检查规则：

1. 已登记的文档标题和测试文件必须存在于暂存版本中。
2. 暂存的新增、修改、删除测试应有 design 或 regression 登记。删除测试可以使用 HEAD 中的旧登记。
3. 对比关联文档章节与测试文件的 HEAD／index 内容。只有一侧变化时拒绝提交，提示同步另一侧或显式记录复核。
4. 文档其他章节变化不触发该契约。测试文件变化会检查该文件的所有关联。
5. 删除或修改映射仍会检查旧关联，不能仅移除登记来跳过单侧变更检查。
6. 文档和测试同时变化只证明双方被触及，不能证明语义一致；测试价值与语义一致性仍由审查负责。

测试重构、文档错字或补充已有契约的回归可能无需修改另一侧。这些情况应记录明确的复核理由，不应添加无意义的断言或改动文案来通过检查。

先暂存本次真实修改，再生成复核记录：

```sh
node scripts/check-test-contracts.mjs --review capability.lazy-schemas --reason '仅重构夹具，已复核本节行为约定无需修改'
```

程序打印一个 JSON 对象。把该对象的条目合入清单的 `reviews`，再暂存清单。复核记录包括双方当前暂存内容的 SHA-256 指纹和理由。任何关联内容随后变化都会使旧指纹失效。程序不推断理由是否充分，也不把复核记录视为用户授权。

文档标题、测试移动或契约退出时，应同步清单。已经移除的契约仍可用同一命令根据 HEAD 中的旧登记生成本次复核记录。历史复核记录可以删除；内容不匹配的旧记录不会放行新的单侧修改。

默认检查只要求本次变化的测试完成登记，不阻塞尚未迁移且未改动的历史测试。全量登记审计使用：

```sh
node scripts/check-test-contracts.mjs --all
```

`--all` 额外检查暂存版本中的全部测试是否登记。它不会自动生成映射，也不执行测试。单独运行关联检查可使用 `npm run check:test-contracts`。

## Common-path measurements

```sh
npm run bench:common -- --output /tmp/common-paths.json
```

This opt-in script measures permission queries, local broker searches, scoped/full root lists and real owned IPC roundtrips. Fixed profiles contain 4,000/8,000 assistant-message proxies, 30/50 registered tools, eight active tools and terminal registries with 120/240 actors and 200/400 Jobs. The permission replay receives the corresponding user/assistant/tool-result entry counts; it does not inspect message bodies. Root lists use an in-memory registry and omit archive/view I/O. Broker provider ports use synthetic in-memory catalogs and Skill bodies, so this measures local search, not retrieval-model latency or Skill filesystem performance.

Imports and fixture setup are excluded. The first operation is timed before validation; subsequent operations are reported separately with median/min/max wall time, process CPU and applicable work counts. `--iterations N` controls warm samples (default 25). Assertions run outside the clocks. Each invocation owns a private IPC root and tears it down before reporting success. Results include platform, Node, revision and working-tree status; timings are measurements, not CI thresholds or memory-growth evidence.

The manual [Harness performance workflow](../.github/workflows/inherited-performance.yml) runs common-path measurements before the inherited lifecycle benchmark on each Linux and Windows runner. Each platform uploads `common-paths.json` and `inherited-performance.json` together as `harness-performance-<os>-<revision>`. The workflow remains opt-in and applies no timing thresholds.

## Inherited 创建性能

性能基准独立于 `npm run check`，按需运行：

```sh
npm run bench:inherited -- --output /tmp/inherited-performance.json
```

[Harness performance 工作流](../.github/workflows/inherited-performance.yml) 仍只由 `workflow_dispatch` 手动触发。默认测量 1,000／4,000／16,000／32,000 条历史 assistant 消息代理值，每档同时持有三个实际运行中的 Inherited Subagent，分别使用 print 和 RPC 宿主模式；4,000 档另外测量单子 Agent 对照。每个配置重复三次，每次使用独立 Node 进程，不调用在线模型或外部 MCP。`--calls 1000 --children 3 --mode rpc --repeats 1` 可用于限定单次冒烟；`--project <checkout>` 指定检出。

合成历史约为 1 user／10 assistant／9 toolResult，工具结果包含 512 B 与 16 KiB 文本，持久化后重新打开，避免夹具共享常量字符串低估已加载历史占用。完整历史随档位增长，规范 compaction 将有效尾部保持在约 300 条 entry 加摘要。目录保持小规模（Linux 当前夹具 31 个注册工具，Main 激活 8 个）；输出记录实际父子工具数、历史 entry 数与文件字节数。这些档位是负载输入，不代表真实供应商请求数或单次在线上下文容量。

创建走真实 `subagent_create`，等全部子会话实际分发本地模型流后才采样。RPC 配置还建立真实连接，并给每个运行中 Job 订阅执行流；分别采样连接／订阅存活及断开后的内存。仅在全部子任务以 `completed` 收尾后，通过 `AgentSessionRuntime.fork` 测量完整 SDK 分叉，验证生命周期钩子、新会话身份及源文件未被分叉写入修改。它不模拟数千份归档子会话、持续 RPC 事件积压、多根 Session 并行或 MCP 复用／lazy-load。

内存阶段包括导入后基线、操作前、创建后、GC 后子会话存活、RPC 断开、分叉后，以及实际退役并释放夹具引用后的 GC。RSS、heap、external、arrayBuffers 与进程峰值 RSS 分开记录；进程峰值不可重置，包含导入、夹具构建和验证，平台不支持时为 null。GC 快照不是分配总量或无泄漏证明。输出还记录创建／分叉耗时、CPU、catalog 读取次数，以及包含 GC、校验和收尾在内的生命周期最长事件循环间隔。单 worker 有 120 秒退出期限，失败或资源清理失败不输出成功结果。

比较时核对 Node 版本、操作系统、配置与提交；CPU、墙钟与内存数据用于分析，不设跨 runner 的绝对门禁。默认回归只对已确认的重复工作设宽松读取次数上限，不通过放宽超时掩盖退化。

### Heap ownership attribution

Use a separate, explicit profile to investigate live heap ownership:

```sh
npm run bench:inherited -- --calls 1000 --children 3 --mode rpc --repeats 1 \
  --heap-snapshot-dir /tmp/private-heap-profile --output /tmp/private-heap-report.json
```

The snapshot directory must not exist yet. Snapshot mode requires an explicit `--calls` value and `--repeats 1`; it never expands into the default history matrix. The worker captures standard V8 `.heapsnapshot` files after GC at three phases: the parent before creation, all configured children actually running with RPC subscriptions when requested, and teardown after the fixture function has returned. Each snapshot records its file size and V8 heap-space occupancy. Snapshot collection forces GC and changes subsequent execution and process RSS watermarks, so all timing fields are `null` in this mode and its memory measurements must not be mixed with normal runs; normal benchmark invocations remain unchanged. The worker retains its 120-second deadline, and collection or cleanup failures fail the run.

After the worker exits, the controller reads the snapshots sequentially and reports counts and shallow bytes for each V8 node type, type deltas from the parent phase, the largest object/type groups, plus session owners such as `SessionManager`, `AgentSession` and `RootService`. Compare these per-phase groups to distinguish growth in strings, arrays, maps and session objects. Shallow bytes exclude referenced descendants and do not establish retained ownership. Load the snapshots in Chrome DevTools **Memory**, use **Comparison** to compare `childrenAlive` with `parentBeforeCreate`, and inspect **Retainers** and retained sizes for individual `SessionManager` or `AgentSession` instances. Follow their history arrays, indexes and context-message references to distinguish shared message bodies from independently retained projections. Compare `afterTeardown` to check which owners remain reachable. Multiple snapshots do not establish leak freedom or allocation volume.

These artifacts use synthetic history, but a V8 snapshot also contains process internals, module paths and environment-derived data. Keep snapshot files and their reports outside the repository in a private directory; do not upload them as public workflow artifacts. Large profiles can require substantially more disk and peak memory while writing or parsing snapshots. Controller parsing occurs only after the worker exits and is excluded from worker memory measurements.

## 迁移与验证边界

测试整理应先建立行为与文档的对应关系，再合并重复覆盖和移除没有独立依据的断言。未迁移测试应如实报告，不批量标记成已完成。

关联检查器用隔离的临时 Git 仓库验证章节定位、双向联动、暂存与工作区隔离、复核失效、映射删除及新增测试登记。它不验证模型理解、在线提供方缓存或测试本身是否存在等价断言。
