import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import presetExtension from '../../extensions/preset.ts';

interface Captured {
  commands: Record<string, (args: string, ctx: unknown) => Promise<void>>;
  handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
}

interface Harness {
  caps: Captured;
  branch: unknown[];
  calls: {
    setActiveTools: (readonly string[])[];
    setModel: string[];
    setThinking: string[];
    appended: { customType: string; data: unknown }[];
    notices: { message: string; level: string }[];
    status: (string | undefined)[];
  };
  ctx: Record<string, unknown>;
  fire: (event: string, payload: unknown) => Promise<unknown>;
}

interface SetupOptions {
  presets?: Record<string, unknown>;
  activeTools?: string[];
  allTools?: string[];
  flags?: Record<string, string>;
  modelIds?: string[];
  modelOk?: boolean;
  selectChoice?: string;
}

function setup(options: SetupOptions = {}): Harness {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'preset-agent-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'preset-cwd-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  if (options.presets) writeFileSync(path.join(agentDir, 'presets.json'), JSON.stringify(options.presets));

  const caps: Captured = { commands: {}, handlers: {} };
  const branch: unknown[] = [];
  let activeTools = [...(options.activeTools ?? ['read', 'bash', 'edit'])];
  const allToolNames = options.allTools ?? ['read', 'bash', 'edit', 'write', 'codemode'];
  const modelIds = new Set(options.modelIds ?? []);

  const calls: Harness['calls'] = { setActiveTools: [], setModel: [], setThinking: [], appended: [], notices: [], status: [] };

  const pi = {
    registerFlag: () => {},
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      caps.commands[name] = definition.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (caps.handlers[event] ??= []).push(handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { calls.setActiveTools.push(names); activeTools = [...names]; },
    getAllTools: () => allToolNames.map((name) => ({ name, parameters: {} })),
    setModel: (model: { provider: string; id: string }) => { calls.setModel.push(`${model.provider}/${model.id}`); return Promise.resolve(options.modelOk ?? true); },
    setThinkingLevel: (level: string) => { calls.setThinking.push(level); },
    getFlag: (name: string) => options.flags?.[name],
    appendEntry: (customType: string, data: unknown) => {
      calls.appended.push({ customType, data });
      branch.push({ type: 'custom', customType, data, id: `e${branch.length}` });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    ui: {
      notify: (message: string, level: string) => { calls.notices.push({ message, level }); },
      setStatus: (_key: string, value: string | undefined) => { calls.status.push(value); },
      select: async () => options.selectChoice,
    },
    modelRegistry: {
      find: (provider: string, id: string) => (modelIds.has(`${provider}/${id}`) ? { provider, id } : undefined),
    },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => false,
  } as unknown as Record<string, unknown>;

  presetExtension(pi);
  const fire = async (event: string, payload: unknown): Promise<unknown> => {
    let result: unknown;
    for (const handler of caps.handlers[event] ?? []) result = await handler(payload, ctx);
    return result;
  };
  return { caps, branch, calls, ctx, fire };
}

test('--preset applies model/thinking/tools on session_start and sets status', async () => {
  const h = setup({
    presets: { fast: { model: { provider: 'p', id: 'm' }, thinkingLevel: 'low', tools: ['+write'] } },
    flags: { preset: 'fast' },
    modelIds: ['p/m'],
  });
  await h.fire('session_start', {});
  assert.deepEqual(h.calls.setModel, ['p/m']);
  assert.deepEqual(h.calls.setThinking, ['low']);
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'bash', 'edit', 'write']);
  assert.ok(h.calls.status.includes('preset:fast'));
  assert.ok(h.calls.appended.some((entry) => entry.customType === 'preset-state'));
});

test('/preset NAME applies; unknown name notifies an error', async () => {
  const h = setup({ presets: { fast: { thinkingLevel: 'high' } } });
  await h.fire('session_start', {});
  await h.caps.commands['preset']!('fast', h.ctx);
  assert.deepEqual(h.calls.setThinking, ['high']);
  await h.caps.commands['preset']!('ghost', h.ctx);
  assert.ok(h.calls.notices.some((notice) => notice.level === 'error' && notice.message.includes('ghost')));
});

test('an unauthenticated preset model applies nothing and reports an error', async () => {
  const h = setup({ presets: { remote: { model: { provider: 'p', id: 'm' }, tools: ['+write'] } }, modelIds: [] });
  await h.fire('session_start', {});
  await h.caps.commands['preset']!('remote', h.ctx);
  assert.equal(h.calls.setActiveTools.length, 0);
  assert.ok(h.calls.notices.some((notice) => notice.level === 'error'));
  assert.equal(h.calls.appended.filter((entry) => entry.customType === 'preset-state').length, 0);
});

test('/preset clear records a null snapshot', async () => {
  const h = setup({ presets: { fast: { thinkingLevel: 'high' } } });
  await h.fire('session_start', {});
  await h.caps.commands['preset']!('fast', h.ctx);
  await h.caps.commands['preset']!('clear', h.ctx);
  const states = h.calls.appended.filter((entry) => entry.customType === 'preset-state').map((entry) => entry.data as { snapshot: unknown });
  assert.equal(states.at(-1)?.snapshot, null);
});

test('context_with_system projects the instruction section after apply', async () => {
  const h = setup({ presets: { fast: { instructions: 'Be terse.' } } });
  await h.fire('session_start', {});
  await h.caps.commands['preset']!('fast', h.ctx);
  const result = (await h.fire('context_with_system', { messages: [{ role: 'user', content: 'hi' }] })) as {
    messages: { role?: string; sections?: Record<string, string | null> }[];
  };
  const texts = result.messages.map((message) => message.sections?.['preset-instructions']).filter((value) => value !== undefined);
  assert.ok(texts.includes('Be terse.'));
});
