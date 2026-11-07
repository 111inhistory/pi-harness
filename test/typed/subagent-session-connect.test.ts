/**
 * `/subagent sessions connect <uid|sessionId>`: the user makes one live peer
 * session reachable from the current agent.
 *
 * The command is a local information step, not a message: it appends the peer's
 * identity, working directory and Main address as a native custom context
 * message that starts no turn, and it grants `msg_write` through the same enable
 * path `/capability enable` uses. These cases pin the RootService contract (one
 * branch record, idempotent activation, no remote write, ownership fence after
 * every await) and the real SDK path: the contact reaches a provider request,
 * the request prefix is preserved, the tool is declared on the next request, a
 * manual `msg_write` is authorized by the user's own action, and a busy turn
 * queues the contact instead of interrupting it.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { collapseSystemMessages, resolveTranscript } from '@earendil-works/pi-ai/utils/transcript';

import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { argumentCompletionProvider } from '../../src/autocomplete.ts';
import { waitFor } from '../../test-support/async.ts';

/**
 * The harness resolves its socket root once, when the IPC platform module first
 * loads. Every test in this file therefore shares one private temp root, and the
 * override is in place before any harness module is imported.
 */
const SOCKET_ROOT = path.join(tmpdir(), `pi-session-connect-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
process.env['PI_SUBAGENT_SOCKET_DIR'] = SOCKET_ROOT;

async function loadHarness() {
  const [root, directory, records, peers] = await Promise.all([
    import('../../src/subagent/root-service.ts'),
    import('../../src/subagent/session-directory.ts'),
    import('../../src/capability/discovery-record.ts'),
    import('../../src/subagent/session-peers.ts'),
  ]);
  return { ...root, ...directory, ...peers, records };
}

interface Recorded {
  readonly entries: Array<{ customType: string; data?: unknown }>;
  readonly messages: Array<{ message: { customType: string; content: string; display: boolean }; options?: unknown }>;
  readonly active: Set<string>;
  readonly registered: Map<string, { name: string; exposure?: string }>;
}

async function fixture(t: TestContext, options: { readonly failRecord?: boolean } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-session-connect-'));
  const socketRoot = SOCKET_ROOT;
  const harness = await loadHarness();
  const manager = SessionManager.inMemory(cwd);
  const recorded: Recorded = {
    entries: [], messages: [], active: new Set(), registered: new Map([['msg_write', { name: 'msg_write' }]]),
  };
  const api = {
    getAllTools: () => [...recorded.registered.values()],
    getActiveTools: () => [...recorded.active],
    setActiveTools(names: string[]) {
      recorded.active.clear();
      for (const name of names) if (recorded.registered.has(name)) recorded.active.add(name);
    },
    appendEntry(customType: string, data?: unknown) {
      if (options.failRecord === true && customType === harness.records.CAPABILITY_DISCOVERY_RECORD) {
        throw new Error('the session branch is read-only');
      }
      recorded.entries.push({ customType, data });
      // The real API writes the branch; the branch is where a repeat connect
      // reads what is already recorded.
      manager.appendCustomEntry(customType, data);
    },
    sendMessage(message: Recorded['messages'][number]['message'], options?: unknown) {
      recorded.messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true,
  } as unknown as ExtensionContext;
  let owned = true;
  const service = new harness.RootService({
    api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => owned,
  });
  await service.initialize();
  t.after(async () => {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, socketRoot, manager, service, recorded, harness, own: () => owned, release: () => { owned = false; } };
}

test('connect appends the peer contact and grants msg_write once', async (t) => {
  const { cwd, socketRoot, service, recorded, harness } = await fixture(t);
  const peer = await harness.registerSession(socketRoot, { sessionId: 'peer-session', cwd, name: 'peer work' });
  t.after(() => harness.unregisterSession(socketRoot, peer.sessionId));
  const address = harness.sessionMainAddress(peer);

  const result = await service.connectSession(peer.uid);
  assert.equal(result.session.uid, peer.uid);
  assert.equal(result.address, address);
  assert.deepEqual([...result.enabled], ['msg_write']);
  assert.equal(result.recordError, null);
  assert.ok(recorded.active.has('msg_write'), 'the shared enable path activated the tool');

  assert.equal(recorded.messages.length, 1);
  const delivered = recorded.messages[0]!;
  assert.equal(delivered.message.customType, harness.SESSION_CONTACT);
  assert.equal(delivered.message.display, true);
  assert.deepEqual(delivered.options, { triggerTurn: false });
  const text = delivered.message.content;
  assert.match(text, new RegExp(`uid: ${peer.uid}`));
  assert.match(text, new RegExp(`session: ${peer.sessionId}`));
  assert.match(text, /name: peer work/);
  assert.match(text, new RegExp(`cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(text.includes(`Main address: ${address}`));
  assert.match(text, /Use msg_write/);

  const record = recorded.entries.filter((entry) => entry.customType === harness.records.CAPABILITY_DISCOVERY_RECORD);
  assert.equal(record.length, 1, 'the grant is one branch record');
  const memory = (record[0]!.data as { result: { manual: Array<{ name?: string }> } }).result;
  assert.deepEqual(memory.manual.map((hit) => hit.name), ['msg_write']);

  // A repeat is allowed and appends the current contact again, without a second
  // record: connect keeps no connection state of its own.
  const again = await service.connectSession(peer.sessionId);
  assert.deepEqual([...again.enabled], []);
  assert.deepEqual([...again.alreadyEnabled], ['msg_write']);
  assert.equal(again.recordError, null);
  assert.equal(recorded.messages.length, 2);
  assert.equal(recorded.entries.filter((entry) => entry.customType === harness.records.CAPABILITY_DISCOVERY_RECORD).length, 1);

  assert.equal(existsSync(address), false, 'connect writes no frame to the peer');
});

