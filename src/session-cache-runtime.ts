/**
 * Session runtime cache identity installation and branch lineage resolution.
 *
 * Lineage is persisted on the native session branch as a native custom entry:
 * `harness-cache-identity` with data `{ key: string | null }`.
 *
 * Invariants:
 * - `key: string`: Explicit effective outbound cache key.
 * - `key: null`: Prompt caching explicitly disabled for this lineage.
 * - `resolveSessionCacheKey(manager)` traverses the branch from newest to oldest entry;
 *   if no entry is found, it defaults to the local session ID (`manager.getSessionId()`).
 * - If a `harness-cache-identity` entry is found but malformed, it throws explicitly
 *   instead of falling back and masking corruption.
 * - Custom entry customType `harness-cache-identity` does not start with `subagent-`,
 *   so `isHarnessEntry` filtering preserves it across branch snapshots for nested inheritance.
 * - Identical keys are not duplicate-appended; fresh sessions (without inherited key)
 *   write no entry and naturally default to the local session ID.
 * - Session installation wraps `agent.streamFunction` to compose `options.onPayload`.
 *   The existing hook has final authority; if an existing hook changes the effective key
 *   on Responses, the change is recorded to lineage. Anthropic requests never persist null.
 * - Cleanup restores the previous `agent.streamFunction`.
 */

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { classifyProviderTransport } from './provider-session.ts';
import {
  applySessionCacheToPayload, limitSessionCacheKey,
  type SessionCacheOptions,
} from './session-cache.ts';

export const CACHE_IDENTITY_CUSTOM_TYPE = 'harness-cache-identity';

export interface CacheIdentityCustomEntryData {
  readonly key: string | null;
}

export interface SessionBranchManager {
  getBranch(): readonly unknown[];
  getSessionId(): string;
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface SessionCacheTarget {
  readonly agent: { streamFunction: StreamFn };
  readonly sessionManager: SessionBranchManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getBranchCacheIdentityKey(manager: { getBranch(): readonly unknown[] }): string | null | undefined {
  const branch = manager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      isRecord(entry) &&
      entry['type'] === 'custom' &&
      entry['customType'] === CACHE_IDENTITY_CUSTOM_TYPE
    ) {
      const data = entry['data'];
      if (!isRecord(data) || !('key' in data)) {
        throw new Error(`Malformed ${CACHE_IDENTITY_CUSTOM_TYPE} entry on session branch: missing 'key' property`);
      }
      const key = data['key'];
      if (key !== null && typeof key !== 'string') {
        throw new Error(`Malformed ${CACHE_IDENTITY_CUSTOM_TYPE} entry on session branch: expected string or null, got ${typeof key}`);
      }
      if (key === null) return null;
      if (key.length === 0) return null;
      return limitSessionCacheKey(key) ?? null;
    }
  }
  return undefined;
}

/**
 * Resolve the effective cache key recorded on the session branch.
 *
 * Returns the key from the latest `harness-cache-identity` entry on the branch:
 * - `string`: explicit inherited cache key.
 * - `null`: explicitly disabled caching.
 * If no such entry exists on the branch, defaults to the session's native local ID.
 * Throws if an entry exists but its data payload is malformed.
 */
export function resolveSessionCacheKey(manager: {
  getBranch(): readonly unknown[];
  getSessionId(): string;
}): string | null {
  const recorded = getBranchCacheIdentityKey(manager);
  if (recorded !== undefined) {
    return recorded;
  }

  const sessionId = manager.getSessionId();
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return limitSessionCacheKey(sessionId) ?? null;
  }
  return null;
}

/**
 * Persist an outbound cache key (or null for disabled) onto a session's native branch.
 */
export function recordSessionCacheIdentity(
  manager: { appendCustomEntry(customType: string, data?: unknown): string },
  key: string | null,
): string {
  const normalizedKey = key === null
    ? null
    : (typeof key === 'string' && key.length > 0
        ? limitSessionCacheKey(key) ?? null
        : null);
  return manager.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { key: normalizedKey });
}

/**
 * Install outbound cache identity adaptation on an SDK session.
 *
 * Hooks into the session by wrapping `agent.streamFunction`, composing with any
 * `options.onPayload` provided at call time. The existing hook maintains final
 * priority over default and inherited keys.
 *
 * If `key` is provided and differs from the branch head, records the identity
 * custom entry on the branch. Fresh sessions (`key === undefined`) append nothing.
 *
 * Returns a cleanup function that restores the original `agent.streamFunction`.
 */
export function installSessionCacheIdentity(
  session: SessionCacheTarget,
  key?: string | null,
): () => void {
  if (
    !session ||
    !session.agent ||
    typeof session.agent.streamFunction !== 'function' ||
    !session.sessionManager ||
    typeof session.sessionManager.appendCustomEntry !== 'function' ||
    typeof session.sessionManager.getBranch !== 'function' ||
    typeof session.sessionManager.getSessionId !== 'function'
  ) {
    throw new Error('A live agent stream boundary and sessionManager are required to install session cache identity.');
  }

  const manager = session.sessionManager;

  // Append lineage entry only if an explicit key is provided and differs from the branch head.
  // Fresh sessions (key === undefined) write no entry and default to local session ID.
  if (key !== undefined) {
    const currentRecorded = getBranchCacheIdentityKey(manager);
    const normalizedKey = key === null ? null : (limitSessionCacheKey(key) ?? null);
    if (currentRecorded !== normalizedKey) {
      recordSessionCacheIdentity(manager, normalizedKey);
    }
  }

  const agent = session.agent;
  const previousStream = agent.streamFunction;

  const streamWrapper: StreamFn = (model, context, options) => {
    const nativeSessionId = manager.getSessionId();
    const effectiveInheritedKey = resolveSessionCacheKey(manager);

    const isRetentionNone = options?.cacheRetention === 'none' || effectiveInheritedKey === null;
    const cacheOptions: SessionCacheOptions = {
      nativeSessionId,
      inheritedKey: isRetentionNone
        ? undefined
        : (typeof effectiveInheritedKey === 'string' ? effectiveInheritedKey : undefined),
      cacheRetention: isRetentionNone ? 'none' : options?.cacheRetention,
    };

    const previousOnPayload = options?.onPayload;

    const wrappedOnPayload = async (payload: unknown, requestModel: Model<Api>): Promise<unknown> => {
      // 1. Apply our session cache payload logic
      const transformed = applySessionCacheToPayload(payload, requestModel, cacheOptions);

      // 2. Existing hook has final priority
      let finalPayload = transformed;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(transformed, requestModel);
        if (overridden !== undefined) {
          finalPayload = overridden;
        }
      }

      // 3. Only observe Responses payloads. If an existing final hook changed the effective key,
      // record the actual update to lineage so capture can observe it, avoiding duplicate writes.
      if (classifyProviderTransport(requestModel) === 'responses' && isRecord(finalPayload)) {
        const finalKey = typeof finalPayload['prompt_cache_key'] === 'string'
          ? (limitSessionCacheKey(finalPayload['prompt_cache_key']) ?? null)
          : null;
        const currentBranchKey = resolveSessionCacheKey(manager);
        if (finalKey !== currentBranchKey) {
          recordSessionCacheIdentity(manager, finalKey);
        }
      }

      return finalPayload;
    };

    const nextOptions = {
      ...options,
      onPayload: wrappedOnPayload,
    };

    return previousStream.call(agent, model, context, nextOptions);
  };

  agent.streamFunction = streamWrapper;

  return () => {
    if (agent.streamFunction === streamWrapper) {
      agent.streamFunction = previousStream;
    }
  };
}
