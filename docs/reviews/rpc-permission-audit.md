# RPC and tool-permission audit

## Scope and evidence

This review covers the permission, child-scope and observation changes introduced after `af3494b`, including the RPC/schema commits subsequently split into the current history. It examines production call paths and the behavioral evidence used to approve them. It is not a claim that every repository module has been audited. The findings describe the inspected baseline; the implementation ledger below records later fixes and remaining acceptance gaps.

The reviewer used synthetic histories and tools, real Pi SDK sessions for creation, and the actual permission domain and Runtime for focused reproductions. No online provider or external MCP service was involved. Windows verification is tracked separately: the first native VM run reported 1,162 tests, 1,130 passes, 14 failures and 18 skips. These are historical baseline failures; their fixes and subsequent platform receipts are recorded below.

## Findings

### P1: Inherited creation repeatedly reconstructs the root catalog

`RootService.#childDeniedNames` originally called `explicitlyDisabled` and `explicitlyEnabled` for each registered tool. Both resolve the catalog and replay the branch. Lazy parent-scope resolution repeats this work during child SDK initialization. The resulting work runs on the same event loop as the TUI.

A real `subagent_create` call with 500 synthetic user/assistant pairs and 500 additional registered tools produced these individual samples using the same SDK and fixture:

| Revision | Create | Longest timer interval | Root catalog reads |
| --- | ---: | ---: | ---: |
| Before the change (`af3494b`) | 83 ms | 84 ms | 11 |
| Before the local fix | 759 ms | 760 ms | 9,236 |
| After the local fix | 90 ms | 91 ms | 20 |

These are diagnostic samples, not portable timing limits. Different fixtures and hosts will produce different values. They demonstrate an introduced synchronous regression without attributing every user-observed delay to this one cause.

The local fix reads the catalog once and uses the existing per-operation permission resolver. It adds no persistent cache or invalidation state. A regression through the real tool, RootService and child SDK initialization uses 500 turns and 250 tools and bounds catalog reconstruction, rather than wall time. It failed before the fix with 5,787 reads and passed after it.

### P1: Legacy manual records still act as runtime admission authority

The permission resolver itself reads only canonical records and config defaults, but `discoveryRecords` still parses the retired `manual` category, and `branchToolSelection` adds those names to `selected`. MCP admission accepts that selection without a canonical enable. `appendManualCapabilityRecord` and the old category model also remain in the source.

A real `createToolAdmission` reproduction uses one active registered MCP tool, no discovery `tools`/`mcp` hits and no canonical enable:

| Branch | MCP execution admitted |
| --- | --- |
| Empty | No |
| Old `capability-discovery.manual` only | Yes |
| Same old record plus canonical `unset` | Yes |

This is an unremoved legacy runtime reader through a different authority path. It contradicts the claimed canonical-only runtime and explicit offline migration boundary. The prior review checked the permission resolver but missed admission's `selected` path; the previous closure of source unification was premature.

### P1: Permission effects ignore the effective winning rule

`setToolPermission` applies activation/removal to all tools matching a changed target. It does not filter those effects by the effective permission after the mutation.

Two reproduced cases use a Codemode tool, with Codemode already active:

1. Enable the exact tool, then disable its MCP group. The exact rule still resolves to `enabled`, but the group operation removes the tool from active.
2. Disable the exact tool, then enable its MCP group. The exact rule still resolves to `disabled`, but the group operation activates the tool.

The execution guard still rejects a disabled tool; this reproduction does not establish an execution bypass. It establishes inconsistent control results and active membership. Effects should follow the existing rule winner, without adding a second precedence model.

### P1: Unsubscribing retains connection objects until the Job ends

Each live `stream.subscribe` attaches a new continuation to `runtime.jobDone(jobId)`. The subscription teardown removes the native observer and sets `active = false`, but does not remove the Runtime waiter or its continuation. The continuation captures the connection and root service.

A focused reproduction with a real Runtime creates one unresolved Job, subscribes/unsubscribes 500 connection objects, drops strong caller references and performs GC between event-loop turns. All 500 connection objects remain reachable through `WeakRef`. After settling the Job and performing GC again, only the final loop-local object remains.

This is a retention defect for long Jobs with repeated subscriptions/reconnections. It is separate from the Inherited TUI regression: without RPC subscriptions, this particular reference chain is absent. The fix needs a detachable terminal observer or cancellation of the existing waiter; suppressing event delivery alone does not release the observer.

### P2: Other permission operations repeat the same branch/catalog work

The creation fix does not address the other per-name call sites:

- `queryToolPermissions` reads the catalog, then calls `resolveToolPermission` for every name; each call reads the catalog and replays stored entries again.
- The RPC tool-port snapshot resolves every tool and then performs another disabled pass for eligibility.
- Compaction, Preset retention and several activation/filter paths invoke the single-name enabled/disabled helpers inside loops.
- `decide` and `createToolPermissionResolver` contain separate copies of the same match/priority/winner algorithm.

