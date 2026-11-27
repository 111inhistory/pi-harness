/**
 * Routing owns role selection and its instructions. Each role's candidates
 * reference named Presets or carry temporary definitions using the same schema.
 */

import { readConfigDocument } from '../config-storage.ts';
import { DEFAULT_HARNESS_CONFIG, type ClassifierModelRef, type RoutingRetryConfig } from '../harness-config.ts';
import { runClassifier } from '../classifier-client.ts';
import { composeAssignment } from './prompt.ts';
import { retryDelayMs, type Api, type Model, type ClassifierContext, type ClassifierChoiceQuestion } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { JobBudgetPort } from './job-budget.ts';
import { validatePreset, type PresetCatalog, type PresetConfig } from '../preset/config.ts';

/** An existing named preset, or a temporary preset with the same schema. */
export type RoutingPreset = string | PresetConfig;


export interface RoutingInstructions {
  role: string;
  model: string;
}

export interface RoutingRole {
  id: string;
  instructions: string;
  /** Labels are classifier choices; values are named or temporary presets. */
  candidates: Readonly<Record<string, RoutingPreset>>;
}

export interface RoutingConfig {
  version: 4;
  instructions: RoutingInstructions;
  roles: RoutingRole[];
}

/** The selected definition is frozen into the actor, independent of later file edits. */
export interface RoutedPreset {
  readonly name: string;
  readonly config: PresetConfig;
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

/** Routing owns role selection; all execution fields use the Preset schema. */
export function validateRoutingConfig(value: unknown): RoutingConfig {
  const config = record(value);
  if (config === null || config.version !== 4) invalid("must be a version 4 routing config");
  for (const key of Object.keys(config)) {
    if (!['version', 'instructions', 'roles'].includes(key)) invalid(
      'unknown routing field "' + key + '"');
  }
  const instructions = record(config.instructions);
  if (instructions === null || !filled(instructions.role) || !filled(instructions.model)) {
    invalid("instructions need the role and model text");
  }
  if (!Array.isArray(config.roles) || config.roles.length === 0) invalid("roles must be a non-empty array");
  const ids = new Set<string>();
  const roles: RoutingRole[] = config.roles.map((raw, index) => {
    const role = record(raw);
    if (role === null || !filled(role.id) || ids.has(role.id)) invalid(
      'roles[' + index + '] needs a unique id');
    ids.add(role.id);
    for (const key of Object.keys(role)) {
      if (!['id', 'instructions', 'candidates'].includes(key)) invalid(
        'roles[' + index + '] has unknown field "' + key + '"; execution settings belong in its presets');
    }
    if (!filled(role.instructions)) invalid('roles[' + index + '] needs instructions');
    const candidates = record(role.candidates);
    if (candidates === null || Object.keys(candidates).length === 0) invalid(
      'roles[' + index + '].candidates must be a non-empty object');
    const normalized: Record<string, RoutingPreset> = Object.create(null);
    for (const [label, candidate] of Object.entries(candidates)) {
      if (!filled(label)) invalid('candidate labels must be non-empty');
      if (typeof candidate === 'string') {
        if (!filled(candidate)) invalid('candidate preset names must be non-empty');
        normalized[label] = candidate;
      } else {
        if (record(candidate)?.hooks !== undefined) invalid('roles[' + index + '].candidates.' + label + ': temporary Presets cannot declare Hooks');
        const parsed = validatePreset(candidate);
        if ('errors' in parsed) invalid('roles[' + index + '].candidates.' + label + ': ' + parsed.errors.join('; '));
        normalized[label] = parsed.preset;
      }
    }
    return { id: role.id, instructions: role.instructions, candidates: normalized };
  });
  return { version: 4,
    instructions: { role: instructions.role, model: instructions.model }, roles };
}

export interface RouteSubagentInput {
  readonly registry: Pick<ModelRegistry, 'find' | 'findOfType' | 'classify'>;
  readonly models: readonly ClassifierModelRef[];
  readonly task: string;
  readonly context?: string | null;
  readonly signal?: AbortSignal | undefined;
  readonly budget: Pick<JobBudgetPort, 'beginModelCall'>;
  readonly configPath?: string;
  readonly config?: unknown;
  readonly presets?: PresetCatalog;
  /** The root's resolved classifier retry policy; defaults to the built-in one. */
  readonly retry?: RoutingRetryConfig;
}
export interface SubagentRoute {
  readonly roleId: string;
  readonly instructions: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: string | null;
  readonly preset: RoutedPreset;
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
 * Validate the parsed routing config through the shared Preset schema.
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
  if (!filled(path)) throw invalidConfigError("configPath must name the Pi user's subagent-routing.toml");
  const document = readConfigDocument(path, 'toml');
  if (document.status === 'missing') throw invalidConfigError(`cannot read ${path}: file is missing`);
  if (document.status !== 'ok') throw invalidConfigError(`cannot read ${path}: ${messageOf(document.error)}`);
  return validateConfig(document.value);
}


function resolveChatModel(registry: RouteSubagentInput['registry'], candidate: NonNullable<PresetConfig['model']>): Model<Api> {
  const model = registry.find(candidate.provider, candidate.id);
  if (!model) {
    throw new SubagentRoutingError(
      "routing_model_unavailable",
      `Selected model ${candidate.provider}/${candidate.id} is not in the model catalog.`,
      { candidate: candidate.id },
    );
  }
  if (model.type !== undefined && model.type !== "chat") {
    throw new SubagentRoutingError(
      "routing_model_invalid",
      `Selected model ${candidate.provider}/${candidate.id} is a ${model.type} model, not a chat model.`,
      { candidate: candidate.id },
    );
  }
  return model;
}

function abortedError(stage: number): SubagentRoutingError {
  return new SubagentRoutingError("routing_aborted", `Routing aborted before classifier call ${stage}.`, { stage });
}

function classificationFailedError(stage: number, classifier: ClassifierModelRef, nativeError: string): SubagentRoutingError {
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
 * Routing owns the backoff policy. The shared executor owns dispatch and the
 * Job budget owns the deadline. `attempt` is 1-indexed within a candidate.
 */
function classifierRetryDelayMs(attempt: number, retry: RoutingRetryConfig): number {
  const delay = retryDelayMs(
    { baseDelayMs: retry.baseDelayMs, maxAgentDelayMs: retry.maxDelayMs },
    attempt,
  );
  return Math.max(0, Math.round(delay * (1 - Math.random() * retry.jitterRatio)));
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

/** Keep routing-specific diagnostics and answer validation at the caller. */
async function classifyChoice({ stage, key, registry, models, signal, budget, retry, state, question }: {
  stage: number; key: string; registry: RouteSubagentInput['registry']; models: readonly ClassifierModelRef[];
  signal: AbortSignal | undefined; budget: RouteSubagentInput['budget']; retry: RoutingRetryConfig;
  state: ClassifierContext['state']; question: ClassifierChoiceQuestion;
}): Promise<string> {
  const response = await runClassifier({
    registry, models, signal, context: { state, questions: { [key]: question } },
    maxAttemptsPerModel: retry.maxAttempts,
    retryDelayMs: attempt => classifierRetryDelayMs(attempt, retry),
    debitAttempt: () => {
      const debit = budget.beginModelCall();
      if (debit?.ok) return;
      const terminal = debit?.terminal ?? null;
      throw new SubagentRoutingError(terminal?.error?.code ?? 'budget_exceeded', `Routing stopped: the Job budget refused classifier call ${stage}.`, {
        stage, reason: debit?.reason ?? null, terminal,
      });
    },
  });
  if (response.outcome === 'aborted') throw abortedError(stage);
  if (response.outcome === 'answered') return selectLabel(stage, key, response.result.answers, question.criteria);
  if (response.outcome === 'failed') throw classificationFailedError(stage, response.model, response.errorMessage);
  throw new SubagentRoutingError('routing_classifier_unavailable', 'No configured classifier is in the model catalog.', { stage, models });
}

/**
 * Route one Job: classify the role over `delegated_assignment`; a multi-preset
 * pool asks a second choice question using the candidate Preset descriptions.
 * A singleton skips that question. The chosen definition is carried unchanged
 * to the child, where the shared Preset resolver applies its execution settings.
 *
 * @param {object} input
 * @param {object} input.registry Model registry with findOfType/classify/find.
 * @param {object[]} input.models Ordered classifier candidates from the root config snapshot.
 * @param {string} input.task The Job's task text, used unmodified.
 * @param {string} [input.context] Batch context shared by the batch.
 * @param {AbortSignal} [input.signal] Cancellation of the calling run.
 * @param {{beginModelCall: () => object}} input.budget The Job budget.
 * @param {string} [input.configPath] Pi user routing config path, supplied by the adapter.
 * @param {object} [input.config] Parsed config for tests/internal callers.
 * @param {object} [input.retry] The root's resolved classifier retry policy.
 * @returns {Promise<SubagentRoute>} The role, selected model and Preset definition.
 */
export async function routeSubagent({
  registry, models, task, context = "", signal, budget, config, configPath, presets = new Map(),
  retry = DEFAULT_HARNESS_CONFIG.subagent.routingRetry,
}: RouteSubagentInput): Promise<SubagentRoute> {
  const routing = config === undefined ? loadSubagentRoutingConfig(configPath) : validateConfig(config);
  const batchContext = context ?? "";
  if (typeof task !== "string" || task.trim() === "" || typeof batchContext !== "string") {
    throw new SubagentRoutingError("routing_invalid_input", "routeSubagent requires a non-empty task and a string context.", {});
  }
  const delegatedAssignment = composeAssignment(task, batchContext);
  if (models.length === 0) throw new SubagentRoutingError(
    'routing_classifier_unconfigured', 'Fresh routing requires classifier.models in harness.json.', {},
  );
  const roleById = new Map(routing.roles.map((role) => [role.id, role]));

  const roleId = await classifyChoice({
    stage: 1,
    key: "role",
    registry,
    models,
    signal,
    budget,
    retry,
    state: { delegated_assignment: delegatedAssignment },
    question: {
      type: "choice",
      instructions: routing.instructions.role,
      criteria: Object.fromEntries(routing.roles.map((role) => [role.id, role.instructions])),
    },
  });
  const role = roleById.get(roleId)!;

  const pool = Object.entries(role.candidates).map(([id, definition]) => {
    const config = typeof definition === 'string' ? presets.get(definition) : definition;
    if (config === undefined) throw invalidConfigError('Unknown preset "' + definition + '" for role ' + roleId + '.');
    if (config.model === undefined) throw invalidConfigError('Preset "' + id + '" needs an explicit model for Fresh routing.');
    return { id, name: typeof definition === 'string' ? definition : 'routing:' + roleId + '/' + id, config };
  });
  const modelId = pool.length === 1 ? pool[0]!.id : await classifyChoice({
    stage: 2,
    key: "model",
    registry,
    models,
    signal,
    budget,
    retry,
    state: {
      delegated_assignment: delegatedAssignment,
      selected_role: { id: roleId, instructions: role.instructions },
    },
    question: {
      type: "choice",
      instructions: routing.instructions.model,
      criteria: Object.fromEntries(pool.map((candidate) => [candidate.id,
        candidate.config.description || candidate.name])),
    },
  });
  const candidate = pool.find((entry) => entry.id === modelId)!;
  const chatModel = resolveChatModel(registry, candidate.config.model!);
  return {
    roleId,
    instructions: role.instructions,
    model: chatModel,
    thinkingLevel: candidate.config.thinkingLevel ?? null,
    preset: { name: candidate.name, config: candidate.config },
  };
}
