import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_HARNESS_CONFIG,
  HarnessConfigError,
  harnessConfigFor,
  loadHarnessConfig,
  resolveHarnessConfig,
  type HarnessConfigLayer,
} from '../../src/harness-config.ts';
import { promptString } from '../../src/prompt-text.ts';

interface TempRoots {
  readonly agentDir: string;
  readonly cwd: string;
}

async function tempRoots(t: TestContext): Promise<TempRoots> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-harness-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(cwd, '.pi'), { recursive: true });
  return { agentDir, cwd };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), 'utf8');
}

/** `getAgentDir()` reads this key, so provider tests can point it at a temp root. */
function useAgentDir(t: TestContext, agentDir: string): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

interface FakePi {
  readonly api: ExtensionAPI;
  emit(event: 'session_start' | 'session_tree' | 'session_shutdown'): void;
}

function fakePi(): FakePi {
  const handlers = new Map<string, (() => void)[]>();
  const api = {
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    emit(event) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

const context = (cwd: string, trusted: boolean): ExtensionContext =>
  ({ cwd, isProjectTrusted: () => trusted }) as unknown as ExtensionContext;

function budget(soft: number, hard: number, lifetimeMs = 60_000) {
  return { modelCalls: { soft, hard }, activeTimeMs: { soft, hard }, lifetimeMs };
}

function resolveError(layers: readonly HarnessConfigLayer[]): HarnessConfigError {
  try {
    resolveHarnessConfig(layers);
  } catch (error) {
    assert.ok(error instanceof HarnessConfigError);
    return error;
  }
  assert.fail('expected a HarnessConfigError');
}

function expectError(error: HarnessConfigError, source: string, field: string): void {
  assert.equal(error.source, source);
  assert.equal(error.field, field);
  assert.ok(error.message.startsWith(`${source}: ${field || 'config'} `), error.message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('absent config files resolve to the built-in defaults', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  const config = loadHarnessConfig({ cwd, agentDir, projectTrusted: true });
  assert.deepEqual(config, DEFAULT_HARNESS_CONFIG);
  assert.equal(config.subagent.maxDepth, 2);
  assert.equal(config.subagent.maxActiveChildren, 4);
  assert.deepEqual(config.subagent.budgetsByDepth[1]?.modelCalls, { soft: 160, hard: 200 });
  assert.deepEqual(config.subagent.budgetsByDepth[2]?.modelCalls, { soft: 48, hard: 64 });
  assert.deepEqual(config.capability.search.bm25, { k: 0.9, b: 0.9, d: 0 });
  assert.deepEqual(config.capability.search.limits, {
    tools: 8, mcp: 8, skills: 6, skillBodies: 6, requestTokens: 128, descriptionChars: 240, skillBodyChars: 60_000,
  });
  assert.equal(config.capability.noSelectionLimit, 3);
  assert.equal(config.codemode.memoryLimitBytes, 256 * 1024 * 1024);
  assert.equal(config.codemode.defaultMaxOutputTokens, 10_000);
  assert.equal(config.subagent.prompts.common, '');
  assert.equal(config.subagent.prompts.inherited, promptString('subagent-turns.json', 'inheritedContext'));
  assert.deepEqual(resolveHarnessConfig(), DEFAULT_HARNESS_CONFIG);
});

test('global overrides merge field by field and retain untouched defaults', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  await writeJson(path.join(agentDir, 'harness.json'), {
    subagent: {
      maxDepth: 3,
      maxActiveChildren: 2,
      budgetsByDepth: { 3: budget(10, 20) },
      inheritedToolWaitMs: 5_000,
      routingRetry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200, jitterRatio: 0.5 },
    },
    capability: { budget: budget(4, 8), search: { bm25: { k: 1.2, b: 0.5, d: 0.1 } } },
    codemode: { defaultMaxOutputTokens: 512 },
  });
  const config = loadHarnessConfig({ cwd, agentDir, projectTrusted: false });
  assert.equal(config.subagent.maxDepth, 3);
  assert.equal(config.subagent.maxActiveChildren, 2);
  assert.deepEqual(config.subagent.budgetsByDepth[3], budget(10, 20));
  assert.deepEqual(config.subagent.budgetsByDepth[1], DEFAULT_HARNESS_CONFIG.subagent.budgetsByDepth[1]);
  assert.equal(config.subagent.inheritedToolWaitMs, 5_000);
  assert.deepEqual(config.subagent.routingRetry, { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200, jitterRatio: 0.5 });
  assert.deepEqual(config.capability.budget, budget(4, 8));
  assert.deepEqual(config.capability.search.bm25, { k: 1.2, b: 0.5, d: 0.1 });
  assert.deepEqual(config.capability.search.limits, DEFAULT_HARNESS_CONFIG.capability.search.limits);
  assert.equal(config.codemode.defaultMaxOutputTokens, 512);
  assert.equal(config.codemode.memoryLimitBytes, DEFAULT_HARNESS_CONFIG.codemode.memoryLimitBytes);
});

test('a trusted project composes with the global layer and wins per field', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  await writeJson(path.join(agentDir, 'harness.json'), {
    subagent: { maxDepth: 3, maxActiveChildren: 3, prompts: { common: { replace: 'global common' } } },
    capability: { budget: { modelCalls: { soft: 300 } } },
  });
  await writeJson(path.join(cwd, '.pi', 'harness.json'), {
    subagent: { maxActiveChildren: 2, budgetsByDepth: { 3: budget(10, 20) } },
    capability: { budget: { modelCalls: { hard: 400 } } },
  });
  const config = loadHarnessConfig({ cwd, agentDir, projectTrusted: true });
  assert.equal(config.subagent.maxDepth, 3);
  assert.equal(config.subagent.maxActiveChildren, 2);
  assert.deepEqual(config.subagent.budgetsByDepth[3], budget(10, 20));
  assert.deepEqual(config.capability.budget.modelCalls, { soft: 300, hard: 400 });
  assert.equal(config.subagent.prompts.common, 'global common');
});