The repeated work is established by source inspection; the real-creation measurements above quantify only the creation path. Reuse one operation-local snapshot and one winner algorithm. Do not introduce a branch-wide cache whose invalidation creates another authority.

### P2: Propagation tests simulate a different root implementation

`capability-tool-permission-propagation.test.ts` builds its own `filteredRoot` and refresh functions rather than invoking RootService. One case asserts that a tool explicitly enabled at the root remains allowed in the child scope. The actual RootService denies both enabled and disabled names to children because explicit enable is root-only.

These tests cover pieces of scope behavior, but their names and comments overstate RootService coverage. Passing them cannot establish that RootService performs live propagation correctly or efficiently. Retain useful scope-unit cases under their real scope; verify root-only and live-update behavior through the production root/child entry points.

### P2: Existing admission benchmark no longer runs

`scripts/capability-admission-bench.mjs` imports the removed `manualToolMatcher` and `setCapabilityRootOnlyPolicy` exports. Running it fails at module import. Its reference arm also models the retired manual-record policy.

It cannot serve as current performance evidence. Retire it or rewrite it around an explicit current question; do not restore compatibility aliases to make an obsolete benchmark pass.

### P2: History reads build unused live-snapshot projections

`NativeJobRunner.liveSnapshot` constructs completed messages and entries by separately traversing the native branch. `history.read` calls it to obtain the current end boundary, then reads the interval again through ActorSessionStore. It does not use the snapshot's messages, entries or partial. The stream response uses messages/partial but not the entries field.

This is unnecessary work and transient allocation in an observation path, introduced with the RPC snapshot surface. Its contribution to an observed slowdown has not been timed here. A narrow boundary read or one shared projection is preferable to constructing and discarding full views.

## Boundary and simplification review

- Runtime's typed `TaskOptions` are converted back to `unknown` and checked as an object. Verify the actual callers before retaining this internal check.
- `cloneValue` promises detached values but returns the original object if cloning fails. Its guarantee is inconsistent. Define ownership and the accepted payload contract before removing or tightening the copy.
- Inherited histories need independent append containers, headers and session indexes, not a deep copy of immutable message bodies. Pi 1.5's normal append path pushes new entries; context edits project replacements. Existing sibling tests establish array/header isolation, not arbitrary mutation isolation for historical messages. Keep message bodies shared; do not introduce generic CoW. If a concrete writer requires copying, limit materialization to the SDK's effective context at the latest valid compaction, including its `firstKeptEntryId` interval and necessary state records.
- RPC input, disk recovery and IPC ownership are external/resource boundaries. Their validation is not disproved by counting `asRecord`, `requireString` or type predicates.
- `schema.ts` is used by generation and CI, not production dispatch. Replacing it with TypeScript interfaces would remove the language-neutral validation asset rather than optimize a runtime hotspot.
- Permission migration currently runs only through an offline script, but its implementation still resides in `src/`. The user requires migration tooling outside production modules: move it to `scripts/`, remove migration-only production exports, and remove all retired-format readers from runtime. No compatibility period or production fallback is authorized.

## Current disposition

The audit does not yet approve the complete local-data migration. The ledger separates integrated code and checks from active-root files excluded from external writes, final platform acceptance and untested online/long-duration boundaries. The original findings remain as the failed-before evidence.

The new optional creation benchmark is deliberately narrow. It records CPU, memory and event-loop data for synthetic creation through the real SDK; it is outside the default gate. It does not cover repeated subscriptions, compaction, tool-management queries, external MCP startup, concurrent batches, revival, or post-disposal memory recovery. Passing it is not a substitute for addressing those paths or for resolving the Windows failures.

## Implementation evidence ledger

### Stage 1, Unit 1: retired discovery authorization

Executor commit `5076815` removes the retired discovery `manual` field, parser branch, writer and admission selection. Main review independently inspected the revised diff and ran:

```sh
node --import tsx --test test/typed/capability-tool-permission.test.ts test/typed/capability-compaction-prune.test.ts test/typed/capability-manual.test.ts
```

Result: 48 passed, 0 failed, 0 skipped in the executor worktree. The admission regression now covers retired record rejection, canonical enable, production reset and a current-discovery positive control. The pruning test includes both protected and unprotected tools in the actual candidate source and verifies the unprotected control before asserting protection.

Disposition: integrated as `1332132`, with offline migration isolation corrected in `e1d0931`. `1ff62a03` then verifies the execution surface in a real SDK session: retired manual-only MCP-shaped tool is denied by Codemode, canonical enable permits one actual execution, reset denies again. Main reran the whole SDK file: 2 passed. This uses an offline faux model and synthetic registered tool, not external MCP transport or direct model-to-MCP invocation. The final consolidation and effects units are recorded below. Full integrated and platform gates are tracked separately.

### Stage 1, Unit 2: offline migration isolation

