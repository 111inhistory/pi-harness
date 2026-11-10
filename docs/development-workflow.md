# Development workflow

Start with the existing architecture, choose the responsibility and algorithm, then write production code. Apply the repository's current scope and freeze first. Use one coherent change as the unit of work; an exploratory probe may precede the design, but does not establish a new production boundary by itself.

## 1. Understand the existing responsibility

Read the relevant architecture/contract section, actual entry point, owning module, direct collaborators and existing tests. Check the working-tree diff so that the design accounts for changes already in progress. Follow the affected path rather than reading the whole repository or trusting a file name as its responsibility.

Identify where the current decision is made, where authoritative state lives, what is derived, and who owns mutation and release. Look for an existing operation that can carry the required behavior. For a bug, establish the trigger or mark the cause as unverified; do not build a design around an assumed failure.

Before editing production code, choose what happens to the affected responsibility:

| Choice | Decision to make |
| --- | --- |
| Keep | Preserve a needed distinction, deep interface or correctness boundary; improve its implementation if needed |
| Merge | Move a responsibility to an existing owner when it has no sufficient independent meaning; name the receiving owner |
| Delete | Remove a concept only when no required behavior or invariant depends on it; check callers and failure paths |
| Replace | Keep a real responsibility but change its algorithm, owner or representation; state what behavior remains equivalent |
| Defer / Prove first | Leave a speculative addition out, or investigate a consequential uncertainty before committing to a mechanism |
| Add | Introduce a module, state, field or layer only when an actual current requirement cannot be carried clearly by an existing owner |

Apply the existence test: what concretely breaks if this concept disappears, and who would absorb its responsibility? Preserve permission boundaries, recovery, resource ownership and other necessary complexity. A large module is not automatically wrong; a small forwarding layer is not automatically useful. For an addition, name its current caller and the complexity it hides. Do not add a second authority or a future extension point without a present need.

For a local change, this decision can be one sentence. When ownership moves across modules, state the before/after responsibilities in a short explanation or table. A full architecture report or per-symbol classification is not required.

## 2. Design the core algorithm and its boundaries

Before expanding the implementation, determine the input, output, authoritative data, ordering and essential steps. Use a few sentences, a small example or pseudocode to resolve non-obvious logic. Do not substitute a list of helper functions or interfaces for the algorithm.

For the affected path, settle the relevant questions:

- **Semantics:** What determines the winner, record order, effective interval or state transition? Distinguish a persisted fact from a derived view and an intended change from its successful application.
- **Cost:** What input sizes multiply? Account for replay, matching, sorting, copies, serialization and synchronous I/O across callers. Distinguish temporary allocation, peak live data and retained state; check actual writes before choosing cloning or sharing.
- **Ownership and lifecycle:** Who can mutate each object, who holds strong references, and which event releases them? Include cancellation and failure where applicable. Weak references do not replace a release path.
- **Boundaries:** Which empty/missing inputs, overlapping rules, chronological cases, partial failures or concurrent events can actually reach this path? Preserve error results, ordering and externally visible effects when simplifying.

Select only applicable conditions. A pure parser does not need a socket lifecycle design. A straightforward local fix does not need pseudocode or a new design document. For substantial work, keep these decisions in the existing plan/review or task discussion; implement and validate one dependency unit at a time instead of designing every detail up front.

Use independent examples to expose ambiguous semantics before coding. For example, discovery A, prune A, rediscovery A must retain the new record without reviving old metadata; an overlapping permission update must apply the final effective decision. Investigate uncertain SDK or platform behavior with a focused probe. Do not add general machinery to compensate for an unverified premise. Measurement details are in [resource verification](testing.md#complexity-and-resource-verification).

## 3. Implement through the real entry point

Make the smallest end-to-end path work using the chosen owner and algorithm, then complete its necessary failure and boundary cases. Reuse domain operations; keep adapters focused on real translation boundaries. Remove superseded implementations, callers and production formats rather than maintaining parallel paths.

Keep types, nearby comments and current contract documentation consistent with the change. Explain non-obvious decisions in [code comments](writing-guide.md#code-comments); do not preserve an obsolete mechanism to satisfy its old comment or test. If implementation needs an unplanned cache, wrapper, deep copy or state, revisit its existence and ownership before expanding the design.

Run the most relevant test or reproduction while implementing. Revisit the design when actual behavior contradicts it; do not patch each symptom with another rule. Record unrelated findings in the current issue/review unless they block this change.

## 4. Validate behavior and resource costs

Verify through the affected production entry, with independent expected behavior. Extend existing behavioral tests where they miss a meaningful case; do not mirror the new algorithm in the expected values. For a bug, rerun the original trigger and verify failed-before/passed-after evidence when feasible. A temporary reproduction may establish the evidence before a permanent test is chosen; strict test-first ordering is not required.

Check the costs and lifecycle boundaries identified in step 2. Use work counts for demonstrated repeated work, actual teardown evidence for observers, and native execution for platform-specific semantics. Use optional measurements when memory retention or latency remains uncertain. Do not require a benchmark, heap dump or multi-platform run for unrelated edits. Explain missing environment evidence rather than substituting a nearby test.

Review the complete diff, including comments and removed callers. Run `npm run check` for code delivery and the affected docs, JSON and contract checks. Repeat passed checks only when further changes, failures or unresolved concerns warrant it. Documentation-only changes use documentation checks; do not manufacture behavior tests for wording.

## 5. Commit and deliver

Group each complete behavior with its necessary tests and contract updates. Separate independent work; check dependency-chain commits without relying on later files. Inspect `git diff --cached --stat`, the full staged diff and the staged contract check before committing.

Report what changed, what verified the behavior and any remaining limitations. Keep long-running evidence in the existing review rather than creating a document per edit. Commit, push and lift feature freezes only within the user's authorization.