test('an untrusted project file is ignored even when it is invalid', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  await writeJson(path.join(cwd, '.pi', 'harness.json'), { subagent: { maxActiveChildren: 1, surprise: true } });
  const ignored = loadHarnessConfig({ cwd, agentDir, projectTrusted: false });
  assert.equal(ignored.subagent.maxActiveChildren, DEFAULT_HARNESS_CONFIG.subagent.maxActiveChildren);
  assert.throws(
    () => loadHarnessConfig({ cwd, agentDir, projectTrusted: true }),
    (error: unknown) => error instanceof HarnessConfigError
      && error.source === path.join(cwd, '.pi', 'harness.json')
      && error.field === 'subagent.surprise',
  );
});

test('unknown fields, wrong types and unreadable top-level values name source and field', () => {
  const unknown = resolveError([{ source: 'global', value: { capability: { search: { unknown: 1 } } } }]);
  expectError(unknown, 'global', 'capability.search.unknown');
  assert.match(unknown.message, /is unknown\./);

  const type = resolveError([{ source: 'project', value: { subagent: { maxDepth: '2' } } }]);
  expectError(type, 'project', 'subagent.maxDepth');
  assert.match(type.message, /must be a finite number\./);

  const nested = resolveError([{ source: 'global', value: { subagent: { budget: {} } } }]);
  expectError(nested, 'global', 'subagent.budget');
  assert.match(nested.message, /is unknown\./);

  const promptKey = resolveError([{ source: 'global', value: { subagent: { prompts: { common: { pre: 'x' } } } } }]);
  expectError(promptKey, 'global', 'subagent.prompts.common.pre');

  const promptType = resolveError([{ source: 'global', value: { subagent: { prompts: { inherited: 'text' } } } }]);
  expectError(promptType, 'global', 'subagent.prompts.inherited');

  const root = resolveError([{ source: 'global', value: ['subagent'] }]);
  expectError(root, 'global', '');
  assert.match(root.message, /config must be an object\./);
});

