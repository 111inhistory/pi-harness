import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc, { type AsyncCommand } from 'fast-check';
import { checkProperty, commandOptions } from './pbt.ts';
import { fauxProvider, InMemoryCredentialStore, getCurrentTools, type AssistantMessage, type Api, type Message, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../src/capability/extension.ts';
import { DEFAULT_HARNESS_CONFIG } from '../src/harness-config.ts';
import { serializedRequest, declaredTools } from './capability-model-wire.ts';

const names = ['history_alpha', 'history_beta'] as const;
type Spec = { description: string; schema: number };
type ToolState = Spec & { permission: 'enabled' | 'disabled' | 'unmanaged'; active: boolean; discovered: boolean; used: boolean };
interface State { tools: ToolState[]; turn: number }
interface Request { messages: readonly Message[]; wire: readonly unknown[] }
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
  open(manager: SessionManager): Promise<void>;
  register(slot: number): void;
  close(): Promise<void>;
}

async function fixture(): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-capability-history-'));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'history-model' }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = { ...faux.models[0]!, api: 'openai-responses', compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } };
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], defaultTools: ['read', 'capability', names[0]],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 } });
  let session!: AgentSession;
  let api!: ExtensionAPI;
  const world: World = {
    root, model, metadata: names.map(name => ({ description: `Description for ${name}`, schema: 0 })),
    effects: [], requests: [], errors: [], response: null, selection: 0,
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
          capabilityExtension(api, { config: DEFAULT_HARNESS_CONFIG });
          for (const slot of [0, 1]) world.register(slot);
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
        if (!retrieval) world.requests.push({ messages: context.messages, wire: await serializedRequest(model, context.messages) });
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

type Action = 'describe' | 'schema' | 'enable' | 'disable' | 'reset' | 'discover' | 'execute' | 'compact' | 'reopen' | 'request';
class Command implements AsyncCommand<State, World> {
  readonly action: Action;
  readonly slot: number;
  readonly description: string;
  readonly schema: number;
  constructor(action: Action, slot: number, description: string, schema: number) {
    this.action = action; this.slot = slot; this.description = description; this.schema = schema;
  }
  check() { return true; }
  async run(state: State, world: World) {
    const tool = state.tools[this.slot]!;
    const previous = world.requests.at(-1)?.wire;
    let checkpoint = false;
    if (this.action === 'describe' || this.action === 'schema') {
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
      for (const [slot, current] of state.tools.entries()) {
        const pruned = slot !== 0 && current.permission === 'unmanaged' && current.discovered && !current.used;
        if (current.permission === 'disabled' || pruned) current.active = false;
        if (pruned) current.discovered = false;
        current.used = false;
      }
      checkpoint = true;
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
    await world.session.prompt(`Generated history turn ${++state.turn}`);
    assert.equal(world.effects.length - before,
      this.action === 'execute' && tool.active && tool.permission !== 'disabled' ? 1 : 0,
      'permission and active state decide whether the real SDK executes the backend');
    if (world.effects.length > before) {
      tool.used = true;
      assert.deepEqual(world.effects.at(-1), { slot: this.slot, schema: tool.schema,
        parameters: { [`revision_${tool.schema}`]: 'generated input' } });
    }
    const latest = world.requests.at(-1)!;
    if (previous && !checkpoint) assert.deepEqual(latest.wire.slice(0, previous.length), previous,
      'an ordinary state change appends to the serialized model history');
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
      const revision = latest.messages.filter(message => message.role === 'system').flatMap(message => {
        const text = message.sections?.[`harness-guidance:tool-description:${name}`];
        return text === undefined ? [] : [text];
      }).at(-1);
      const description = typeof revision === 'string'
        ? revision.slice(`Updated description for tool ${name}:\n\n`.length) : declared.description;
      assert.equal(description, expected.description,
        'the latest effective description matches the externally registered metadata');
    }
    assert.deepEqual(world.errors, []);
  }
  toString() {
    if (['compact', 'reopen', 'request'].includes(this.action)) return this.action;
    const value = this.action === 'describe' ? `,${JSON.stringify(this.description)}` : this.action === 'schema' ? `,${this.schema}` : '';
    return `${this.action}(${names[this.slot]}${value})`;
  }
}

export async function runCapabilityHistoryModel() {
  const commands = fc.commands([
    fc.tuple(fc.constantFrom<Action>('describe', 'schema', 'enable', 'disable', 'reset', 'discover', 'execute', 'compact', 'reopen', 'request'),
      fc.integer({ min: 0, max: 1 }), fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 3 }))
      .map(args => new Command(...args)),
  ], commandOptions(24));
  await checkProperty(fc.asyncProperty(commands, async history => {
    const world = await fixture();
    const state: State = { tools: world.metadata.map((spec, slot) => ({ ...spec, permission: 'unmanaged', active: slot === 0, discovered: false, used: false })), turn: 0 };
    try {
      await new Command('request', 0, '', 0).run(state, world);
      await fc.asyncModelRun(() => ({ model: state, real: world }), history);
    } finally { await world.close(); }
  }));
}

await runCapabilityHistoryModel();
console.log('CAPABILITY_HISTORY_MODEL_OK');
