/**
 * Exact provider-transport classification shared by Capability and Subagent.
 *
 * Provider encoding stays in Pi. This module only reports which native
 * transcript features the concrete model/API declares, and for request-scoped
 * facts which native mid-conversation effort encoder the exact auth path can
 * use. It never serializes a provider payload, infers support from a model or
 * provider name, or claims that a preserved prefix is a cache hit.
 *
 * Support is read from the exact `api` and explicit `compat` booleans. The
 * Responses direct sign-in exception also needs the actual request auth because
 * the installed adapter checks it; no other transport does.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export type ProviderTransport = 'responses' | 'anthropic' | 'completions' | 'other';

/**
 * The auth facts the installed adapters actually inspect. Omit the whole
 * `auth` object when auth has not been resolved. A resolved `{}` means no
 * baseUrl override and no API key (for example a header-only request).
 */
export interface ProviderRequestAuth {
  readonly apiKey?: string;
  /** Truthy resolved baseUrl; overrides model.baseUrl exactly as the SDK does. */
  readonly baseUrl?: string;
}

export interface ProviderRequestFacts {
  /** Resolved request auth, when the caller has one. */
  readonly auth?: ProviderRequestAuth;
  /** SDK-effective thinking level after clamping. `off` means thinking disabled. */
  readonly thinkingLevel?: ModelThinkingLevel;
}

/**
 * Native encoder available for a same-model effort change.
 *
 * `unverified` means the exact API has an encoder but the caller did not supply
 * the request facts needed to decide whether it applies. Consumers must treat it
 * as unsupported until they can re-evaluate with the missing facts.
 */
export type ProviderMidConversationEffort =
  | 'none'
  | 'unverified'
  | 'responses-configuration-update'
  | 'anthropic-effort-markers';

export interface ProviderSessionPolicy {
  readonly transport: ProviderTransport;
  /**
   * Pi keeps later system messages in place instead of replaying them into the
   * leading prompt. Instructions can therefore be appended without rewriting
   * the cached prefix.
   */
  readonly midConversationSystemMessages: boolean;
  /**
   * The native transport can add tool names mid-conversation. This describes
   * native declarations only; text-tool pseudo-additions are not modeled.
   */
  readonly toolAdditions: boolean;
  /**
   * The native transport can replace a same-name tool declaration in place.
   */
  readonly toolSameNameUpdates: boolean;
  /**
   * Native encoder for an effective non-off effort change, or `none` when the
   * exact API/compat path has no encoder. See {@link ProviderMidConversationEffort}.
   */
  readonly midConversationEffort: ProviderMidConversationEffort;
}

const RESPONSES_APIS: ReadonlySet<string> = new Set([
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
]);

const ANTHROPIC_APIS: ReadonlySet<string> = new Set(['anthropic-messages']);

const COMPLETIONS_APIS: ReadonlySet<string> = new Set(['openai-completions']);

const OPENAI_RESPONSES_API = 'openai-responses';
const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compatOf(model: unknown): UnknownRecord {
  if (!isRecord(model)) return {};
  const compat = model['compat'];
  return isRecord(compat) ? compat : {};
}

/** Exact transport identity; compat never turns another API into one of these. */
export function classifyProviderTransport(model: unknown): ProviderTransport {
  if (!isRecord(model)) return 'other';
  const api = model['api'];
  if (typeof api !== 'string') return 'other';
  if (RESPONSES_APIS.has(api)) return 'responses';
  if (ANTHROPIC_APIS.has(api)) return 'anthropic';
  if (COMPLETIONS_APIS.has(api)) return 'completions';
  return 'other';
}

/**
 * The installed openai-responses adapter suppresses configuration_update items
 * on Sign in with ChatGPT. Its exact predicate is provider `openai`, the
 * resolved request base URL, and a defined apiKey that does not start with
 * `sk-`. A truthy resolved auth.baseUrl replaces model.baseUrl before the
 * adapter dispatch. Custom gateways therefore still need resolved auth when
 * the model provider is `openai`, because the URL can be overridden.
 */
function isOfficialOpenAIBaseUrl(value: unknown): boolean {
  return value === OFFICIAL_OPENAI_BASE_URL;
}