test('prototype-shaped keys from external JSON are rejected instead of merged', () => {
  const nested: unknown = JSON.parse('{"subagent":{"__proto__":{"polluted":true}}}');
  expectError(resolveError([{ source: 'global', value: nested }]), 'global', 'subagent.__proto__');
  const root: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
  expectError(resolveError([{ source: 'global', value: root }]), 'global', '__proto__');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('invalid JSON is reported with the file that contains it', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  const file = path.join(agentDir, 'harness.json');
  await writeFile(file, '{ "subagent": ', 'utf8');
  assert.throws(
    () => loadHarnessConfig({ cwd, agentDir, projectTrusted: false }),
    (error: unknown) => error instanceof HarnessConfigError && error.source === file && error.field === ''
      && /must contain valid JSON\./.test(error.message),
  );
});

test('BM25 and retry bounds accept their documented ranges and reject the rest', () => {
  const bm25 = (value: Record<string, number>) => ({ source: 'global', value: { capability: { search: { bm25: value } } } });
  assert.deepEqual(resolveHarnessConfig([bm25({ k: 0, b: 0, d: 0 })]).capability.search.bm25, { k: 0, b: 0, d: 0 });
  assert.deepEqual(resolveHarnessConfig([bm25({ k: 2, b: 1, d: 5 })]).capability.search.bm25, { k: 2, b: 1, d: 5 });
  expectError(resolveError([bm25({ k: -0.1 })]), 'global', 'capability.search.bm25.k');
  expectError(resolveError([bm25({ d: -1 })]), 'global', 'capability.search.bm25.d');
  expectError(resolveError([bm25({ b: -0.1 })]), 'global', 'capability.search.bm25.b');
  expectError(resolveError([bm25({ b: 1.1 })]), 'global', 'capability.search.bm25.b');
  expectError(resolveError([bm25({ k: Number.NaN })]), 'global', 'capability.search.bm25.k');

  const retry = (value: Record<string, number>) => ({ source: 'global', value: { subagent: { routingRetry: value } } });
  assert.equal(resolveHarnessConfig([retry({ jitterRatio: 0 })]).subagent.routingRetry.jitterRatio, 0);
  assert.equal(resolveHarnessConfig([retry({ jitterRatio: 1 })]).subagent.routingRetry.jitterRatio, 1);
  expectError(resolveError([retry({ jitterRatio: -0.01 })]), 'global', 'subagent.routingRetry.jitterRatio');
  expectError(resolveError([retry({ jitterRatio: 1.01 })]), 'global', 'subagent.routingRetry.jitterRatio');
  expectError(resolveError([retry({ maxAttempts: 0 })]), 'global', 'subagent.routingRetry.maxAttempts');
  expectError(resolveError([retry({ maxAttempts: 2.5 })]), 'global', 'subagent.routingRetry.maxAttempts');
  expectError(resolveError([retry({ maxDelayMs: 100, baseDelayMs: 200 })]), 'global', 'subagent.routingRetry.maxDelayMs');
});

test('positive integer limits reject zero, fractions and non-finite values', () => {
  for (const [field, value] of [
    ['maxActiveChildren', 0],
    ['maxDepth', 0],
    ['maxDepth', 2.5],
    ['inheritedToolWaitMs', -1],
  ] as const) {
    expectError(resolveError([{ source: 'global', value: { subagent: { [field]: value } } }]), 'global', `subagent.${field}`);
  }
  expectError(
    resolveError([{ source: 'global', value: { capability: { search: { limits: { tools: 0 } } } } }]),
    'global', 'capability.search.limits.tools',
  );
  expectError(
    resolveError([{ source: 'global', value: { capability: { search: { limits: { skillBodyChars: 1.5 } } } } }]),
    'global', 'capability.search.limits.skillBodyChars',
  );
  expectError(
    resolveError([{ source: 'global', value: { codemode: { memoryLimitBytes: Number.POSITIVE_INFINITY } } }]),
    'global', 'codemode.memoryLimitBytes',
  );
});

test('budget relations allow soft == hard and reject soft > hard at the layer that made it invalid', () => {
  const equal = resolveHarnessConfig([
    { source: 'global', value: { capability: { budget: budget(20, 20) } } },
    { source: 'project', value: { subagent: { budgetsByDepth: { 2: { modelCalls: { soft: 64 } } } } } },
  ]);
  assert.deepEqual(equal.capability.budget.modelCalls, { soft: 20, hard: 20 });
  assert.deepEqual(equal.subagent.budgetsByDepth[2]?.modelCalls, { soft: 64, hard: 64 });

  const globalOnly = resolveError([{ source: 'global', value: { capability: { budget: budget(300, 200) } } }]);
  expectError(globalOnly, 'global', 'capability.budget.modelCalls.hard');

  const composed = resolveError([
    { source: 'global', value: { capability: { budget: budget(300, 200) } } },
    { source: 'project', value: { capability: { budget: budget(400, 200) } } },
  ]);
  expectError(composed, 'project', 'capability.budget.modelCalls.hard');

  const depth = resolveError([{ source: 'project', value: { subagent: { budgetsByDepth: { 1: { activeTimeMs: { soft: 9_000_000 } } } } } }]);
  expectError(depth, 'project', 'subagent.budgetsByDepth.1.activeTimeMs.hard');
});

test('maxDepth demands a final budget for every reachable depth across layers', () => {
  const missing = resolveError([{ source: 'global', value: { subagent: { maxDepth: 3 } } }]);
  expectError(missing, 'global', 'subagent.budgetsByDepth.3');
  assert.match(missing.message, /is required by subagent\.maxDepth\./);

  const deeper = resolveError([{ source: 'global', value: { subagent: { maxDepth: 4, budgetsByDepth: { 3: budget(10, 20) } } } }]);
  expectError(deeper, 'global', 'subagent.budgetsByDepth.4');

  const composed = resolveHarnessConfig([
    { source: 'global', value: { subagent: { maxDepth: 3 } } },
    { source: 'project', value: { subagent: { budgetsByDepth: { 3: budget(10, 20) } } } },
  ]);
  assert.equal(composed.subagent.maxDepth, 3);

  const lowered = resolveHarnessConfig([{ source: 'global', value: { subagent: { maxDepth: 1 } } }]);
  assert.equal(lowered.subagent.maxDepth, 1);
  assert.deepEqual(lowered.subagent.budgetsByDepth[2], DEFAULT_HARNESS_CONFIG.subagent.budgetsByDepth[2]);
});

test('a new depth needs a complete budget while existing depths accept partial overrides', () => {
  const partialNew = resolveError([{ source: 'global', value: { subagent: { budgetsByDepth: { 3: { modelCalls: { soft: 1, hard: 2 }, activeTimeMs: { soft: 1, hard: 2 } } } } } }]);
  expectError(partialNew, 'global', 'subagent.budgetsByDepth.3.lifetimeMs');
  assert.match(partialNew.message, /is required for a new depth\./);

  const missingBound = resolveError([{ source: 'global', value: { subagent: { budgetsByDepth: { 3: { modelCalls: { soft: 1 }, activeTimeMs: { soft: 1, hard: 2 }, lifetimeMs: 3 } } } } }]);
  expectError(missingBound, 'global', 'subagent.budgetsByDepth.3.modelCalls.hard');

  const badKey = resolveError([{ source: 'global', value: { subagent: { budgetsByDepth: { 0: budget(1, 2) } } } }]);
  expectError(badKey, 'global', 'subagent.budgetsByDepth.0');
  assert.match(badKey.message, /must name a positive integer depth\./);

  const overridden = resolveHarnessConfig([
    { source: 'global', value: { subagent: { budgetsByDepth: { 2: { modelCalls: { soft: 10 }, lifetimeMs: 5_000 } } } } },
  ]);
  assert.deepEqual(overridden.subagent.budgetsByDepth[2], {
    modelCalls: { soft: 10, hard: 64 },
    activeTimeMs: { soft: 2_700_000, hard: 3_600_000 },
    lifetimeMs: 5_000,
  });
  assert.deepEqual(overridden.subagent.budgetsByDepth[1], DEFAULT_HARNESS_CONFIG.subagent.budgetsByDepth[1]);
});

test('resolving layers never mutates the shared defaults', () => {
  const before = JSON.stringify(DEFAULT_HARNESS_CONFIG);
  deepFreeze(DEFAULT_HARNESS_CONFIG);
  const config = resolveHarnessConfig([
    { source: 'global', value: { subagent: { maxDepth: 1, prompts: { common: { replace: 'A' } }, budgetsByDepth: { 1: { modelCalls: { soft: 1 } } } } } },
    { source: 'project', value: { capability: { search: { bm25: { k: 0.5 } } } } },
  ]);
  assert.equal(config.subagent.prompts.common, 'A');
  assert.deepEqual(config.subagent.budgetsByDepth[1]?.modelCalls, { soft: 1, hard: 200 });
  assert.equal(JSON.stringify(DEFAULT_HARNESS_CONFIG), before);
  assert.deepEqual(DEFAULT_HARNESS_CONFIG.capability.search.bm25, { k: 0.9, b: 0.9, d: 0 });
});

test('prompt layers apply default -> global replace+append -> project replace+append', () => {
  const base = DEFAULT_HARNESS_CONFIG.subagent.prompts;
  const layers = resolveHarnessConfig([
    { source: 'global', value: { subagent: { prompts: { common: { replace: 'A', append: 'B' }, inherited: { append: 'G' } } } } },
    { source: 'project', value: { subagent: { prompts: { common: { append: 'C' }, inherited: { append: 'P' } } } } },
  ]);
  assert.equal(layers.subagent.prompts.common, 'A\n\nB\n\nC');
  assert.equal(layers.subagent.prompts.inherited, `${base.inherited}\n\nG\n\nP`);

  const replaced = resolveHarnessConfig([
    { source: 'global', value: { subagent: { prompts: { common: { replace: 'A', append: 'B' } } } } },
    { source: 'project', value: { subagent: { prompts: { common: { replace: 'D' } } } } },
  ]);
  assert.equal(replaced.subagent.prompts.common, 'D');

  const cleared = resolveHarnessConfig([{ source: 'global', value: { subagent: { prompts: { inherited: { replace: '' } } } } }]);
  assert.equal(cleared.subagent.prompts.inherited, '');

  const clearedThenAppended = resolveHarnessConfig([
    { source: 'global', value: { subagent: { prompts: { inherited: { replace: '' } } } } },
    { source: 'project', value: { subagent: { prompts: { inherited: { append: 'only project' } } } } },
  ]);
  assert.equal(clearedThenAppended.subagent.prompts.inherited, 'only project');

  const emptyAppend = resolveHarnessConfig([{ source: 'global', value: { subagent: { prompts: { common: { replace: 'A', append: '' } } } } }]);
  assert.equal(emptyAppend.subagent.prompts.common, 'A');
  assert.equal(emptyAppend.subagent.prompts.inherited, base.inherited);
});

test('prompt text is literal: no variable, command or file expansion', () => {
  const literal = 'Keep $HOME, ${PLACEHOLDER}, $(whoami), @README.md and {{name}} exactly as written.';
  const config = resolveHarnessConfig([{ source: 'global', value: { subagent: { prompts: { common: { append: literal } } } } }]);
  assert.equal(config.subagent.prompts.common, literal);
});

test('one provider caches its snapshot until the session lifecycle invalidates it', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  useAgentDir(t, agentDir);
  const globalFile = path.join(agentDir, 'harness.json');
  await writeJson(globalFile, { subagent: { maxActiveChildren: 1 } });
  const { api, emit } = fakePi();
  const provider = harnessConfigFor(api);
  assert.equal(harnessConfigFor(api), provider);

  const first = provider(context(cwd, true));
  assert.equal(first.subagent.maxActiveChildren, 1);

  await writeJson(globalFile, { subagent: { maxActiveChildren: 3 } });
  assert.equal(provider(context(cwd, true)), first);
  assert.equal(provider(context(cwd, true)).subagent.maxActiveChildren, 1);

  emit('session_start');
  const reloaded = provider(context(cwd, true));
  assert.notEqual(reloaded, first);
  assert.equal(reloaded.subagent.maxActiveChildren, 3);

  await writeJson(globalFile, { subagent: { maxActiveChildren: 2 } });
  emit('session_tree');
  assert.equal(provider(context(cwd, true)).subagent.maxActiveChildren, 2);

  await writeJson(globalFile, { subagent: { maxActiveChildren: 4 } });
  emit('session_shutdown');
  assert.equal(provider(context(cwd, true)).subagent.maxActiveChildren, 4);
});

