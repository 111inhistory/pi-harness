# Proposal: An independent external orchestrator with a lightweight Pi

Status: proposal for a separate project, not a current pi-harness interface contract or an implementation task in this repository. This replaces the earlier idea of implementing the session-management and cron suite inside the Harness. Presets remain [postponed](agent-presets-proposal.md). Ordinary Agent discovery and communication remain [a separate Harness proposal](agent-discovery-communication-proposal.md).

## Decision and goal

External orchestration should live in an independent project. That project may embed a lightweight Pi session as its reasoning and dialogue engine. Using Pi for decisions does not imply making Pi's extension runtime the owner of orchestration.

The project manages a set of independent Pi executions, observes progress and arranges later checks. It does not initially need a workflow DAG, a web platform, a generic scheduler service or a preset system.

## Responsibility ownership

| Responsibility | Owner |
| --- | --- |
| Managed Pi process handles, launch and continuation | External orchestrator runtime |
| Session discovery, management scope and native-history lookup | External orchestrator runtime |
| JSONL slicing, preprocessing and output budgets | External orchestrator runtime |
| Schedules, pending wake-ups, cancellation and management state | External orchestrator runtime |
| Interpretation of evidence, coordination and intervention decisions | Lightweight Pi inside the orchestrator |
| Actual model/tool execution inside a worker | The target worker Pi and its SDK |
| Native interruption of the worker's current run | A minimal target-side control operation |
| Ordinary peer messages and bounded Agent discovery | Existing/thin Harness integration |
| Native session identity, name and conversation history | Pi's native session mechanism |

The lightweight Pi is a collaborator of the external runtime. It must not be the sole in-memory owner of timers or process handles. A model turn ending, context compaction or changing its dialogue branch must not silently destroy management state.

An independent project does not require a separate scheduling daemon: one local process can own the orchestration runtime and host a Pi SDK session. Separate processes/services are justified only by an actual deployment or availability requirement.

## Minimal structure

```text
User / external events / scheduled deadlines
                  |
       External orchestrator runtime
       - managed Pi handles and native session lookup
       - bounded observation and management operations
       - schedules and delivery bookkeeping
                  |
       Lightweight Pi SDK session
       - receives goals and observations
       - reasons about progress and blockers
       - calls the runtime's tools
                  |
       Worker Pi sessions via existing IPC / thin control adapters
```

The runtime supplies facts and effects; the embedded Pi supplies decisions. Do not put a hidden autonomous planner in the runtime or let a timer directly decide that a worker must restart.

## Tool surface belongs to the external project

The discussed names can remain useful without becoming Harness-owned tools:

| Tool | Meaning |
| --- | --- |
| `session_list` | List live and resumable native sessions within the configured management scope. |
| `session_poll` | Return an explicitly bounded, preprocessed slice of recorded JSONL; not a live-state oracle. |
| `session_stop` | Request interruption of a live target's current run; leave its process and child Jobs intact. |
| `session_create` | Start a new managed Pi execution in an explicit cwd with a task and instructions. Deferred. |
| `session_resume` | Continue identified native history without silently creating a new identity. Deferred. |
| `session_connect` | Arrange peer contact and respective collaboration responsibilities. Deferred. |
| `session_rename` | Change the target's native name through a real host operation. Deferred. |
| Cron capability | Arrange, list and cancel future observations/wake-ups. Deferred. |

The initial tool subset and launch interface are separate-project implementation decisions. The discussion has not authorized implementing all rows at once.

The external runtime can expose these operations directly as tools to its embedded Pi. An MCP adapter can later let another explicitly authorized Pi use them; it is not required merely to connect an embedded Pi to its own host.

When exposed to ordinary Pi clients, management tools remain manual and distinct from ordinary discovery/message tools. In the embedded Pi, the user explicitly starts an orchestrator with a displayed management scope and tool set. Loading project text or receiving a worker message cannot silently broaden that scope.

## Lightweight Pi

Start with a normal Pi SDK session and explicit instructions, current model settings and a small management tool loadout. Keep its native conversation for reasoning and audit. No predefined-preset catalog, `/preset` command, Seed compiler or special profile engine is needed.

A default coordination instance need not load repository-editing tools or unrelated MCP backends, because the runtime already owns the required observations and management effects. This is a minimal default, not a universal claim that an orchestrator must never edit or implement.

The host must distinguish active tool declarations from execution restrictions. A small active set is not an OS sandbox or an authorization engine. Current management scope and tool authority remain host-checked at the point of action.

Future model/profile selection can reuse Pi mechanisms; it does not decide process ownership or schedule lifetime. See the separate deferred preset research rather than adding it to the first implementation.

## Observations and interruption

Preserve the bounded poll decisions from discussion:

- `session_poll` reads recorded content; full history is not the default.
- A practical starting budget is 20 returned content events, at most 100 when requested, 1 MiB scanned, 4 KiB per text entry and 32 KiB total output. These are initial budgets, not performance promises or a new configuration framework.
- Define the default scope as `journal_tail`, not the current runtime branch. Native `branch()` can move an in-memory leaf without appending; an external file reader cannot infer that active leaf reliably.
- Preserve event identity/parent relation when a slice may span branches; do not present different branches as one conversation.
- Exclude thinking, system/configuration metadata and tool arguments by default. Tool results have bounded status/text summaries.
- Mark limited observation honestly. Missing results in a window do not prove a tool is running or absent.
- Do not derive `idle` or queued-message state from JSONL. A separate live host snapshot, if needed, requires the target's actual facts.
- Read files without repairing them. Ignore an incomplete trailing line, retain a bounded snapshot size and do not chase continuous appends.
- Non-live resumable sessions may be observed without starting them. Full history and incremental cursor APIs are deferred.

