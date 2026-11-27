/**
 * Neutral tool observation fact source for live SDK `tool_result` events and
 * persisted session branch recovery.
 *
 * Carries no Hook or Stats policy. Live nested executions are observed directly
 * from the SDK's authoritative `tool_result` events (never re-emitted from
 * Codemode's `details.calls`), and every observation is deduplicated by call ID.
 */
import type { ImageContent, TextContent, Usage } from '@earendil-works/pi-ai';
import type { CodemodeErrorKind } from '@earendil-works/pi-codemode';
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import type {
  CodemodeNestedCallDetail,
  CodemodeNestedCallStatus,
  CodemodeScriptErrorDetail,
  CodemodeToolDetails,
} from './capability/codemode.ts';

export type ToolObservationStatus = 'ok' | 'error' | 'cancelled' | 'unfinished';
export type ToolObservationSource = 'live' | 'branch';
export type NestedObservationCompleteness = 'none' | 'complete' | 'unknown';

export interface CodemodeObservationMetadata {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly error?: CodemodeScriptErrorDetail;
}

export interface ToolObservation {
  readonly callId: string;
  readonly parentCallId?: string;
  readonly toolName: string;
  readonly isNested: boolean;
  readonly status: ToolObservationStatus;
  readonly isError: boolean;
  readonly source: ToolObservationSource;
  /**
   * Typed tool arguments when authoritatively available:
   * - Live events always carry `event.input`.
   * - Branch recovery carries top-level assistant `toolCall.arguments` or
   *   `message.nestedCalls.calls[].arguments` when within SDK size limits.
   * - `undefined` when omitted by SDK caps or absent in legacy history.
   */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Byte size reported by SDK when nested arguments exceeded `NESTED_CALL_LIMITS`. */
  readonly inputBytes?: number;
  readonly durationMs?: number;
  readonly errorPreview?: string;
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly usage?: Usage;
  /**
   * Completeness of nested tool call facts under this observation:
   * - `'none'`: provably made no nested calls
   * - `'complete'`: all nested calls and their typed arguments are known
   * - `'unknown'`: nested facts are missing (legacy history) or truncated
   */
  readonly nestedCompleteness: NestedObservationCompleteness;
  /** Observed nested child call IDs in execution order. */
  readonly nestedCallIds?: readonly string[];
  /** Present on `codemode` observations that carry typed `CodemodeToolDetails`. */
  readonly codemode?: CodemodeObservationMetadata;
}

const VALID_CODEMODE_ERROR_KINDS = new Set<string>(['script', 'timeout', 'aborted', 'sandbox']);
const VALID_CODEMODE_CALL_STATUSES = new Set<string>(['ok', 'error', 'cancelled']);
const VALID_NESTED_RECORD_STATUSES = new Set<string>(['ok', 'error', 'cancelled', 'unfinished']);
export const DEFAULT_MAX_TRACKED_CALL_IDS = 4096;
export const DEFAULT_MAX_TRACKED_PARENTS = 128;
export const DEFAULT_MAX_CHILDREN_PER_PARENT = 512;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse typed `CodemodeToolDetails` produced by `src/capability/codemode.ts`.
 * Returns `null` for legacy untyped details or unrelated tool details.
 */
