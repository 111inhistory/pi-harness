import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import presetExtension from '../../extensions/preset.ts';

interface Captured {
  commands: Record<string, (args: string, ctx: unknown) => Promise<void>>;
  handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
  complete?: Parameters<ExtensionAPI['registerCommand']>[1]['getArgumentCompletions'];
}

interface Harness {
  caps: Captured;
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
  setActive: (names: string[]) => void;
  /** Toggle a loadout-effect failure for the next apply/clear. */
  setSyncFails: (value: boolean) => void;
}

interface SetupOptions {
  presets?: Record<string, unknown>;
  activeTools?: string[];
  flags?: Record<string, string>;
  modelIds?: string[];
  modelSelectFails?: boolean;
  /** The capability-tool-base record cannot be written (read-only branch). */
  appendBaseFails?: boolean;
  /** setActiveTools throws on the next sync. */
  syncFails?: boolean;
}

function setup(options: SetupOptions = {}): Harness {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'preset-agent-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'preset-cwd-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  if (options.presets) writeFileSync(path.join(agentDir, 'presets.toml'), stringify(options.presets));

  const caps: Captured = { commands: {}, handlers: {} };
  const branch: unknown[] = [];
  let activeTools = [...(options.activeTools ?? ['read', 'bash', 'edit'])];
  const allToolNames = ['read', 'bash', 'edit', 'write', 'codemode'];
  const modelIds = new Set(options.modelIds ?? []);

  const calls: Harness['calls'] = { setActiveTools: [], setModel: [], setThinking: [], appended: [], notices: [], status: [] };
  let syncFails = options.syncFails ?? false;

  const pi = {
    registerFlag: () => {},
    registerCommand: (name: string, definition: Parameters<ExtensionAPI['registerCommand']>[1]) => {
      caps.commands[name] = async (args, ctx) => { await definition.handler(args, ctx as never); };
      if (name === 'preset' && definition.getArgumentCompletions) caps.complete = definition.getArgumentCompletions;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (caps.handlers[event] ??= []).push(handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      if (syncFails) throw new Error('sdk setActiveTools failed');
      calls.setActiveTools.push(names);
      activeTools = [...names];
    },
    getAllTools: () => allToolNames.map((name) => ({ name, parameters: {} })),
    setModel: (model: { provider: string; id: string }) => { calls.setModel.push(`${model.provider}/${model.id}`); return Promise.resolve(!options.modelSelectFails); },
    setThinkingLevel: (level: string) => { calls.setThinking.push(level); },
    getFlag: (name: string) => options.flags?.[name],
    appendEntry: (customType: string, data: unknown) => {
      if (options.appendBaseFails === true && customType === 'capability-tool-base') throw new Error('read-only branch');
      calls.appended.push({ customType, data });
      branch.push({ type: 'custom', customType, data, id: `e${branch.length}` });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    mode: 'print',
    ui: {
      notify: (message: string, level: string) => { calls.notices.push({ message, level }); },
      setStatus: (_key: string, value: string | undefined) => { calls.status.push(value); },
      select: async () => undefined,
      addAutocompleteProvider: () => {},
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
  return {
    caps, calls, ctx, fire,
    setActive: (names: string[]) => { activeTools = [...names]; },
    setSyncFails: (value: boolean) => { syncFails = value; },
  };
}

/** First start, then apply the named preset through the public command. */
async function applyOnStart(h: Harness, name: string): Promise<void> {
  await h.fire('session_start', {});
  await h.caps.commands['preset']!(name, h.ctx);
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

test('/preset NAME rejects an unknown name', async () => {
  const h = setup();
  await h.caps.commands['preset']!('ghost', h.ctx);
  assert.ok(h.calls.notices.some((notice) => notice.level === 'error' && notice.message.includes('ghost')));
});

test('an unauthenticated preset model applies nothing and reports an error', async () => {
  const h = setup({
    presets: { remote: { model: { provider: 'p', id: 'm' }, tools: ['+write'] } },
    modelIds: ['p/m'],
    modelSelectFails: true,
  });
  await applyOnStart(h, 'remote');
  assert.equal(h.calls.setActiveTools.length, 0);
  assert.ok(h.calls.notices.some((notice) =>
    notice.level === 'error' &&
    notice.message === 'Preset "remote": model p/m is not authenticated; nothing applied.'));
  assert.equal(h.calls.appended.filter((entry) => entry.customType === 'preset-state').length, 0);
});

test('a preset tool set is recomputed from the stable session baseline across resume/reload', async () => {
  // The session baseline is the true initial active set, not the live set a
  // previous preset left behind.
  const h = setup({
    presets: { a: { tools: ['-bash'] }, b: { tools: ['+write'] } },
    activeTools: ['read', 'bash', 'edit'],
  });
  await applyOnStart(h, 'a');
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'edit'], 'A bans bash from the stable baseline');

  // Simulate resume/reload: Pi restores A's active set before session_start runs.
  h.setActive(['read', 'edit']);
  await applyOnStart(h, 'b');
  const last = h.calls.setActiveTools.at(-1)!;
  assert.ok(last.includes('bash'), 'B computes from the stable baseline, so bash returns');
  assert.deepEqual([...last].sort(), ['bash', 'edit', 'read', 'write']);
});

test('/preset clear succeeds despite unreadable catalog source after apply persists snapshot', async () => {
  const h = setup({
    presets: {
      pro: {
        model: { provider: 'p', id: 'm' },
        thinkingLevel: 'low',
        tools: ['+write'],
        codemode: { mode: 'only' },
        instructions: 'Follow concise guidelines.',
      },
    },
    modelIds: ['p/m'],
  });

  // 1. Start and apply preset, then prove live application and persistence.
  await applyOnStart(h, 'pro');
  assert.deepEqual(h.calls.setModel, ['p/m']);
  assert.deepEqual(h.calls.setThinking, ['low']);
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'bash', 'edit', 'write']);
  assert.equal(h.calls.status.at(-1), 'preset:pro');

  const snapshotBefore = h.calls.appended
    .filter((entry) => entry.customType === 'preset-state')
    .map((entry) => (entry.data as { snapshot: { name?: string; instructions?: string; codemode?: unknown } | null }).snapshot)
    .at(-1);
  assert.equal(snapshotBefore?.name, 'pro');
  assert.equal(snapshotBefore?.instructions, 'Follow concise guidelines.');
  assert.deepEqual(snapshotBefore?.codemode, { mode: 'only' });

  assert.ok(!h.calls.appended.some(entry => entry.customType === 'codemode-mode'));

  const beforeOptions = { appendSystemPrompt: 'BASE_APPEND', sections: {} as Record<string, string> };
  await h.fire('before_agent_start', { systemPromptOptions: beforeOptions });
  assert.equal(beforeOptions.appendSystemPrompt, 'BASE_APPEND\n\nFollow concise guidelines.');
  assert.equal(beforeOptions.sections['preset-instructions'], undefined);

  // 2. Obstruct the private catalog on disk with an unreadable directory (EISDIR).
  const catalogPath = path.join(process.env['PI_CODING_AGENT_DIR']!, 'presets.toml');
  rmSync(catalogPath);
  mkdirSync(catalogPath);
  assert.throws(() => readFileSync(catalogPath, 'utf8'), { code: 'EISDIR' });

  // 3. Clear withdraws the preset's contributions even without the catalog.
  await h.caps.commands['preset']!('clear', h.ctx);

  const snapshotAfter = h.calls.appended
    .filter((entry) => entry.customType === 'preset-state')
    .map((entry) => (entry.data as { snapshot: unknown }).snapshot)
    .at(-1);
  assert.equal(snapshotAfter, null, 'clear writes a null snapshot');

  assert.ok(!h.calls.appended.some(entry => entry.customType === 'codemode-mode'));

  const afterOptions = { appendSystemPrompt: 'BASE_APPEND', sections: {} as Record<string, string> };
  await h.fire('before_agent_start', { systemPromptOptions: afterOptions });
  assert.equal(afterOptions.appendSystemPrompt, 'BASE_APPEND', 'cleared current state preserves only the base addendum');

  assert.equal(h.calls.status.at(-1), undefined, 'status is cleared');
  assert.deepEqual(h.calls.setModel, ['p/m'], 'model is not rolled back');
  assert.deepEqual(h.calls.setThinking, ['low'], 'thinking is not rolled back');
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'bash', 'edit'], 'tools follow the unmodified baseline');

  await h.caps.commands['preset']!('other', h.ctx);
  assert.ok(h.calls.notices.some(notice => notice.level === 'error' && notice.message.includes('other')));
});

