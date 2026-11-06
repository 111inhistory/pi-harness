/**
 * Persistence, nested inheritance, branch navigation, and continuation tests
 * for session cache identity using real SessionManager and Actor storage.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  SessionManager,
  type ExtensionContext,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import { captureInheritedContext } from '../../src/inherited-context.ts';
import {
  CACHE_IDENTITY_CUSTOM_TYPE,
  recordSessionCacheIdentity,
  resolveSessionCacheKey,
} from '../../src/session-cache-runtime.ts';
import { createSubagentStore } from '../../src/subagent/storage.ts';

const pi = { getActiveTools: () => ['read', 'write'] };
const physicalModel = fauxProvider({ models: [{ id: 'physical-persist-fixture', reasoning: true }] }).models[0]!;

function captureCtx(manager: SessionManager, model: Model<Api> = physicalModel) {
  return {
    cwd: '/tmp/fixture-persist',
    sessionManager: manager,
    model,
    thinkingLevel: 'medium' as const,
    getSystemPrompt: () => 'PERSIST_SYSTEM_PROMPT',
    modelRegistry: {} as ExtensionContext['modelRegistry'],
  };
}

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: physicalModel.api,
    provider: physicalModel.provider,
    model: physicalModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

test('persistence: real SessionManager persists harness-cache-identity and recovers parent key on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-cache-persist-'));
  try {
    const manager = SessionManager.create('/tmp/work', dir);
    manager.appendMessage(userMessage('start conversation'));
    recordSessionCacheIdentity(manager, 'fixture-cache');
    manager.appendMessage(assistantMessage('acknowledged'));

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile, 'persisted manager must have a session file');

    // Reopen from disk
    const reopened = SessionManager.open(sessionFile, dir);
    const resolvedKey = resolveSessionCacheKey(reopened);
    assert.equal(resolvedKey, 'fixture-cache');
    assert.equal(reopened.getSessionId(), manager.getSessionId());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nested inheritance: child and grandchild get distinct local session IDs while preserving root parent cache key', () => {
  // 1. Root parent session
  const rootManager = SessionManager.inMemory('/tmp/work');
  rootManager.appendMessage(userMessage('root task'));
  recordSessionCacheIdentity(rootManager, 'root-shared-cache-identity');

  // 2. Capture child snapshot
  const childSnapshot = captureInheritedContext(pi, captureCtx(rootManager));
  assert.equal(childSnapshot.cacheKey, 'root-shared-cache-identity');

  // Verify child snapshot has its own unique session ID in header
  const rootHeader = rootManager.getHeader();
  const childHeader = childSnapshot.entries.find(
    (e): e is Extract<FileEntry, { type: 'session' }> => e.type === 'session',
  );
  assert.ok(childHeader, 'child snapshot must have a session header');
  assert.notEqual(childHeader.id, rootHeader?.id, 'child must have a distinct session ID');

  // 3. Child session instantiated from snapshot entries
  const childManager = SessionManager.inMemory('/tmp/work', {}, childSnapshot.entries as FileEntry[]);
  assert.equal(resolveSessionCacheKey(childManager), 'root-shared-cache-identity');
  assert.notEqual(childManager.getSessionId(), rootManager.getSessionId(), 'child local ID must differ from root');

  // Child performs some work
  childManager.appendMessage(userMessage('child step 1'));
  childManager.appendMessage(assistantMessage('child output 1'));

  // 4. Capture grandchild snapshot from child
  const grandchildSnapshot = captureInheritedContext(pi, captureCtx(childManager));
  assert.equal(grandchildSnapshot.cacheKey, 'root-shared-cache-identity');

  // 5. Grandchild instantiated from grandchild snapshot
  const grandchildManager = SessionManager.inMemory('/tmp/work', {}, grandchildSnapshot.entries as FileEntry[]);
  assert.equal(resolveSessionCacheKey(grandchildManager), 'root-shared-cache-identity');
  assert.notEqual(grandchildManager.getSessionId(), childManager.getSessionId(), 'grandchild local ID must differ from child');
  assert.notEqual(grandchildManager.getSessionId(), rootManager.getSessionId(), 'grandchild local ID must differ from root');

  // Lineage custom entry survived intact across both levels of inheritance
  const customEntries = grandchildManager.getBranch().filter(
    (e) => e.type === 'custom' && e.customType === CACHE_IDENTITY_CUSTOM_TYPE,
  );
  assert.equal(customEntries.length, 1);
});

test('branch navigation: selecting different branches resolves their respective keys without cross-branch leakage', () => {
  const manager = SessionManager.inMemory('/tmp/work');
  const userRoot = manager.appendMessage(userMessage('root prompt'));

  // Branch A: explicit key A
  manager.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { key: 'branch-A-cache-key' });
  const leafA = manager.appendMessage(assistantMessage('reply A'));

  // Switch back to root user message and create Branch B: explicit key B
  manager.branch(userRoot);
  manager.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { key: 'branch-B-cache-key' });
  const leafB = manager.appendMessage(assistantMessage('reply B'));

  // Switch back to root user message and create Branch C: disabled cache (null)
  manager.branch(userRoot);
  manager.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { key: null });
  const leafC = manager.appendMessage(assistantMessage('reply C'));

  // Switch back to root user message: branch has no cache entry, defaults to local session ID
  manager.branch(userRoot);
  assert.equal(resolveSessionCacheKey(manager), manager.getSessionId());

  // Navigate to Branch A
  manager.branch(leafA);
  assert.equal(resolveSessionCacheKey(manager), 'branch-A-cache-key');

  // Navigate to Branch B
  manager.branch(leafB);
  assert.equal(resolveSessionCacheKey(manager), 'branch-B-cache-key');

  // Navigate to Branch C (disabled)
  manager.branch(leafC);
  assert.equal(resolveSessionCacheKey(manager), null);

  // Re-verify Branch A is unaffected by visits to B or C
  manager.branch(leafA);
  assert.equal(resolveSessionCacheKey(manager), 'branch-A-cache-key');
});

test('durable continuation: storage openForAppend preserves cache identity across continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-actor-persist-'));
  try {
    const rootBranch: object[] = [];
    const storage = createSubagentStore<SessionManager>({
      dir,
      appendEntry: (customType: string, data: unknown) => {
        rootBranch.push({ type: 'custom', customType, data });
      },
      readBranch: () => rootBranch,
      readEntries: () => rootBranch,
      openSession: (file, cwd) => SessionManager.open(file, dir, cwd),
    });
    assert.equal(storage.durable, true);

    const agentId = 'actor_sub_01';
    const cwd = '/tmp/work';

    // 1. Initial Actor run
    const initial = storage.openForAppend(agentId, null, null, cwd);
    initial.manager.appendMessage(userMessage('initial turn'));
    recordSessionCacheIdentity(initial.manager, 'actor-retained-cache-key');
    initial.manager.appendMessage(assistantMessage('initial turn response'));

    const recordedLeaf = initial.manager.getLeafId();
    assert.ok(recordedLeaf);

    // 2. Open for continuation from persisted session file and anchor leaf
    const continued = storage.openForAppend(agentId, initial.file, recordedLeaf, cwd);

    // Effective cache key is preserved on continuation
    const resolvedKey = resolveSessionCacheKey(continued.manager);
    assert.equal(resolvedKey, 'actor-retained-cache-key');

    // Subsequent turn on continued manager retains cache identity
    continued.manager.appendMessage(userMessage('continued turn'));
    continued.manager.appendMessage(assistantMessage('continued turn response'));
    assert.equal(resolveSessionCacheKey(continued.manager), 'actor-retained-cache-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
