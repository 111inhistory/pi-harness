import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { resolveHarnessConfig } from '../../src/harness-config.ts';
import { createJobBudget } from '../../src/subagent/job-budget.ts';
import { routeSubagent, SubagentRoutingError, type RouteSubagentInput } from '../../src/subagent/routing.ts';

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
    budget: createJobBudget({ depth: 1 }),
    config: {
      version: 3,
      classifier: { provider: 'openrouter', id: '~typesafe/jev-latest' },
      instructions: { role: 'Select the executor.', model: 'Select the fixture.' },
      roles: [{ id: 'executor', instructions: 'Complete the fixture.', candidates: { fixture: {
        model: { provider: model.provider, id: model.id }, thinkingLevel: 'medium', description: 'Offline fixture.',
      } } }],
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('configured retry intervals and maximum replace the defaults and charge every physical call', async (t) => {
  const setup = await fixture(t, 2);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const retry = resolveHarnessConfig([{ source: 'fixture', value: { subagent: {
    routingRetry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 60, jitterRatio: 0 },
  } } }]).subagent.routingRetry;
  const pending = routeSubagent({ ...setup, task: 'TASK', retry }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await flush();
  assert.equal(setup.calls.mock.callCount(), 1);
  t.mock.timers.tick(49);
  await flush();
  assert.equal(setup.calls.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(setup.calls.mock.callCount(), 2, 'the first retry uses the configured 50 ms base');
  t.mock.timers.tick(59);
  await flush();
  assert.equal(setup.calls.mock.callCount(), 2);
  t.mock.timers.tick(1);
  await flush();

  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(result.value?.roleId, 'executor');
  assert.equal(setup.calls.mock.callCount(), 3, 'the second backoff is capped at the configured 60 ms');
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