export function parseCodemodeToolDetails(details: unknown): CodemodeToolDetails | null {
  if (
    !isPlainRecord(details)
    || typeof details.ok !== 'boolean'
    || typeof details.durationMs !== 'number'
    || !Number.isFinite(details.durationMs)
    || typeof details.truncated !== 'boolean'
  ) {
    return null;
  }
  if (!Array.isArray(details.calls)) return null;
  const calls: CodemodeNestedCallDetail[] = [];
  for (const raw of details.calls) {
    if (!isPlainRecord(raw)) return null;
    if (
      typeof raw.id !== 'string'
      || typeof raw.name !== 'string'
      || typeof raw.args !== 'string'
      || typeof raw.status !== 'string'
      || !VALID_CODEMODE_CALL_STATUSES.has(raw.status)
    ) {
      return null;
    }
    calls.push({
      id: raw.id,
      name: raw.name,
      args: raw.args,
      status: raw.status as CodemodeNestedCallStatus,
      ...(typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    });
  }
  let error: CodemodeScriptErrorDetail | undefined;
  if (details.error !== undefined) {
    if (!isPlainRecord(details.error) || typeof details.error.kind !== 'string' || !VALID_CODEMODE_ERROR_KINDS.has(details.error.kind)) {
      return null;
    }
    error = {
      kind: details.error.kind as CodemodeErrorKind,
      ...(typeof details.error.name === 'string' && details.error.name !== '' ? { name: details.error.name } : {}),
    };
  }
  return {
    calls,
    ok: details.ok,
    durationMs: details.durationMs,
    truncated: details.truncated,
    ...(typeof details.fullOutputPath === 'string' ? { fullOutputPath: details.fullOutputPath } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

function toCodemodeMetadata(details: CodemodeToolDetails): CodemodeObservationMetadata {
  return {
    ok: details.ok,
    durationMs: details.durationMs,
    truncated: details.truncated,
    ...(details.error === undefined ? {} : { error: details.error }),
  };
}

export interface LiveToolObservationLimits {
  readonly maxTrackedCallIds?: number;
  readonly maxTrackedParents?: number;
  readonly maxChildrenPerParent?: number;
}

export interface LiveToolObservationTracker {
  /** Convert one live SDK `tool_result` event; returns `null` on duplicate `callId`. */
  observe(event: ToolResultEvent): ToolObservation | null;
  /** Clear bounded per-turn / per-branch tracking state. */
  reset(): void;
}

/**
 * Bounded state machine for live SDK `tool_result` events.
 *
 * Nested `tool_result` events arrive before their outer parent `tool_result`
 * event with `parentToolCallId` set. Tracks at most `maxTrackedCallIds` IDs
 * and `maxTrackedParents` in-flight parent buckets per turn; once any cap is
 * exceeded, stops growing internal tables and degrades parent completeness to
 * `'unknown'` rather than claiming completeness or retaining unbounded memory.
 */
export function createLiveToolObservationTracker(
  limits: LiveToolObservationLimits = {},
): LiveToolObservationTracker {
  const maxTrackedCallIds = Math.max(1, limits.maxTrackedCallIds ?? DEFAULT_MAX_TRACKED_CALL_IDS);
  const maxTrackedParents = Math.max(1, limits.maxTrackedParents ?? DEFAULT_MAX_TRACKED_PARENTS);
  const maxChildrenPerParent = Math.max(1, limits.maxChildrenPerParent ?? DEFAULT_MAX_CHILDREN_PER_PARENT);

  const seenCallIds = new Set<string>();
  const pendingChildrenByParent = new Map<string, { ids: string[]; overflow: boolean }>();
  let callIdOverflow = false;
  let parentOverflow = false;

  return {
    observe(event: ToolResultEvent): ToolObservation | null {
      if (seenCallIds.has(event.toolCallId)) return null;
      if (seenCallIds.size < maxTrackedCallIds) {
        seenCallIds.add(event.toolCallId);
      } else {
        // Stop growing bounded state for the remainder of this turn; degrade
        // outer completeness to 'unknown' rather than dropping dedup silently.
        callIdOverflow = true;
      }

      if (event.parentToolCallId !== undefined) {
        if (!callIdOverflow) {
          let bucket = pendingChildrenByParent.get(event.parentToolCallId);
          if (bucket === undefined) {
            if (pendingChildrenByParent.size < maxTrackedParents) {
              bucket = { ids: [], overflow: false };
              pendingChildrenByParent.set(event.parentToolCallId, bucket);
            } else {
              parentOverflow = true;
            }
          }
          if (bucket !== undefined) {
            if (bucket.ids.length < maxChildrenPerParent) {
              bucket.ids.push(event.toolCallId);
            } else {
              bucket.overflow = true;
            }
          }
        }
        return {
          callId: event.toolCallId,
          parentCallId: event.parentToolCallId,
          toolName: event.toolName,
          isNested: true,
          status: event.isError ? 'error' : 'ok',
          isError: event.isError,
          source: 'live',
          input: event.input,
          content: event.content,
          details: event.details,
          ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          nestedCompleteness: 'none',
        };
      }

      const pending = pendingChildrenByParent.get(event.toolCallId);
      pendingChildrenByParent.delete(event.toolCallId);
      const liveChildren = pending?.ids ?? [];
      const degraded = callIdOverflow || parentOverflow || pending?.overflow === true;

      const cmDetails = event.toolName === 'codemode' ? parseCodemodeToolDetails(event.details) : null;
      let nestedCompleteness: NestedObservationCompleteness;
      if (degraded) {
        nestedCompleteness = 'unknown';
      } else if (cmDetails !== null) {
        if (cmDetails.calls.length === 0 && liveChildren.length === 0) {
          nestedCompleteness = 'none';
        } else {
          const liveSet = new Set(liveChildren);
          const allObserved = cmDetails.calls.every(
            (call) => !call.id.endsWith('/?') && liveSet.has(call.id),
          );
          nestedCompleteness = allObserved ? 'complete' : 'unknown';
        }
      } else if (event.toolName === 'codemode') {
        nestedCompleteness = 'unknown';
      } else {
        nestedCompleteness = liveChildren.length > 0 ? 'complete' : 'none';
      }

      const status: ToolObservationStatus = cmDetails?.error?.kind === 'aborted'
        ? 'cancelled'
        : (event.isError ? 'error' : 'ok');

      return {
        callId: event.toolCallId,
        toolName: event.toolName,
        isNested: false,
        status,
        isError: event.isError,
        source: 'live',
        input: event.input,
        ...(cmDetails === null ? {} : { durationMs: cmDetails.durationMs }),
        content: event.content,
        details: event.details,
        ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        nestedCompleteness,
        ...(liveChildren.length > 0 ? { nestedCallIds: liveChildren } : {}),
        ...(cmDetails === null ? {} : { codemode: toCodemodeMetadata(cmDetails) }),
      };
    },
    reset(): void {
      seenCallIds.clear();
      pendingChildrenByParent.clear();
      callIdOverflow = false;
      parentOverflow = false;
    },
  };
}

export type LiveToolObservationListener = (
  observation: ToolObservation,
  event: ToolResultEvent,
  ctx: ExtensionContext,
) => void;

/**
 * Subscribe a neutral listener to live SDK `tool_result` observations and reset
 * bounded tracking state on turn settlement and branch lifecycle transitions.
 *
 * Returns an idempotent teardown function that detaches every `pi.on` handler
 * and drops references to the listener; `session_shutdown` invokes the same
 * teardown automatically.
 */
export function installToolObservation(
  pi: ExtensionAPI,
  listener: LiveToolObservationListener,
  limits?: LiveToolObservationLimits,
): () => void {
  const tracker = createLiveToolObservationTracker(limits);
  let disposed = false;
  let activeListener: LiveToolObservationListener | undefined = listener;
  const unsubscribes: (() => void)[] = [];
  const reset = (): void => { tracker.reset(); };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    activeListener = undefined;
    tracker.reset();
    for (const off of unsubscribes.splice(0)) {
      if (typeof off === 'function') off();
    }
  };

  unsubscribes.push(
    pi.on('tool_result', (event, ctx) => {
      if (disposed || activeListener === undefined) return;
      const observation = tracker.observe(event);
      if (observation !== null) activeListener(observation, event, ctx);
    }),
    pi.on('agent_settled', reset),
    pi.on('session_start', reset),
    pi.on('session_before_switch', reset),
    pi.on('session_before_fork', reset),
    pi.on('session_tree', reset),
    pi.on('session_shutdown', dispose),
  );

  return dispose;
}

interface PersistedNestedCallRecord {
  readonly id: string;
  readonly name: string;
  readonly status: ToolObservationStatus;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly argumentsBytes?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

interface PersistedNestedCalls {
  readonly calls: readonly PersistedNestedCallRecord[];
  readonly complete: boolean;
}

function parsePersistedNestedCalls(raw: unknown): PersistedNestedCalls | null {
  if (!isPlainRecord(raw) || !Array.isArray(raw.calls) || typeof raw.complete !== 'boolean') {
    return null;
  }
  const calls: PersistedNestedCallRecord[] = [];
  for (const item of raw.calls) {
    if (!isPlainRecord(item)) return null;
    if (
      typeof item.id !== 'string'
      || typeof item.name !== 'string'
      || typeof item.status !== 'string'
      || !VALID_NESTED_RECORD_STATUSES.has(item.status)
    ) {
      return null;
    }
    calls.push({
      id: item.id,
      name: item.name,
      status: item.status as ToolObservationStatus,
      ...(isPlainRecord(item.arguments) ? { arguments: item.arguments } : {}),
      ...(typeof item.argumentsBytes === 'number' && Number.isFinite(item.argumentsBytes)
        ? { argumentsBytes: item.argumentsBytes }
        : {}),
      ...(typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)
        ? { durationMs: item.durationMs }
        : {}),
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
    });
  }
  return { calls, complete: raw.complete };
}

/**
 * Recover neutral tool observations from persisted branch entries in a single
 * linear pass, matching live SDK `nested -> outer` order and deduplicating by
 * call ID.
 *
 * Legacy Codemode records lacking `message.nestedCalls` (or records where the
 * SDK hit `NESTED_CALL_LIMITS` with `complete: false`) report
 * `nestedCompleteness: 'unknown'` rather than synthesizing arguments from
 * truncated preview strings.
 */
export function extractBranchToolObservations(branch: readonly SessionEntry[]): readonly ToolObservation[] {
  const toolCallArgs = new Map<string, Readonly<Record<string, unknown>>>();
  const seen = new Set<string>();
  const observations: ToolObservation[] = [];

  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const msg = entry.message as unknown as Record<string, unknown>;
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          isPlainRecord(part)
          && part.type === 'toolCall'
          && typeof part.id === 'string'
          && isPlainRecord(part.arguments)
        ) {
          toolCallArgs.set(part.id, part.arguments);
        }
      }
      continue;
    }
    if (msg.role !== 'toolResult' || typeof msg.toolCallId !== 'string' || typeof msg.toolName !== 'string') {
      continue;
    }
    const callId = msg.toolCallId;
    if (seen.has(callId)) continue;

    const toolName = msg.toolName;
    const isError = msg.isError === true;
    const cmDetails = toolName === 'codemode' ? parseCodemodeToolDetails(msg.details) : null;
    const persistedNested = parsePersistedNestedCalls(msg.nestedCalls);
    const childIds: string[] = [];
    let nestedCompleteness: NestedObservationCompleteness;

    if (persistedNested !== null) {
      let everyCallComplete = persistedNested.complete;
      for (const child of persistedNested.calls) {
        if (child.status === 'unfinished' || child.argumentsBytes !== undefined || child.arguments === undefined) {
          everyCallComplete = false;
        }
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        childIds.push(child.id);
        observations.push({
          callId: child.id,
          parentCallId: callId,
          toolName: child.name,
          isNested: true,
          status: child.status,
          isError: child.status === 'error',
          source: 'branch',
          ...(child.arguments === undefined ? {} : { input: child.arguments }),
          ...(child.argumentsBytes === undefined ? {} : { inputBytes: child.argumentsBytes }),
          ...(child.durationMs === undefined ? {} : { durationMs: child.durationMs }),
          ...(child.error === undefined ? {} : { errorPreview: child.error }),
          nestedCompleteness: 'none',
        });
      }
      nestedCompleteness = everyCallComplete
        ? (persistedNested.calls.length === 0 ? 'none' : 'complete')
        : 'unknown';
    } else if (toolName === 'codemode') {
      // Pi 1.6.1 omits message.nestedCalls when a script made zero nested calls.
      // Only a typed CodemodeToolDetails with calls.length === 0 proves 'none';
      // legacy or untyped records lacking message.nestedCalls stay 'unknown'.
      nestedCompleteness = cmDetails !== null && cmDetails.calls.length === 0 ? 'none' : 'unknown';
    } else {
      nestedCompleteness = 'none';
    }

    seen.add(callId);
    const input = toolCallArgs.get(callId);
    const status: ToolObservationStatus = cmDetails?.error?.kind === 'aborted'
      ? 'cancelled'
      : (isError ? 'error' : 'ok');

    observations.push({
      callId,
      toolName,
      isNested: false,
      status,
      isError,
      source: 'branch',
      ...(input === undefined ? {} : { input }),
      ...(cmDetails === null ? {} : { durationMs: cmDetails.durationMs }),
      ...(Array.isArray(msg.content) ? { content: msg.content as readonly (TextContent | ImageContent)[] } : {}),
      ...(msg.details === undefined ? {} : { details: msg.details }),
      ...(isPlainRecord(msg.usage) ? { usage: msg.usage as unknown as Usage } : {}),
      nestedCompleteness,
      ...(childIds.length > 0 ? { nestedCallIds: childIds } : {}),
      ...(cmDetails === null ? {} : { codemode: toCodemodeMetadata(cmDetails) }),
    });
  }

  return observations;
}
