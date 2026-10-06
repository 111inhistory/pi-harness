import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_WARNING_MESSAGE,
  JOB_BUDGET_BY_DEPTH,
  JobBudgetError,
  createJobBudget,
  profileForDepth,
} from "../src/job-budget.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Deterministic stand-in for the adapter's monotonic clock.
function createClock(start = 10_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
      return value;
    },
  };
}

function jobBudgetError(code) {
  return (error) => error instanceof JobBudgetError && error.code === code;
}

test("selects the frozen depth profile and reports it in detailed snapshots", () => {
  assert.deepEqual(JOB_BUDGET_BY_DEPTH, {
    1: {
      modelCalls: { soft: 160, hard: 200 },
      activeTimeMs: { soft: 90 * MINUTE, hard: 120 * MINUTE },
      lifetimeMs: 24 * HOUR,
    },
    2: {
      modelCalls: { soft: 48, hard: 64 },
      activeTimeMs: { soft: 45 * MINUTE, hard: 60 * MINUTE },
      lifetimeMs: 12 * HOUR,
    },
  });
  assert.ok(Object.isFrozen(JOB_BUDGET_BY_DEPTH));
  assert.ok(Object.isFrozen(JOB_BUDGET_BY_DEPTH[1].modelCalls));

  const clock = createClock();
  assert.equal(profileForDepth(2), JOB_BUDGET_BY_DEPTH[2]);

  const budget = createJobBudget({ depth: 2, jobId: "job_07", now: clock.now });
  assert.equal(budget.depth, 2);
  assert.equal(budget.jobId, "job_07");
  assert.equal(budget.profile, JOB_BUDGET_BY_DEPTH[2]);
  assert.equal(budget.terminal, null);

  const detailed = budget.snapshot({ detail: true });
  assert.equal(detailed.depth, 2);
  assert.equal(detailed.jobId, "job_07");
  assert.deepEqual(detailed.profile, JOB_BUDGET_BY_DEPTH[2]);
  assert.ok(!("profile" in budget.snapshot()));

  assert.throws(() => profileForDepth(3), jobBudgetError("invalid_depth"));
});

test("counts Model Calls before dispatch and warns exactly once at soft", () => {
  const clock = createClock();
  const budget = createJobBudget({ depth: 2, now: clock.now });

  for (let call = 1; call <= 47; call += 1) {
    assert.deepEqual(budget.beginModelCall(), { ok: true, sequence: call });
  }
  assert.equal(budget.snapshot().phase, "normal");
  assert.equal(budget.takeWarning(), null);

  assert.deepEqual(budget.beginModelCall(), { ok: true, sequence: 48 });
  const warned = budget.snapshot();
  assert.equal(warned.phase, "warning");
  assert.equal(warned.modelCalls, 48);
  assert.equal(warned.terminal, null);
  assert.equal(warned.warningTaken, false);

  assert.equal(budget.takeWarning(), BUDGET_WARNING_MESSAGE);
  assert.equal(budget.takeWarning(), null);
  assert.equal(budget.snapshot().warningTaken, true);

  for (let call = 49; call <= 64; call += 1) {
    assert.equal(budget.beginModelCall().ok, true);
  }
  assert.equal(budget.snapshot().phase, "warning");
  assert.equal(budget.takeWarning(), null);
});

test("allows the hard-th Model Call and rejects the projected hard+1", () => {
  const clock = createClock();
  const budget = createJobBudget({ depth: 2, now: clock.now });
  for (let call = 1; call <= 64; call += 1) {
    assert.equal(budget.beginModelCall().ok, true);
  }
  assert.equal(budget.snapshot().modelCalls, 64);

  const rejected = budget.beginModelCall();
  assert.deepEqual(rejected, {
    ok: false,
    reason: "budget_exceeded",
    terminal: {
      status: "failed",
      termination: "budget_exhausted",
      truncated: true,
      error: {
        code: "budget_exceeded",
        detail: { dimension: "model_calls", soft: 48, hard: 64, observed: 64, rejectedProjected: 65 },
      },
    },
    error: {
      code: "budget_exceeded",
      detail: { dimension: "model_calls", soft: 48, hard: 64, observed: 64, rejectedProjected: 65 },
    },
  });

  const frozen = budget.snapshot();
  assert.equal(frozen.modelCalls, 64);
  assert.equal(frozen.rejectedProjectedModelCalls, 65);
  assert.equal(frozen.phase, "exhausted");
  assert.deepEqual(frozen.terminal, rejected.terminal);

  const again = budget.beginModelCall();
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already_terminal");
  assert.deepEqual(again.terminal, rejected.terminal);

  // Depth 1 carries the same shape at its own ceiling.
  const depthOne = createJobBudget({ depth: 1, now: clock.now });
  for (let call = 1; call <= 200; call += 1) {
    assert.equal(depthOne.beginModelCall().ok, true);
  }
  const rejectedOne = depthOne.beginModelCall();
  assert.equal(rejectedOne.ok, false);
  assert.deepEqual(rejectedOne.error.detail, {
    dimension: "model_calls",
    soft: 160,
    hard: 200,
    observed: 200,
    rejectedProjected: 201,
  });
});

