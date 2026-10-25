/**
 * Host-side engine for the no-argument `capability` tool.
 *
 * The public surface lives in ../extensions/capability.mjs and only starts this
 * engine: one discovery run drives an isolated internal retrieval session whose
 * entire tool set is `capability_search` + `submit_result`. The session itself
 * inherits the caller's native conversation (raw session entries, system
 * prompt, model); this engine owns the run — it tracks every ref the searches
 * actually returned, validates the submission against those refs, and maps the
 * run outcome to the broker's grouped result shape.
 *
 * Search is local-only: remote installation candidates stay out of the
 * discovery result, Main's tool content and the branch memory until a user
 * approval receiver exists (rewrite plan D4). Every result therefore carries an
 * explicit `coverage` object saying local was (or was not) searched and remote
 * was not searched, so an empty result cannot be read as "no remote resources".
 *
 * Pi-specific plumbing (shared Subagent execution, the budget hook, the
 * inherited-context capture) stays in the extension, so this module is
 * importable without the Pi SDK and its protocol behavior is unit-testable:
 * brokers and sessions are injected.
 */

import { createJobBudget } from "./job-budget.mjs";
import {
  CAPABILITY_SEARCH_PARAMETERS,
  CAPABILITY_SEARCH_TOOL_NAME,
  SUBMIT_RESULT_PARAMETERS,
  SUBMIT_RESULT_TOOL_NAME,
} from "./capability-broker.mjs";
import { promptText } from "./prompt-text.mjs";

const toolsPrompt = JSON.parse(promptText("capability-tools.json"));
const policyPrompt = JSON.parse(promptText("capability-policy.json"));

/**
 * Fixed internal budget for one discovery run: harness-owned, never derived
 * from the caller, the public schema, or a parent Job Budget. One run is a
 * handful of searches plus one submission, so the ceiling is deliberately
 * small. `soft` asks the model to wrap up and submit; `hard` and the time
 * bounds stop the run with an explicit failure.
 */
export const CAPABILITY_DISCOVERY_BUDGET = Object.freeze({
  modelCalls: Object.freeze({ soft: 6, hard: 8 }),
  activeTimeMs: Object.freeze({ soft: 60_000, hard: 120_000 }),
  lifetimeMs: 300_000,
});

/** Fixed bound for the reported missing-capability lines. */
const MISSING_QUERIES = 5;

/**
 * The retrieval addendum. The internal session inherits the caller's system
 * prompt (native system context) and this section is appended to it, so the
 * retrieval agent keeps the caller's environment, permissions and conventions
 * while its own tool set and rules stay fixed. It is also the whole system
 * prompt in the degenerate case where the caller captured none.
 */
export const CAPABILITY_DISCOVERY_SYSTEM_PROMPT = promptText("capability-discovery-system.md");

/**
 * The user turn that starts one discovery run. It is the only prompt the
 * internal session receives; there is no planning turn after the submission.
 */
export const CAPABILITY_DISCOVERY_PROMPT = promptText("capability-discovery-user.md");

/** Remote search stays off until a user approval receiver exists (D4). */
export const CAPABILITY_REMOTE_SEARCH_DISABLED = policyPrompt.remoteSearchDisabled;

/**
 * What this run actually covered. `local` counts completed local searches, so a
 * run whose only search failed reports `not_searched` instead of a no-match.
 */
export function capabilityCoverage(run) {
  return {
    local: (run?.completedSearches ?? 0) > 0 ? "searched" : "not_searched",
    remote: "not_searched",
  };
}

const GROUP_BY_ARRAY = Object.freeze({ tools: "tools", mcp: "mcp", skills: "skills", remote: "remote" });
const GROUP_BY_KIND = Object.freeze({ tool: "tools", mcp: "mcp", skill: "skills", package: "remote" });

/**
 * The broker's grouped result shape in its explicit failure form. Used for
 * cancelled, failed and misbehaving runs alike, so a failure is never presented
 * as a clean "no match".
 */
