# Proposal: Agent discovery and communication

Status: proposal, not the current interface contract. This document records the discussed design; it does not authorize runtime implementation. External orchestration belongs to [a separate project](session-orchestration-proposal.md), which may embed a lightweight Pi; its session-management and scheduling runtime is outside this Harness. Presets and Seed research are [postponed separately](agent-presets-proposal.md) and are not dependencies of this proposal.

## Goal

Let an ordinary Agent recognize its parent, children and permitted peers, then communicate through the existing message tool. Do not require ordinary Agents to understand Pi session management or grant external orchestration tools merely because a message arrived.

A peer is another collaborating Agent. For an independent Pi process, its native session is the implementation carrier, not a second model-facing collaboration concept.

## Decisions established in discussion

| Subject | Decision |
| --- | --- |
| Listing | Replace `subagent_list` with `agent_list`; do not retain a compatibility alias. |
| Creating children | Keep `subagent_create`. It only creates Subagents. |
| Stopping children | Keep `subagent_stop`. It only controls Subagents within the existing authority boundary. |
| Main peer visibility | Show peers explicitly made discoverable by the user or an authorized external orchestrator, plus peers with which actual message delivery has occurred. |
| Subagent visibility | Preserve the existing parent/sibling/child scope and depth rules. Do not add machine-wide peer discovery to Subagents. |
| Automatic activation | After communication, enable `agent_list` automatically. This is a narrowly scoped discovery affordance, not an orchestration grant. |
| Message destination | Use the existing managed Socket path in `msg_write.path`. No `session:` address scheme. |
| Message source | Put complete cross-session identity in `from`, such as `<stable-session-uid>:Main`. No separate wire `session` field. |
| Human naming | Use the native session name; remove intent rather than maintaining another description field. |

The final wire and address simplification is a separately requested implementation. This proposal defines the discovery behavior that should build on it.

## `agent_list`

### Main view

A Main query separates its child tree from visible peers:

```text
children
  Existing Subagent tree, with its existing status/history projection.

peers
  Parallel Agents explicitly opened for discovery or already contacted.
```

Main has no parent. For Subagent callers, retain the existing scoped tree model rather than forcing a breaking parent/children/peers response redesign merely for visual symmetry.

Reuse existing detailed subtree lookup, `all`, display windows and history fields where they retain their meaning. In particular, `all` may remove a display window; it must never bypass peer visibility or reveal all live sessions. Lookup by ID must apply the same visibility rule as listing.

Peer entries contain only basic identification and contact metadata: stable identity, native name when present, cwd, Main Socket path and reliably available reachability information. Do not label a peer `running` merely because a PID exists or a message arrived. Detailed runtime inspection belongs to the manual orchestration interface.

Do not expose transcripts, system prompts, tool arguments or credentials through this list. A peer's visible name is not its routing identity. Renaming does not change the contact relationship or destination identity.

### Visibility and contact

The underlying directory remains a host addressing index. Directory membership alone is insufficient to make a session appear in Main's peer list.

A peer is visible when at least one of these holds:

1. The user explicitly opened that peer for discovery.
2. An authorized external orchestrator opened or connected it.
3. The current Agent has successfully sent a message to it or accepted a message from it.

“Opened for discovery” means the explicit visibility choice discussed by the user; it must not be inferred merely from `agent_list` being active. The exact user command and storage representation for that choice remain to be specified.

Contact is directional evidence: a sender records its confirmed handoff; a receiver records actual acceptance. If a send times out or disconnects with unknown outcome, do not invent a confirmed sender-side contact or replay the message. The receiver may independently have observed and recorded acceptance.

A failed or refused send does not create a contact. Reading the directory, constructing an address or previewing a picker does not create one either. Rejecting a self-send must happen before it can create a peer entry.

Reuse native branch history/custom-entry mechanisms for contact evidence. Do not create a second mutable database of Agent identity or a new permission ledger. Where existing incoming message metadata can supply the evidence, derive it rather than duplicating it. Outgoing evidence must retain the actual peer identity, because plain success text alone is insufficient for restoration.

