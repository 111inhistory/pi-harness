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
  /** Legacy field: accepted but not used to choose or clamp thinking. */
  thinking?: unknown;
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
 * Validate the parsed routing config. Unknown top-level/role fields remain
 * ignored, but a candidate must carry its own direct thinking level. Legacy
 * role.thinking is tolerated and deliberately not used.
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
    if (Object.hasOwn(role, "thinking")) validated.thinking = role.thinking;
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
