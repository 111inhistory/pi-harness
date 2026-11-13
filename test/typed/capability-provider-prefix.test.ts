/**
 * Provider-boundary proof of what enabling a tool does to a request.
 *
 * A real `createAgentSession` runs the real harness extension, the real command
 * and the real projection with an offline scripted model. Two boundaries are
 * checked:
 *
 * 1. The transcript the agent hands to the provider: the messages of the request
 *    before the enable are an exact prefix of the request after it, the leading
 *    system message is not rewritten, and the tool loadout only grows.
 * 2. The provider-facing conversion (`resolveTranscript` from
 *    `@earendil-works/pi-ai/utils/transcript`, the entry point every provider
 *    function calls first): a transport that accepts mid-conversation system
 *    messages keeps the head untouched. A transport that does not folds later
 *    system messages into the head, so the head text changes for any declared
 *    tool whose prompt section Pi patches.
 *
 * The capability projection contributes nothing to either path: a user
 * enablement is branch authority, never request memory. The second case below
 * measures the remaining, Pi-owned cost instead of claiming it away.
 */
import { projectCapabilitySnapshot } from './support/capability-snapshot.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore, type AssistantMessage, type Message,
} from '@earendil-works/pi-ai';
import { collapseSystemMessages, normalizeContext, resolveTranscript } from '@earendil-works/pi-ai/utils/transcript';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import harnessExtension from '../../test-support/harness-extension.ts';
import {  type ProjectionMessage } from '../../src/capability/prompt.ts';

const PERMISSION_RECORD = 'capability-tool-permission';

function permissionRecordCount(branch: readonly unknown[]): number {
  return branch.filter((entry) => {
    const record = entry as { type?: string; customType?: string };
    return record.type === 'custom' && record.customType === PERMISSION_RECORD;
  }).length;
}

const TOOL = 'deck_pages';

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

/** The wire messages a provider function receives for one support mode. */
function wire(messages: readonly AgentMessage[], midConversationSystemMessages: boolean): Message[] {
  return resolveTranscript(normalizeContext({ messages: messages as unknown as Message[] }), midConversationSystemMessages)
    .messages;
}

function projected(messages: readonly AgentMessage[], branch: readonly unknown[]): AgentMessage[] {
  return projectCapabilitySnapshot(
    messages as unknown as readonly ProjectionMessage[],
    branch,
    { allowsTool: () => true },
  ) as unknown as AgentMessage[];
}

