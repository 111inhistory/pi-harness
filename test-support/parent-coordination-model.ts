import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import fc, { type AsyncCommand, type Scheduler } from 'fast-check';
import { checkProperty, commandOptions } from './pbt.ts';
import { AgentSession, SessionManager, type CustomEntry, type CustomMessageEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getBroadcastSocketPath } from '../src/ipc/socket.ts';
import { createSdkFixture, type SdkFixture } from './subagent-sdk-fixture.ts';
import { waitFor } from './async.ts';
import { createdItemsFromMessage, type FixtureActor, type FixtureChat, type FixtureGate } from '../test/typed/support/subagent-sdk-fixture.ts';

type Action = 'spawn' | 'write' | 'upstream' | 'broadcast' | 'hold' | 'yield' | 'finish' | 'cancel' | 'finish-pair' | 'reload';
type Outcome = 'text' | 'empty' | 'error';
interface Input { marker: string; from: string; round: number; required: boolean }
interface NodeModel { parent: number | null; inherited: boolean; alive: boolean; busy: boolean; round: number; inbox: Input[] }
interface Model { nodes: NodeModel[]; serial: number }
interface Spawn { slots: number[]; callId: string }
interface NodeReal {
  actor?: FixtureActor;
  session?: AgentSession;
  initialIds: Set<string>;
  request?: FixtureChat;
  calls: number;
  next?: AssistantMessage;
  spawn?: Spawn;
  holdNext: boolean;
  pending?: { gate: FixtureGate; reply: AssistantMessage };
  ending?: AssistantMessage;
}
interface JobData { agentId: string; jobId: string; continuedFromJobId: string | null }
interface Delivery { source: string; sourceId: string; jobId?: string; status?: string }
interface Notice { sender: number; jobId: string; status: string; text?: string; consumed: boolean; pending: boolean; required: boolean }
interface Real { fx: SdkFixture; nodes: NodeReal[]; notices: Notice[]; scheduler: Scheduler }
const task = (slot: number) => `COORD_NODE_${slot}_END`;
const freshReal = (): NodeReal => ({ initialIds: new Set(), calls: 0, holdNext: false });
const children = (model: Model, parent: number | null) => model.nodes.flatMap((node, slot) => node.parent === parent ? [slot] : []);
const records = (real: Real, slot: number) => real.fx.sessionManager.getBranch()
  .filter((entry): entry is CustomEntry<JobData> & { data: JobData } => entry.type === 'custom' && entry.customType === 'subagent-job')
  .filter(entry => entry.data.agentId === real.nodes[slot]!.actor!.id);
