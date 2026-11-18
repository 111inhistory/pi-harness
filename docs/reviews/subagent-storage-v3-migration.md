# Subagent storage v3 migration preparation

## Scope and current evidence

This is an offline migration proposal, not authorization to rewrite existing sessions. Production continues to read only its canonical v3 format; migration belongs in an explicit script under `scripts/`.

The read-only inventory separates JSON-complete v2-only candidates from v1-only, mixed-version, and malformed roots. Roots without Subagent data are outside this migration. File paths, session identities, hashes, exact counts, and size estimates belong in a private local inventory, not in repository fixtures or this proposal.

The inspected v2 registrations partition into batches using native parent-entry chains and registration indices, without orphan indices or ambiguous membership. The inspected terminal leaves contain no partial batches. This evidence does not establish that arbitrary crash prefixes are recoverable; every selected root still requires its own exact preflight.

## Target representation

- An Actor owns its label, goal, shared context, batch, declared member position, kind, and roster.
- Persisted roster entries contain session-local Actor references, labels, and goals. Full logical addresses are derived from the root session identity at runtime, including after a Fork. Persisting a full session prefix in the roster prevents copied roots from restoring under their new session identity.
- A Job spec contains its initial/continuation kind and optional inherited capture metadata. It does not duplicate the Actor's goal or label as an independently mutable assignment.
- Public create results, prompts, and message targets continue to use full logical addresses. The migration does not install old-address aliases.

## v2 conversion requirements

1. Preflight the selected files without writing them. Record source identity, content hashes, root identity, topology, native branch links, and every proposed Actor/Job mapping. Refuse malformed JSON and unresolved references in a selected root.
2. Recover each batch from a direct native parent-entry chain of initial registration events with indices `0..n-1`. Verify shared creator, parent, origin, and context. Do not infer membership from labels, timestamps, matching prose, or physical line adjacency.
3. Allocate deterministic session-wide batch numbers in registration order across all branches, not just the current branch. Map singleton Actors to `sub_<batch>` and multi-member Actors to `sub_<batch>-<position>`. Preserve continuation round numbers.
4. If exact partitioning is impossible, stop that root and request an explicit mapping decision. Do not silently invent singleton groups or incomplete rosters.
5. Transform harness event data in place while retaining each native entry's ID, parent ID, timestamp, and physical position. Replace initial topology with canonical Actor fields and local roster references. Translate Actor/Job references and `Main` to canonical `main` in structured identity fields.
6. Preserve initial goal/context/label from the original initial Job. Preserve model, role, trusted working directory, inherited seed metadata, anchors, native start/end entry IDs, results, errors, and Budget outcomes.
7. Translate the exact tool identifier `subagent_stop` to `subagent_signal` only in known structured execution fields: captured tool lists, exclusions, and parsed Preset tool-selection tokens. Do not perform text substitution inside model messages, signatures, tool arguments, role instructions, or system prompts.
8. Non-harness lines must remain byte-identical. Historical messages may still mention old addresses or tool names; the mapping report explains their relationship to the new identifiers.

Capability collection records are a separate authority for tool availability. Translating an Actor's frozen tool lists does not reconcile old tool references in root or child Capability state. That work is explicitly deferred; this planner must report the limitation rather than rewrite Capability-owned entries or claim that execution availability is fully migrated. Namespace reactivation and inherited Capability restoration require their own validation before an apply tool is delivered.

## Child files, Fork ownership, and views

The conversion initially leaves child files and their recorded paths unchanged. Existing production copy-on-write behavior remains authoritative: when the recorded file is not the new Actor's canonical own file, first revival materializes the selected native branch under the new filename. Subsequent continuations use the recorded new file; rewind reuses a compatible existing copy.

This avoids an upfront rewrite of all child histories, but does not promise zero later copying or disk growth. A foreign Fork still requires copy-on-write. No hard-link aliases, symlinks, or runtime migration branches are introduced merely to avoid this cost.

Old derived view directories remain untouched. The runtime rebuilds views under the mapped Job IDs from preserved native intervals. Migration does not perform historical garbage collection or delete sockets.

## v1 and malformed roots

The existing `convert-subagent-storage-v2.mjs` is a historical v1-to-v2 converter that collapses registry state to a selected path. It is not a branch-preserving v3 converter and must not be chained automatically.

The v1-only root, mixed root, and malformed v2 root are excluded from the first conversion set. A separate proposal must state which v1 branch positions retain equivalent registry state and which require selecting a terminal checkpoint. Preserving ordinary conversation entries is not equivalent to preserving the registry at every historical checkpoint. Undelivered pending messages must not be silently discarded.

Malformed interior lines require explicit inspection and repair authorization. They are not assumed to be harmless incomplete append tails, and migration must not skip them to manufacture a successful conversion.

## Application and recovery boundary

- Application requires the target root and affected shared-history owners to be offline. A plan prepared while sessions are active is not a stable application snapshot.
- Revalidate the plan against the source identity and hashes immediately before application. Changed sources require a new plan.
- Preserve a byte-exact recovery copy outside the rewritten active file. Write the replacement to a separate file, flush it, and replace the selected root atomically. Report success only after verification.
- Recovery is an explicit offline restoration from the recovery copy, not a production fallback reader or automatic rollback service.
- Do not overwrite an unrelated recovery copy, rewrite another root's child history, or remove unverified IPC resources.

## Verification and cost

Verify every existing terminal branch and the current branch: Actor and Job counts, mapping completeness, topology, batch membership, continuation links, labels/goals, native bounds, anchors, outcomes, and capture identity. Verify non-harness line hashes and unchanged child files. On disposable copies, exercise native SDK loading, list, Fork, and an explicit continuation without changing the originals.

The implementation must stream root JSONL rather than materialize multi-hundred-megabyte files as arrays of parsed messages. Memory is bounded by the largest current line plus native entry/Actor/Job mapping metadata. Source hashing and replacement are linear in the selected root bytes; optional child verification reads child bytes without rewriting them. Recovery copies and replacement files require additional root-sized disk space; later copy-on-write adds only the branches actually revived.

## Delivery boundary

- Canonical local-roster storage and copied-root/Fork restoration are implemented and covered by runtime-event folding tests.
- The read-only planner is implemented in `scripts/plan-subagent-storage-v3.mjs`. Synthetic tests apply the planned event data to original native entry IDs and exercise actual canonical folding and restoration across terminal branches, including continuations and changed session prefixes.
- The single-root offline application entry is `scripts/migrate-subagent-storage-v3.mjs`; it requires `--apply --offline`, regenerates the plan, verifies persisted recovery/output hashes, and replaces only the explicitly selected root. Its existence does not authorize application to any session.
- Read-only domain restoration of a prepared plan does not validate native SDK revival, model availability, inherited Capability state, or an offline application procedure. The plan keeps `runtimeValidated: false` and requires a separate offline check.
- Present the exact selected roots, mappings, exclusions, disk estimate, and offline requirements for approval before rewriting existing sessions.
