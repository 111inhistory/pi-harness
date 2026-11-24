/**
 * Exact replay acceptance for a clipped managed-Shell result.
 *
 * A real `bash` tool call runs a real process through the built `pi-job` CLI,
 * the oversized output is clipped by the managed foreground path, and the
 * resulting tool result is persisted in the SDK session file. The session is
 * then closed and reopened from that file, and the same history is sent through
 * the installed Responses adapter to a loopback mock wire. Closing a transport
 * must replay the already-sent clipped result byte for byte instead of
 * re-clipping or otherwise rewriting it.
 *
 * This is deliberately not a claim about a live provider's `prefix_mismatch`
 * handling: the mock wire only observes what the harness serializes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { InMemoryCredentialStore, normalizeContext, type Model } from '@earendil-works/pi-ai';
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

import { AsyncShellHost } from '../../src/async-shell/host.ts';
import { installAsyncShellSurface } from '../../src/async-shell/surface.ts';
import { DEFAULT_HARNESS_CONFIG, harnessConfigFor } from '../../src/harness-config.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tmuxAvailable = spawnSync(process.platform === 'win32' ? 'psmux.exe' : 'tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const options = { skip: process.platform === 'win32' ? 'POSIX managed shell only' : !tmuxAvailable && 'tmux is required', timeout: 180_000 };

interface ResponsesPayload {
  readonly input?: readonly Record<string, unknown>[];
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events.map(event => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function textEvents(text: string): readonly Record<string, unknown>[] {
  const item = {
    type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return [
    { type: 'response.created', response: { id: 'resp_text', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp_text', status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
  ];
}

function toolCallEvents(command: string): readonly Record<string, unknown>[] {
  const args = JSON.stringify({ command });
  const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'bash', arguments: args, status: 'completed' };
  return [
    { type: 'response.created', response: { id: 'resp_call', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: args },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp_call', status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
  ];
}

/** Loopback Responses wire. It records the request bodies the installed adapter serialized. */
async function mockWire(command: string): Promise<{
  readonly baseUrl: string;
  readonly bodies: ResponsesPayload[];
  close(): Promise<void>;
}> {
  const bodies: ResponsesPayload[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as ResponsesPayload;
      bodies.push(payload);
      const replayed = (payload.input ?? []).some(item => item['type'] === 'function_call_output');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(replayed ? textEvents('Tool result received.') : toolCallEvents(command)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function model(baseUrl: string): Model<'openai-responses'> {
  return {
    id: 'offline-responses', name: 'Offline Responses', api: 'openai-responses',
    provider: 'offline-fixture', baseUrl, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 100_000, maxTokens: 4096,
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  };
}

async function createSession(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManager;
  readonly model: Model<'openai-responses'>;
  readonly runtime: ModelRuntime;
  readonly host: AsyncShellHost;
}): Promise<AgentSession> {
  const settings = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', defaultTools: ['bash'],
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings,
    systemPrompt: 'Offline replay fixture.', noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'shell-clipped-replay-fixture',
      factory(api) {
        harnessConfigFor(api, {
          ...DEFAULT_HARNESS_CONFIG,
          shell: { ...DEFAULT_HARNESS_CONFIG.shell, autoBackgroundAfterMs: 10_000, maxForegroundWaitMs: 10_000 },
        });
        installAsyncShellSurface(api, async () => options.host, 'main');
      },
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: options.cwd, agentDir: options.agentDir, modelRuntime: options.runtime, model: options.model,
    settingsManager: settings, resourceLoader: loader, sessionManager: options.sessionManager, tools: ['bash'],
  });
  await session.bindExtensions({ onError: error => { throw error; } });
  return session;
}

