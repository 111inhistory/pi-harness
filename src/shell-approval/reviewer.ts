/**
 * Optional Shell Approval auto-review adapter.
 *
 * The reviewer reuses the public review primitives of
 * `@mzwing/pi-permission-auto-review/review` instead of carrying a second copy
 * of the Codex Guardian policy. The package is optional: it is imported only
 * when a review is requested, and every loading, model, transport or parsing
 * failure falls back to an explicit undecided result. A missing review must
 * never become an allow.
 *
 * The package's `review` declaration imports a type from the optional
 * `@gotgenes/pi-permission-system` peer. This module therefore treats the
 * loaded module as an unknown compatibility boundary, validates the exact
 * public functions it calls, and owns narrow structural shapes locally. It
 * never imports the plugin's extension entrypoint, session machinery or UI.
 */

import { randomUUID } from "node:crypto";

import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";

import { parentModelRuntime } from "../session/model-runtime.ts";

const REVIEW_MODULE_SPECIFIER = "@mzwing/pi-permission-auto-review/review";
const CODEX_API = "openai-codex-responses";

/** The plugin's dedicated Codex reviewer and its hidden model id. */
export const DEFAULT_REVIEW_PROVIDER = "openai-codex";
export const DEFAULT_REVIEW_MODEL = "codex-auto-review";
const DEFAULT_REVIEW_REASONING: ReviewReasoning = "low";
const DEFAULT_TIMEOUT_MS = 90_000;

/** The optional package declares `engines.node >=24`; older runtimes stay undecided. */
export const AUTO_REVIEW_MIN_NODE_MAJOR = 24;

/** Room left for reasoning and the verdict when a prompt is admitted. */
const OUTPUT_RESERVE_TOKENS = 16_384;

export type ReviewReasoning = ModelThinkingLevel;
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type UserAuthorization = "unknown" | "low" | "medium" | "high";

/** The exact action handed to the reviewer. */
export interface ShellReviewAction {
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly platform?: "posix" | "windows";
  readonly argv?: readonly string[];
  /** Source agent label, or the main session when omitted by the caller. */
  readonly source: string;
  readonly reason?: string;
}

export interface ShellReviewContext {
  /** The resolved Pi branch the caller treats as trusted review context. */
  readonly branch: readonly SessionEntry[];
}

export interface ShellReviewInput {
  readonly action: ShellReviewAction;
  readonly context: ShellReviewContext;
  /** Caller lifetime cancellation. Aborting it aborts the model request. */
  readonly signal?: AbortSignal;
}

export interface ShellReviewOptions {
  /** The parent session ModelRegistry facade; bridged to its ModelRuntime. */
  readonly modelRegistry: ModelRegistry;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: ReviewReasoning;
  readonly timeoutMs?: number;
}

export type ShellReviewFailure =
  | "unavailable"
  | "model-unresolved"
  | "cancelled"
  | "timeout"
  | "invalid-response"
  | "provider-error"
  | "input-budget-exceeded";

export interface ShellReviewAssessment {
  readonly riskLevel: RiskLevel;
  readonly userAuthorization: UserAuthorization;
  readonly rationale: string;
}

export type ShellReviewResult =
  | {
      readonly decision: "allow";
      readonly reason: string;
      readonly assessment: ShellReviewAssessment;
    }
  | {
      readonly decision: "deny";
      readonly reason: string;
      readonly assessment: ShellReviewAssessment;
    }
  | {
      readonly decision: "defer";
      readonly reason: string;
      readonly failure: ShellReviewFailure;
    };

export interface ShellReviewer {
  review(input: ShellReviewInput): Promise<ShellReviewResult>;
}

interface ResolvedOptions {
  readonly modelRegistry: ModelRegistry;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReviewReasoning;
  readonly timeoutMs: number;
}

interface Assessment extends ShellReviewAssessment {
  readonly outcome: "allow" | "deny";
}

