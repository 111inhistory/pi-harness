import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { CAPABILITY_DISCOVERY_PROMPT, CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  createCapabilityDiscovery, providerErrorDetail } from '../../src/capability/agent.ts';
import type { CapabilityBrokerPort, CapabilityDiscoveryDependencies, CapabilityOpenSessionRequest } from '../../src/capability/agent.ts';
import type { CapabilityStepParameters } from '../../src/capability/contracts.ts';
import type { CapabilitySearchHit, CapabilitySearchResult, CapabilitySkillHit } from '../../src/capability/broker.ts';
import { DEFAULT_HARNESS_CONFIG } from '../../src/harness-config.ts';

const NO_SELECTION_LIMIT = DEFAULT_HARNESS_CONFIG.capability.noSelectionLimit;
const DISCOVERY_BUDGET = DEFAULT_HARNESS_CONFIG.capability.budget;

const toolHit: CapabilitySearchHit = { ref: 'tool://read', name: 'read', description: 'fixture tool', kind: 'tool', status: 'available', match: 'ref', score: 0, reason: 'fixture' };
const skillHit: CapabilitySkillHit = { ...toolHit, ref: '/skills/fixture/SKILL.md', name: 'fixture', kind: 'skill', filePath: '/skills/fixture/SKILL.md' };
function result(hits: CapabilitySearchHit[] = [], warnings: string[] = []): CapabilitySearchResult {
  return { status: warnings.length ? 'partial' : 'ok', tools: hits.filter(hit => hit.kind !== 'skill' && hit.kind !== 'mcp'),
    mcp: hits.filter(hit => hit.kind === 'mcp'), skills: hits.filter((hit): hit is CapabilitySkillHit => hit.kind === 'skill' && hit.filePath !== undefined),
    remote: [], warnings, missingCapabilities: [] };
}
type Search = Parameters<CapabilityBrokerPort['search']>[0];
function broker(results: Record<string, CapabilitySearchResult | Error | (() => Promise<CapabilitySearchResult>)> = {}) {
  const calls: Search[] = [];
  return { calls, async search(input: Search): Promise<CapabilitySearchResult> {
    calls.push(input);
    const value = results[input.query] ?? result();
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value() : structuredClone(value);
  } };
}
const step = (request: CapabilityOpenSessionRequest, params: CapabilityStepParameters) =>
  request.customTools[0]!.execute('step', params, request.signal, undefined, {} as ExtensionToolContext);
interface State { prompts: number; opens: number; aborts: number; disposals: number }
async function discover(options: {
  broker?: CapabilityBrokerPort;
  signal?: AbortSignal;
  onOpen?: (request: CapabilityOpenSessionRequest) => void;
  behavior?: (request: CapabilityOpenSessionRequest, state: State) => Promise<readonly unknown[] | void>;
  budget?: CapabilityDiscoveryDependencies['budget'];
  noSelectionLimit?: CapabilityDiscoveryDependencies['noSelectionLimit'];
} = {}) {
  const state: State = { prompts: 0, opens: 0, aborts: 0, disposals: 0 };
  const engine = createCapabilityDiscovery({ broker: options.broker ?? broker(), openSession: async request => {
    state.opens++;
    options.onOpen?.(request);
    return { prompt: async text => {
      state.prompts++;
      assert.equal(text, CAPABILITY_DISCOVERY_PROMPT);
      assert.equal(request.instructions, CAPABILITY_DISCOVERY_SYSTEM_PROMPT);
      assert.equal(request.customTools.length, 1);
      assert.equal(request.customTools[0]!.name, 'capability_step');
      assert.equal(request.customTools[0]!.executionMode, 'sequential');
      return await options.behavior?.(request, state) ?? [];
    }, abort() { state.aborts++; }, async dispose() { await Promise.resolve(); state.disposals++; } };
  }, ...(options.budget === undefined ? {} : { budget: options.budget }),
     ...(options.noSelectionLimit === undefined ? {} : { noSelectionLimit: options.noSelectionLimit }) });
  const output = await engine.discover({ cwd: '/fixture', signal: options.signal });
  return { output, state };
}

