import assert from 'node:assert/strict';
import test from 'node:test';

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  normalizeContext,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  CACHE_IDENTITY_CUSTOM_TYPE,
  installSessionCacheIdentity,
  recordSessionCacheIdentity,
  resolveSessionCacheKey,
  type SessionCacheTarget,
} from '../../src/session-cache-runtime.ts';
import { isHarnessEntry, withoutEntries } from '../../src/subagent/storage.ts';

function responsesModelFixture(id = 'test-responses-fixture'): Model<'openai-responses'> {
  return {
    id,
    name: id,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function anthropicModelFixture(id = 'test-anthropic-fixture'): Model<'anthropic-messages'> {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
}

function emptyStream(): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.end();
  return stream;
}

test('resolveSessionCacheKey: defaults to local session ID when no entry on branch', () => {
  const manager = SessionManager.inMemory('/tmp/project');
  const resolved = resolveSessionCacheKey(manager);
  assert.equal(resolved, manager.getSessionId());
});

test('resolveSessionCacheKey: throws explicitly on malformed branch entry data instead of masking corruption', () => {
  const manager = SessionManager.inMemory('/tmp/project');

  // 1. Missing data or not an object
  manager.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, 'not-an-object');
  assert.throws(
    () => resolveSessionCacheKey(manager),
    /Malformed harness-cache-identity entry on session branch/,
  );

  // 2. Missing 'key' property
  const manager2 = SessionManager.inMemory('/tmp/project');
  manager2.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { wrongProp: 'val' });
  assert.throws(
    () => resolveSessionCacheKey(manager2),
    /missing 'key' property/,
  );

  // 3. 'key' is invalid type (e.g. number instead of string or null)
  const manager3 = SessionManager.inMemory('/tmp/project');
  manager3.appendCustomEntry(CACHE_IDENTITY_CUSTOM_TYPE, { key: 12345 });
  assert.throws(
    () => resolveSessionCacheKey(manager3),
    /expected string or null, got number/,
  );
});

test('recordSessionCacheIdentity & resolveSessionCacheKey: explicit key, disabled null, and lineage order', () => {
  const manager = SessionManager.inMemory('/tmp/project');

  // 1. Record explicit cache key
  recordSessionCacheIdentity(manager, 'parent-cache-key-1');
  assert.equal(resolveSessionCacheKey(manager), 'parent-cache-key-1');

  // 2. Lineage update: newer entry overrides earlier entry
  recordSessionCacheIdentity(manager, 'parent-cache-key-2');
  assert.equal(resolveSessionCacheKey(manager), 'parent-cache-key-2');

  // 3. Explicit disable: key = null
  recordSessionCacheIdentity(manager, null);
  assert.equal(resolveSessionCacheKey(manager), null);

  // 4. Explicit re-enable on subsequent branch turn
  recordSessionCacheIdentity(manager, 'revived-cache-key');
  assert.equal(resolveSessionCacheKey(manager), 'revived-cache-key');
});

test('harness-cache-identity entry survives isHarnessEntry filtering for nested branch preservation', () => {
  const manager = SessionManager.inMemory('/tmp/project');
  recordSessionCacheIdentity(manager, 'lineage-preserved-key');

  const branch = manager.getBranch();
  const cacheEntry = branch.find(
    (e) => typeof e === 'object' && e !== null && 'customType' in e && e.customType === CACHE_IDENTITY_CUSTOM_TYPE,
  );
  assert.ok(cacheEntry, 'harness-cache-identity entry must exist on branch');

  // isHarnessEntry only targets subagent-* entries; harness-cache-identity must NOT be dropped
  assert.equal(isHarnessEntry(cacheEntry), false);

  const kept = withoutEntries(branch, isHarnessEntry);
  assert.ok(
    kept.some((e) => typeof e === 'object' && e !== null && 'customType' in e && e.customType === CACHE_IDENTITY_CUSTOM_TYPE),
    'harness-cache-identity entry must survive withoutEntries(..., isHarnessEntry)',
  );
});

test('installSessionCacheIdentity: strictly validates required target properties', () => {
  assert.throws(
    () => installSessionCacheIdentity(null as any),
    /live agent stream boundary and sessionManager are required/,
  );
  assert.throws(
    () => installSessionCacheIdentity({ agent: {} } as any),
    /live agent stream boundary and sessionManager are required/,
  );
  assert.throws(
    () => installSessionCacheIdentity({ agent: { streamFunction: () => emptyStream() } } as any),
    /live agent stream boundary and sessionManager are required/,
  );
});

test('installSessionCacheIdentity: fresh session (key === undefined) does not append duplicate or default entries', () => {
  const manager = SessionManager.inMemory('/tmp/project');
  const initialBranchLength = manager.getBranch().length;

  const session: SessionCacheTarget = {
    agent: { streamFunction: () => emptyStream() },
    sessionManager: manager,
  };

  // Fresh install with undefined key
  installSessionCacheIdentity(session);
  assert.equal(manager.getBranch().length, initialBranchLength, 'fresh session must not append default record');
  assert.equal(resolveSessionCacheKey(manager), manager.getSessionId());

  // Same explicit key does not append duplicate entry
  installSessionCacheIdentity(session, 'explicit-key-1');
  const afterFirstAppend = manager.getBranch().length;
  assert.equal(afterFirstAppend, initialBranchLength + 1);

  installSessionCacheIdentity(session, 'explicit-key-1');
  assert.equal(manager.getBranch().length, afterFirstAppend, 'same key must not duplicate-append');
});

