import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampOpenAIPromptCacheKey,
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from '@earendil-works/pi-ai/api/openai-prompt-cache';
import {
  applySessionCacheToPayload,
  resolveSessionCacheIdentity,
  wrapSessionCacheOnPayload,
  type SessionCacheOptions,
} from '../../src/session-cache.ts';

test('native clampOpenAIPromptCacheKey clamps to 64 code points', () => {
  assert.equal(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, 64);
  assert.equal(clampOpenAIPromptCacheKey(undefined), undefined);

  const shortKey = 'subagent-task-123';
  assert.equal(clampOpenAIPromptCacheKey(shortKey), shortKey);

  const longKey = 'a'.repeat(80);
  assert.equal(clampOpenAIPromptCacheKey(longKey), 'a'.repeat(64));

  // Preserves multi-byte Unicode code points without surrogate corruption
  const unicodeKey = '🚀'.repeat(70);
  const clamped = clampOpenAIPromptCacheKey(unicodeKey)!;
  assert.equal(Array.from(clamped).length, 64);
  assert.equal(clamped, '🚀'.repeat(64));
});

test('resolveSessionCacheIdentity: native default vs explicit inherited key', () => {
  // Native default when no inherited key
  const nativeOnly = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
  });
  assert.deepEqual(nativeOnly, {
    effectiveKey: 'sess-child-001',
    disabled: false,
    isInherited: false,
  });

  // Explicit inheritedKey overrides native default
  const inherited = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
  });
  assert.deepEqual(inherited, {
    effectiveKey: 'sess-parent-root',
    disabled: false,
    isInherited: true,
  });

  // Long keys are clamped to 64 code points
  const longParent = 'p'.repeat(100);
  const clampedInherited = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    inheritedKey: longParent,
  });
  assert.equal(clampedInherited.effectiveKey, 'p'.repeat(64));
  assert.equal(clampedInherited.isInherited, true);
});

test('resolveSessionCacheIdentity: cacheRetention none disables caching over all keys', () => {
  // cacheRetention: 'none' overrides explicit inherited key
  const noneWithInherited = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
    cacheRetention: 'none',
  });
  assert.deepEqual(noneWithInherited, {
    effectiveKey: undefined,
    disabled: true,
    isInherited: false,
  });

  // cacheRetention: 'none' overrides native default
  const noneWithNative = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    cacheRetention: 'none',
  });
  assert.deepEqual(noneWithNative, {
    effectiveKey: undefined,
    disabled: true,
    isInherited: false,
  });

  // cacheRetention short/long keeps caching active
  for (const retention of ['short', 'long'] as const) {
    const active = resolveSessionCacheIdentity({
      nativeSessionId: 'sess-child-001',
      inheritedKey: 'sess-parent-root',
      cacheRetention: retention,
    });
    assert.deepEqual(active, {
      effectiveKey: 'sess-parent-root',
      disabled: false,
      isInherited: true,
    });
  }
});

test('resolveSessionCacheIdentity: handles empty strings and preserves opaque keys without trimming', () => {
  // Empty inheritedKey falls back to native
  const emptyInherited = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    inheritedKey: '',
  });
  assert.deepEqual(emptyInherited, {
    effectiveKey: 'sess-child-001',
    disabled: false,
    isInherited: false,
  });

  // Opaque whitespace-carrying keys are preserved verbatim (not trimmed)
  const opaqueInherited = resolveSessionCacheIdentity({
    nativeSessionId: 'sess-child-001',
    inheritedKey: '  key-with-spaces  ',
  });
  assert.deepEqual(opaqueInherited, {
    effectiveKey: '  key-with-spaces  ',
    disabled: false,
    isInherited: true,
  });

  // Both empty returns undefined effectiveKey
  const bothEmpty = resolveSessionCacheIdentity({
    nativeSessionId: '',
    inheritedKey: '',
  });
  assert.deepEqual(bothEmpty, {
    effectiveKey: undefined,
    disabled: false,
    isInherited: false,
  });
});

test('applySessionCacheToPayload: replaces native default key with explicit inherited key for Responses', () => {
  const responsesModels = [
    { api: 'openai-responses' },
    { api: 'azure-openai-responses' },
    { api: 'openai-codex-responses' },
  ];

  for (const model of responsesModels) {
    const payload = {
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: 'hello' }],
      prompt_cache_key: 'sess-child-001',
      temperature: 0.2,
    };

    const options: SessionCacheOptions = {
      nativeSessionId: 'sess-child-001',
      inheritedKey: 'sess-parent-root',
    };

    const result = applySessionCacheToPayload(payload, model, options) as Record<string, unknown>;
    assert.equal(result.prompt_cache_key, 'sess-parent-root');
    assert.equal(result.model, 'gpt-5.6-luna');
    assert.equal(result.temperature, 0.2);
    // Original payload is not mutated in place
    assert.equal(payload.prompt_cache_key, 'sess-child-001');
  }
});

test('applySessionCacheToPayload: keeps native default key unchanged when no inheritedKey is provided', () => {
  const payload = {
    model: 'gpt-5.6-luna',
    prompt_cache_key: 'sess-child-001',
  };

  const options: SessionCacheOptions = {
    nativeSessionId: 'sess-child-001',
  };

  const result = applySessionCacheToPayload(payload, { api: 'openai-responses' }, options);
  assert.deepEqual(result, payload);
});

