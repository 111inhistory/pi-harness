/**
 * Focused contract tests for the shared Budget deadline watcher.
 *
 * Both wrappers are production code. The fakes provide only the Budget
 * observation surface; the timer math, rescheduling and cleanup are exercised
 * through Node's mocked setTimeout.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BudgetDeadlineSnapshot,
  type BudgetObservation,
  type BudgetTerminalView,
  type CapabilityBudgetWatch,
  watchCapabilityBudget,
  watchSubagentBudget,
} from "../../src/subagent/budget-watch.ts";

interface FakeBudgetState {
  elapsedMs: number;
  activeTimeMs: number;
  running: boolean;
  lifetimeMs: number;
  activeHardMs: number;
  terminal: BudgetTerminalView | null;
}

function fakeState(overrides: Partial<FakeBudgetState> = {}): FakeBudgetState {
  return {
    elapsedMs: 0,
    activeTimeMs: 0,
    running: true,
    lifetimeMs: 10_000,
    activeHardMs: 10_000,
    terminal: null,
    ...overrides,
  };
}

function snapshotOf(state: FakeBudgetState): BudgetDeadlineSnapshot {
  return {
    profile: {
      activeTimeMs: { hard: state.activeHardMs },
      lifetimeMs: state.lifetimeMs,
    },
    elapsedMs: state.elapsedMs,
    activeTimeMs: state.activeTimeMs,
    running: state.running,
  };
}

interface FakeCapabilityBudget {
  readonly budget: CapabilityBudgetWatch;
}

function fakeCapabilityBudget(state: FakeBudgetState, onCheck: () => void): FakeCapabilityBudget {
  return {
    budget: {
      snapshot: (): BudgetDeadlineSnapshot => snapshotOf(state),
      check(): BudgetObservation {
        onCheck();
        return { terminal: state.terminal };
      },
    },
  };
}

test("capability watch schedules from the earliest wall-clock bound and aborts only on a failed terminal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = fakeState({ elapsedMs: 2_000, activeTimeMs: 4_500, activeHardMs: 5_000, lifetimeMs: 10_000 });
  let checks = 0;
  const fake = fakeCapabilityBudget(state, () => { checks += 1; });
  const expired: BudgetTerminalView[] = [];

  const stop = watchCapabilityBudget(fake.budget, (terminal) => expired.push(terminal));
  assert.equal(checks, 1, "the watch observes immediately");

  // Active Time remaining (500ms) is sooner than lifetime remaining (8000ms).
  t.mock.timers.tick(499);
  assert.equal(checks, 1);
  t.mock.timers.tick(1);
  assert.equal(checks, 2);

  // A paused Budget only has its absolute lifetime lease left.
  state.running = false;
  state.elapsedMs = 9_000;
  t.mock.timers.tick(500);
  assert.equal(checks, 3);
  t.mock.timers.tick(999);
  assert.equal(checks, 3, "lifetime remaining is 1000ms from the last observation");
  t.mock.timers.tick(1);
  assert.equal(checks, 4);

  // Only a failed terminal reaches this policy's abort callback.
  const failed: BudgetTerminalView = { status: "failed", error: { code: "job_expired" } };
  state.terminal = failed;
  t.mock.timers.tick(1_000);
  assert.equal(checks, 5);
  assert.deepEqual(expired, [failed]);
  t.mock.timers.tick(60_000);
  assert.equal(checks, 5, "a terminal verdict ends the watch");
  stop();
});

test("capability watch ends without aborting on completed or cancelled terminals", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of ["completed", "cancelled"] as const) {
    const state = fakeState({ terminal: { status } });
    let checks = 0;
    const fake = fakeCapabilityBudget(state, () => { checks += 1; });
    const expired: BudgetTerminalView[] = [];
    const stop = watchCapabilityBudget(fake.budget, (terminal) => expired.push(terminal));
    assert.equal(checks, 1);
    t.mock.timers.tick(60_000);
    assert.equal(checks, 1, "no timer is scheduled for a terminal Budget");
    assert.deepEqual(expired, [], `${status} is not a budget failure`);
    stop();
  }
});

test("capability watch cleanup prevents later observations", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = fakeState();
  let checks = 0;
  let expired = 0;
  const fake = fakeCapabilityBudget(state, () => { checks += 1; });
  const stop = watchCapabilityBudget(fake.budget, () => { expired += 1; });
  assert.equal(checks, 1);

  stop();
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(checks, 1);
  assert.equal(expired, 0);
});

test("subagent watch observes through checkBudget and stops on any terminal verdict", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = fakeState({ activeTimeMs: 0, activeHardMs: 1_000, lifetimeMs: 10_000 });
  const budget = { snapshot: (): BudgetDeadlineSnapshot => snapshotOf(state) };
  let observations = 0;
  const checkBudget = (): BudgetObservation => {
    observations += 1;
    return { terminal: state.terminal };
  };

  const stop = watchSubagentBudget(budget, checkBudget);
  assert.equal(observations, 1);

  t.mock.timers.tick(999);
  assert.equal(observations, 1);
  t.mock.timers.tick(1);
  assert.equal(observations, 2);

  // The runtime's verdict is authoritative: the watcher itself has no abort
  // policy and never asks the Budget directly.
  state.terminal = { status: "failed", error: { code: "budget_exceeded" } };
  t.mock.timers.tick(1_000);
  assert.equal(observations, 3);
  t.mock.timers.tick(60_000);
  assert.equal(observations, 3, "a terminal verdict ends the watch");
  stop();
});

test("both watches share the one-millisecond deadline floor", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const capabilityState = fakeState({ elapsedMs: 20_000, lifetimeMs: 10_000 });
  let capabilityChecks = 0;
  const capability = fakeCapabilityBudget(capabilityState, () => { capabilityChecks += 1; });
  const capabilityStop = watchCapabilityBudget(capability.budget, () => {});
  assert.equal(capabilityChecks, 1);
  t.mock.timers.tick(1);
  assert.equal(capabilityChecks, 2, "an expired deadline is observed again after the 1ms floor");
  capabilityStop();

  const subagentState = fakeState({ elapsedMs: 20_000, lifetimeMs: 10_000 });
  const subagentBudget = { snapshot: (): BudgetDeadlineSnapshot => snapshotOf(subagentState) };
  let subagentChecks = 0;
  const subagentStop = watchSubagentBudget(subagentBudget, () => {
    subagentChecks += 1;
    return { terminal: subagentState.terminal };
  });
  assert.equal(subagentChecks, 1);
  t.mock.timers.tick(1);
  assert.equal(subagentChecks, 2, "the same floor applies to the Subagent policy");
  subagentStop();
});
