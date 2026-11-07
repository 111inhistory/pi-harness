import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxProvider, normalizeContext, type Message, type Model, type SystemMessage, type Tool } from '@earendil-works/pi-ai';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { projectDiscoveryDeclarations } from '../../src/capability/declarations.ts';
import { retrievalToolLoadout } from '../../src/capability/retrieval-tools.ts';

const tool = (name: string, description: string): Tool => ({
  name, description, parameters: { type: 'object', properties: {} },
});

async function wire(messages: Message[], api: 'openai-responses' | 'anthropic-messages'): Promise<readonly unknown[]> {
  const model = { ...fauxProvider().getModel(), api, provider: 'offline', id: 'fixture',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  } as Model<typeof api>;
  if (api === 'openai-responses') {
    return convertResponsesMessages(model, normalizeContext({ messages }), new Set([model.provider]), {
      includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
    }) as unknown as readonly unknown[];
  }
  let payload: unknown;
  const stream = streamAnthropic(model as Model<'anthropic-messages'>, normalizeContext({ messages }), {
    apiKey: 'offline', cacheRetention: 'none',
    fetch: async () => { throw new Error('Network access is forbidden'); },
    onPayload: value => { payload = value; throw new Error('Payload captured'); },
  });
  assert.equal((await stream.result()).stopReason, 'error');
  const request = payload as { system: unknown; messages: unknown[] };
  return [request.system, ...request.messages];
}

for (const api of ['openai-responses', 'anthropic-messages'] as const) {
  test(`${api}: blocked inherited Codemode keeps the parent's declaration prefix`, async () => {
    const codemode = tool('codemode', 'Legacy searchTools catalog: mcp__fixture__read');
    const native: Message[] = [
      { role: 'system', content: '', timestamp: 0, sections: {
        preamble: 'Base', mcp_servers: 'Unselected server catalog',
      }, toolsAdded: [codemode] },
      { role: 'user', content: 'Find a capability', timestamp: 1 },
    ];
    const before = structuredClone(native);
    let reads = 0;
    const describe = () => { reads += 1; return 'Run JavaScript using the callable tool snapshot.'; };
    const parent = projectDiscoveryDeclarations(native, () => true, describe) as Message[];
    const loadout = retrievalToolLoadout(native, [tool('capability_step', 'Select local resources')]);
    const blocked = loadout.find(entry => entry.name === 'codemode')!;
    assert.ok('execute' in blocked);
    await assert.rejects(blocked.execute(), /unavailable in capability discovery/);
    const { label: _label, execute: _execute, ...declaration } = blocked;
    assert.deepEqual(declaration, codemode, 'execution blocking preserves the original declaration metadata');
    const child = projectDiscoveryDeclarations([
      ...native,
      { role: 'system', content: 'Only retrieval tools may execute.', timestamp: 2,
        toolsAdded: loadout } as SystemMessage,
      { role: 'user', content: 'Search now', timestamp: 3 },
    ], () => true, describe) as Message[];
    assert.deepEqual(child.slice(0, parent.length), parent);
    assert.equal(reads, 2, 'one metadata lookup per complete projection');
    assert.deepEqual(native, before);
    const first = await wire(parent, api);
    assert.deepEqual((await wire(child, api)).slice(0, first.length), first);
  });
}