export function capabilityFailureResult(message, warnings = [], coverage = { local: "not_searched", remote: "not_searched" }) {
  return {
    status: "failed",
    tools: [],
    mcp: [],
    skills: [],
    remote: [],
    coverage: { ...coverage },
    missingCapabilities: [],
    warnings: [...warnings, String(message)],
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneHit(hit) {
  return structuredClone(hit);
}

/**
 * A provider failure resolves the internal session's prompt instead of
 * rejecting it (the attempt keeps an assistant message with `stopReason:
 * "error"`), so the run's own output decides the outcome. Returns the
 * provider's error text for a failed attempt, or null otherwise.
 */
export function providerErrorDetail(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let last = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "assistant") {
      last = list[index];
      break;
    }
  }
  if (last === null || last.stopReason !== "error") return null;
  return typeof last.errorMessage === "string" && last.errorMessage !== ""
    ? last.errorMessage
    : "the provider reported an error";
}

function recordHits(run, result) {
  let returned = 0;
  for (const [arrayKey, fallbackGroup] of Object.entries(GROUP_BY_ARRAY)) {
    for (const hit of ensureArray(result?.[arrayKey])) {
      if (!hit || typeof hit.ref !== "string" || hit.ref === "") continue;
      const group = GROUP_BY_KIND[hit.kind] ?? fallbackGroup;
      // Remote candidates are never selectable or returned until an approval
      // receiver exists (D4); a remote ref is not a valid submission.
      if (group === "remote") continue;
      returned += 1;
      run.hits.set(hit.ref, { group, hit });
    }
  }
  return returned;
}

function collectWarnings(run, warnings) {
  for (const warning of ensureArray(warnings)) {
    const text = String(warning);
    if (!run.warnings.includes(text)) run.warnings.push(text);
  }
}

function errorToolResult(text) {
  return { content: [{ type: "text", text }], details: { error: text }, isError: true };
}

