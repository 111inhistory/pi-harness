/**
 * Fresh-subagent routing: Jev selects a role, then a model from that role's
 * pool (singleton pools select directly), plus local thinking synthesis.
 *
 * `routeSubagent` composes the batch assignment (the same rule as the child
 * prompt), asks the classifier once for the role over the full assignment
 * (with a bounded retry for transient transport failures), appends the actual
 * selected role text to the state, asks once for the model, and returns the
 * role instructions, the catalog chat model object, the selected candidate's
 * direct thinking level, and the role tool whitelist. Selecting a model from a
 * pool with differing candidate levels therefore also selects the thinking
 * level; there is no role default to clamp it. Tool registration, depth harness
 * tools and the child prompt stay with the adapter.
 *
 * There is one logical role call and, for multi-model pools, one logical model
 * call; no fallback: a missing catalog entry, a final classifier error
 * (including missing provider credentials), an abort or a budget refusal
 * throws SubagentRoutingError instead of degrading into a silent selection.
 */

import { readFileSync } from "node:fs";
import { composeAssignment } from "./subagent/prompt.ts";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
import {
  RoutingConfigError,
  candidateThinking,
  modelSupportsThinking,
  validateRoutingConfig,
} from "./subagent/routing.ts";

/** Harness-owned routing error with a stable machine-readable code. */
export class SubagentRoutingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SubagentRoutingError";
    this.code = code;
    this.detail = detail;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Non-empty text; used for identifiers and prompt prose alike. */
function filled(value) {
  return typeof value === "string" && value.trim() !== "";
}

function invalidConfigError(message) {
  return new SubagentRoutingError("routing_invalid_config", `Invalid routing config: ${message}`, {});
}

/**
 * Validate the parsed routing config inline. Unknown fields are ignored, but
 * each candidate carries its final thinking level directly.
 */
function validateConfig(value) {
  try {
    return validateRoutingConfig(value);
  } catch (error) {
    if (error instanceof RoutingConfigError) throw invalidConfigError(error.message);
    throw error;
  }
}

/** Read the explicit Pi user config for each new Fresh route; no bundled fallback. */
export function loadSubagentRoutingConfig(path) {
  if (!filled(path)) throw invalidConfigError("configPath must name the Pi user's subagent-routing.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfigError(`cannot read ${path}: ${messageOf(error)}`);
  }
  return validateConfig(parsed);
}

function resolveClassifier(registry, classifier) {
  const model = registry.findOfType("classifier", classifier.provider, classifier.id);
  if (!model) {
    throw new SubagentRoutingError(
      "routing_classifier_unavailable",
      `Classifier ${classifier.provider}/${classifier.id} is not in the model catalog.`,
      { provider: classifier.provider, id: classifier.id },
    );
  }
  return model;
}

function resolveChatModel(registry, candidate) {
  const model = registry.find(candidate.provider, candidate.model);
  if (!model) {
    throw new SubagentRoutingError(
      "routing_model_unavailable",
      `Selected model ${candidate.provider}/${candidate.model} is not in the model catalog.`,
      { candidate: candidate.id },
    );
  }
  if (model.type !== undefined && model.type !== "chat") {
    throw new SubagentRoutingError(
      "routing_model_invalid",
      `Selected model ${candidate.provider}/${candidate.model} is a ${model.type} model, not a chat model.`,
      { candidate: candidate.id },
    );
  }
  return model;
}

function abortedError(stage) {
  return new SubagentRoutingError("routing_aborted", `Routing aborted before classifier call ${stage}.`, { stage });
}

function classificationFailedError(stage, classifier, nativeError) {
  return new SubagentRoutingError(
    "routing_classification_failed",
    `Classifier call ${stage} (${classifier.provider}/${classifier.id}) failed: ${nativeError}`,
    { stage, model: `${classifier.provider}/${classifier.id}`, nativeError },
  );
}

function invalidAnswerError(stage, key, reason) {
  return new SubagentRoutingError("routing_invalid_answer", `Classifier call ${stage} did not decide ${key}: ${reason}.`, { stage, key });
}