test('connect records its manual grant even when msg_write was already discovered', async (t) => {
  const { cwd, socketRoot, manager, service, recorded, harness } = await fixture(t);
  const peer = await harness.registerSession(socketRoot, { sessionId: 'peer-discovered-session', cwd, name: null });
  t.after(() => harness.unregisterSession(socketRoot, peer.sessionId));
  manager.appendCustomEntry(harness.records.CAPABILITY_DISCOVERY_RECORD, {
    version: harness.records.CAPABILITY_DISCOVERY_RECORD_VERSION,
    result: {
      status: 'ok',
      tools: [{ name: 'msg_write', ref: 'tool://msg_write', kind: 'tool', status: 'available' }],
      mcp: [], skills: [], coverage: { local: 'searched', remote: 'not_searched' },
    },
  });
  recorded.active.add('msg_write');
  assert.equal(harness.records.manualEnabledTools(manager.getBranch()).has('msg_write'), false);

  const result = await service.connectSession(peer.uid);
  assert.deepEqual([...result.enabled], ['msg_write']);
  assert.deepEqual([...result.alreadyEnabled], []);
  assert.equal(recorded.entries.length, 1, 'discovery does not suppress the explicit user grant');
  assert.equal(harness.records.manualEnabledTools(manager.getBranch()).has('msg_write'), true);
  assert.equal(recorded.messages.length, 1);
});

test('a failed branch record still appends the contact but reports a partial result', async (t) => {
  const { cwd, socketRoot, service, recorded, harness } = await fixture(t, { failRecord: true });
  const peer = await harness.registerSession(socketRoot, { sessionId: 'peer-record-failure', cwd, name: null });
  t.after(() => harness.unregisterSession(socketRoot, peer.sessionId));

  const result = await service.connectSession(peer.uid);
  assert.match(result.recordError ?? '', /the session branch is read-only/);
  assert.deepEqual([...result.enabled], ['msg_write'], 'activation still succeeded');
  assert.ok(recorded.active.has('msg_write'));
  assert.equal(recorded.messages.length, 1, 'the contact is appended despite the failed record');
  assert.equal(recorded.entries.length, 0, 'no durable grant was written');
});

test('connect refuses an unknown or self target without touching context', async (t) => {
  const { service, recorded, harness } = await fixture(t);

  await assert.rejects(service.connectSession('nosuch'), (error: unknown) =>
    error instanceof Error && 'code' in error && (error as { code: string }).code === 'session_not_found');
  await assert.rejects(service.connectSession(service.sessionId), (error: unknown) =>
    error instanceof Error && 'code' in error && (error as { code: string }).code === 'invalid_target');
  assert.equal(recorded.messages.length, 0);
  assert.equal(recorded.entries.length, 0);
  assert.equal(recorded.active.has('msg_write'), false);
});

