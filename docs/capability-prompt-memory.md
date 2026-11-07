# Capability discovery memory in the Prompt

Capability discovery is lazy, but selected capabilities must survive session
compaction and nested tool calls.

`src/capability/prompt.ts` projects a native `<capabilities>` system
section on the current session branch. Canonical `capability-discovery` entries
own discovery facts; `harness-capability-memory` records preserve the section
versions and placements already emitted to the model. Both follow the native
branch. `src/prompt-section-journal.ts` owns shared placement replay.

## Durable branch storage

Every successful or partial discovery writes one `capability-discovery` entry
to the session branch. User authorization records use the same entry shape with
the `manual` category and no tool call anchor; `/capability enable` writes them
after the shared activation call reports the tool active.

- Nested calls: When an outer tool calls `ctx.executeTool("capability", ...)`,
  the inner discovery record writes directly to the branch. The record survives
  even when the calling outer tool drops or summarizes the inner `details`.
- Canonical entries are the only memory source. The projection does not read
  `toolResult.details` or reconstruct memory from older result messages.
- The initial projection can anchor visible results by `toolCallId` and fold
  older discoveries into its checkpoint. Once recorded, every later discovery
  appends a section update, including a nested result absent from model history.
- Persist-before-activate: Capability appends the discovery record to the
  branch before calling synchronous tool activation.

## Contents

- Tools and MCP groups: refs, names, descriptions, exposure, shared instructions,
  and selected group members. Native declarations, Codemode interface queries,
  or fallback result metadata provide argument schemas; branch records do not
  duplicate schemas.
- Shared instructions: every declared namespace can emit its current instructions
  through a native guidance section, including MCP and namespaces enabled directly
  by the user. Capability memory omits this prose only when that producer actually
  emitted it. Otherwise memory retains the instructions, including when direct
  declarations are hidden. Tool-result text omits the shared prose in both cases.
- Skills: absolute entry paths, names, and descriptions. The host does not infer
  constraints or associations from Skill prose. A Skill ref is its entry path;
  the model uses native file read to understand the guidance. The host installs
  no resource protocol router or file tool override.
- Manual entries are branch authority, not request state. A `manual` record is
  never projected: the tool it authorizes is declared by the native tool list,
  so a `<capabilities>` entry would repeat the interface and change the leading
  system prompt. Manual and discovered entries share one ref namespace and the
  same permission check, but only discovery contributes section text.
  See [the cache boundary](reviews/capability-enable-cache.md).
- Manual-only tools: `capability.manualTools` names tools that discovery must not
  see. They are excluded from the eligible catalog used by search and by
  discovery activation, and the scope view drops them from every node below the
  root, so a child cannot inherit one. Catalog browsing includes manual tools
  without granting authorization; execution follows the normal active-tool guard.
- Manual authorization: the `manual` record is the authority, not the active
  set. `before_agent_start` removes a manual tool that is active without a record
  (`defaultActive`, a restored transcript, another extension), `tool_call`
  refuses it, and Codemode admission applies the same predicate. A receipt of a
  cross-session message activates `msg_write` under the same rules but writes no
  record, so a receipt never manufactures a user grant.
- Shared guidance: retained across discoveries, even when a selection adds no tools.
- Remote coverage: discovery searches local resources only.
  Coverage explicitly marks remote search as `not_searched`. Remote candidates
  never enter branch records, system sections, or summaries.

Discovery memory never grants tool authority. The latest section state checks
group members against the current live registry and scope on every request.
Earlier emitted versions keep their original text and placement; an unavailable
member is removed by a later state update. Native declaration and execution
checks remain authoritative.

## Native discovery boundary

The `extensions/capability.ts` entry installs the native discovery
boundary and MCP execution backend. It replaces the native MCP discovery surface, not its transport or
authentication. The paired entry disables native `tool_search`, global resource
listing, and default `<mcp_servers>` injection.

Codemode remains available for execution and composition. Its sandbox does not
register `searchTools`. `ALL_TOOLS`, `describeTool`, and `describeNamespace` see
only currently enabled, permitted tools. `ALL_TOOLS` carries short descriptions;
`describeTool` returns the full interface when requested. A sandbox keeps the tool
snapshot captured at its start, so newly activated tools require a new Codemode
call. Catalog queries do not wait for MCP backends; the host adds no active MCP
reconnection. Actual nested calls still pass through Pi's tool pipeline. Generic
MCP resource reads require a currently enabled, permitted member of the selected
server namespace.

Old native Codemode declarations can embed a catalog in their description. The
request projection replaces those descriptions with the safe registered
Codemode description. This migration removes native metadata from the request;
it does not rewrite user text or stored history. It can invalidate an old cache
prefix. Normal discovery updates retain the prefix behavior described below.

## Timing and cache behavior

