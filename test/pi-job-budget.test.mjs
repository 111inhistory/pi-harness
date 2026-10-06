import assert from "node:assert/strict";
import test from "node:test";

import { BUDGET_WARNING_MESSAGE, createJobBudget } from "../src/job-budget.mjs";
import { ModelCallBudgetError, installModelCallBudget } from "../src/pi-job-budget.mjs";

const PROFILE = Object.freeze({
  modelCalls: Object.freeze({ soft: 2, hard: 3 }),
  activeTimeMs: Object.freeze({ soft: 10_000, hard: 20_000 }),
  lifetimeMs: 60_000,
});

/**
 * A minimal live-session stand-in: `streamFunction` is the provider boundary
 * (the agent loop and native compaction both call it) and `prepareRequest` is
 * the projection boundary Pi itself installs.
 */
function createFakeSession({ stream } = {}) {
  const session = {
    prepared: 0,
    streamed: 0,
    aborts: 0,
    agent: {
      async prepareRequest(request) {
        session.prepared += 1;
        return { context: request.context, marker: "native" };
      },
      streamFunction(model, context, options) {
        session.streamed += 1;
        return stream ? stream(model, context, options) : { stream: true, model, context, options };
      },
    },
    abort() {
      this.aborts += 1;
    },
  };
  return session;
}

function createRequest() {
  return { context: { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] } };
}

test("charges the model call at the stream boundary and chains the native prepareRequest", async () => {
  const session = createFakeSession();
  const originalPrepare = session.agent.prepareRequest;
  const originalStream = session.agent.streamFunction;
  const budget = createJobBudget({ profile: PROFILE });
  const cleanup = installModelCallBudget(session, budget);
  const request = createRequest();

  const update = await session.agent.prepareRequest(request, undefined);
  assert.equal(update.marker, "native", "the native projection handler still runs");
  assert.equal(session.prepared, 1);
  assert.equal(budget.snapshot().modelCalls, 0, "preparing a request must not charge it");

  const stream = session.agent.streamFunction("model-a", request.context, { signal: "s" });
  assert.equal(session.streamed, 1);
  assert.equal(stream.stream, true, "the previous stream handler's result passes through");
  assert.equal(stream.model, "model-a");
  assert.equal(stream.options.signal, "s", "stream options are forwarded unchanged");
  assert.equal(budget.snapshot().modelCalls, 1, "exactly one debit per provider request, never two");

  cleanup();
  assert.equal(session.agent.streamFunction, originalStream, "cleanup restores the previous stream handler");
  assert.equal(session.agent.prepareRequest, originalPrepare, "cleanup restores the previous prepare handler");
});

test("counts native compaction and retry attempts, one debit per provider attempt", () => {
  const session = createFakeSession();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(session, budget);

  // Compaction (`_runDefaultCompaction` -> `compact(..., agent.streamFunction)`)
  // and provider retries reach the same boundary without prepareRequest.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    session.agent.streamFunction("model-a", { messages: [] }, {});
  }
  assert.equal(session.streamed, 3);
  assert.equal(budget.snapshot().modelCalls, 3);

  assert.throws(
    () => session.agent.streamFunction("model-a", { messages: [] }, {}),
    (error) => {
      assert.ok(error instanceof ModelCallBudgetError);
      assert.equal(error.code, "budget_exceeded");
      assert.equal(error.terminal?.status, "failed");
      return true;
    },
  );
  assert.equal(session.streamed, 3, "a refused request must not reach the provider");
  assert.equal(session.aborts, 1);
  assert.equal(budget.check().terminal.status, "failed");
});

test("the soft warning is injected once as a per-request user message", async () => {
  const session = createFakeSession();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(session, budget);
  const request = createRequest();

  const first = await session.agent.prepareRequest(request, undefined);
  assert.equal(first.context.messages.length, 1);
  session.agent.streamFunction("model-a", first.context, {});

  const second = await session.agent.prepareRequest(request, undefined);
  assert.equal(second.context.messages.length, 1, "the warning follows the call that crossed soft");
  session.agent.streamFunction("model-a", second.context, {});

  const warned = await session.agent.prepareRequest(request, undefined);
  assert.equal(warned.context.messages.length, 2);
  const injected = warned.context.messages[1];
  assert.equal(injected.role, "user");
  assert.equal(injected.content[0].type, "text");
  assert.equal(injected.content[0].text, BUDGET_WARNING_MESSAGE, "the canonical soft control message is injected verbatim");
  assert.equal(typeof injected.timestamp, "number");

  const after = await session.agent.prepareRequest(request, undefined);
  assert.equal(after.context.messages.length, 1, "the soft warning is one-shot");
  assert.equal(request.context.messages.length, 1, "the caller's context is never mutated");
});

test("beforeRequest can stop the run before the budget is charged and before the provider", async () => {
  const session = createFakeSession();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(session, budget, {
    beforeRequest: () => ({ stop: true, reason: "A submission was already accepted." }),
  });

  // The stop gate sits at the provider boundary, so it also covers native
  // compaction, which never calls prepareRequest.
  assert.throws(() => session.agent.streamFunction("model-a", { messages: [] }, {}), /submission was already accepted/);
  assert.equal(budget.snapshot().modelCalls, 0);
  assert.equal(session.streamed, 0);
  assert.equal(session.aborts, 1);
});

test("cleanup leaves a later installer's handlers in place", () => {
  const session = createFakeSession();
  const budget = createJobBudget({ profile: PROFILE });
  const cleanup = installModelCallBudget(session, budget);
  const replacementPrepare = async () => undefined;
  const replacementStream = () => undefined;
  session.agent.prepareRequest = replacementPrepare;
  session.agent.streamFunction = replacementStream;

  cleanup();
  assert.equal(session.agent.prepareRequest, replacementPrepare);
  assert.equal(session.agent.streamFunction, replacementStream);
});

test("a session without a wrappable stream boundary fails with a clear hook error", () => {
  const budget = createJobBudget({ profile: PROFILE });
  for (const session of [{}, null, { agent: { prepareRequest: async () => undefined } }]) {
    assert.throws(
      () => installModelCallBudget(session, budget),
      (error) => error.code === "budget_hook_unavailable",
    );
  }
});
