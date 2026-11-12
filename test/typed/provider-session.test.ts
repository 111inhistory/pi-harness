import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProviderTransport,
  providerSessionPolicy,
  type ProviderRequestFacts,
  type ProviderSessionPolicy,
} from '../../src/provider-session.ts';

function responses(compat: Record<string, boolean>): ProviderSessionPolicy {
  return providerSessionPolicy({ api: 'openai-responses', compat });
}

function effortPolicy(
  model: Record<string, unknown>,
  request?: ProviderRequestFacts,
): ProviderSessionPolicy['midConversationEffort'] {
  return providerSessionPolicy(model, request).midConversationEffort;
}

test('classifies only the exact native transport APIs', () => {
  for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
    assert.equal(classifyProviderTransport({ api }), 'responses');
  }
  assert.equal(classifyProviderTransport({ api: 'anthropic-messages' }), 'anthropic');
  assert.equal(classifyProviderTransport({ api: 'openai-completions' }), 'completions');
  for (const api of ['mistral-conversations', 'pi-virtual', 'bedrock-converse-stream']) {
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
    toolAdditions: true,
    toolSameNameUpdates: true,
    midConversationEffort: 'none',
  });
  assert.deepEqual(responses({ supportsToolSearch: true }), {
    transport: 'responses',
    midConversationSystemMessages: false,
    toolAdditions: true,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
  assert.deepEqual(responses({ supportsMidConvoSystemMessages: true }), {
    transport: 'responses',
    midConversationSystemMessages: true,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
  assert.deepEqual(responses({}), {
    transport: 'responses',
    midConversationSystemMessages: false,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
});

test('Anthropic requires both its mid-conversation bits', () => {
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: true,
    toolAdditions: true,
    toolSameNameUpdates: true,
    midConversationEffort: 'none',
  });
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoSystemMessages: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: true,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
  assert.deepEqual(providerSessionPolicy({
    api: 'anthropic-messages',
    compat: { supportsMidConvoToolChanges: true },
  }), {
    transport: 'anthropic',
    midConversationSystemMessages: false,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
});

test('Chat Completions derives additions tool placement strictly from its own bits', () => {
  // additions iff both mid-conversation system messages and tool additions are true
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: true,
    },
  }), {
    transport: 'completions',
    midConversationSystemMessages: true,
    toolAdditions: true,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  // mid-convo system messages without tool additions allows prompt updates but no tool additions
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {
      supportsMidConvoSystemMessages: true,
    },
  }), {
    transport: 'completions',
    midConversationSystemMessages: true,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  // tool additions without mid-convo system messages cannot anchor tools
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {
      supportsMidConvoToolAdditions: true,
    },
  }), {
    transport: 'completions',
    midConversationSystemMessages: false,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  // empty compat defaults to false / none
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {},
  }), {
    transport: 'completions',
    midConversationSystemMessages: false,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  // other transports' flags have no effect on completions
  assert.deepEqual(providerSessionPolicy({
    api: 'openai-completions',
    compat: {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoToolChanges: true,
    },
  }), {
    transport: 'completions',
    midConversationSystemMessages: true,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });
});

