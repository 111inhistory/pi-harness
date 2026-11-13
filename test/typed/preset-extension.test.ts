import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
}

interface SetupOptions {
  presets?: Record<string, unknown>;
  activeTools?: string[];
  flags?: Record<string, string>;
  modelIds?: string[];
  modelSelectFails?: boolean;
  defaultTools?: string[];
}

function setup(options: SetupOptions = {}): Harness {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'preset-agent-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'preset-cwd-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  if (options.presets) writeFileSync(path.join(agentDir, 'presets.json'), JSON.stringify(options.presets));

  const caps: Captured = { commands: {}, handlers: {} };
  const branch: unknown[] = [];
  let activeTools = [...(options.activeTools ?? ['read', 'bash', 'edit'])];
  const allToolNames = ['read', 'bash', 'edit', 'write', 'codemode'];
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
    setModel: (model: { provider: string; id: string }) => { calls.setModel.push(`${model.provider}/${model.id}`); return Promise.resolve(!options.modelSelectFails); },
    setThinkingLevel: (level: string) => { calls.setThinking.push(level); },
    getFlag: (name: string) => options.flags?.[name],
    appendEntry: (customType: string, data: unknown) => {
      calls.appended.push({ customType, data });
      branch.push({ type: 'custom', customType, data, id: `e${branch.length}` });
    },
  } as unknown as ExtensionAPI;
  if (options.defaultTools !== undefined) {
    (pi as unknown as { getSettings: () => unknown }).getSettings = () => ({ defaultTools: options.defaultTools });
  }

  const ctx = {
    cwd,
    ui: {
      notify: (message: string, level: string) => { calls.notices.push({ message, level }); },
      setStatus: (_key: string, value: string | undefined) => { calls.status.push(value); },
      select: async () => undefined,
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
  return { caps, calls, ctx, fire, setActive: (names: string[]) => { activeTools = [...names]; } };
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

test('a preset tool set is recomputed from a stable settings base across resume/reload', async () => {
  // base = settings defaultTools (read/bash/edit), not the live active set.
  const h = setup({
    presets: { a: { tools: ['-bash'] }, b: { tools: ['+write'] } },
    activeTools: ['read', 'bash', 'edit'],
    defaultTools: ['read', 'bash', 'edit'],
  });
  await applyOnStart(h, 'a');
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'edit'], 'A removes bash from the stable base');

  // Simulate resume/reload: Pi restores A's active set before session_start runs.
  h.setActive(['read', 'edit']);
  await applyOnStart(h, 'b');
  const last = h.calls.setActiveTools.at(-1)!;
  assert.ok(last.includes('bash'), 'B must compute from the stable base, so bash returns');
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

  const modeBefore = h.calls.appended
    .filter((entry) => entry.customType === 'codemode-mode')
    .map((entry) => (entry.data as { mode?: unknown }).mode)
    .at(-1);
  assert.equal(modeBefore, 'only');

  const beforeSections: Record<string, string> = {};
  await h.fire('before_agent_start', { systemPromptOptions: { sections: beforeSections } });
  assert.equal(beforeSections['preset-instructions'], 'Follow concise guidelines.');

  // 2. Obstruct the private catalog on disk with an unreadable directory (EISDIR).
  const catalogPath = path.join(process.env['PI_CODING_AGENT_DIR']!, 'presets.json');
  rmSync(catalogPath);
  mkdirSync(catalogPath);
  assert.throws(() => readFileSync(catalogPath, 'utf8'), { code: 'EISDIR' });

  // 3. Clear must succeed despite the unreadable catalog: snapshot, instructions,
  //    and codemode are withdrawn while model/thinking/tools remain unchanged.
  await h.caps.commands['preset']!('clear', h.ctx);

  const snapshotAfter = h.calls.appended
    .filter((entry) => entry.customType === 'preset-state')
    .map((entry) => (entry.data as { snapshot: unknown }).snapshot)
    .at(-1);
  assert.equal(snapshotAfter, null, 'clear writes a null snapshot');

  const modeAfter = h.calls.appended
    .filter((entry) => entry.customType === 'codemode-mode')
    .map((entry) => (entry.data as { mode?: unknown }).mode)
    .at(-1);
  assert.equal(modeAfter, null, 'clear withdraws the codemode mode override');

  const afterSections: Record<string, string> = { 'preset-instructions': 'Follow concise guidelines.' };
  await h.fire('before_agent_start', { systemPromptOptions: { sections: afterSections } });
  assert.equal(afterSections['preset-instructions'], undefined, 'cleared current state removes the instruction section');

  assert.equal(h.calls.status.at(-1), undefined, 'status is cleared');
  assert.deepEqual(h.calls.setModel, ['p/m'], 'model is not rolled back');
  assert.deepEqual(h.calls.setThinking, ['low'], 'thinking is not rolled back');
  assert.deepEqual(h.calls.setActiveTools.at(-1), ['read', 'bash', 'edit', 'write'], 'tools are not rolled back');

  // Any command that genuinely requires catalog access fails because of the obstruction.
  await assert.rejects(
    async () => h.caps.commands['preset']!('other', h.ctx),
    { code: 'EISDIR' },
  );
});
