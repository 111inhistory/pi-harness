import { setTimeout as delay } from 'node:timers/promises';
import { isRetryableAssistantError, type ClassifierContext, type ClassifierResult, type Usage } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ClassifierModelRef } from './harness-config.ts';

interface ClassifierAttempt {
  readonly model: ClassifierModelRef;
  readonly outcome: 'not_in_catalog' | 'answered' | 'unavailable' | 'transient' | 'failed' | 'aborted';
  readonly durationMs: number;
  readonly usage?: Usage;
}

export type ClassifierRun = {
  readonly outcome: 'answered'; readonly model: ClassifierModelRef; readonly result: ClassifierResult;
  readonly attempts: readonly ClassifierAttempt[];
} | {
  readonly outcome: 'failed'; readonly model: ClassifierModelRef;
  readonly errorMessage: string; readonly attempts: readonly ClassifierAttempt[];
} | {
  readonly outcome: 'aborted' | 'not_in_catalog'; readonly attempts: readonly ClassifierAttempt[];
};

interface ClassifierRequest {
  readonly registry: Pick<ModelRegistry, 'findOfType' | 'classify'>;
  readonly models: readonly ClassifierModelRef[];
  readonly context: ClassifierContext;
  /** The caller owns the operation deadline and aborts this signal. */
  readonly signal?: AbortSignal | undefined;
  readonly maxAttemptsPerModel: number;
  readonly retryDelayMs: (attempt: number) => number;
  /** Reserve one physical SDK attempt, or throw the caller's budget refusal. */
  readonly debitAttempt: () => void;
  readonly onAttempt?: (attempt: ClassifierAttempt) => void;
}

function unavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

export async function runClassifier({ registry, models, context, signal, maxAttemptsPerModel, retryDelayMs, debitAttempt, onAttempt }: ClassifierRequest): Promise<ClassifierRun> {
  const attempts: ClassifierAttempt[] = [];
  const record = (attempt: ClassifierAttempt): void => {
    attempts.push(attempt);
    try { onAttempt?.(attempt); } catch { /* Observation must not affect classifier routing. */ }
  };
  let lastFailure: { model: ClassifierModelRef; errorMessage: string } | undefined;
  const aborted = (): ClassifierRun => ({ outcome: 'aborted', attempts });
  for (const ref of models) {
    if (signal?.aborted) return aborted();
    const model = registry.findOfType('classifier', ref.provider, ref.id);
    if (!model) {
      record({ model: ref, outcome: 'not_in_catalog', durationMs: 0 });
      continue;
    }
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      if (signal?.aborted) return aborted();
      debitAttempt();
      if (signal?.aborted) return aborted();
      const started = performance.now();
      let result: ClassifierResult | undefined;
      let failure: unknown;
      try {
        result = await registry.classify(model, context, { maxRetries: 0, ...(signal ? { signal } : {}) });
      } catch (error) {
        failure = error;
      }
      const entry = { model: ref, durationMs: performance.now() - started, ...(result?.usage ? { usage: result.usage } : {}) };
      if (signal?.aborted || result?.stopReason === 'aborted') {
        record({ ...entry, outcome: 'aborted' });
        return aborted();
      }
      if (result?.stopReason === 'stop') {
        const actual = { provider: result.provider, id: result.model };
        record({ ...entry, model: actual, outcome: 'answered' });
        return { outcome: 'answered', model: actual, result, attempts };
      }
      const errorMessage = result?.errorMessage ?? (failure instanceof Error ? failure.message
        : failure === undefined ? 'the classifier returned no usable result' : String(failure));
      lastFailure = { model: ref, errorMessage };
      if (unavailable(failure)) {
        record({ ...entry, outcome: 'unavailable' });
        break;
      }
      // The SDK transient predicate only reads these two fields.
      const transient = (isRetryableAssistantError as (error: { stopReason: 'error'; errorMessage: string }) => boolean)(
        { stopReason: 'error', errorMessage },
      );
      if (!transient) {
        record({ ...entry, outcome: 'failed' });
        return { outcome: 'failed', ...lastFailure, attempts };
      }
      record({ ...entry, outcome: 'transient' });
      if (attempt < maxAttemptsPerModel) {
        try {
          await delay(retryDelayMs(attempt), undefined, { signal });
        } catch (error) {
          if (signal?.aborted) return aborted();
          throw error;
        }
      }
    }
  }
  if (signal?.aborted) return aborted();
  return lastFailure ? { outcome: 'failed', ...lastFailure, attempts } : { outcome: 'not_in_catalog', attempts };
}