function capabilitySearchTool(run) {
  return {
    name: CAPABILITY_SEARCH_TOOL_NAME,
    label: "Capability Search",
    description: toolsPrompt.search.description,
    parameters: CAPABILITY_SEARCH_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      if (run.submission) {
        return errorToolResult(
          "A submission was already accepted; this run is closing and no further searches are needed.",
        );
      }
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      if (query === "") return errorToolResult("capability_search requires a non-empty query string.");
      const src = params?.src;
      if (src !== "local") {
        if (src === "remote" || src === "all") return errorToolResult(CAPABILITY_REMOTE_SEARCH_DISABLED);
        return errorToolResult('capability_search requires src to be "local".');
      }
      let result;
      try {
        result = await run.broker.search({ query, src, cwd: run.cwd, signal: signal ?? run.signal });
      } catch (error) {
        run.warnings.push(`capability_search("${query}", ${src}) failed: ${errorMessage(error)}`);
        return errorToolResult(
          `Search failed: ${errorMessage(error)}. The search did not complete, so this is not evidence that nothing matches; ` +
            "retry with the same or a different query.",
        );
      }
      const returned = recordHits(run, result);
      collectWarnings(run, result?.warnings);
      if (result?.status === "failed") {
        const detail = ensureArray(result.warnings).join("; ") || "the broker reported a failed search";
        return errorToolResult(
          `Search failed: ${detail}. The search did not complete, so this is not evidence that nothing matches; ` +
            "retry with the same or a different query.",
        );
      }
      run.completedSearches += 1;
      if (returned === 0 && !run.emptyQueries.includes(query)) run.emptyQueries.push(query);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

function submitResultTool(run) {
  return {
    name: SUBMIT_RESULT_TOOL_NAME,
    label: "Submit Result",
    description: toolsPrompt.submit.description,
    parameters: SUBMIT_RESULT_PARAMETERS,
    async execute(_toolCallId, params) {
      if (run.submission) return errorToolResult("A submission was already accepted; the run is ending.");
      const raw = params?.refs;
      if (!Array.isArray(raw) || raw.some((ref) => typeof ref !== "string")) {
        return errorToolResult("submit_result requires refs to be an array of strings.");
      }
      const refs = [];
      for (const value of raw) {
        const ref = value.trim();
        if (ref !== "" && !refs.includes(ref)) refs.push(ref);
      }
      const unknown = refs.filter((ref) => !run.hits.has(ref));
      if (unknown.length > 0) {
        return errorToolResult(
          `Unknown ref(s): ${unknown.join(", ")}. Only refs returned by ${CAPABILITY_SEARCH_TOOL_NAME} in this run are real; ` +
            "search again and submit the exact refs from the results.",
        );
      }
      if (refs.length === 0 && run.completedSearches === 0) {
        return errorToolResult(
          `An empty submission means no relevant capability exists, but no ${CAPABILITY_SEARCH_TOOL_NAME} call has completed in ` +
            "this run. Search first; if the searches fail, that failure must not be reported as a no-match.",
        );
      }
      run.submission = { refs };
      return {
        content: [
          {
            type: "text",
            text:
              refs.length === 0
                ? policyPrompt.submissionEmpty
                : policyPrompt.submissionAccepted.replace("{count}", String(refs.length)),
          },
        ],
        details: { accepted: true, refs },
        terminate: true,
      };
    },
  };
}

function abortRunSession(run) {
  const pending = run.session?.abort?.();
  if (pending && typeof pending.catch === "function") pending.catch(() => {});
}

function budgetStopMessage(terminal) {
  if (terminal?.error?.code === "job_expired") {
    return "capability discovery failed: the internal discovery time limit expired before a submission was accepted.";
  }
  const dimension = terminal?.error?.detail?.dimension;
  return `capability discovery failed: the internal discovery budget was exhausted${dimension ? ` (${dimension})` : ""}.`;
}

/**
 * Pre-debit stop check for the shared budget hook: once a submission is
 * accepted (batched calls) or the run is already finishing (cancellation), no
 * further provider request may be dispatched.
 */
function beforeModelRequest(run) {
  return () => {
    if (run.submission) return { stop: true, reason: "A submission was already accepted." };
    if (run.stop) return { stop: true, reason: run.stop.message };
    return undefined;
  };
}

/**
 * The internal model is close to its discovery budget: finish by submitting
 * instead of exploring further.
 */
export function capabilityBudgetWarning(warning) {
  return `${warning}\n\n${policyPrompt.budgetWrapUp}`;
}

/**
 * Abort the run when Active Time or the lifetime lease expires. Model Calls are
 * charged by the shared budget hook; these bounds are wall-clock, so they need
 * their own deadline timer.
 */
function watchBudget(budget, onExpire) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const state = budget.check();
    if (state.terminal) {
      if (state.terminal.status === "failed") onExpire(state.terminal);
      return;
    }
    const detail = budget.snapshot({ detail: true });
    const lifetimeRemaining = detail.profile.lifetimeMs - detail.elapsedMs;
    const activeRemaining = detail.running
      ? detail.profile.activeTimeMs.hard - detail.activeTimeMs
      : Number.POSITIVE_INFINITY;
    const delay = Math.max(1, Math.min(lifetimeRemaining, activeRemaining));
    timer = setTimeout(schedule, delay);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

function submissionResult(run) {
  const groups = { tools: [], mcp: [], skills: [], remote: [] };
  for (const ref of run.submission.refs) {
    const record = run.hits.get(ref);
    if (!record) continue;
    groups[record.group].push(cloneHit(record.hit));
  }
  return {
    status: run.warnings.length > 0 ? "partial" : "ok",
    tools: groups.tools,
    mcp: groups.mcp,
    skills: groups.skills,
    remote: [],
    coverage: capabilityCoverage(run),
    missingCapabilities:
      run.submission.refs.length === 0 ? run.emptyQueries.slice(0, MISSING_QUERIES) : [],
    warnings: [...run.warnings],
  };
}

function settleRun(run, thrown, budget) {
  const coverage = capabilityCoverage(run);
  if (run.submission) return submissionResult(run);
  if (run.stop?.code === "cancelled") return capabilityFailureResult(run.stop.message, run.warnings, coverage);
  if (run.stop?.code === "budget") return capabilityFailureResult(run.stop.message, run.warnings, coverage);
  const terminal = budget.check().terminal;
  if (terminal && terminal.status === "failed") {
    return capabilityFailureResult(budgetStopMessage(terminal), run.warnings, coverage);
  }
  if (thrown) {
    return capabilityFailureResult(
      `capability discovery failed: the internal retrieval model errored: ${errorMessage(thrown)}.`,
      run.warnings,
      coverage,
    );
  }
  return capabilityFailureResult(
    "capability discovery failed: the internal retrieval agent finished without an accepted submission.",
    run.warnings,
    coverage,
  );
}

/**
 * Build one discovery engine over injected dependencies.
 *
 * `openSession(request)` must start the isolated internal session over the
 * caller's inherited native context and resolve to `{ prompt, abort, dispose }`;
 * `dispose()` may be async and is awaited. The request carries `instructions`
 * (the retrieval addendum the host appends to the inherited system prompt), the
 * two `customTools`, the run's `budget` (fixed internal profile), `beforeRequest`
 * (a pre-debit stop check the host must install as the session's pre-provider-
 * request hook together with the shared Model Call debit: when it returns
 * `{ stop: true }` the request must not be dispatched) and the caller `signal`.
 *
 * `prompt(text)` resolves to the assistant messages of that run. A provider
 * failure stays a resolved native prompt, so the adapter hands this run's own
 * output back and the engine classifies it instead of reporting a generic
 * "no submission".
 */
export function createCapabilityDiscovery({ broker, openSession } = {}) {
  if (!broker || typeof broker.search !== "function") {
    throw new TypeError("createCapabilityDiscovery requires a broker with search().");
  }
  if (typeof openSession !== "function") {
    throw new TypeError("createCapabilityDiscovery requires an openSession().");
  }

  return {
    /**
     * Run one discovery. Never throws for expected failure classes: caller
     * cancellation, model errors and budget exhaustion all come back as
     * `status: "failed"` with an explicit warning, never as an empty "no match".
     */
    async discover({ cwd, signal } = {}) {
      const run = {
        broker,
        cwd,
        signal,
        hits: new Map(),
        warnings: [],
        emptyQueries: [],
        completedSearches: 0,
        submission: null,
        stop: null,
        session: null,
      };
      if (signal?.aborted) {
        return capabilityFailureResult(
          "capability discovery cancelled: the caller aborted before the internal session started.",
        );
      }

      const budget = createJobBudget({ profile: CAPABILITY_DISCOVERY_BUDGET });
      let session = null;
      let stopWatch = null;
      let onAbort = null;
      try {
        session = await openSession({
          instructions: CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
          customTools: [capabilitySearchTool(run), submitResultTool(run)],
          budget,
          beforeRequest: beforeModelRequest(run),
          signal,
        });
        run.session = session;
        // Opening the session can take long enough for the caller to abort; an
        // already-aborted signal must not become a prompt, and the abort
        // listener below would only fire on a later abort.
        if (signal?.aborted) {
          if (run.stop === null) {
            run.stop = {
              code: "cancelled",
              message: "capability discovery cancelled: the caller aborted while the internal session was starting.",
            };
          }
          abortRunSession(run);
          return settleRun(run, null, budget);
        }
        budget.startActive();
        stopWatch = watchBudget(budget, (terminal) => {
          if (run.stop === null) run.stop = { code: "budget", message: budgetStopMessage(terminal) };
          abortRunSession(run);
        });
        if (signal) {
          onAbort = () => {
            if (run.stop === null) {
              run.stop = {
                code: "cancelled",
                message: "capability discovery cancelled: the caller aborted before a submission was accepted.",
              };
            }
            abortRunSession(run);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
        let thrown = null;
        let settled = null;
        try {
          settled = await session.prompt(CAPABILITY_DISCOVERY_PROMPT);
        } catch (error) {
          thrown = error;
        }
        if (settled !== null && run.submission === null && run.stop === null) {
          const detail = providerErrorDetail(settled);
          if (detail !== null) thrown = new Error(`the provider request failed: ${detail}`);
        }
        return settleRun(run, thrown, budget);
      } catch (error) {
        if (signal?.aborted) {
          return capabilityFailureResult(
            "capability discovery cancelled: the caller aborted while the internal retrieval session was starting.",
            run.warnings,
            capabilityCoverage(run),
          );
        }
        return capabilityFailureResult(
          `capability discovery failed: could not run the internal retrieval session: ${errorMessage(error)}.`,
          run.warnings,
          capabilityCoverage(run),
        );
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        if (stopWatch) stopWatch();
        budget.pauseActive();
        if (budget.terminal === null) {
          budget.terminate({ reason: run.submission ? "model_final" : "cancelled" });
        }
        try {
          // The shared Subagent execution owns the session and its cleanups; its
          // dispose is idempotent and also waits for the aborted run to go idle.
          await session?.dispose?.();
        } catch {
          // Teardown failures must not replace the already-decided run result.
        }
      }
    },
  };
}