interface ReviewPrompt {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

interface ReviewDetails {
  readonly requestId: string;
  readonly source: "tool_call";
  readonly agentName: string | null;
  readonly command: string;
  readonly toolName: string;
  readonly payload: {
    readonly kind: "bash";
    readonly request: {
      readonly requester: {
        readonly agentName: string | null;
        readonly forwarded: false;
        readonly sessionId: null;
      };
      readonly surface: string;
      readonly toolName: string;
      readonly value: string;
    };
    readonly evidence: readonly { readonly label: string; readonly text: string }[];
    readonly annotations: readonly never[];
  };
}

type ReviewConfig = Readonly<Record<string, unknown>> & {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReviewReasoning;
};

/**
 * The validated public surface of the optional review module. The plugin owns
 * the prompt and the verdict parser behind these calls.
 */
interface ReviewModule {
  readonly DEFAULT_CONFIG: Record<string, unknown>;
  renderTranscript(entries: readonly SessionEntry[]): unknown;
  buildReviewPrompt(
    config: ReviewConfig,
    transcript: unknown,
    details: ReviewDetails,
    toolInput?: unknown,
  ): unknown;
  parseReviewAssessment(text: string): unknown;
}

type ReviewAttempt =
  | { readonly ok: true; readonly assessment: Assessment }
  | { readonly ok: false; readonly failure: ShellReviewFailure };

let cachedReviewModule: ReviewModule | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

/**
 * A provider is not bound to reject promptly when its request signal aborts,
 * so the adapter enforces the abort itself.
 */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function moduleShape(namespace: unknown): ReviewModule | null {
  if (!isRecord(namespace)) return null;
  const { DEFAULT_CONFIG, renderTranscript, buildReviewPrompt, parseReviewAssessment } = namespace;
  if (!isRecord(DEFAULT_CONFIG)) return null;
  if (typeof renderTranscript !== "function"
    || typeof buildReviewPrompt !== "function"
    || typeof parseReviewAssessment !== "function") return null;

  return {
    DEFAULT_CONFIG,
    renderTranscript(entries) {
      return Reflect.apply(renderTranscript, undefined, [entries]);
    },
    buildReviewPrompt(config, transcript, details, toolInput) {
      return Reflect.apply(buildReviewPrompt, undefined, [config, transcript, details, toolInput]);
    },
    parseReviewAssessment(text) {
      return Reflect.apply(parseReviewAssessment, undefined, [text]);
    },
  };
}

/** Loads the optional module only when a review is actually requested. */
async function loadReviewModule(): Promise<ReviewModule | null> {
  if (cachedReviewModule !== null) return cachedReviewModule;
  try {
    const specifier: string = REVIEW_MODULE_SPECIFIER;
    const namespace: unknown = await import(specifier);
    const module = moduleShape(namespace);
    if (module !== null) cachedReviewModule = module;
    return module;
  } catch {
    return null;
  }
}

/**
 * Mirrors the plugin's model resolution for its hidden `codex-auto-review`
 * model. Any failure stays unresolved: a dedicated reviewer is never silently
 * replaced by a different model.
 */
function resolveReviewModel(runtime: ModelRuntime, providerId: string, modelId: string): Model<Api> | null {
  const registered = runtime.getModel(providerId, modelId);
  if (registered !== undefined) return registered;
  if (providerId !== DEFAULT_REVIEW_PROVIDER || modelId !== DEFAULT_REVIEW_MODEL) return null;

  const template = runtime.getModels(providerId)
    .find(model => model.provider === providerId && model.api === CODEX_API);
  if (template === undefined) return null;

  return {
    ...template,
    id: DEFAULT_REVIEW_MODEL,
    name: "Codex Auto Review",
    reasoning: true,
    input: ["text"],
  };
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readPrompt(value: unknown): ReviewPrompt | null {
  if (!isRecord(value)) return null;
  const { systemPrompt, userPrompt } = value;
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return null;
  if (typeof userPrompt !== "string" || userPrompt.length === 0) return null;
  return { systemPrompt, userPrompt };
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isUserAuthorization(value: unknown): value is UserAuthorization {
  return value === "unknown" || value === "low" || value === "medium" || value === "high";
}

function readAssessment(value: unknown): Assessment | null {
  if (!isRecord(value)) return null;
  const { riskLevel, userAuthorization, outcome, rationale } = value;
  if (outcome !== "allow" && outcome !== "deny") return null;
  if (!isRiskLevel(riskLevel) || !isUserAuthorization(userAuthorization)) return null;
  if (typeof rationale !== "string" || rationale.trim().length === 0) return null;
  return { riskLevel, userAuthorization, outcome, rationale: rationale.trim() };
}

function replyText(message: AssistantMessage): string {
  return message.content
    .flatMap(block => block.type === "text" ? [block.text] : [])
    .join("")
    .trim();
}

function requestDetails(action: ShellReviewAction): ReviewDetails {
  const agentName = action.source.length === 0 ? null : action.source;
  return {
    requestId: `shell-approval-${randomUUID()}`,
    source: "tool_call",
    agentName,
    command: action.command,
    toolName: action.shell,
    payload: {
      kind: "bash",
      request: {
        requester: { agentName, forwarded: false, sessionId: null },
        surface: action.shell,
        toolName: action.shell,
        value: action.command,
      },
      evidence: [
        { label: "working directory", text: action.cwd },
        ...action.platform === undefined ? [] : [{ label: "platform", text: action.platform }],
        ...action.argv === undefined ? [] : [{ label: "argv", text: action.argv.join(" ") }],
        ...action.reason === undefined ? [] : [{ label: "approval reason", text: action.reason }],
      ],
      annotations: [],
    },
  };
}

function reviewConfig(base: Record<string, unknown>, options: ResolvedOptions): ReviewConfig {
  return {
    ...base,
    provider: options.provider,
    model: options.model,
    reasoning: options.reasoning,
  };
}

function defer(failure: ShellReviewFailure, reason: string): ShellReviewResult {
  return { decision: "defer", failure, reason };
}

function cancelled(): ShellReviewResult {
  return defer("cancelled", "Automatic review was cancelled before an assessment completed.");
}

function unsupportedRuntime(): ShellReviewResult | null {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= AUTO_REVIEW_MIN_NODE_MAJOR) return null;
  return defer(
    "unavailable",
    `Automatic review unavailable: Node.js ${AUTO_REVIEW_MIN_NODE_MAJOR} or newer is required (current ${process.versions.node}). Left to manual review.`,
  );
}

function timedOut(): ShellReviewResult {
  return defer("timeout", "Automatic review timed out before an assessment completed.");
}

function decided(assessment: Assessment): ShellReviewResult {
  const detail = `${assessment.rationale} (risk: ${assessment.riskLevel}; user authorization: ${assessment.userAuthorization})`;
  if (assessment.outcome === "allow") {
    return {
      decision: "allow",
      reason: `Automatic review allowed execution: ${detail}`,
      assessment: {
        riskLevel: assessment.riskLevel,
        userAuthorization: assessment.userAuthorization,
        rationale: assessment.rationale,
      },
    };
  }
  return {
    decision: "deny",
    reason: `Automatic review denied execution: ${detail}. Do not attempt to bypass this decision by rewriting, splitting, or executing the command indirectly.`,
    assessment: {
      riskLevel: assessment.riskLevel,
      userAuthorization: assessment.userAuthorization,
      rationale: assessment.rationale,
    },
  };
}

interface AttemptInput {
  readonly module: ReviewModule;
  readonly runtime: ModelRuntime;
  readonly model: Model<Api>;
  readonly config: ReviewConfig;
  readonly prompt: ReviewPrompt;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly deadline: number;
}

async function requestAssessment(input: AttemptInput): Promise<ReviewAttempt> {
  const { module, runtime, model, config, prompt, signal, timeoutSignal, deadline } = input;
  if (signal.aborted) return { ok: false, failure: "cancelled" };

  const reasoning = clampThinkingLevel(model, config.reasoning);
  const budget = approximateTokens(prompt.systemPrompt + prompt.userPrompt);
  if (budget + OUTPUT_RESERVE_TOKENS > model.contextWindow) {
    return { ok: false, failure: "input-budget-exceeded" };
  }

  let reply: AssistantMessage;
  try {
    reply = await raceWithSignal(
      runtime.streamSimple(model, {
        systemPrompt: prompt.systemPrompt,
        messages: [{ role: "user", content: prompt.userPrompt, timestamp: Date.now() }],
      }, {
        maxRetries: 0,
        signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
        ...reasoning === "off" ? {} : { reasoning },
      }).result(),
      signal,
    );
  } catch {
    if (timeoutSignal.aborted) return { ok: false, failure: "timeout" };
    if (signal.aborted) return { ok: false, failure: "cancelled" };
    return { ok: false, failure: "provider-error" };
  }
  if (reply.stopReason === "error") return { ok: false, failure: "provider-error" };
  if (reply.stopReason === "aborted") {
    return { ok: false, failure: timeoutSignal.aborted ? "timeout" : "cancelled" };
  }

  try {
    const assessment = readAssessment(module.parseReviewAssessment(replyText(reply)));
    if (assessment === null) return { ok: false, failure: "invalid-response" };
    return { ok: true, assessment };
  } catch {
    return { ok: false, failure: "invalid-response" };
  }
}

async function review(input: ShellReviewInput, options: ResolvedOptions): Promise<ShellReviewResult> {
  const runtimeBoundary = unsupportedRuntime();
  if (runtimeBoundary !== null) return runtimeBoundary;

  const callerSignal = input.signal;
  if (isAborted(callerSignal)) return cancelled();

  const module = await raceWithSignal(loadReviewModule(), callerSignal);
  if (module === null) {
    return defer(
      "unavailable",
      "Automatic review unavailable: the optional dependency @mzwing/pi-permission-auto-review/review is not installed or exposes an incompatible interface. Left to manual review.",
    );
  }
  if (isAborted(callerSignal)) return cancelled();

  let runtime: ModelRuntime;
  try {
    runtime = parentModelRuntime(options.modelRegistry, "shell approval auto-review");
  } catch {
    return defer(
      "unavailable",
      "Automatic review unavailable: the parent session model runtime could not be read, so Pi's provider registrations and credentials cannot be reused. Left to manual review.",
    );
  }

  const model = resolveReviewModel(runtime, options.provider, options.model);
  if (model === null) {
    return defer(
      "model-unresolved",
      `Automatic review could not resolve review model ${options.provider}/${options.model} and did not substitute another model. Left to manual review.`,
    );
  }

  const config = reviewConfig(module.DEFAULT_CONFIG, options);
  let prompt: ReviewPrompt | null;
  try {
    prompt = readPrompt(module.buildReviewPrompt(
      config,
      module.renderTranscript(input.context.branch),
      requestDetails(input.action),
      input.action,
    ));
  } catch {
    prompt = null;
  }
  if (prompt === null) {
    return defer("unavailable", "Automatic review unavailable: the review prompt could not be built. Left to manual review.");
  }

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  const timeoutSignal = timeoutController.signal;
  const signal = callerSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal]);
  const deadline = Date.now() + options.timeoutMs;

