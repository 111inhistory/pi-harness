# Shared provider and inherited-context design

## Status and scope

This document records the agreed architecture and tradeoffs before implementation. It is a design, not a description of delivered behavior. Current contracts remain in [interface-contract.md](../interface-contract.md); current ownership remains in [architecture.md](../architecture.md).

Capability and Subagent share one provider adaptation layer and one inherited-context assembly path. This iteration covers Responses and Anthropic Messages. Chat Completions adaptation is deferred. Provider adapters reuse Pi's native request conversion, authentication and streaming; they do not introduce another HTTP client or provider catalog.

The implementation must preserve the existing uncommitted enable rewrite, manual authorization, native MCP reconnect behavior, lifecycle fences and unrelated proposals. No merge, commit, gateway restart or plugin/configuration replacement is part of this design.

## Agreed decisions

| Area | Decision | Tradeoff |
| --- | --- | --- |
| Local identity | Every child retains its own native session ID, storage and IPC identity. | Cache reuse must not depend on replacing a child's local identity with its parent's. |
| Cache identity | An inherited branch carries its parent's effective outbound cache key. A fresh branch starts with its own key. | Related branches can reuse a prefix; this does not guarantee a hit or repair differences in tools, effort or rendered context. |
| Provider ownership | Capability and Subagent consume the same provider policy and request integration. | Provider conditions leave business orchestration; adapters still require concrete capability declarations. |
| Transcript ownership | Captured history, appended instructions and tool declarations have separate explicit inputs. | Callers can no longer rely on changing a live tool set to implicitly rewrite inherited instructions. |
| Tool authority | Registration, model declaration and execution admission remain separate. | A retained declaration may describe a tool the child cannot execute. Admission remains authoritative. |
| Tool removal | Do not implement tool removal in this iteration. Do not emit removal events or add a removal API. | Old declarations may remain visible and occupy context. Removal after compaction is a possible future design, not an implemented policy. |
| Capability pseudo-removal | Continue retaining inherited declarations while blocking their execution through the tool-call hook and explaining the restriction in appended instructions. | The model can still attempt a blocked call. The hook must reject it; soft instructions alone are insufficient. |
| Explicit cache controls | Do not add cache breakpoints, prewarming, TTL settings or explicit-only cache mode in this iteration. | Shared keys and preserved prefixes improve current behavior without depending on unverified Codex breakpoint support. |
| Protocol scope | Implement Responses and Anthropic Messages; defer Chat Completions-specific tool extensions. | No universal promise of append-only tool transport for other APIs. |
| Thinking level | Inherit the parent's requested thinking level independently of tool-transport support. | Model-native clamping may still apply. Lack of additive tools must not force a child to low. |

## Module boundaries and interfaces

The following are semantic contracts. Exact TypeScript names and file layout will be finalized before parallel implementation; existing APIs should be reused where they already express the contract.

### Inherited-context capture

The capture module owns the native branch snapshot, resolved physical model, thinking level, system context, tool snapshot and outbound cache identity. It removes unresolved spawning calls using the existing native-history rules. It does not encode provider requests, activate tools or apply Capability discovery projection.

A tool snapshot distinguishes declarations carried by the native transcript from the current executable loadout. It retains declaration order and historical schema changes. Capturing a branch must not resolve every historical declaration to the latest registry schema and rewrite the past.

A child receives a new local session ID. The inherited cache identity must survive nested inheritance and durable continuation. Existing root/branch navigation and generation ownership rules still apply; an old callback must not install identity into a replacement root. Persisted cache identity must contain no credentials or provider account identifiers. Do not add a second session-state store merely for caching.

The effective cache key must respect existing request behavior, including supported upstream overrides and disabled caching. Do not infer a parent's effective key solely from its current local ID when the session already inherited or overrode its cache identity. A cache key may remain stable across a model change, but reuse is not promised across models, accounts or endpoints.

### Context assembly and projection