`session_stop` requires a thin worker-side abort operation. Killing a Pi process is not equivalent to stopping its current run. Reuse the native abort path, including cooperative cancellation of in-flight model/tool work; do not clear queued messages, terminate the Pi process or issue stop to child Jobs. Already applied tool effects are not undone.

A request receipt is not proof the run has exited. Reuse existing local IPC ownership and unknown-delivery rules. No blind replay after an uncertain stop. Do not generalize this minimal endpoint into a remote administration framework.

## Scheduling, when implemented

Schedules belong to the external runtime, not RootService, a worker's branch or the model's pending tool call. A deadline creates a host event for the lightweight Pi, which then observes and decides what to do.

Required boundaries:

- No model `while + sleep` loop just to wait.
- At most one pending wake-up per recurring task; skip missed ticks rather than producing catch-up bursts.
- A busy or temporarily unavailable reasoning session does not create an unbounded queue.
- Cancellation stops future ticks without claiming to retract accepted events.
- A timer cannot automatically stop/restart a worker merely because time elapsed.
- Model-session reset and runtime shutdown are different lifecycles. Task ownership must be explicit, not inherited accidentally from a Pi generation.

An independent runtime can support durable schedules if restart-survival is an actual requirement. It does not make persistence free: storage, missed deadlines and target revalidation still require a contract. Choose those deliberately; do not assume an in-memory timer survives the project process exiting.

## Human commands and interaction

Human management commands belong to the independent project's CLI/TUI or its embedded Pi command layer, not automatically to the worker Harness:

| Proposed entry | Behavior |
| --- | --- |
| `/session` / `/session list [filter]` | Browse the scoped live+resumable list; group by lifecycle facts and filter in place. |
| `/session poll [id]` | Select a target if omitted and show one bounded recorded-content slice with scope and truncation information. No hidden refresh loop. |
| `/session stop [id]` | Select a permitted live target, then explicitly choose “stop current run”; highlighting alone has no effect. |
| Create/resume/connect/rename entries | Deferred with the corresponding operations; no empty UI shell is required now. |
| Cron entries | Deferred with scheduling; when implemented, expose list/cancel without requiring a model turn. |

Use native Pi controls when the embedded Pi owns the interaction. Do not build another UI framework. Preserve exact-ID shortcuts, keyboard completion, focus/IME, cancellation without side effects, long-list scrolling and narrow-width handling. Non-TUI clients need explicit arguments or clear unsupported-interaction feedback; never choose a target for them.

The ordinary Harness retains `/agent` discovery and child-only `/subagent` operations as described in the companion proposal. Migrating the old `/subagent sessions` entry must wait until the replacement is actually available; remove rather than keep a redundant alias at that point. The standalone runtime does not depend on automatic command-name candidate expansion in Pi's editor.

Direct human management actions do not silently enable their corresponding tools in a worker or broaden the embedded Agent's configured scope.

## Harness boundary

This repository explicitly excludes an external scheduling service from its product scope. The independent project is the correct owner of that responsibility. Do not move its process registry, history scanner, management queue or cron into Harness modules for convenience.

The Harness may provide ordinary messages and the minimal host operation required for native interruption. Existing session directory and native metadata are reusable integration points, not mandates to duplicate them externally. An optional live status adapter must report facts without asking a model to answer.

The contact-based `agent_list` proposal remains independent. Ordinary peers do not gain management tools, and a management-wide session list does not become their discovery source.

## Evidence and reusable ideas

| Evidence | What survives |
| --- | --- |
| User chooses an independent orchestration project with a lightweight Pi | Runtime owns orchestration; Pi can still supply reasoning. |
| Current repository's scope excludes an external scheduling service | Keep implementation and lifecycle outside the worker Harness. |
| Existing Pi SDK, IPC and native session storage | Reuse identity, history, model execution, UI and interruption rather than cloning the Harness. |
| Abandoned Work experiment | Stable identity and observation separate from execution are useful; TODO/Branch/focus/Desc machinery stays abandoned. |
| Preset/Seed investigation | Preserve as deferred research; it is not a prerequisite for a lightweight Pi. |
| Native `branch()` and append-only histories | A file tail is not necessarily the active runtime branch; observation must state its scope. |

## Razor decisions and acceptance

Principle: every concept must protect an actual goal or needed distinction. This proposal covers ownership and minimal local orchestration, not a general workflow platform or OS isolation.

| Concept | Verdict | Reason |
| --- | --- | --- |
| Independent orchestration runtime | Keep | Process/schedule ownership must outlive individual model turns and worker contexts. |
| Embedded lightweight Pi | Keep | Reuses a mature reasoning/tool/UI engine without making it the management-state owner. |
| Separate daemon/service split | Defer | One local runtime can initially host the Pi SDK session. |
| Worker-side abort adapter | Keep | Only the worker can implement native current-run interruption accurately. |
| Harness-owned process manager / cron | Replace | The responsibility is real, but belongs to the independent project. |
| Work workflow engine | Delete | Its planning value does not justify another task/execution model. |
| Preset/Seed implementation | Defer | Explicitly postponed; current functionality does not depend on it. |
| Durable schedules / live-process adoption | Prove first | Their ownership/recovery cost requires a concrete requirement. |

Acceptance must exercise real Pi workers, local IPC and an embedded SDK session, not only mocked handlers. Prove that recorded observation is bounded and branch-honest; stop leaves the process and child Jobs intact; management scope is enforced; ordinary messages do not grant management authority; human list/selection/cancel flows work in a real terminal; and resetting the reasoning dialogue does not implicitly lose external process handles or schedule definitions.

Before implementation, settle the independent project's minimal launch mode, management scope and the initial observation/control subset. Runtime persistence and future scheduling must be stated as supported or unsupported, not hidden behind “lightweight.”
