/**
 * Routing configuration validation and the candidate-level thinking decision.
 *
 * A Fresh route selects a role and then a model from that role's candidate
 * pool. Each candidate owns its final thinking level directly; there is no
 * role default and no min/max band to clamp. Choosing a model from a pool with
 * differing candidate levels therefore also chooses the thinking level.
 */

export const ROUTING_THINKING_LEVELS = ["low", "medium", "high"] as const;
export type RoutingThinkingLevel = (typeof ROUTING_THINKING_LEVELS)[number];

export interface RoutingClassifierConfig {
  provider: string;
  id: string;
}

export interface RoutingInstructions {
  role: string;
  model: string;
}

export interface RoutingCandidate {
  model: string;
  thinking: RoutingThinkingLevel;
}

export interface RoutingRole {
  id: string;
  instructions: string;
  excludeTools: string[];
  enableTools?: string[];
  candidates: RoutingCandidate[];
}

export interface RoutingModel {
  id: string;
  provider: string;
  model: string;
  preference: string;
}

export interface RoutingConfig {
  version: 2;
  classifier: RoutingClassifierConfig;
  instructions: RoutingInstructions;
  roles: RoutingRole[];
  models: RoutingModel[];
}

export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigError";
  }
}

function invalid(message: string): never {
  throw new RoutingConfigError(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function filled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exactToolNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => filled(name) && !/[?*]/.test(name));
}

