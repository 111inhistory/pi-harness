// Isolated SDK memory diagnostic, not a production runner or a Subagent.
// Run: node --expose-gc --max-old-space-size=256 docs/reviews/reproductions/native-session-memory.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

if (!globalThis.gc) throw new Error('Run this diagnostic with --expose-gc.');
const dir = await mkdtemp(path.join(tmpdir(), 'pi-sdk-memory-'));
const rows = [];
async function sample(phase) {
  for (let i = 0; i < 3; i++) { await setImmediate(); globalThis.gc(); }
  const { heapUsed, rss, external } = process.memoryUsage();
  rows.push({ phase, heapMiB: +(heapUsed / 1048576).toFixed(2), rssMiB: +(rss / 1048576).toFixed(2), externalMiB: +(external / 1048576).toFixed(2) });
}

let manager;
let session;
let loader;
let runtime;
let settings;
let model;
let opened;
const retained = new Map();
try {
  await sample('baseline');
  manager = SessionManager.inMemory(dir);
  for (let i = 0; i < 128; i++) {
    manager.appendMessage({ role: 'user', content: randomBytes(48 * 1024).toString('base64'), timestamp: i });
  }
  await sample('native-manager-8MiB-text');
  let branch = manager.getBranch();
  let entries = manager.getEntries();
  assert.equal(branch[0], entries[0], 'native branch/list access shares entry objects');
  await sample('two-shallow-entry-arrays');
  branch = null; entries = null;
  let copies = Array.from({ length: 3 }, () => structuredClone(manager.getBranch()));
  assert.equal(copies.length, 3);
  await sample('three-deep-copies');
  copies = null;
  await sample('deep-copies-released');

  runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  assert.ok(model);
  runtime.streamSimple = () => { throw new Error('This diagnostic must not call a model.'); };
  settings = SettingsManager.inMemory({ packages: [], cacheWarming: 'off', compaction: { enabled: false } });
  loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await loader.reload();
  opened = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: manager });
  session = opened.session; opened = null;
  retained.set('actor', manager);
  await sample('native-session-created');
  session.dispose();
  assert.ok(retained.get('actor').getEntryCount() >= 128, 'dispose does not erase stored entries');
  session = null; manager = null; loader = null; settings = null; runtime = null; model = null;
  await sample('disposed-but-manager-retained');
  retained.clear();
  await sample('all-session-owners-released');
  console.log(JSON.stringify({ sdk: '1.4.0', node: process.version, textMiB: 8, modelCalls: 0, rows }, null, 2));
} finally {
  session?.dispose();
  retained.clear();
  await rm(dir, { recursive: true, force: true });
}
