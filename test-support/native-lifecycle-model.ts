import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fc, { type AsyncCommand, type Scheduler } from 'fast-check';
import { checkProperty, commandOptions } from './pbt.ts';
import { AgentSession, type CustomEntry, type CustomMessageEntry, type SessionManager } from '@earendil-works/pi-coding-agent';
import type { JobRequest } from '../src/subagent/runtime.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createSdkFixture, type SdkFixture } from './subagent-sdk-fixture.ts';
import { waitFor } from './async.ts';
import { isStoppingRefusal } from '../test/typed/support/subagent-sdk-fixture.ts';
import type { FixtureActor, FixtureGate, FixtureHistoryPaths } from '../test/typed/support/subagent-sdk-fixture.ts';

type JobRecord = Pick<JobRequest, 'agentId' | 'jobId' | 'continuedFromJobId'>;
interface NoticeDetails { jobId: string; status: string; sourceId: string }

// These entries were just written by the real root in this private fixture.
function jobRecords(manager: SessionManager) {
  return manager.getBranch().filter((entry): entry is CustomEntry<JobRecord> & { data: JobRecord } =>
    entry.type === 'custom' && entry.customType === 'subagent-job');
}

type TerminalNotice = CustomMessageEntry<NoticeDetails> & { content: string; details: NoticeDetails };

function terminalNotices(manager: SessionManager, jobId: string) {
  return manager.getBranch().filter((entry): entry is TerminalNotice =>
    entry.type === 'custom_message' && entry.customType === 'agent-delivery')
    .filter(entry => entry.details.jobId === jobId);
}

type Phase = 'running' | 'stopping' | 'idle';
type Result = 'text' | 'empty' | 'thinking' | 'error';
type Action = 'write' | 'uncertain-write' | 'peer' | 'cancel' | 'finish' | 'finish-both' | 'reload';
interface ActorModel {
  phase: Phase;
  round: number;
  predecessor: string | null;
  history: FixtureHistoryPaths | null;
  inbox: { text: string; from: string }[];
}
interface Model { actors: ActorModel[]; serial: number }
interface Provider {
  round: number;
  calls: number;
  finish: boolean;
  result: Result;
  pending: { gate: FixtureGate; reply: AssistantMessage } | undefined;
  produced: Set<string>;
  context: string;
}
interface Real {
  fx: SdkFixture;
  scheduler: Scheduler;
  actors: FixtureActor[];
  providers: Provider[];
  artifacts: { path: string; body: string }[];
}
const task = (slot: number) => `TASK_SLOT_${slot}`;
const answer = (slot: number, round: number) => `RESULT_SLOT_${slot}_ROUND_${round}_END`;

function reply(real: Real, slot: number): AssistantMessage {
  const provider = real.providers[slot]!;
  if (provider.result === 'thinking') return real.fx.assistant([{ type: 'thinking', thinking: 'No final text' }]);
  if (provider.result === 'error') return real.fx.assistant([], 'error', 'Scripted provider failure');
  return real.fx.textAnswer(provider.result === 'empty' ? '' : answer(slot, provider.round));
}

function resume(actor: ActorModel, provider: Provider) {
  if (actor.phase !== 'idle') return;
  actor.predecessor = actor.history!.jobId;
  actor.round++;
  actor.inbox = [];
  provider.round = actor.round;
  provider.finish = false;
  provider.pending = undefined;
  provider.produced.clear();
  actor.phase = 'running';
}

async function terminal(model: Model, real: Real, slot: number, result: Result) {
  const expected = model.actors[slot]!;
  const cancelled = expected.phase === 'stopping';
  const provider = real.providers[slot]!;
  provider.result = result;
  provider.finish = true;
  if (provider.pending) {
    provider.pending.reply = reply(real, slot);
    provider.pending.gate.resolve();
  }
  const actor = await real.fx.stopped(real.actors[slot]!.id);
  await real.fx.session.waitForIdle();
  const history = actor.history;
  assert.ok(history?.result, 'a settled durable Job exposes its artifacts');
  const status = cancelled ? 'cancelled' : result === 'error' ? 'failed' : 'completed';
  const body = await fs.readFile(history.result, 'utf8');
  assert.ok(status === 'cancelled' ? body === '' || provider.produced.has(body) :
    body === (status === 'completed' && result === 'text' ? answer(slot, expected.round) : ''),
    'a Job result comes from its own provider responses');
  assert.match(await fs.readFile(history.summary, 'utf8'), new RegExp('`' + status + '`'));
  const notices = terminalNotices(real.fx.sessionManager, history.jobId);
  assert.equal(notices.length, 1, 'one terminal notification per Job');
  assert.equal(notices[0]!.details.status, status);
  const record = jobRecords(real.fx.sessionManager).find(entry => entry.data.jobId === history.jobId);
  assert.equal(record?.data.continuedFromJobId, expected.predecessor);
  const transcript = await real.fx.events(history.cleanJsonl);
  for (const input of expected.inbox) {
    const entries = transcript.filter(entry => entry.role === 'custom' && Array.isArray(entry.content) &&
      entry.content.some((block: { type?: string; text?: string }) => block.type === 'text' &&
        block.text === `[Message from ${input.from}]\n${input.text}`));
    if (status === 'completed') assert.equal(entries.length, 1, `input ${input.text} is consumed once`);
    else assert.ok(entries.length <= 1, 'interrupted delivery is never duplicated');
    if (status === 'completed') assert.ok(provider.context.includes(`[Message from ${input.from}]\n${input.text}`),
      'the native model request consumed the delivered message');
    if (entries.length) {
      const details = entries[0]!.details as { sourceId?: string } | undefined;
      assert.equal(details?.sourceId, input.from);
    }
  }
  for (const path of [history.summary, history.cleanJsonl, history.result]) {
    real.artifacts.push({ path, body: await fs.readFile(path, 'utf8') });
  }
  expected.phase = 'idle';
  expected.history = history;
}