function deliveries(manager: SessionManager) {
  return manager.getBranch().filter((entry): entry is CustomMessageEntry<Delivery> & { details: Delivery; content: string } =>
    entry.type === 'custom_message' && entry.customType === 'agent-delivery');
}
function stored(node: NodeReal) {
  const file = node.session!.sessionManager.getSessionFile();
  assert.ok(file, 'each actor has a real durable native session');
  return SessionManager.open(file);
}
function revive(model: Model, real: Real, slot: number) {
  const node = model.nodes[slot]!;
  if (!node.alive) {
    node.alive = true; node.round++; node.busy = node.parent !== null;
    delete real.nodes[slot]!.ending;
  }
}
function input(model: Model, real: Real, slot: number, marker: string, from: string) {
  revive(model, real, slot);
  model.nodes[slot]!.inbox.push({ marker, from, round: model.nodes[slot]!.round, required: true });
}
function prepareSpawn(model: Model, real: Real, slot: number, count: number, inherited: boolean) {
  const slots: number[] = [];
  for (let index = 0; index < count; index++) {
    slots.push(model.nodes.length);
    model.nodes.push({ parent: slot, inherited, alive: true, busy: true, round: 1, inbox: [] });
    real.nodes.push(freshReal());
  }
  const callId = `spawn-${++model.serial}`;
  real.nodes[slot]!.spawn = { slots, callId };
  real.nodes[slot]!.next = real.fx.toolAnswer('subagent_create', {
    tasks: slots.map(child => ({ task: task(child), inheritContext: inherited })),
  }, callId);
}
async function ready(real: Real, slots: number[]) {
  await waitFor(() => slots.every(slot => real.nodes[slot]!.actor && real.nodes[slot]!.session), { label: 'native actors registered and executing' });
}
async function idle(real: Real, slot: number) {
  await real.nodes[slot]!.session!.waitForIdle();
  // Let the runner observe the completed SDK turn before reading published state.
  await turn();
}
async function terminal(model: Model, real: Real, slot: number, status: string, text?: string) {
  const view = await real.fx.stopped(real.nodes[slot]!.actor!.id);
  const job = records(real, slot).at(-1)!.data;
  assert.equal(view.history?.jobId, job.jobId, 'the settled view belongs to the current Job');
  assert.ok(view.history);
  assert.match(await fs.readFile(view.history.summary, 'utf8'), new RegExp('`' + status + '`'));
  const parent = model.nodes[slot]!.parent;
  real.notices.push({ sender: slot, jobId: job.jobId, status,
    pending: parent !== null && model.nodes[parent]!.busy, required: true,
    consumed: parent !== null && model.nodes[parent]!.alive, ...(text === undefined ? {} : { text }) });
  model.nodes[slot]!.alive = false;
  model.nodes[slot]!.busy = false;
}
async function settleParents(model: Model, real: Real) {
  for (const slot of children(model, null)) {
    const parent = model.nodes[slot]!;
    if (!parent.alive || parent.busy) continue;
    await idle(real, slot);
    if (children(model, slot).every(child => !model.nodes[child]!.alive)) await terminal(model, real, slot, 'completed');
  }
  for (const notice of real.notices) {
    const parent = model.nodes[notice.sender]!.parent;
    if (parent !== null && !model.nodes[parent]!.busy) notice.pending = false;
  }
}
async function wake(model: Model, real: Real, slot: number, marker: string) {
  input(model, real, slot, marker, 'Main');
  await real.fx.call('msg_write', { path: real.nodes[slot]!.actor!.socket, content: marker });
}
async function finish(model: Model, real: Real, slot: number, outcome: Outcome) {
  const node = real.nodes[slot]!;
  const pending = node.pending!;
  const text = `RESULT_${slot}_ROUND_${model.nodes[slot]!.round}`;
  pending.reply = outcome === 'error' ? real.fx.assistant([], 'error', 'Scripted provider failure') : real.fx.textAnswer(outcome === 'empty' ? '' : text);
  node.ending = pending.reply;
  if (outcome === 'error') for (const delivery of model.nodes[slot]!.inbox) {
    if (delivery.round === model.nodes[slot]!.round) delivery.required = false;
  }
  pending.gate.resolve();
  await terminal(model, real, slot, outcome === 'error' ? 'failed' : 'completed', outcome === 'text' ? text : undefined);
  const history = (await real.fx.item(node.actor!.id))!.history!;
  assert.ok(history.result);
  assert.equal(await fs.readFile(history.result, 'utf8'), outcome === 'text' ? text : '');
}
async function audit(model: Model, real: Real) {
  interface Tree { id: string; status?: string; kind?: string; children?: Tree[] }
  const root = (await real.fx.call('subagent_list', { all: true })).details as unknown as Tree;
  const topology = new Map<string, { parent: string | null; view: Tree }>();
  function visit(view: Tree, parent: string | null) {
    if (view.id !== 'Main') topology.set(view.id, { parent, view });
    for (const child of view.children ?? []) visit(child, view.id === 'Main' ? null : view.id);
  }
  visit(root, null);
  assert.equal(topology.size, model.nodes.length);
  for (let slot = 0; slot < model.nodes.length; slot++) {
    const expected = model.nodes[slot]!;
    const actual = topology.get(real.nodes[slot]!.actor!.id)!;
    assert.equal(actual.parent, expected.parent === null ? null : real.nodes[expected.parent]!.actor!.id);
    assert.equal(actual.view.status, expected.alive ? 'running' : 'stopped', `published state of node ${slot}`);
    assert.equal(actual.view.kind, expected.inherited ? 'inherited' : 'fresh');
    const active = real.nodes[slot]!.session!.getActiveToolNames();
    // These are policy expectations, independent of the production scope filter:
    // child communication is depth-owned, while a Main-only read grant is not.
    assert.ok(active.includes('msg_write'),
      `Main enable cannot revoke independent child messaging (node ${slot}, ${actual.view.kind}; active: ${active.join(', ')})`);
    assert.equal(active.includes('read'), false, 'ordinary Main enables remain root-only');
    if (expected.parent !== null) {
      for (const name of ['subagent_create', 'subagent_stop', 'capability']) {
        assert.equal(active.includes(name), false, `leaf authority excludes ${name}`);
      }
    }
    const jobs = records(real, slot);
    assert.equal(jobs.length, expected.round, 'child activity never silently creates parent Jobs');
    for (let index = 0; index < jobs.length; index++) assert.equal(jobs[index]!.data.continuedFromJobId, index === 0 ? null : jobs[index - 1]!.data.jobId);
  }
}

