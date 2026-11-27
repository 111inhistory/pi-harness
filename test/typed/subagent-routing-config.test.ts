import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { resolveHarnessConfig } from '../../src/harness-config.ts';
import { createJobBudget } from '../../src/subagent/job-budget.ts';
import { routeSubagent, SubagentRoutingError, type RouteSubagentInput } from '../../src/subagent/routing.ts';
import { waitFor } from '../../test-support/async.ts';

async function fixture(t: TestContext, failedAttempts: number) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'routing-config-fixture', reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0]!;
  const registry = new ModelRegistry(runtime);
  let attempts = 0;
  const classify: RouteSubagentInput['registry']['classify'] = async (classifier) => {
    attempts++;
    const base = { api: classifier.api, provider: classifier.provider, model: classifier.id, timestamp: 0 };
    return attempts <= failedAttempts
      ? { ...base, answers: {}, stopReason: 'error', errorMessage: 'fetch failed' }
      : { ...base, answers: { role: { type: 'choice', choice: 'executor', probabilities: { executor: 1 }, confidence: 1 } }, stopReason: 'stop' };
  };
  const calls = t.mock.method(registry, 'classify', classify);
  return {
    registry,
    calls,
    models: [{ provider: 'openrouter', id: '~typesafe/jev-latest' }],
    budget: createJobBudget({ depth: 1 }),
    config: {
      version: 4,
      instructions: { role: 'Select the executor.', model: 'Select the fixture.' },
      roles: [{ id: 'executor', instructions: 'Complete the fixture.', candidates: { fixture: {
        model: { provider: model.provider, id: model.id }, thinkingLevel: 'medium', description: 'Offline fixture.',
      } } }],
    },
  };
}

test('configured retry intervals and maximum replace the defaults and charge every physical call', async (t) => {
  const setup = await fixture(t, 2);
  t.mock.method(Math, 'random', () => 0);
  const retry = resolveHarnessConfig([{ source: 'fixture', value: { subagent: {
    routingRetry: { maxAttempts: 3, baseDelayMs: 80, maxDelayMs: 120, jitterRatio: 0 },
  } } }]).subagent.routingRetry;
  const pending = routeSubagent({ ...setup, task: 'TASK', retry }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await waitFor(() => setup.calls.mock.callCount() === 1, { label: 'the first classifier call' });
  await sleep(50);
  assert.equal(setup.calls.mock.callCount(), 1, 'the first retry waits the configured base delay');

  await waitFor(() => setup.calls.mock.callCount() === 2, { label: 'the first retry' });
  const secondAt = performance.now();
  await waitFor(() => setup.calls.mock.callCount() === 3, { label: 'the second retry' });
  assert.ok(performance.now() - secondAt >= 100, 'the second backoff uses the configured maximum');

  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(result.value?.roleId, 'executor');
  assert.equal(setup.calls.mock.callCount(), 3);
  assert.equal(setup.budget.snapshot().modelCalls, 3);
  assert.ok(setup.calls.mock.calls.every((call) => call.arguments[2]?.maxRetries === 0));
});

test('a configured single attempt returns the first transient error without a retry', async (t) => {
  const setup = await fixture(t, 1);
  const retry = resolveHarnessConfig([{ source: 'fixture', value: { subagent: {
    routingRetry: { maxAttempts: 1 },
  } } }]).subagent.routingRetry;
  await assert.rejects(
    routeSubagent({ ...setup, task: 'TASK', retry }),
    (error: unknown) => error instanceof SubagentRoutingError && error.code === 'routing_classification_failed',
  );
  assert.equal(setup.calls.mock.callCount(), 1);
  assert.equal(setup.budget.snapshot().modelCalls, 1);
  assert.equal(setup.calls.mock.calls[0]?.arguments[2]?.maxRetries, 0);
});
