/**
 * Real-SDK offline acceptance for classified Hook rules across the turn boundary.
 *
 * Each scenario boots the actual Hook surface next to the Capability port through
 * the Pi SDK, with a temporary agent directory holding a non-empty
 * `classifier.models` config. Chat replies and `registry.classify` are scripted;
 * every classifier answer is held behind a Promise gate, so the test controls
 * exactly when an answer becomes available instead of relying on timing.
 *
 * The three boundaries:
 * - a held classifier answer for an `injectHint` rule is consumed only by a
 *   later executed outer tool result and must not start a turn of its own;
 * - a hint-only answer that arrives after `agent_settled` is cancelled, because
 *   the pending hint died with the turn;
 * - a branch-only `activate` answer has no hint to lose, so it survives
 *   settlement and commits against the branch without waking the session.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fauxProvider, InMemoryCredentialStore,
  type AssistantMessage, type Context,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type CustomMessageEntry,
} from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../../src/capability/extension.ts';
import { installHookSurface } from '../../src/hooks/extension.ts';
import { HOOK_HINT_MESSAGE, readHintReceipts } from '../../src/hooks/repeat.ts';
import { installHookStats } from '../../src/hooks/stats.ts';

const CLASSIFIER = { provider: 'openrouter', id: '~typesafe/jev-latest' } as const;

const HELD_QUESTION = 'Does the held result need a follow-up hint?';
const STALE_QUESTION = 'Does the cancelled result need a hint?';
const ACTIVATE_QUESTION = 'Should the branch activate the held tool?';
const HELD_HINT = 'HELD_PASSIVE_HINT';
const STALE_HINT = 'STALE_PASSIVE_HINT';

const PASSIVE_TURN = 'PASSIVE_TURN: run two outer probes.';
const REPEAT_TURN = 'REPEAT_TURN: probe again.';
const STALE_TURN = 'STALE_TURN: run one outer probe.';
const ACTIVATE_TURN = 'ACTIVATE_TURN: run one outer probe.';

const HELD_TOOL = 'held_tool';

const heldHooks = `
version = 1
[hooks.held-hint]
on = 'tool_result'
when = '''tool == 'hint_probe' && turn.toolCalls == 1'''
classify = { kind = 'bool', question = '${HELD_QUESTION}' }
actions = [{ type = 'injectHint', text = '${HELD_HINT}' }]
[hooks.held-hint.repeat]
maxTriggers = 1
`;

const staleHooks = `
version = 1
[hooks.stale-hint]
on = 'tool_result'
when = '''tool == 'stale_probe' && turn.toolCalls == 1'''
classify = { kind = 'bool', question = '${STALE_QUESTION}' }
actions = [{ type = 'injectHint', text = '${STALE_HINT}' }]
`;

const activateHooks = `
version = 1
[hooks.deferred-activate]
on = 'tool_result'
when = '''tool == 'activate_probe' && turn.toolCalls == 1'''
classify = { kind = 'bool', question = '${ACTIVATE_QUESTION}' }
actions = [{ type = 'activate', targets = ['${HELD_TOOL}'] }]
`;

interface ClassifierSubject {
  readonly trigger?: string;
  readonly tool?: string;
  readonly turn?: { readonly toolCalls?: number };
  readonly result?: { readonly isError?: boolean };
}

interface CapturedClassifier {
  readonly question: string;
  readonly subject: ClassifierSubject;
  readonly signal: AbortSignal | undefined;
}

interface CapturedRequest {
  readonly prompt: string;
  readonly text: string;
}

interface ScriptInput {
  readonly prompt: string;
  readonly step: number;
  /** Resolve one held classifier answer and let its continuations run. */
  readonly release: (question: string) => Promise<void>;
}

type ScriptReply =
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'text'; readonly text: string };

interface Fixture {
  readonly session: AgentSession;
  readonly requests: CapturedRequest[];
  readonly classifierCalls: CapturedClassifier[];
  readonly scriptErrors: unknown[];
  readonly errors: unknown[];
  readonly release: (question: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface FixtureOptions {
  readonly hooks: string;
  readonly questions: readonly string[];
  readonly script: (input: ScriptInput) => ScriptReply | Promise<ScriptReply>;
}

function usage(): AssistantMessage['usage'] {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** The turn prompt is the first user-role model message; hints follow it. */
function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]!;
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '').join('\n');
    if ([PASSIVE_TURN, REPEAT_TURN, STALE_TURN, ACTIVATE_TURN].includes(text)) return text;
  }
  throw new Error('the fixture request has no user message');
}