/**
 * Bounded retry policy for one idempotent routing classifier request. The SDK
 * provider retry is disabled for these calls (`maxRetries: 0`), so every
 * physical HTTP attempt is debited and timed here exactly once. The delays and
 * jitter mirror the SDK provider policy: 0.5s, 1s, ... capped at 8s, shortened
 * by up to 25%; a routing call makes at most three physical attempts.
 */
const CLASSIFIER_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
});

/** Whether the SDK's transient-provider classifier considers a failure retryable. */
function transientClassifierFailure(nativeError) {
  return typeof nativeError === "string"
    && isRetryableAssistantError({ stopReason: "error", errorMessage: nativeError });
}

/** Exponential retry delay with SDK-style bounded jitter. `attempt` is 1-indexed. */
function classifierRetryDelayMs(attempt) {
  const delay = retryDelayMs(
    { baseDelayMs: CLASSIFIER_RETRY.baseDelayMs, maxAgentDelayMs: CLASSIFIER_RETRY.maxDelayMs },
    attempt,
  );
  return Math.max(0, Math.round(delay * (1 - Math.random() * CLASSIFIER_RETRY.jitterRatio)));
}

/** Resolve after the backoff delay, or early when the Job is cancelled. */
function waitForRetry(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    // An abort can land between the check above and listener registration.
    if (signal?.aborted) onAbort();
  });
}

/**
 * The decided label: the deterministic argmax over the answer's probabilities
 * across the configured criteria, ties keeping the configured order (the rule
 * the native reference classifier applies). The answer's label must name a
 * configured criterion; a malformed answer throws instead of defaulting.
 */
function selectLabel(stage, key, answers, criteria) {
  const answer = answers?.[key];
  const labels = Object.keys(criteria);
  if (!answer || answer.type !== "choice" || !labels.includes(answer.choice)) {
    throw invalidAnswerError(stage, key, `expected one of ${labels.join(", ")} as ${key}, got ${JSON.stringify(answer?.choice)}`);
  }
  let chosen = null;
  let peak = -Infinity;
  for (const label of labels) {
    const probability = answer.probabilities?.[label];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0) {
      throw invalidAnswerError(stage, key, `no usable probability for ${label}`);
    }
    if (probability > peak) {
      chosen = label;
      peak = probability;
    }
  }
  if (peak === 0) throw invalidAnswerError(stage, key, "every criterion has probability zero");
  return chosen;
}

/**
 * One logical classifier question. Each physical attempt takes its own Job
 * budget debit and honors the abort signal before the debit and dispatch. Only
 * a transient provider/transport failure is retried; auth/config failures,
 * malformed answers and protocol/parse errors fail on their first attempt.
 */
async function classifyChoice({ stage, key, registry, classifier, signal, budget, state, question }) {
  if (signal?.aborted) throw abortedError(stage);

  for (let attempt = 1; attempt <= CLASSIFIER_RETRY.maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortedError(stage);
    const debit = budget.beginModelCall();
    if (!debit || debit.ok !== true) {
      const terminal = debit?.terminal ?? null;
      throw new SubagentRoutingError(terminal?.error?.code ?? "budget_exceeded", `Routing stopped: the Job budget refused classifier call ${stage}.`, {
        stage,
        reason: debit?.reason ?? null,
        terminal,
      });
    }
    if (signal?.aborted) throw abortedError(stage);

    let result;
    let nativeError;
    try {
      // The routing retry loop is the only retry layer: a provider request
      // must correspond to one debit, never to an unknown inner attempt count.
      result = await registry.classify(classifier, { state, questions: { [key]: question } }, { signal, maxRetries: 0 });
    } catch (error) {
      if (signal?.aborted) throw abortedError(stage);
      nativeError = messageOf(error);
    }
    if (result !== undefined) {
      if (signal?.aborted || result?.stopReason === "aborted") throw abortedError(stage);
      if (result?.stopReason === "stop") return selectLabel(stage, key, result.answers, question.criteria);
      nativeError = result?.errorMessage ?? "the classifier returned no usable result";
    }

    const finalError = nativeError ?? "the classifier returned no usable result";
    if (attempt < CLASSIFIER_RETRY.maxAttempts && transientClassifierFailure(finalError)) {
      if (!(await waitForRetry(classifierRetryDelayMs(attempt), signal))) throw abortedError(stage);
      if (signal?.aborted) throw abortedError(stage);
      continue;
    }
    throw classificationFailedError(stage, classifier, finalError);
  }
}

