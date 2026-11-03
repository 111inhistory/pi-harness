# Capability discovery memory in the Prompt

Capability discovery is lazy, but selected capabilities must survive session
compaction and nested tool calls.

`src/capability/prompt.ts` projects a native `<capabilities>` system
section on the current session branch. The primary source of truth is the
canonical `capability-discovery` custom entry appended to the branch through
`pi.appendEntry` (defined in `src/capability/discovery-record.ts`).

## Durable branch storage

Every successful or partial discovery writes one `capability-discovery` entry
to the session branch. User-driven enablement writes the same entry shape with
the `manual` category and no tool call anchor.

- Nested calls: When an outer tool calls `ctx.executeTool("capability", ...)`,
  the inner discovery record writes directly to the branch. The record survives
  even when the calling outer tool drops or summarizes the inner `details`.
- Canonical entries are the only memory source. The projection does not read
  `toolResult.details` or reconstruct memory from older result messages.
- Visible results anchor updates by `toolCallId`. Discoveries outside visible
  context fold into the leading checkpoint.
- Persist-before-activate: Capability appends the discovery record to the
  branch before calling synchronous tool activation.

## Contents

- Tools and MCP groups: refs, names, descriptions, exposure, shared instructions,
  and selected group members. Native declarations, Codemode interface queries,
  or fallback result metadata provide argument schemas; branch records do not
  duplicate schemas.
- Shared instructions: this section injects shared instructions. Capability tool-result
  text omits them, including fallback results, so the same guidance is not copied
  into both the tool result and its anchored memory section.
- Skills: absolute entry paths, names, and descriptions. The host does not infer
  constraints or associations from Skill prose. A Skill ref is its entry path;
  the model uses native file read to understand the guidance. The host installs
  no resource protocol router or file tool override.
- Manual entries: `/capability enable` records the tools it actually activated
  under the `manual` category. A manual record carries no tool call anchor, so
  the projection folds it into the leading checkpoint. Manual and discovered
  entries share one ref namespace and the same permission check.
- Manual-only tools: `capability.manualTools` names tools that discovery must not
  see. They are excluded from the eligible catalog used by search and by
  discovery activation, and the scope view drops them from every node below the
  root, so a child cannot inherit one. The user command opts back in with
  `includeManual`; execution then follows the normal active-tool guard.
- Manual authorization: the `manual` record is the authority, not the active
  set. `before_agent_start` removes a manual tool that is active without a record
  (`defaultActive`, a restored transcript, another extension), `tool_call`
  refuses it, and Codemode admission applies the same predicate. The request
  projection resolves the execution view, so an enabled manual entry appears in
  Main's section and is still filtered out for a child scope.
- Shared guidance: retained across discoveries, even when a selection adds no tools.
- Remote coverage: discovery searches local resources only.
  Coverage explicitly marks remote search as `not_searched`. Remote candidates
  never enter branch records, system sections, or summaries.

Discovery memory never grants tool authority. The projection checks group members
against the current live tool registry on every model request. If the current
scope disallows a tool, the projection excludes that tool.

## Native discovery boundary

The paired `extensions/harness.ts` entry installs the native discovery
boundary. It replaces the native MCP discovery surface, not its transport or
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

The `context_with_system` hook runs before every model request, not only at
`before_agent_start`. Each visible Capability result anchors a section update
immediately after that result. Repeated identical selections emit no redundant
patch. Previously sent messages stay unchanged as new discoveries arrive.

Discoveries compacted out of the visible history fold into the leading system
checkpoint in the request projection. Pi's stored checkpoint need not
store the section; the projection rebuilds it from raw branch records on every
request. This covers reloads, repeated compaction, branch changes, and inherited
sessions. An isolated retrieval session applies the same projection to its
inherited snapshot.

The section is model-facing request state; `ctx.getSystemPrompt()` and the raw
session checkpoint do not contain this projection.

On compatible Responses models, native system section patches remain at their
historical positions to preserve the wire prefix. Providers without
mid-conversation system-message support fold sections through Pi's normal
conversion path. This feature prevents an additional cache invalidation during
normal discovery updates, but does not alter cache invalidation caused by
compaction itself.

## Unresolved SDK allowlist discrepancy

Under SDK `1.4.0`, a strict tool allowlist can retain MCP registration while
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