Assembly receives an inherited prefix and explicit additions. New child instructions and tool definitions are appended at their intended transcript position. Supported transports must not move those additions into the initial system message or initial tool inventory.

Capability owns discovery-memory projection and search instructions. Subagent owns task, role and communication instructions. Both call the same assembly primitives. Provider support is not decided inside Capability memory projection.

Normal inherited branching and post-compaction reconstruction are distinct cases. This iteration must not introduce tool removal during compaction or treat compaction as permission to discard authorization. Existing branch memory and manual-tool isolation remain intact.

### Tool operations and execution admission

Tool operations have three separate responsibilities:

1. Register a local executable implementation through Pi's registry.
2. Apply the permitted executable loadout through existing activation/admission rules.
3. Record newly available model declarations at the context tail through Pi's transcript representation.

One caller may orchestrate all three, but no operation should implicitly grant authority merely because a tool schema is present. Reuse the existing activation implementation for discovery, explicit enable, cross-session reply activation and explicit connect authorization.

This iteration supports tool additions and necessary same-name declaration updates. It does not add tool removal. If an inherited capability retrieval session cannot execute a historical tool, its declaration remains historical context and its call is blocked.

The capability retrieval execution allowlist contains only the internal retrieval tools, currently `capability_step`. The tool-call hook enforces this independently of prompt text. Inherited placeholders must never call parent execute handles. Existing tests must cover direct calls and nested execution paths so a retained declaration cannot become an execution bypass.

Tool usage guidance has a separate placement contract. Subagent namespace instructions contain only stable shared guidance. Tool descriptions describe purpose, behavior and results; they must not absorb the complete guideline body. Tool-specific guidance, including create-only requirements, is appended at the tool's activation/declaration position through the context layer. Enabling create after list must not change the earlier namespace instructions. Repeated enablement must not duplicate guidance. Replay and recovery must retain the original placement; compaction reconstruction must preserve applicable guidance without implementing removal. Do not restore owned `promptSnippet`/`promptGuidelines` metadata merely to let Pi patch the leading tools/rules sections. Verify namespace instruction serialization in each native provider; local namespace metadata alone is not evidence that the model received the guidance.

Manual-only tools remain excluded from child eligibility under the current contract. Prefix preservation must not copy prohibited interfaces or bypass the existing manualTools boundary. Capability selection is not a manual grant. Ordinary incoming peer messages do not manufacture manual authorization; an explicit connect command can use the ordinary user-grant path for `msg_write`.

### Shared provider adaptation

Provider adaptation consumes the concrete model capabilities, context additions, declaration operations and outbound cache identity. It translates these intentions through supported Pi APIs and hooks. It does not choose search results, routing roles or tool permissions.

For Responses, use native mid-conversation system messages and `additional_tools` when the exact model declares support. Keep `supportsAdditionalTools` and `supportsToolSearch` distinct. Shared cache identity changes the outbound cache key without replacing local session identity. Magpie's mapping from a body key to Codex wire headers is a deployment behavior, not a reason to hard-code Magpie account logic into the Harness.

For Anthropic Messages, use native mid-conversation system messages and inline tool additions when the exact transport declares support. Reuse Pi's beta-header handling and tool conversion. Preserve existing native cache-control behavior; do not add a new breakpoint policy. Do not implement or emit `tool_removal` in this iteration even though the provider supports it.

For other transports or models without declared additive support, keep an explicit non-additive path and report its cache limitation. Do not guess support from a model name, silently enable compat flags or implement the deferred Chat Completions extension as part of this work.

The adapter should use the existing payload hook or equivalent supported request seam. Verify that the seam executes for both ordinary child sessions and Capability's internal sessions. Compose with existing hooks rather than replacing them, and restore any session-local wrapper on cleanup. Keep exact wire conversion in Pi.

### Business orchestration

Capability captures context, starts a retrieval session through the shared execution lifetime, validates selections and activates actual tools through the existing tool API. It must not own provider request encoding, cache identity generation or a thinking-level fallback tied to additive support.