test("accrues Active Time only while running and expires at the active hard limit", () => {
  const clock = createClock();
  const budget = createJobBudget({ depth: 2, now: clock.now });

  clock.advance(30 * MINUTE); // queued
  assert.equal(budget.check().terminal, null);
  assert.equal(budget.snapshot().activeTimeMs, 0);

  assert.deepEqual(budget.startActive(), { ok: true, activeTimeMs: 0 });
  assert.equal(budget.startActive().reason, "already_running");
  clock.advance(20 * MINUTE);
  assert.equal(budget.snapshot().activeTimeMs, 20 * MINUTE);
  assert.equal(budget.snapshot().running, true);

  assert.deepEqual(budget.pauseActive(), { ok: true, activeTimeMs: 20 * MINUTE });
  clock.advance(40 * MINUTE); // waiting: free for Active Time, still leased
  const waiting = budget.snapshot({ detail: true });
  assert.equal(waiting.activeTimeMs, 20 * MINUTE);
  assert.equal(waiting.elapsedMs, 90 * MINUTE);
  assert.equal(waiting.running, false);
  assert.deepEqual(budget.pauseActive(), { ok: true, activeTimeMs: 20 * MINUTE });

  budget.startActive();
  clock.advance(25 * MINUTE); // 45m active: soft
  assert.equal(budget.snapshot().phase, "warning");
  assert.equal(budget.takeWarning(), BUDGET_WARNING_MESSAGE);

  clock.advance(15 * MINUTE); // 60m active: hard
  const expired = budget.check();
  assert.deepEqual(expired.terminal, {
    status: "failed",
    termination: "budget_exhausted",
    truncated: true,
    error: {
      code: "budget_exceeded",
      detail: { dimension: "active_time", soft: 45 * MINUTE, hard: 60 * MINUTE, observed: 60 * MINUTE },
    },
  });
  assert.equal(expired.phase, "exhausted");
  assert.equal(expired.running, false);
  assert.equal(expired.activeTimeMs, 60 * MINUTE);

  const refusedCall = budget.beginModelCall();
  assert.equal(refusedCall.ok, false);
  assert.equal(refusedCall.reason, "already_terminal");
});

for (const [depth, lifetimeMs] of [
  [1, 24 * HOUR],
  [2, 12 * HOUR],
]) {
  test(`expires depth ${depth} on lifetime even for a job that never ran`, () => {
    const clock = createClock();
    const budget = createJobBudget({ depth, now: clock.now });

    clock.advance(lifetimeMs - 1);
    assert.equal(budget.check().terminal, null);

    clock.advance(1);
    const expired = budget.check();
    assert.deepEqual(expired.terminal, {
      status: "failed",
      termination: "lifetime_expired",
      truncated: true,
      error: { code: "job_expired", detail: { lifetimeMs, elapsedMs: lifetimeMs } },
    });
    assert.equal(expired.phase, "exhausted");
    assert.equal(expired.modelCalls, 0);
    assert.equal(expired.activeTimeMs, 0);
    assert.equal(expired.running, false);

    assert.equal(budget.startActive().ok, false);
    assert.equal(budget.beginModelCall().ok, false);
    assert.equal(budget.terminate({ reason: "model_final" }).ok, false);
    assert.deepEqual(budget.snapshot().terminal, expired.terminal);
  });
}

test("freezes monotonically at the terminal state", () => {
  const clock = createClock();
  const finished = createJobBudget({ depth: 2, now: clock.now });
  for (let call = 1; call <= 48; call += 1) {
    finished.beginModelCall();
  }

  assert.deepEqual(finished.terminate({ reason: "model_final" }), {
    ok: true,
    terminal: { status: "completed", termination: "model_final", truncated: false, error: null },
  });

  const frozen = finished.snapshot();
  assert.equal(frozen.phase, "warning");
  assert.equal(frozen.modelCalls, 48);
  assert.equal(finished.takeWarning(), null);

  clock.advance(24 * HOUR);
  assert.deepEqual(finished.snapshot(), frozen);
  assert.deepEqual(finished.check(), frozen);
  assert.equal(finished.beginModelCall().reason, "already_terminal");
  assert.deepEqual(finished.startActive(), {
    ok: false,
    reason: "already_terminal",
    terminal: frozen.terminal,
    error: null,
    activeTimeMs: 0,
  });
  assert.deepEqual(finished.terminate({ reason: "cancelled" }), {
    ok: false,
    reason: "already_terminal",
    terminal: frozen.terminal,
    error: null,
  });

  // A budget failure is equally final: a later model_final cannot overwrite it.
  const blown = createJobBudget({ depth: 2, now: clock.now });
  for (let call = 1; call <= 65; call += 1) {
    blown.beginModelCall();
  }
  const failure = blown.snapshot().terminal;
  assert.equal(blown.terminate({ reason: "model_final" }).ok, false);
  assert.deepEqual(blown.snapshot().terminal, failure);

  // Cancelling closes the running window without returning quota.
  const cancelled = createJobBudget({ depth: 1, now: clock.now });
  assert.equal(cancelled.terminate({ reason: "cancelled" }).ok, true);
  const running = createJobBudget({ depth: 1, now: clock.now });
  running.startActive();
  clock.advance(10 * MINUTE);
  assert.deepEqual(running.terminate({ reason: "cancelled" }), {
    ok: true,
    terminal: {
      status: "cancelled",
      termination: "cancelled",
      truncated: true,
      error: { code: "cancelled", message: "Job cancelled." },
    },
  });
  clock.advance(HOUR);
  assert.equal(running.snapshot().activeTimeMs, 10 * MINUTE);
  assert.equal(running.pauseActive().ok, true);
  assert.equal(running.snapshot().activeTimeMs, 10 * MINUTE);
});

