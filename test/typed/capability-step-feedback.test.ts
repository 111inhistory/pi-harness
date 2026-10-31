/** Model-facing `capability_step` feedback: compact first sightings, ref-only repeats. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createCapabilityDiscovery } from '../../src/capability/agent.ts';
import type { CapabilityBrokerPort, CapabilityOpenSessionRequest, CapabilityStepFeedback } from '../../src/capability/agent.ts';
import type { CapabilityStepParameters } from '../../src/capability/contracts.ts';
import type { CapabilitySearchHit, CapabilitySearchResult, CapabilitySkillHit } from '../../src/capability/broker.ts';

const toolHit: CapabilitySearchHit = { ref: 'tool://read', name: 'read', description: 'read fixture',
  kind: 'tool', status: 'available', match: 'ref', score: 0, reason: 'fixture' };
const skillHit: CapabilitySkillHit = { ...toolHit, ref: '/skills/fixture/SKILL.md', name: 'fixture-skill', description: 'skill fixture',
  kind: 'skill', filePath: '/skills/fixture/SKILL.md' };
function result(hits: CapabilitySearchHit[] = []): CapabilitySearchResult {
  return { status: 'ok', tools: hits.filter(hit => hit.kind === 'tool' || hit.kind === 'namespace'),
    mcp: hits.filter(hit => hit.kind === 'mcp'),
    skills: hits.filter((hit): hit is CapabilitySkillHit => hit.kind === 'skill' && hit.filePath !== undefined),
    remote: [], missingCapabilities: [], warnings: [] };
}
type Search = Parameters<CapabilityBrokerPort['search']>[0];
function broker(results: Record<string, CapabilitySearchResult | Error> = {}) {
  return { async search(input: Search): Promise<CapabilitySearchResult> {
    const value = results[input.query] ?? result();
    if (value instanceof Error) throw value;
    return structuredClone(value);
  } };
}
async function discover(brokerPort: CapabilityBrokerPort,
  behavior: (request: CapabilityOpenSessionRequest) => Promise<readonly unknown[] | void>) {
  const engine = createCapabilityDiscovery({ broker: brokerPort, openSession: async request => ({
    prompt: async () => await behavior(request) ?? [],
    abort() {},
    async dispose() { await Promise.resolve(); },
  }) });
  return engine.discover({ cwd: '/fixture' });
}
/**
 * The tool result `content` is what the SDK hands to the provider as the
 * `capability_step` tool result; parse it exactly as the model receives it.
 */
async function step(request: CapabilityOpenSessionRequest, params: CapabilityStepParameters) {
  const result = await request.customTools[0]!.execute('step', params, request.signal, undefined, {} as ExtensionToolContext);
  const part = result.content[0];
  assert.ok(part !== undefined && part.type === 'text', 'step content is one text block');
  return { result, raw: part.text, feedback: JSON.parse(part.text) as CapabilityStepFeedback };
}

const nsInstructions = `GROUP_GUIDANCE ${'long shared guidance '.repeat(400)}`;
const members = Array.from({ length: 30 }, (_, index) => ({
  ref: `tool://member_${index}`, name: `member_${index}`,
  description: `${`MEMBER_DESCRIPTION_${index} `.repeat(20)}`, exposure: 'direct',
}));
const namespace: CapabilitySearchHit = {
  ref: 'namespace://fixture', name: 'fixture', description: 'Fixture namespace for integration',
  kind: 'namespace', status: 'available', match: 'bm25', score: 0.5, reason: 'BM25 metadata match',
  namespace: 'fixture', instructions: nsInstructions, toolCount: members.length, tools: members,
};

