import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message, SystemMessage, Tool } from '@earendil-works/pi-ai';

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

test('appends instructions and declarations without rewriting the inherited prefix', () => {
  const head = system('base', [tool('read')]);
  const user: Message = { role: 'user', content: 'task', timestamp: 1 };
  const inherited: Message[] = [head, user];

  const result = appendSessionTranscript(inherited, {
    instructions: { text: '  child instructions  ', sections: { role: 'child', empty: '' } },
    declarations: [tool('deck_pages')],
  });

  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0], head);
  assert.equal(result.messages[1], user);

  const appended = result.appended;
  assert.ok(appended);
  assert.equal(appended.role, 'system');
  assert.equal(appended.content, 'child instructions');
  assert.deepEqual(appended.sections, { role: 'child' });
  assert.deepEqual(appended.toolsAdded, [tool('deck_pages')]);
  assert.equal('toolsRemoved' in appended, false);
  assert.equal('toolsRemoved' in result.messages[0]!, false);
});

test('preserves historical declarations and appends only new or changed ones', () => {
  const first = system('', [tool('read', 'first')]);
  const second = system('', [tool('read', 'second')]);

  const result = appendSessionTranscript([first, second], {
    declarations: [tool('read', 'second'), tool('read', 'third'), tool('deck_pages')],
  });

  assert.equal(result.messages[0], first);
  assert.equal(result.messages[1], second);
  assert.deepEqual(result.appended?.toolsAdded?.map((entry) => [entry.name, entry.description]), [
    ['read', 'third'],
    ['deck_pages', 'deck_pages'],
  ]);
  assert.deepEqual(first.toolsAdded, [tool('read', 'first')]);
  assert.deepEqual(second.toolsAdded, [tool('read', 'second')]);
});

test('a repeated identical declaration is a no-op', () => {
  const inherited = [system('base', [tool('read')])];

  const result = appendSessionTranscript(inherited, { declarations: [tool('read')] });

  assert.equal(result.messages, inherited);
  assert.equal(result.appended, undefined);
});

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

test('declarations are stored without executable handles', () => {
  const executable = { ...tool('deck_pages'), execute: async () => ({}) } as unknown as Tool;

  const result = appendSessionTranscript([], { declarations: [executable] });

  const declaration = result.appended?.toolsAdded?.[0];
  assert.ok(declaration);
  assert.equal('execute' in declaration, false);
  assert.deepEqual(declaration, tool('deck_pages'));
});

test('successive calls append in order and retain earlier additions', () => {
  const first = appendSessionTranscript([], { instructions: { text: 'one' } });
  const second = appendSessionTranscript(first.messages, {
    instructions: { text: 'two' },
    declarations: [tool('deck_pages')],
  });

  assert.equal(second.messages.length, 2);
  assert.equal((second.messages[0] as SystemMessage).content, 'one');
  assert.equal(second.appended?.content, 'two');
  assert.deepEqual(second.appended?.toolsAdded?.map((entry) => entry.name), ['deck_pages']);
});

test('empty instructions and sections do not append a message', () => {
  const inherited = [system('base')];

  const result = appendSessionTranscript(inherited, {
    instructions: { text: '   ', sections: { empty: '' } },
  });

  assert.equal(result.messages, inherited);
  assert.equal(result.appended, undefined);
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