function flush(): Promise<void> {
  // A classifier answer is awaited through runClassifier into the Hook runtime;
  // one macrotask boundary runs those continuations before the next assertion.
  return new Promise<void>(resolve => setImmediate(resolve));
}

function hookHints(session: AgentSession): CustomMessageEntry[] {
  return session.sessionManager.getBranch().filter(
    (entry): entry is CustomMessageEntry =>
      entry.type === 'custom_message' && entry.customType === HOOK_HINT_MESSAGE,
  );
}

function assistantTexts(session: AgentSession): string[] {
  return session.sessionManager.getBranch().flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant'
    ? entry.message.content.flatMap(part => part.type === 'text' ? [part.text] : [])
    : []);
}

async function startFixture(options: FixtureOptions): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hooks-classifier-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  let session: AgentSession | undefined;
  const dispose = async (): Promise<void> => {
    try { await session?.dispose(); } finally {
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      await rm(cwd, { recursive: true, force: true });
    }
  };
  try {
    await mkdir(agentDir);
    await mkdir(path.join(cwd, '.pi'));
    // An empty classifier config drops classified rules before they run, so the
    // fixture must publish at least one catalog model even though the transport
    // below is scripted.
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      version: 1,
      classifier: { models: [CLASSIFIER] },
    }));
    await writeFile(path.join(agentDir, 'hooks.toml'), options.hooks);

    const faux = fauxProvider({ models: [{ id: 'hooks-classifier-fixture' }] });
    const model = faux.models[0]!;
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    assert.ok(runtime.getModelOfType('classifier', CLASSIFIER.provider, CLASSIFIER.id),
      'the fixture classifier ref must resolve in the offline catalog');

    const requests: CapturedRequest[] = [];
    const classifierCalls: CapturedClassifier[] = [];
    const scriptErrors: unknown[] = [];
    const gates = new Map<string, { readonly promise: Promise<void>; readonly release: () => void }>();
    for (const question of options.questions) {
      let releaseGate!: () => void;
      const promise = new Promise<void>(resolve => { releaseGate = resolve; });
      gates.set(question, { promise, release: releaseGate });
    }
    const release = async (question: string): Promise<void> => {
      const gate = gates.get(question);
      assert.ok(gate, `the fixture never asked: ${question}`);
      gate.release();
      await flush();
    };

    // The real `registry.classify` route stays in place: only the transport is
    // scripted, and every answer is held until the test releases its gate.
    runtime.classify = async (classifier, context, classifyOptions) => {
      const key = Object.keys(context.questions)[0];
      assert.equal(key, 'hook');
      const question = context.questions['hook'];
      assert.ok(question?.type === 'bool');
      const instructions = question.instructions;
      classifierCalls.push({
        question: instructions,
        subject: (context.state as { readonly subject?: ClassifierSubject }).subject ?? {},
        signal: classifyOptions?.signal,
      });
      const gate = gates.get(instructions);
      assert.ok(gate, `the classifier was asked an unexpected question: ${instructions}`);
      await gate.promise;
      return {
        api: classifier.api, provider: classifier.provider, model: classifier.id,
        answers: { hook: { type: 'bool' as const, probability: 0.9 } },
        usage: usage(), stopReason: 'stop' as const, timestamp: Date.now(),
      };
    };

    const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(), usage: usage(),
    });

    runtime.streamSimple = (_requestModel, context) => {
      const prompt = latestUserText(context);
      const step = requests.filter(request => request.prompt === prompt).length;
      requests.push({ prompt, text: JSON.stringify(context) });
      const stream = new AssistantMessageEventStream();
      void (async () => {
        try {
          const scripted = await options.script({ prompt, step, release });
          const message = scripted.type === 'tool'
            ? reply([{ type: 'toolCall', id: `${prompt.split(':')[0]}-${step}`, name: scripted.name, arguments: {} }], 'toolUse')
            : reply([{ type: 'text', text: scripted.text }], 'stop');
          stream.push({
            type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message,
          });
        } catch (error) {
          scriptErrors.push(error);
          stream.push({
            type: 'error', reason: 'error',
            error: { ...reply([], 'error'), errorMessage: error instanceof Error ? error.message : String(error) },
          });
        }
        stream.end();
      })();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } },
      { projectTrusted: true },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'hooks-classifier-fixture', factory(pi) {
        installHookSurface(pi, capabilityExtension(pi), installHookStats(pi));
        const probe = (name: string, label: string, defaultActive = true) => pi.registerTool({
          name, label, description: `Fixture probe ${name}`, defaultActive,
          parameters: { type: 'object', properties: {} } as never,
          async execute() { return { content: [{ type: 'text', text: `${name} recorded` }], details: {} }; },
        });
        probe('hint_probe', 'Held hint probe');
        probe('stale_probe', 'Stale hint probe');
        probe('activate_probe', 'Activation probe');
        probe(HELD_TOOL, 'Held activation target', false);
      } }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd, agentDir, model, modelRuntime: runtime, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => errors.push(error) });

    return {
      session, requests, classifierCalls, scriptErrors, errors, release, dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

test('a passive hint rides the next executed outer result and consumes repeat across runs', async () => {
  const fixture = await startFixture({
    hooks: heldHooks,
    questions: [HELD_QUESTION],
    script: async ({ prompt, step, release }) => {
      if (prompt === REPEAT_TURN) return step === 0 ? { type: 'tool', name: 'hint_probe' } : { type: 'text', text: 'repeat done' };
      if (prompt !== PASSIVE_TURN) throw new Error(`unexpected prompt: ${prompt}`);
      if (step === 0) return { type: 'tool', name: 'hint_probe' };
      if (step === 1) {
        // The answer is held until the run reaches its second outer tool call.
        await release(HELD_QUESTION);
        return { type: 'tool', name: 'hint_probe' };
      }
      return { type: 'text', text: 'passive done' };
    },
  });
  try {
    await fixture.session.prompt(PASSIVE_TURN);
    assert.deepEqual(fixture.scriptErrors, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 3, 'two outer tool results plus one continuation request');
    assert.ok(!fixture.requests[0]!.text.includes(HELD_HINT));
    assert.ok(!fixture.requests[1]!.text.includes(HELD_HINT),
      'the answer is not delivered at the result that started classification');
    assert.ok(fixture.requests[2]!.text.includes(HELD_HINT),
      'the pending hint is consumed by the subsequent executed outer result');

    const hints = hookHints(fixture.session);
    assert.equal(hints.length, 1);
    assert.equal(hints[0]!.content, HELD_HINT);
    assert.equal(hints[0]!.display, false);
    const receipts = readHintReceipts(hints[0]!.details);
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!.key, /^held-hint:/);

    const branch = fixture.session.sessionManager.getBranch();
    const hintIndex = branch.findIndex(entry =>
      entry.type === 'custom_message' && entry.customType === HOOK_HINT_MESSAGE);
    const doneIndex = branch.findIndex(entry => entry.type === 'message' && entry.message.role === 'assistant'
      && entry.message.content.some(part => part.type === 'text' && part.text === 'passive done'));
    assert.ok(hintIndex >= 0 && doneIndex > hintIndex,
      'the continuation that reads the hint is still the same run');

    assert.equal(fixture.classifierCalls.length, 1);
    const call = fixture.classifierCalls[0]!;
    assert.equal(call.question, HELD_QUESTION);
    assert.equal(call.subject.trigger, 'tool_result');
    assert.equal(call.subject.tool, 'hint_probe');
    assert.equal(call.subject.turn?.toolCalls, 1);
    assert.equal(call.subject.result?.isError, false);

    await flush();
    assert.equal(fixture.requests.length, 3, 'the passive hint does not start its own turn');
    assert.deepEqual(assistantTexts(fixture.session), ['passive done']);
    assert.equal(fixture.session.isIdle, true);

    await fixture.session.prompt(REPEAT_TURN);
    await flush();
    assert.equal(fixture.requests.length, 5);
    assert.equal(fixture.classifierCalls.length, 1, 'the persisted passive hint prevents a second classifier attempt');
    assert.equal(hookHints(fixture.session).length, 1);
    assert.deepEqual(fixture.scriptErrors, []);
    assert.deepEqual(fixture.errors, []);

    const command = fixture.session.extensionRunner.getCommand('hook-stats');
    assert.ok(command);
    const ctx = fixture.session.extensionRunner.createCommandContext();
    const lines: string[] = [];
    const beforeStats = fixture.session.sessionManager.getLeafId();
    await command.handler('', { ...ctx, ui: { ...ctx.ui, notify: text => lines.push(text) } });
    const [stats] = lines;
    assert.match(stats ?? '', /Classifier: calls=1/);
    assert.match(stats ?? '', /Tools other: calls=3/);
    assert.match(stats ?? '', /Hook held-hint: matched=2 committed=1 suppressed=1/);
    assert.doesNotMatch(stats ?? '', /HELD_PASSIVE_HINT|hint_probe|REPEAT_TURN|Does the held result/);
    assert.equal(fixture.session.sessionManager.getLeafId(), beforeStats);
    assert.equal(fixture.requests.length, 5);
  } finally {
    await fixture.dispose();
  }
});

