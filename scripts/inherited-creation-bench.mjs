#!/usr/bin/env node
/** Real SDK creation/fork measurements, with bounded context and scalable native history. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as turn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import v8 from 'node:v8';
import { stripCallbackEnv } from '../test-support/test-environment.mjs';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '..');
const { values } = parseArgs({ options: {
  worker: { type: 'boolean' }, project: { type: 'string', default: repository }, output: { type: 'string' },
  calls: { type: 'string' }, children: { type: 'string' }, mode: { type: 'string' }, repeats: { type: 'string', default: '3' },
} });
const positive = (value, name) => { const n = Number(value); assert.ok(Number.isSafeInteger(n) && n > 0, `${name} must be positive`); return n; };
const project = path.resolve(values.project);
const repeats = positive(values.repeats, '--repeats');
const memory = () => { const peak = process.resourceUsage().maxRSS; return { ...process.memoryUsage(),
  processPeakRssBytes: peak > 0 ? peak * 1024 : null }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function rpcClient(address) {
  const socket = net.connect(address);
  const closed = new Promise(resolve => socket.once('close', resolve));
  const pending = new Map();
  let buffer = '', id = 0;
  const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  socket.on('error', fail);
  socket.once('close', () => fail(new Error('Benchmark RPC connection closed')));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (!pending.has(frame.id)) continue; // Stream events are consumed without retaining their bodies.
      const request = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) request.reject(new Error(JSON.stringify(frame.error))); else request.resolve(frame.result);
    }
  });
  try { await once(socket, 'connect'); } catch (error) { socket.destroy(); await closed; throw error; }
  return { async call(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Benchmark RPC timed out: ${method}`)); }, 10000);
      pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
  }, async close() { socket.destroy(); await closed; } };
}

async function worker(profile) {
  assert.equal(typeof global.gc, 'function');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pi-lifecycle-bench-'));
  // Set private IPC defaults before importing any Harness module that captures them.
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, 'agent');
  process.env.PI_SUBAGENT_SOCKET_DIR = path.join(temporary, 'uds');
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  const load = file => import(pathToFileURL(path.join(project, file)).href);
  const sdk = await load('node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const ai = await load('node_modules/@earendil-works/pi-ai/dist/index.js');
  const { AssistantMessageEventStream } = await load('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js');
  const { Type } = await load('node_modules/typebox/build/index.mjs');
  const { default: subagentExtension } = await load('src/subagent/extension.ts');
  const { RootService } = await load('src/subagent/root-service.ts');
  const { harnessRpcTarget } = await load('src/harness-rpc/discovery.ts');
  const { AgentSession, createAgentSessionFromServices, createAgentSessionRuntime, DefaultResourceLoader,
    ModelRuntime, SessionManager, SettingsManager } = sdk;
  global.gc();
  const baseline = memory();

  async function run() {
    const childFinish = deferred(), childrenStarted = deferred();
    const roots = [];
    let currentRoot, host, client, parentApi;
    let childDispatches = 0, mainDispatches = 0, catalogReads = 0, firstPromptMs = null, operationStart = 0;
    const events = [], childToolCounts = new Map();
    const originalInitialize = RootService.prototype.initialize;
    const originalPrompt = AgentSession.prototype.prompt;
    RootService.prototype.initialize = async function () {
      roots.push(this); await originalInitialize.call(this); currentRoot = this;
    };
    AgentSession.prototype.prompt = function (...args) {
      if (operationStart && firstPromptMs === null) firstPromptMs = performance.now() - operationStart;
      if (host && this !== host.session) childToolCounts.set(this.sessionManager.getSessionId(), this.getActiveToolNames().length);
      return originalPrompt.apply(this, args);
    };
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const faux = ai.fauxProvider({ models: [{ id: 'synthetic-lifecycle-model', contextWindow: 1048576 }] });
    const model = faux.models[0];
    const answer = text => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 0, usage });
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
    let manager, create, context, heartbeat;
    try {
      const sessionDir = path.join(temporary, 'sessions');
      manager = SessionManager.create(temporary, sessionDir);
      let firstKept;
      let firstKeptIndex;
      for (let call = 0; call < profile.calls; call++) {
        if (call % 10 === 0) {
          const id = manager.appendMessage({ role: 'user', content: `Synthetic request ${call}: ${'u'.repeat(100)}`, timestamp: 0 });
          if (call === profile.calls - 150) { firstKept = id; firstKeptIndex = manager.getEntries().length - 1; }
        }
        if (call % 10 !== 9) {
          const id = `synthetic_call_${call}`;
          manager.appendMessage({ ...answer('Inspect this synthetic source'), stopReason: 'toolUse',
            content: [{ type: 'toolCall', id, name: 'synthetic_0', arguments: { query: `request ${call}: ${'q'.repeat(700)}` } }] });
          manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'synthetic_0', isError: false, timestamp: 0,
            content: [{ type: 'text', text: `${call}: ${'r'.repeat(call % 5 === 0 ? 16384 : 512)}` }] });
        } else manager.appendMessage(answer(`Synthetic completed step ${call}`));
        if (call === profile.calls - 101) manager.appendCompaction('Synthetic history summary. ' + 's'.repeat(1024), firstKept, profile.calls * 500);
      }
      const historyEntries = manager.getEntries().length;
      const effectiveTailEntries = historyEntries - firstKeptIndex;
      const source = manager.getSessionFile();
      const historyFileBytes = (await stat(source)).size;
      // Reopen serialized history so shared fixture strings do not understate a loaded session's memory.
      manager = SessionManager.open(source, sessionDir);
      const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
        runtime.registerNativeProvider(faux.provider);
        runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
        runtime.hasConfiguredAuth = () => true;
        runtime.streamSimple = (_model, _context, options) => {
          const child = options?.sessionId !== sessionManager.getSessionId();
          if (child) { childDispatches++; if (childDispatches === profile.children) childrenStarted.resolve(); } else mainDispatches++;
          const stream = new AssistantMessageEventStream();
          void (child ? childFinish.promise : Promise.resolve()).then(() => {
            stream.push({ type: 'done', reason: 'stop', message: answer('Synthetic completion') }); stream.end();
          });
          return stream;
        };
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
          noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
          extensionFactories: [{ name: 'lifecycle-benchmark', factory(api) {
            parentApi = api;
            const getTools = api.getAllTools.bind(api);
            api.getAllTools = () => { catalogReads++; return getTools(); };
            for (let i = 0; i < 19; i++) api.registerTool({ name: `synthetic_${i}`, label: `Synthetic ${i}`,
              description: 'Synthetic inspection tool', defaultActive: i < 4,
              parameters: Type.Object({ query: Type.String() }), async execute() { return { content: [] }; } });
            subagentExtension(api);
            api.on('session_before_fork', () => { events.push('before_fork'); });
            api.on('session_shutdown', event => { events.push(`shutdown:${event.reason}`); });
            api.on('session_start', event => { events.push(`start:${event.reason}`); });
          } }],
        });
        await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
        const services = { cwd, agentDir, settingsManager: settings, modelRuntime: runtime, resourceLoader: loader };
        return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model }), services, diagnostics: [] };
      };
      host = await createAgentSessionRuntime(factory, { cwd: temporary, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
      const rebind = session => session.bindExtensions({ mode: profile.mode, onError: error => { throw error; } });
      host.setRebindSession(rebind); await rebind(host.session);
      const registeredTools = parentApi.getAllTools().length;
      const activeTools = parentApi.getActiveTools().length;
      global.gc(); const before = memory();
      let maxLifecycleEventLoopGapMs = 0, lastTick = performance.now();
      heartbeat = setInterval(() => { const now = performance.now(); maxLifecycleEventLoopGapMs = Math.max(maxLifecycleEventLoopGapMs, now - lastTick); lastTick = now; }, 1);
      create = host.session.getToolDefinition('subagent_create');
      context = host.session.extensionRunner.createToolContext('benchmark-create', undefined);
      const readsBefore = catalogReads;
      operationStart = performance.now(); const createCpuStart = process.cpuUsage();
      const created = await create.execute('benchmark-create', { tasks: Array.from({ length: profile.children }, () => ({ task: 'Wait for synthetic completion', inheritContext: true })) }, undefined, undefined, context);
      const createMs = performance.now() - operationStart, createCpu = process.cpuUsage(createCpuStart);
      const createCatalogReads = catalogReads - readsBefore;
      const afterCreate = memory();
      assert.equal(created.details.items.length, profile.children);
      await childrenStarted.promise;
      assert.equal(currentRoot.runtime.jobs().jobs.filter(j => j.status === 'running').length, profile.children);
      const childActiveTools = [...childToolCounts.values()];
      assert.equal(childActiveTools.length, profile.children);
      let rpcSubscriptions = 0;
      if (profile.mode === 'rpc') {
        client = await rpcClient(harnessRpcTarget(currentRoot.socketRoot, currentRoot.sessionId).address);
        for (const item of created.details.items) {
          const reply = await client.call('stream.subscribe', { jobId: item.id });
          assert.equal(reply.live, true); rpcSubscriptions++;
        }
      }
      await turn(); global.gc(); const afterGcWithChildrenAlive = memory();
      // Disconnecting one client must detach all of its observations; no work is replayed.
      if (client) { await client.close(); client = null; await turn(); }
      global.gc(); const afterRpcDisconnectWithChildrenAlive = memory();
      let runningRoot = currentRoot;
      childFinish.resolve();
      await Promise.all(created.details.items.map(item => runningRoot.runtime.jobDone(item.id)));
      await host.session.waitForIdle();
      manager = null; create = null; context = null;
      const parentFile = host.session.sessionFile;
      const parentDigest = await digest(parentFile);
      const parentId = host.session.sessionManager.getSessionId();
      const leaf = host.session.sessionManager.getLeafId();
      const forkReads = catalogReads;
      const forkStart = performance.now(), forkCpuStart = process.cpuUsage();
      const fork = await host.fork(leaf, { position: 'at' });
      const forkMs = performance.now() - forkStart, forkCpu = process.cpuUsage(forkCpuStart);
      const forkCatalogReads = catalogReads - forkReads;
      const afterFork = memory();
      assert.equal(fork.cancelled, false);
      assert.notEqual(host.session.sessionManager.getSessionId(), parentId);
      assert.equal(host.session.sessionManager.getHeader().parentSession, parentFile);
      assert.ok(events.includes('before_fork') && events.includes('shutdown:fork') && events.includes('start:fork'));
      assert.equal(runningRoot.closed, true);
      // The old root is physically retired; the measurement must not keep it alive for instrumentation.
      assert.ok(roots.slice(0, -1).every(root => root.closed));
      roots.splice(0, roots.length - 1); runningRoot = null;
      await turn(); global.gc(); const afterGcWithForkAlive = memory();
      host.session.sessionManager.appendMessage({ role: 'user', content: 'Synthetic fork ownership check', timestamp: 0 });
      assert.equal(await digest(parentFile), parentDigest, 'fork mutation preserves the source file');
      clearInterval(heartbeat);
      return { ...profile, registeredTools, activeTools, childActiveTools, rpcConnections: profile.mode === 'rpc' ? 1 : 0,
        rpcSubscriptions, historyEntries, effectiveTailEntries, historyFileBytes, firstPromptMs,
        createMs, forkMs, createCatalogReads, forkCatalogReads, maxLifecycleEventLoopGapMs,
        cpuCreateMs: (createCpu.user + createCpu.system) / 1000, cpuForkMs: (forkCpu.user + forkCpu.system) / 1000,
        measuredChildDispatches: childDispatches, measuredMainDispatches: mainDispatches,
        memory: { before, afterCreate, afterGcWithChildrenAlive, afterRpcDisconnectWithChildrenAlive, afterFork, afterGcWithForkAlive } };
    } finally {
      clearInterval(heartbeat); childFinish.resolve();
      const failures = [];
      for (const close of [() => client?.close(), () => host?.dispose(), ...roots.map(root => () => root.retire())]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      RootService.prototype.initialize = originalInitialize; AgentSession.prototype.prompt = originalPrompt;
      if (failures.length) throw new AggregateError(failures, 'Lifecycle benchmark cleanup failed');
    }
  }
  let result;
  try { result = await run(); } finally { await rm(temporary, { recursive: true, force: true }); }
  // run() has returned: fixture-owned managers, loaders, contexts and old roots are out of scope.
  await turn(); global.gc(); await turn(); global.gc();
  result.memory.baselineAfterImports = baseline;
  result.memory.afterTeardownAndGc = memory();
  return result;
}

if (values.worker) {
  const profile = { calls: positive(values.calls, '--calls'), children: positive(values.children, '--children'), mode: values.mode };
  assert.ok(profile.calls >= 1000 && profile.calls % 10 === 0);
  assert.ok([1, 3].includes(profile.children) && ['print', 'rpc'].includes(profile.mode));
  console.log(JSON.stringify(await worker(profile)));
} else {
  const profiles = values.calls
    ? [{ calls: positive(values.calls, '--calls'), children: positive(values.children ?? '3', '--children'), mode: values.mode ?? 'print' }]
    : [1000, 4000, 16000, 32000].flatMap(calls => ['print', 'rpc'].map(mode => ({ calls, mode, children: 3 })))
      .concat(['print', 'rpc'].map(mode => ({ calls: 4000, mode, children: 1 })));
  const samples = [];
  const execute = promisify(execFile);
  for (const profile of profiles) for (let repeat = 0; repeat < repeats; repeat++) {
    const { stdout } = await execute(process.execPath, ['--expose-gc', '--import', 'tsx', script, '--worker', '--project', project,
      '--calls', String(profile.calls), '--children', String(profile.children), '--mode', profile.mode],
    { cwd: project, env: stripCallbackEnv(process.env), timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const sample = JSON.parse(stdout.trim()); samples.push(sample);
    console.error(`${profile.calls} calls / ${profile.children} live children / ${profile.mode}: create ${sample.createMs.toFixed(1)} ms, fork ${sample.forkMs.toFixed(1)} ms`);
  }
  const medians = profiles.map(profile => {
    const rows = samples.filter(s => s.calls === profile.calls && s.children === profile.children && s.mode === profile.mode);
    const phases = Object.keys(rows[0].memory);
    return { ...profile, createMs: median(rows.map(r => r.createMs)), forkMs: median(rows.map(r => r.forkMs)),
      memory: Object.fromEntries(phases.map(phase => [phase, Object.fromEntries(Object.keys(rows[0].memory[phase])
        .map(key => [key, rows[0].memory[phase][key] === null ? null : median(rows.map(r => r.memory[phase][key]))]))])) };
  });
  const report = { revision: execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: process.platform, node: process.version, arch: process.arch, heapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
    repeats, memoryUnits: 'bytes', scope: 'Real SDK Inherited create and AgentSessionRuntime.fork. Compacted native history, no online models/MCP. Three children are simultaneously dispatched and held; RPC samples include a real client and live stream subscriptions. Archive populations and MCP sharing/lazy loading are not simulated.',
    notes: ['Process peak RSS is a non-resettable worker watermark, including imports/setup; null when unsupported.',
      'Lifecycle loop gap includes GC, validation and settling, not just create/fork.',
      'GC snapshots distinguish live ownership and teardown; they do not measure allocation volume or prove absence of leaks.'],
    medians, samples };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(values.output, text); else process.stdout.write(text);
}