test('an unusable msg_write refuses before any contact reaches the context', async (t) => {
  const { cwd, socketRoot, service, recorded, harness } = await fixture(t);
  const peer = await harness.registerSession(socketRoot, { sessionId: 'peer-session', cwd, name: null });
  t.after(() => harness.unregisterSession(socketRoot, peer.sessionId));
  recorded.registered.delete('msg_write');

  await assert.rejects(service.connectSession(peer.uid), (error: unknown) =>
    error instanceof Error && 'code' in error && (error as { code: string }).code === 'msg_write_unavailable');
  assert.equal(recorded.messages.length, 0, 'the model never receives an address it cannot use');
  assert.equal(recorded.entries.length, 0);
});

test('a root that loses its branch while the connect resolves writes nothing', async (t) => {
  const { cwd, socketRoot, service, recorded, harness, release } = await fixture(t);
  const peer = await harness.registerSession(socketRoot, { sessionId: 'peer-session', cwd, name: null });
  t.after(() => harness.unregisterSession(socketRoot, peer.sessionId));

  // Native compaction is the one await inside connect: revoke ownership while
  // the append is waiting on it, so the post-await fence is what refuses.
  service.beginCompaction();
  const pending = service.connectSession(peer.uid);
  await Promise.resolve();
  release();
  service.endCompaction();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof Error && 'code' in error && (error as { code: string }).code === 'runtime_closed');
  assert.equal(recorded.messages.length, 0, 'a stale root never appends into the new session');
  assert.equal(recorded.entries.length, 0);
  assert.equal(recorded.active.has('msg_write'), false);
});

function textReply(model: { api: string; provider: string; id: string }, text: string): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
    usage: {
      input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

type Transcript = Parameters<typeof resolveTranscript>[0];

/** The wire messages a provider function receives for one support mode. */
function wire(messages: readonly AgentMessage[], midConversationSystemMessages: boolean): Transcript['messages'] {
  return resolveTranscript({ messages } as unknown as Transcript, midConversationSystemMessages).messages;
}

/** The visible text blocks of the user messages in one provider request. */
function userText(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return [];
    return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []);
  });
}

