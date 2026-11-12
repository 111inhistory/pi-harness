import assert from 'node:assert/strict';
import test from 'node:test';

import type { SystemMessage, Tool } from '@earendil-works/pi-ai';

import { appendSessionTranscript, firstToolDeclarations, softToolBlockNote } from '../../src/session-transcript.ts';

function tool(name: string, description = name): Tool {
  return { name, description, parameters: { type: 'object', properties: {} } };
}

function system(content: string, tools: readonly Tool[] = []): SystemMessage {
  return {
    role: 'system',
    content,
    ...(tools.length === 0 ? {} : { toolsAdded: [...tools] }),
    timestamp: 0,
  };
}

test('blocked tools become soft notes, never removal events', () => {
  const inherited = [system('base', [tool('read'), tool('secret')])];

  const result = appendSessionTranscript(inherited, {
    blockedTools: ['secret', 'secret', ''],
  });

  assert.equal(result.appended?.content, softToolBlockNote('secret'));
  assert.equal('toolsRemoved' in (result.appended ?? {}), false);
  assert.deepEqual(
    (result.messages[0] as SystemMessage).toolsAdded?.map((entry) => entry.name),
    ['read', 'secret'],
  );
});

test('inherited Pi-native removal history is left untouched and no removal is added', () => {
  const removal = {
    role: 'system',
    content: '',
    toolsRemoved: [{ name: 'read' }],
    timestamp: 2,
  } as const;

  const result = appendSessionTranscript([removal], { blockedTools: ['read'] });

  assert.equal(result.messages[0], removal);
  assert.equal(result.appended?.content, softToolBlockNote('read'));
  assert.equal('toolsRemoved' in (result.appended ?? {}), false);
});

test('first declarations keep transcript order and strip executable handles', () => {
  const executable = { ...tool('read'), execute: async () => 'parent read' } as unknown as Tool;

  const declarations = firstToolDeclarations([
    { role: 'system', toolsAdded: [executable, tool('read', 'later duplicate')] },
    { role: 'system', toolsAdded: [tool('write')] },
  ]);

  assert.deepEqual(declarations.map((entry) => entry.name), ['read', 'write']);
  assert.equal(declarations[0]?.description, 'read');
  assert.equal('execute' in (declarations[0] ?? {}), false);
});