Subagent owns fresh/inherited task routing, budgets, tree identity, IPC and continuation. It passes an assembled session request into the shared child execution path. Capability does not become a publicly registered Subagent merely because it reuses that path.

Cross-session connect resolves a live peer, appends contact context and activates `msg_write` through existing rules. It does not gain a separate provider adapter, remote greeting, authorization service or connection state machine.

## Evidence and limits

Official [OpenAI prompt-caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching) illustrates a stable key across one user's sessions and forks. It also distinguishes a shared prefix from an eligible cached prefix. This supports the chosen direction but is not a cache-hit guarantee for a subscription proxy.

Controlled online probes used only Luna through Magpie and pinned one account. Distinct local session IDs with a shared outbound key reused most of the inherited prefix. Two trials with three inherited parent exchanges and three interleaved rounds per branch retained roughly 98–99 percent cached input for the shared-key child and parent. Independent-key children sometimes read a partial prefix and sometimes missed. These observations do not establish the backend's internal isolation or eviction algorithm.

The probes held effort and tool declarations fixed and did not execute the real Harness lifecycle. They do not prove the historical main-session miss cause. Do not claim every independent key misses or every shared key hits.

Magpie's inspected Codex preparation removes top-level `prompt_cache_options`; content-level breakpoint handling by the upstream is unverified. Explicit cache controls are deferred for this iteration. Official Codex credit billing has no separate cache-write surcharge, while cached input still has a credit rate; API pricing and subscription usage are different contracts.

No real Anthropic inference is authorized for this iteration. Anthropic verification uses real SDK serialization against an offline fixture; any live Anthropic endpoint remains untested. Further online probes are restricted to the explicit Luna route and must not use auto/group aliases that can select another model.

## Acceptance and delivery

- Real SDK request capture must show separate local session IDs and shared inherited cache identity, including nested inheritance and durable continuation.
- Shared adapters must be exercised through both Capability and Subagent call sites, not just helper-unit tests.
- Responses and Anthropic request captures must preserve inherited prompt and tool prefixes under supported additive capabilities and append only the intended new instructions/declarations.
- Capability must retain its execution restriction: inherited tools are soft-disabled in appended instructions and rejected by the tool-call hook. No parent execute handle is transferred.
- Tool registration, activation and declaration tests must cover additions, same-name updates, MCP reconnect and manual authorization. This iteration must introduce no removal API or removal events.
- Thinking level must not be lowered merely because additive tools are unavailable. Native provider constraints remain observable.
- Fresh children must not accidentally inherit a parent's cache identity. Branch switches, compaction, cleanup and model changes must not cause identity leakage between unrelated sessions.
- Deferred or unsupported transports must not be presented as verified append-only implementations.
- Code delivery requires `npm run check`, with JSON/docs checks for changed assets. Online results must be reported separately from offline tests; Windows and real Anthropic inference must be marked untested when not exercised.
- Keep existing work uncommitted. Do not merge to the main branch or clean branches without a user request. Integrate the pending connect work only after its shared activation and context contracts are reconciled with this design and the cache acceptance gate is satisfied.

## Implementation ownership

The lead agent owns interface contracts, module boundaries, integration and final review. The architecture is implemented incrementally: define only the contracts needed for the first end-to-end slice, let executors identify concrete missing inputs or ownership gaps, and extend the contracts centrally as those gaps are demonstrated. Do not require a complete future framework before implementation or add speculative extension points.

The first slice connects inherited cache identity, a tool/context snapshot, append-only child additions and the existing SDK execution entry for Responses and Anthropic. Persistence, call-site details and hook composition may reveal additional contract requirements; the lead resolves those requirements with affected executors before they independently add overlapping state.

Implementation may be delegated only after assigning non-overlapping file ownership or isolated worktrees. Workers must use the shared contracts rather than independently inventing provider flags, authorization state or persistence formats. Public architecture and interface documents should be updated to the final delivered implementation, not copied from this proposal before code exists.
