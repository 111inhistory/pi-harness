# Memory retention and lifecycle review

Follow-up verification confirmed connection retention after subscription cancellation, transient prune-replay allocations, unused snapshot projections and the existence of the named clone sites. See [confirmed findings V1–V10](rpc-permission-audit.md#confirmed-findings-from-the-two-follow-up-reviews) for reproduced retention, counted work and the limits of static evidence.

This review is not an accepted ownership contract. The eager-capture and whole-history deep-copy claims below were rejected after checking the actual call path and SDK writes. Root/scope collection growth alone has not established a leak. See [the reconciled rewrite plan](rpc-permission-audit.md#reconciliation-of-the-additional-reviews) before using these recommendations.

## Scope

This review examines memory retention, reference leaks, unnecessary allocations and defensive copying introduced after `af3494b`. It focuses on lifetime management of collections, closures, event listeners and intermediate projections that the algorithm and test reviews did not cover.

Evidence: static analysis of closure captures, collection growth patterns, and object lifecycle across session/root/Job boundaries. No heap profiling or GC instrumentation was performed; findings are based on code structure and reference lifetime.

## Critical retention issues

### P0: RPC subscription observers are not released when a Job settles

**Location**: `src/harness-rpc/ports/stream.ts:54-72`

```typescript
void root.runtime.jobDone(jobId).then((view) => {
  if (!active) return;
  connection.pushEvent(subscriptionId, { /* ... */ });
}).catch(() => {
  /* A settled Job's boundary already belongs to the runtime. */
});
```

**Problem**: The subscription attaches a `.then()` continuation to `runtime.jobDone(jobId)` **before** checking if the Job is already terminal. The continuation captures `connection`, `subscriptionId`, `root` and `view`. When the client calls `unsubscribe`, only `active` is set to `false` and the native event listener is removed (`live.listeners.delete(listener)`), but the `jobDone` waiter remains attached.

**Evidence**: `SubagentRuntime.jobDone` returns a Promise that resolves when the Job reaches terminal status (L1280-1290 in `runtime.ts`). The runtime stores one waiter array per Job in `#waiters: Map<string, Array<(view: JobView) => void>>`. The waiter array holds every registered callback until the Job settles, at which point all callbacks are invoked and the array is cleared (L1299).

A client that subscribes to a running Job, receives some events, then unsubscribes will leave its continuation in `#waiters` until the Job finishes. For a long-running Job (e.g., a multi-hour batch), repeated subscribe/unsubscribe cycles accumulate waiters. Each waiter captures the entire `RpcConnection` object, which holds the socket, all other subscriptions on that connection, and the chain of serialized request promises.

**Reproduction scenario** (from audit P1 finding):
1. Create one Job that does not settle (e.g., a user-input wait or a long-running shell task)
2. Subscribe 500 times, each time creating a new connection object
3. Unsubscribe immediately after each subscription
4. Drop all caller references to the 500 connections
5. Perform GC
6. All 500 connections remain reachable through `jobDone` waiters

**Impact**: Memory growth proportional to subscription count × connection size, retained until Job settlement. In a multi-tenant RPC scenario or a debugging session with repeated client reconnections, this is a leak.

**Fix**: Track the `jobDone` waiter and detach it on unsubscribe:

```typescript
let jobWaiter: ((view: JobView) => void) | null = null;
if (!TERMINAL.has(snapshot.status)) {
  jobWaiter = (view) => {
    if (!active) return;
    connection.pushEvent(subscriptionId, { /* ... */ });
  };
  void root.runtime.jobDone(jobId).then(jobWaiter).catch(() => {});
}

// In unsubscribe:
if (jobWaiter !== null) {
  // runtime must expose removeJobWaiter(jobId, waiter) or use AbortSignal
}
```

Alternatively, use an `AbortSignal` to cancel the `jobDone` waiter when the subscription is removed.

---

### P0: `discoveryRecords` allocates a new filtered array on every prune entry

**Location**: `src/capability/discovery-record.ts:285-307`

```typescript
for (const entry of branch ?? []) {
  // ...
  } else if (entry["customType"] === CAPABILITY_PRUNE_RECORD) {
    const prune = parsePruneRecord(entry["data"]);
    if (prune !== null && (prune.removedTools.length > 0 || (prune.removedGroups?.length ?? 0) > 0)) {
      const removedTools = new Set(prune.removedTools);
      const removedGroups = new Set(prune.removedGroups ?? []);
      records = records.map((record) => filterDiscoveryByPrune(record, removedTools, removedGroups));
    }
  }
}
```

**Problem**: For each prune entry, `records.map()` allocates a new array and calls `filterDiscoveryByPrune` for every accumulated discovery record. With `k` prune entries and `n` discovery records, this creates `O(k × n)` intermediate `StoredDiscovery` objects and `O(k)` temporary arrays.

**Memory impact**:
- 10 prune entries × 50 discoveries = 500 `StoredDiscovery` allocations, each containing nested `tools`/`mcp`/`guidance` arrays
- Each `filterDiscoveryByPrune` call allocates new `tools`/`mcp` arrays via `filterHits`, plus a `guidance` array via `filterGuidance`
- These intermediate objects are short-lived (GC collects them after the next prune), but the allocation rate spikes during branch replay

**Call frequency**: `discoveryRecords` is called on every context projection (once per request in TUI, once per RPC catalog query). A session with 1,000 entries and 10 prunes replays this work 10 times per request.

**Fix** (also addresses the P0 algorithm issue): Single-pass accumulation. Maintain one cumulative `removedTools` set and `removedGroups` set, clear entries when a discovery re-introduces them, and apply the filter once at the end.

---

### P1: `RootService.#retainedScopes` accumulates proxies for every actor ever created

**Location**: `src/subagent/root-service.ts:106-116, 670-691`

```typescript
readonly #retainedScopes = new Map<string, { proxy: CapabilityToolCatalog; excluded: readonly string[] }>();

#parentScope(agentId: string | null): CapabilityToolCatalog {
  // ...
  const retained = this.#retainedScopes.get(agentId);
  if (retained !== undefined) {
    setCapabilityParent(retained.proxy, this.#rootScope(), [...retained.excluded, ...disabled]);
    return retained.proxy;
  }
  const scope = this.actors.toolScope(agentId);
  if (scope === null) throw new SubagentError('unknown_agent', `Missing parent capability scope for ${agentId}.`);
  const proxy: CapabilityToolCatalog = { getAllTools: () => { /* ... */ } };
  setCapabilityParent(proxy, this.#rootScope(), [...scope.excludedTools, ...disabled]);
  this.#retainedScopes.set(agentId, { proxy, excluded: scope.excludedTools });
  return proxy;
}
```

**Problem**: When a child's first Job runs, `#parentScope` is called to resolve its capability parent. If the actor is not live (no running Job), a retained proxy is constructed and stored in `#retainedScopes`. The map is **never cleared**. Once an actor's proxy is inserted, it remains until the root retires.

The proxy closure captures `this.#options.api` and `this.actors`, and `getAllTools()` reads the actor's tool scope on every call. Although the closure itself is small, the map grows without bound: 1,000 actors created during a root's lifetime = 1,000 map entries, each holding a closure and an `excluded` array.

**Impact**: Bounded by actor count, not Job count, but actors are never reclaimed. A root that runs 10,000 Jobs across 500 distinct actors will hold 500 proxies indefinitely. The proxies themselves are lightweight, but their unbounded accumulation is a leak in principle.

**Mitigation**: Either clear `#retainedScopes` when an actor is explicitly stopped/removed (requires tracking actor lifecycle), or use a `WeakMap<string, ...>` with a separate id-to-proxy indirection (non-trivial because string keys are not weak). Or accept bounded growth: for realistic actor counts (<1000), this is tolerable.

**Recommendation**: Document the lifetime explicitly. If actor count is expected to stay below 1,000 per root session, annotate this as "bounded by actor count" rather than a leak. If unbounded actor creation is expected (e.g., ephemeral test actors), add a cleanup path.

---

### P1: Scope `learned` sets grow monotonically and are never pruned

**Location**: `src/capability/scope.ts:79-90, 118-138`

```typescript
interface ScopeState {
  parent: CapabilityParentSource;
  denied: ReadonlySet<string>;
  /** Append-only qualification learned by earlier operations. */
  learned: Set<string>;
  permissionDefaults: readonly string[];
}

const scopes = new WeakMap<CapabilityToolCatalog, ScopeState>();
```

**Problem**: Every time `createCapabilityScopeView` is called, it appends to `state.learned` for every ancestor in the chain (L127-133). The learned sets are append-only by design (stated in `scope.ts:20`), but they are never cleared or bounded.

A child session that is repeatedly created, stopped, and recreated (e.g., a test harness or a batch processor) will accumulate every tool name it has ever seen. The root's learned set also grows: every tool the root has ever qualified is added to `stateFor(pi).learned` and never removed.

**Memory cost**: Each learned set is a `Set<string>`. With 500 registered tools and 100 scope view constructions, a child's learned set can reach 500 entries (bounded by total tool count). The set itself is not large, but its growth is unbounded relative to operation count, not tool count.

**Mitigation**: The sets are bounded by registered tool count, which is typically <500. For a single root session, this is acceptable. However, if a scope object outlives its session (e.g., a cached ExtensionAPI in a test fixture), the learned sets will accumulate across multiple test cases.

**Recommendation**: Acceptable for production (bounded by tool count), but a test concern. If test fixtures reuse the same ExtensionAPI across multiple sessions, the learned sets will grow. Test cleanup should either create fresh API objects or accept that learned sets reflect the union of all test cases.

---

### P2: Permission resolver cache is per-operation but branch replay is not

**Location**: `src/capability/tool-permission.ts:547-580`

```typescript
export function createToolPermissionResolver(
  host: ToolPermissionHost,
  tools: readonly ToolPermissionTool[] | null,
  branch: readonly unknown[] | null | undefined,
): ToolPermissionResolver {
  const stored = storedEntries(host, branch);  // replays branch once
  const byName = tools === null ? null : new Map(tools.map((tool) => [tool.name, tool]));
  const cache = new Map<string, { readonly state: ToolPermissionManagedState | null; readonly seeded: boolean }>();
  const resolveTool = (tool: ToolPermissionTool | undefined, name: string) => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    // ... resolve and cache
  };
  // ...
}
```

**Problem**: `storedEntries(host, branch)` replays the entire branch to compute explicit state and config defaults. The resolver caches per-tool results in `cache`, but the branch replay is not cached. Multiple resolver constructions in the same request (e.g., one for eligibility, one for admission, one for RPC snapshot) replay the branch multiple times.

**Call sites**:
- `extension.ts:200` (context projection)
- `extension.ts:464` (discovery provider)
- `tool-info.ts:83` (RPC snapshot)
- `root-service.ts:665` (`#childDeniedNames` on every parent-scope resolution)

Each call constructs a new resolver and replays the branch. For a branch with 1,000 entries and 30 permission records, each replay creates 30 `ManagedEntry` objects plus intermediate Sets/Maps in `explicitState`.

**Impact**: Allocation rate, not retention. The intermediate objects are short-lived, but the repeated work is unnecessary. The algorithm review already flagged repeated catalog reads (P2); this is the permission-domain counterpart.

**Fix**: Cache `storedEntries(host, branch)` at operation scope (e.g., per request or per context projection), or accept that the resolver is cheap enough (30 entries × 1,000-entry branch replay is <1ms on a modern CPU). Given that the resolver itself is operation-local, the repeated branch replay is a performance concern (covered by the algorithm review), not a memory leak.

---

## Allocation and copying inefficiencies

### P1: `liveSnapshot()` builds full messages/entries arrays on every call

**Location**: `src/subagent/native-runner.ts:542-548`

```typescript
live.snapshot = () => ({
  startEntryId: boundary,
  endEntryId: manager.getLeafId(),
  messages: jobMessages(),  // calls messagesAfter(manager, boundary)
  entries: entriesAfter(manager, boundary),
  partial: live.latestPartial,
});
```

**Usage**:
- `history.read` (L46 in ports/history.ts): calls `liveSnapshot` to get `endEntryId`, then calls `actors.readInterval` to read the same entries again. The snapshot's `messages` and `entries` are unused.
- `stream.subscribe` (L54 in ports/stream.ts): uses `messages` and `partial`, but not `entries`.

**Problem**: `messagesAfter` and `entriesAfter` traverse the native branch and build arrays. For a Job that has produced 500 messages, `history.read` allocates and discards 500+ message objects plus 500+ entry objects, then reads the same interval again via `actors.readInterval`.

**Memory impact**: Short-lived allocations (GC collects them after the call), but high allocation rate for repeated RPC queries. A client polling `history.read` every second for a long-running Job allocates 1,000+ objects per second, most of which are immediately discarded.

**Fix**: Split the interface (already noted in the algorithm review as P2):
- `liveBoundary(): { startEntryId, endEntryId }`
- `liveMessages(): { messages, partial }`

Or use lazy object properties that compute on first access. The current eager construction contradicts the "observation is a projection" principle stated in the snapshot's own docstring.

---

### P2: Inherited context capture is called eagerly even when not used

**Location**: `src/subagent/surface.ts:200-210, root-service.ts:293`

```typescript
// surface.ts
export interface SubagentSurfaceCreateOptions {
  // ...
  /** Lazy capture: the runtime calls it only for an Inherited admission. */
  readonly captureInheritedContext: () => unknown;
}

// root-service.ts:293
return root.create(batch, {
  parentAgentId: null,
  allowInherited: true,
  origin: { /* ... */ },
  captureInheritedContext: () => captureContextForChild(api, ctx, 1, root.maxDepth),
}, ctx);
```

**Problem**: The docstring says "the runtime calls it only for an Inherited admission", but the closure is constructed **every time** `root.create` is called. Closure construction itself is cheap (just captures references), but `captureContextForChild` is not lazy: it is a thunk that **will** be called if the batch contains any Inherited task.

The real inefficiency is inside `captureContextForChild` (L285-300 in surface.ts):

```typescript
export function captureContextForChild(
  api: SubagentSurfaceApi,
  ctx: ExtensionContext,
  childDepth: number,
  maxDepth: number,
  toolCallId?: string,
): InheritedSnapshot & { readonly warnings?: readonly string[] } {
  const snapshot = captureInheritedContext(api, ctx, toolCallId);
  const dropped = droppedInheritedTools(api.getAllTools(), snapshot.tools, childDepth, maxDepth);
  return dropped.length === 0 ? snapshot : { ...snapshot, warnings: [inheritedToolsWarning(dropped)] };
}
```

`captureInheritedContext` (from `inherited-context.ts`) reads the entire branch, projects it to messages, and builds a full `InheritedSnapshot`. For a root with 1,000-entry branch, this allocates 1,000+ projected message objects, even when the batch contains zero Inherited tasks.

**Call frequency**: Every `subagent.create` invocation. A batch with 10 Fresh tasks (zero Inherited) still constructs the closure and will allocate the snapshot if `captureContextForChild` is called (it is not, so the thunk remains uncalled, but the closure allocation is wasted).

**Impact**: Allocation waste when no Inherited tasks are admitted. The snapshot itself is not leaked (it is GC'd if the thunk is never called), but constructing a closure for every batch is unnecessary.

**Fix**: Guard the capture at the caller:

```typescript
captureInheritedContext: options.allowInherited
  ? () => captureContextForChild(api, ctx, 1, root.maxDepth)
  : () => { throw new Error('Inherited tasks are not allowed in this context.'); }
```

Or defer closure construction until `allowInherited === true` and an Inherited task is actually admitted.

---

### P2: `structuredClone` is used defensively where ownership is clear

**Locations**:
- `agent.ts:161`: `hit: structuredClone(hit)` inside a Map
- `agent.ts:208`: `structuredClone(entry.hit)` when building discovery result
- `codemode.ts:252`: `usage = structuredClone(next)` for usage accumulation
- `codemode.ts:297`: `usage: structuredClone(usage)` in tool result

**Pattern**: Capability search hits and Codemode usage objects are cloned multiple times within the same execution context. The hits are stored in a `Map` that is local to one discovery session, and the usage is accumulated within one Codemode execution.

**Problem**: `structuredClone` is expensive (serializes to internal format and deserializes). It is justified at IPC boundaries (cross-session messages), at storage boundaries (writing to disk), or when objects are handed to untrusted code. Within a single synchronous discovery session or Codemode execution, the objects are not shared with concurrent operations.

**Example**: `agent.ts:161` stores `structuredClone(hit)` in `run.hits`, which is a `Map` local to one `discover()` call. The hit is not returned to the caller until the entire discovery completes. The clone prevents the hit from being mutated by later processing, but the code does not mutate hits after storing them.

**Impact**: CPU cost (cloning is not free), not memory (the clones are short-lived). For a discovery session that processes 50 hits, 50 `structuredClone` calls are performed. Each hit is a small object (<1KB), so the cost is 10-50ms per session, but this is unnecessary when ownership is clear.

**Recommendation**: Audit each `structuredClone` call and document its justification:
- Cross-session/IPC boundary: justified
- Storage/disk write: justified
- Defensive copy within one operation: only if objects are mutated after sharing

For hits that are stored in a local Map and never mutated, prefer shallow copy (`{ ...hit }`) or accept shared references.

---

### P3: Repeated `.map` calls for simple projections

**Examples**:
- `tool-permission.ts:706`: `changedTargets.map((item) => ({ ...item.target, affectedTools: item.affectedTools }))`
- `command.ts:157`: `groups.map((group) => group.label)`
- `skills.ts:123`: `loaded.skills.map((skill) => ({ ...skill, sourceInfo: sources.get(...)?.sourceInfo ?? skill.sourceInfo }))`

**Problem**: These are small allocations (10-50 objects per call), but they occur in hot paths (command execution, permission queries). The spread operator creates a new object for every item, even when only one field is added.

**Impact**: Minor. Each `.map` allocates a new array and 10-50 objects. For typical batch sizes (<100), this is noise. Only flag it as P3 to establish a pattern: prefer in-place construction or shared references when the projection is simple.

---

## Listener and subscription lifecycle

### P1: `LiveJob.listeners` is cleared but the LiveJob remains in `#jobs` map

**Location**: `src/subagent/native-runner.ts:647-653`

```typescript
})).finally(async (): Promise<void> => {
  live.closed = true;
  live.listeners.clear();
  live.snapshot = null;
  live.latestPartial = null;
  this.#jobs.delete(request.jobId);
  // ...
});
```

**Analysis**: This is **correct**. The LiveJob is removed from `#jobs` in the same `finally` block that clears `listeners`. The P0 issue is not here; it is in the RPC subscription's `jobDone` waiter, which is registered at the Runtime level and not released when the RPC subscription is removed.

**No issue**: The LiveJob cleanup is correct. The audit's P1 finding is specifically about `runtime.jobDone` waiters, not the LiveJob's own listener set.

---

### OK: RPC connection subscriptions are released on `close()`

**Location**: `src/harness-rpc/transport.ts:143-158`

```typescript
close(): void {
  if (this.#closed) return;
  this.#closed = true;
  for (const unsubscribe of this.#subscriptions.values()) {
    try {
      unsubscribe();
    } catch (error) {
      this.#onError(asError(error));
    }
  }
  this.#subscriptions.clear();
  // ...
}
```

**Analysis**: When the connection is closed, all subscriptions are unsubscribed and the map is cleared. The subscription map itself does not leak.

**The leak** is that the `unsubscribe()` callback (returned by `subscribeJobEvents`) only removes the native event listener (`live.listeners.delete(listener)`), but does not remove the `jobDone` waiter registered at the Runtime level. The connection's cleanup is correct; the subscription's cleanup is incomplete.

---

## WeakMap and lifecycle assumptions

### OK: `scopes` WeakMap keys on ExtensionAPI

**Location**: `src/capability/scope.ts:79`

```typescript
const scopes = new WeakMap<CapabilityToolCatalog, ScopeState>();
```

**Analysis**: The key is an ExtensionAPI (or a proxy catalog in RootService). When the API is GC'd, the ScopeState is released. This is correct for the root session (the API outlives all operations), and correct for child sessions (the API is released when the child session ends).

**The concern** from P1 is that `state.learned` grows without bound **while the API is live**. The WeakMap itself is not a leak; the issue is the unbounded growth of the `learned` Set for a long-lived API.

---

### OK: `readers` WeakMap keys on ExtensionAPI

**Location**: `src/capability/declaration-visibility.ts:32`

```typescript
const readers = new WeakMap<object, DeclarationsReader>();
```

**Analysis**: Similar to `scopes`. The key is the ExtensionAPI, and the reader is released when the API is GC'd. No leak here.

---

## Defensive copying and shared references

### Acceptable: Inherited entry copying is justified

**Location**: `src/subagent/runtime.ts` (via `copyInheritedEntries`)

**Justification** (from boundary review): Child sessions modify their own entries (add custom data, append new turns). If inherited entries are shared by reference, a child's mutation would corrupt the parent's conversation. The deep copy isolates sibling and parent state.

**Verdict**: The copying is necessary. The algorithm review's note that "cloneValue promises detached values but returns the original object if cloning fails" is a separate concern (inconsistent ownership contract), not evidence that the copying itself is unnecessary.

---

### Acceptable: RPC input validation and `asRecord` guards

**Location**: `src/harness-rpc/util.ts`

**Justification**: RPC frames arrive from an external transport (Unix socket, Named Pipe) and are decoded from JSON. They are untrusted input by definition. The validation transforms `unknown` to typed values and rejects malformed requests with structured errors.

**Verdict**: Appropriate for an external boundary. Not a defensive-copy concern.

---

## Summary of retention issues

| Issue | Severity | Retained object | Lifetime | Fix |
|-------|----------|----------------|----------|-----|
| RPC `jobDone` waiters not released on unsubscribe | **P0** | `RpcConnection`, closures | Until Job settles | Detach waiter on unsubscribe |
| `discoveryRecords` O(n²) prune filtering | **P0** | Intermediate `StoredDiscovery[]` arrays | Per branch replay | Single-pass accumulation |
| `#retainedScopes` unbounded growth | **P1** | Proxy closures | Until root retires | Document bounded growth or add cleanup |
| Scope `learned` sets grow monotonically | **P1** | `Set<string>` per scope | Until API is GC'd | Acceptable (bounded by tool count) |
| `liveSnapshot` builds unused arrays | **P1** | Projected messages/entries | Short-lived | Split interface |
| Inherited capture always constructs closure | **P2** | Closure allocation | Short-lived | Guard at caller |
| Defensive `structuredClone` in hot paths | **P2** | Cloned objects | Short-lived | Audit ownership |
| Permission resolver branch replay not cached | **P2** | Intermediate Sets/Maps | Short-lived | Cache at operation scope |

**Critical path**: Fix P0 items (RPC waiter leak, prune O(n²)) before merge. Address P1 items (retained scopes, snapshot interface) in the next iteration.

The Windows validation failures (14 failures, 18 skips) and the performance issues identified in the audit remain separate concerns.
