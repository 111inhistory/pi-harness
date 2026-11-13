import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import fc, { type AsyncCommand } from 'fast-check';
import { checkProperty, commandOptions } from './pbt.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxProvider, InMemoryCredentialStore, getCurrentTools, type AssistantMessage, type Api, type Message, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../src/capability/extension.ts';
import { DEFAULT_HARNESS_CONFIG } from '../src/harness-config.ts';
import { installPresetInstruction } from '../src/preset/instruction.ts';
import { HARNESS_CONTEXT_SYNC_CUSTOM_TYPE } from '../src/request-instructions.ts';
import { toolGuidanceSection } from '../src/tool-guidance.ts';
import { appendPresetState } from '../src/preset/state.ts';
import { serializedRequest, declaredTools } from './capability-model-wire.ts';

const names = ['history_alpha', 'history_beta'] as const;
type Spec = { description: string; schema: number };
type ToolState = Spec & { permission: 'enabled' | 'disabled' | 'unmanaged'; active: boolean; discovered: boolean; discoveredDescription: string | null; used: boolean };
type View = 'native' | 'append' | 'filter' | 'duplicate' | 'opaque' | 'forced' | 'reorder' | 'retained';
interface State { tools: ToolState[]; turn: number; preset: string | null; pruned: string[] }
interface Frame { head: AgentMessage | undefined; hasHeadSystem: boolean; conversation: AgentMessage[] }
interface Request { messages: readonly Message[]; wire: readonly unknown[]; frame: Frame; projected: readonly AgentMessage[] }

const placementJournalTypes = new Set([
  'harness-tool-guidance',
  'harness-capability-memory',
  'harness-preset-instruction',
]);

function placementJournal(world: World) {
  return world.session.sessionManager.getBranch()
    .filter(entry => entry.type === 'custom' && placementJournalTypes.has(entry.customType));
}

function isHarnessSectionKey(key: string): boolean {
  return key === 'preset-instructions'
    || key === 'capabilities'
    || key === 'capability-availability'
    || key.startsWith('harness-guidance-');
}

function effectiveSystemSections(messages: readonly Message[]): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue;
    for (const [key, value] of Object.entries(message.sections)) {
      if (value === null) delete sections[key];
      else sections[key] = value;
    }
  }
  return sections;
}

function allSectionValues(messages: readonly Message[], key: string): (string | null)[] {
  return messages.flatMap(message => {
    if (message.role !== 'system' || !message.sections || !Object.hasOwn(message.sections, key)) return [];
    return [message.sections[key] ?? null];
  });
}

function hasAnyHarnessSection(messages: readonly Message[]): boolean {
  return messages.some(message =>
    message.role === 'system'
    && message.sections !== undefined
    && Object.keys(message.sections).some(isHarnessSectionKey));
}

interface World {
  root: string;
  session: AgentSession;
  api: ExtensionAPI;
  model: Model<Api>;
  metadata: Spec[];
  effects: { slot: number; schema: number; parameters: unknown }[];
  requests: Request[];
  errors: unknown[];
  response: { name: string; slot: number; schema: number } | null;
  selection: number;
  view: View;
  frame: Frame;
  projected: readonly AgentMessage[];
  retained: AgentMessage | undefined;
  open(manager: SessionManager): Promise<void>;
  register(slot: number): void;
  close(): Promise<void>;
}

