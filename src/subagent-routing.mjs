/**
 * Fresh-subagent routing: the two sequential Jev classifications that select a
 * role and then a model, plus the local thinking synthesis.
 *
 * `routeSubagent` composes the batch assignment (the same rule as the child
 * prompt), asks the classifier once for the role over the full assignment,
 * appends the actual selected role text to the state, asks once for the model,
 * and returns the role instructions, the catalog chat model object, the role
 * level limited to the model's configured band, and the role tool whitelist.
 * Tool registration, depth harness tools and the child prompt stay with the
 * adapter.
 *
 * There are exactly two calls per route and no fallback: a missing catalog
 * entry, a classifier error (including missing provider credentials), an abort
 * or a budget refusal throws SubagentRoutingError instead of degrading into a
 * silent selection.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The single production routing config. */
const CONFIG_URL = new URL("../config/subagent-routing.json", import.meta.url);

/** The automatic path never exceeds high; `max` stays a main-session choice. */
const THINKING_LEVELS = ["low", "medium", "high"];
const THINKING_RANK = { low: 0, medium: 1, high: 2 };

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
 * Validate the parsed routing config inline. Unknown fields are ignored; a
 * missing or malformed essential fails the Job instead of quietly changing a
 * routing dimension.
 */
function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw invalidConfigError("must be a version 1 JSON object");
  }
  const { classifier, instructions, roles, candidates } = value;
  if (!classifier || !filled(classifier.provider) || !filled(classifier.id)) {
    throw invalidConfigError("classifier needs a provider and an id");
  }
  if (!instructions || !filled(instructions.role) || !filled(instructions.model)) {
    throw invalidConfigError("instructions need the role and model text");
  }
  if (!Array.isArray(roles) || roles.length === 0) throw invalidConfigError("roles must be a non-empty array");
  if (!Array.isArray(candidates) || candidates.length === 0) throw invalidConfigError("candidates must be a non-empty array");

  const roleIds = [];
  for (const [index, role] of roles.entries()) {
    if (!role || !filled(role.id) || roleIds.includes(role.id)) throw invalidConfigError(`roles[${index}] needs a unique id`);
    if (!filled(role.instructions) || !THINKING_LEVELS.includes(role.thinking)) {
      throw invalidConfigError(`roles[${index}] needs instructions and a low, medium or high thinking level`);
    }
    if (!Array.isArray(role.tools) || role.tools.length === 0 || !role.tools.every(filled)) {
      throw invalidConfigError(`roles[${index}].tools must be non-empty tool names`);
    }
    roleIds.push(role.id);
  }

  const candidateIds = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || !filled(candidate.id) || candidateIds.includes(candidate.id)) {
      throw invalidConfigError(`candidates[${index}] needs a unique id`);
    }
    if (!filled(candidate.provider) || !filled(candidate.model) || !filled(candidate.preference)) {
      throw invalidConfigError(`candidates[${index}] needs provider, model and preference`);
    }
    const band = candidate.thinking;
    if (!band || !THINKING_LEVELS.includes(band.min) || !THINKING_LEVELS.includes(band.max) || THINKING_RANK[band.min] > THINKING_RANK[band.max]) {
      throw invalidConfigError(`candidates[${index}].thinking must be a low..high band with min <= max`);
    }
    candidateIds.push(candidate.id);
  }
  return value;
}

let cachedConfig = null;

/** The production config, read and validated once per process. */
function routingConfig() {
  if (cachedConfig !== null) return cachedConfig;
  const path = fileURLToPath(CONFIG_URL);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfigError(`cannot read ${path}: ${messageOf(error)}`);
  }
  cachedConfig = validateConfig(parsed);
  return cachedConfig;
}

/**
 * The Job's assignment text: batch context plus the task, assembled with the
 * same rule as the child prompt. Context bytes are preserved; the context is
 * only trimmed to decide whether it is present at all.
 */
function composeAssignment(task, context) {
  return context.trim() === "" ? task : `# Batch context\n\n${context}\n\n# Task\n\n${task}`;
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

/** The role level limited to the candidate's band; Pi does the final clamp. */
function clampThinking(desired, band) {
  const bounded = Math.min(Math.max(THINKING_RANK[desired], THINKING_RANK[band.min]), THINKING_RANK[band.max]);
  return THINKING_LEVELS[bounded];
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
 * One native classifier call. The Job budget is debited before dispatch and
 * the abort signal is honored before the debit and before dispatch, so an
 * aborted or exhausted Job never reaches the provider.
 */
async function classifyChoice({ stage, key, registry, classifier, signal, budget, state, question }) {
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
  try {
    result = await registry.classify(classifier, { state, questions: { [key]: question } }, { signal });
  } catch (error) {
    if (signal?.aborted) throw abortedError(stage);
    throw classificationFailedError(stage, classifier, messageOf(error));
  }
  if (signal?.aborted || result?.stopReason === "aborted") throw abortedError(stage);
  if (!result || result.stopReason !== "stop") {
    throw classificationFailedError(stage, classifier, result?.errorMessage ?? "the classifier returned no usable result");
  }
  return selectLabel(stage, key, result.answers, question.criteria);
}

/**
 * Route one Job: one classifier call for the role over `delegated_assignment`,
 * one for the model over the same state plus the actual selected role text.
 *
 * @param {object} input
 * @param {object} input.registry Model registry with findOfType/classify/find.
 * @param {string} input.task The Job's task text, used unmodified.
 * @param {string} [input.context] Batch context shared by the batch.
 * @param {AbortSignal} [input.signal] Cancellation of the calling run.
 * @param {{beginModelCall: () => object}} input.budget The Job budget.
 * @param {object} [input.config] Parsed config replacing the production JSON; tests/internal only.
 * @returns {Promise<{roleId: string, instructions: string, model: object, thinkingLevel: string, tools: string[]}>}
 */
export async function routeSubagent({ registry, task, context = "", signal, budget, config } = {}) {
  const routing = config === undefined ? routingConfig() : validateConfig(config);
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
  const candidateById = new Map(routing.candidates.map((candidate) => [candidate.id, candidate]));

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

  const modelId = await classifyChoice({
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
      criteria: Object.fromEntries(routing.candidates.map((candidate) => [candidate.id, candidate.preference])),
    },
  });
  const candidate = candidateById.get(modelId);

  return {
    roleId,
    instructions: role.instructions,
    model: resolveChatModel(registry, candidate),
    thinkingLevel: clampThinking(role.thinking, candidate.thinking),
    tools: [...role.tools],
  };
}