test('providers use the context trust flag and project file of each session', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  useAgentDir(t, agentDir);
  await writeJson(path.join(agentDir, 'harness.json'), { subagent: { maxActiveChildren: 3 } });
  await writeJson(path.join(cwd, '.pi', 'harness.json'), { subagent: { maxActiveChildren: 2 } });
  const { api, emit } = fakePi();
  const provider = harnessConfigFor(api);

  assert.equal(provider(context(cwd, false)).subagent.maxActiveChildren, 3);
  emit('session_start');
  assert.equal(provider(context(cwd, true)).subagent.maxActiveChildren, 2);
  emit('session_start');
  assert.equal(provider(context(cwd, false)).subagent.maxActiveChildren, 3);
});

test('each SDK surface keeps its own snapshot', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  useAgentDir(t, agentDir);
  const globalFile = path.join(agentDir, 'harness.json');
  await writeJson(globalFile, { subagent: { maxActiveChildren: 1 } });
  const first = fakePi();
  const second = fakePi();
  const firstConfig = harnessConfigFor(first.api)(context(cwd, true));
  assert.equal(firstConfig.subagent.maxActiveChildren, 1);

  await writeJson(globalFile, { subagent: { maxActiveChildren: 2 } });
  first.emit('session_start');
  assert.equal(harnessConfigFor(first.api)(context(cwd, true)).subagent.maxActiveChildren, 2);
  assert.equal(harnessConfigFor(second.api)(context(cwd, true)).subagent.maxActiveChildren, 2);

  await writeJson(globalFile, { subagent: { maxActiveChildren: 3 } });
  first.emit('session_start');
  assert.equal(harnessConfigFor(first.api)(context(cwd, true)).subagent.maxActiveChildren, 3);
  assert.equal(harnessConfigFor(second.api)(context(cwd, true)).subagent.maxActiveChildren, 2);
});