test('applySessionCacheToPayload: does not inject key if payload had no key or retention is none', () => {
  // If payload has no prompt_cache_key, keep it unchanged (do not quietly re-enable or inject)
  const noKeyPayload = {
    model: 'gpt-5.6-luna',
    input: [],
  };

  const options: SessionCacheOptions = {
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
  };

  const result1 = applySessionCacheToPayload(noKeyPayload, { api: 'openai-responses' }, options);
  assert.deepEqual(result1, noKeyPayload);
  assert.equal('prompt_cache_key' in (result1 as object), false);

  // If retention is none and payload has native default key, remove it
  const nativePayload = {
    model: 'gpt-5.6-luna',
    prompt_cache_key: 'sess-child-001',
  };
  const noneOptions: SessionCacheOptions = {
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
    cacheRetention: 'none',
  };
  const result2 = applySessionCacheToPayload(nativePayload, { api: 'openai-responses' }, noneOptions) as Record<string, unknown>;
  assert.equal('prompt_cache_key' in result2, false);
});

test('applySessionCacheToPayload: preserves user non-default custom key (e.g. from samplingParams)', () => {
  const customPayload = {
    model: 'gpt-5.6-luna',
    prompt_cache_key: 'custom-account-pool-key',
    temperature: 0.5,
  };

  const options: SessionCacheOptions = {
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
  };

  // Even though inheritedKey is present, existing key differs from native default: preserve it!
  const result = applySessionCacheToPayload(customPayload, { api: 'openai-responses' }, options);
  assert.deepEqual(result, customPayload);
});

test('applySessionCacheToPayload: Anthropic and other transports are never injected with OpenAI fields', () => {
  const anthropicModel = { api: 'anthropic-messages' };
  const anthropicPayload = {
    model: 'claude-3-7-sonnet-20250219',
    messages: [{ role: 'user', content: 'test' }],
  };

  const options: SessionCacheOptions = {
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
  };

  const resultAnthropic = applySessionCacheToPayload(anthropicPayload, anthropicModel, options);
  assert.deepEqual(resultAnthropic, anthropicPayload);
  assert.equal('prompt_cache_key' in (resultAnthropic as object), false);

  // Other APIs (Completions, Bedrock, unknown)
  for (const api of ['openai-completions', 'bedrock-converse-stream', 'mistral-conversations', 'pi-virtual']) {
    const otherPayload = { model: 'other-model', prompt_tokens: 10 };
    const resultOther = applySessionCacheToPayload(otherPayload, { api }, options);
    assert.deepEqual(resultOther, otherPayload);
    assert.equal('prompt_cache_key' in (resultOther as object), false);
  }

  // Primitive/non-record payloads pass through
  assert.equal(applySessionCacheToPayload(null, { api: 'openai-responses' }, options), null);
  assert.equal(applySessionCacheToPayload('raw', { api: 'openai-responses' }, options), 'raw');
});

test('wrapSessionCacheOnPayload: 4-tier priority hierarchy (native default < inherited < none < final override)', async () => {
  const model = { api: 'openai-responses' };

  // Tier 1: native default key
  const hookTier1 = wrapSessionCacheOnPayload({
    nativeSessionId: 'sess-child-001',
  });
  const res1 = (await hookTier1(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res1.prompt_cache_key, 'sess-child-001');

  // Tier 2: inherited key overrides native default
  const hookTier2 = wrapSessionCacheOnPayload({
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
  });
  const res2 = (await hookTier2(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res2.prompt_cache_key, 'sess-parent-root');

  // Tier 3: cacheRetention none overrides inherited key and native default
  const hookTier3 = wrapSessionCacheOnPayload({
    nativeSessionId: 'sess-child-001',
    inheritedKey: 'sess-parent-root',
    cacheRetention: 'none',
  });
  const res3 = (await hookTier3(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal('prompt_cache_key' in res3, false);

  // Tier 4: existing final onPayload override has highest priority
  // Overrides Tier 2 (inherited key)
  const hookTier4OverInherited = wrapSessionCacheOnPayload(
    {
      nativeSessionId: 'sess-child-001',
      inheritedKey: 'sess-parent-root',
    },
    async (payload) => ({
      ...(payload as Record<string, unknown>),
      prompt_cache_key: 'final-user-hook-override',
    }),
  );
  const res4a = (await hookTier4OverInherited(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res4a.prompt_cache_key, 'final-user-hook-override');

  // Overrides Tier 3 (none / disabled)
  const hookTier4OverNone = wrapSessionCacheOnPayload(
    {
      nativeSessionId: 'sess-child-001',
      inheritedKey: 'sess-parent-root',
      cacheRetention: 'none',
    },
    async (payload) => ({
      ...(payload as Record<string, unknown>),
      prompt_cache_key: 'explicitly-re-enabled-by-custom-hook',
    }),
  );
  const res4b = (await hookTier4OverNone(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res4b.prompt_cache_key, 'explicitly-re-enabled-by-custom-hook');
});

test('wrapSessionCacheOnPayload: supports dynamic options function and in-place existing hook mutation', async () => {
  const model = { api: 'openai-responses' };
  let currentInheritedKey: string | undefined = 'initial-parent';

  const hook = wrapSessionCacheOnPayload(
    () => ({
      nativeSessionId: 'sess-child-001',
      inheritedKey: currentInheritedKey,
    }),
    (payload) => {
      // In-place mutation without returning
      (payload as Record<string, unknown>)['custom_flag'] = true;
      return undefined;
    },
  );

  const res1 = (await hook(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res1.prompt_cache_key, 'initial-parent');
  assert.equal(res1.custom_flag, true);

  // Change dynamic options
  currentInheritedKey = 'updated-parent';
  const res2 = (await hook(
    { model: 'm', prompt_cache_key: 'sess-child-001' },
    model,
  )) as Record<string, unknown>;
  assert.equal(res2.prompt_cache_key, 'updated-parent');
  assert.equal(res2.custom_flag, true);
});