/** The host registration socket the managed CLI dials before it starts. */
async function callbackServer(host: AsyncShellHost, socketPath: string): Promise<net.Server> {
  const server = net.createServer(connection => {
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        const frame = JSON.parse(line) as { agentId: string };
        connection.write('\n');
        void host.receive(frame.agentId, frame as never).catch(() => {});
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return server;
}

test('a clipped Shell result is replayed byte for byte after reopening its SDK session', options, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-shell-replay-'));
  const agentDir = path.join(cwd, 'agent');
  const socketPath = path.join(cwd, 'main.sock');
  const cli = path.join(cwd, process.platform === 'win32' ? 'pi-job.exe' : 'pi-job');
  const runtimeRoot = path.join(cwd, 'shell');
  await mkdir(agentDir, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

  const previous = {
    cli: process.env['PI_ASYNC_SHELL_CLI'],
    agentDir: process.env['PI_CODING_AGENT_DIR'],
    root: process.env['PI_ASYNC_SHELL_ROOT'],
  };
  process.env['PI_ASYNC_SHELL_CLI'] = cli;
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_ASYNC_SHELL_ROOT'] = runtimeRoot;

  let session: AgentSession | undefined;
  let host: AsyncShellHost | undefined;
  let callbacks: net.Server | undefined;
  let wire: Awaited<ReturnType<typeof mockWire>> | undefined;
  t.after(async () => {
    await session?.dispose();
    await host?.close().catch(() => {});
    if (callbacks !== undefined) {
      const server = callbacks;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await wire?.close();
    await rm(cwd, { recursive: true, force: true });
    for (const [key, value] of [
      ['PI_ASYNC_SHELL_CLI', previous.cli],
      ['PI_CODING_AGENT_DIR', previous.agentDir],
      ['PI_ASYNC_SHELL_ROOT', previous.root],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-async-shell.mjs'), cli], { encoding: 'utf8' });
  assert.equal(build.status, 0, `the async-shell CLI must build: ${build.stderr}`);

  const script = 'for (let i = 1; i <= 3000; i += 1) console.log("line-" + i); console.error("TAIL-DIAGNOSIS");';
  const command = `${quote(process.execPath)} -e ${quote(script)}`;
  wire = await mockWire(command);
  host = new AsyncShellHost({
    accepting: () => true,
    mainAddress: () => socketPath,
    deliver: async () => {},
    wake: () => {},
    cancel: async () => {},
  });
  const shellHost = host;
  callbacks = await callbackServer(shellHost, socketPath);

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const fixtureModel = model(wire.baseUrl);
  runtime.streamSimple = (requestModel, context, streamOptions) => streamResponses(
    requestModel as Model<'openai-responses'>, normalizeContext(context),
    { ...streamOptions, apiKey: 'offline-fixture' },
  );

  const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  session = await createSession({ cwd, agentDir, sessionManager: manager, model: fixtureModel, runtime, host: shellHost });
  await session.prompt('Run the oversized Shell command.');

  assert.equal(wire.bodies.length, 2, 'one tool-call request and one request carrying its result');
  const live = wire.bodies[1]!;
  const outputs = (live.input ?? []).filter(item => item['type'] === 'function_call_output');
  assert.equal(outputs.length, 1, 'the first send carries exactly one Shell result');
  const sent = outputs[0]!['output'];
  assert.equal(typeof sent, 'string');

  // The real managed foreground path clipped the oversized log to its tail and
  // named the full log; this is the text that entered the model conversation.
  assert.match(sent as string, /line-3000/);
  assert.match(sent as string, /TAIL-DIAGNOSIS/);
  assert.doesNotMatch(sent as string, /^line-1$/m);
  assert.match(sent as string, /\[Showing lines \d+-\d+ of \d+\. Full output: .+\]$/);
  assert.doesNotMatch(sent as string, /line-1000\n/);

  const file = manager.getSessionFile();
  assert.ok(file);
  type PersistedToolResult = {
    readonly role: 'toolResult';
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  };
  const persisted = (await readFile(file, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { type?: string; message?: { role?: string } })
    .filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult')
    .map(entry => entry.message as unknown as PersistedToolResult);
  assert.equal(persisted.length, 1);
  const [persistedResult] = persisted;
  assert.ok(persistedResult);
  const persistedText = persistedResult.content
    .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  assert.equal(persistedText, sent, 'the wire text is exactly the persisted clipped result');

  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  await session.dispose();
  session = undefined;

  const reopenedManager = SessionManager.open(file);
  session = await createSession({ cwd, agentDir, sessionManager: reopenedManager, model: fixtureModel, runtime, host: shellHost });
  await session.prompt('Continue after restart.');

  assert.equal(wire.bodies.length, 3);
  const replayed = wire.bodies[2]!;
  const liveInput = live.input ?? [];
  assert.deepEqual((replayed.input ?? []).slice(0, liveInput.length), liveInput,
    'every request item sent before closing is replayed unchanged from the reopened session');
  const replayedOutput = (replayed.input ?? []).filter(item => item['type'] === 'function_call_output');
  assert.equal(replayedOutput.length, 1);
  assert.deepEqual(replayedOutput[0], outputs[0], 'the clipped Shell result has one exact replay representation');
  assert.equal(replayedOutput[0]!['output'], sent);
});