class Command implements AsyncCommand<Model, Real> {
  readonly action: Action;
  readonly slot: number;
  readonly count: number;
  readonly inherited: boolean;
  readonly outcome: Outcome;
  readonly payload: string;
  constructor(action: Action, slot: number, count: number, inherited: boolean, outcome: Outcome, payload: string) {
    this.action = action; this.slot = slot; this.count = count;
    this.inherited = inherited; this.outcome = outcome; this.payload = payload;
  }
  check(model: Readonly<Model>) {
    const node = model.nodes[this.slot];
    if (this.action === 'reload') return model.nodes.every(row => !row.alive);
    if (this.action === 'finish-pair') return model.nodes.filter(row => row.parent !== null && row.alive).length >= 2;
    if (this.action === 'broadcast' && this.slot === -1) return true;
    if (!node) return false;
    if (this.action === 'spawn') return node.parent === null && !node.busy && !(node.inherited && this.inherited)
      && children(model, this.slot).length + this.count <= 3;
    if (this.action === 'hold') return node.parent === null && !node.busy;
    if (this.action === 'yield') return node.parent === null && node.busy;
    if (this.action === 'broadcast') return node.parent === null && !node.busy;
    if (this.action === 'upstream' || this.action === 'finish') return node.parent !== null && node.alive;
    if (this.action === 'cancel') return node.alive;
    return true;
  }
  async run(model: Model, real: Real) {
    const marker = `MSG_${++model.serial}_END:${this.payload}`;
    const node = model.nodes[this.slot];
    const actual = real.nodes[this.slot];
    if (this.action === 'spawn') {
      prepareSpawn(model, real, this.slot, this.count, this.inherited);
      await wake(model, real, this.slot, marker);
      await waitFor(() => !actual!.spawn, { label: 'parent consumed native create result' });
      await ready(real, children(model, this.slot));
    } else if (this.action === 'hold') {
      actual!.holdNext = true;
      await wake(model, real, this.slot, marker);
      node!.busy = true;
      await waitFor(() => actual!.pending, { label: 'parent provider held' });
    } else if (this.action === 'yield') {
      actual!.pending!.gate.resolve();
      node!.busy = false;
      await idle(real, this.slot);
    } else if (this.action === 'write') {
      await wake(model, real, this.slot, marker);
      if (node!.parent !== null) await waitFor(() => actual!.pending, { label: 'leaf receives continuation' });
    } else if (this.action === 'upstream') {
      const parent = node!.parent!;
      input(model, real, parent, marker, actual!.actor!.id);
      const before = actual!.pending!;
      before.reply = real.fx.toolAnswer('msg_write', { path: real.nodes[parent]!.actor!.socket, content: marker }, `write-${model.serial}`);
      before.gate.resolve();
      await waitFor(() => actual!.pending && actual!.pending !== before, { label: 'leaf resumed after native parent write' });
    } else if (this.action === 'broadcast') {
      const parent = this.slot === -1 ? null : this.slot;
      const recipients = children(model, parent);
      const sender = parent === null ? 'Main' : actual!.actor!.id;
      for (const child of recipients) input(model, real, child, marker, sender);
      const path = getBroadcastSocketPath(sender, real.fx.sessionSocketDir);
      if (parent === null) await real.fx.call('msg_write', { path, content: marker });
      else {
        const callId = `broadcast-${model.serial}`;
        actual!.next = real.fx.toolAnswer('msg_write', { path, content: marker }, callId);
        await wake(model, real, parent, `WAKE_${model.serial}_END`);
        await waitFor(() => actual!.request?.context.messages.some(message => message.role === 'toolResult' && message.toolCallId === callId), { label: 'native broadcast executed' });
      }
      for (const child of recipients) if (model.nodes[child]!.parent !== null) await waitFor(() => real.nodes[child]!.pending, { label: 'broadcast child running' });
    } else if (this.action === 'cancel') {
      for (const delivery of node!.inbox) if (delivery.round === node!.round) delivery.required = false;
      // A held provider has not consumed its queued steer notices. Cancellation
      // may discard them; already drained notices remain required exactly once.
      for (const notice of real.notices) if (notice.pending && model.nodes[notice.sender]!.parent === this.slot) {
        notice.required = false; notice.consumed = false; notice.pending = false;
      }
      await real.fx.call('subagent_stop', { id: actual!.actor!.id });
      await terminal(model, real, this.slot, 'cancelled');
    } else if (this.action === 'finish') await finish(model, real, this.slot, this.outcome);
    else if (this.action === 'finish-pair') {
      const slots = model.nodes.flatMap((row, slot) => row.parent !== null && row.alive ? [slot] : []).slice(0, 2);
      const runs = slots.map(async slot => {
        await real.scheduler.schedule(Promise.resolve(), `release leaf ${slot}`);
        await finish(model, real, slot, this.outcome);
      });
      await real.scheduler.waitFor(Promise.all(runs));
    } else await real.fx.session.reload();
    await settleParents(model, real);
    await audit(model, real);
  }
  toString() { return `${this.action}(${this.slot},${this.count},${this.inherited},${this.outcome},${JSON.stringify(this.payload)})`; }
}