  try {
    const attempt = await requestAssessment({
      module,
      runtime,
      model,
      config,
      prompt,
      signal,
      timeoutSignal,
      deadline,
    });
    if (!attempt.ok) {
      if (isAborted(callerSignal)) return cancelled();
      switch (attempt.failure) {
        case "cancelled":
          return cancelled();
        case "timeout":
          return timedOut();
        case "input-budget-exceeded":
          return defer(
            "input-budget-exceeded",
            "Automatic review preflight failed: the prompt exceeds the review model context budget. Left to manual review.",
          );
        case "invalid-response":
          return defer(
            "invalid-response",
            "Automatic review returned a missing or unparseable assessment, so execution was not allowed. Left to manual review.",
          );
        case "provider-error":
          return defer(
            "provider-error",
            "Automatic review failed to call the model, so execution was not allowed. Left to manual review.",
          );
        default:
          return defer(attempt.failure, "Automatic review did not complete. Left to manual review.");
      }
    }
    if (isAborted(callerSignal)) return cancelled();
    return decided(attempt.assessment);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

export function createShellReviewer(options: ShellReviewOptions): ShellReviewer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolved: ResolvedOptions = {
    modelRegistry: options.modelRegistry,
    provider: options.provider ?? DEFAULT_REVIEW_PROVIDER,
    model: options.model ?? DEFAULT_REVIEW_MODEL,
    reasoning: options.reasoning ?? DEFAULT_REVIEW_REASONING,
    timeoutMs,
  };

  return {
    async review(input) {
      try {
        return await review(input, resolved);
      } catch (error) {
        if (isAborted(input.signal)) return cancelled();
        return defer(
          "unavailable",
          `Automatic review unavailable: ${error instanceof Error ? error.message : String(error)}. Left to manual review.`,
        );
      }
    },
  };
}
