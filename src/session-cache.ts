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
 * 4. existing final onPayload override: An existing onPayload hook composed with
 *    this wrapper runs after default/inherited key application, and any modification
 *    it makes is final and authoritative.
 *
 * Transports:
 * - Responses (openai-responses, azure-openai-responses, openai-codex-responses):
 *   supports `prompt_cache_key`.
 * - Anthropic (anthropic-messages) and other transports:
 *   never injected with OpenAI prompt cache fields.
 */

import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache';
import {
  classifyProviderTransport,
  type ProviderTransport,
} from './provider-session.ts';

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

export type SessionCacheOptionsSource =
  | SessionCacheOptions
  | (() => SessionCacheOptions);

export interface SessionCacheIdentity {
  /**
   * Effective outbound cache key, or undefined if caching is disabled or no key is set.
   * Clamped to OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH (64) when present.
   */
  readonly effectiveKey: string | undefined;

  /** Whether caching is disabled (cacheRetention === 'none'). */
  readonly disabled: boolean;

  /** Whether the effective key was derived from an explicit inheritedKey. */
  readonly isInherited: boolean;
}

export type OnPayloadFn = (
  payload: unknown,
  model: unknown,
) => unknown | Promise<unknown>;

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
 * Resolve the effective outbound cache identity from session options.
 *
 * Rules:
 * - If cacheRetention is 'none', caching is disabled and effectiveKey is undefined.
 * - Else if inheritedKey is non-empty, effectiveKey is the clamped inheritedKey (isInherited = true).
 * - Else if nativeSessionId is non-empty, effectiveKey is the clamped nativeSessionId (isInherited = false).
 * - Otherwise, effectiveKey is undefined.
 */
export function resolveSessionCacheIdentity(
  options: SessionCacheOptions,
): SessionCacheIdentity {
  const disabled = options.cacheRetention === 'none';
  if (disabled) {
    return {
      effectiveKey: undefined,
      disabled: true,
      isInherited: false,
    };
  }

  const rawInherited = normalizeKey(options.inheritedKey);
  if (rawInherited !== undefined) {
    return {
      effectiveKey: clampOpenAIPromptCacheKey(rawInherited),
      disabled: false,
      isInherited: true,
    };
  }

  const rawNative = normalizeKey(options.nativeSessionId);
  if (rawNative !== undefined) {
    return {
      effectiveKey: clampOpenAIPromptCacheKey(rawNative),
      disabled: false,
      isInherited: false,
    };
  }

  return {
    effectiveKey: undefined,
    disabled: false,
    isInherited: false,
  };
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

  const nativeDefault = clampOpenAIPromptCacheKey(normalizeKey(options.nativeSessionId));
  if (nativeDefault === undefined || existingKey !== nativeDefault) {
    // Existing key is not the native default (e.g. custom key via samplingParams); keep unchanged.
    return payload;
  }

  // At this point, existingKey matches the native default key.
  if (options.cacheRetention === 'none') {
    const { prompt_cache_key: _dropped, ...rest } = payload;
    return rest;
  }

  const inherited = clampOpenAIPromptCacheKey(normalizeKey(options.inheritedKey));
  if (inherited !== undefined) {
    return {
      ...payload,
      prompt_cache_key: inherited,
    };
  }

  return payload;
}

/**
 * Wraps an existing or absent onPayload hook with session cache adaptation.
 *
 * The wrapped hook applies cache key adaptation first, then delegates to any
 * existingOnPayload hook. Any payload or field returned by existingOnPayload
 * takes final precedence over default, inherited, and retention-none rules.
 */
export function wrapSessionCacheOnPayload(
  options: SessionCacheOptionsSource,
  existingOnPayload?: OnPayloadFn,
): OnPayloadFn {
  return async (payload: unknown, model: unknown): Promise<unknown> => {
    const resolvedOptions = typeof options === 'function' ? options() : options;
    const transformed = applySessionCacheToPayload(payload, model, resolvedOptions);

    if (existingOnPayload) {
      const overridden = await existingOnPayload(transformed, model);
      if (overridden !== undefined) {
        return overridden;
      }
    }

    return transformed;
  };
}
