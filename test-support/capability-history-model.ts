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
import { appendPresetState } from '../src/preset/state.ts';
import { serializedRequest, declaredTools } from './capability-model-wire.ts';

const names = ['history_alpha', 'history_beta'] as const;
type Spec = { description: string; schema: number };
type ToolState = Spec & { permission: 'enabled' | 'disabled' | 'unmanaged'; active: boolean; discovered: boolean; used: boolean };
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
    || key.startsWith('harness-guidance:');
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
            // Real registration activates Harness's static declaration-anchored asset.
            api.registerTool({ name: 'subagent_create', label: 'Static guidance fixture',
              description: 'Fixture for static instruction placement.', defaultActive: true,
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

function assertTailPlacement(messages: readonly Message[]) {
  const lastNonSystem = messages.findLastIndex(message => message.role !== 'system');
  for (let index = 0; index <= lastNonSystem; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'system' || message.sections === undefined) continue;
    assert.equal(Object.keys(message.sections).some(isHarnessSectionKey), false,
      'Harness sections must not appear before or inside the conversation body');
  }
  for (let index = lastNonSystem + 1; index < messages.length; index += 1) {
    assert.equal(messages[index]!.role, 'system', 'tail snapshot messages stay after all conversation messages');
  }
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
        if (pruned) { current.discovered = false; state.pruned.push(names[slot]!); }
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
      if (tool.permission !== 'disabled') { tool.active = true; tool.discovered = true; }
    }

    const before = world.effects.length;
    const requestsBefore = world.requests.length;
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
        assertTailPlacement(req.messages);
        const presets = allSectionValues(req.messages, 'preset-instructions');
        assert.deepEqual(presets, state.preset === null ? [] : [state.preset],
          'unforced requests emit current Preset instructions once at the tail');
        const notices = allSectionValues(req.messages, 'capability-availability');
        if (state.pruned.length === 0) {
          assert.deepEqual(notices, [], 'no pruning notice when no capability was pruned at the current compaction');
        } else {
          assert.equal(notices.length, 1, 'exactly one current pruning notice is emitted per unforced request');
          for (const name of state.pruned) {
            assert.ok(typeof notices[0] === 'string' && notices[0].includes(name),
              'the model is told which unused capability was pruned');
          }
        }
        if (this.withStaticGuidance) {
          const staticGuidance = req.messages.flatMap(message =>
            message.role === 'system' && message.sections && Object.hasOwn(message.sections, 'harness-guidance:subagent')
              ? [message.sections['harness-guidance:subagent']] : []);
          assert.equal(staticGuidance.length, 1, 'static active-tool guidance is emitted once at the tail');
        }
      }
    }

    const latest = world.requests.at(-1)!;
    if (world.view !== 'forced') {
      const memories = allSectionValues(latest.messages, 'capabilities');
      const expectedInMemory = state.tools
        .map((entry, slot) => ({ entry, name: names[slot]! }))
        .filter(({ entry }) => entry.discovered && entry.permission !== 'disabled')
        .map(({ name }) => name);
      if (expectedInMemory.length === 0) {
        assert.deepEqual(memories, [], 'no Capability memory section when no discovered tool is currently allowed');
      } else {
        assert.equal(memories.length, 1, 'exactly one current Capability memory section is emitted at the tail');
        for (const name of expectedInMemory) {
          assert.ok(typeof memories[0] === 'string' && memories[0].includes(name),
            `current Capability memory includes ${name}`);
        }
        for (const [slot, entry] of state.tools.entries()) {
          if (!entry.discovered || entry.permission === 'disabled') {
            assert.equal(memories[0]!.includes(names[slot]!), false,
              `current Capability memory omits ${names[slot]}`);
          }
        }
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
      assert.deepEqual(allSectionValues(latest.messages, `harness-guidance:tool-description:${name}`), [],
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
  const property = (histories: typeof nativeCommands, restoreNative = false) => fc.asyncProperty(histories, async history => {
    const world = await fixture(restoreNative);
    const state: State = { tools: world.metadata.map((spec, slot) => ({ ...spec, permission: 'unmanaged', active: slot === 0, discovered: false, used: false })), turn: 0, preset: null, pruned: [] };
    try {
      await new Command('request', 0, '', 0, restoreNative).run(state, world);
      await fc.asyncModelRun(() => ({ model: state, real: world }), history);
      if (restoreNative) {
        await new Command('native', 0, '', 0, true).run(state, world);
        await new Command('reopen', 0, '', 0, true).run(state, world);
      }
    } finally { await world.close(); }
  });
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
