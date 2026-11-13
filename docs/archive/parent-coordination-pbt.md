# Parent coordination PBT validation

Candidate `7906c71d45eb5011cf5dc6f7861cb05c303e2dc4` replaces the imperative parent-hold, upstream-parent and hierarchical-broadcast catalogue with generated histories through real SDK sessions, managed IPC and durable files. Production code is unchanged. The model's current behavior is described in [Testing](../testing.md#parent-coordination-model-tests).

The affected test family, including all changed shared fixtures and scenario dispatchers, decreases from 2,515 to 1,913 lines. This is a replacement of the test model, not a claim of one-for-one preservation of the old assertions. Independent budget tests remain; the new model does not claim budget-clock coverage.

| Validation | Linux | Native Windows |
| --- | --- | --- |
| Full `npm run check` | 1,110 pass, 0 fail, 10 skip | 1,100 pass, 0 fail, 21 skip |
| Histories per PBT in full run | 100, seed 74113 | 100, seed 74113 |
| Additional parent histories | 300, seed 12345 | 300, seed 20260718 |
| Types, docs, JSON, all contract associations, RPC schema | Pass | Pass |

Windows runs at the exact candidate with Node 24.22.1, npm 12.2.1 and fast-check 4.10.2. The vendor submodule is initialized and its WASM checksum matches the manifest; parser tests run. Skips reflect platform/environment conditions, without missing-artifact inflation. The additional Windows property takes 44.6 seconds under the unchanged 120-second subprocess budget.

During development, shrinking reduced a fixture hang to a broadcast followed by final settlement. A queued message triggered another provider request after the first release. The scripted provider now finishes subsequent requests in that same Job; broadcast generation and assertions remain intact. No production defect was found in these runs.

The final oracle checks both durable delivery entries and actual receiving model requests. Inherited entries captured at creation are excluded from each Actor's own deliveries. Scheduler control is limited to wrapped leaf-provider release boundaries. Online provider behavior is untested.