test('parallel searches retain input order, then cumulative selection finishes without another model call', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const searches = broker({ first: async () => { await gate; return result([toolHit]); }, second: async () => { release(); return result([skillHit]); } });
  const { output, state } = await discover({ broker: searches, behavior: async request => {
    const first = await step(request, { queries: ['first', 'second'], refs: [] });
    assert.deepEqual(first.details.searches.map(search => search.query), ['first', 'second']);
    assert.equal(first.details.noSelectionCount, 1, 'bootstrap uses the extra empty-step allowance');
    assert.equal(first.details.noSelectionLimit, NO_SELECTION_LIMIT);
    const next = await step(request, { queries: ['third'], refs: [toolHit.ref] });
    assert.deepEqual(next.details.selection.accepted, [toolHit.ref]);
    assert.equal(next.terminate, undefined);
    assert.equal(request.beforeRequest(), undefined);
    const finish = await step(request, { queries: [], refs: [skillHit.ref], finish: true });
    assert.equal(finish.terminate, true);
    assert.equal(request.beforeRequest()?.stop, true);
    const closed = await step(request, { queries: ['NEVER_SEARCHED'], refs: [] });
    assert.equal(closed.isError, true);
    return [{ role: 'assistant', stopReason: 'error', errorMessage: 'LATE_ERROR' }];
  } });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.tools, [toolHit]);
  assert.deepEqual(output.skills, [skillHit]);
  assert.equal(searches.calls.length, 3);
  assert.ok(searches.calls.every(call => call.src === 'local' && call.cwd === '/fixture'));
  assert.deepEqual(output.coverage, { local: 'searched', remote: 'not_searched' });
  assert.equal(state.prompts, 1);
  assert.equal(state.disposals, 1);
});

test('omitted fields support search-only, selection-only and finish-only steps', async () => {
  const searches = broker({ found: result([toolHit]) });
  const { output } = await discover({ broker: searches, behavior: async request => {
    const searched = await step(request, { queries: ['found'] });
    assert.deepEqual(searched.details.selection.accepted, []);
    assert.equal(searched.details.searches.length, 1);
    const selected = await step(request, { refs: [toolHit.ref] });
    assert.deepEqual(selected.details.selection.accepted, [toolHit.ref]);
    assert.deepEqual(selected.details.searches, []);
    assert.equal(selected.isError, undefined);
    assert.equal(selected.terminate, undefined);
    const finished = await step(request, { finish: true });
    assert.equal(finished.terminate, true);
    assert.equal(finished.isError, undefined);
  } });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.tools, [toolHit]);
  assert.equal(searches.calls.length, 1);
});

test('empty calls count as zero selection without searching or reporting query failures', async () => {
  const searches = broker();
  const { output } = await discover({ broker: searches, behavior: async request => {
    for (let index = 1; index <= NO_SELECTION_LIMIT + 1; index++) {
      const idle = await step(request, {});
      assert.equal(idle.isError, undefined);
      assert.deepEqual(idle.details.searches, []);
      assert.equal(idle.details.noSelectionCount, index);
    }
  } });
  assert.equal(output.endReason, 'no_selection_limit');
  assert.equal(output.status, 'failed');
  assert.equal(searches.calls.length, 0);
});

test('finish-only permits an empty result after a search but not before', async () => {
  const { output } = await discover({ behavior: async request => {
    assert.equal((await step(request, { finish: true })).isError, true);
    await step(request, { queries: ['empty'] });
    assert.equal((await step(request, { finish: true })).terminate, true);
  } });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.tools, []);
});

test('only a namespace group ref is selectable and its member metadata stays intact', async () => {
  const namespace: CapabilitySearchHit = { ...toolHit, ref: 'namespace://fixture', name: 'fixture', kind: 'namespace',
    instructions: 'GROUP_GUIDANCE', toolCount: 1,
    tools: [{ ref: toolHit.ref, name: toolHit.name, description: toolHit.description, exposure: 'direct' }] };
  const { output } = await discover({ broker: broker({ found: result([namespace]) }), behavior: async request => {
    await step(request, { queries: ['found'], refs: [] });
    const member = await step(request, { queries: [], refs: [toolHit.ref], finish: true });
    assert.equal(member.isError, true);
    await step(request, { queries: [], refs: [namespace.ref], finish: true });
  } });
  assert.deepEqual(output.tools, [namespace]);
});

test('startup failure is explicit and has no session to dispose', async () => {
  const { output, state } = await discover({ onOpen() { throw new Error('LOADER_FAILURE'); } });
  assert.equal(output.status, 'failed');
  assert.equal(output.coverage.local, 'not_searched');
  assert.ok(output.warnings.some(warning => warning.includes('LOADER_FAILURE')));
  assert.equal(state.prompts, 0);
  assert.equal(state.disposals, 0);
});

test('zero selections, not zero search hits, close the run after the extra bootstrap allowance', async () => {
  const searches = broker({ found: result([toolHit]) });
  const { output } = await discover({ broker: searches, behavior: async request => {
    for (let index = 0; index < NO_SELECTION_LIMIT + 1; index++) {
      const response = await step(request, { queries: ['found'], refs: [] });
      assert.equal(response.details.noSelectionCount, index + 1);
    }
    assert.equal(request.beforeRequest()?.stop, true);
  } });
  assert.equal(searches.calls.length, NO_SELECTION_LIMIT, 'limit stops before dispatching the next batch');
  assert.equal(output.status, 'failed');
  assert.equal(output.endReason, 'no_selection_limit');
});

