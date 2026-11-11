import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import fc, { type AsyncCommand } from 'fast-check';
import { AgentSession, SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { RpcEventEnvelope } from '../src/harness-rpc/protocol.ts';
import { createSdkFixture, type SdkFixture } from './subagent-sdk-fixture.ts';
import { RpcModelClient } from './rpc-model-client.ts';
import { waitFor } from './async.ts';
import type { FixtureActor, FixtureGate } from '../test/typed/support/subagent-sdk-fixture.ts';

type Action = 'connect' | 'subscribe' | 'unsubscribe' | 'foreign-unsubscribe' | 'pulse' | 'finish' | 'cancel' | 'revive' | 'disconnect' | 'fin' | 'reload' | 'query';
type Outcome = 'text' | 'empty' | 'error';
interface Job { id: string; slot: number; round: number; status: string; outputs: string[]; result: string; inputs: string[] }
interface Subscription { client: number; id: string; job: number; start: number; active: boolean; terminal: string | null; frozen?: number }
interface Model { jobs: Job[]; current: number[]; connected: boolean[]; subscriptions: Subscription[]; serial: number }
interface Provider { pending?: { gate: FixtureGate; reply: AssistantMessage }; ending?: AssistantMessage; session?: AgentSession; context?: string }
interface Real { fx: SdkFixture; admin: RpcModelClient; clients: RpcModelClient[]; allClients: RpcModelClient[]; actors: FixtureActor[]; providers: Provider[]; address: string }
interface StreamReply { subscription: string; jobId: string; agentId: string; rootSessionId: string; live: boolean; boundary: { status: string; round: number; messages: unknown[]; partial: unknown } }
interface Payload { kind: string; jobId: string; agentId: string; rootSessionId: string; status?: string; event?: { type: string; message?: unknown; assistantMessageEvent?: { type: string; delta?: string; partial?: unknown } } }
interface History { available: boolean; status: string; entries: SessionEntry[]; bounds: { startEntryId: string | null; endEntryId: string | null } }
const task = (slot: number) => `RPC_SLOT_${slot}_END`;
const live = (job: Job) => job.status === 'running';
function assistantText(message: unknown): string | undefined {
  const value = message as { role?: string; content?: { type: string; text?: string }[] };
  if (value.role !== 'assistant' || !Array.isArray(value.content) || !value.content.some(block => block.type === 'text')) return undefined;
  return value.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}
const texts = (messages: unknown[]) => messages.flatMap(message => { const text = assistantText(message); return text === undefined ? [] : [text]; });
async function call<T>(client: RpcModelClient, method: string, params: unknown = {}): Promise<T> {
  const response = await client.request(method, params);
  assert.equal(response.ok, true, `${method}: ${JSON.stringify(response)}`);
  assert.ok(response.ok);
  return response.result as T;
}
function events(client: RpcModelClient, id: string): RpcEventEnvelope[] {
  return client.frames.flatMap(frame => 'event' in frame && frame.event.subscription === id ? [frame.event] : []);
}
async function connect(real: Real, slot: number) {
  const client = await RpcModelClient.connect(real.address);
  real.clients[slot] = client;
  real.allClients.push(client);
}
async function end(model: Model, real: Real, slot: number, outcome: Outcome | 'cancel') {
  const job = model.jobs[model.current[slot]!]!;
  const provider = real.providers[slot]!;
  const text = `RESULT_${slot}_${job.round}_${model.serial}`;
  if (outcome === 'cancel') await call(real.admin, 'subagent.stop', { id: real.actors[slot]!.id });
  else {
    const reply = outcome === 'error' ? real.fx.assistant([], 'error', 'Scripted provider failure') : real.fx.textAnswer(outcome === 'empty' ? '' : text);
    provider.ending = reply;
    provider.pending!.reply = reply;
    if (outcome !== 'error') job.outputs.push(outcome === 'empty' ? '' : text);
    provider.pending!.gate.resolve();
  }
  await real.fx.stopped(real.actors[slot]!.id);
  job.status = outcome === 'cancel' ? 'cancelled' : outcome === 'error' ? 'failed' : 'completed';
  job.result = outcome === 'text' ? text : '';
  for (const sub of model.subscriptions) if (sub.active && sub.job === model.current[slot]) sub.terminal = job.status;
  const result = await call<{ status: string; result: string }>(real.admin, 'jobs.result', { jobId: job.id });
  assert.equal(result.status, job.status);
  if (outcome !== 'cancel') assert.equal(result.result, job.result);
}
async function audit(model: Model, real: Real) {
  await Promise.all(real.clients.flatMap((client, slot) => model.connected[slot] ? [client.barrier()] : []));
  const listing = await call<{ jobs: { jobId: string; status: string }[] }>(real.admin, 'jobs.list');
  const tree = await call<{ children: { id: string; kind: string }[] }>(real.admin, 'agents.tree');
  assert.deepEqual(tree.children.map(actor => [actor.id, actor.kind]).sort(),
    real.actors.map((actor, slot) => [actor.id, slot === 1 ? 'inherited' : 'fresh']).sort(), 'RPC creation preserves the host-owned topology');
  assert.deepEqual(listing.jobs.map(job => [job.jobId, job.status]).sort(), model.jobs.map(job => [job.id, job.status]).sort());
  for (let slot = 0; slot < real.clients.length; slot++) {
    const seq = real.clients[slot]!.frames.flatMap(frame => 'event' in frame ? [frame.event.seq] : []);
    assert.deepEqual(seq, seq.map((_, index) => index + 1), 'event sequence is monotonic across subscriptions on one connection');
  }
  for (const sub of model.subscriptions) {
    const client = real.allClients[sub.client]!;
    const received = events(client, sub.id);
    if (!sub.active) { assert.equal(received.length, sub.frozen, 'retired observations receive no later events'); continue; }
    const job = model.jobs[sub.job]!;
    const messages: unknown[] = [];
    let deltas = '';
    const terminals: string[] = [];
    for (const frame of received) {
      const payload = frame.payload as Payload;
      assert.equal(payload.rootSessionId, real.fx.sessionManager.getSessionId());
      assert.equal(payload.jobId, job.id);
      assert.equal(payload.agentId, real.actors[job.slot]!.id);
      if (payload.kind === 'job') terminals.push(payload.status!);
      if (payload.event?.type === 'message_end') messages.push(payload.event.message);
      const delta = payload.event?.assistantMessageEvent;
      if (delta) {
        assert.equal('partial' in delta, false, 'wire deltas do not repeat the cumulative partial');
        if (delta.type === 'text_delta') deltas += delta.delta;
      }
    }
    assert.deepEqual(texts(messages), job.outputs.slice(sub.start), 'each subscription receives exactly its subsequent provider outputs');
    assert.equal(deltas, job.outputs.slice(sub.start).join(''), 'wire deltas reconstruct the generated text');
    assert.deepEqual(terminals, sub.terminal === null ? [] : [sub.terminal], 'terminal state is published once to each current observer');
  }
  for (const client of real.allClients) assert.deepEqual(client.errors, []);
}
async function query(model: Model, real: Real, index: number) {
  const job = model.jobs[index]!;
  const detail = await call<{ job: { status: string }; record: unknown }>(real.admin, 'jobs.get', { jobId: job.id });
  assert.equal(detail.job.status, job.status);
  assert.equal(detail.record === null, live(job));
  const result = await real.admin.request('jobs.result', { jobId: job.id });
  assert.equal(result.ok, !live(job));
  if (!result.ok) assert.equal(result.error.code, 'not_ready');
  const history = await call<History>(real.admin, 'history.read', { jobId: job.id });
  assert.equal(history.available, true);
  assert.equal(history.status, job.status);
  assert.deepEqual(texts(history.entries.flatMap(entry => entry.type === 'message' ? [entry.message] : [])), job.outputs);
  for (const marker of job.inputs) {
    const matches = history.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'agent-delivery'
      && entry.content === `[Message from Main]\n${marker}`);
    assert.ok(job.status === 'completed' ? matches.length === 1 : matches.length <= 1,
      'accepted RPC messages are consumed once; interrupted input cannot duplicate');
    if (job.status === 'completed') assert.ok(real.providers[job.slot]!.context!.includes(`[Message from Main]\n${marker}`),
      'the native model consumed the RPC-delivered input');
  }
  if (!live(job)) {
    const file = real.providers[job.slot]!.session!.sessionManager.getSessionFile();
    assert.ok(file);
    const branch = SessionManager.open(file).getBranch();
    const start = history.bounds.startEntryId === null ? -1 : branch.findIndex(entry => entry.id === history.bounds.startEntryId);
    const finish = branch.findIndex(entry => entry.id === history.bounds.endEntryId);
    assert.ok(finish >= 0);
    assert.deepEqual(history.entries, branch.slice(start + 1, finish + 1), 'history reads the recorded native interval');
  }
}
function retire(model: Model, real: Real, client: RpcModelClient) {
  for (const sub of model.subscriptions) if (real.allClients[sub.client] === client && sub.active) {
    sub.active = false;
    sub.frozen = events(client, sub.id).length;
  }
}
class Command implements AsyncCommand<Model, Real> {
  readonly action: Action; readonly slot: number; readonly client: number; readonly select: number; readonly outcome: Outcome; readonly text: string;
  constructor(action: Action, slot: number, client: number, select: number, outcome: Outcome, text: string) {
    this.action = action; this.slot = slot; this.client = client; this.select = select; this.outcome = outcome; this.text = text;
  }
  check(model: Readonly<Model>) {
    const job = model.jobs[model.current[this.slot]!]!;
    if (this.action === 'connect') return !model.connected[this.client];
    if (this.action === 'pulse' || this.action === 'finish' || this.action === 'cancel') return live(job);
    if (this.action === 'revive') return !live(job);
    if (this.action === 'reload') return model.jobs.every(row => !live(row));
    if (this.action === 'query') return true;
    return model.connected[this.client]!;
  }
  async run(model: Model, real: Real) {
    model.serial++;
    const job = model.jobs[model.current[this.slot]!]!;
    const client = real.clients[this.client]!;
    if (this.action === 'connect') { await connect(real, this.client); model.connected[this.client] = true; }
    else if (this.action === 'subscribe') {
      const target = model.jobs[this.select % model.jobs.length]!;
      const response = await call<StreamReply>(client, 'stream.subscribe', { jobId: target.id });
      assert.equal(response.jobId, target.id);
      assert.equal(response.agentId, real.actors[target.slot]!.id);
      assert.equal(response.rootSessionId, real.fx.sessionManager.getSessionId());
      assert.equal(response.live, live(target));
      assert.equal(response.boundary.status, target.status);
      assert.equal(response.boundary.round, target.round);
      assert.deepEqual(texts(response.boundary.messages), live(target) ? target.outputs : []);
      assert.equal(response.boundary.partial, null);
      model.subscriptions.push({ client: real.allClients.indexOf(client), id: response.subscription,
        job: model.jobs.indexOf(target), start: target.outputs.length, active: true, terminal: null });
    } else if (this.action === 'unsubscribe' || this.action === 'foreign-unsubscribe') {
      const candidates = model.subscriptions.filter(sub => this.action === 'foreign-unsubscribe' ? real.allClients[sub.client] !== client : real.allClients[sub.client] === client);
      const chosen = candidates[this.select % candidates.length];
      const id = chosen?.id ?? 'unknown-subscription';
      const removed = chosen !== undefined && real.allClients[chosen.client] === client && chosen.active;
      assert.deepEqual(await call(client, 'stream.unsubscribe', { subscription: id }), { removed });
      if (removed) { chosen!.active = false; chosen!.frozen = events(client, id).length; }
    } else if (this.action === 'disconnect' || this.action === 'fin') {
      await client.barrier();
      await client.close(this.action === 'fin');
      model.connected[this.client] = false;
      retire(model, real, client);
    } else if (this.action === 'pulse') {
      const provider = real.providers[this.slot]!;
      const before = provider.pending!;
      const marker = `INPUT_${model.serial}_END:${this.text}`;
      await call(real.admin, 'message.send', { path: real.actors[this.slot]!.socket, content: marker });
      job.inputs.push(marker);
      const text = `OUTPUT_${model.serial}_END:${this.text}`;
      before.reply = real.fx.textAnswer(text);
      job.outputs.push(text);
      before.gate.resolve();
      await waitFor(() => provider.pending && provider.pending !== before, { label: 'queued RPC input reaches the next native provider request' });
    } else if (this.action === 'finish' || this.action === 'cancel') await end(model, real, this.slot, this.action === 'cancel' ? 'cancel' : this.outcome);
    else if (this.action === 'revive') {
      const provider = real.providers[this.slot]!;
      delete provider.ending;
      const marker = `REVIVE_${model.serial}_END`;
      const receipt = await call<{ jobId: string }>(real.admin, 'message.send', { path: real.actors[this.slot]!.socket, content: marker });
      model.current[this.slot] = model.jobs.length;
      model.jobs.push({ id: receipt.jobId, slot: this.slot, round: job.round + 1, status: 'running', outputs: [], result: '', inputs: [marker] });
      await waitFor(() => provider.pending, { label: 'RPC message revives native actor' });
    } else if (this.action === 'reload') {
      await real.fx.session.reload();
      for (const observer of real.clients) { await observer.close(); retire(model, real, observer); }
      model.connected.fill(false);
      await real.admin.close();
      real.admin = await RpcModelClient.connect(real.address);
      real.allClients.push(real.admin);
    } else {
      await query(model, real, this.select % model.jobs.length);
      for (const method of ['jobs.get', 'jobs.result', 'history.read', 'stream.subscribe']) {
        const response = await real.admin.request(method, { jobId: 'sub_missing' });
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error.code, 'not_found');
      }
    }
    await audit(model, real);
  }
  toString() { return `${this.action}(${this.slot},client${this.client},${this.select},${this.outcome},${JSON.stringify(this.text)})`; }
}
async function sample(commands: Iterable<AsyncCommand<Model, Real>>) {
  const sessions = new Map<string, AgentSession>();
  const original = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = function (...args: Parameters<AgentSession['prompt']>) { sessions.set(this.sessionId, this); return original.apply(this, args); };
  let fx: SdkFixture | undefined;
  let real: Real | undefined;
  let failed: unknown;
  try {
    fx = await createSdkFixture({ scenario: 'rpc-observation-model', durable: true, mode: 'rpc' });
    const record = JSON.parse(await fs.readFile(path.join(fx.sessionSocketDir, 'harness-rpc.json'), 'utf8')) as { address: string; sessionId: string };
    assert.equal(record.sessionId, fx.sessionManager.getSessionId());
    const admin = await RpcModelClient.connect(record.address);
    real = { fx, admin, allClients: [admin], clients: [], actors: [], providers: [{}, {}], address: record.address };
    const current = real;
    fx.controls.chat = async request => {
      if (request.options.sessionId === fx!.session.sessionId) return fx!.textAnswer('Root received completion');
      const match = request.text.match(/\bRPC_SLOT_(\d+)_END\b/);
      assert.ok(match);
      const provider = current.providers[Number(match[1])]!;
      provider.session = sessions.get(request.options.sessionId!)!;
      provider.context = request.text;
      assert.ok(provider.session);
      if (provider.ending) return provider.ending;
      const pending = { gate: fx!.controlledGate(), reply: fx!.textAnswer('') };
      provider.pending = pending;
      try { await fx!.abortable(pending.gate, request.options.signal); }
      finally { if (provider.pending === pending) delete provider.pending; }
      return pending.reply;
    };
    const created = await call<{ items: FixtureActor[] }>(admin, 'subagent.create', { tasks: [0, 1].map(slot => ({ task: task(slot), inheritContext: slot === 1 })) });
    real.actors = created.items;
    assert.equal(real.actors.length, 2);
    await waitFor(() => current.providers.every(provider => provider.pending), { label: 'native RPC-created actors executing' });
    const model: Model = { jobs: created.items.map((actor, slot) => ({ id: actor.id, slot, round: 1, status: 'running', outputs: [], result: '', inputs: [] })),
      current: [0, 1], connected: [true, true, true], subscriptions: [], serial: 0 };
    for (const slot of [0, 1, 2]) await connect(real, slot);
    await fc.asyncModelRun(() => ({ model, real: current }), commands);
    for (const slot of [0, 1]) if (live(model.jobs[model.current[slot]!]!)) await end(model, real, slot, 'text');
    await audit(model, real);
    for (let index = 0; index < model.jobs.length; index++) await query(model, real, index);
  } catch (error) { failed = error; throw error; }
  finally {
    try {
      const cleanup: unknown[] = [];
      if (real) for (const client of real.allClients) {
        try { await client.close(false); assert.deepEqual(client.errors, []); } catch (error) { cleanup.push(error); }
      }
      if (fx) {
        try { await fx.close(); assert.deepEqual(fx.uiErrors, []); } catch (error) { cleanup.push(error); }
      }
      if (cleanup.length) throw new AggregateError(cleanup, 'RPC resources failed to release');
    } catch (cleanup) {
      if (failed !== undefined) throw new AggregateError([failed, cleanup], 'RPC history and cleanup both failed');
      throw cleanup;
    } finally { AgentSession.prototype.prompt = original; sessions.clear(); }
  }
}
const commands = fc.commands([fc.tuple(
  fc.constantFrom<Action>('connect', 'subscribe', 'unsubscribe', 'foreign-unsubscribe', 'pulse', 'finish', 'cancel', 'revive', 'disconnect', 'fin', 'reload', 'query'),
  fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 2 }), fc.nat({ max: 15 }),
  fc.constantFrom<Outcome>('text', 'empty', 'error'),
  fc.array(fc.constantFrom('hello', '中文', '\n', '"', '$()', '🙂'), { maxLength: 5 }).map(parts => parts.join('')),
).map(args => new Command(...args))], { maxCommands: 28,
  ...(process.env.PI_PBT_COMMAND_PATH === undefined ? {} : { replayPath: process.env.PI_PBT_COMMAND_PATH }) });
const report = await fc.check(fc.asyncProperty(commands, sample), {
  numRuns: Number(process.env.PI_PBT_RUNS ?? 50),
  ...(process.env.PI_PBT_SEED === undefined ? {} : { seed: Number(process.env.PI_PBT_SEED) }),
  ...(process.env.PI_PBT_PATH === undefined ? {} : { path: process.env.PI_PBT_PATH }),
});
console.log(`PBT seed=${report.seed} runs=${report.numRuns} shrinks=${report.numShrinks}`);
if (report.failed) throw new Error(await fc.asyncDefaultReportMessage(report), { cause: report.errorInstance });
console.log('RPC_OBSERVATION_MODEL_OK');
