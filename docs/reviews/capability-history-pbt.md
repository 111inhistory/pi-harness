# Capability history PBT counterexamples

The generated model runs real SDK sessions, Capability retrieval, registered `/capability` commands, backend execution, compaction, durable reopen and the installed Responses serializer. Provider responses and compaction summaries are scripted external inputs. No production code was changed to investigate these failures.

## Pruned tool enabled and then disabled

A tool starts inactive. The generated history discovers it, compacts without using it, explicitly enables it, then disables it. Each operation is followed by an actual model request.

Expected: disable blocks execution immediately but retains the newly published declaration until the next successful compaction. The previous request remains a serialized prefix. Actual: the request after disable loses the declaration added by enable, and the active slot disappears before another compaction.

Reproduce from the repository root:

```sh
PI_PBT_RUNS=100 PI_PBT_SEED=74113 PI_PBT_PATH=83:4:5:5:6:7:7:7:8:8:8:8:10:10:10:12:12:12 PI_PBT_COMMAND_PATH=/V:D node --import tsx --test test/typed/capability-history-model.test.ts
```

The first failing run shrank 17 times. A separate diagnostic replay bypassed only the prefix assertion and confirmed that the active-state assertion also fails; the committed model retains both assertions.

Cause: `prunedToolNames` retains the earlier prune until rediscovery. Explicit enable overrides it only while the current permission is enabled. Disabling removes that override. `createToolAdmission.declares` then refuses the name because it is still pruned; `before_agent_start` removes its active slot and the declaration projection removes even the post-prune declaration already sent to the model. See `src/capability/discovery-record.ts`, `src/capability/admission.ts` and `src/capability/native-discovery.ts`.

## Description refresh while disabled, followed by enable

A baseline tool starts active. The generated history disables it, replaces only its description, then enables it again. Its parameters remain identical.

Expected: the already sent description/declaration history remains fixed, with any new current guidance appended. Actual: enabling causes the request projection to remove a description-only declaration that an earlier request already exposed while execution was disabled.

```sh
PI_PBT_RUNS=100 PI_PBT_SEED=12345 PI_PBT_PATH=51:2:4:4:4:5:4:4:4:4:5:5:5 PI_PBT_COMMAND_PATH=DCj:F node --import tsx --test test/typed/capability-history-model.test.ts
```

The first failing run shrank 12 times. Its minimal description was whitespace; a separate replay with a normal nonblank replacement description reproduced the same prefix failure.

Cause: `projectToolPromptUpdates` leaves a description-only redeclaration intact while the name is not callable and has no published revision evidence. Enabling makes it callable; the next projection sanitizes that historical redeclaration for the first time and publishes tail guidance. That changes a declaration already sent in the disabled request. See `src/tool-prompt-updates.ts` and the permission-filtered context projection in `src/capability/extension.ts`.

## Model validation and limits

The prefix oracle compares complete Responses serializer outputs from consecutive real root requests within one checkpoint. It does not compare differently serialized transports or claim prefix stability across compaction. Parameter changes are checked against the declared current schema. The provider/backend execution counter is separate from the reference permission/activation state.

During model development, an invalid scripted argument to the public `capability` tool was corrected; this was a fixture error, not a product defect. The reference model also clears discovered membership when compaction removes it. A temporary diagnostic run excluding the known prefix assertion exercised 300 generated histories against the remaining state/schema/execution assertions. This is diagnostic evidence only, not a passing run of the complete property.

Both exact counterexamples also reproduce on native Windows with Node 24.22.1 and fast-check 4.10.2 at test commit `bbb2d79`. Each replay exits 1 on the same serialized-prefix assertion, in roughly 1.3–1.4 seconds, without reaching its process deadline. Strict types, docs, JSON, contract associations and RPC schema checks pass there. The native lifecycle model passes 50 histories with seed 74113. The full Windows suite was not run for this candidate.

Linux full validation with 100 histories and seed 74113 reports 1,121 passes, this one failing generated property and 10 platform/environment skips. These are offline SDK and serializer reproductions; they do not establish online provider cache effects. The counterexamples remain failures in the PBT rather than skipped commands or expected-failure tests.
