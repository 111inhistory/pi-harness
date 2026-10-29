# Capability discovery memory in the Prompt

Capability discovery is lazy, but selected capabilities must survive session
compaction and nested tool calls.

`src/capability/prompt.ts` projects a native `<capabilities>` system
section on the current session branch. The primary source of truth is the
canonical `capability-discovery` custom entry appended to the branch through
`pi.appendEntry` (defined in `src/capability/discovery-record.ts`).

## Durable branch storage

Every successful or partial discovery writes one `capability-discovery` entry
to the session branch:

- Nested calls: When an outer tool calls `ctx.executeTool("capability", ...)`,
  the inner discovery record writes directly to the branch. The record survives
  even when the calling outer tool drops or summarizes the inner `details`.
- Canonical entries are the only memory source. The projection does not read
  `toolResult.details` or reconstruct memory from older result messages.
- Visible results anchor updates by `toolCallId`. Discoveries outside visible
  context fold into the leading checkpoint.

## Contents

- Tools and MCP groups: refs, names, descriptions, exposure, shared instructions,
  and selected group members. Native declarations or selected result metadata
  provide argument schemas; branch records do not duplicate schemas.
- Skills: absolute entry paths, names, and descriptions. The host does not infer
  constraints or associations from Skill prose. A Skill ref is its entry path;
  the model uses native file read to understand the guidance.
  No resource protocol router or read/write override is installed.
- Shared guidance: retained across discoveries, even when a selection adds no tools.
- Remote coverage: discovery searches local resources only.
  Coverage explicitly marks remote search as `not_searched`. Remote candidates
  never enter branch records, system sections, or summaries.

Discovery memory never grants tool authority. The projection checks group members
against the current live tool registry on every model request. If the current
scope disallows a tool, the projection excludes that tool.

## Native discovery boundary

The paired `extensions/harness.ts` entry also installs the native discovery
boundary. It replaces the native MCP discovery surface, not its transport or
authentication. The paired entry disables native `tool_search`, global resource
listing, and default `<mcp_servers>` injection.

Codemode remains available for execution and composition. Its sandbox does not
register `searchTools`. `ALL_TOOLS`, `describeTool`, and `describeNamespace` see
only currently enabled, permitted tools. Nested calls still pass through Pi's
tool pipeline. Generic MCP resource reads also require a currently enabled,
permitted member of the selected server namespace.

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

## Regression coverage

- `test/capability-prompt.test.mjs`: checks immediate availability, request
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
  removal without user-text mutation, and worker admission after cancellation.
