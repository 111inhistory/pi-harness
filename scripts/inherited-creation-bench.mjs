#!/usr/bin/env node
/** Opt-in CPU, memory and event-loop measurements of real Inherited creation. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const project = path.resolve(option('--project', repository));

function memory() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function measure() {
  const turns = Number(option('--turns', '500'));
  const textBytes = Number(option('--text-bytes', '4096'));
  const tools = Number(option('--tools', '100'));
  for (const value of [turns, textBytes, tools]) assert.ok(Number.isSafeInteger(value) && value > 0);
  const sdk = await import(pathToFileURL(path.join(project, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const ai = await import(pathToFileURL(path.join(project, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(project, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')).href);
  const { Type } = await import(pathToFileURL(path.join(project, 'node_modules/typebox/build/index.mjs')).href);
  const { default: subagentExtension } = await import(pathToFileURL(path.join(project, 'src/subagent/extension.ts')).href);
  const { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-inherited-bench-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SOCKET_DIR = path.join(cwd, 'uds');
  const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = ai.fauxProvider({ models: [{ id: 'synthetic-perf-model', contextWindow: 1_048_576 }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = text => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 0, usage });
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  runtime.streamSimple = () => {
    const stream = new AssistantMessageEventStream();
    void finish.then(() => {
      const message = assistant('done');
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  };
  let catalogReads = 0;
  let promptMs = null;
  let startedAt = 0;
  const originalPrompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = function (...parameters) {
    if (promptMs === null) promptMs = performance.now() - startedAt;
    return originalPrompt.apply(this, parameters);
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'inherited-bench-root', factory(api) {
      const getAllTools = api.getAllTools.bind(api);
      api.getAllTools = () => { catalogReads += 1; return getAllTools(); };
      for (let index = 0; index < tools; index += 1) api.registerTool({
        name: `synthetic_${index}`, label: `Synthetic ${index}`, description: 'Synthetic parent tool',
        parameters: Type.Object({}),
        async execute() { return { content: [{ type: 'text', text: 'fixture' }] }; },
      });
      subagentExtension(api);
    } }],
  });
  let session;
  let heartbeat;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
    const text = 'x'.repeat(textBytes);
    for (let turn = 0; turn < turns; turn += 1) {
      manager.appendMessage({ role: 'user', content: `${turn}: ${text}`, timestamp: 0 });
      manager.appendMessage(assistant(`${turn}: ${text}`));
    }
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, settingsManager,
      resourceLoader: loader, sessionManager: manager }));
    await session.bindExtensions({ onError: error => { throw error; } });
    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    const context = session.extensionRunner.createToolContext('benchmark-create', undefined);
    assert.equal(typeof global.gc, 'function', 'run through npm run bench:inherited');
    global.gc();
    const before = memory();
    const readsBefore = catalogReads;
    let lastTick = performance.now();
    let maxEventLoopGapMs = 0;
    heartbeat = setInterval(() => {
      const now = performance.now();
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick);
      lastTick = now;
    }, 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    const cpuBefore = process.cpuUsage();
    startedAt = performance.now();
    const result = await create.execute('benchmark-create', {
      tasks: [{ task: 'Wait for synthetic creation measurement', inheritContext: true }],
    }, undefined, undefined, context);
    const createMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    assert.equal(result.details.items.length, 1);
    const afterCreate = memory();
    await new Promise(resolve => setTimeout(resolve, 15));
    clearInterval(heartbeat);
    global.gc();
    return {
      turns, textBytesPerMessage: textBytes, additionalRegisteredTools: tools,
      createMs, firstPromptMs: promptMs, maxEventLoopGapMs,
      cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      rootCatalogReads: catalogReads - readsBefore,
      memory: { before, afterCreate, afterGcWithChildAlive: memory() },
    };
  } finally {
    clearInterval(heartbeat);
    release();
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    AgentSession.prototype.prompt = originalPrompt;
    await rm(cwd, { recursive: true, force: true });
  }
}

async function sample(scenario) {
  const parameters = ['--expose-gc', '--import', 'tsx', script, '--worker', '--project', project,
    '--turns', String(scenario.turns), '--text-bytes', String(scenario.textBytes), '--tools', String(scenario.tools)];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, parameters, { cwd: repository, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) { reject(new Error(`Benchmark worker exited with ${code}`)); return; }
      try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
    });
  });
}

if (args.includes('--worker')) {
  console.log(JSON.stringify(await measure()));
} else {
  const scenarios = [
    { turns: 100, textBytes: 4096, tools: 100 },
    { turns: 500, textBytes: 4096, tools: 100 },
    { turns: 500, textBytes: 16384, tools: 500 },
  ];
  const samples = [];
  for (const scenario of scenarios) for (let repeat = 0; repeat < 3; repeat += 1) {
    const result = await sample(scenario);
    samples.push(result);
    console.error(`${scenario.turns} turns / ${scenario.tools} tools: ${result.createMs.toFixed(1)} ms, ${result.rootCatalogReads} catalog reads`);
  }
  const report = {
    revision: execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, arch: process.arch,
    workload: 'Real SDK Inherited create tool; durable synthetic history; no external MCP or online model; one live child per isolated worker.',
    samples,
  };
  const output = option('--output', '');
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  else console.log(JSON.stringify(report, null, 2));
}