test('a preset without a tool selection applies when the baseline cannot be recorded', async () => {
  const h = setup({
    presets: { solo: { model: { provider: 'p', id: 'm' }, instructions: 'S' } },
    modelIds: ['p/m'],
    appendBaseFails: true,
  });
  await h.fire('session_start', {});
  assert.ok(h.calls.notices.some((notice) =>
    notice.level === 'error' && notice.message.includes('tool baseline could not be recorded')));

  await h.caps.commands['preset']!('solo', h.ctx);
  assert.deepEqual(h.calls.setModel, ['p/m'], 'no tool selection does not require a recorded baseline');
  assert.ok(h.calls.appended.some((entry) => entry.customType === 'preset-state'));
  assert.equal(h.calls.status.at(-1), 'preset:solo');
  assert.ok(!h.calls.notices.some((notice) =>
    notice.level === 'error' && notice.message.includes('could not be applied')));
});

test('a tool preset fails closed when the baseline cannot be recorded', async () => {
  const h = setup({
    presets: { needs: { tools: ['+write'] } },
    appendBaseFails: true,
  });
  await h.fire('session_start', {});
  await h.caps.commands['preset']!('needs', h.ctx);
  assert.ok(h.calls.notices.some((notice) =>
    notice.level === 'error'
    && notice.message.includes('could not be applied')
    && notice.message.includes('read-only branch')));
  assert.ok(!h.calls.appended.some((entry) => entry.customType === 'preset-state'));
  assert.equal(h.calls.setActiveTools.length, 0, 'nothing was activated without the records');
});