/** Sections whose content differs between two replayed prompt heads. */
function changedSections(before: Message[], after: Message[]): string[] {
  const head = (messages: Message[]): Record<string, string> =>
    (collapseSystemMessages(normalizeContext({ messages: messages as never })).messages[0] as
      { sections?: Record<string, string> }).sections ?? {};
  const left = head(before);
  const right = head(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((name) => left[name] !== right[name]);
}

interface Scenario {
  readonly before: AgentMessage[];
  readonly after: AgentMessage[];
  readonly branch: readonly unknown[];
  readonly third: AgentMessage[];
}

/**
 * Run one enable on a real session and return the captured requests.
 *
 * `promptSnippet` and `promptGuidelines` decide whether Pi lists the tool in its
 * prompt sections; a tool without them is declared only in the tool list.
 */
async function scenario(options: {
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}): Promise<Scenario> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-capability-prefix-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  let session: AgentSession | undefined;
  try {
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      capability: { manualTools: [TOOL] },
    }));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    const faux = fauxProvider({ models: [{ id: 'prefix-fixture', contextWindow: 1_048_576 }] });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = faux.models[0]!;
    const requests: AgentMessage[][] = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context.messages) as AgentMessage[]);
      const reply = textReply(model, `turn ${requests.length}`);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: reply });
      stream.end();
      return stream;
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        {
          name: 'prefix-manual-fixture',
          factory: (api: ExtensionAPI) => {
            api.registerTool({
              name: TOOL,
              label: 'Deck pages',
              description: 'List deck pages.',
              ...(options.promptSnippet === undefined ? {} : { promptSnippet: options.promptSnippet }),
              ...(options.promptGuidelines === undefined ? {} : { promptGuidelines: [...options.promptGuidelines] }),
              parameters: { type: 'object', properties: {} },
              async execute() {
                return { content: [{ type: 'text' as const, text: 'DECK_PAGES_EXECUTED' }], details: {} };
              },
            });
          },
        },
        { name: 'harness-prefix-fixture', factory: (api: ExtensionAPI) => { harnessExtension(api); } },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });

    await session.prompt('First turn, before enablement.');
    const before = requests.at(-1)!;
    assert.ok(!getCurrentTools(before).some((tool) => tool.name === TOOL), 'the unauthorized tool is not declared');
    assert.ok(!session.getActiveToolNames().includes(TOOL), 'the declaration prune removed the manual tool');

    const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === 'capability');
    assert.ok(command, 'the harness registers /capability');
    const notices: { text: string; type: string }[] = [];
    const commandContext = session.extensionRunner.createCommandContext();
    Object.defineProperty(commandContext, 'ui', {
      value: { notify: (text: string, type: string = 'info') => { notices.push({ text, type }); } },
    });
    await command.handler(`enable ${TOOL}`, commandContext);
    assert.match(notices.at(-1)?.text ?? '', new RegExp(`Capability · enable ${TOOL}`));
    assert.match(notices.at(-1)?.text ?? '', new RegExp(`✔ ${TOOL}`));
    assert.ok(session.getActiveToolNames().includes(TOOL), 'the user command activated it');

    await session.prompt('Second turn, after enablement.');
    const after = requests.at(-1)!;
    const branch = session.sessionManager.getBranch();
    assert.equal(permissionRecordCount(branch), 1, 'the branch carries the user authorization');

    await command.handler(`enable ${TOOL}`, commandContext);
    assert.match(notices.at(-1)?.text ?? '', new RegExp(`Already enabled\\n {2}· ${TOOL}`));
    await session.prompt('Third turn, after a repeated enable.');
    assert.deepEqual(errors, []);
    return { before, after, branch, third: requests.at(-1)! };
  } finally {
    try {
      if (session !== undefined) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

test('enabling a tool appends to the request and never rewrites the head', { timeout: 60_000 }, async () => {
  // A tool without a prompt snippet or guidelines: Pi's prompt sections do not
  // mention it, so declaring it is a pure tool-list append.
  const { before, after, branch, third } = await scenario({});

  // 1) The request prefix is untouched: the enable appended, it did not rewrite.
  assert.deepEqual(after.slice(0, before.length), before, 'every earlier message is byte-identical');
  assert.deepEqual(after[0], before[0], 'the leading system message is not rewritten');

  // 2) The loadout grew by exactly the enabled tool, in place.
  const beforeTools = getCurrentTools(before).map((tool) => tool.name);
  const afterTools = getCurrentTools(after).map((tool) => tool.name);
  assert.deepEqual(afterTools, [...beforeTools, TOOL], 'the declaration is appended, existing order kept');

  // 3) No capability memory is injected: the declaration supplies the interface.
  assert.doesNotMatch(JSON.stringify(after), /<capabilities>/, 'a user enablement adds no prompt section');

  // 4) The projection contributes nothing to the provider request, in either mode.
  assert.deepEqual(wire(projected(after, branch), false), wire(after, false),
    'the projection does not change the collapsed provider request');
  assert.deepEqual(wire(projected(after, branch), true), wire(after, true),
    'nor a mid-conversation-system request');

  // 5) A transport with mid-conversation system messages keeps the head and prefix.
  const midBefore = wire(before, true);
  const midAfter = wire(after, true);
  assert.deepEqual(midAfter[0], midBefore[0], 'the head is byte-identical at the provider boundary');
  assert.deepEqual(midAfter.slice(0, midBefore.length), midBefore, 'and so is the whole prefix');

  // 6) A transport without them folds later system messages into the head. With no
  //    prompt section to patch, that head is still identical.
  assert.deepEqual(changedSections(wire(before, false), wire(after, false)), [],
    'the collapsed head does not change for a tool outside Pi\'s prompt sections');

  // 7) A repeated enable appends nothing.
  assert.deepEqual(third.slice(0, after.length), after, 'a repeated enable appends nothing');
  assert.equal(permissionRecordCount(branch), 1, 'and records nothing');
});

test('a measured limitation: a tool with a prompt snippet patches Pi\'s prompt sections', { timeout: 60_000 }, async () => {
  // `promptSnippet`/`promptGuidelines` put the tool into Pi's `<tools>` and
  // `<rules>` sections. This is Pi's prompt model, not capability memory, and it
  // is measured here rather than presented as a cache fix.
  const { before, after, branch } = await scenario({
    promptSnippet: 'List the pages of a deck',
    promptGuidelines: ['Use deck_pages to inspect a deck before editing it'],
  });

  // The transcript is still append-only: the patch is a new system message.
  assert.deepEqual(after.slice(0, before.length), before, 'earlier messages are still byte-identical');
  assert.deepEqual(after[0], before[0], 'and the leading system message is still not rewritten');

  // On a mid-conversation-system transport the head stays identical too.
  assert.deepEqual(wire(after, true)[0], wire(before, true)[0]);

  // Without that support, Pi's own section patch is folded into the head.
  assert.deepEqual(changedSections(wire(before, false), wire(after, false)).sort(), ['rules', 'tools'],
    'only Pi\'s tool-derived sections change');

  // Even here the capability projection adds nothing to that folded head.
  assert.deepEqual(wire(projected(after, branch), false), wire(after, false),
    'capability memory is not the cause of the folded head change');
  assert.doesNotMatch(JSON.stringify(wire(after, false)), /<capabilities>/);
});