test("snapshots and terminal errors are immutable", () => {
  const clock = createClock();
  const budget = createJobBudget({ depth: 2, now: clock.now });
  budget.beginModelCall();
  const view = budget.snapshot();
  assert.ok(Object.isFrozen(view));
  assert.throws(() => {
    view.modelCalls = 99;
  }, TypeError);
  assert.throws(() => {
    view.phase = "normal";
  }, TypeError);

  const blown = createJobBudget({ depth: 2, now: clock.now });
  for (let call = 1; call <= 65; call += 1) {
    blown.beginModelCall();
  }
  const { terminal } = blown.snapshot();
  assert.ok(Object.isFrozen(terminal));
  assert.ok(Object.isFrozen(terminal.error));
  assert.ok(Object.isFrozen(terminal.error.detail));
  assert.throws(() => {
    terminal.error.detail.hard = 1;
  }, TypeError);

  const error = new JobBudgetError("invalid_depth", "boom", { depth: 9 });
  assert.ok(Object.isFrozen(error.detail));
});

test("rejects invalid depth and options", () => {
  const clock = createClock();
  const invalidDepth = (options) =>
    assert.throws(() => createJobBudget(options), jobBudgetError("invalid_depth"));

  invalidDepth();
  invalidDepth({ depth: 0 });
  invalidDepth({ depth: 3 });
  invalidDepth({ depth: 1.5 });
  invalidDepth({ depth: "2" });
  invalidDepth({ depth: null, now: clock.now });
  invalidDepth({ profile: undefined });

  const invalidOptions = (options) =>
    assert.throws(() => createJobBudget(options), jobBudgetError("invalid_options"));

  invalidOptions("depth 1");
  invalidOptions({ depth: 1, soft: 10 });
  invalidOptions({ depth: 1, now: 42 });
  invalidOptions({ depth: 1, now: () => "later" });
  invalidOptions({ depth: 1, jobId: 7 });
  invalidOptions({ depth: 1, jobId: "" });
  invalidOptions({
    depth: 1,
    profile: { modelCalls: { soft: 5, hard: 4 }, activeTimeMs: { soft: 1, hard: 2 }, lifetimeMs: 10 },
  });
  invalidOptions({
    depth: 1,
    profile: { modelCalls: { soft: 5, hard: 8 }, activeTimeMs: { soft: 1, hard: 2 } },
  });
  invalidOptions({
    depth: 1,
    profile: { modelCalls: { soft: 5, hard: 8 }, activeTimeMs: { soft: 1, hard: 2 }, lifetimeMs: 10, extra: true },
  });

  const budget = createJobBudget({ depth: 2, now: clock.now });
  assert.throws(() => budget.terminate({ reason: "exploded" }), jobBudgetError("invalid_options"));
  assert.throws(() => budget.terminate(), jobBudgetError("invalid_options"));
  assert.throws(() => budget.snapshot({ detail: "yes" }), jobBudgetError("invalid_options"));
  assert.throws(() => budget.snapshot({ verbose: true }), jobBudgetError("invalid_options"));
});

test("honours an explicit profile without a depth", () => {
  const clock = createClock();
  const profile = {
    modelCalls: { soft: 2, hard: 4 },
    activeTimeMs: { soft: 1_000, hard: 2_000 },
    lifetimeMs: 60_000,
  };
  const budget = createJobBudget({ profile, now: clock.now, jobId: "capability" });

  assert.equal(budget.depth, null);
  assert.deepEqual(budget.snapshot({ detail: true }).profile, profile);

  for (let call = 1; call <= 4; call += 1) {
    assert.equal(budget.beginModelCall().ok, true);
  }
  assert.equal(budget.takeWarning(), BUDGET_WARNING_MESSAGE);
  const rejected = budget.beginModelCall();
  assert.equal(rejected.reason, "budget_exceeded");
  assert.deepEqual(rejected.error.detail, {
    dimension: "model_calls",
    soft: 2,
    hard: 4,
    observed: 4,
    rejectedProjected: 5,
  });
});