Executor candidate `9504c7d` moved migration to `scripts/lib/permission-migration.ts` and removed the production-only export. Main reproduced a persisted-input regression: an invalid canonical assignment suppressed conversion of a legacy denial. Corrected `1500ef2`, integrated as `e1d0931`, validates assignment state in offline code and retains the denial. No migration-only module remains under production `src/`.

Actual-data readiness exposed a separate boundary: child sessions are reopened at root-recorded `anchor` / `seedLeafId`, so canonical records appended only at the file tail are not visible after restore to those checkpoints. The append-only leaf traversal is insufficient for full migration. The final conservative converter and actual closed-file execution are recorded below; they preserve native IDs/checkpoints and leave unsupported shapes untouched. No production fallback or auto-migration is authorized.

### Final permission consolidation and mutation effects

Main integrated the resolver portion of executor `371fb462` as `f9d4bbf`, excluding its unrelated migration blocks. One operation-local catalog, canonical replay and winner implementation serve queries and bulk filters in compaction, discovery, Preset, BTW and RPC. The committed 500-tool / 30-rule query regression fails against `f36fe85` with 1,001 catalog reads and passes after consolidation with one catalog read and one branch traversal. No persistent cache or new authority was added. Query cost remains one history traversal plus canonical mutation parsing and per-tool matching against live rules; this is not a constant-time or fully indexed matcher. The resolver owns temporary registry/decision maps, released when the operation returns. Mutations additionally retain shallow pre/post branch arrays for the operation, sharing historical bodies; no permanent history snapshot or persistent invalidation state is added. Allocation/peak-live costs remain separate from the benchmark's live-child retained heap measurement.

`a13b871` filters activation, immediate removal, deferred compaction and notices by the effective winner after the successful canonical mutation. A pre-write pointer-array snapshot makes live branch arrays and detached branch snapshots equivalent without copying historical bodies or introducing a second mutation reducer. Main replaced the executor's comparison-only fixture with independent expected outcomes through the actual domain writer. The two overlap regressions and both live/snapshot cases all fail against `f9d4bbf` and pass after the fix. Failed persistence still applies no effects.

`c6aaef6` closes the remaining bulk caller in the terminal enable picker. The existing picker/cancellation scenario now offers 500 actual eligible tools and checks bounded catalog work, unchanged labels and no writes on cancellation. It fails before with 503 catalog reads and passes after with at most four; the single-name cross-session `msg_write` check remains a single-name operation.

### Checkpoint-preserving conversion and actual execution

`243a225` replaces the superseded append-marker migrator with a conservative offline converter for the verified actual shape: v3 files containing flat manual-only discovery records. Blacklist, mixed/group records and legacy/canonical coexistence are refused before writing. Production still has no retired reader, migration export or fallback. The converter preserves original entry IDs, parents, timestamps and unrelated bytes, including blank lines, CRLF and absent final newlines. A unique sibling temporary file is written and fsynced before rename; failure cleans it up. This tool is deliberately not a universal legacy rule translator.

Main reproduced the checkpoint defect through the old CLI and real SDK: the old conversion enables the tool at the tail but leaves it unmanaged at a saved pre-tail actor checkpoint. The new conversion enables it at that checkpoint and preserves the selected leaf. The committed offline suite additionally uses ActorSessionStore/storage restore, actual SDK sibling branches, exact canonical expected data, unsupported-input refusal and byte-idempotent reruns. The removed append-marker/blacklist migration fixtures no longer describe the supported converter; canonical group/reset coverage remains in the runtime suite.

Actual authorized execution converted **25 closed files / 39 records**, with zero errors. Before each write, the independent verifier checked the original backup checksum, current source checksum and live root ownership; it then verified exact canonical sets, native metadata, unrelated bytes and zero-write rerun. Original verified backups total 216,544,876 bytes. A fresh inventory finds **12 files / 12 retired records** remaining, all owned by live roots; no active file was externally modified. Private manifests, original bytes and dry-run/execution reports remain outside Git. This is completed closed-file migration, not completion of all local history.

### Inherited creation, ownership and propagation

Main integrated the operation-local root resolver as `6b49686`, replacing the simulated RootService propagation file with actual SDK child-loadout coverage. The real child excludes root-enabled `read` and root-disabled `write`, while unmanaged `edit` stays active. Existing scope-view tests still cover learned qualification and newly applied denials. Main ran the six real-root boundary tests plus seven scope-view tests: 13 passed. `27d1c8c` adds actual live-parent-to-grandchild coverage: a child initially has `write`, root disable is written through the permission domain, then a Fresh grandchild created by that child excludes `write` and keeps `edit`. Removing the root mutation breaks the expected denial; no simulated filter/refresh is used. Retained-parent revival is not claimed by that test.

`8092ede` shares immutable inherited entries/message bodies while keeping independent arrays, header IDs, indexes and leaves; `4564f36` removes the internal typed-options recheck. The real SessionManager sibling test covers independent append/branch/compaction and the effective compaction interval, including a retained pre-checkpoint tool call/result and a later context edit. No compaction materialization or durable format change was introduced. `9cfac59` removes the clone-failure fallback: undetachable adapter results fail through terminal cleanup, while unsupported optional diagnostic detail is omitted and code/message survive. Native result production remains string-based.