/** A real SDK session running the real harness, with a scripted offline model. */
async function sdkFixture(t: TestContext, options: { manual?: boolean } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-session-connect-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  // `msg_write` is manual here: the user's connect must be enough authorization.
  if (options.manual === true) {
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      capability: { manualTools: ['msg_write'] },
    }));
  }
  const [{ default: harnessExtension }, directory, root] = await Promise.all([
    import('../../test-support/harness-extension.ts'),
    import('../../src/subagent/session-directory.ts'),
    import('../../src/subagent/session-peers.ts'),
  ]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'session-connect-fixture', contextWindow: 1_048_576 }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0]!;
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const requests: AgentMessage[][] = [];
  const declared: string[][] = [];
  const held: AssistantMessageEventStream[] = [];
  const immediate = (index: number): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: textReply(model, `turn ${index + 1}`) });
    stream.end();
    return stream;
  };
  let respond = immediate;
  runtime.streamSimple = (_model, context) => {
    declared.push(getCurrentTools(context.messages).map((entry) => entry.name));
    requests.push(structuredClone(context.messages) as AgentMessage[]);
    return respond(requests.length - 1);
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'session-connect-fixture', factory: harnessExtension }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const session = (await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  })).session;
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const peer = await directory.registerSession(SOCKET_ROOT, { sessionId: 'peer-session', cwd, name: 'peer work' });
  const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === 'subagent');
  assert.ok(command, 'the harness registers /subagent on the real SDK session');
  const notices: Array<{ text: string; type: string }> = [];
  const ctx = session.extensionRunner.createCommandContext();
  Object.defineProperty(ctx, 'ui', {
    value: { notify: (text: string, type: string = 'info') => { notices.push({ text, type }); } },
  });
  t.after(async () => {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    finally {
      session.dispose();
      await directory.unregisterSession(SOCKET_ROOT, peer.sessionId);
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  const entries = () => session.sessionManager.getEntries();
  return {
    cwd, session, model, requests, declared, errors, notices, peer, held, command, directory,
    address: directory.sessionMainAddress(peer),
    contacts: () => entries().filter((entry) => entry.type === 'custom_message' && entry.customType === root.SESSION_CONTACT).length,
    grants: () => entries().filter((entry) => entry.type === 'custom' && entry.customType === 'capability-discovery').length,
    connect: async (target: string = peer.uid) => { await command.handler(`sessions connect ${target}`, ctx); },
    hold: (): AssistantMessageEventStream => {
      const stream = new AssistantMessageEventStream();
      held.push(stream);
      return stream;
    },
    respondWith: (fn: (index: number) => AssistantMessageEventStream) => { respond = fn; },
    respondImmediately: () => { respond = immediate; },
    finish: (stream: AssistantMessageEventStream, text: string) => {
      stream.push({ type: 'done', reason: 'stop', message: textReply(model, text) });
      stream.end();
    },
  };
}

test('forced Tab completes connect and live peer targets through the real command and editor provider', async (t) => {
  const f = await sdkFixture(t);
  const provider = argumentCompletionProvider(new CombinedAutocompleteProvider([f.command], f.cwd), 'subagent');
  const signal = new AbortController().signal;
  const suggest = (line: string) => provider.getSuggestions([line], 0, line.length, { signal, force: true });
  const actionLine = '/subagent sessions con';
  const actions = await suggest(actionLine);
  assert.ok(actions);
  const action = actions.items.find(item => item.value === 'sessions connect ');
  assert.ok(action, 'partial connect is offered on forced Tab');
  const appliedAction = provider.applyCompletion([actionLine], 0, actionLine.length, action, actions.prefix);
  assert.equal(appliedAction.lines[0], '/subagent sessions connect ');
  const targets = await suggest(appliedAction.lines[0]!);
  assert.ok(targets);
  const target = targets.items.find(item => item.value === `sessions connect ${f.peer.uid}`);
  assert.ok(target, 'the published live peer is offered');
  assert.match(target.label, /peer work/);
  assert.equal(targets.items.length, 1, 'the current session is excluded from connect targets');
  const appliedTarget = provider.applyCompletion(appliedAction.lines, 0, appliedAction.cursorCol, target, targets.prefix);
  assert.equal(appliedTarget.lines[0]?.trimEnd(), `/subagent sessions connect ${f.peer.uid}`);
  assert.equal(f.contacts(), 0, 'completion does not append contacts');
  assert.equal(f.grants(), 0, 'completion does not grant msg_write');
  assert.ok(!f.session.getActiveToolNames().includes('msg_write'));
  await f.directory.unregisterSession(SOCKET_ROOT, f.peer.sessionId);
  assert.equal(await f.command.getArgumentCompletions?.(`sessions connect ${f.peer.uid}`), null,
    'a withdrawn live record disappears without restarting the editor');
});

test('connect appends to the provider request and never rewrites its prefix', { timeout: 60_000 }, async (t) => {
  const f = await sdkFixture(t, { manual: true });
  const { session, requests, declared } = f;

  assert.ok(!session.getActiveToolNames().includes('msg_write'), 'Main starts without the write tool');
  await session.prompt('First turn, before connect.');
  assert.equal(requests.length, 1);
  const before = requests[0]!;
  assert.ok(!declared[0]!.includes('msg_write'), 'the unauthorized manual tool is not declared');

  await f.connect();
  assert.deepEqual(f.notices.map((notice) => notice.type), ['info'], JSON.stringify(f.notices));
  assert.match(f.notices[0]!.text, new RegExp(`^Connected ${f.peer.uid} \\(peer work\\) at ${f.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(f.notices[0]!.text.includes(`main: ${f.address}`));
  assert.match(f.notices[0]!.text, /msg_write: enabled/);
  assert.equal(requests.length, 1, 'connect starts no unsolicited turn');
  assert.equal(f.contacts(), 1);
  assert.equal(f.grants(), 1, 'the explicit user action records the grant');

  await session.prompt('Second turn, after connect.');
  assert.equal(requests.length, 2);
  const after = requests[1]!;

  // 1) The earlier request is an exact prefix: connect appended, it did not rewrite.
  assert.deepEqual(after.slice(0, before.length), before, 'every earlier message is byte-identical');
  assert.deepEqual(after[0], before[0], 'the leading system message is not rewritten');

  // 2) The loadout grew by exactly the granted tool, in place.
  assert.deepEqual(declared[1], [...declared[0]!, 'msg_write'], 'the declaration is appended, existing order kept');

  // 3) The contact lives only in the appended region, with the selected identity.
  //    The visible text is read as-is: a serialized payload escapes the address
  //    separators, so a substring test on JSON would depend on the transport.
  const contact = userText(after.slice(before.length))
    .find((text) => text.startsWith('The user connected a live Pi session'));
  assert.ok(contact, 'the contact is appended as a user text message');
  const identity = [
    ['uid', f.peer.uid],
    ['session id', f.peer.sessionId],
    ['address', f.address],
    ['tool hint', 'Use msg_write'],
  ] as const;
  for (const [label, needle] of identity) {
    assert.ok(contact.includes(needle), `the contact ${label} reaches the provider request verbatim`);
  }
  assert.equal(userText(before).some((text) => text.includes(f.peer.uid)), false, 'nothing about the peer predates the connect');

  // 4) The additive transport keeps the head and the prefix. The collapsed
  //    transport is checked only for its earlier conversation; the baseline
  //    still has the owned tool-metadata head drift described below.
  const midBefore = wire(before, true);
  const midAfter = wire(after, true);
  assert.deepEqual(midAfter[0], midBefore[0], 'the head is byte-identical with mid-conversation system messages');
  assert.deepEqual(midAfter.slice(0, midBefore.length), midBefore, 'and so is the whole prefix');
  const rawBefore = wire(before, false);
  const rawAfter = wire(after, false);
  // A transport that folds system messages rebuilds the leading head from every
  // system message, so there only the conversation after the head is a prefix.
  assert.deepEqual(rawAfter.slice(1, rawBefore.length), rawBefore.slice(1),
    'the collapsed transport keeps the earlier conversation');

  // 5) Existing baseline limitation: declaring msg_write patches Pi's tool
  //    sections through its prompt metadata. A transport that folds system
  //    messages can therefore change the head on the first enable. This is not
  //    the desired long-term contract; the shared provider/context integration
  //    and owned tool-metadata migration must remove the avoidable head drift.
  //    Step 6 isolates contact delivery by repeating a connect with no new tool.

  // 6) A repeated connect appends the current contact and records nothing new, so
  //    the next request extends the previous one — head included, in both modes.
  await f.connect(f.peer.sessionId);
  assert.match(f.notices.at(-1)!.text, /msg_write: already enabled/);
  assert.equal(f.contacts(), 2);
  assert.equal(f.grants(), 1);
  await session.prompt('Third turn, after a repeated connect.');
  assert.equal(requests.length, 3);
  const third = requests[2]!;
  assert.deepEqual(third.slice(0, after.length), after, 'a repeated connect rewrites nothing earlier');
  const collapsedSecond = wire(after, false);
  const collapsedThird = wire(third, false);
  assert.deepEqual(collapsedThird.slice(0, collapsedSecond.length), collapsedSecond,
    'with no new declaration, even the folded head is byte-identical');
  assert.deepEqual(collapsedThird[0], collapsedSecond[0], 'the folded head is unchanged');

  // 7) A stale or unknown target is a normal lookup error, not a silent no-op.
  await f.connect('nosuch');
  assert.equal(f.notices.at(-1)!.type, 'error');
  assert.match(f.notices.at(-1)!.text, /session_not_found/);
  assert.equal(f.contacts(), 2);

  assert.equal(existsSync(f.address), false, 'no frame was written to the peer endpoint');
  assert.deepEqual(f.errors, []);
});

test('connect during a streaming turn queues the contact instead of interrupting', { timeout: 60_000 }, async (t) => {
  const f = await sdkFixture(t);
  const { session, requests, declared } = f;
  f.respondWith(() => f.hold());

  const turn = session.prompt('Busy turn.');
  await waitFor(() => f.held.length === 1 && session.isStreaming, { label: 'the streaming turn' });
  const first = f.held[0]!;

  await f.connect();
  assert.equal(f.notices.at(-1)!.type, 'info');
  assert.equal(requests.length, 1, 'connect starts no extra request');
  assert.equal(f.contacts(), 0, 'the contact is not inserted while the turn is still running');

  f.finish(first, 'busy done');
  await turn;
  assert.equal(f.contacts(), 1, 'the contact lands at the end of the turn');
  assert.equal(requests.length, 1, 'and still starts no request');

  f.respondImmediately();
  await session.prompt('Next turn.');
  assert.equal(requests.length, 2);
  assert.ok(declared[1]!.includes('msg_write'), 'the granted tool is declared on the next request');
  assert.ok(JSON.stringify(requests[1]).includes(f.peer.uid), 'the queued contact is visible on the next request');

  // A root retired by a pending switch refuses the connect instead of writing
  // into whatever session replaces it.
  await session.extensionRunner.emit({ type: 'session_before_switch', reason: 'new' });
  await f.connect();
  assert.equal(f.notices.at(-1)!.type, 'error');
  assert.match(f.notices.at(-1)!.text, /runtime_transitioning/);
  assert.equal(f.contacts(), 1, 'a transitioning root appends nothing');
  assert.equal(requests.length, 2, 'and starts no request');
});
