/**
 * Effective outbound cache identity and payload adaptation for prompt caching.
 *
 * Local identity is never replaced: the local SessionManager ID, child session
 * identity, and IPC addresses remain distinct. Caching modifies only the
 * outbound provider cache key (`prompt_cache_key` on Responses API requests),
 * allowing inherited subagents to share a cached prefix with their parent.
 *
 * Priority rules:
 * 1. native default: The session's own nativeSessionId (clamped to 64 code points).
 * 2. inherited key: When an explicit inheritedKey is present and cache is enabled,
 *    it replaces the native default key on Responses payloads.
 * 3. none: When cacheRetention is 'none', caching is disabled and no cache key
 *    is emitted/injected.
 * 4. existing final onPayload override: An existing onPayload hook composed by the
 *    session cache installation runs after default/inherited key application, and any
 *    modification it makes is final and authoritative.
 *
 * Transports:
 * - Responses (openai-responses, azure-openai-responses, openai-codex-responses):
 *   supports `prompt_cache_key`.
 * - Anthropic (anthropic-messages) and other transports:
 *   never injected with OpenAI prompt cache fields.
 */

import { classifyProviderTransport } from './provider-session.ts';

// The provider key limit counts Unicode code points, not UTF-16 code units.
// Keep this small wire constraint here: Pi's extension loader does not expose
// the provider-specific helper through its supported package-root entrypoint.
export function limitSessionCacheKey(key: string | undefined): string | undefined {
  return key === undefined ? undefined : Array.from(key).slice(0, 64).join('');
}

export type CacheRetention = 'none' | 'short' | 'long';

export interface SessionCacheOptions {
  /**
   * Native session ID of the current session (e.g. from SessionManager).
   * Used as the default fallback key when no explicit inherited key is provided.
   */
  readonly nativeSessionId?: string | undefined;

  /**
   * Explicit inherited cache key (e.g. captured from parent's outbound cache identity).
   * When provided and cache is enabled, replaces the native default key.
   */
  readonly inheritedKey?: string | undefined;

  /**
   * Cache retention tier. When 'none', prompt caching is disabled.
   */
  readonly cacheRetention?: CacheRetention | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function isResponsesTransport(model: unknown): boolean {
  return classifyProviderTransport(model) === 'responses';
}

/**
 * Pure transform for outbound request payloads.
 *
 * Responsibilities:
 * - Only modifies Responses payloads (openai-responses, azure-openai-responses, openai-codex-responses).
 * - Leaves Anthropic and other transports completely untouched (no OpenAI fields injected).
 * - Replaces payload.prompt_cache_key ONLY when:
 *   1) payload currently carries the native default key (clamp(options.nativeSessionId)), AND
 *   2) an explicit inheritedKey is present.
 * - If payload has no prompt_cache_key or carries a custom non-default key (e.g. from samplingParams),
 *   it is left untouched; does not quietly re-enable caching or overwrite user customization.
 * - If cacheRetention is 'none', ensures a native default key is removed.
 */
export function applySessionCacheToPayload(
  payload: unknown,
  model: unknown,
  options: SessionCacheOptions,
): unknown {
  if (!isResponsesTransport(model) || !isRecord(payload)) {
    return payload;
  }

  const existingKey = payload['prompt_cache_key'];
  if (typeof existingKey !== 'string') {
    // No key present on payload; do not inject or re-enable.
    return payload;
  }

  const nativeDefault = limitSessionCacheKey(normalizeKey(options.nativeSessionId));
  if (nativeDefault === undefined || existingKey !== nativeDefault) {
    // Existing key is not the native default (e.g. custom key via samplingParams); keep unchanged.
    return payload;
  }

  // At this point, existingKey matches the native default key.
  if (options.cacheRetention === 'none') {
    const { prompt_cache_key: _dropped, ...rest } = payload;
    return rest;
  }

  const inherited = limitSessionCacheKey(normalizeKey(options.inheritedKey));
  if (inherited !== undefined) {
    return {
      ...payload,
      prompt_cache_key: inherited,
    };
  }

  return payload;
}