export function isRoutingThinkingLevel(value: unknown): value is RoutingThinkingLevel {
  return typeof value === "string" && (ROUTING_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Validate routing configuration with thinking defined only by each candidate.
 */
export function validateRoutingConfig(value: unknown): RoutingConfig {
  const config = record(value);
  if (config === null || config.version !== 2) invalid("must be a version 2 JSON object");

  const classifier = record(config.classifier);
  if (classifier === null || !filled(classifier.provider) || !filled(classifier.id)) {
    invalid("classifier needs a provider and an id");
  }
  const instructions = record(config.instructions);
  if (instructions === null || !filled(instructions.role) || !filled(instructions.model)) {
    invalid("instructions need the role and model text");
  }
  if (!Array.isArray(config.roles) || config.roles.length === 0) invalid("roles must be a non-empty array");
  if (!Array.isArray(config.models) || config.models.length === 0) invalid("models must be a non-empty array");

  const modelIds = new Set<string>();
  const models: RoutingModel[] = [];
  for (const [index, raw] of (config.models as unknown[]).entries()) {
    const model = record(raw);
    if (model === null || !filled(model.id) || modelIds.has(model.id)) invalid(`models[${index}] needs a unique id`);
    if (!filled(model.provider) || !filled(model.model) || !filled(model.preference)) {
      invalid(`models[${index}] needs provider, model and preference`);
    }
    modelIds.add(model.id);
    models.push({
      id: model.id,
      provider: model.provider,
      model: model.model,
      preference: model.preference,
    });
  }

  const roleIds: string[] = [];
  const roles: RoutingRole[] = [];
  for (const [index, raw] of (config.roles as unknown[]).entries()) {
    const role = record(raw);
    if (role === null || !filled(role.id) || roleIds.includes(role.id)) invalid(`roles[${index}] needs a unique id`);
    if (!filled(role.instructions)) invalid(`roles[${index}] needs instructions`);
    if (Object.hasOwn(role, "tools")) invalid(`roles[${index}].tools is no longer supported; use excludeTools`);
    if (!exactToolNames(role.excludeTools)) invalid(`roles[${index}].excludeTools must be exact tool names`);
    if (role.enableTools !== undefined && !exactToolNames(role.enableTools)) {
      invalid(`roles[${index}].enableTools must be exact tool names`);
    }
    if (!Array.isArray(role.candidates) || role.candidates.length === 0) {
      invalid(`roles[${index}].candidates must be non-empty`);
    }

    const poolIds = new Set<string>();
    const candidates: RoutingCandidate[] = [];
    for (const rawCandidate of role.candidates as unknown[]) {
      const candidate = record(rawCandidate);
      if (candidate === null || !filled(candidate.model) || !modelIds.has(candidate.model) || poolIds.has(candidate.model)) {
        invalid(`roles[${index}].candidates needs unique refs to global models`);
      }
      if (!isRoutingThinkingLevel(candidate.thinking)) {
        invalid(`roles[${index}].candidates thinking must be low, medium or high`);
      }
      poolIds.add(candidate.model);
      candidates.push({ model: candidate.model, thinking: candidate.thinking });
    }

    roleIds.push(role.id);
    const validated: RoutingRole = {
      id: role.id,
      instructions: role.instructions,
      excludeTools: [...role.excludeTools],
      candidates,
    };
    if (role.enableTools !== undefined) validated.enableTools = [...role.enableTools];
    roles.push(validated);
  }

  const classifierConfig: RoutingClassifierConfig = {
    provider: classifier.provider,
    id: classifier.id,
  };
  const instructionConfig: RoutingInstructions = {
    role: instructions.role,
    model: instructions.model,
  };
  return { version: 2, classifier: classifierConfig, instructions: instructionConfig, roles, models };
}

/** The selected candidate is the only source of a Fresh route's thinking level. */
export function candidateThinking(candidate: RoutingCandidate): RoutingThinkingLevel {
  if (!isRoutingThinkingLevel(candidate.thinking)) {
    throw new RoutingConfigError("candidate thinking must be low, medium or high");
  }
  return candidate.thinking;
}

/**
 * Check a direct level against the model's advertised capability. Catalogs
 * without an explicit map/reasoning flag are left to Pi's own clamp; an
 * explicit unsupported level is reported instead of silently rewritten.
 */
export function modelSupportsThinking(
  model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> },
  level: RoutingThinkingLevel,
): boolean {
  if (model.reasoning === false) return false;
  const map = model.thinkingLevelMap;
  if (map !== undefined && Object.hasOwn(map, level) && map[level] === null) return false;
  return true;
}


import { readFileSync } from 'node:fs';
import { composeAssignment } from './prompt.ts';
import { isRetryableAssistantError, retryDelayMs, type Api, type Model, type ClassifierApi, type ClassifierModel, type ClassifierContext, type ClassifierChoiceQuestion } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { JobBudgetPort } from './runtime.ts';

export interface RouteSubagentInput {
  readonly registry: Pick<ModelRegistry, 'find' | 'findOfType' | 'classify'>;
  readonly task: string;
  readonly context?: string | null;
  readonly signal?: AbortSignal | undefined;
  readonly budget: Pick<JobBudgetPort, 'beginModelCall'>;
  readonly configPath?: string;
  readonly config?: unknown;
}
export interface SubagentRoute {
  readonly roleId: string;
  readonly instructions: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: RoutingThinkingLevel;
  readonly excludeTools: readonly string[];
  readonly enableTools: readonly string[];
}
/** Harness-owned routing error with a stable machine-readable code. */
export class SubagentRoutingError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "SubagentRoutingError";
    this.code = code;
    this.detail = detail;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidConfigError(message: string): SubagentRoutingError {
  return new SubagentRoutingError("routing_invalid_config", `Invalid routing config: ${message}`, {});
}

/**
 * Validate the parsed routing config inline. Unknown fields are ignored, but
 * each candidate carries its final thinking level directly.
 */
function validateConfig(value: unknown): RoutingConfig {
  try {
    return validateRoutingConfig(value);
  } catch (error) {
    if (error instanceof RoutingConfigError) throw invalidConfigError(error.message);
    throw error;
  }
}

/** Read the explicit Pi user config for each new Fresh route; no bundled fallback. */
export function loadSubagentRoutingConfig(path: string | undefined): RoutingConfig {
  if (!filled(path)) throw invalidConfigError("configPath must name the Pi user's subagent-routing.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfigError(`cannot read ${path}: ${messageOf(error)}`);
  }
  return validateConfig(parsed);
}

function resolveClassifier(registry: RouteSubagentInput['registry'], classifier: RoutingClassifierConfig): ClassifierModel<ClassifierApi> {
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

function resolveChatModel(registry: RouteSubagentInput['registry'], candidate: RoutingModel): Model<Api> {
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

function abortedError(stage: number): SubagentRoutingError {
  return new SubagentRoutingError("routing_aborted", `Routing aborted before classifier call ${stage}.`, { stage });
}

function classificationFailedError(stage: number, classifier: ClassifierModel<ClassifierApi>, nativeError: string): SubagentRoutingError {
  return new SubagentRoutingError(
    "routing_classification_failed",
    `Classifier call ${stage} (${classifier.provider}/${classifier.id}) failed: ${nativeError}`,
    { stage, model: `${classifier.provider}/${classifier.id}`, nativeError },
  );
}

function invalidAnswerError(stage: number, key: string, reason: string): SubagentRoutingError {
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
function transientClassifierFailure(nativeError: unknown): boolean {
  return typeof nativeError === "string"
    // The SDK helper reads only stopReason/errorMessage; it declares the full
    // assistant type even though routing errors have no assistant transcript.
    && (isRetryableAssistantError as (message: { stopReason: 'error'; errorMessage: string }) => boolean)({ stopReason: "error", errorMessage: nativeError });
}

/** Exponential retry delay with SDK-style bounded jitter. `attempt` is 1-indexed. */
function classifierRetryDelayMs(attempt: number): number {
  const delay = retryDelayMs(
    { baseDelayMs: CLASSIFIER_RETRY.baseDelayMs, maxAgentDelayMs: CLASSIFIER_RETRY.maxDelayMs },
    attempt,
  );
  return Math.max(0, Math.round(delay * (1 - Math.random() * CLASSIFIER_RETRY.jitterRatio)));
}

/** Resolve after the backoff delay, or early when the Job is cancelled. */
function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
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
function selectLabel(stage: number, key: string, answers: unknown, criteria: Record<string, string>): string {
  const candidate = record(answers)?.[key];
  const answer = record(candidate);
  const labels = Object.keys(criteria);
  if (!answer || answer.type !== "choice" || typeof answer.choice !== 'string' || !labels.includes(answer.choice)) {
    throw invalidAnswerError(stage, key, `expected one of ${labels.join(", ")} as ${key}, got ${JSON.stringify(answer?.choice)}`);
  }
  let chosen = labels[0]!;
  let peak = -Infinity;
  for (const label of labels) {
    const probability = record(answer.probabilities)?.[label];
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
async function classifyChoice({ stage, key, registry, classifier, signal, budget, state, question }: {
  stage: number; key: string; registry: RouteSubagentInput['registry']; classifier: ClassifierModel<ClassifierApi>;
  signal: AbortSignal | undefined; budget: RouteSubagentInput['budget']; state: ClassifierContext['state']; question: ClassifierChoiceQuestion;
}): Promise<string> {
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
      result = await registry.classify(classifier, { state, questions: { [key]: question } }, { ...(signal === undefined ? {} : { signal }), maxRetries: 0 });
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
  throw classificationFailedError(stage, classifier, "No classifier attempt completed.");
}

/**
 * Route one Job: classify the role over `delegated_assignment`; a multi-model
 * role pool adds one model call over the assignment plus selected role text.
 * Global models own Preferences; role pool entries own thinking levels.
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
export async function routeSubagent({ registry, task, context = "", signal, budget, config, configPath }: RouteSubagentInput): Promise<SubagentRoute> {
  const routing = config === undefined ? loadSubagentRoutingConfig(configPath) : validateConfig(config);
  const batchContext = context ?? "";
  if (typeof task !== "string" || task.trim() === "" || typeof batchContext !== "string") {
    throw new SubagentRoutingError("routing_invalid_input", "routeSubagent requires a non-empty task and a string context.", {});
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
  const role = roleById.get(roleId)!;

  const pool = role.candidates;
  const modelId = pool.length === 1 ? pool[0]!.model : await classifyChoice({
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
      criteria: Object.fromEntries(pool.map((candidate) => [candidate.model, modelById.get(candidate.model)!.preference])),
    },
  });
  const candidate = pool.find((entry) => entry.model === modelId)!;
  const model = modelById.get(modelId)!;
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