test('a large namespace reaches the model as intact compact JSON while details keep every member', async () => {
  let stepResult: Awaited<ReturnType<typeof step>> | undefined;
  const output = await discover(broker({ namespace: result([namespace]) }), async request => {
    stepResult = await step(request, { queries: ['namespace'] });
    const searched = stepResult.feedback.searches[0];
    assert.ok(searched);
    assert.deepEqual(searched.tools, [{ ref: namespace.ref, name: namespace.name,
      description: namespace.description, kind: 'namespace', toolCount: members.length }]);
    assert.deepEqual(searched.mcp, []);
    assert.deepEqual(searched.skills, []);
    assert.deepEqual(searched.repeatedRefs, []);
    assert.deepEqual(searched.warnings, []);
    assert.deepEqual(searched.missingCapabilities, []);
    assert.ok(stepResult.raw.length < 1_000, 'feedback omits the long body instead of truncating serialized JSON');
    assert.doesNotMatch(stepResult.raw, /long shared guidance|MEMBER_DESCRIPTION_|member_\d+/);
    const raw = stepResult.result.details.searches[0];
    assert.ok(raw);
    assert.equal(raw.tools[0]?.instructions, nsInstructions);
    assert.deepEqual(raw.tools[0]?.tools, members);
    const finish = await step(request, { refs: [namespace.ref], finish: true });
    assert.equal(finish.result.terminate, true);
  });
  assert.deepEqual(output.tools, [namespace], 'selecting the namespace ref still keeps all original members');
});

test('duplicate hits within one batch and across steps repeat refs without becoming missing matches', async () => {
  const found = result([toolHit, skillHit]);
  const output = await discover(broker({ alpha: found, beta: found }), async request => {
    const batch = await step(request, { queries: ['alpha', 'beta'] });
    assert.deepEqual(batch.feedback.searches.map(search => search.query), ['alpha', 'beta']);
    const [first, second] = batch.feedback.searches;
    assert.ok(first && second);
    assert.deepEqual(first.tools.map(hit => hit.ref), [toolHit.ref]);
    assert.deepEqual(first.skills.map(hit => hit.ref), [skillHit.ref]);
    assert.deepEqual(second.tools, []);
    assert.deepEqual(second.skills, []);
    assert.deepEqual(second.repeatedRefs, [toolHit.ref, skillHit.ref]);
    assert.deepEqual(second.missingCapabilities, []);
    assert.equal(second.status, 'ok');
    const again = await step(request, { queries: ['alpha'] });
    const repeated = again.feedback.searches[0];
    assert.ok(repeated);
    assert.deepEqual(repeated.tools, []);
    assert.deepEqual(repeated.skills, []);
    assert.deepEqual(repeated.repeatedRefs, [toolHit.ref, skillHit.ref]);
    assert.deepEqual(repeated.missingCapabilities, []);
    // Seen and selected stay distinct: repeated refs are still selectable.
    assert.deepEqual(again.feedback.selection.accepted, []);
    const finish = await step(request, { refs: [toolHit.ref, skillHit.ref], finish: true });
    assert.deepEqual(finish.feedback.selection.accepted, [toolHit.ref, skillHit.ref]);
  });
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.tools, [toolHit]);
  assert.deepEqual(output.skills, [skillHit]);
  assert.deepEqual(output.missingCapabilities, [], 'duplicates are not reported as absent capabilities');
});

test('a fresh discovery run shows the compact candidate again', async () => {
  const searches = broker({ namespace: result([namespace]) });
  for (const pass of [1, 2]) {
    const output = await discover(searches, async request => {
      const searched = await step(request, { queries: ['namespace'] });
      assert.equal(searched.feedback.searches[0]?.tools.length, 1, `run ${pass} shows the first sighting`);
      assert.deepEqual(searched.feedback.searches[0]?.repeatedRefs, []);
      await step(request, { refs: [namespace.ref], finish: true });
    });
    assert.deepEqual(output.tools, [namespace]);
  }
});

test('one failed query keeps its place in model feedback without dropping independent candidates', async () => {
  const output = await discover(broker({ broken: new Error('SYNC_FAILURE'), found: result([toolHit]) }), async request => {
    const batch = await step(request, { queries: ['broken', 'found'] });
    assert.deepEqual(batch.feedback.searches.map(search => [search.query, search.status]), [['broken', 'failed'], ['found', 'ok']]);
    const [failed, succeeded] = batch.feedback.searches;
    assert.deepEqual(failed?.tools, []);
    assert.ok(failed?.warnings.some(warning => warning.includes('SYNC_FAILURE')));
    assert.deepEqual(succeeded?.tools.map(hit => hit.ref), [toolHit.ref]);
    assert.equal(batch.feedback.error, undefined);
    const details = batch.result.details.searches.map(search => search.status);
    assert.deepEqual(details, ['failed', 'ok']);
    await step(request, { refs: [toolHit.ref], finish: true });
  });
  assert.equal(output.status, 'partial');
  assert.deepEqual(output.tools, [toolHit]);
});
