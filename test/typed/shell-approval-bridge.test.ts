import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { installInheritedShellChecks, publishShellCheck, SHELL_APPROVAL_WAIT } from '../../src/shell-approval/bridge.ts';

function surface() {
  const emitter = new EventEmitter();
  const handlers = new Map<string, (event: ToolCallEvent, ctx: ExtensionContext) => unknown>();
  const events = {
    on(channel: string, handler: (data: unknown) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    emit(channel: string, data: unknown) { emitter.emit(channel, data); },
  };
  return { api: { events, on: (name: string, fn: (event: ToolCallEvent, ctx: ExtensionContext) => unknown) => handlers.set(name, fn) } as unknown as ExtensionAPI, handlers, events };
}

test('child Shell hooks consult optional root approval at call time and propagate source and wait boundaries', async () => {
  const root = surface();
  const child = surface();
  const ctx = { cwd: '/tmp/synthetic-project' } as ExtensionContext;
  installInheritedShellChecks(child.api, root.api, 'synthetic-child');
  const run = child.handlers.get('tool_call')!;
  const call: ToolCallEvent = { type: 'tool_call', toolCallId: 'synthetic', toolName: 'bash', input: { command: 'echo hello' } };
  assert.equal(await run(call, ctx), undefined, 'no optional root extension means no additional gate');
  const waits: unknown[] = [];
  child.events.on(SHELL_APPROVAL_WAIT, pending => waits.push(pending));
  publishShellCheck(root.api, async (tool, command, context, source, waiting) => {
    assert.equal(tool, 'bash');
    assert.equal(command, 'echo hello');
    assert.equal(context, ctx);
    assert.equal(source, 'synthetic-child');
    waiting?.(true);
    waiting?.(false);
    return 'synthetic denial';
  });
  assert.deepEqual(await run(call, ctx), { block: true, reason: 'synthetic denial' });
  assert.deepEqual(waits, [true, false]);
  assert.equal(await run({ ...call, toolName: 'read', input: { path: 'synthetic.txt' } }, ctx), undefined);
});
