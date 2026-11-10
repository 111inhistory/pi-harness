/**
 * Declaration visibility is published on the shared ResourceLoader bus, not on
 * one ExtensionAPI object. Pi gives every extension its own API object, so the
 * capability extension owns the reader while the RPC/subagent extension only
 * sees a different object on the same bus.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { independentDeclarations, setIndependentDeclarations } from '../../src/capability/declaration-visibility.ts';

/** One shared bus with distinct per-extension API objects over it. */
function sharedBus() {
  const listeners = new Set<(data: unknown) => void>();
  const events = {
    emit(_event: string, data?: unknown): unknown {
      for (const listener of listeners) listener(data);
      return undefined;
    },
    on(_event: string, handler: (data: unknown) => void): unknown {
      listeners.add(handler);
      return undefined;
    },
  };
  return events;
}

test('a second extension reads the reader published by the capability extension', () => {
  const bus = sharedBus();
  const capabilityApi = { events: bus };
  const rpcApi = { events: bus };
  assert.notEqual(rpcApi, capabilityApi, 'Pi gives each extension its own API object');

  const declared = new Set(['read', 'write']);
  setIndependentDeclarations(capabilityApi, () => declared);

  assert.deepEqual([...independentDeclarations(capabilityApi)!], ['read', 'write']);
  assert.deepEqual([...independentDeclarations(rpcApi)!], ['read', 'write'],
    'the RPC API finds the reader through the shared bus, not its own WeakMap entry');
});

test('a host with no bus reports no known declaration projection', () => {
  assert.equal(independentDeclarations({}), null);
});
