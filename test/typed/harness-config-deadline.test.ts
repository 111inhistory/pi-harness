import assert from 'node:assert/strict';
import test from 'node:test';
import { watchCapabilityBudget } from '../../src/subagent/budget-watch.ts';

// Configurable leases can exceed Node's signed 32-bit timer delay.
test('a paused long Budget waits in bounded timer chunks until its actual lease expires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timer = t.mock.method(globalThis, 'setTimeout');
  const nodeMaxDelay = 2_147_483_647;
  const lifetimeMs = 30 * 24 * 60 * 60 * 1_000;
  let elapsedMs = 0;
  let expirations = 0;
  const stop = watchCapabilityBudget({
    snapshot: () => ({
      profile: { activeTimeMs: { hard: lifetimeMs }, lifetimeMs },
      elapsedMs,
      activeTimeMs: 0,
      running: false,
    }),
    check: () => ({ terminal: elapsedMs >= lifetimeMs ? { status: 'failed' } : null }),
  }, () => { expirations++; });
  try {
    assert.equal(timer.mock.calls[0]?.arguments[1], nodeMaxDelay);
    elapsedMs = nodeMaxDelay;
    t.mock.timers.tick(nodeMaxDelay);
    assert.equal(expirations, 0);
    assert.equal(timer.mock.calls[1]?.arguments[1], lifetimeMs - nodeMaxDelay);

    elapsedMs = lifetimeMs;
    t.mock.timers.tick(lifetimeMs - nodeMaxDelay);
    assert.equal(expirations, 1);
    assert.equal(timer.mock.callCount(), 2, 'a terminal Budget does not schedule another timer');
  } finally {
    stop();
  }
});
