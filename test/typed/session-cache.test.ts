import assert from 'node:assert/strict';
import test from 'node:test';

import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache';
import {
  applySessionCacheToPayload,
  type SessionCacheOptions,
} from '../../src/session-cache.ts';

test('payload replacement recognizes native Unicode truncation and preserves inherited code points', () => {
  const nativeSessionId = '🚀'.repeat(70);
  const inheritedKey = '🌍'.repeat(70);
  const payload = { prompt_cache_key: clampOpenAIPromptCacheKey(nativeSessionId) };
  const result = applySessionCacheToPayload(payload, { api: 'openai-responses' }, {
    nativeSessionId, inheritedKey,
  }) as { prompt_cache_key: string };
  assert.equal(result.prompt_cache_key, clampOpenAIPromptCacheKey(inheritedKey));
  assert.equal(result.prompt_cache_key, '🌍'.repeat(64));
  assert.equal(payload.prompt_cache_key, '🚀'.repeat(64), 'the native payload is not mutated');
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