### Observation and transport

`cca5b02` splits the narrow live end-boundary read from the stream projection and removes unused entries arrays. `c65f09a` adds detachable Runtime terminal observation and releases it together with native observation. The isolated real-Runtime GC reproduction goes from 500/500 connections retained before settlement to 0/500 after unsubscribe; deterministic tests separately verify event suppression and observer teardown.

Actual socket integration found an additional FIN lifecycle gap. `b4cdbd9` handles input end, drains ordered handlers, releases observers and ends the writable socket so queued responses flush. Main rejected an intermediate immediate-destroy version because it lost a 4 MiB response; the paused-reader real socket test fails with that version and passes with normal `socket.end()`. `6d55bcf` preserves explicit server retirement's ability to destroy a half-closed socket still flushing. Wire/schema bytes and methods remain unchanged. Main independently ran transport + stream: 16 passed before the last small retirement correction; final gates will include it.

### Discovery replay and retired diagnostic tooling

`84564de` replaces per-prune full replay filtering with reverse suffix removals: each record sees only later removals and is projected once. A new independent chronology test failed before the change because two separate member prunes left the exhausted old group's guidance alive; it passes after, and rediscovery keeps only new metadata. Main ran the complete pruning file: 14 passed. `96cf198` deletes the broken benchmark tied to removed manual APIs, without restoring compatibility exports.

`eb24cbc8` retains the discovery broker-input snapshot but transfers the run-owned hit to the final result instead of cloning twice. `8ac4f5a0` uses an explicit fixed-shape Usage/cost copy for mutable accumulation and the published snapshot; a producer-owned Usage object remains unchanged after two classifier calls. Main ran agent, Codemode-boundary and propagation tests together: 33 passed.

### Verification milestones and actual-data preparation

- Initial concurrent Linux full run: 1,164 tests, 1,151 pass, 4 SDK subprocess timeouts, 9 skips. The affected integration file then passed all 35 tests without competing full gates. No timeout threshold changed.
- Integrated Linux midpoint gate: 1,163 tests, 1,153 pass, 0 fail, 10 skips; type and schema checks passed. This is a milestone, not the final revision's acceptance.
- Integrated Linux gate at `27d1c8c`: 1,169 tests, 1,159 pass, 0 fail, 10 skips; includes the real SDK retired-manual Codemode sequence, live root-to-grandchild propagation, usage ownership and transport fixes. Type and protocol schema checks pass. Permission consolidation and checkpoint-preserving migration are still outside this revision.
- Final integrated Linux gate at `243a225`: 1,176 tests, 1,166 pass, 0 fail, 10 skips, approximately 84.2 seconds; type and protocol schema checks pass. This includes the final resolver, effective effects, conservative checkpoint converter and observed-turn shell synchronization. JSON, active-document links/technical language and contract checks also pass.
- Native Windows baseline had 14 failures in preset paths, POSIX parser fixtures and real PowerShell argv extraction. Integrated fixture fixes preserve exact expectations and add a native bare-`--` opaque-command denial test. Focused VM run: 36 tests, 35 pass, 0 fail, 1 prerequisite skip. Natural PowerShell bare `--` remains a pinned-parser limitation handled by whole-command review.
- Integrated Windows gate at `b4cdbd9`: 1,167 tests, 1,148 pass, 1 fail, 18 skips. The failure was an async-shell SDK scenario's fixed 3-second first-yield poll. `f36fe85` replaces that poll with the observed model callback, preserving outer deadlines; a temporary 4-second delay fails before and passes after. The separate one-off named-pipe `ENOENT` remains unproven and is not claimed fixed.
- Final native Windows gate at `243a225`: 1,177 tests, 1,159 pass, 0 fail, 18 skips; type and schema checks pass, approximately 174.7 seconds wall time, one run without retries/warmup. Skips are explicit platform/prerequisite cases: Unix-only socket ownership and tmux isolation, non-Windows shell default, unavailable process query, real-Pi RPC hosts, optional dependencies and the deliberate minimum-runtime scenario. JSON and all 52 contract associations pass. The extra document check exposed a Windows path-separator defect in historical-prose exclusions; `9c588bb` fixes category recognition and the native Windows documentation gate then passes (386 links / 71 files). The later picker consolidation is covered by fresh gates below.
- Final post-picker gates at `c6aaef6`: Linux 1,176 tests / 1,166 pass / 0 fail / 10 skips (94.8 seconds); native Windows 1,177 / 1,159 / 0 / 18 (165.9 seconds test time). Both include type and schema checks. Native Windows documentation, JSON and all 52 contract associations also pass. Subsequent source changes only remove two trailing blank lines; remaining changes record evidence. A gitleaks scan of all 34 then-unpushed commits found no secrets.
- Inventory: 540 native session files, 37 containing 51 retired manual records; no retired blacklist or mixed discovery/manual records in this inventory. Backups cover 25 closed files (216,544,876 bytes). Twelve files belonging to active roots remain excluded from external writes. Backups/manifests containing private local paths remain outside Git.