test('new selections neither increment nor reset zero-selection count; repeats do not make progress', async () => {
  const { output } = await discover({ broker: broker({ found: result([toolHit]) }), behavior: async request => {
    await step(request, { queries: ['found'], refs: [] });
    const selected = await step(request, { queries: ['found'], refs: [toolHit.ref] });
    assert.equal(selected.details.noSelectionCount, 1);
    for (let index = 0; index < NO_SELECTION_LIMIT; index++) {
      const repeated = await step(request, { queries: ['found'], refs: [toolHit.ref] });
      assert.deepEqual(repeated.details.selection.accepted, []);
      assert.deepEqual(repeated.details.selection.alreadySelected, [toolHit.ref]);
    }
  } });
  assert.equal(output.status, 'partial');
  assert.equal(output.endReason, 'no_selection_limit');
  assert.deepEqual(output.tools, [toolHit]);
});

test('unknown refs atomically reject this submission without losing earlier selection', async () => {
  const { output } = await discover({ broker: broker({ found: result([toolHit, skillHit]) }), behavior: async request => {
    await step(request, { queries: ['found'], refs: [] });
    await step(request, { queries: ['found'], refs: [toolHit.ref] });
    const rejected = await step(request, { queries: ['DO_NOT_DISPATCH'], refs: [skillHit.ref, 'tool://invented'] });
    assert.equal(rejected.isError, true);
    assert.deepEqual(rejected.details.selection.accepted, []);
    assert.deepEqual(rejected.details.selection.rejected, ['tool://invented']);
    await step(request, { queries: [], refs: [], finish: true });
  } });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.tools, [toolHit]);
  assert.deepEqual(output.skills, []);
});

test('normal empty finish is ok after a completed search; bootstrap-only finish is rejected', async () => {
  const { output } = await discover({ behavior: async request => {
    assert.equal((await step(request, { queries: [], refs: [], finish: true })).isError, true);
    await step(request, { queries: ['empty'], refs: [] });
    assert.equal((await step(request, { queries: [], refs: [], finish: true })).terminate, true);
  } });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.missingCapabilities, ['empty']);
});

test('query failures do not lose independent search results or become local no-match claims', async () => {
  const searches = broker({ failed: new Error('SEARCH_BROKEN'), found: result([toolHit]) });
  const { output } = await discover({ broker: searches, behavior: async request => {
    const response = await step(request, { queries: ['failed', 'found'], refs: [] });
    assert.deepEqual(response.details.searches.map(search => search.status), ['failed', 'ok']);
    await step(request, { queries: [], refs: [toolHit.ref], finish: true });
  } });
  assert.equal(output.status, 'partial');
  assert.deepEqual(output.tools, [toolHit]);
  assert.ok(output.warnings.some(warning => warning.includes('SEARCH_BROKEN')));
  const failed = await discover({ broker: broker({ broken: new Error('ALL_BROKEN') }), behavior: async request => {
    assert.equal((await step(request, { queries: ['broken'], refs: [] })).isError, true);
    assert.equal((await step(request, { queries: [], refs: [], finish: true })).isError, true);
  } });
  assert.equal(failed.output.status, 'failed');
  assert.equal(failed.output.coverage.local, 'not_searched');
  assert.deepEqual(failed.output.missingCapabilities, []);
});

for (const ending of ['throw', 'provider', 'budget', 'incomplete'] as const) {
  test(`${ending} preserves incremental selections as partial rather than dropping them`, async () => {
    const { output, state } = await discover({ broker: broker({ found: result([toolHit]) }), behavior: async request => {
      await step(request, { queries: ['found'], refs: [] });
      await step(request, { queries: ['next'], refs: [toolHit.ref] });
      if (ending === 'throw') throw new Error('MODEL_FAILURE');
      if (ending === 'provider') return [{ role: 'assistant', stopReason: 'error', errorMessage: 'PROVIDER_FAILURE' }];
      if (ending === 'budget') {
        for (let index = 0; index <= DISCOVERY_BUDGET.modelCalls.hard; index++) request.budget.beginModelCall();
      }
      return [];
    } });
    assert.equal(output.status, 'partial');
    assert.deepEqual(output.tools, [toolHit]);
    assert.equal(output.endReason, ending === 'throw' || ending === 'provider' ? 'provider_error' : ending);
    assert.equal(state.disposals, 1);
  });
}

