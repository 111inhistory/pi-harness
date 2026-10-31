import assert from "node:assert/strict";
import test from "node:test";

import { routeSubagent } from "../src/subagent/routing.ts";

const CLASSIFIER = { type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" };
const GEMINI = { type: "chat", provider: "openrouter", id: "~google/gemini-pro-latest" };

const CONFIG = {
  version: 2,
  classifier: { provider: "openrouter", id: "~typesafe/jev-latest" },
  instructions: {
    role: "Select the role for delegated_assignment.",
    model: "Select the model for delegated_assignment under selected_role.",
  },
  roles: [{
    id: "executor",
    instructions: "EXECUTOR INSTRUCTIONS",
    excludeTools: [],
    enableTools: [],
    candidates: [{ model: "gemini", thinking: "medium" }],
  }],
  models: [
    { id: "gemini", provider: "openrouter", model: "~google/gemini-pro-latest", preference: "GEMINI PREFERENCE" },
  ],
};

function stoppedRole() {
  return {
    api: "typesafe-system-one",
    provider: "openrouter",
    model: CLASSIFIER.id,
    answers: {
      role: {
        type: "choice",
        choice: "executor",
        probabilities: { executor: 1 },
        confidence: 1,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function failed(message) {
  return {
    api: "typesafe-system-one",
    provider: "openrouter",
    model: CLASSIFIER.id,
    answers: {},
    stopReason: "error",
    errorMessage: message,
    timestamp: 0,
  };
}

function createRegistry(responses) {
  const calls = [];
  return {
    calls,
    findOfType(type, provider, id) {
      if (type !== "classifier" || provider !== CLASSIFIER.provider || id !== CLASSIFIER.id) return undefined;
      return CLASSIFIER;
    },
    find(provider, id) {
      return provider === GEMINI.provider && id === GEMINI.id ? GEMINI : undefined;
    },
    async classify(model, context, options) {
      calls.push({ model, context, options });
      const response = responses[calls.length - 1];
      if (typeof response === "function") return response({ model, context, options, index: calls.length });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function createBudget(refusals = []) {
  const debits = [];
  return {
    debits,
    beginModelCall() {
      const sequence = debits.length + 1;
      debits.push(sequence);
      return refusals[sequence - 1] ?? { ok: true, sequence };
    },
  };
}

const refusal = {
  ok: false,
  reason: "budget_exceeded",
  terminal: {
    status: "failed",
    termination: "budget_exhausted",
    truncated: true,
    error: { code: "budget_exceeded", detail: {} },
  },
  error: { code: "budget_exceeded", detail: {} },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

function outcome(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

function mockRetryClock(t, random) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalRandom = Math.random;
  Math.random = () => random;
  t.after(() => {
    Math.random = originalRandom;
  });
}

function routingError(code) {
  return (error) => error?.code === code;
}

test("retries a network failure and a recoverable 5xx once each, with bounded exponential backoff", async (t) => {
  mockRetryClock(t, 0);
  const registry = createRegistry([
    failed("fetch failed"),
    failed("System One API error (503): service temporarily unavailable"),
    stoppedRole(),
  ]);
  const budget = createBudget();

  const pending = outcome(routeSubagent({ registry, budget, task: "TASK", config: CONFIG }));
  await flush();
  assert.equal(registry.calls.length, 1);

  t.mock.timers.tick(499);
  await flush();
  assert.equal(registry.calls.length, 1, "the first retry waits the full 500ms base delay");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(registry.calls.length, 2);

  t.mock.timers.tick(999);
  await flush();
  assert.equal(registry.calls.length, 2, "the second retry waits the doubled 1000ms delay");
  t.mock.timers.tick(1);
  await flush();

  const { value, error } = await pending;
  assert.equal(error, undefined);
  assert.equal(value.roleId, "executor");
  assert.equal(registry.calls.length, 3);
  assert.deepEqual(budget.debits, [1, 2, 3], "each physical provider attempt is charged exactly once");
  assert.ok(registry.calls.every((call) => call.options.maxRetries === 0), "the SDK inner retry is disabled, not stacked");
});

test("retries HTTP 429 and thrown transport failures", async (t) => {
  mockRetryClock(t, 0);
  const retryable = createRegistry([
    failed("System One API error (429): rate limit exceeded"),
    stoppedRole(),
  ]);
  const retryableBudget = createBudget();

  const retryablePending = outcome(routeSubagent({ registry: retryable, budget: retryableBudget, task: "TASK", config: CONFIG }));
  await flush();
  assert.equal(retryable.calls.length, 1);
  t.mock.timers.tick(500);
  await flush();
  const retryableResult = await retryablePending;
  assert.equal(retryableResult.error, undefined);
  assert.equal(retryable.calls.length, 2);
  assert.deepEqual(retryableBudget.debits, [1, 2]);

  const thrown = createRegistry([
    () => {
      throw new Error("fetch failed");
    },
    stoppedRole(),
  ]);
  const thrownBudget = createBudget();
  const thrownPending = outcome(routeSubagent({ registry: thrown, budget: thrownBudget, task: "TASK", config: CONFIG }));
  await flush();
  assert.equal(thrown.calls.length, 1);
  t.mock.timers.tick(500);
  await flush();
  const thrownResult = await thrownPending;
  assert.equal(thrownResult.error, undefined);
  assert.equal(thrown.calls.length, 2);
  assert.deepEqual(thrownBudget.debits, [1, 2]);
});

test("jitter shortens the retry wait but never increases the attempt count", async (t) => {
  mockRetryClock(t, 1);
  const registry = createRegistry([
    failed("fetch failed"),
    failed("fetch failed"),
    failed("fetch failed"),
    stoppedRole(),
  ]);
  const budget = createBudget();

  const pending = outcome(routeSubagent({ registry, budget, task: "TASK", config: CONFIG }));
  await flush();
  assert.equal(registry.calls.length, 1);

  t.mock.timers.tick(374);
  await flush();
  assert.equal(registry.calls.length, 1, "full jitter still waits 375ms, not less");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(registry.calls.length, 2);

  t.mock.timers.tick(749);
  await flush();
  assert.equal(registry.calls.length, 2, "the second jittered delay is 750ms");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(registry.calls.length, 3);

  const { error } = await pending;
  assert.equal(error?.code, "routing_classification_failed");
  assert.equal(error.detail.nativeError, "fetch failed");
  assert.equal(error.detail.stage, 1);
  assert.deepEqual(budget.debits, [1, 2, 3], "three attempts are the bound, even with a fourth response available");

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(registry.calls.length, 3, "no timer remains after the final attempt");
});

test("does not retry auth/config, other 4xx, parse or validation failures", async () => {
  const permanent = [
    ["401 Unauthorized: provider has no credentials", "routing_classification_failed"],
    ["403 Forbidden: account disabled", "routing_classification_failed"],
    ["400 Bad Request: invalid request", "routing_classification_failed"],
    ["No API key for provider: openrouter", "routing_classification_failed"],
    ["System One API returned invalid probabilities for role", "routing_classification_failed"],
    ["System One API did not return a choice answer for role", "routing_classification_failed"],
  ];
  for (const [message, code] of permanent) {
    const registry = createRegistry([failed(message)]);
    const budget = createBudget();
    await assert.rejects(
      routeSubagent({ registry, budget, task: "TASK", config: CONFIG }),
      routingError(code),
      message,
    );
    assert.equal(registry.calls.length, 1, `${message} must fail on the first physical attempt`);
    assert.deepEqual(budget.debits, [1]);
  }

  const malformed = createRegistry([{
    ...stoppedRole(),
    answers: {
      role: { type: "choice", choice: "root", probabilities: { executor: 0.1 }, confidence: 1 },
    },
  }]);
  const malformedBudget = createBudget();
  await assert.rejects(
    routeSubagent({ registry: malformed, budget: malformedBudget, task: "TASK", config: CONFIG }),
    routingError("routing_invalid_answer"),
  );
  assert.equal(malformed.calls.length, 1, "a malformed successful answer is not a transport failure");
  assert.deepEqual(malformedBudget.debits, [1]);
});

test("cancellation during backoff stops further attempts and reports an abort", async (t) => {
  mockRetryClock(t, 0);
  const registry = createRegistry([failed("fetch failed"), stoppedRole()]);
  const budget = createBudget();
  const controller = new AbortController();

  const pending = outcome(routeSubagent({
    registry,
    budget,
    task: "TASK",
    config: CONFIG,
    signal: controller.signal,
  }));
  await flush();
  assert.equal(registry.calls.length, 1);

  controller.abort();
  await flush();

  const { error } = await pending;
  assert.equal(error?.code, "routing_aborted");
  assert.equal(registry.calls.length, 1);
  assert.deepEqual(budget.debits, [1], "no debit is taken for the cancelled retry");

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(registry.calls.length, 1, "the cleared backoff timer must not dispatch a retry");
});

test("a budget refusal on a retry stops before dispatch and keeps honest physical debit counts", async (t) => {
  mockRetryClock(t, 0);
  const registry = createRegistry([
    failed("fetch failed"),
    failed("fetch failed"),
    stoppedRole(),
  ]);
  const budget = createBudget([undefined, undefined, refusal]);

  const pending = outcome(routeSubagent({ registry, budget, task: "TASK", config: CONFIG }));
  await flush();
  assert.equal(registry.calls.length, 1);

  t.mock.timers.tick(500);
  await flush();
  assert.equal(registry.calls.length, 2);

  t.mock.timers.tick(1_000);
  await flush();
  const { error } = await pending;
  assert.equal(error?.code, "budget_exceeded");
  assert.equal(registry.calls.length, 2, "the refused third attempt never reaches the provider");
  assert.deepEqual(budget.debits, [1, 2, 3]);
});