async function fixture(withStaticGuidance = false): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-capability-history-'));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'history-model' }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = { ...faux.models[0]!, api: 'openai-responses', compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } };
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], defaultTools: ['read', 'capability', names[0],
    ...(withStaticGuidance ? ['subagent_create'] : [])],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 } });
  let session!: AgentSession;
  let api!: ExtensionAPI;
  const world: World = {
    root, model, metadata: names.map(name => ({ description: `Description for ${name}`, schema: 0 })),
    effects: [], requests: [], errors: [], response: null, selection: 0,
    view: 'native', frame: { head: undefined, hasHeadSystem: false, conversation: [] }, projected: [],
    retained: undefined,
    get session() { return session; }, get api() { return api; },
    register(slot) {
      const spec = world.metadata[slot]!;
      world.api.registerTool({ name: names[slot]!, label: names[slot]!, description: spec.description,
        defaultActive: slot === 0, parameters: { type: 'object', properties: { [`revision_${spec.schema}`]: { type: 'string' } } },
        execute: async (_callId, parameters) => {
          world.effects.push({ slot, schema: spec.schema, parameters });
          return { content: [{ type: 'text', text: `Executed revision ${spec.schema}` }], details: { schema: spec.schema } };
        } });
    },
    async open(manager) {
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [{ name: 'capability-history', factory(extensionApi) {
          api = extensionApi;
          api.on('before_agent_start', () => world.view === 'forced' ? { systemPrompt: 'PBT_FORCED_BASE' } : undefined);
          api.on('context', event => {
            const messages = event.messages;
            world.retained ??= messages.find(message => message.role === 'user');
            const plugin = { role: 'user' as const, content: 'PBT_EPHEMERAL_PLUGIN', timestamp: 0 };
            if (world.view === 'append') return { messages: [...messages, plugin] };
            if (world.view === 'retained' && world.retained !== undefined) {
              return { messages: [...messages, world.retained] };
            }
            if (world.view === 'reorder') {
              const users = messages.filter(message => message.role === 'user').reverse();
              let index = 0;
              return { messages: messages.map(message => message.role === 'user' ? users[index++]! : message) };
            }
            if (world.view === 'opaque') return { messages: [...structuredClone(messages), plugin] };
            if (world.view === 'filter') {
              const currentUser = messages.findLastIndex(message => message.role === 'user');
              return { messages: messages.filter((message, index) => message.role !== 'user' || index === currentUser) };
            }
            if (world.view === 'duplicate') {
              const user = messages.findLast(message => message.role === 'user');
              return { messages: user === undefined ? messages : [...messages, user] };
            }
            return undefined;
          });
          // Observe incoming SDK messages before Harness appends its request-local tail snapshot.
          api.on('context_with_system', event => {
            const head = event.messages[0];
            world.frame = {
              head: head === undefined ? undefined : structuredClone(head),
              hasHeadSystem: head?.role === 'system',
              conversation: event.messages.filter(message => message.role !== 'system').map(message => structuredClone(message)),
            };
          });
          capabilityExtension(api, { config: DEFAULT_HARNESS_CONFIG });
          installPresetInstruction(api);
          for (const slot of [0, 1]) world.register(slot);
          if (withStaticGuidance) {
            // Real registration activates native SDK ToolDefinition.promptGuidelines.
            api.registerTool({ name: 'subagent_create', label: 'Static guidance fixture',
              description: 'Fixture for static instruction placement.', defaultActive: true,
              promptGuidelines: ['SUBAGENT_STATIC_GUIDANCE'],
              parameters: { type: 'object', properties: {} },
              execute: async () => { throw new Error('The history model does not issue subagent calls.'); } });
          }
          api.on('session_before_compact', event => ({ compaction: {
            summary: 'Earlier tool usage is historical.', firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          } }));
        } }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      session = (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
        model, settingsManager: settings, resourceLoader: loader, sessionManager: manager })).session;
      await world.session.bindExtensions({
        onError: error => { world.errors.push(error); },
        uiContext: { ...world.session.extensionRunner.createContext().ui,
          notify(message, level) { if (level === 'error') world.errors.push(message); } },
      });
      const transform = session.agent.transformContext;
      session.agent.transformContext = async (messages, signal) => {
        const projected = transform === undefined ? messages : await transform(messages, signal);
        world.projected = structuredClone(projected);
        return projected;
      };
    },
    async close() {
      try {
        await world.session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
        await world.session.dispose();
        assert.deepEqual(world.errors, []);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  };
  faux.provider.streamSimple = (_model, context) => {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      try {
        const retrieval = getCurrentTools(context.messages).some(tool => tool.name === 'capability_step');
        if (!retrieval) world.requests.push({ messages: context.messages, wire: await serializedRequest(model, context.messages),
          frame: world.frame, projected: world.projected });
        const searched = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'capability_step');
        const call = retrieval ? { name: 'capability_step', slot: world.selection, schema: 0 } : world.response;
        if (!retrieval) world.response = null;
        const message: AssistantMessage = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: `history-call-${world.requests.length}-${Date.now()}`, name: call.name,
            arguments: retrieval ? searched ? { refs: [`tool://${names[world.selection]}`], finish: true }
              : { queries: [names[world.selection]!] } : call.name === 'capability' ? {} : { [`revision_${call.schema}`]: 'generated input' } }] : [{ type: 'text', text: 'Model turn complete.' }],
          stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
        };
        stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
      } catch (error) { stream.push({ type: 'error', reason: 'error', error: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'error',
        errorMessage: String(error), timestamp: Date.now(), usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      } }); }
      stream.end();
    })();
    return stream;
  };
  try { await world.open(SessionManager.create(root, path.join(root, 'sessions'))); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return world;
}