/** Operations and observable outcomes define the model independently of production state. */
class Command implements AsyncCommand<Model, Real> {
  readonly action: Action;
  readonly slot: number;
  readonly result: Result;
  readonly payload: string;
  constructor(action: Action, slot = 0, result: Result = 'text', payload = '') {
    this.action = action; this.slot = slot; this.result = result; this.payload = payload;
  }
  check(model: Readonly<Model>) {
    const actor = model.actors[this.slot]!;
    if (this.action === 'reload') return model.actors.every(row => row.phase === 'idle');
    if (this.action === 'finish-both') return model.actors.every(row => row.phase !== 'idle');
    if (this.action === 'write') return true;
    if (this.action === 'peer') return actor.phase === 'running';
    if (this.action === 'cancel' || this.action === 'finish') return actor.phase !== 'idle';
    return actor.phase === 'running';
  }
  async run(model: Model, real: Real) {
    const fx = real.fx;
    const actor = model.actors[this.slot]!;
    const target = real.actors[this.slot]!;
    const provider = real.providers[this.slot]!;
    const marker = `|INPUT_${++model.serial}_END|${this.payload}`;
    if (this.action === 'reload') {
      await fx.session.reload();
      for (let slot = 0; slot < model.actors.length; slot++) {
        const restored = await fx.item(real.actors[slot]!.id);
        assert.equal(restored?.socket, real.actors[slot]!.socket);
        assert.deepEqual(restored?.history, model.actors[slot]!.history);
      }
    } else if (this.action === 'finish-both') {
      // The scheduler controls the provider-release boundaries. SDK/kernel work after release remains real.
      const completions = model.actors.map(async (_, slot) => {
        await real.scheduler.schedule(Promise.resolve(), `release actor ${slot}`);
        await terminal(model, real, slot, this.result);
      });
      await real.scheduler.waitFor(Promise.all(completions));
    } else if (this.action === 'finish') {
      await terminal(model, real, this.slot, this.result);
    } else if (this.action === 'cancel') {
      await fx.call('subagent_stop', { id: target.id });
      actor.phase = 'stopping';
    } else if (this.action === 'peer') {
      const receiver = 1 - this.slot;
      const before = provider.calls;
      const destination = model.actors[receiver]!;
      const refused = destination.phase === 'stopping';
      resume(destination, real.providers[receiver]!);
      const response = fx.toolAnswer('msg_write', { path: real.actors[receiver]!.socket, content: marker });
      response.content.unshift({ type: 'text', text: `Intermediate answer ${marker}` });
      provider.pending!.reply = response;
      provider.pending!.gate.resolve();
      await waitFor(() => provider.calls > before, { label: 'native peer tool completed and the sender resumed' });
      if (!refused) destination.inbox.push({ text: marker, from: target.id });
    } else {
      if (actor.phase === 'stopping') {
        await assert.rejects(fx.call('msg_write', { path: target.socket, content: marker }),
          error => isStoppingRefusal(target.id, error));
      } else {
        const restoring = actor.phase === 'idle';
        const before = provider.calls;
        resume(actor, provider);
        if (this.action === 'uncertain-write') {
          const original = AgentSession.prototype.sendCustomMessage;
          let enqueued = false;
          AgentSession.prototype.sendCustomMessage = async function (message, options) {
            await original.call(this, message, options);
            if (typeof message.content === 'string' && message.content.includes(marker)) {
              enqueued = true;
              throw new Error('SDK enqueued the message before failing');
            }
          };
          try { await assert.rejects(fx.call('msg_write', { path: target.socket, content: marker })); }
          finally { AgentSession.prototype.sendCustomMessage = original; }
          assert.ok(enqueued, 'the unknown-handoff fault occurs after actual SDK enqueue');
        } else await fx.call('msg_write', { path: target.socket, content: marker });
        actor.phase = 'running';
        actor.inbox.push({ text: marker, from: 'Main' });
        if (restoring) await waitFor(() => provider.calls > before, { label: 'continuation reached the native provider' });
      }
    }
    for (let slot = 0; slot < model.actors.length; slot++) {
      const view = await fx.item(real.actors[slot]!.id);
      assert.equal(view?.status, model.actors[slot]!.phase === 'idle' ? 'stopped' : model.actors[slot]!.phase);
      assert.equal(view?.socket, real.actors[slot]!.socket);
    }
  }
  toString() { return `${this.action}(${this.slot},${this.result},${JSON.stringify(this.payload)})`; }
}

