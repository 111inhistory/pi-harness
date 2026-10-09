# Live Jev routing evaluation — current Pi user config

**Superseded for English-test conclusions:** this run omitted the established Chinese-ratio filter. See `/tmp/pi-jev-english-tuned/report.md` for the corrected valid-subset comparison. The raw paid requests remain recorded here for audit.

## Scope and execution

- Config snapshot: `config.json`, copied from `/home/skwj111/pi-harness/.pi-agent/subagent-routing.json`.
- Five existing datasets, all 472 records; cross-dataset duplicates retained.
- Assignment-only state, matching current production routing. Historical original labels are reference labels, not a new ground truth.
- Real OpenRouter Jev Decisions calls only. No Gemini, DeepSeek or Sol execution requests.
- Production `routeSubagent` performs selection, role-local candidate enforcement and thinking clamping. Execution model bindings are lookup-only records in this test registry; this does not test execution-provider availability.
- Initial runner incorrectly passed raw API responses without the SDK `stopReason` envelope. All initial 472 role requests returned HTTP 200. These saved responses were reused after checking the exact request payload, then the 367 necessary model requests were sent. No role request was repeated.
- 839 actual paid requests in total, 472 routes completed, zero final errors. Response-reported cost: $0.056637126.

## Distribution

| Role | Count |
|---|---:|
| researcher | 244 |
| executor | 123 |
| reviewer | 105 |

| Model | Count |
|---|---:|
| Gemini | 9 |
| DeepSeek | 358 |
| Sol | 105 |

All 105 reviewers selected the configured singleton Sol with high thinking; no reviewer model request was needed. Of the 367 non-reviewer decisions, DeepSeek received 358 (97.55%) and Gemini 9 (2.45%). The overall Gemini preference is weak in this corpus.

## Historical labels

44/54 labeled records match the historical role label. This is label agreement, not measured accuracy. The other 418 records have no expected role. Several disagreements are justified by the actual assignment: `DailyNtfsInventory` is explicitly read-only, `PersistOmpConfig` requires memory updates, and `IrlightReview` is an independent review. Old model expectations are stale after the role pools and Preferences changed and are not scored as current correctness.

## Random review

A uniform hash-ranked sample of 20 records was drawn with seed `d0b7b878b45c919039dca6a1889717b2`. The same sample was retained after fixing the response envelope; it was not rerolled based on routing results. Full assignments, request payloads and responses are in `random-sample.json`.

The sample has 7 reviewer/Sol, 4 executor/DeepSeek and 9 researcher/DeepSeek decisions. Roles are broadly consistent with the requested deliverables and authority. Two useful boundary cases:

- `PluginAudit`: researcher probability 0.62, reviewer 0.36, confidence 0.43. Migration inventory versus independent assessment is genuinely ambiguous; not a demonstrated role bug.
- `PersistOmpConfig`: executor is appropriate because the assignment requires updating memory. DeepSeek selection is questionable for primarily textual memory consolidation, given the requested overall preference for Gemini.

Read-only technical tasks such as `DesktopResearch`, `NvidiaPath` and `WindowsDisplayRegistry` consistently go to DeepSeek. Some require substantial inference or exact evidence, so read-only status alone cannot establish misrouting. However, the combination of an almost universal DeepSeek preference and textual documentation cases choosing DeepSeek shows that the Gemini tradeoff wording likely needs refinement. This is an interpretation of observed decisions, not a returned explanation from Jev.

Outside the random sample, the known technical-documentation case `omp_subtask_0390` also selected DeepSeek, with model confidence 0.22.

## Confidence diagnostics

- Role confidence below 0.5: 27 of 472 decisions.
- Model confidence below 0.5: 44 of 367 decisions.
- No new confidence-based fallback or routing policy was introduced. Confidence is not accuracy.

## Conclusion

Role-pool enforcement works. Reviewer is correctly confined to Sol/high. Current Preferences route this task corpus overwhelmingly to DeepSeek, so the intended overall Gemini inclination is not demonstrated. No user configuration was changed during this evaluation. Raw responses, fixed sample and configuration snapshot are retained for inspection.