test('a passive hint with no later outer result is dropped at settlement instead of waking the session', async () => {
  const fixture = await startFixture({
    hooks: heldHooks,
    questions: [HELD_QUESTION],
    script: async ({ prompt, step, release }) => {
      if (prompt !== PASSIVE_TURN) throw new Error(`unexpected prompt: ${prompt}`);
      if (step === 0) return { type: 'tool', name: 'hint_probe' };
      // The answer lands while the turn is alive, but this run executes no
      // further outer tool result to consume it.
      await release(HELD_QUESTION);
      return { type: 'text', text: 'single-result done' };
    },
  });
  try {
    await fixture.session.prompt(PASSIVE_TURN);
    await flush();
    assert.deepEqual(fixture.scriptErrors, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2, 'an unanswered hint must not add a request');
    assert.ok(!fixture.requests[1]!.text.includes(HELD_HINT));
    assert.equal(fixture.classifierCalls.length, 1);
    const call = fixture.classifierCalls[0]!;
    assert.equal(call.question, HELD_QUESTION);
    assert.equal(call.signal?.aborted, false,
      'this answer arrives during the turn, so the run itself is not aborted');
    assert.equal(hookHints(fixture.session).length, 0,
      'the pending hint dies with the turn instead of being flushed after settlement');
    assert.deepEqual(assistantTexts(fixture.session), ['single-result done']);
    assert.equal(fixture.session.isIdle, true);
  } finally {
    await fixture.dispose();
  }
});