The `context_with_system` hook runs before every model request. On first use,
existing discovery facts initialize the journal at their visible anchors or the
leading checkpoint. Even an empty initial state is recorded without changing the
prompt. Every later discovery, live namespace instruction change, or withdrawal
appends a system update after the current last message. It never rewrites the
older checkpoint when a nested result is invisible. Identical state appends no
update.

The shared journal records the exact emitted text and fixed placement. Later
turns and reloads replay those versions between their original neighbors. The
current registry cannot supply historical versions of namespace instructions, so
new live namespace guidance is first delivered at the tail; static asset guidance
can initialize at its first declaration. Later asset changes are tail updates.
Clearing guidance appends a native section removal and retains its history.
Native compaction or explicit context editing creates a new context boundary;
the latest recorded state initializes that boundary once.

The section is request state; `ctx.getSystemPrompt()` and the raw native
checkpoint do not contain these projected updates. Journal entries belong to the
branch and survive rewind and inheritance. Main and the isolated retrieval
session use the same projection. `/btw` replays the inherited emitted sections
inside its own memory session. User enablement records remain authority only;
the namespace's guidance is separate from that authorization.

Compatible Responses and Anthropic models preserve incremental system updates
through native serialization. Other transports retain their native conversion,
including system folding when required. Native `ToolDefinition.promptGuidelines`
remain SDK-owned: the SDK diffs the replayed sections against current definitions
and appends changed sections, including after resume. This journal adds no copy
of those native rules. Prefix preservation does not itself guarantee a cache hit.

## Unresolved SDK allowlist discrepancy

Under SDK `1.5.0`, a strict tool allowlist can retain MCP registration while
rejecting activation of members that do not match it. The absence of hidden
`tool_search` alone does not predict failure: an allowlist that matches the MCP
member names can still permit activation.

Capability writes the canonical branch record before it activates tools. The host
filters public results by the actual active set, but the earlier record can retain
unactivated members. Later request projections can advertise those members again.
An activation exception can leave the same discrepancy.

This is an unresolved defect in the requirement to accumulate successfully obtained
capabilities, not a policy that permits failed activation to count as success.
The record does not grant execution permission. Conditions and recovery options
are in [known issues](known-issues.md#严格工具-allowlist-下的激活记忆不一致).

## Regression coverage

- `test/typed/capability-prompt.test.ts`: checks immediate availability, request
  immutability, idempotence, deduplication, shared guidance updates, native and
  repeated compaction, raw-entry restoration, branch isolation, and Responses
  prefix preservation.
- `test/typed/capability-guidance-journal.test.ts`: checks ordinary namespace,
  MCP, live instruction revisions, hidden discoveries, direct enablement,
  withdrawal, scope updates and resume against Responses and Anthropic wire.
- `test/typed/prompt-section-journal.test.ts` and
  `test/typed/tool-guidance-record.test.ts`: check shared ordering, fixed
  placement, domain isolation, boundary rebasing and malformed-record errors.
- `test/typed/capability-record.test.ts`: checks record normalization, exclusion
  of argument schemas, branch serialization, and coverage reporting.
- `test/typed/capability-nested.test.ts`: checks that nested tool calls retain
  discovered capabilities on the branch when outer tools omit inner results.
- `test/typed/capability-native-discovery.test.ts`: checks native entry replacement,
  selected MCP execution, scoped Codemode helpers, resource-read permissions,
  and late server registration in both extension load orders.
- `test/typed/capability-codemode-boundary.test.ts`: checks historical catalog
  removal without user-text mutation, slim catalogs, full explicit interface
  queries, sandbox snapshots, and worker admission after cancellation.
- `test/typed/capability-feedback-sdk.test.ts`: checks complete, compact feedback
  in real SDK model requests and full namespace selection after ref-only repeats.
- `test/typed/capability-allowlist-mask.test.ts`: reproduces the unresolved SDK
  allowlist case where activation fails after the host writes the selection record.
- `test/typed/capability-main-default-activation.test.ts`: checks that Main starts
  without `msg_write` and Capability activates the Subagent namespace.
- `test/typed/capability-enable.test.ts`: checks command parsing, live-registry
  target resolution, activate-then-record order, per-target refusals, idempotence,
  record-write failure reporting, the picker and its cancellation, and completion.
- `test/typed/capability-provider-prefix.test.ts`: checks at the provider
  boundary that an enable appends instead of rewriting, that the projection
  contributes nothing, and measures Pi's own prompt-section patch.
- `test/typed/capability-mcp-reconnect.test.ts`: checks that a tool registered by
  native `/mcp reconnect` is browsable and enableable, that a withdrawn
  registration is refused, and that `manualTools` still governs new registrations.
- `test/typed/cross-session-reply-activation.test.ts`: checks that a receipt
  activates only `msg_write`, that the reply is delivered, that no grant is
  written, and that repeated receipts are idempotent.
