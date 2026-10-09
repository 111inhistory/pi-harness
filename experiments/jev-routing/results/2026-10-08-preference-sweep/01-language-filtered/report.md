# Jev routing Preference comparison with the language filter restored

## Scope

The previous 472-record evaluation omitted the established language filter. Its full-corpus routing percentages must not be treated as English-test conclusions.

Filter every complete delegated_assignment, not the dataset's language label: Han characters U+4E00..U+9FFF divided by all Unicode codepoints. Exclude ratio >= 0.20. Whitespace, identifiers and code are included in the denominator. Of 472 records, 199 are excluded and 273 retained. Cross-dataset duplicates remain as in the full run. The exclusion manifest is `language-filter.json`.

## Comparison

The same 273 valid records are compared against their saved old-Preference results. Role instructions and all role pools are unchanged; saved role responses are reused only after verifying exact request equality. Only Gemini and DeepSeek Preferences changed. 188 new real Jev model decisions were requested, all HTTP 200, served by `typesafe/jev-1.13-20260917`. Singleton reviewer pools need no model classification or execution-model call. No execution-provider availability or model task quality is evaluated here.

| Model | Old Preferences, valid subset | New Preferences, same subset |
|---|---:|---:|
| Gemini | 2 | 56 |
| DeepSeek | 186 | 132 |
| Sol | 85 | 85 |

54 decisions change from DeepSeek to Gemini. Among 188 non-reviewer decisions, Gemini increases from 1.06% to 29.79%. Researcher: Gemini 52, DeepSeek 64. Executor: Gemini 4, DeepSeek 68. All 85 reviewers remain Sol/high.

The revised wording removes generic factual-accuracy demands as an automatic DeepSeek advantage. Routine read-only work and textual consolidation favor Gemini; substantial inference and concrete code implementation favor DeepSeek. Existing classifier instructions, role instructions, role pools and Sol Preference are unchanged.

## Random review and concrete cases

20 valid records are uniformly hash-ranked using seed `d0b7b878b45c919039dca6a1889717b2`, without outcome-based reselection. Full assignments, raw responses and baseline model IDs are in `random-sample.json`.

- Code implementation examples WpsScale, OfflineWrapperAgent, CoreBuild, DaemonRescue and ImplementPublication remain DeepSeek.
- Independent reviews remain Sol/high.
- DesktopResearch and DesktopSessionProtocols move to Gemini for source gathering/comparison and explanatory work.
- InspectI915Pipeline remains DeepSeek; the assignment requires difficult technical flow and failure-handling analysis.
- NvidiaPath is a boundary case: DeepSeek probability 0.51, Gemini 0.49.
- DrmLink is tied 0.50/0.50. The raw API choice says DeepSeek, but production selection uses probability argmax with configured criterion order for ties, thus selects Gemini. This is existing host policy, not a newly invented fallback.
- Outside the random sample, known documentation case UpdateSuspendDoc now selects Gemini, as do several source-lookup and environment-investigation cases.

## Important tradeoff

Model confidence below 0.5 rises from 17/188 to 98/188. Decisions with maximum probability <=0.6 rise from 5 to 55. The new wording better expresses the desired overall inclination, but makes many research choices ambiguous. This single-run comparison is not an accuracy score and does not prove stronger execution quality. No confidence-based routing rule, retry, or fallback was added.

Historical role-label agreement is 38/43 labeled valid records; labels for the other 230 valid records are absent. Several historical labels are inappropriate for the actual requested deliverable, so this is not measured accuracy.

## Artifacts and application

- `config.json`: tested candidate configuration.
- `results.json` / `results.jsonl`: all valid outcomes and raw decisions.
- `random-sample.json`: fixed random review sample.
- `summary.json`: counters and costs.
- `language-filter.json`: exclusion manifest.

Additional response-reported cost: $0.010756368. The temporary API key was supplied only through stdin; no Authorization headers or credentials are written into these files.

Only the two tested model Preference strings were written back to `/home/skwj111/pi-harness/.pi-agent/subagent-routing.json`, with exact checks preserving every other user field. The repository template was not overwritten.