test('a fixed child config is the root snapshot and never reads child files', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  useAgentDir(t, agentDir);
  await writeJson(path.join(agentDir, 'harness.json'), { subagent: { maxActiveChildren: 2 } });
  const root = fakePi();
  const rootConfig = harnessConfigFor(root.api)(context(cwd, true));
  const child = fakePi();
  const childProvider = harnessConfigFor(child.api, rootConfig);
  assert.equal(harnessConfigFor(child.api, rootConfig), childProvider);
  assert.equal(childProvider(context(cwd, false)), rootConfig);

  await writeJson(path.join(cwd, '.pi', 'harness.json'), { subagent: { maxActiveChildren: 4 } });
  await writeFile(path.join(agentDir, 'harness.json'), 'not json', 'utf8');
  child.emit('session_start');
  child.emit('session_tree');
  child.emit('session_shutdown');
  assert.equal(childProvider(context(cwd, true)), rootConfig);
  assert.equal(rootConfig.subagent.maxActiveChildren, 2);
  assert.equal(JSON.stringify(rootConfig), JSON.stringify(harnessConfigFor(root.api)(context(cwd, true))));
});

test('a bad snapshot surfaces as a config error instead of silently returning defaults', async (t) => {
  const { agentDir, cwd } = await tempRoots(t);
  useAgentDir(t, agentDir);
  const file = path.join(agentDir, 'harness.json');
  await writeJson(file, { subagent: { maxDepth: 5 } });
  const { api } = fakePi();
  const provider = harnessConfigFor(api);
  assert.throws(
    () => provider(context(cwd, true)),
    (error: unknown) => error instanceof HarnessConfigError && error.source === file && error.field === 'subagent.budgetsByDepth.3',
  );
  // The failure is not cached: fixing the file makes the same provider succeed on the next call.
  await writeJson(file, { subagent: { maxDepth: 2 } });
  assert.equal(provider(context(cwd, true)).subagent.maxDepth, 2);
});
