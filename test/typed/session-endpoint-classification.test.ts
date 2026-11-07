/**
 * `RootService.sessionEndpoint`: the one classification `msg_write` relies on.
 *
 * An address is local, this session's own Main, another live session's Main, or
 * another session's non-Main endpoint. Which addresses belong to a session's
 * endpoint namespace is the IPC platform adapter's answer (socket files below
 * the directory on Unix, the shared pipe prefix on Windows), so this contract is
 * exercised with real native endpoints rather than a filesystem assumption.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

/**
 * The harness resolves its socket root once, when the IPC platform module first
 * loads, so the override is in place before any harness module is imported.
 */
const SOCKET_ROOT = path.join(tmpdir(), `pi-session-endpoint-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
process.env['PI_SUBAGENT_SOCKET_DIR'] = SOCKET_ROOT;

async function loadHarness() {
  const [root, directory, socket] = await Promise.all([
    import('../../src/subagent/root-service.ts'),
    import('../../src/subagent/session-directory.ts'),
    import('../../src/ipc/socket.ts'),
  ]);
  return { ...root, ...directory, ...socket };
}

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-session-endpoint-cwd-'));
  const harness = await loadHarness();
  const api = {
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: { find: () => undefined },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const service = new harness.RootService({
    api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => true,
  });
  await service.initialize();
  t.after(async () => {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, harness, service };
}

test('sessionEndpoint separates peer Main, peer non-Main and local endpoints', async (t) => {
  const { cwd, harness, service } = await fixture(t);
  const peer = await harness.registerSession(SOCKET_ROOT, { sessionId: 'peer-session', cwd, name: 'peer work' });
  t.after(() => harness.unregisterSession(SOCKET_ROOT, peer.sessionId));

  // Registered last so it runs after this root retires and the peer is removed.
  t.after(() => rm(SOCKET_ROOT, { recursive: true, force: true }));

  const own = (await service.listSessions()).find((session) => session.sessionId === service.sessionId);
  assert.ok(own, 'this root publishes itself under the shared socket root');

  assert.deepEqual(await service.sessionEndpoint(harness.sessionMainAddress(own)), { kind: 'local' });
  assert.deepEqual(await service.sessionEndpoint(harness.sessionMainAddress(peer)), { kind: 'session', session: peer });

  const peerEndpoints = [
    harness.getAgentSocketPath('sub_01', peer.socketDir),
    harness.getBroadcastSocketPath('sub_01', peer.socketDir),
  ];
  for (const address of peerEndpoints) {
    assert.deepEqual(await service.sessionEndpoint(address), { kind: 'foreign' },
      `another session's non-Main endpoint is foreign, never local traffic: ${address}`);
  }

  assert.deepEqual(await service.sessionEndpoint(harness.getAgentSocketPath('sub_01', own.socketDir)), { kind: 'local' });
  assert.deepEqual(
    await service.sessionEndpoint(harness.getAgentSocketPath('Main', path.join(SOCKET_ROOT, 'not-a-session'))),
    { kind: 'local' },
    'an endpoint outside every published session namespace is not foreign',
  );
});