Branch behavior follows the current visible branch: contact evidence that is no longer on that branch must not leak into it from an abandoned branch. An explicit external visibility setting has its own scope and must not be mistaken for branch contact history. Exact restoration format is an implementation decision requiring focused review.

A known but currently unreachable peer may remain known; its stale path is not proof of liveness. Whether the default list hides unreachable known peers or labels them is a presentation decision, not a reason to erase contact evidence.

## Automatic `agent_list` activation

The narrowly permitted transition is:

```text
Actual ordinary message handoff or acceptance
  -> record/derive the peer contact where applicable
  -> activate the registered agent_list tool
  -> continue through native message delivery
```

Activation is host-owned and must happen before a receiving model turn builds its tool loadout. The contact result and activation must be visible to that turn. If the session is busy, preserve native steer/queue behavior; do not start a parallel model loop.

This activation:

- enables only `agent_list`, not its entire namespace;
- does not run Capability retrieval or activate `session_*`, cron or other manual tools;
- does not grant child creation, stopping or arbitrary global discovery;
- does not override hidden exposure or an explicit role denial;
- does not reinterpret a message body as authorization;
- treats `agent_list` as the discussed ordinary discovery tool, not a manual orchestration capability;
- uses current registration and existing activation mechanics rather than a new activation subsystem.

Automatic listing does not automatically grant `msg_write`. An Agent with existing message authority can use the supplied reply address. A separate decision would be needed if reply authority itself must be granted on receipt.

Restoring a branch containing contact evidence must restore the intended listing affordance through the same derivation, instead of waiting for another live message. A failed automatic activation must not be reported as successful; contact and tool availability are separate facts.

## Messages

The user supplies only the destination path and body:

```json
{"path":"/tmp/project-sockets/peer/Main.sock","content":"Please review the parser change and reply with findings."}
```

For cross-session traffic the sender host constructs one NDJSON frame:

```json
{"from":"syntheticuid:Main","content":"Please review the parser change and reply with findings."}
```

The receiving host parses the composite identity at the IPC boundary, resolves it against the managed directory and maps it to the Runtime's internal sender representation. Do not treat it as a local Actor ID. Internal typed distinctions may remain where Runtime admission needs them; they are not another public identity protocol.

The model sees the same ordinary message label used for other peers:

```text
[Message from syntheticuid:Main]
Reply address: /tmp/project-sockets/syntheticuid/Main.sock
Please review the parser change and reply with findings.
```

Native names may improve human display, but the stable source and usable reply path must remain unambiguous. Do not infer a target's execution state from this message or display a fabricated `running` status.

Keep actual Socket ownership checks, Main-to-Main restrictions for cross-session messages, host-bound identity and the prohibition on self-send. Same-user local IPC retains the existing trust model; composite `from` is not cryptographic authentication. Do not introduce an authentication system as part of this UI/protocol simplification.

## Human commands and interaction

Commands are a user interface over the same relationship projection and host operations, not a second tool API or a way to change model permissions incidentally.

| Command | Default interaction |
| --- | --- |
| `/agent` | Open a bounded, grouped Agent list; equivalent to the list entry below, not a statistics notification. |
| `/agent list [parent|children|peers] [filter]` | Show the requested relationships with a plain text filter; no relation argument means all relationships visible to this caller. |
| `/subagent` | Open the child-management view, reusing the children projection and selecting a permitted child action. |
| `/subagent stop [id|--all]` | Keep existing child-only stopping. Without a target, show a child picker; merely opening or cancelling it does not stop anything. |

`/agent` is the discovery entry; `/subagent` retains the child-control meaning. The child-management view reuses the same list renderer/data instead of implementing another list. Move the old `/subagent list` functionality to `/agent list`; do not retain two synonymous list commands or a compatibility alias. Move the old `/subagent sessions` management-wide view to `/session list` as described in the companion proposal. Removing those old command paths is part of the future implementation, not a statement that current code already changed.

