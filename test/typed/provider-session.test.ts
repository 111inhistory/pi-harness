import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProviderTransport,
  providerSessionPolicy,
  type ProviderSessionPolicy,
} from '../../src/provider-session.ts';

function responses(compat: Record<string, boolean>): ProviderSessionPolicy {
  return providerSessionPolicy({ api: 'openai-responses', compat });
}

test('classifies only the exact native transport APIs', () => {
  for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
    assert.equal(classifyProviderTransport({ api }), 'responses');
  }
  assert.equal(classifyProviderTransport({ api: 'anthropic-messages' }), 'anthropic');
  for (const api of ['openai-completions', 'mistral-conversations', 'pi-virtual', 'bedrock-converse-stream']) {
    assert.equal(classifyProviderTransport({ api }), 'other');
  }
  assert.equal(classifyProviderTransport({ api: 'openai-responses', provider: 'custom-gateway' }), 'responses');
  assert.equal(classifyProviderTransport({ compat: { supportsMidConvoSystemMessages: true } }), 'other');
  assert.equal(classifyProviderTransport({ api: 42 }), 'other');
  assert.equal(classifyProviderTransport(null), 'other');
});

test('Responses derives tool placement from the transport bits', () => {
  assert.deepEqual(responses({ supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }), {
    transport: 'responses',
    midConversationSystemMessages: true,
    toolSupport: 'changes',
  });
  assert.deepEqual(responses({ supportsToolSearch: true }), {
    transport: 'responses',
    midConversationSystemMessages: false,
    toolSupport: 'additions',
  });
  assert.deepEqual(responses({ supportsMidConvoSystemMessages: true }), {
    transport: 'responses',
    midConversationSystemMessages: true,
    toolSupport: 'none',
  });
  assert.deepEqual(responses({}), {
    transport: 'responses',
    midConversationSystemMessages: false,
    toolSupport: 'none',
  });
});

test('Anthropic requires both its mid-conversation bits', () => {
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: true,
    toolSupport: 'changes',
  });
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoSystemMessages: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: true,
    toolSupport: 'none',
  });
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoToolChanges: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: false,
    toolSupport: 'none',
  });
});

test('Chat Completions ignores additive compat', () => {
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    },
  }), {
    transport: 'other',
    midConversationSystemMessages: false,
    toolSupport: 'none',
  });
});