test('installSessionCacheIdentity: wraps agent.streamFunction, adapts Responses, and cleanup restores stream', async () => {
  const manager = SessionManager.inMemory('/tmp/project');
  let streamCalledWithOptions: SimpleStreamOptions | undefined;

  const originalStream: StreamFn = (_model, _context, options) => {
    streamCalledWithOptions = options;
    return emptyStream();
  };

  const session: SessionCacheTarget = {
    agent: { streamFunction: originalStream },
    sessionManager: manager,
  };

  const cleanup = installSessionCacheIdentity(session, 'inherited-outbound-key');

  assert.equal(resolveSessionCacheKey(manager), 'inherited-outbound-key');
  assert.notEqual(session.agent.streamFunction, originalStream);

  const responsesModel = responsesModelFixture();
  const context = normalizeContext({ messages: [] });
  const streamOptions: SimpleStreamOptions = {
    sessionId: manager.getSessionId(),
  };

  session.agent.streamFunction(responsesModel, context, streamOptions);

  assert.ok(streamCalledWithOptions?.onPayload, 'streamFunction must provide wrapped onPayload');
  const wrappedOnPayload = streamCalledWithOptions.onPayload;

  const nativePayload = {
    model: 'gpt-5.6-luna',
    prompt_cache_key: manager.getSessionId(),
    input: [],
  };
  const finalPayload = (await wrappedOnPayload(nativePayload, responsesModel)) as Record<string, unknown>;

  // Outbound prompt_cache_key was replaced with inherited key
  assert.equal(finalPayload['prompt_cache_key'], 'inherited-outbound-key');

  // Cleanup restores original streamFunction
  cleanup();
  assert.equal(session.agent.streamFunction, originalStream);
});

test('installSessionCacheIdentity: existing onPayload override has final priority and records update to lineage', async () => {
  const manager = SessionManager.inMemory('/tmp/project');
  let streamCalledWithOptions: SimpleStreamOptions | undefined;

  const originalStream: StreamFn = (_model, _context, options) => {
    streamCalledWithOptions = options;
    return emptyStream();
  };

  const session: SessionCacheTarget = {
    agent: { streamFunction: originalStream },
    sessionManager: manager,
  };

  installSessionCacheIdentity(session, 'base-inherited-key');
  assert.equal(resolveSessionCacheKey(manager), 'base-inherited-key');

  const responsesModel = responsesModelFixture();
  const existingOnPayload = async (payload: unknown) => ({
    ...(payload as Record<string, unknown>),
    prompt_cache_key: 'final-user-hook-override',
  });

  const context = normalizeContext({ messages: [] });
  const streamOptions: SimpleStreamOptions = {
    sessionId: manager.getSessionId(),
    onPayload: existingOnPayload,
  };

  session.agent.streamFunction(responsesModel, context, streamOptions);

  assert.ok(streamCalledWithOptions?.onPayload);
  const wrappedOnPayload = streamCalledWithOptions.onPayload;
  const nativePayload = {
    model: 'gpt-5.6-luna',
    prompt_cache_key: manager.getSessionId(),
    input: [],
  };
  const finalPayload = (await wrappedOnPayload(nativePayload, responsesModel)) as Record<string, unknown>;

  // Final hook override wins
  assert.equal(finalPayload['prompt_cache_key'], 'final-user-hook-override');
  // Manager lineage was updated to reflect actual final key
  assert.equal(resolveSessionCacheKey(manager), 'final-user-hook-override');
});

test('installSessionCacheIdentity: Anthropic requests do not inject fields and do not persist null to manager', async () => {
  const manager = SessionManager.inMemory('/tmp/project');
  const initialBranchLength = manager.getBranch().length;
  let streamCalledWithOptions: SimpleStreamOptions | undefined;

  const originalStream: StreamFn = (_model, _context, options) => {
    streamCalledWithOptions = options;
    return emptyStream();
  };

  const session: SessionCacheTarget = {
    agent: { streamFunction: originalStream },
    sessionManager: manager,
  };

  // Fresh session install
  installSessionCacheIdentity(session);

  const anthropicModel = anthropicModelFixture();
  const context = normalizeContext({ messages: [] });
  const streamOptions: SimpleStreamOptions = {
    sessionId: manager.getSessionId(),
  };

  session.agent.streamFunction(anthropicModel, context, streamOptions);

  assert.ok(streamCalledWithOptions?.onPayload);
  const wrappedOnPayload = streamCalledWithOptions.onPayload;
  const anthropicPayload = {
    model: 'claude-3-7-sonnet',
    messages: [{ role: 'user', content: 'test' }],
  };
  const finalPayload = (await wrappedOnPayload(anthropicPayload, anthropicModel)) as Record<string, unknown>;

  assert.equal('prompt_cache_key' in finalPayload, false);
  // Anthropic missing prompt_cache_key must NOT be persisted as key: null on manager
  assert.equal(manager.getBranch().length, initialBranchLength);
  assert.equal(resolveSessionCacheKey(manager), manager.getSessionId());
});
