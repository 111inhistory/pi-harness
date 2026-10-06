/**
 * Pi 0.99 adapter for the Pi-independent Job Budget state machine
 * (./job-budget.mjs): Model Call debits and the one-shot soft warning on a live
 * AgentSession.
 *
 * The debit guards `agent.streamFunction` — the one boundary every provider
 * request crosses (verified against the installed package): the agent loop
 * calls it for each assistant response, and `AgentSession._runDefaultCompaction`
 * passes the same function to `compact(...)` for automatic and manual
 * compaction, where provider-side summarization retries go through it again.
 * Debiting here counts ordinary calls, compaction summaries and retries exactly
 * once each, and the pre-debit stop check refuses any of them before dispatch.
 *
 * `agent.prepareRequest` is still chained (Pi's own handler there computes the
 * transcript projection and virtual-model routing) and carries the one-shot
 * soft warning into the next conversational request. It never debits, so no
 * request is charged twice.
 *
 * Active Time and lifetime leases stay with the caller: this module only wires
 * the per-request debit, the refusal and the soft warning, and never calls the
 * budget's timer-facing API.
 *
 * Known consequence of wrapping the stream boundary: Pi's
 * `_getSummarizationRequestAuth` treats a non-default `streamFunction` as
 * self-authenticating (it resolves credentials tolerantly instead of requiring
 * them). Job sessions run on their parent session's authenticated ModelRuntime,
 * so compaction still resolves the same credentials; this only changes which
 * error surfaces when a provider has no usable auth at all.
 */

/** A refused provider request. Carries the budget's terminal record. */
export class ModelCallBudgetError extends Error {
  constructor(terminal) {
    const code = terminal?.error?.code ?? "budget_exceeded";
    super(`Model request refused by the job budget (${code}).`);
    this.name = "ModelCallBudgetError";
    this.code = code;
    this.terminal = terminal ?? null;
  }
}

function hookUnavailable() {
  const error = new Error(
    "installModelCallBudget requires a live AgentSession with an agent whose streamFunction can be wrapped.",
  );
  error.code = "budget_hook_unavailable";
  return error;
}

function abortSession(session) {
  const pending = session.abort?.();
  if (pending && typeof pending.catch === "function") pending.catch(() => {});
}

/**
 * Install the per-request budget hook on a live AgentSession.
 *
 * Every provider request — conversational, compaction or retry — passes the
 * stream wrapper, which runs `beforeRequest()` (the optional pre-debit stop
 * check), charges one Model Call, and refuses (abort + throw) before dispatch
 * once the budget is exhausted. Once the budget reports its soft phase, the
 * next conversational request gets the soft warning appended to its effective
 * context; compaction requests never carry it.
 *
 * @param {{ agent?: object, abort?: Function }} session live AgentSession.
 * @param {object} budget Job Budget from ./job-budget.mjs.
 * @param {{
 *   beforeRequest?: () => ({ stop?: boolean, reason?: string } | undefined),
 *   warningText?: (canonicalWarning: string) => string,
 * }} [options]
 * @returns {() => void} cleanup; restores the previous handlers only while this
 *   installer's wrappers are still the current ones, and never throws.
 */
export function installModelCallBudget(session, budget, { beforeRequest, warningText } = {}) {
  const agent = session?.agent;
  if (!agent || typeof agent !== "object" || typeof agent.streamFunction !== "function") {
    throw hookUnavailable();
  }
  const previousStream = agent.streamFunction;
  const previousPrepare = agent.prepareRequest;
  const streamWrapper = (model, context, options) => {
    const decision = typeof beforeRequest === "function" ? beforeRequest() : undefined;
    if (decision && decision.stop) {
      abortSession(session);
      throw new Error(decision.reason ?? "Model request refused.");
    }
    const debit = budget.beginModelCall();
    if (!debit.ok) {
      abortSession(session);
      throw new ModelCallBudgetError(debit.terminal);
    }
    return previousStream.call(agent, model, context, options);
  };
  const prepareWrapper = async (request, signal) => {
    const update = typeof previousPrepare === "function" ? await previousPrepare.call(agent, request, signal) : undefined;
    const warning = budget.takeWarning();
    if (warning === null) return update;
    const text = typeof warningText === "function" ? warningText(warning) : warning;
    const context = update?.context ?? request.context;
    if (!context || !Array.isArray(context.messages)) return update;
    return {
      ...(update ?? {}),
      context: {
        ...context,
        messages: [
          ...context.messages,
          { role: "user", content: [{ type: "text", text: String(text) }], timestamp: Date.now() },
        ],
      },
    };
  };
  agent.streamFunction = streamWrapper;
  agent.prepareRequest = prepareWrapper;
  return () => {
    if (agent.streamFunction === streamWrapper) agent.streamFunction = previousStream;
    if (agent.prepareRequest === prepareWrapper) agent.prepareRequest = previousPrepare;
  };
}