test('Responses effort uses the exact API, effective level, and resolved OpenAI auth/baseUrl', () => {
  const customGateway = {
    api: 'openai-responses',
    provider: 'custom-gateway',
    baseUrl: 'https://gateway.invalid/v1',
    compat: { supportsMidConvoEffort: true },
  };
  const openAIGateway = {
    ...customGateway,
    provider: 'openai',
  };
  const officialOpenAI = {
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    compat: { supportsMidConvoEffort: true },
  };

  // A non-openai provider cannot satisfy the adapter's sign-in predicate.
  assert.equal(effortPolicy(customGateway), 'unverified');
  assert.equal(effortPolicy(customGateway, { thinkingLevel: 'low' }), 'responses-configuration-update');
  assert.equal(
    effortPolicy(customGateway, { thinkingLevel: 'low', auth: { apiKey: 'not-sk-gateway' } }),
    'responses-configuration-update',
  );

  // provider=openai needs resolved auth even when the catalog URL is custom,
  // because resolved auth.baseUrl can replace it before the adapter dispatch.
  assert.equal(effortPolicy(openAIGateway, { thinkingLevel: 'low' }), 'unverified');
  assert.equal(effortPolicy(openAIGateway, { thinkingLevel: 'low', auth: {} }), 'responses-configuration-update');
  assert.equal(
    effortPolicy(openAIGateway, {
      thinkingLevel: 'low',
      auth: { baseUrl: 'https://api.openai.com/v1', apiKey: 'offline-chatgpt-token' },
    }),
    'none',
  );

  // The reverse override must also use the resolved URL, not the catalog URL.
  assert.equal(
    effortPolicy(officialOpenAI, {
      thinkingLevel: 'medium',
      auth: { baseUrl: 'https://gateway.invalid/v1', apiKey: 'offline-chatgpt-token' },
    }),
    'responses-configuration-update',
  );

  // The official resolved path needs resolved auth; an empty resolved auth
  // object means no override and no API key (header-only).
  assert.equal(effortPolicy(officialOpenAI, { thinkingLevel: 'medium' }), 'unverified');
  assert.equal(effortPolicy(officialOpenAI, { thinkingLevel: 'medium', auth: {} }), 'responses-configuration-update');
  assert.equal(
    effortPolicy(officialOpenAI, { thinkingLevel: 'medium', auth: { apiKey: 'sk-offline' } }),
    'responses-configuration-update',
  );
  assert.equal(
    effortPolicy(officialOpenAI, { thinkingLevel: 'medium', auth: { apiKey: 'offline-chatgpt-token' } }),
    'none',
  );
  // Empty auth.baseUrl is not an override, matching the SDK's truthy check.
  assert.equal(
    effortPolicy(officialOpenAI, { thinkingLevel: 'medium', auth: { baseUrl: '', apiKey: 'offline-chatgpt-token' } }),
    'none',
  );
  assert.equal(
    effortPolicy(openAIGateway, { thinkingLevel: 'medium', auth: { baseUrl: '', apiKey: 'offline-chatgpt-token' } }),
    'responses-configuration-update',
  );

  // Effective level and the compat bit are independently required.
  assert.equal(effortPolicy(customGateway, { thinkingLevel: 'off' }), 'none');
  assert.equal(effortPolicy(customGateway, { thinkingLevel: 'low', auth: {} }), 'responses-configuration-update');
  assert.equal(effortPolicy({ ...customGateway, compat: {} }, { thinkingLevel: 'low' }), 'none');
});

test('only openai-responses and enabled Anthropic have native effort encoders', () => {
  assert.equal(effortPolicy({
    api: 'azure-openai-responses',
    compat: { supportsMidConvoEffort: true },
  }, { thinkingLevel: 'high' }), 'none');
  assert.equal(effortPolicy({
    api: 'openai-codex-responses',
    compat: { supportsMidConvoEffort: true },
  }, { thinkingLevel: 'high' }), 'none');
  assert.equal(effortPolicy({
    api: 'openai-completions',
    compat: { supportsMidConvoEffort: true },
  }, { thinkingLevel: 'high' }), 'none');

  const anthropic = {
    api: 'anthropic-messages',
    compat: { supportsMidConvoEffort: true },
  };
  assert.equal(effortPolicy(anthropic), 'unverified');
  assert.equal(effortPolicy(anthropic, { thinkingLevel: 'high' }), 'anthropic-effort-markers');
  assert.equal(effortPolicy(anthropic, { thinkingLevel: 'off' }), 'none');
  assert.equal(effortPolicy({ ...anthropic, compat: {} }, { thinkingLevel: 'high' }), 'none');
});
