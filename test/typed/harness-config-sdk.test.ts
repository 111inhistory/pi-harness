/**
 * Real-SDK offline acceptance for external Harness configuration.
 *
 * Every scenario boots the actual `subagentExtension` through the Pi SDK with a
 * temporary agent directory and a trusted `.pi` project directory. The JSON
 * files are the only configuration input: the test never imports the loader or
 * calls `harnessConfigFor`, so it exercises the consumer wiring rather than the
 * resolver in isolation. Providers and the routing classifier are scripted;
 * no network or provider credential is used.
 *
 * Scenario 1: maxDepth 3 reaches a real depth-3 leaf, the leaf loses creation
 * and stop tools while depth 1/2 keep them, a configured budget warning level
 * appears in a terminal Job event, and layered global/project prompt patches
 * reach the model-bound child input while the host identity remains intact.
 *
 * Scenario 2: rewriting the project file after the root has started must not
 * change the active child or the next child (root snapshot). The project's
 * non-default active-child cap is enforced, and an inherited child receives the
 * project-replaced inherited paragraph plus the once-appended common paragraph
 * without resurrecting the globally replaced text.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  fauxProvider, getCurrentTools, getSystemMessageText, InMemoryCredentialStore,
  type AssistantMessage, type Context, type ToolCall,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

import subagentExtension from '../../src/subagent/extension.ts';
import { promptString } from '../../src/prompt-text.ts';
import { deferred, waitFor } from '../../test-support/async.ts';

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

const DEFAULT_INHERITED = promptString('subagent-turns.json', 'inheritedContext');

const COMMON_GLOBAL = '[[CFG_GLOBAL_COMMON: report verified and unverified work.]]';
const COMMON_PROJECT = '[[CFG_PROJECT_COMMON: keep project-level reporting.]]';
const COMMON_REWRITTEN = '[[CFG_REWRITTEN_COMMON: must not reach an active root.]]';
const INHERITED_GLOBAL = '[[CFG_GLOBAL_INHERITED: global replacement.]]';
const INHERITED_PROJECT = '[[CFG_PROJECT_INHERITED: project replacement wins.]]';
const INHERITED_REWRITTEN = '[[CFG_REWRITTEN_INHERITED: must not reach an active root.]]';

const ROOT_TASK = 'ROOT_CONFIG_FIXTURE: sit idle while the host exercises the configured tool surface.';
const MAIN_ACK = 'MAIN_CONFIG_ACK: root fixture ready.';

const D1_TASK = 'CONFIG_DEPTH1_TASK: delegate one depth-2 child and relay its result.';
const D2_TASK = 'CONFIG_DEPTH2_TASK: delegate one depth-3 leaf and relay its result.';
const D3_TASK = 'CONFIG_DEPTH3_TASK: produce the leaf answer without delegating.';
const D3_RESULT = 'CONFIG_DEPTH3_RESULT: leaf answer.';
const D2_RESULT = 'CONFIG_DEPTH2_RESULT: depth-2 answer.';
const D1_RESULT = 'CONFIG_DEPTH1_RESULT: depth-1 answer.';

const HELD_A_TASK = 'CONFIG_HELD_A_TASK: hold the first root child open.';
const HELD_B_TASK = 'CONFIG_HELD_B_TASK: hold the inherited second child open.';
const HELD_C_TASK = 'CONFIG_HELD_C_TASK: complete beside the inherited child.';
const HELD_RESULT = 'CONFIG_HELD_RESULT: released child answer.';

const budgetProfile = (soft: number, hard: number): JsonRecord => ({
  modelCalls: { soft, hard },
  activeTimeMs: { soft: 60_000, hard: 120_000 },
  lifetimeMs: 3_600_000,
});

function harnessConfig(options: {
  maxDepth: number;
  maxActiveChildren: number;
  commonAppend: string;
  inheritedReplace: string;
  d1ModelCalls: { soft: number; hard: number };
}): JsonRecord {
  const depths: JsonRecord = {};
  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    depths[String(depth)] = depth === 1
      ? budgetProfile(options.d1ModelCalls.soft, options.d1ModelCalls.hard)
      : budgetProfile(2, 8);
  }
  return {
    subagent: {
      maxDepth: options.maxDepth,
      maxActiveChildren: options.maxActiveChildren,
      budgetsByDepth: depths,
      prompts: {
        common: { append: options.commonAppend },
        inherited: { replace: options.inheritedReplace },
      },
    },
  };
}

function usage(): AssistantMessage['usage'] {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type Role = 'Main' | 'd1' | 'd2' | 'd3' | 'heldA' | 'heldB' | 'heldC';

interface Scenario {
  readonly cwd: string;
  readonly session: AgentSession;
  readonly inputs: Map<Role, string[]>;
  readonly toolsSeen: Map<Role, string[][]>;
  readonly scriptErrors: unknown[];
  readonly execute: (name: string, params: JsonRecord) => Promise<{ details?: unknown }>;
  readonly branchEntries: () => JsonRecord[];
  readonly dispose: () => Promise<void>;
}

interface ReplyHelpers {
  readonly text: (text: string) => AssistantMessage;
  readonly tool: (name: string, args: ToolCall['arguments'], id: string) => AssistantMessage;
}

interface ScenarioOptions {
  readonly config: {
    readonly global: JsonRecord;
    readonly project: JsonRecord;
  };
  readonly respond: (
    role: Role,
    turn: number,
    text: string,
    reply: ReplyHelpers,
  ) => AssistantMessage | Promise<AssistantMessage>;
  readonly onRequest?: (role: Role, turn: number, text: string) => void | Promise<void>;
}

const modelText = (context: Context): string =>
  context.messages.map((message) => {
    if (message.role === 'system') return getSystemMessageText(message);
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }).join('\n');

async function startScenario(options: ScenarioOptions): Promise<Scenario> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'harness-config-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(cwd, '.pi'), { recursive: true });

  const globalPath = path.join(agentDir, 'harness.json');
  const projectPath = path.join(cwd, '.pi', 'harness.json');
  await writeFile(globalPath, JSON.stringify(options.config.global));
  await writeFile(projectPath, JSON.stringify(options.config.project));

  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const oldSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'harness-config-fixture', reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  assert.ok(faux.provider.id);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;

  await writeFile(path.join(agentDir, 'subagent-routing.json'), JSON.stringify({
    version: 3,
    classifier: { provider: 'openrouter', id: '~typesafe/jev-latest' },
    instructions: { role: 'Select the executor role.', model: 'Select the only configured model.' },
    roles: [{
      id: 'executor',
      instructions: 'Complete the delegated assignment.',
      candidates: { fixture: { model: { provider: faux.provider.id, id: model.id }, thinkingLevel: 'low' } },
    }],
  }));

  runtime.classify = async (classifier, context) => {
    const key = Object.keys(context.questions)[0];
    assert.ok(key, 'routing must ask a question');
    const question = context.questions[key];
    assert.ok(question?.type === 'choice', 'fixture routing asks a choice question');
    const selected = Object.keys(question.criteria)[0];
    assert.ok(selected, 'the fixture role/model has one criterion');
    const probabilities = Object.fromEntries(
      Object.keys(question.criteria).map((name) => [name, name === selected ? 1 : 0]),
    );
    return {
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { [key]: { type: 'choice' as const, choice: selected, probabilities, confidence: 1 } },
      usage: usage(), stopReason: 'stop' as const, timestamp: Date.now(),
    };
  };

  const sessionManager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  const rootSessionId = sessionManager.getSessionId();
  const inputs = new Map<Role, string[]>();
  const toolsSeen = new Map<Role, string[][]>();
  const scriptErrors: unknown[] = [];

  const remember = (role: Role, text: string, tools: readonly string[]): number => {
    const list = inputs.get(role) ?? [];
    list.push(text);
    inputs.set(role, list);
    const toolList = toolsSeen.get(role) ?? [];
    toolList.push([...tools]);
    toolsSeen.set(role, toolList);
    return list.length;
  };

  function roleOf(sessionId: string | undefined, text: string): Role {
    if (sessionId === rootSessionId) return 'Main';
    if (text.includes(D3_TASK)) return 'd3';
    if (text.includes(D2_TASK)) return 'd2';
    if (text.includes(D1_TASK)) return 'd1';
    if (text.includes(HELD_B_TASK)) return 'heldB';
    if (text.includes(HELD_C_TASK)) return 'heldC';
    if (text.includes(HELD_A_TASK)) return 'heldA';
    throw new Error(`Unrecognized scripted session ${String(sessionId)}`);
  }

  const response = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: Date.now(), usage: usage(),
  });
  const textAnswer = (text: string): AssistantMessage => response([{ type: 'text', text }], 'stop');
  const toolAnswer = (name: string, args: ToolCall['arguments'], id: string): AssistantMessage =>
    response([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');

  runtime.streamSimple = (requestModel, context, streamOptions) => {
    assert.equal(requestModel.id, model.id);
    const stream = new AssistantMessageEventStream();
    void (async () => {
      try {
        const text = modelText(context);
        const role = roleOf(streamOptions?.sessionId, text);
        const turn = remember(role, text, getCurrentTools(context.messages).map((tool) => tool.name));
        await options.onRequest?.(role, turn, text);
        const message = await options.respond(role, turn, text, { text: textAnswer, tool: toolAnswer });
        const reason = message.stopReason === 'toolUse' || message.stopReason === 'length' || message.stopReason === 'deferred'
          ? message.stopReason : 'stop';
        stream.push({ type: 'done', reason, message });
        stream.end();
      } catch (error) {
        scriptErrors.push(error);
        const failure: AssistantMessage = {
          ...response([], 'error'),
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        stream.push({ type: 'error', reason: 'error', error: failure });
        stream.end();
      }
    })();
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'harness-config-sdk', factory: subagentExtension }],
  });

  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, sessionManager,
      settingsManager, resourceLoader,
    });
    session = created.session;
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    session.setActiveToolsByName([
      ...session.getActiveToolNames(), 'subagent_create', 'subagent_list', 'subagent_stop',
    ]);

    let toolCall = 0;
    const execute = async (name: string, params: JsonRecord): Promise<{ details?: unknown }> => {
      const tool = session!.getToolDefinition(name);
      assert.ok(tool, `missing native tool ${name}`);
      return tool.execute(`harness-config-${++toolCall}`, params, undefined, undefined,
        session!.extensionRunner.createToolContext(`harness-config-${toolCall}`, undefined)) as Promise<{ details?: unknown }>;
    };
    const branchEntries = (): JsonRecord[] =>
      session!.sessionManager.getBranch().map((entry) => entry as unknown as JsonRecord);

    const scenario: Scenario = {
      cwd, session, inputs, toolsSeen, scriptErrors, execute, branchEntries,
      dispose: async () => {
        try {
          await session!.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        } finally {
          session!.dispose();
          if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
          else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
          if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
          else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
          await rm(cwd, { recursive: true, force: true });
        }
      },
    };

    // Start the root exactly as a user session would. The scripted Main reply
    // is only a readiness marker; all root creation below goes through the real
    // tool definition and extension runner context.
    await session.prompt(ROOT_TASK);
    await session.waitForIdle();
    assert.deepEqual(extensionErrors, []);
    return scenario;
  } catch (error) {
    if (session !== undefined) session.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

function jobEntries(branch: readonly JsonRecord[], customType: string): JsonRecord[] {
  return branch.filter((entry) => entry['type'] === 'custom' && entry['customType'] === customType)
    .map((entry) => asRecord(entry['data']))
    .filter((data): data is JsonRecord => data !== null);
}

function jobEnd(branch: readonly JsonRecord[], jobId: string): JsonRecord {
  const end = jobEntries(branch, 'subagent-job-end').find((data) => data['jobId'] === jobId);
  assert.ok(end, `missing terminal Job event for ${jobId}`);
  return end;
}

function jobRegistration(branch: readonly JsonRecord[], jobId: string): JsonRecord {
  const job = jobEntries(branch, 'subagent-job').find((data) => data['jobId'] === jobId);
  assert.ok(job, `missing Job registration for ${jobId}`);
  return job;
}

function assertPromptLayer(text: string, label: string): void {
  assert.ok(text.includes(COMMON_GLOBAL), `${label} must receive the global common guidance`);
  assert.ok(text.includes(COMMON_PROJECT), `${label} must receive the project common guidance`);
  assert.ok(text.indexOf(COMMON_GLOBAL) < text.indexOf(COMMON_PROJECT),
    `${label} applies global common guidance before the project layer`);
  assert.equal(countOf(text, COMMON_GLOBAL), 1, `${label} appends the common guidance once for this construction`);
  assert.equal(countOf(text, COMMON_PROJECT), 1, `${label} appends the project common guidance once`);
}

test('configured maxDepth 3 reaches a leaf with gated tools, configured Budget, and layered prompts', { timeout: 60000 }, async () => {
  const scenario = await startScenario({
    config: {
      global: harnessConfig({
        maxDepth: 3,
        maxActiveChildren: 4,
        commonAppend: COMMON_GLOBAL,
        inheritedReplace: INHERITED_GLOBAL,
        d1ModelCalls: { soft: 2, hard: 8 },
      }),
      project: {
        subagent: { prompts: { common: { append: COMMON_PROJECT } } },
      },
    },
    respond: (role, turn, text, reply) => {
      if (role === 'Main') return reply.text(MAIN_ACK);
      if (role === 'd3') return reply.text(D3_RESULT);
      if (role === 'd2') {
        if (text.includes(D3_RESULT)) return reply.text(D2_RESULT);
        if (turn === 1) {
          return reply.tool('subagent_create', {
            tasks: [{ name: 'DepthThree', task: D3_TASK }],
          }, `create-d3-${turn}`);
        }
        return reply.text('Depth-2 child dispatched its leaf and is waiting.');
      }
      if (text.includes(D2_RESULT)) return reply.text(D1_RESULT);
      if (turn === 1) {
        return reply.tool('subagent_create', {
          tasks: [{ name: 'DepthTwo', task: D2_TASK }],
        }, `create-d2-${turn}`);
      }
      return reply.text('Depth-1 child dispatched its child and is waiting.');
    },
  });

  try {
    const created = await scenario.execute('subagent_create', {
      tasks: [{ name: 'DepthOne', task: D1_TASK }],
    });
    const items = asRecord(created.details)?.['items'];
    assert.ok(Array.isArray(items), 'the real create tool returns its created agent items');
    const first = asRecord(items[0]);
    assert.equal(first?.['id'], 'sub_01');
    assert.equal(typeof first?.['socket'], 'string');

    // Depth 3 is only reachable when the configured maximum is actually used by
    // surface registration, the runner's exclusion set and the nested create
    // guard.
    const leafEnd = await waitFor(() => {
      const branch = scenario.branchEntries();
      return jobEntries(branch, 'subagent-job-end').find((data) => data['jobId'] === 'sub_01_01_01') ?? null;
    }, { label: 'the depth-3 leaf Job to complete', timeoutMs: 30000 });
    await scenario.session.waitForIdle();

    assert.equal(leafEnd['status'], 'completed');
    assert.equal(asRecord(leafEnd['budget'])?.['depth'], 3);
    assert.deepEqual(scenario.scriptErrors, []);

    // D3's own model request proves the leaf loadout: creation and stop are
    // gone, list and messaging remain.
    const leafTools = scenario.toolsSeen.get('d3')?.[0];
    assert.ok(leafTools, 'the depth-3 leaf made a scripted model request');
    assert.ok(leafTools.includes('subagent_list'), 'a leaf keeps subagent_list');
    assert.ok(leafTools.includes('msg_write'), 'a leaf keeps msg_write');
    assert.equal(leafTools.includes('subagent_create'), false, 'a leaf at maxDepth cannot create children');
    assert.equal(leafTools.includes('subagent_stop'), false, 'a leaf at maxDepth cannot stop peers');

    // Depth 2 still holds create and successfully used it, so maxDepth 3 is not
    // implemented by merely disabling creation one level early.
    const d2Tools = scenario.toolsSeen.get('d2')?.[0];
    assert.ok(d2Tools, 'the depth-2 child made a scripted model request');
    assert.ok(d2Tools.includes('subagent_create'), 'a depth-2 child below maxDepth 3 keeps creation');
    const d2LeafRegistration = jobRegistration(scenario.branchEntries(), 'sub_01_01_01');
    assert.equal(asRecord(d2LeafRegistration['actor'])?.['depth'], 3);

    // The configured soft model-call limit is observable in the terminal Job
    // event; the default depth-1 soft limit would leave the phase normal.
    const d1End = jobEnd(scenario.branchEntries(), 'sub_01');
    const d1Budget = asRecord(d1End['budget']);
    assert.ok(d1Budget, 'the terminal Job event carries its Budget snapshot');
    assert.equal(d1Budget['depth'], 1);
    assert.equal(d1Budget['phase'], 'warning', 'the configured soft limit is applied to the depth-1 Job');
    assert.ok((d1Budget['modelCalls'] as number) >= 2);
    assert.equal(asRecord(d1Budget['terminal'])?.['termination'], 'model_final');
    assert.equal(d1End['status'], 'completed');

    // Both config layers reach the actual model-bound child input, in layer
    // order; fixed host identity stays intact. Check markers and identity, not
    // legacy prompt prose.
    const d1Input = scenario.inputs.get('d1')?.[0];
    assert.ok(d1Input);
    assertPromptLayer(d1Input, 'the depth-1 child');
    assert.match(d1Input, /You are Subagent sub_01\b/);
    assert.match(d1Input, /Your direct parent is Main\b/);

    const d2Input = scenario.inputs.get('d2')?.[0];
    assert.ok(d2Input);
    assertPromptLayer(d2Input, 'the depth-2 child');
    assert.match(d2Input, /You are Subagent sub_01_01\b/);
    assert.match(d2Input, /Your direct parent is sub_01\b/);

    const d3Input = scenario.inputs.get('d3')?.[0];
    assert.ok(d3Input);
    assertPromptLayer(d3Input, 'the depth-3 leaf');
    assert.match(d3Input, /You are Subagent sub_01_01_01\b/);
    assert.match(d3Input, /Your direct parent is sub_01_01\b/);

    // A fresh child must not silently receive the inherited paragraph.
    assert.equal(d1Input.includes(INHERITED_PROJECT), false);
    assert.equal(d3Input.includes(DEFAULT_INHERITED), false);

    const result = await scenario.execute('subagent_list', { all: true });
    assert.ok(asRecord(result.details), 'the root can list the completed depth-3 tree');
    assert.deepEqual([...scenario.inputs.keys()].sort(), ['Main', 'd1', 'd2', 'd3']);
  } finally {
    await scenario.dispose();
  }
});

test('a root config snapshot survives project rewrites, governs child caps, and replaces inherited prompts', { timeout: 60000 }, async () => {
  const releaseChildren = deferred();

  const scenario = await startScenario({
    config: {
      global: harnessConfig({
        maxDepth: 3,
        maxActiveChildren: 5,
        commonAppend: COMMON_GLOBAL,
        inheritedReplace: INHERITED_GLOBAL,
        d1ModelCalls: { soft: 2, hard: 8 },
      }),
      project: {
        subagent: {
          maxActiveChildren: 2,
          prompts: {
            common: { append: COMMON_PROJECT },
            inherited: { replace: INHERITED_PROJECT },
          },
        },
      },
    },
    respond: async (role, turn, _text, reply) => {
      if (role === 'Main') return reply.text(MAIN_ACK);
      // The held children stay inside their first model request until the file
      // has been rewritten and both pools have been exercised.
      if ((role === 'heldA' || role === 'heldB' || role === 'heldC') && turn === 1) {
        await releaseChildren.promise;
        // One local tool round forces a second model request, so the active
        // child's prompt snapshot stays observable after the file rewrite.
        return reply.tool('subagent_list', { all: true }, `held-list-${role}`);
      }
      return reply.text(HELD_RESULT);
    },
  });

  try {
    const projectPath = path.join(scenario.cwd, '.pi', 'harness.json');

    const first = await scenario.execute('subagent_create', {
      tasks: [{ name: 'HeldFresh', task: HELD_A_TASK }],
    });
    const firstItems = asRecord(first.details)?.['items'];
    assert.ok(Array.isArray(firstItems));
    assert.equal(asRecord(firstItems[0])?.['id'], 'sub_01');

    // Wait until the first child is really inside its own model request before
    // rewriting the file: the root snapshot must already be resolved.
    await waitFor(() => scenario.inputs.get('heldA')?.length === 1, {
      label: 'the first child to reach its held model request', timeoutMs: 15000,
    });

    const rewritten = harnessConfig({
      maxDepth: 2,
      maxActiveChildren: 1,
      commonAppend: COMMON_REWRITTEN,
      inheritedReplace: INHERITED_REWRITTEN,
      d1ModelCalls: { soft: 2, hard: 8 },
    });
    await mkdir(path.dirname(projectPath), { recursive: true });
    await writeFile(projectPath, JSON.stringify(rewritten));

    // The next batch is admitted against the original root snapshot: the
    // rewritten fresh cap of one would refuse it, because heldA already holds
    // one of the two fresh slots.
    const second = await scenario.execute('subagent_create', {
      tasks: [
        { name: 'HeldInherited', task: HELD_B_TASK, inheritContext: true },
        { name: 'HeldAfterRewrite', task: HELD_C_TASK },
      ],
    });
    const secondItems = asRecord(second.details)?.['items'];
    assert.ok(Array.isArray(secondItems));
    assert.equal(asRecord(secondItems[0])?.['id'], 'sub_02');
    assert.equal(asRecord(secondItems[1])?.['id'], 'sub_03', 'the mixed batch is admitted under the root snapshot');
    await waitFor(() => scenario.inputs.get('heldC')?.length === 1, {
      label: 'the batch fresh child to reach its held model request', timeoutMs: 15000,
    });
    await waitFor(() => scenario.inputs.get('heldB')?.length === 1, {
      label: 'the inherited child to reach its held model request', timeoutMs: 15000,
    });

    const inheritedInput = scenario.inputs.get('heldB')?.[0];
    assert.ok(inheritedInput);
    assertPromptLayer(inheritedInput, 'the inherited child');
    assert.ok(inheritedInput.includes(INHERITED_PROJECT), 'the project replacement reaches the inherited child');
    assert.equal(inheritedInput.includes(INHERITED_GLOBAL), false,
      'a project replacement does not resurrect the globally replaced inherited paragraph');
    assert.equal(inheritedInput.includes(DEFAULT_INHERITED), false,
      'the replaced inherited paragraph replaces the built-in text');
    assert.equal(inheritedInput.includes(COMMON_REWRITTEN), false,
      'the rewritten file does not change prompts of children created inside the active root');
    assert.equal(inheritedInput.includes(INHERITED_REWRITTEN), false);
    assert.match(inheritedInput, /You are Subagent sub_02\b/);
    assert.match(inheritedInput, /Your direct parent is Main\b/);
    assert.ok(inheritedInput.includes(HELD_B_TASK), 'the inherited child receives its assigned task');

    // The configured fresh cap is two, not the built-in four, and both fresh
    // slots are held by heldA and the batch's fresh child. A third direct fresh
    // child must be refused without touching the running pair.
    await assert.rejects(
      scenario.execute('subagent_create', {
        tasks: [{ name: 'OverCap', task: 'CONFIG_OVER_CAP_TASK: must be refused.' }],
      }),
      (error: unknown) => {
        const record = asRecord(error);
        assert.equal(record?.['code'], 'child_limit_exceeded');
        const detail = asRecord(record?.['detail']);
        assert.equal(detail?.['kind'], 'fresh');
        assert.equal(detail?.['maxActiveChildren'], 2, 'the refusal reports the resolved configured cap');
        assert.equal(detail?.['activeChildren'], 2);
        return true;
      },
    );

    // Release the held children. Their second turn still observes the original
    // prompt snapshot, and the running first child is not mutated by the file.
    releaseChildren.resolve();
    await waitFor(() => scenario.inputs.get('heldA')?.length === 2
      && scenario.inputs.get('heldB')?.length === 2
      && scenario.inputs.get('heldC')?.length === 2, {
      label: 'the held children to finish their released turn', timeoutMs: 15000,
    });
    await waitFor(() => {
      const branch = scenario.branchEntries();
      return ['sub_01', 'sub_02', 'sub_03'].every((jobId) =>
        jobEntries(branch, 'subagent-job-end').some((data) => data['jobId'] === jobId));
    }, { label: 'the held child Jobs to terminate', timeoutMs: 15000 });
    await scenario.session.waitForIdle();
    assert.deepEqual(scenario.scriptErrors, []);

    const firstSecondTurn = scenario.inputs.get('heldA')?.[1];
    assert.ok(firstSecondTurn);
    assertPromptLayer(firstSecondTurn, 'the active first child after the file rewrite');
    assert.equal(firstSecondTurn.includes(COMMON_REWRITTEN), false,
      'rewriting the file does not mutate an active child snapshot');

    const secondSecondTurn = scenario.inputs.get('heldB')?.[1];
    assert.ok(secondSecondTurn);
    assert.equal(secondSecondTurn.includes(COMMON_REWRITTEN), false);
    assert.equal(secondSecondTurn.includes(INHERITED_REWRITTEN), false);

    const heldAEnd = jobEnd(scenario.branchEntries(), 'sub_01');
    const heldBEnd = jobEnd(scenario.branchEntries(), 'sub_02');
    assert.equal(heldAEnd['status'], 'completed');
    assert.equal(heldBEnd['status'], 'completed');
    assert.equal(asRecord(heldBEnd['budget'])?.['depth'], 1);
    assert.deepEqual(
      jobEntries(scenario.branchEntries(), 'subagent-job-end').map((data) => data['jobId']).sort(),
      ['sub_01', 'sub_02', 'sub_03'],
      'the rejected fourth child never allocates a Job',
    );
  } finally {
    releaseChildren.resolve();
    await scenario.dispose();
  }
});

test('registers /subagent and keeps argument errors service-free through the SDK command context', { timeout: 30000 }, async () => {
  const scenario = await startScenario({
    config: {
      global: harnessConfig({
        maxDepth: 2, maxActiveChildren: 4,
        commonAppend: 'Global guidance.', inheritedReplace: 'Inherited guidance.',
        d1ModelCalls: { soft: 2, hard: 8 },
      }),
      project: {},
    },
    respond: (_role, _turn, _text, reply) => reply.text('ack'),
  });
  try {
    const command = scenario.session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === 'subagent');
    assert.ok(command, 'the harness extension registers /subagent on the real SDK session');
    const notices: Array<{ text: string; type: string }> = [];
    const ctx = scenario.session.extensionRunner.createCommandContext();
    Object.defineProperty(ctx, 'ui', {
      value: { notify: (text: string, type: string = 'info') => { notices.push({ text, type }); } },
    });
    await command.handler('stop --bogus', ctx);
    assert.deepEqual(notices, [{ text: 'invalid_command_args: stop requires one actor id or --all.', type: 'error' }]);
  } finally {
    await scenario.dispose();
  }
});
