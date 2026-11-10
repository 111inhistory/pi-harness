# Capability permission algorithm and test coverage review

Follow-up verification confirmed repeated prune filtering, per-tool rule scans, repeated query replay, duplicated winner logic, unused snapshot projections, inaccurate propagation fixtures and the broken admission benchmark. See [confirmed findings V1–V10](rpc-permission-audit.md#confirmed-findings-from-the-two-follow-up-reviews) for production-function probes, counts, provenance and limits.

This review is not an accepted implementation plan. Other factual claims and severity labels below were rejected or qualified after source verification; see [the reconciled rewrite plan](rpc-permission-audit.md#reconciliation-of-the-additional-reviews). Preserve this text as review history; do not implement its indexing, cumulative-prune, or test-mapping suggestions without that reconciliation.

## Scope

This review examines the algorithm efficiency, architectural coherence and test quality of the capability permission and RPC observation changes introduced after `af3494b`. It complements `rpc-permission-audit.md` by focusing on computational complexity, redundant logic, and test construction issues that the prior audit did not cover.

Evidence sources: static analysis of production call paths, synthetic fixtures for complexity measurement, and inspection of test construction patterns. No online providers or external MCP services were used.

## Algorithm efficiency findings

### P0: `discoveryRecords` O(n²) prune filtering

**Location**: `src/capability/discovery-record.ts:285-295`

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

**Problem**: For each `capability-prune` entry encountered, the entire accumulated `records` array is re-mapped. With `k` prune records and `n` discovery records, complexity is O(k × n). A branch with 10 compactions and 50 discoveries performs 500 filtering passes.

**Impact**: `discoveryRecords` is called on every context projection (L192 in `extension.ts`), memory read for admission (L118 in `admission.ts`), and pruned-name derivation. With long-lived sessions accumulating multiple compactions, this becomes a per-request hotspot.

**Fix**: Single-pass accumulation. Collect all `removedTools` and `removedGroups` into cumulative sets during branch traversal, clearing them when a discovery re-introduces a name. Apply the final filter once at the end.

---

### P0: `createToolPermissionResolver` linear scan per uncached tool

**Location**: `src/capability/tool-permission.ts:565-580`

```typescript
const resolveTool = (tool: ToolPermissionTool | undefined, name: string) => {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const matches = stored.filter((entry) => matchesEntry(entry.entry, tool, name));
  // ... sort by precedence, pick winner
```

**Problem**: `stored` is computed once per resolver via `storedEntries(host, branch)`, which already replays the branch and builds the effective rules. However, for each uncached tool name, the resolver filters the entire `stored` array (typically 10–50 entries) and sorts matches.

**Measurement**: A resolver constructed with 500 registered tools and 30 stored permission entries, queried for all 500 tools, performs 15,000 `matchesEntry` calls (500 × 30). The cache prevents repeated work within one operation, but the first catalog query or activation in a request pays this cost.

**Impact**: Multiplied across the execution hooks, admission checks, eligibility filters and RPC catalog queries introduced in this change set. The audit's "repeated branch/catalog work" (P2) stems partly from this.

**Fix**: Build reverse indices when constructing the resolver:
- `Map<toolName, ManagedEntry[]>` for exact-tool entries
- `Map<server, ManagedEntry[]>` for `mcp://` entries
- `Map<namespace, ManagedEntry[]>` for `namespace://` entries
- `ManagedEntry[]` for prefix entries (unavoidable scan, but typically 1–3 entries)

Lookup becomes O(1) for exact matches, O(serverToolCount) for MCP, O(namespaceToolCount) for namespaces.

---

### P1: `extractUsedToolsFromWindow` nested iteration with no early exit

**Location**: `src/capability/pruning.ts:77-120`

```typescript
for (const entry of windowEntries) {
  // ... check direct toolResult
  const nested = msg["nestedCalls"];
  if (isRecord(nested) && Array.isArray(nested["calls"])) {
    for (const call of nested["calls"]) {
      if (isRecord(call) && typeof call["name"] === "string" && call["name"] !== "") {
        if (typeof call["durationMs"] === "number" && call["durationMs"] >= 0) {
          used.add(call["name"]);
        }
      }
    }
  }
}
```

**Problem**: Once a tool is added to `used`, subsequent entries still check it. For a compaction window with 1,000 entries and 50 distinct tools, the function performs 1,000 entry iterations even after all 50 tools are known used.

**Impact**: Compaction is background and does not block user requests, but it runs on the main event loop. A long window (e.g., `noSelectionLimit: true` producing 500+ turns between compactions) delays the compaction completion and the subsequent `session_compact` hook.

**Mitigation**: The full scan is deliberate (to count usage frequency if metrics are added later), so this is optimization rather than correctness. If usage is binary (used/unused), short-circuit when `used.size` equals the number of discovered tools. Alternatively, yield control periodically with `setImmediate` batching.

---

### P1: Permission precedence algorithm duplicated three times

**Locations**:
1. `tool-permission.ts:452` (`decide` function)
2. `tool-permission.ts:574` (`resolveTool` within `createToolPermissionResolver`)
3. `tool-permission.ts:334` (`storedEntries`, implicit via Map key replacement)

**Code** (identical in two places):
```typescript
matches.sort((left, right) => Number(left.defaulted) - Number(right.defaulted)
  || KIND_RANK[left.entry.kind] - KIND_RANK[right.entry.kind]
  || right.order - left.order);
const winner = matches[0]!;
```

**Problem**: The same precedence rule (`defaulted` → `KIND_RANK` → `order`) is implemented three times. `storedEntries` achieves it by Map key replacement (later insertion wins within rank), but the logic is not obvious from reading the code. Changing precedence requires coordinating three sites.

**Fix**: Extract `function selectWinningEntry(matches: readonly ManagedEntry[]): ManagedEntry` and reuse it. `storedEntries` can also call it explicitly instead of relying on Map insertion order.

---

## Architectural coherence findings

### P1: `RootService.#rootScope()` cache name misleads

**Location**: `src/subagent/root-service.ts:148-158`

```typescript
#rootScopeCache: CapabilityToolCatalog | null = null;

#rootScope(): CapabilityToolCatalog {
  const catalog = this.#rootScopeCache ??= {
    getAllTools: () => this.#options.api.getAllTools(),
  };
  setCapabilityParent(catalog, null, this.#childDeniedNames());
  return catalog;
}
```

**Problem**: `#rootScopeCache` suggests expensive computation is skipped on subsequent calls, but only the object shell is cached. `#childDeniedNames()` is invoked every time, which replays the branch, reads all tools, and resolves permissions for every tool (the P1 catalog-reconstruction issue from the audit).

The field name creates a false expectation. A reader scanning for performance issues might conclude the root scope is cached and skip investigating this path, missing the repeated work.

**Options**:
1. Truly cache the result: store `{ catalog, denials }` and invalidate on branch append.
2. Rename to `#rootScopeProxy` or `#rootScopeCatalog` to clarify it is not a computation cache.

Given that scope views are intentionally fresh per operation (stated in `scope.ts:20`), option 2 aligns with the current design. If caching is added later, invalidation must coordinate with branch appends across extensions.

---

### P2: Native snapshot interface forces construction of unused fields

**Location**: `src/subagent/native-runner.ts:330-336`

```typescript
live.snapshot = () => ({
  startEntryId: boundary,
  endEntryId: manager.getLeafId(),
  messages: jobMessages(),  // builds entire message array
  entries: entriesAfter(manager, boundary),  // traverses branch
  partial: live.latestPartial,
});
```

**Usage**:
- `history.read` (ports/history.ts:46): calls `liveSnapshot` to obtain `endEntryId`, then reads the interval again via `actors.readInterval`. The returned `messages`, `entries` and `partial` are unused.
- `stream.subscribe` (ports/stream.ts:54): uses `messages` and `partial` but not `entries`.

**Problem**: A single snapshot interface forces every caller to construct all five fields, even when only a subset is needed. `jobMessages()` and `entriesAfter()` traverse the same native branch twice. For a Job that has produced 500 messages, `history.read` builds and discards 1,000+ objects per call.

**Impact**: Observation is a secondary concern (not the hot path), but the RPC endpoint was added specifically to avoid parsing TUI output. Constructing and discarding full projections contradicts that goal.

**Fix**: Split into focused accessors:
- `liveBoundary(): { startEntryId, endEntryId }`
- `liveMessages(): { messages, partial }`
- `liveSnapshot()` as a convenience that calls both

Or use lazy object properties that compute on access. The current eager construction is not justified by usage patterns.

---

### P2: State source composition order inconsistent across call sites

Permission state is derived from:
- `storedEntries(host, branch)` — branch records plus config defaults
- `independentDeclarations(host)` — native loadout visibility mask
- `host.getActiveTools()` — activation state
- `createCapabilityScopeView(host).available` — scope eligibility

Different entry points read these sources in different orders:

1. **extension.ts:242** (context projection):
   ```typescript
   const catalog = createEligibleToolCatalog(pi, { blocked: permission.disabledFor });
   const admission = createToolAdmission(pi, branch, catalog);
   const callable = new Set(pi.getActiveTools().filter(admission.admits));
   ```
   Order: eligibility → permission → admission → active

2. **tool-catalog.ts** (eligibility filtering):
   ```typescript
   const eligible = createCapabilityScopeView(host, { ... });
   // then separately: permission.disabledFor(tool)
   ```
   Order: eligibility → permission

3. **tool-info.ts:83** (RPC snapshot):
   ```typescript
   const state = snapshot(api, ctx);  // reads permission first, then eligibility, then active
   ```
   Order: permission → eligibility → active

**Problem**: The final derived state is correct (the resolver unifies them), but the scattered read order increases verification cost. If a new state source is added (e.g., preset overrides), it is easy to miss one entry point. The resolver abstraction prevents drift, but does not eliminate the redundant multi-step composition in each caller.

**Observation**: This is a consequence of the incremental evolution from manual-only → blacklist → three-state. Each layer was added without refactoring existing composition points. Not a blocker, but a candidate for consolidation: build one `DerivedToolState` snapshot that reads all sources once and exposes named predicates.

---

## Code organization and naming

### P2: `manual-tools.ts` file name contradicts its content

**Location**: `src/capability/manual-tools.ts:1-10`

```typescript
/**
 * Permission target parsing and matching.
 *
 * This module owns the user-visible target grammar (`tool`, `mcp://server`,
 * `namespace://name`) and the config-only prefix form (`foo*`). It grants
 * nothing and holds no policy: the permission domain decides which parsed
 * target wins.
 */
```

**Problem**: The file is named `manual-tools.ts`, suggesting it owns the legacy manual-authorization mechanism. In reality, it is a general-purpose parser for `ToolPermissionTarget` that supports four kinds (`tool`, `mcp`, `namespace`, `prefix`). "Manual" is a legacy concept that no longer governs this module's scope.

**Impact**: A developer searching for "where are permission targets parsed" will not intuitively check a file named `manual-tools.ts`. The name creates a false association with retired functionality.

**Fix**: Rename to `tool-permission-target.ts` or `permission-parser.ts`.

---

### P2: Redundant error-message extraction in 5+ locations

**Locations**: Multiple modules contain variants of:
```typescript
error instanceof Error ? error.message : String(error)
// or
error instanceof RpcRequestError ? { code, message } : { code: 'internal', message: String(error) }
```

**Instances**:
- `assembly.ts:50`
- `router.ts` (implicit via `errorBody`)
- `enable.ts:172`
- `tool-permission.ts:368`
- `native-runner.ts` (multiple)

**Fix**: Centralize as:
- `src/util/errors.ts`: `export function messageOf(error: unknown): string`
- `src/harness-rpc/error.ts`: `export function rpcErrorBody(error: unknown): RpcErrorBody`

Existing code already has `errorMessage` in `src/util.ts` (used by other modules); the RPC and permission modules did not reuse it.

---

### P3: `admission.ts` constructs active Set twice in 4 lines

**Location**: `src/capability/admission.ts:115-122`

```typescript
const pruned = prunedToolNames(branch);
const active = new Set(host.getActiveTools());
const tools = catalog?.tools ?? host.getAllTools();
// ...
const callable = new Set(pi.getActiveTools().filter((name) => admission.admits(name) && !lazyNames.has(name)));
```

**Problem**: `host.getActiveTools()` is called twice and converted to a `Set` twice within the same function. Although the array is small (<100 elements), the duplication is unnecessary and the function is called on every context projection.

**Fix**: Reuse the first `active` set for the second construction, or hoist `getActiveTools()` once.

---

## Test construction issues

### P1: Propagation tests simulate a different root than production

**Location**: `test/typed/capability-tool-permission-propagation.test.ts:50-90`

**Pattern**: Tests construct a `filteredRoot` catalog and a manual `refresh()` function that re-reads the root's enabled/disabled state and rebuilds the child's denial list:

```typescript
const filteredRoot: CapabilityToolCatalog = {
  getAllTools: () => rootApi.getAllTools().filter((tool) => !explicitlyDisabled(rootApi, rootBranch, tool.name)),
};
// ...
const refresh = () => {
  const disabled = rootApi.getAllTools().filter(t => explicitlyDisabled(rootApi, rootBranch, t.name)).map(t => t.name);
  setCapabilityParent(childApi, filteredRoot, disabled);
};
```

**Problem**: The actual `RootService` implementation (L635-676 in `root-service.ts`) uses a cached catalog proxy and computes denials via `createToolPermissionResolver` with both `disabled` and `enabled` checks. The test's `filteredRoot` only filters disabled tools; it does not deny enabled tools, which are root-only and must not propagate to children.

**Evidence**: A test that enables a tool at the root and asserts it remains allowed in the child would pass with this test harness, but fail with the real `RootService` because `RootService.#childDeniedNames` denies both disabled and enabled tools (L665).

**Impact**: The propagation test suite covers scope mechanics (inheritance, learned sets, denials) but does not validate that the production root correctly excludes managed tools from child catalogs. The tests pass while the real behavior differs.

**Fix**: Either use the actual `RootService` in the test (requires heavier setup), or align the test harness's denial logic with `#childDeniedNames`. At minimum, document that these are unit tests of the scope module and do not constitute integration verification of root/child boundaries.

---

### P1: Existing capability-admission benchmark is unmaintained and broken

**Location**: `scripts/capability-admission-bench.mjs:3-5`

```javascript
import { manualToolMatcher, NO_MANUAL_TOOLS } from '../src/capability/manual-tools.ts';
import { setCapabilityRootOnlyPolicy } from '../src/capability/scope.ts';
```

**Problem**: Both imports reference removed exports. Running the benchmark fails at module load:

```
SyntaxError: Named export 'manualToolMatcher' not found.
```

The benchmark's reference arm also models the retired manual-only policy, so even if it ran, it would not provide a valid comparison for current behavior.

**Impact**: The benchmark cannot serve as current performance evidence or as a regression detector. Its presence in the repository suggests it is maintained, but it is not.

**Options**:
1. Remove it (the new `inherited-creation-bench.mjs` replaces it for the measured creation path).
2. Rewrite it to measure the current permission resolver (replace `manualToolMatcher` with `createToolPermissionResolver` and measure its amortized cost over 1,000 tool queries).

---

### P2: New inherited-creation benchmark covers only one scenario

**Location**: `scripts/inherited-creation-bench.mjs`

**Scope**: Measures synchronous catalog construction during one `subagent.create` call with synthetic fixtures (500 turns, 250 tools). Reports CPU, memory and event-loop delay.

**Gaps** (acknowledged in the audit):
- Repeated subscriptions and unsubscriptions (P1 retention issue)
- Compaction pruning with large windows
- Tool permission queries via RPC
- Concurrent batch creation
- Post-disposal memory recovery

**Observation**: The benchmark is deliberately narrow and optional (`npm run bench:inherited`, not in CI). It establishes a bound for one known regression (catalog reconstruction), but passing it is not a substitute for addressing the other paths. The audit correctly notes this.

**Recommendation**: Retain the benchmark as a diagnostic tool. Do not claim it validates the entire change set's performance. Add inline comments stating its scope.

---

### P2: `capability-lazy-schemas.test.ts` and `capability-reachability.test.ts` use real SDK but no contract mapping

**Location**: `test/typed/capability-lazy-schemas.test.ts`, `test/typed/capability-reachability.test.ts`

**Pattern**: Both tests use `createTestSdk()` and exercise real tool registration, activation and projection, but they are not listed in `test/contracts.json`. Other typed tests covering similar behavior contracts (e.g., `capability-mcp-reconnect.test.ts`, `capability-native-exposure.test.ts`) have contract mappings.

**Problem**: The test-contract hook exists to discover when a documented behavior is not tested. These two files exercise real SDK behavior but have no associated contracts, so:
- A behavior documented in `docs/capability.md` or `docs/harness-configuration.md` will not trigger a hook warning if these tests are its only coverage.
- Conversely, if these tests fail, no contract mapping points to which specification they verify.

**Fix**: Add contract entries for lazy-schema projection and reachability checking. If the behaviors are not yet documented, mark them as `undocumented` in `contracts.json` with a note, following the pattern in `test/contracts.json:420-430`.

---

### P2: Permission query/set tests rely on string matching for skip reasons

**Location**: `test/typed/capability-tool-permission.test.ts:450-480`

**Pattern**:
```typescript
assert.strictEqual(result.skipped.length, 1);
assert(result.skipped[0]?.reason.includes('not registered'));
```

**Problem**: The test asserts on English text substrings rather than structured error codes or enums. If the wording changes (e.g., "not registered" → "registration not found"), the test fails despite correct behavior. The `ActivationSkipReason` type is a string union, not an enum, so there is no compile-time check.

**Impact**: Low (these are typed tests with good coverage), but the pattern makes refactoring skip-reason text more fragile than necessary.

**Suggestion**: Either assert on exact string equality (`strictEqual(reason, 'not_registered')`) using the union values, or introduce a structured skip-reason object with a `code` field.

---

### P3: Duplicate assertion helpers across multiple test files

**Pattern**: Several test files define local `assertToolStatus`, `assertPermission`, or `resolveAndCheck` helpers that perform similar multi-field comparisons:

- `capability-tool-permission.test.ts:80-95`
- `capability-reachability.test.ts:60-75`
- `harness-rpc-tool-info.test.ts:120-140`

**Problem**: Assertion logic is duplicated rather than shared. A change to the `ToolPermissionInfo` shape requires updating multiple files.

**Fix**: Extract shared helpers into `test/typed/support/permission-assertions.ts` (or similar). Not a blocker, but reduces maintenance cost.

---

## Boundary and external validation

### Acceptable: RPC input validation is appropriate for an external boundary

**Observation**: The audit mentions "`asRecord`, `requireString` or type predicates" as potential over-validation.

**Clarification**: The Harness RPC endpoint is a distinct transport from the native Pi RPC (stdin/stdout). Its frames arrive over Unix sockets or Named Pipes, decoded from newline-delimited JSON. It is an external boundary by definition.

The validation in `util.ts` (`requireString`, `requireStringArray`, etc.) is **not** redundant: it transforms untrusted `unknown` payloads into typed values, with structured error responses for malformed requests. This is appropriate for any RPC boundary.

**Conclusion**: The input guards are justified. The audit's boundary review should clarify this distinction rather than grouping them with internal type checks.

---

### Acceptable: `schema.ts` is a generation asset, not a runtime hotspot

**Location**: `src/harness-rpc/schema.ts` (837 lines of JSON Schema definitions)

**Observation**: The audit notes "schema.ts is used by generation and CI, not production dispatch."

**Clarification**: `schema.ts` is imported by `scripts/check-rpc-schema.mjs` and by the schema-validation CI workflow (`.github/workflows/harness-rpc-schema.yml`). It is **not** imported by `transport.ts`, `router.ts`, or any runtime code path.

The size is justified: it contains the complete JSON Schema for every RPC method's request and response, plus type derivations for TypeScript. Replacing it with TypeScript interfaces would remove the language-neutral schema asset that external clients (non-TS languages) depend on.

**Conclusion**: Not a bloat concern. The schema is a build-time artifact.

---

### Acceptable: Permission migration is an offline tool, not a runtime path

**Location**: `src/capability/permission-migration.ts`

**Observation**: The audit mentions "permission migration is invoked by an explicit offline script only."

**Clarification**: `permission-migration.ts` is imported only by `scripts/migrate-tool-permissions.mjs`, which users run once to convert legacy `blacklist.json` and manual-authorization records into canonical `capability-tool-permission` entries. The migration is **not** invoked during normal session startup or tool execution.

**Conclusion**: The migration code is maintenance tooling. Whether to keep it after all known branches have been migrated is a scope decision (keep for user support, or remove after a deprecation window). It is not part of the measured runtime paths.

---

## Disposition

This review identifies **four P0 issues** requiring immediate attention:

1. `discoveryRecords` O(n²) prune filtering
2. `createToolPermissionResolver` linear scan per tool
3. Propagation tests do not cover the actual `RootService` child-denial logic
4. Capability-admission benchmark is broken and unmaintainable

**P1 issues** (should be addressed before the next release):

5. `extractUsedToolsFromWindow` full scan with no early exit
6. Permission precedence algorithm duplicated three times
7. `#rootScope()` cache name misleads about computation cost

**P2+ issues** are technical debt that can be deferred to a consolidation pass.

The change set is not approved for merge in its current state. Address P0 items first. P1 items should be batched with the audit's own P1 findings (catalog reconstruction, legacy manual authority, permission effects inconsistency, subscription retention).

The Windows validation failures (14 failures, 18 skips) reported in the audit remain unresolved and are outside this review's scope.