async function sample(commands: Iterable<AsyncCommand<Model, Real>>, scheduler: Scheduler) {
  const fx = await createSdkFixture({ scenario: 'lifecycle-model', durable: true, systemPrompt: 'MODEL_PARENT_IDENTITY' });
  const model: Model = { actors: [], serial: 0 };
  const real: Real = { fx, scheduler, actors: [], providers: [], artifacts: [] };
  fx.controls.chat = async request => {
    const match = request.text.match(/\bTASK_SLOT_(\d+)\b/);
    assert.ok(match, 'the provider request belongs to a created actor');
    const slot = Number(match[1]);
    const provider = real.providers[slot]!;
    provider.calls++;
    provider.context = request.text;
    let message: AssistantMessage;
    if (provider.finish) message = reply(real, slot);
    else {
      const pending = { gate: fx.controlledGate(), reply: reply(real, slot) };
      provider.pending = pending;
      await pending.gate.promise;
      if (request.options.signal?.aborted) throw new Error('Scripted transport aborted');
      message = pending.reply;
    }
    provider.produced.add(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    return message;
  };
  let failed: unknown;
  try {
    fx.sessionManager.appendMessage({ role: 'user', content: 'CAPTURED_PARENT_MARKER', timestamp: Date.now() });
    for (const slot of [0, 1]) {
      real.providers.push({ round: 1, calls: 0, finish: false, result: 'text',
        pending: undefined, produced: new Set(), context: '' });
      real.actors.push(await fx.create(task(slot), { inheritContext: slot === 1 }));
      model.actors.push({ phase: 'running', round: 1, predecessor: null, history: null, inbox: [] });
      await waitFor(() => real.providers[slot]!.calls > 0, { label: 'new actor reached the native provider' });
    }
    fx.sessionManager.appendMessage({ role: 'user', content: 'LATER_PARENT_MUTATION', timestamp: Date.now() });
    await fc.asyncModelRun(() => ({ model, real }), commands);
    for (const slot of [0, 1]) if (model.actors[slot]!.phase !== 'idle') await new Command('finish', slot).run(model, real);
    for (const artifact of real.artifacts) assert.equal(await fs.readFile(artifact.path, 'utf8'), artifact.body,
      'later Jobs never rewrite earlier Job artifacts');
    for (const slot of [0, 1]) {
      const context = real.providers[slot]!.context;
      assert.equal(context.split(task(slot)).length - 1, 1, 'continuations preserve the original assignment once');
      assert.equal(context.includes('CAPTURED_PARENT_MARKER'), slot === 1);
      assert.equal(context.includes('LATER_PARENT_MUTATION'), false);
    }
  } catch (error) { failed = error; throw error; }
  finally {
    try {
      await fx.close();
      assert.deepEqual(fx.uiErrors, []);
    } catch (cleanup) {
      if (failed !== undefined) throw new AggregateError([failed, cleanup], 'Lifecycle history and cleanup both failed');
      throw cleanup;
    }
  }
}

export async function runLifecycleModel() {
  const commands = fc.commands([
    fc.tuple(fc.constantFrom<Action>('write', 'uncertain-write', 'peer', 'cancel', 'finish'),
      fc.integer({ min: 0, max: 1 }), fc.constantFrom<Result>('text', 'empty', 'thinking', 'error'),
      fc.array(fc.constantFrom('hello', '中文', '\n', '"', '$()', '🙂'), { maxLength: 6 }).map(parts => parts.join('')))
      .map(([action, slot, result, payload]) => new Command(action, slot, result, payload)),
    fc.constantFrom<Action>('reload', 'finish-both').map(action => new Command(action)),
  ], commandOptions(32));
  await checkProperty(fc.asyncProperty(commands, fc.scheduler(), sample));
}

await runLifecycleModel();
console.log('NATIVE_LIFECYCLE_MODEL_OK');