type Action = 'describe' | 'schema' | 'enable' | 'disable' | 'reset' | 'discover' | 'execute' | 'compact' | 'reopen' | 'request' |
  'native' | 'append' | 'filter' | 'duplicate' | 'opaque' | 'forced' | 'preset' | 'clear-preset';

function assertBodyPreserved(request: Request) {
  let cursor = 0;
  for (const message of request.frame.conversation) {
    while (cursor < request.projected.length && !isDeepStrictEqual(request.projected[cursor], message)) cursor += 1;
    assert.ok(cursor < request.projected.length, 'caller/plugin messages survive unchanged and in their original order');
    cursor += 1;
  }
}

function assertNoDeveloperTail(messages: readonly Message[], wire: readonly unknown[]) {
  assert.notEqual(messages.at(-1)?.role, 'system', 'requests must never end with a trailing system message');
  const wireTail = wire.at(-1) as { role?: unknown; type?: unknown } | undefined;
  assert.notEqual(wireTail?.role, 'developer', 'encoded Responses wire must never end with a developer item');
}

class Command implements AsyncCommand<State, World> {
  readonly action: Action;
  readonly slot: number;
  readonly description: string;
  readonly schema: number;
  readonly withStaticGuidance: boolean;
  constructor(action: Action, slot: number, description: string, schema: number, withStaticGuidance = false) {
    this.action = action; this.slot = slot; this.description = description; this.schema = schema;
    this.withStaticGuidance = withStaticGuidance;
  }
  check() { return true; }
  async run(state: State, world: World) {
    const tool = state.tools[this.slot]!;
    const discoveredSnapshotBefore = state.tools
      .map((entry, slot) => ({ entry, name: names[slot]! }))
      .filter(({ entry }) => entry.discovered && entry.permission !== 'disabled')
      .map(({ entry, name }) => ({ name, description: entry.discoveredDescription }));
    const discoveredBeforeTurn = discoveredSnapshotBefore.map(({ name }) => name);
    const activeBeforeTurn = state.tools
      .map((entry, slot) => ({ entry, name: names[slot]! }))
      .filter(({ entry }) => entry.active)
      .map(({ name }) => name);
    if (['native', 'append', 'filter', 'duplicate', 'opaque', 'forced'].includes(this.action)) {
      world.view = this.action === 'filter' && this.slot === 1 ? 'reorder'
        : this.action === 'append' && this.schema === 3 ? 'retained' : this.action as View;
    } else if (this.action === 'preset' || this.action === 'clear-preset') {
      state.preset = this.action === 'preset' ? `PBT_PRESET_${this.slot}_${this.schema}` : null;
      appendPresetState(world.api, {
        version: 1,
        snapshot: state.preset === null ? null : { name: 'generated', instructions: state.preset },
      });
    } else if (this.action === 'describe' || this.action === 'schema') {
      if (this.action === 'describe') tool.description = this.description;
      else tool.schema = this.schema;
      world.metadata[this.slot] = { description: tool.description, schema: tool.schema };
      world.register(this.slot);
    } else if (['enable', 'disable', 'reset'].includes(this.action)) {
      await world.session.prompt(`/capability ${this.action} ${names[this.slot]}`);
      tool.permission = this.action === 'reset' ? 'unmanaged' : this.action === 'enable' ? 'enabled' : 'disabled';
      if (this.action === 'enable') tool.active = true;
    } else if (this.action === 'compact') {
      await world.session.compact();
      state.pruned = [];
      for (const [slot, current] of state.tools.entries()) {
        const pruned = slot !== 0 && current.permission === 'unmanaged' && current.discovered && !current.used;
        if (current.permission === 'disabled' || pruned) current.active = false;
        if (pruned) { current.discovered = false; current.discoveredDescription = null; state.pruned.push(names[slot]!); }
        current.used = false;
      }
    } else if (this.action === 'reopen') {
      const file = world.session.sessionManager.getSessionFile();
      assert.ok(file);
      await world.session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
      await world.session.dispose();
      await world.open(SessionManager.open(file));
    } else if (this.action === 'execute') {
      world.response = { name: names[this.slot]!, slot: this.slot, schema: tool.schema };
    } else if (this.action === 'discover') {
      world.selection = this.slot;
      world.response = { name: 'capability', slot: this.slot, schema: 0 };
      if (tool.permission !== 'disabled') {
        tool.active = true;
        tool.discovered = true;
        tool.discoveredDescription = tool.description;
      }
    }

    const before = world.effects.length;
    const requestsBefore = world.requests.length;
    const syncCountBefore = world.session.sessionManager.getBranch().filter(
      entry => entry.type === 'custom_message' && entry.customType === HARNESS_CONTEXT_SYNC_CUSTOM_TYPE,
    ).length;
    await world.session.prompt(`Generated history turn ${++state.turn}`);
    assert.equal(world.effects.length - before,
      this.action === 'execute' && tool.active && tool.permission !== 'disabled' ? 1 : 0,
      'permission and active state decide whether the real SDK executes the backend');
    if (world.effects.length > before) {
      tool.used = true;
      assert.deepEqual(world.effects.at(-1), { slot: this.slot, schema: tool.schema,
        parameters: { [`revision_${tool.schema}`]: 'generated input' } });
    }

    assert.deepEqual(placementJournal(world), [], 'no placement journal entries are written to the branch');

    const turnRequests = world.requests.slice(requestsBefore);
    assert.ok(turnRequests.length >= 1, 'every turn issues at least one model request');
    for (const req of turnRequests) {
      assertBodyPreserved(req);
      assertNoDeveloperTail(req.messages, req.wire);
      if (world.view === 'forced') {
        assert.equal(req.messages[0]?.role, 'system');
        assert.equal(req.messages[0]?.content, 'PBT_FORCED_BASE');
        assert.equal(hasAnyHarnessSection(req.messages), false,
          'forced full system prompt wins and suppresses Harness request-local sections');
      } else {
        if (req.frame.hasHeadSystem) {
          const head = req.frame.head;
          const projectedHead = req.projected[0];
          assert.ok(head?.role === 'system' && projectedHead?.role === 'system',
            'the SDK-produced base head stays a system message');
          assert.equal(projectedHead.content, head.content);
          assert.deepEqual(projectedHead.sections, head.sections,
            'the SDK-produced base head sections stay intact');
        }
        const effective = effectiveSystemSections(req.messages);
        const expectedPreset = state.preset === null ? undefined : `<preset-instructions>\n${state.preset}\n</preset-instructions>`;
        assert.equal(effective['preset-instructions'], expectedPreset,
          'unforced requests keep current Preset instructions via SDK systemPromptOptions.sections');
        const notice = effective['capability-availability'];
        if (state.pruned.length === 0) {
          assert.equal(notice, undefined, 'no pruning notice when no capability was pruned at the current compaction');
        } else {
          assert.ok(typeof notice === 'string', 'a pruning notice is present in effective system sections');
          for (const name of state.pruned) {
            assert.ok(notice.includes(name), 'the model is told which unused capability was pruned');
          }
        }
        if (this.withStaticGuidance) {
          const rules = effective['rules'] ?? '';
          assert.equal(rules.split('SUBAGENT_STATIC_GUIDANCE').length - 1, 1,
            'static active-tool promptGuidelines is emitted once in SDK <rules>');
        }
      }
    }

    const syncCountAfter = world.session.sessionManager.getBranch().filter(
      entry => entry.type === 'custom_message' && entry.customType === HARNESS_CONTEXT_SYNC_CUSTOM_TYPE,
    ).length;
    const discoveredSnapshotAfter = state.tools
      .map((entry, slot) => ({ entry, name: names[slot]! }))
      .filter(({ entry }) => entry.discovered && entry.permission !== 'disabled')
      .map(({ entry, name }) => ({ name, description: entry.discoveredDescription }));
    const expectedAtTurnEnd = discoveredSnapshotAfter.map(({ name }) => name);
    const activeAfterTurn = state.tools
      .map((entry, slot) => ({ entry, name: names[slot]! }))
      .filter(({ entry }) => entry.active)
      .map(({ name }) => name);
    const expectedSyncRequired = this.action === 'discover' && (
      !isDeepStrictEqual(discoveredSnapshotAfter, discoveredSnapshotBefore)
      || !isDeepStrictEqual(activeAfterTurn, activeBeforeTurn)
    );
    assert.equal(
      syncCountAfter - syncCountBefore,
      expectedSyncRequired ? 1 : 0,
      expectedSyncRequired
        ? 'modeled mid-run discovery/activation change must persist exactly one harness-context-sync entry'
        : `action ${this.action} with no modeled mid-run change must not emit a harness-context-sync entry`,
    );

    if (this.action === 'execute' && tool.active && tool.permission !== 'disabled') {
      assert.ok(turnRequests.length >= 2, 'active permitted execution sends tool result back to the model');
      if (world.view === 'native' || world.view === 'filter' || world.view === 'reorder') {
        const followupWireTail = turnRequests[1]!.wire.at(-1) as { type?: unknown } | undefined;
        assert.equal(followupWireTail?.type, 'function_call_output',
          'an unchanged tool execution follow-up ends cleanly with function_call_output');
      }
    }

    const latest = world.requests.at(-1)!;
    if (world.view !== 'forced') {
      const firstOfTurn = turnRequests[0]!;
      const expectedAtTurnStart = this.action === 'discover' ? discoveredBeforeTurn : expectedAtTurnEnd;
      const startMemory = effectiveSystemSections(firstOfTurn.messages)['capabilities'];
      if (expectedAtTurnStart.length === 0) {
        assert.equal(startMemory, undefined,
          'turn start: no Capability memory when no discovered tool was allowed at turn start');
      } else {
        assert.ok(typeof startMemory === 'string' && startMemory.includes('<capabilities>'),
          'turn start: current Capability memory is present in system sections');
        for (const name of expectedAtTurnStart) {
          assert.ok(startMemory.includes(name), `turn start: Capability memory includes ${name}`);
        }
        for (const name of names) {
          if (!expectedAtTurnStart.includes(name)) {
            assert.equal(startMemory.includes(name), false, `turn start: Capability memory omits ${name}`);
          }
        }
      }
    }

    if (this.action === 'discover') {
      assert.ok(turnRequests.length >= 2, 'discovery calls capability and issues a follow-up request');
      if (expectedSyncRequired) {
        const syncEntry = world.session.sessionManager.getBranch().findLast(
          entry => entry.type === 'custom_message' && entry.customType === HARNESS_CONTEXT_SYNC_CUSTOM_TYPE,
        );
        const rawSyncText = syncEntry?.type === 'custom_message' && typeof syncEntry.content === 'string'
          ? syncEntry.content
          : '';
        const capabilityMatch = /<capabilities>\n[\s\S]*?\n<\/capabilities>/.exec(rawSyncText);
        const latestSyncText = capabilityMatch?.[0] ?? '';
        for (const name of expectedAtTurnEnd) {
          assert.ok(latestSyncText.includes(name), `mid-run sync: Capability memory includes ${name}`);
        }
        for (const name of names) {
          if (!expectedAtTurnEnd.includes(name)) {
            assert.equal(latestSyncText.includes(name), false, `mid-run sync: Capability memory omits ${name}`);
          }
        }
        if (world.view === 'native' || world.view === 'filter' || world.view === 'reorder') {
          const latestWireTail = latest.wire.at(-1) as { role?: unknown; content?: unknown } | undefined;
          assert.equal(latestWireTail?.role, 'user',
            'modeled mid-run discovery change ends the wire request on a persisted user sync message');
          const serializedTail = JSON.stringify(latestWireTail?.content ?? '');
          const wireCapabilities = /<capabilities>[\s\S]*?<\/capabilities>/.exec(serializedTail)?.[0] ?? '';
          assert.equal(wireCapabilities.length > 0, expectedAtTurnEnd.length > 0,
            'wire user sync has a capabilities section exactly when current members exist');
          for (const name of expectedAtTurnEnd) {
            assert.ok(wireCapabilities.includes(name), `wire current Capability memory includes ${name}`);
          }
          for (const name of names) {
            if (!expectedAtTurnEnd.includes(name)) {
              assert.equal(wireCapabilities.includes(name), false, `wire current Capability memory omits ${name}`);
            }
          }
          const wireAvailability = /<capability-availability>[\s\S]*?<\/capability-availability>/.exec(serializedTail)?.[0] ?? '';
          for (const name of state.pruned) {
            assert.ok(wireAvailability.includes(name), `wire availability notice retains removed capability ${name}`);
          }
        }
      } else if (world.view === 'native' || world.view === 'filter' || world.view === 'reorder') {
        const latestWireTail = latest.wire.at(-1) as { type?: unknown } | undefined;
        assert.equal(latestWireTail?.type, 'function_call_output',
          'modeled no-op mid-run discovery keeps the follow-up wire ending on function_call_output');
      }
    }

    const currentDeclarations = getCurrentTools(latest.messages);
    for (const slot of [0, 1]) {
      const expected = state.tools[slot]!;
      const name = names[slot]!;
      assert.equal(world.session.getActiveToolNames().includes(name), expected.active,
        `active state of ${name} after ${this.action}`);
      const visible = currentDeclarations.find(entry => entry.name === name);
      assert.equal(visible !== undefined, expected.active, 'only active tools have a current declaration');
      if (!expected.active || expected.permission === 'disabled') continue;
      const declared = declaredTools(latest.wire).filter(entry => entry.name === name).at(-1);
      assert.ok(declared);
      assert.deepEqual(declared.parameters, { type: 'object', properties: { [`revision_${expected.schema}`]: { type: 'string' } } });
      assert.equal(declared.description, expected.description,
        'the latest native declaration description matches the externally registered metadata');
      assert.deepEqual(allSectionValues(latest.messages, toolGuidanceSection(`tool-description:${name}`)), [],
        'no obsolete tool-description correction section is emitted');
    }
    assert.deepEqual(world.errors, []);
  }
  toString() {
    if (this.action === 'filter' && this.slot === 1) return 'reorder-users';
    if (this.action === 'append' && this.schema === 3) return 'append-retained';
    if (['compact', 'reopen', 'request', 'native', 'append', 'filter', 'duplicate', 'opaque', 'forced', 'clear-preset'].includes(this.action)) return this.action;
    if (this.action === 'preset') return `preset(${this.slot},${this.schema})`;
    const value = this.action === 'describe' ? `,${JSON.stringify(this.description)}` : this.action === 'schema' ? `,${this.schema}` : '';
    return `${this.action}(${names[this.slot]}${value})`;
  }
}