The opt-in creation benchmark runs nine isolated samples per checkout using the same installed SDK and workload. The final `c67e73b` large case has median 182.2 ms creation / 215.7 ms CPU / 183.8 ms longest timer gap / 20 catalog reads; the regressed `cad2d0e` baseline has median 1,539.2 ms / 9,236 catalog reads. The earlier `b4cdbd9` sample was 174.5 ms / 204.9 ms CPU / 176.1 ms gap / 20 reads. These timings are diagnostic samples, not portable limits. Final live-child retained heap delta is about 32.76 MiB; snapshots do not measure total allocation volume or post-disposal recovery. Retained data with a live child does not establish a leak. Observer teardown and connection reachability have separate deterministic and GC evidence above. Raw reports remain outside Git.

## Rewrite plan and feature freeze

### Authorization and freeze boundary

The rewrite feature freeze is closed with user authorization after recording the Ubuntu PowerShell failure with richer diagnostics and adding macOS to the standard CI matrix. The user explicitly deferred active PowerShell reproduction. The latest completed Linux baseline at `9d735062` has 1,033 passes, zero failures and ten skips; the three PBT models also passed 1,000 local histories each with command limit 128 and `size=max`. The reported Ubuntu CI failure at `1f35ba2c` remains unresolved, and adding macOS CI is not macOS acceptance. Active-root migration deferrals, provider-cache design gaps and untested environments remain recorded in [known issues](../known-issues.md); closure does not mark them fixed or approve deferred feature proposals.

The following plan and freeze rules are historical execution evidence, not an active feature restriction. The preceding findings remain the evidence ledger. The follow-up inputs were [permission algorithm review](capability-permission-algorithm-review.md) and [memory retention review](memory-retention-review.md). Their suggestions require verification; their severity labels and proposed mechanisms are not implementation instructions.

During the former freeze:

- Preserve the agreed product scope. Work on audit, correctness fixes, simplification, removal of production compatibility, ownership/lifecycle fixes, and the tests/docs needed to verify those changes.
- Add no new commands, RPC methods, permission states, protocol capabilities, SDKs, backends or diagnostic product surfaces. Do not implement the archived proposals' future interface lists.
- The CPU/memory benchmark already drafted is optional diagnostic tooling, outside the default test suite. Keep its narrow coverage explicit. Defer additional benchmark scenarios until the corresponding rewritten paths and contracts are stable; no expansion of the performance framework is part of this plan.
- Continue Windows synchronization and verification as acceptance work, not as a reason to skip failures. Keep the VM's user-managed lock state unchanged. Do not claim complete Windows support from transport-only checks.
- The freeze required explicit user authorization to lift it. Green tests, merged commits and archived proposals did not themselves lift it.

### Current worktree and baseline

The working tree contains the local Inherited catalog fix and its actual-SDK regression; optional benchmark/workflow drafts; Windows RPC fixture adjustments; and review/doc changes. They are not one completed implementation. Preserve and separate them by purpose before committing; do not silently discard pending work or publish the whole tree as a rewrite.

The committed baseline is `cad2d0e`, with `af3494b` as the comparison point before the permission/RPC work. The Windows VM received that baseline plus the then-current four-file RPC fixture/doc patch. Later local performance changes have not been synchronized to that VM yet. Record the tested revision and patch set with each result.

### Confirmed findings from the two follow-up reviews

The following table records accepted facts, not blanket approval of the reviews' severity labels or repair sketches. Focused probes ran against the current working tree after the local `#childDeniedNames` fix. They used synthetic current-format entries and production functions; temporary instrumentation observed work counts without changing production behavior. No new benchmark scenarios or product features were added for this verification.