test('a loadout sync failure after apply is reported without claiming success', async () => {
  const h = setup({ presets: { only: { tools: ['+write'] } } });
  await h.fire('session_start', {});
  h.setSyncFails(true);

  await h.caps.commands['preset']!('only', h.ctx);
  assert.ok(h.calls.appended.some((entry) => entry.customType === 'preset-state'),
    'the snapshot stays durable even when the effect fails');
  assert.ok(h.calls.notices.some((notice) =>
    notice.level === 'warning' && notice.message.includes('could not be synchronized')));
  assert.ok(!h.calls.notices.some((notice) => notice.message === 'Preset "only" applied.'));
  assert.equal(h.calls.status.at(-1), 'preset:only', 'the durable snapshot still owns the status');
});

test('clear reports a loadout sync failure instead of claiming the loadout was updated', async () => {
  const h = setup({ presets: { only: { tools: ['+write'] } } });
  await applyOnStart(h, 'only');
  h.setSyncFails(true);

  await h.caps.commands['preset']!('clear', h.ctx);
  assert.ok(h.calls.notices.some((notice) =>
    notice.level === 'warning' && notice.message.includes('could not be synchronized')));
  assert.ok(!h.calls.notices.some((notice) =>
    notice.message === 'Preset cleared; tools now follow the branch baseline and manual choices. Model and thinking are unchanged.'));
  assert.equal(h.calls.status.at(-1), undefined, 'the cleared snapshot still releases the status');
  const lastState = h.calls.appended.filter((entry) => entry.customType === 'preset-state').at(-1);
  assert.deepEqual((lastState?.data as { snapshot: unknown }).snapshot, null);
});

test('version prompts are TUI-only and skipping applies to the candidate seen on the branch', async () => {
  const h = setup({ presets: { writer: { instructions: 'v1' } } });
  await applyOnStart(h, 'writer');
  const file = path.join(process.env['PI_CODING_AGENT_DIR']!, 'presets.toml');
  writeFileSync(file, stringify({ writer: { instructions: 'v2' } }));
  let prompts = 0;
  let useUpdate = false;
  (h.ctx.ui as { select: unknown }).select = async (_title: string, choices: string[]) => {
    prompts += 1;
    return choices[useUpdate ? 0 : 1];
  };
  Object.assign(h.ctx, { hasUI: true, mode: 'rpc' });
  await h.fire('session_start', { reason: 'startup' });
  assert.equal(prompts, 0);
  const before = h.calls.appended.length;
  Object.assign(h.ctx, { mode: 'tui' });
  await h.fire('session_start', { reason: 'startup' });
  assert.equal(prompts, 1);
  assert.deepEqual(h.calls.appended.slice(before).map(entry => entry.customType), ['preset-version-skipped']);
  await h.fire('session_start', { reason: 'resume' });
  assert.equal(prompts, 1);
  writeFileSync(file, stringify({ writer: { instructions: 'v3' } }));
  useUpdate = true;
  await h.fire('session_start', { reason: 'resume' });
  assert.equal(prompts, 2);
  assert.equal(h.calls.status.at(-1), 'preset:writer');
  const latest = h.calls.appended.at(-1)?.data as { snapshot?: { instructions?: string } };
  assert.equal(latest.snapshot?.instructions, 'v3');
  assert.deepEqual((await h.caps.complete?.('w'))?.map(item => item.value), ['writer']);
});

test('tree marks invalid and missing Presets and the picker can clear an empty catalog', async () => {
  const h = setup({ presets: { writer: { instructions: 'v1' } } });
  await applyOnStart(h, 'writer');
  const file = path.join(process.env['PI_CODING_AGENT_DIR']!, 'presets.toml');
  writeFileSync(file, stringify({ writer: { instructions: false } }));
  await h.fire('session_tree', {});
  assert.equal(h.calls.status.at(-1), 'preset:writer (invalid)');
  writeFileSync(file, '');
  await h.fire('session_tree', {});
  assert.equal(h.calls.status.at(-1), 'preset:writer (missing)');
  (h.ctx.ui as { select: unknown }).select = async (_title: string, choices: string[]) => {
    assert.deepEqual(choices, ['(none)']);
    return choices[0];
  };
  await h.caps.commands['preset']!('show', h.ctx);
  assert.equal(h.calls.status.at(-1), undefined);
});
