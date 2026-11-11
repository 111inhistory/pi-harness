#!/usr/bin/env node
/** Opt-in measurements of local common paths; no model or external MCP calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stripCallbackEnv } from '../test-support/test-environment.mjs';

const { values } = parseArgs({ options: { iterations: { type: 'string', default: '25' }, output: { type: 'string' } } });
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, '--iterations must be a positive integer');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pi-common-bench-'));
// Harness IPC defaults are captured at import time, so select the private root first.
const sanitized = stripCallbackEnv(process.env);
for (const key of Object.keys(process.env)) if (!(key in sanitized)) delete process.env[key];
process.env.PI_SUBAGENT_SOCKET_DIR = path.join(temporary, 'uds');
process.env.PI_CODING_AGENT_DIR = path.join(temporary, 'agent');
const cleanups = [];
let report;
try {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { queryToolPermissions } = await import('../src/capability/tool-permission.ts');
  const { createCapabilityBroker } = await import('../src/capability/broker.ts');
  const { RootService } = await import('../src/subagent/root-service.ts');
  const { createOwnedNdjsonServer, getAgentSocketPath, writeSocket } = await import('../src/ipc/socket.ts');
  const profiles = [
    { calls: 4000, users: 400, results: 3500, tools: 30, actors: 120, jobs: 200 },
    { calls: 8000, users: 800, results: 7000, tools: 50, actors: 240, jobs: 400 },
  ];
  const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
  async function measure(run, check) {
    async function once() {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const result = await run();
      const wallMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      check(result); // Validation is outside both clocks; no preflight warms the first operation.
      return { wallMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000 };
    }
    const firstOperation = await once();
    const samples = [];
    for (let i = 0; i < iterations; i++) samples.push(await once());
    return { firstOperation, warm: { iterations,
      medianWallMs: median(samples.map(s => s.wallMs)),
      minWallMs: Math.min(...samples.map(s => s.wallMs)), maxWallMs: Math.max(...samples.map(s => s.wallMs)),
      meanCpuUserMs: samples.reduce((sum, s) => sum + s.cpuUserMs, 0) / iterations,
      meanCpuSystemMs: samples.reduce((sum, s) => sum + s.cpuSystemMs, 0) / iterations } };
  }
  const reports = [];
  for (const input of profiles) {
    const tools = Array.from({ length: input.tools }, (_, i) => ({ name: `synthetic_${i}`, exposure: 'direct',
      description: i === 0 ? 'Inspect code using inspection workflow' : 'Compile source files',
      parameters: { type: 'object', properties: {} }, sourceInfo: { source: 'extension', path: '/synthetic/tools.ts' } }));
    const active = tools.slice(0, 8).map(t => t.name);
    // Only record kinds matter to permission replay; lifecycle benchmarks carry full message bodies.
    const branch = [...Array.from({ length: input.users }, () => ({ type: 'message', message: { role: 'user' } })),
      ...Array.from({ length: input.calls }, () => ({ type: 'message', message: { role: 'assistant' } })),
      ...Array.from({ length: input.results }, () => ({ type: 'message', message: { role: 'toolResult' } })),
      { type: 'custom', customType: 'capability-tool-permission', data: { version: 1,
        set: [{ target: 'synthetic_0', state: 'enabled' }, { target: 'synthetic_1', state: 'disabled' }] } }];
    let catalogReads = 0;
    const permission = await measure(() => queryToolPermissions({ getAllTools: () => { catalogReads++; return tools; } },
      branch, active, 'enabled+disabled+active+inactive'), result => {
      assert.equal(result.entries.length, tools.length);
      assert.equal(result.entries.find(t => t.name === 'synthetic_0').state, 'enabled');
      assert.equal(result.entries.find(t => t.name === 'synthetic_1').state, 'disabled');
    });
    assert.equal(catalogReads, iterations + 1);
    permission.catalogReadsPerOperation = catalogReads / (iterations + 1);
    const work = { toolCatalogReads: 0, activeSetReads: 0, skillCatalogReads: 0, skillBodyReads: 0 };
    const broker = createCapabilityBroker({
      listTools: () => { work.toolCatalogReads++; return tools; },
      listActiveTools: () => { work.activeSetReads++; return active; },
      discoverSkills: () => { work.skillCatalogReads++; return { skills: [{ name: 'inspection-guide',
        description: 'Inspection workflow', filePath: '/synthetic/skills/inspect.md' }], warnings: [] }; },
      readSkillFile: async () => { work.skillBodyReads++; return 'Inspection workflow for code review.'; },
    });
    const search = await measure(() => broker.search({ query: 'inspection', src: 'local', cwd: temporary }), result => {
      assert.equal(result.status, 'ok');
      assert.ok(result.tools.some(t => t.name === 'synthetic_0'));
      assert.ok(result.skills.some(s => s.name === 'inspection-guide'));
    });
    search.workPerOperation = Object.fromEntries(Object.entries(work).map(([key, count]) => [key, count / (iterations + 1)]));
    const manager = SessionManager.inMemory(temporary);
    const service = new RootService({ api: { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], sendMessage() {} },
      context: { cwd: temporary, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true },
      agentDir: process.env.PI_CODING_AGENT_DIR, allocatedIds: new Set(), ownsContext: () => true });
    cleanups.push(() => service.retire());
    await service.initialize();
    service.assertOperational();
    const actors = Array.from({ length: input.actors }, (_, i) => ({ agentId: `sub_${i + 1}`, parentAgentId: null, depth: 1 }));
    const jobs = Array.from({ length: input.jobs }, (_, i) => {
      const actor = actors[i % actors.length];
      const round = Math.floor(i / actors.length) + 1;
      const previous = round === 1 ? null : actor.agentId + (round === 2 ? '' : `#r${round - 1}`);
      return { jobId: actor.agentId + (round === 1 ? '' : `#r${round}`), agentId: actor.agentId,
        spec: previous ? { kind: 'continuation' } : { task: 'Synthetic completed task' },
        continuedFromJobId: previous, end: { status: 'completed', result: 'Synthetic result' } };
    });
    service.runtime.restoreState({ actors, jobs });
    const scoped = await measure(() => service.list({}, 'Main'), tree => { assert.equal(tree.id, 'Main'); assert.equal(tree.children.length, 4); });
    const all = await measure(() => service.list({ all: true }, 'Main'), tree => assert.equal(tree.children.length, input.actors));
    await service.retire();
    const address = getAgentSocketPath('common_bench', path.join(temporary, `ipc-${input.calls}`));
    const payload = { from: 'Main', content: 'Synthetic inspection progress' };
    let received = 0;
    let lastFrame;
    const server = createOwnedNdjsonServer({ address, root: temporary, onMessage(frame) { lastFrame = frame; received++; } });
    cleanups.push(async () => { const closed = await server.close(); if (closed.releaseError) throw closed.releaseError; });
    await server.ready;
    const ipc = await measure(async () => { await writeSocket(address, payload); return { received, frame: lastFrame }; }, result => {
      assert.ok(result.received > 0);
      assert.deepEqual(result.frame, payload);
    });
    assert.equal(received, iterations + 1);
    await server.close();
    reports.push({ input: { ...input, branchEntries: branch.length, activeTools: active.length, activeActors: 0,
      historyStorage: 'in-memory terminal registry; no derived history files' },
      permissionQuery: permission, localSearch: search, rootListScoped: scoped, rootListAll: all, ipcRoundtrip: ipc });
    console.error(`${input.calls} calls / ${input.tools} tools: local common paths measured`);
  }
  report = { revision: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: process.platform, node: process.version, arch: process.arch,
    scope: 'Setup/imports excluded. First operation then warm operations. Local broker uses in-memory provider ports; IPC is real owned transport. No model latency, archive I/O or memory-growth claim.',
    profiles: reports };
} finally {
  const results = await Promise.allSettled(cleanups.map(close => close()));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length) throw new AggregateError(errors, 'Common-path benchmark cleanup failed');
  await rm(temporary, { recursive: true, force: true });
}
// Cleanup succeeds before publishing a successful measurement.
const text = JSON.stringify(report, null, 2) + '\n';
if (values.output) await writeFile(values.output, text); else process.stdout.write(text);