| ID | Accepted finding | Verification and limits | Rewrite disposition |
| --- | --- | --- | --- |
| V1 | Prune replay repeatedly filters all accumulated discoveries and allocates replacement arrays/results | Calling real `discoveryRecords` with 50 valid discoveries followed by 10 nonempty prune records invokes `filterDiscoveryByPrune` 500 times. Source allocates a new records array and projected results on each pass. A later discovery remains available while all 50 earlier records remain filtered, independently verifying the chronology that an optimization must preserve. This code already existed at `af3494b`; it is not a newly introduced regression. These objects are transient allocation, not demonstrated retention. | Stage 4: reduce repeat work while preserving per-record chronology; no P0 designation or cumulative-rediscovery shortcut. |
| V2 | An operation-local resolver still scans every stored rule for each previously unseen tool | A real resolver over 500 tools and 30 distinct namespace rules performs 15,000 namespace-alias probes, with exactly one branch replay. Probe counting uses a synthetic metadata getter reached once per attempted rule match. The source also sorts matching rules. This confirms O(tools × rules) matching; it does not establish that 30-rule scans are themselves a severe latency problem. | Stage 1: share one winner algorithm and avoid unnecessary sorting first; add indices only if later measurements justify them. |
| V3 | Tool query adds repeated branch/catalog reconstruction beyond rule matching | On that same 500-tool/30-rule fixture, real `queryToolPermissions(..., 'inactive')` scans the branch 502 times and reads the catalog 1,001 times. It performs the same 15,000 match probes as V2; the extra scans/reads are avoidable composition overhead. This is distinct from the real-SDK creation regression measured above. | Stage 1: one operation-local catalog and replay for all names and result assembly. |
| V4 | Rule matching/priority selection is duplicated | `decide` and `createToolPermissionResolver` both filter matches and sort by default/canonical, kind rank and mutation order. This is direct source evidence. Canonical record replay/config overlay in `storedEntries` is not a third identical winner algorithm. | Stage 1: a single effective-decision implementation shared by query, guards and effects. |
| V5 | Live snapshot builds data its callers do not consume | The runner calls `messagesAfter` and `entriesAfter`, each traversing the branch; `history.read` needs the end boundary and reads the interval again, while the stream response does not use `entries`. These are reference-array allocations/traversals, not demonstrated deep copies of message bodies. | Stage 3: narrow projection to actual caller needs without changing the wire protocol or adding lazy-property machinery. |
| V6 | Canceled subscription terminal waiters retain connections | The prior real-Runtime reproduction retained all 500 unsubscribed connection objects after GC until Job settlement. The Promise continuation remains reachable even though the native listener and connection subscription map have been cleaned. Current terminal-state guarding and LiveJob cleanup are present; the missing lifecycle step is cancellation before settlement. | Stage 3: detachable terminal observation and resource-release regression; keep delivery suppression and release as distinct assertions. |
| V7 | Root propagation tests substitute their own implementation and miss root-only enable semantics | The test's `filteredRoot` removes disabled tools only and one case expects an explicitly enabled tool to remain allowed in a child; production denies both states to descendants. This verifies the mismatch, not a production bypass. | Stage 5: actual RootService/SDK coverage, with any useful scope tests accurately labeled. |
| V8 | The old admission benchmark is broken and models retired rules | Executing `node --import tsx scripts/capability-admission-bench.mjs --json` fails at the removed `manualToolMatcher` import. The script also imports removed root-only policy APIs. It cannot supply current performance evidence. | Stage 4: remove or archive; no compatibility aliases and no new benchmark framework. |
| V9 | Ownership documentation is misleading in specific places | `manual-tools.ts` is now a general permission-target parser, and `#rootScopeCache` retains a catalog identity rather than computed denials. The Runtime cloning helper's fallback returns a shared value despite its detached-value comment. These are verified naming/contract issues; renaming alone is not a performance fix. | Stages 2/4: clarify ownership and simplify actual duplication. |
| V10 | Operation-local clone sites are real and need ownership review | `agent.ts` clones hits on capture and again on final selection; Codemode clones initial usage and returned usage. Both files are unchanged since `af3494b`, so these are existing costs. Codemode subsequently mutates `usage` and nested `usage.cost`, which justifies owning those accumulators, but does not establish a need for a generic deep clone. Neither review's millisecond estimates were measured. | Stages 2/4: establish writes and transfer points; preserve producer-owned usage while choosing the smallest necessary copy. No blanket deletion. |

The reviews also correctly distinguish actual external RPC/disk validation from controlled internal TypeScript calls, identify schema definitions as generation/CI assets, and observe that the runner clears listeners and removes its LiveJob on completion. These are confirmed boundaries to preserve, not additional defects.

`#retainedScopes` and `learned` do retain data for their owning root/scope lifetime, but their existence alone does not establish a leak. A Set cannot grow per operation when the names are unchanged, and a retained proxy does not add a new copy of the whole root. Further work must measure retained bytes and reachability with actor revival semantics intact. The existing subscription reproduction is the confirmed connection-retention defect; it should not be generalized to every collection.

### Reconciliation of the additional reviews

