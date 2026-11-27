import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { emitHookStat, installHookStats } from '../../src/hooks/stats.ts';

test('Hook Stats bounds rule IDs and rejects reports from a retired session', async () => {
  const lifecycle = new Map<string, () => void>();
  const host = {
    on(event: string, handler: () => void) { lifecycle.set(event, handler); },
  } as unknown as ExtensionAPI;
  const bind = installHookStats(host);
  const render = (): string => bind.render() ?? '';

  assert.equal(bind.capture(), undefined);
  lifecycle.get('session_start')!();
  const first = bind.capture();
  assert.ok(first);
  for (let index = 0; index < 70; index += 1) first({ type: 'hook', id: `rule-${index}`, outcome: 'matched' });
  let report = render();
  assert.equal(report.split('\n').filter(line => line.startsWith('Hook rule-')).length, 64);
  assert.match(report, /Other Hook IDs: matched=6/);
  assert.doesNotMatch(report, /rule-69/);
  first({ type: 'classifier-result', outcome: 'answered', durationMs: 2.7 });
  const copy = bind.snapshot();
  assert.ok(copy);
  assert.equal(copy.classifier.durationMs, 3);
  copy.classifier.outcomes.answered = 10;
  copy.rules[0]!.matched = 99;
  copy.tools[0]!.calls = 99;
  assert.equal(bind.snapshot()?.classifier.outcomes.answered, 1);
  assert.equal(bind.snapshot()?.rules[0]?.matched, 1);
  assert.equal(bind.snapshot()?.tools[0]?.calls, 0);

  lifecycle.get('session_shutdown')!();
  assert.equal(bind.capture(), undefined);
  assert.equal(bind.snapshot(), undefined);
  lifecycle.get('session_start')!();
  first({ type: 'hook', id: 'retired-rule', outcome: 'failed' });
  bind.capture()?.({ type: 'hook', id: 'current-rule', outcome: 'suppressed' });
  report = render();
  assert.match(report, /Hook current-rule: suppressed=1/);
  assert.doesNotMatch(report, /retired-rule|rule-69|Other Hook IDs/);
  assert.doesNotThrow(() => emitHookStat(() => { throw new Error('observer failed'); }, { type: 'classifier-start' }));
});