test('without accepted selections a model error, budget limit or incomplete reply is failed', async () => {
  for (const ending of ['provider', 'budget', 'incomplete']) {
    const { output } = await discover({ behavior: async request => {
      if (ending === 'provider') throw new Error('FAILED_WITHOUT_SELECTION');
      if (ending === 'budget') for (let index = 0; index <= DISCOVERY_BUDGET.modelCalls.hard; index++) request.budget.beginModelCall();
    } });
    assert.equal(output.status, 'failed');
  }
  assert.deepEqual(DISCOVERY_BUDGET.modelCalls, { soft: 16, hard: 20 });
});

test('caller cancellation before, during opening, or during execution respects session ownership', async () => {
  for (const when of ['before', 'opening', 'running'] as const) {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const { output, state } = await discover({ signal: controller.signal,
      onOpen: () => { if (when === 'opening') controller.abort(); },
      behavior: async () => { if (when === 'running') controller.abort(); },
    });
    assert.equal(output.status, 'failed');
    assert.equal(output.endReason, 'cancelled');
    assert.equal(state.prompts, when === 'running' ? 1 : 0);
    assert.equal(state.disposals, when === 'before' ? 0 : 1);
    assert.equal(state.aborts, when === 'before' ? 0 : 1);
  }
});

test('caller abort after finish invalidates success while preserving the internal selection', async () => {
  const controller = new AbortController();
  const { output } = await discover({ signal: controller.signal, broker: broker({ found: result([toolHit]) }),
    behavior: async request => {
      await step(request, { queries: ['found'], refs: [] });
      await step(request, { queries: [], refs: [toolHit.ref], finish: true });
      controller.abort();
    },
  });
  assert.equal(output.status, 'partial');
  assert.equal(output.endReason, 'cancelled');
  assert.deepEqual(output.tools, [toolHit]);
});

test('completed queries retain coverage when another query cancels the batch', async () => {
  const controller = new AbortController();
  const { output } = await discover({
    signal: controller.signal,
    broker: broker({ successful: result([toolHit]), cancelled: async () => {
      controller.abort();
      throw new Error('QUERY_CANCELLED');
    } }),
    behavior: async request => { await step(request, { queries: ['successful', 'cancelled'], refs: [] }); },
  });
  assert.equal(output.status, 'failed');
  assert.equal(output.endReason, 'cancelled');
  assert.equal(output.coverage.local, 'searched');
  assert.deepEqual(output.tools, [], 'unselected candidates never become accepted results');
});

test('a synchronous query throw is isolated from the rest of the batch', async () => {
  const { output } = await discover({ broker: { search(input) {
    if (input.query === 'broken') throw new Error('SYNC_FAILURE');
    return result([toolHit]);
  } }, behavior: async request => {
    const searched = await step(request, { queries: ['broken', 'found'], refs: [] });
    assert.deepEqual(searched.details.searches.map(item => item.status), ['failed', 'ok']);
    await step(request, { queries: [], refs: [toolHit.ref], finish: true });
  } });
  assert.equal(output.status, 'partial');
  assert.deepEqual(output.tools, [toolHit]);
});

test('custom no-selection limit keeps exactly one derived bootstrap allowance', async () => {
  const { output } = await discover({ noSelectionLimit: 1, behavior: async request => {
    const first = await step(request, {});
    assert.equal(first.details.noSelectionLimit, 1);
    assert.equal(first.details.noSelectionCount, 1);
    assert.equal(first.terminate, undefined);
    const second = await step(request, {});
    assert.equal(second.details.noSelectionCount, 2);
    assert.equal(second.details.endReason, 'no_selection_limit');
    assert.equal(second.terminate, true);
  } });
  assert.equal(output.endReason, 'no_selection_limit');
  assert.equal(output.status, 'failed');
});

test('custom capability budget is applied to the discovery session', async () => {
  const budget = { modelCalls: { soft: 1, hard: 1 }, activeTimeMs: { soft: 1_000, hard: 2_000 }, lifetimeMs: 3_000 };
  const { output } = await discover({ budget, behavior: async request => {
    assert.deepEqual(request.budget.snapshot({ detail: true }).profile, budget);
    assert.equal(request.budget.beginModelCall().ok, true);
    assert.equal(request.budget.beginModelCall().ok, false);
  } });
  assert.equal(output.endReason, 'budget');
  assert.equal(output.status, 'failed');
});

test('providerErrorDetail inspects the final assistant attempt and handles unknown input', () => {
  assert.equal(providerErrorDetail(null), null);
  assert.equal(providerErrorDetail([]), null);
  assert.equal(providerErrorDetail([{ role: 'assistant', stopReason: 'error', errorMessage: 'EXACT_ERROR' }]), 'EXACT_ERROR');
  assert.equal(providerErrorDetail([{ role: 'assistant', stopReason: 'error' }]), 'the provider reported an error');
  assert.equal(providerErrorDetail([{ role: 'assistant', stopReason: 'error' }, { role: 'assistant', stopReason: 'stop' }, { role: 'toolResult' }]), null);
});