async function sample(initial: number[], commands: Iterable<AsyncCommand<Model, Real>>, scheduler: Scheduler) {
  const sessions = new Map<string, AgentSession>();
  const original = AgentSession.prototype.prompt;
  // Observe public SDK completion and durable files; no runtime decisions are replaced.
  AgentSession.prototype.prompt = function (...args: Parameters<AgentSession['prompt']>) {
    sessions.set(this.sessionId, this);
    return original.apply(this, args);
  };
  let fx: SdkFixture | undefined;
  let failed: unknown;
  try {
    fx = await createSdkFixture({ scenario: 'parent-coordination-model', durable: true,
      config: { subagent: { maxDepth: 2 } } });
    // Reproduce the root enable before any Fresh or Inherited child is created.
    // Exercise the real branch reader and SDK loadouts, not a modeled scope helper.
    fx.sessionManager.appendCustomEntry('capability-tool-permission', {
      version: 1,
      set: [{ target: 'msg_write', state: 'enabled' }, { target: 'read', state: 'enabled' }],
    });
    fx.session.setActiveToolsByName([...new Set([...fx.session.getActiveToolNames(), 'msg_write', 'read'])]);
    const real: Real = { fx, nodes: [freshReal(), freshReal()], notices: [], scheduler };
    const model: Model = { nodes: [false, true].map(inherited => ({ parent: null, inherited, alive: true, busy: false, round: 1, inbox: [] })), serial: 0 };
    const owners = new Map<string, number>();
    fx.controls.chat = async request => {
      if (request.options.sessionId === fx!.session.sessionId) return fx!.textAnswer('Root acknowledged');
      const sessionId = request.options.sessionId!;
      let slot = owners.get(sessionId);
      if (slot === undefined) {
        const match = [...request.text.matchAll(/\bCOORD_NODE_(\d+)_END\b/g)].at(-1);
        assert.ok(match, 'a new native request has its own assignment');
        slot = Number(match[1]);
        owners.set(sessionId, slot);
        const node = real.nodes[slot]!;
        node.session = sessions.get(sessionId)!;
        assert.ok(node.session, 'the real public SDK prompt owns this provider request');
        node.initialIds = new Set(node.session.sessionManager.getBranch().map(entry => entry.id));
      }
      const node = real.nodes[slot]!;
      node.session = sessions.get(sessionId)!;
      node.request = request;
      node.calls++;
      if (node.spawn) {
        const result = request.context.messages.find(message => message.role === 'toolResult' && message.toolCallId === node.spawn!.callId);
        if (result?.role === 'toolResult') {
          assert.equal(result.isError, false, 'generated admissible child creation succeeds');
          const actors = createdItemsFromMessage(result);
          assert.equal(actors.length, node.spawn.slots.length);
          node.spawn.slots.forEach((child, index) => { real.nodes[child]!.actor = actors[index]!; });
          delete node.spawn;
        }
      }
      if (node.next) { const answer = node.next; delete node.next; return answer; }
      if (node.ending) return node.ending;
      const answer = fx!.textAnswer(`ACK_${slot}_REQUEST_${node.calls}`);
      if (model.nodes[slot]!.parent !== null || node.holdNext) {
        node.holdNext = false;
        const pending = { gate: fx!.controlledGate(), reply: answer };
        node.pending = pending;
        try { await fx!.abortable(pending.gate, request.options.signal); }
        finally { if (node.pending === pending) delete node.pending; }
        return pending.reply;
      }
      return answer;
    };
    for (const slot of [0, 1]) {
      prepareSpawn(model, real, slot, initial[slot]!, false);
      real.nodes[slot]!.actor = await fx.create(task(slot), { inheritContext: model.nodes[slot]!.inherited });
      await waitFor(() => !real.nodes[slot]!.spawn, { label: 'initial native children created' });
      await ready(real, children(model, slot));
    }
    await settleParents(model, real);
    await audit(model, real);
    await fc.asyncModelRun(() => ({ model, real }), commands);
    for (let slot = 2; slot < model.nodes.length; slot++) if (model.nodes[slot]!.alive) await finish(model, real, slot, 'text');
    for (const slot of [0, 1]) if (model.nodes[slot]!.busy) { real.nodes[slot]!.pending!.gate.resolve(); model.nodes[slot]!.busy = false; }
    await settleParents(model, real);
    await fx.session.waitForIdle();
    await audit(model, real);
    // Reopen each native file once, excluding inherited entries captured at creation.
    const native = real.nodes.map(node => deliveries(stored(node)).filter(entry => !node.initialIds.has(entry.id)));
    for (let slot = 0; slot < model.nodes.length; slot++) {
      const own = native[slot]!.filter(entry => entry.details.source === 'agent');
      for (const delivery of model.nodes[slot]!.inbox) {
        const matches = own.filter(entry => entry.content === `[Message from ${delivery.from}]\n${delivery.marker}`);
        assert.ok(delivery.required ? matches.length === 1 : matches.length <= 1, 'accepted messages are consumed once; interrupted messages never duplicate');
        if (matches.length) assert.equal(matches[0]!.details.sourceId, delivery.from);
        if (delivery.required) assert.ok(real.nodes[slot]!.request!.text.includes(`[Message from ${delivery.from}]\n${delivery.marker}`),
          'the receiving model request consumed the accepted message');
      }
      assert.ok(own.every(entry => model.nodes[slot]!.inbox.some(delivery => entry.content === `[Message from ${delivery.from}]\n${delivery.marker}`)), 'messages never leak beyond their intended direct recipients');
    }
    const targets = [deliveries(fx.sessionManager), ...native];
    for (const notice of real.notices) {
      const parent = model.nodes[notice.sender]!.parent;
      for (let target = 0; target < targets.length; target++) {
        const matches = targets[target]!.filter(entry => entry.details.jobId === notice.jobId && entry.details.source === 'host');
        const intended = target === (parent === null ? 0 : parent + 1);
        if (intended && !notice.required) assert.ok(matches.length <= 1, 'interrupted notices never duplicate');
        else assert.equal(matches.length, intended ? 1 : 0, 'one terminal notice reaches exactly the direct parent');
        if (matches.length) {
          assert.equal(matches[0]!.details.sourceId, real.nodes[notice.sender]!.actor!.id);
          assert.equal(matches[0]!.details.status, notice.status);
          if (notice.text !== undefined) {
            assert.ok(matches[0]!.content.startsWith(`${notice.text}\n\n`), 'the notice carries the child result');
            if (notice.consumed) assert.ok(real.nodes[parent!]!.request!.text.includes(notice.text),
              'a live parent model consumes its child result within the held Job');
          }
        }
      }
    }
  } catch (error) { failed = error; throw error; }
  finally {
    try {
      if (fx) { await fx.close(); assert.deepEqual(fx.uiErrors, []); }
    } catch (cleanup) {
      if (failed !== undefined) throw new AggregateError([failed, cleanup], 'History and cleanup both failed');
      throw cleanup;
    } finally { AgentSession.prototype.prompt = original; sessions.clear(); }
  }
}

const commands = fc.commands([fc.tuple(
  fc.constantFrom<Action>('spawn', 'write', 'upstream', 'broadcast', 'hold', 'yield', 'finish', 'cancel', 'finish-pair', 'reload'),
  fc.integer({ min: -1, max: 7 }), fc.integer({ min: 1, max: 2 }), fc.boolean(),
  fc.constantFrom<Outcome>('text', 'empty', 'error'),
  fc.array(fc.constantFrom('hello', '中文', '\n', '"', '$()', '🙂'), { maxLength: 5 }).map(parts => parts.join('')),
).map(args => new Command(...args))], commandOptions(24));
await checkProperty(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 2, maxLength: 2 }), commands, fc.scheduler(), sample));
console.log('PARENT_COORDINATION_MODEL_OK');
