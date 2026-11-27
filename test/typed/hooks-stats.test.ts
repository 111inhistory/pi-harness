import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { emitHookStat, installHookStats } from '../../src/hooks/stats.ts';

test('Hook Stats bounds rule IDs and rejects reports from a retired session', async () => {
  const lifecycle = new Map<string, () => void>();
  let command: { handler(args: string, ctx: { ui: { notify(text: string): void } }): Promise<void> } | undefined;
  const host = {
    on(event: string, handler: () => void) { lifecycle.set(event, handler); },
    registerCommand(_name: string, handler: typeof command) { command = handler; },
  } as unknown as ExtensionAPI;
  const bind = installHookStats(host);
  const render = async (): Promise<string> => {
    let text = '';
    assert.ok(command);
    await command.handler('', { ui: { notify: notification => { text = notification; } } });
    return text;
  };

  assert.equal(bind(), undefined);
  lifecycle.get('session_start')!();
  const first = bind();
  assert.ok(first);
  for (let index = 0; index < 70; index += 1) first({ type: 'hook', id: `rule-${index}`, outcome: 'matched' });
  let report = await render();
  assert.equal(report.split('\n').filter(line => line.startsWith('Hook rule-')).length, 64);
  assert.match(report, /Other Hook IDs: matched=6/);
  assert.doesNotMatch(report, /rule-69/);

  lifecycle.get('session_shutdown')!();
  assert.equal(bind(), undefined);
  lifecycle.get('session_start')!();
  first({ type: 'hook', id: 'retired-rule', outcome: 'failed' });
  bind()?.({ type: 'hook', id: 'current-rule', outcome: 'suppressed' });
  report = await render();
  assert.match(report, /Hook current-rule: suppressed=1/);
  assert.doesNotMatch(report, /retired-rule|rule-69|Other Hook IDs/);
  assert.doesNotThrow(() => emitHookStat(() => { throw new Error('observer failed'); }, { type: 'classifier-start' }));
});
