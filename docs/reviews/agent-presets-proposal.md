# Deferred proposal: Agent presets and Seed sessions

Status: postponed by the user. This is research and a future design candidate, not a current interface contract or implementation task. The necessary session operations and cron work are defined independently in [the orchestration proposal](session-orchestration-proposal.md); ordinary peer discovery is defined in [the communication proposal](agent-discovery-communication-proposal.md).

## Scope boundary

Do not implement preset files, a role-template catalog, a preset selector, hot profile switching, Seed generation or a Seed compiler as part of session orchestration. New sessions can start from explicit cwd, task, native name and additional instructions, using existing Pi model and resource configuration. Manual tools remain enabled through the current capability path. Neither session creation nor scheduling depends on this proposal.

When this work is resumed, settle the configuration representation and authorization behavior before implementation. The details below preserve the prior discussion; they do not reverse the postponement.

## Composition

A preset combines a predefined role prompt, model/thinking configuration and an intended tool loadout. A conceptual definition is:

```json
{
  "name":"orchestrator",
  "role":"coordinator",
  "enableTools":[
    "agent_list","msg_write",
    "session_create","session_resume","session_list",
    "session_connect","session_poll","session_stop","cron"
  ]
}
```

This is a candidate composition example, not a final file schema or a claim that these tools are implemented.

The role prompt states responsibility, working method and authority boundaries. The current task remains separate. An orchestrator need not universally be a reviewer or read-only actor; a default preset may omit editing tools, but that is a role choice rather than a built-in restriction on all orchestrators.

Reuse role prompt assets and model configuration where meanings match. Do not run Main preset selection through the Fresh role classifier merely to share prompt text. Do not duplicate the same role prompt in preset and routing files.

A preset definition does not grant permissions merely by loading. Explicit user selection shows the manual capabilities being enabled and uses the existing user-enable/record path. Automatically discovering a preset or selecting a Subagent routing role cannot grant external orchestration authority. Role denials and Main-only restrictions continue to win.

Instructions must use structured prompt composition rather than copying full-system-prompt replacement from a sample extension.

The current manual grant model is append-only. Switching preset names cannot claim to revoke grants or restore an original security state. Initial delivery can prefer a preset chosen for a dedicated orchestration session; reversible switching needs a separate design decision. Native session name labels the execution; preset name identifies configuration.

Do not expose the orchestrator as an automatically selectable Fresh Subagent role. A background orchestrator with external control needs explicit authority design, not an exception to child-scope exclusion.

## Seed-session fork as a preset construction option

A separate research report proposes representing presets as clean native seed sessions and forking them. This is a useful construction option, but complete replay is not yet a substitute for runtime resource/prompt setup.

Verified in the installed SDK:

- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` creates a new session header/identity and copies every non-header entry. It does not rebase arbitrary strings or sanitize project paths inside entries, and copied entry timestamps are not reset.
- The SDK can restore model/thinking information and the recorded tool loadout. Tool restoration still depends on registrations, explicit tool options, current exclusions and asynchronous backend availability.
- The next run rebuilds structured prompt sections from the current resource loader and hooks. Historical sections absent from that desired prompt are explicitly deleted by the prompt diff.
- An isolated real-SDK/offline-model check seeded a `SEED_ROLE_MARKER` preamble, a `role` section and a `read` declaration, then forked and prompted. The initial active set and first request both contained `read`; the first request had `seedRolePresent:false` and `roleSection:null`. Therefore the proposed “fork alone preserves the role” premise is false for this startup path.
- The Harness stores manual choices as `result.manual` inside `customType: "capability-discovery"`. There is no separate current `capability-manual` record. Copying those entries preserves branch data; it does not register tools or override role qualification.
- Native `SessionManager` naming is `appendSessionInfo`; `setSessionName` belongs to the higher-level session/extension API.

Razor decision: **Prove first** for making Seed the sole preset format. Do not replace the configuration/role design with that claim yet. Seed can preserve a chosen dialogue skeleton or few-shot context and create an independent execution, while current role/resource setup establishes the desired prompt and registered tools. Do not copy the sample extension's full-prompt replacement or invent a Seed compiler merely to avoid using native SDK configuration APIs.

A user-selected, trusted Seed may carry intentional grants, but selection must expose and authorize those grants for the new Main session. Loading or discovering an arbitrary seed is not authority. Forking a working session also copies any Subagent Harness events, custom contacts and other history: use an explicitly constructed clean skeleton rather than assuming a fork removes execution baggage.

Acceptance before adopting Seed: test first request and subsequent turns, `/tree`/reload, tools registering late, excluded tools, model override, target cwd/path cleanup, grant provenance and branch restoration. Creating an independent session is a useful separation of histories; it is not OS isolation or a new security boundary.

## Human entry, also deferred

A future `/preset` command should browse named profiles and show the predefined role prompt, model choice and intended tool grants. An explicit user selection for a new/dedicated session can apply the displayed manual grants through the existing enable path. Loading a profile must not grant tools automatically.

The list must support native keyboard selection, filtering, focus/IME and cancellation without side effects. Hot switching and baseline restoration remain separate decisions because the current manual grant model is append-only. No `/preset` command or `preset` parameter is required in the first session/cron implementation.

## Research to retain

| Source | Useful practice | Limit |
| --- | --- | --- |
| Pi `examples/extensions/preset.ts` | Named model/thinking/tool/instruction composition and a native selection UI | It is an extension example, not a built-in permission system. Full prompt replacement and active-set snapshots are not authorization rollback. |
| [OpenCode agents](https://opencode.ai/docs/agents/) | Distinguish primary personas from Subagents and prompts from enforced permissions | Do not duplicate its permission/configuration engine. |
| Existing Harness role definitions | Role instructions and model configuration have existing owners | Reusing a prompt does not require running explicit Main preset choice through automatic Fresh routing. |

## Razor disposition

Principle: preserve a useful future distinction without making it a dependency of the current goal. Not audited here: implementation of session lifecycle, peer visibility and timers.

| Concept | Verdict | Reason |
| --- | --- | --- |
| Preset implementation | Defer | The user explicitly postponed it; session orchestration works without profiles. |
| Predefined role prompt | Keep | Preserve the future requirement: responsibilities and working method are not tool lists or task text. This does not authorize implementing a new catalog now. |
| Duplicate role/model sources | Merge | Reuse existing assets where semantics match when work resumes. |
| Seed as sole profile representation | Prove first | The tested default startup clears historical role sections; complete runtime restoration is unproven. |
| Hot switching / reversible permissions | Prove first | Append-only grants cannot be silently reinterpreted as revocable state. |
| Seed compiler / configuration framework | Defer | There is no validated representation requirement justifying another layer. |

Preserve manual authorization, role exclusions, stable session identities and honest SDK restoration semantics. A future profile must not bypass these in the name of simplification.