The list groups parent, children and peers, preserves a compact hierarchy for children and uses native names with stable identity available as secondary information. It shows the actual message address when inspecting an item. Basic peer visibility must be identical between the command and model tool: no unfiltered global directory fallback. Subagent callers keep their current scope even if the human formatter can display different relationship headings.

Typing filters the current visible list. Empty input shows the complete permitted view; zero matches offers a recoverable empty state. Use the native Pi selector/scroll components for long lists, preserve keyboard navigation and focus/IME behavior, and handle narrow widths. Print/non-interactive mode may return the same grouped data as text instead of attempting a custom terminal screen.

Selecting a peer is an observation, not a message send. Do not auto-contact, auto-connect or grant tools from highlighting an item. Child-control actions must be visibly distinguished from peer observation; an unrelated peer never receives a Stop action through this UI.

Parameter completion should cover list/stop verbs, relationship values and currently valid child IDs, preserve trailing spaces and exclude impossible next arguments. Free text filters have no invented completion candidates. Follow the current SDK editor's completion lifecycle: the known command-name acceptance issue (next-level candidates require another Tab) is not fixed by this proposal. Do not replace the editor or add timers to simulate automatic expansion.

Human invocation of `/agent` does not by itself activate the model's `agent_list`; model activation follows explicit capability enabling or the communication-trigger rule. Human cancellation and browsing produce no contact or authorization records.

## Razor assessment

Principle: every independent concept must protect a current goal or real distinction. This audit covers discovery and message affordances, not execution scheduling or OS isolation.

| Evidence | Consequence |
| --- | --- |
| User explicitly separates ordinary collaboration from manual orchestration | Ordinary discovery cannot require session-management authorization. |
| User permits a small activation boundary on communication | Automatic activation is restricted to `agent_list`. |
| Existing Subagent tree and session directory already own identities | Merge their projections; do not create a unified Agent registry. |
| Current message/address discussion rejects `session:` and an extra session field | Reuse Socket destinations and complete `from` identity. |

| Concept | Verdict | Deletion test / strongest survival argument |
| --- | --- | --- |
| `agent_list` | Keep | Ordinary Agents need a view of actual collaboration relationships. |
| `subagent_create` / `subagent_stop` names | Keep | Renaming them to generic Agent operations hides their parent-child authority boundary. |
| Separate general-purpose `session_list` for ordinary Agents | Merge | Its useful discovery responsibility belongs in the bounded `agent_list`; the manual management list remains distinct. |
| Contact visibility rule | Keep | Without it, a small collaboration affordance leaks the whole directory. |
| Automatic `agent_list` activation | Keep | The user explicitly accepts this small transition after communication. |
| Implicit activation of the orchestration namespace | Delete | Convenient replies do not justify granting control of independent sessions. |
| Session intent | Delete | Current purpose can be communicated in the message; native name already owns human identification. |
| Unified Agent identity registry | Delete | Existing registries can supply a view without copying ownership. |
| Contact persistence representation | Prove first | Restoration matters, but exact duplication and branch semantics need implementation evidence. |

## Acceptance

- Main cannot enumerate a hidden untouched peer, including via `all` or ID lookup.
- Explicit opening or an authorized connect makes the intended peers visible without exposing unrelated ones.
- Actual incoming acceptance enables only `agent_list` before the next native model request; sending success does likewise for the sender.
- Refused sends and uncertain sender-side outcomes do not fabricate confirmed contacts; no replay is introduced.
- Self-send does not create a peer or wake the current session as an external sender.
- Restoring/forking a branch follows its visible contact evidence and current role denials.
- Subagent list scope and create/stop permissions retain their current behavior.
- Native names can change without invalidating identity or contact routing.
- `/agent list` and the tool agree about permitted peers under the same context; relationship/filter changes cannot reveal hidden peers.
- The child-control picker excludes unrelated peers; opening/cancelling it never stops a child.
- Exercise real editor completion for verbs, relationship values and child IDs, and real terminal list filtering/navigation/resize/IME focus; direct parser calls alone do not establish the command UX.
- Verify with real SDK sessions and real local Sockets, plus a human terminal view; parser-only or handler-only tests are insufficient.