test('a hint-only classifier answer that arrives after settlement is cancelled', async () => {
  const fixture = await startFixture({
    hooks: staleHooks,
    questions: [STALE_QUESTION],
    script: ({ prompt, step }) => {
      if (prompt !== STALE_TURN) throw new Error(`unexpected prompt: ${prompt}`);
      return step === 0
        ? { type: 'tool', name: 'stale_probe' }
        : { type: 'text', text: 'stale done' };
    },
  });
  try {
    await fixture.session.prompt(STALE_TURN);
    assert.deepEqual(fixture.scriptErrors, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.classifierCalls.length, 1);
    const call = fixture.classifierCalls[0]!;
    assert.equal(call.question, STALE_QUESTION);
    assert.equal(call.signal?.aborted, true,
      'settlement cancels the hint-only classifier before its answer can be committed');
    const entries = fixture.session.sessionManager.getBranch().length;

    await fixture.release(STALE_QUESTION);
    assert.equal(hookHints(fixture.session).length, 0, 'a late hint-only answer is not persisted');
    assert.equal(fixture.session.sessionManager.getBranch().length, entries,
      'a cancelled answer appends nothing to the branch');
    assert.equal(fixture.requests.length, 2, 'a cancelled hint-only answer does not wake the session');
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.session.isIdle, true);
  } finally {
    await fixture.dispose();
  }
});

test('a branch-only classifier answer activates after settlement without waking the run', async () => {
  const fixture = await startFixture({
    hooks: activateHooks,
    questions: [ACTIVATE_QUESTION],
    script: ({ prompt, step }) => {
      if (prompt !== ACTIVATE_TURN) throw new Error(`unexpected prompt: ${prompt}`);
      return step === 0
        ? { type: 'tool', name: 'activate_probe' }
        : { type: 'text', text: 'activate done' };
    },
  });
  try {
    assert.equal(fixture.session.getActiveToolNames().includes(HELD_TOOL), false);
    await fixture.session.prompt(ACTIVATE_TURN);
    assert.deepEqual(fixture.scriptErrors, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.classifierCalls.length, 1);
    const call = fixture.classifierCalls[0]!;
    assert.equal(call.question, ACTIVATE_QUESTION);
    assert.equal(call.signal?.aborted, false,
      'a branch-only classifier outlives the turn so its commit is not lost');
    assert.equal(fixture.session.getActiveToolNames().includes(HELD_TOOL), false);
    const entries = fixture.session.sessionManager.getBranch().length;

    await fixture.release(ACTIVATE_QUESTION);
    assert.equal(fixture.session.getActiveToolNames().includes(HELD_TOOL), true,
      'the post-settle answer activates its branch-scoped target');
    assert.ok(fixture.session.sessionManager.getBranch().length > entries,
      'the activation is recorded on the branch');
    assert.equal(hookHints(fixture.session).length, 0);
    assert.equal(fixture.requests.length, 2, 'a branch-only commit does not wake the session');
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.session.isIdle, true);
  } finally {
    await fixture.dispose();
  }
});