| Review claim | Audit disposition |
| --- | --- |
| Repeated filtering at every prune can multiply work | Accept as an algorithm/allocation concern. Verify current call sites and measure representative interleaved discovery/prune histories. Do not classify complexity alone as P0. |
| Replace replay with cumulative removals, clearing names on rediscovery | Do not adopt as written. Later discovery must not resurrect an older record or its stale metadata. Preserve record-local chronology; a reverse traversal with suffix removals may be suitable, but requires independent chronological examples before implementation. |
| Per-tool rule scans need multiple reverse indices | Defer indices until measured. First replay once per operation, select the winner once through one algorithm, and avoid sorting all matches when a single pass suffices. Indices must preserve aliases, prefixes and rule precedence without becoming another state authority. |
| Usage extraction needs an early exit | Not established. The function does not know the complete desired-name set; a full linear pass over the relevant usage records is expected. Do not add speculative frequency metrics, batching or target-count state. |
| The precedence rule is duplicated three times | Two matching/winner implementations are directly visible. Canonical last-write replay and config overlay are distinct responsibilities, not a third copy of the same rule. Consolidate actual duplication without conflating these semantics. |
| Scope proxies and learned names are leaks | Unproven from collection growth alone. Establish reachability and intended root/actor lifetime. Stopped actors may be revived, and denial must continue to override learned qualification. `WeakMap` cannot use string keys; do not add an invalid indirection or delete required state by actor stop alone. |
| Fresh creation eagerly captures the inherited transcript | Rejected for the inspected path. Runtime calls the capture thunk only if an inherited task exists. Creating a closure does not execute its body. |
| Whole-history deep copying is necessary for append isolation | Rejected. Distinct arrays/headers isolate appends; immutable entries/messages can be shared. Inspect actual SDK and extension writers rather than treating a deep-copy test as the ownership contract. |
| A storage or IPC boundary automatically justifies `structuredClone` | Rejected. Serialization and ownership transfer must be examined separately; encoding to disk/wire does not itself require an additional deep clone. |
| Lazy-schema and reachability tests have no contract mapping | Rejected for the current tree: both are registered in `test/contracts.json`. Do not add duplicate mappings or unsupported manifest kinds. |
| RPC terminal observers remain after unsubscribe | Confirmed by the Runtime/WeakRef reproduction above. Current code checks terminal state before installing a waiter; the specific failure is cancellation before Job settlement, not unconditional registration on terminal Jobs. |
| LiveJob cleanup fails to remove its map entry | Rejected by the reviewed `finally` block; it clears listeners and deletes the Job. Audit remaining references separately. |
| Snapshot arrays allocate copies of every message body | Overstated: the inspected helpers allocate arrays and retain references, not deep copies of every body. Repeated branch traversals and unused projections are still unnecessary. |
| Duplicate short helpers or small files prove bloat | Insufficient. Remove redundant responsibility or indirection where a real call trace demonstrates it; do not create global helper layers or merge independent boundaries to hit a line target. |

### Stage 1: Restore one permission authority and one effective decision

Requirements:

- Remove legacy `manual` parsing, selection grants, record writers and production types from discovery/admission. Current-format canonical permissions and normalized config defaults are the only management sources. Audit MCP selection and prompt projection too, not just the permission resolver.
- Move migration code into offline `scripts/` tooling. It may read retired records and append canonical records while the session is closed. Production code must not import it, expose migration-only helpers, keep legacy aliases, or scan retired formats during startup, restore, inheritance or queries.
- Preserve current target grammar, precedence, config reset behavior, group/alias handling and SDK/ancestor restrictions. Share the rule-winner algorithm across single-name and batch paths.
- Compute effects from effective permission after mutation: an overlapping group operation must not activate a still-disabled exact member or remove a still-enabled one. Preserve truthful changed/already-set/skipped/record-failure results and declaration-removal timing.
- Reuse one operation-local catalog/branch resolution for query, set/reset effects, admission, Preset retention, compaction and child denials. No persistent branch cache or invalidation service.

Acceptance:

- Existing real-domain overlap reproductions fail before the fix and pass after it.
- A retired manual-only record cannot grant execution; a canonical reset cannot leave that legacy grant behind. Verify through the actual execution/admission entry points.
- Exact/group/prefix and alias chronology agree across command, RPC, discovery, direct execution and Codemode. Current canonical records replay through resume/tree/fork without reading legacy state.
- Record append failure applies no effect. Active state remains distinct from management state. Disabled direct declarations keep their existing compaction semantics.

### Stage 2: Remove unnecessary inherited-history materialization

Requirements:

- Build a concrete ownership table for capture, Runtime seed metadata, SessionManager storage, projection and child append state. Document actual writes before retaining any deep copy.
- Share immutable historical entry/message bodies. Give each child its own append array, session header/id, index and leaf state. Do not introduce a general Proxy, deep freeze or CoW layer.
- Keep captured history stable across the creation batch and parent progress. Provider blocks, signatures, context edits and tool-result links must survive unchanged.
- If a real writer requires content copying or materialization, use the SDK's effective-context semantics at the latest valid compaction. Include the summary, the `firstKeptEntryId` interval and later entries, plus required tool/prompt/cache state. Do not slice only after the compaction record or erase durable source history.
- Review synchronous JSONL writes and repeated branch traversals independently from deep cloning. Do not change durable recovery formats or lose restart/continuation information merely to shrink an in-memory fixture.

Acceptance:

- Real parent plus sibling sessions can append, branch, compact and settle independently while shared historical messages remain unchanged.
- Tests verify append/header/branch isolation and unchanged historical content, rather than requiring every nested reference to differ.
- Compaction-boundary examples cover no compaction, retained messages before the checkpoint record, post-checkpoint tool calls, context edits, and necessary custom state. Compare the model-visible effective context using independent expected blocks.
- Re-run the existing 500-turn scenario for CPU, event-loop delay and memory with identical dependencies. Distinguish transient allocation, live-child retained state and post-disposal recovery; do not claim a leak from RSS growth alone.