export async function runCapabilityHistoryModel() {
  const nativeCommands = fc.commands([
    fc.tuple(fc.constantFrom<Action>('describe', 'schema', 'enable', 'disable', 'reset', 'discover', 'execute', 'compact', 'reopen', 'request'),
      fc.integer({ min: 0, max: 1 }), fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 3 }))
      .map(args => new Command(...args, false)),
  ], commandOptions(24));
  const runHistory = async (history: Iterable<AsyncCommand<State, World>>, restoreNative = false) => {
    const world = await fixture(restoreNative);
    const state: State = { tools: world.metadata.map((spec, slot) => ({ ...spec, permission: 'unmanaged', active: slot === 0, discovered: false, discoveredDescription: null, used: false })), turn: 0, preset: null, pruned: [] };
    try {
      await new Command('request', 0, '', 0, restoreNative).run(state, world);
      await fc.asyncModelRun(() => ({ model: state, real: world }), history);
      if (restoreNative) {
        await new Command('native', 0, '', 0, true).run(state, world);
        await new Command('reopen', 0, '', 0, true).run(state, world);
      }
    } finally { await world.close(); }
  };
  const property = (histories: typeof nativeCommands, restoreNative = false) =>
    fc.asyncProperty(histories, history => runHistory(history, restoreNative));
  // A removed member remains in the availability notice, but not current memory.
  // CI replay: seed -1775607658, path 6:5:5:5:5:5:6:6:6:7:7:7, command path q:B.
  await runHistory([
    new Command('discover', 1, '', 0, false),
    new Command('compact', 0, '', 0, false),
    new Command('discover', 0, '', 0, false),
  ]);
  const profile = process.env.PI_CAPABILITY_HISTORY_PROFILE ?? (process.env.PI_PBT_PATH === undefined ? 'all' : 'native');
  if (profile !== 'views') {
    console.log('Capability history profile=native');
    await checkProperty(property(nativeCommands));
  }
  if (profile !== 'native') {
    const views = fc.commands([
      fc.tuple(fc.constantFrom<Action>('describe', 'schema', 'enable', 'disable', 'reset', 'discover', 'execute', 'compact', 'reopen', 'request',
        'native', 'append', 'filter', 'duplicate', 'opaque', 'forced', 'preset', 'clear-preset'),
        fc.integer({ min: 0, max: 1 }), fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 3 }))
        .map(args => new Command(...args, true)),
    ], commandOptions(24));
    console.log('Capability history profile=views');
    await checkProperty(property(views, true));
  }
}

await runCapabilityHistoryModel();
console.log('CAPABILITY_HISTORY_MODEL_OK');