function openAIResponsesEffort(
  model: unknown,
  request: ProviderRequestFacts | undefined,
  compat: UnknownRecord,
): ProviderMidConversationEffort {
  if (compat['supportsMidConvoEffort'] !== true) return 'none';
  const thinkingLevel = request?.thinkingLevel;
  if (thinkingLevel === undefined) return 'unverified';
  if (thinkingLevel === 'off') return 'none';

  if (!isRecord(model) || model['provider'] !== 'openai') {
    // The native sign-in predicate requires provider `openai`; another provider
    // cannot reach it even if a catalog URL looks official.
    return 'responses-configuration-update';
  }

  if (request?.auth === undefined) return 'unverified';
  const resolvedBaseUrl = request.auth.baseUrl ? request.auth.baseUrl : model['baseUrl'];
  if (isOfficialOpenAIBaseUrl(resolvedBaseUrl)) {
    const apiKey = request.auth.apiKey;
    // The adapter suppresses configuration_update for non-sk credentials on
    // this exact resolved path.
    if (typeof apiKey === 'string' && !apiKey.startsWith('sk-')) return 'none';
  }

  return 'responses-configuration-update';
}

function anthropicEffort(
  request: ProviderRequestFacts | undefined,
  compat: UnknownRecord,
): ProviderMidConversationEffort {
  if (compat['supportsMidConvoEffort'] !== true) return 'none';
  const thinkingLevel = request?.thinkingLevel;
  if (thinkingLevel === undefined) return 'unverified';
  if (thinkingLevel === 'off') return 'none';
  return 'anthropic-effort-markers';
}

interface ToolPlacement {
  readonly toolAdditions: boolean;
  readonly toolSameNameUpdates: boolean;
}

function toolPlacement(
  transport: ProviderTransport,
  compat: UnknownRecord,
  midConversationSystemMessages: boolean,
): ToolPlacement {
  if (transport === 'responses') {
    const additionalTools = compat['supportsAdditionalTools'] === true;
    return {
      // Tool-search additions do not need mid-conversation system messages.
      toolAdditions: compat['supportsToolSearch'] === true
        || (midConversationSystemMessages && additionalTools),
      toolSameNameUpdates: midConversationSystemMessages && additionalTools,
    };
  }

  if (transport === 'anthropic') {
    const changes = midConversationSystemMessages && compat['supportsMidConvoToolChanges'] === true;
    return { toolAdditions: changes, toolSameNameUpdates: changes };
  }

  if (transport === 'completions') {
    return {
      toolAdditions: midConversationSystemMessages
        && compat['supportsMidConvoToolAdditions'] === true,
      toolSameNameUpdates: false,
    };
  }

  return { toolAdditions: false, toolSameNameUpdates: false };
}

/**
 * Native capabilities for the exact model/API. `request` is needed only for
 * effective mid-conversation effort. A request without an effective thinking
 * level yields `unverified`; the official OpenAI Responses path also yields
 * `unverified` until its auth facts are resolved.
 */
export function providerSessionPolicy(
  model: unknown,
  request?: ProviderRequestFacts,
): ProviderSessionPolicy {
  const transport = classifyProviderTransport(model);
  if (transport === 'other') {
    return {
      transport,
      midConversationSystemMessages: false,
      toolAdditions: false,
      toolSameNameUpdates: false,
      midConversationEffort: 'none',
    };
  }

  const compat = compatOf(model);
  const midConversationSystemMessages = compat['supportsMidConvoSystemMessages'] === true;
  const tools = toolPlacement(transport, compat, midConversationSystemMessages);

  let midConversationEffort: ProviderMidConversationEffort = 'none';
  if (transport === 'responses' && isRecord(model) && model['api'] === OPENAI_RESPONSES_API) {
    // Azure and Codex Responses use the same converter for tools, but the
    // installed adapters do not encode supportsMidConvoEffort. Do not infer an
    // effort encoder from the shared transport family.
    midConversationEffort = openAIResponsesEffort(model, request, compat);
  } else if (transport === 'anthropic') {
    midConversationEffort = anthropicEffort(request, compat);
  }

  return {
    transport,
    midConversationSystemMessages,
    ...tools,
    midConversationEffort,
  };
}