### Stage 3: Make observation ownership detachable and projections focused

Requirements:

- Replace uncancellable per-subscription terminal Promise continuations with an existing detachable lifecycle mechanism, or the smallest terminal observer API needed. Teardown on unsubscribe/disconnect/root retirement must release both native and Runtime observers.
- Terminal Jobs still report state in the subscription boundary; do not replay terminal events or lose early events before the response.
- Read only the live boundary for history requests. Build messages/partial for subscriptions once; remove unused eager entry projections. Preserve current wire payloads.
- Audit connection request queues, backpressure, terminal callbacks and runner-retained partial messages for real reachability. Keep evidence-backed resource fences and unknown-handoff non-replay.

Acceptance:

- Repeated subscribe/unsubscribe and disconnect to an unresolved real Runtime Job do not retain removed observers or connections until settlement. Test delivery suppression and resource release as separate facts.
- Retained observations are constant in current active subscriptions, not cumulative subscription count. Confirm with explicit observer lifecycle evidence and an isolated GC diagnostic where appropriate.
- Real socket/Named Pipe tests preserve snapshot/delta ordering, early-event correlation, unsubscribe and root-switch behavior. Observation never injects monitoring content into Main.

### Stage 4: Simplify replay and internal boundaries without changing semantics

Requirements:

- Measure discovery/prune replay with interleaved removal and rediscovery. Optimize only while retaining per-record chronology and metadata; no cumulative-set shortcut that revives old records.
- Remove duplicate runtime checks on controlled typed inputs once actual callers are verified. Keep validation of external JSON/tool arguments, persisted records and resource ownership.
- Resolve `cloneValue`'s fallback-to-shared behavior through explicit ownership and accepted data contracts. Do not silently weaken a guarantee, add recursive validation or preserve compatibility fallbacks.
- Rename misleading legacy module/proxy names where useful. Merge only wrappers with no independent ownership or behavior; retain small platform modules when they represent actual platform boundaries.
- Remove or archive the broken admission benchmark as historical evidence; do not restore removed exports. Generated schema remains a build/CI asset with local ignored JSON and tracked checksums.

Acceptance:

- Independent timeline examples cover prune, rediscovery, alias changes and historical prompt metadata. Type checks and behavior tests remain valid after removing redundant mechanisms.
- No production legacy readers, compatibility aliases, migration imports, duplicate rule winners, or unsupported copy guarantees remain in the rewritten scope.
- Each remaining substantial copy, state map, validator and adapter has an identified owner and current caller. No line-count reduction target substitutes for this inventory.

### Stage 5: Replace misleading test evidence and close Windows failures

Requirements:

- Replace RootService simulations with actual root/child integration for live denials and root-only explicit enable. Keep useful scope-unit tests labeled as such; do not merely update their fake refresh logic to mirror production.
- Preserve independent expected outputs and known failure triggers. Do not use the implementation's path/rule algorithm to generate expected answers, add broad skips, or loosen assertions to make Windows green.
- Resolve the current Windows failures by identifying Shell platform semantics, real PowerShell quoting, native path fixtures and policy input. Verify execution prevention and the exact policy argv/cwd at the real SDK boundary.
- Keep performance diagnostics opt-in. The default gate may contain a cheap work-count regression for the known hot path; no wall-clock or RSS thresholds in the default suite.

Acceptance:

- Full Linux and native Windows checks pass with explicit counts/skips and environment prerequisites. Existing POSIX-only CLI subprocess smoke remains declared until its Windows lifecycle is separately implemented; no claim of that coverage from Named Pipe unit tests.
- CI finishes on both operating systems; generated schema hashes match; protocol artifacts upload. New action versions remove the reported Node 20 deprecation warning.
- Record actual failed-before/passed-after evidence for the creation, permission, legacy-authority and observer-lifetime regressions. Prior gate totals are not substituted for the rewritten tree's evidence.

### Commit sequence and completion gate

Keep each stage reviewable and split further where behaviors can be reverted independently. Include corresponding tests and current contract updates in each implementation commit; keep migration tooling, historical proposal archiving and repository governance as separate changes when independent. Every intermediate code commit must type-check and pass its applicable gate without referencing future commits.

Before declaring the rewrite complete:

1. Reconcile every finding in this audit and the two follow-up reviews as fixed, rejected with evidence, or explicitly deferred with a concrete user-visible scope. None of the confirmed authorization, effective-state, subscription-release or creation-regression defects may remain open.
2. Remove whole-history defensive cloning in the reviewed creation path, or document a demonstrated writer requiring bounded effective-context copying. Do not treat append-container mutation as message-body mutation.
3. Verify production supports only current formats, with any migration completely outside production modules.
4. Pass Linux, Windows, schema/checksum, docs/JSON and staged test-contract checks; inspect complete staged diffs and secret-scan results.
5. Report tested revision, before/after evidence, memory ownership limits and untested environments. The freeze required a concrete report and user authorization to lift; it did not permit automatically restarting feature work.