/**
 * Route one Job: classify the role over `delegated_assignment`; a multi-model
 * role pool adds one model call over the assignment plus selected role text.
 * Global models own Preferences; role pool entries own thinking bands.
 *
 * @param {object} input
 * @param {object} input.registry Model registry with findOfType/classify/find.
 * @param {string} input.task The Job's task text, used unmodified.
 * @param {string} [input.context] Batch context shared by the batch.
 * @param {AbortSignal} [input.signal] Cancellation of the calling run.
 * @param {{beginModelCall: () => object}} input.budget The Job budget.
 * @param {string} [input.configPath] Pi user routing config path, supplied by the adapter.
 * @param {object} [input.config] Parsed config for tests/internal callers.
 * @returns {Promise<{roleId: string, instructions: string, model: object, thinkingLevel: string, excludeTools: string[], enableTools: string[]}>}
 */
export async function routeSubagent({ registry, task, context = "", signal, budget, config, configPath } = {}) {
  const routing = config === undefined ? loadSubagentRoutingConfig(configPath) : validateConfig(config);
  const batchContext = context ?? "";
  if (typeof task !== "string" || task.trim() === "" || typeof batchContext !== "string") {
    throw new SubagentRoutingError("routing_invalid_input", "routeSubagent requires a non-empty task and a string context.", {});
  }
  if (typeof budget?.beginModelCall !== "function") {
    throw new SubagentRoutingError("routing_invalid_input", "routeSubagent requires the Job budget with beginModelCall().", {});
  }
  if (typeof registry?.classify !== "function" || typeof registry.findOfType !== "function" || typeof registry.find !== "function") {
    throw new SubagentRoutingError("routing_invalid_input", "routeSubagent requires a model registry with findOfType, classify and find.", {});
  }

  const delegatedAssignment = composeAssignment(task, batchContext);
  const classifier = resolveClassifier(registry, routing.classifier);
  const roleById = new Map(routing.roles.map((role) => [role.id, role]));
  const modelById = new Map(routing.models.map((model) => [model.id, model]));

  const roleId = await classifyChoice({
    stage: 1,
    key: "role",
    registry,
    classifier,
    signal,
    budget,
    state: { delegated_assignment: delegatedAssignment },
    question: {
      type: "choice",
      instructions: routing.instructions.role,
      criteria: Object.fromEntries(routing.roles.map((role) => [role.id, role.instructions])),
    },
  });
  const role = roleById.get(roleId);

  const pool = role.candidates;
  const modelId = pool.length === 1 ? pool[0].model : await classifyChoice({
    stage: 2,
    key: "model",
    registry,
    classifier,
    signal,
    budget,
    state: {
      delegated_assignment: delegatedAssignment,
      selected_role: { id: roleId, instructions: role.instructions },
    },
    question: {
      type: "choice",
      instructions: routing.instructions.model,
      criteria: Object.fromEntries(pool.map((candidate) => [candidate.model, modelById.get(candidate.model).preference])),
    },
  });
  const candidate = pool.find((entry) => entry.model === modelId);
  const model = modelById.get(modelId);
  const chatModel = resolveChatModel(registry, model);
  const thinkingLevel = candidateThinking(candidate);
  if (!modelSupportsThinking(chatModel, thinkingLevel)) {
    throw new SubagentRoutingError(
      "routing_thinking_unsupported",
      `Selected model ${chatModel.provider}/${chatModel.id} does not support thinking level ${thinkingLevel}.`,
      { candidate: candidate.model, thinking: thinkingLevel },
    );
  }

  return {
    roleId,
    instructions: role.instructions,
    model: chatModel,
    thinkingLevel,
    excludeTools: [...role.excludeTools],
    enableTools: [...(role.enableTools ?? [])],
  };
}
