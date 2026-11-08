/**
 * Shell Approval auto-review UI feedback through the real extension check hook.
 *
 * Each case loads the production extension with a typed minimal ExtensionAPI,
 * runs the real optional review adapter against a faux provider registered on
 * a real ModelRuntime, and inspects the status line and notifications emitted
 * by the captured `tool_call` handler. Static policy programs are offline Node
 * children; no provider credentials or network requests are used.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import {
  initTheme,
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type TUI,
} from '@earendil-works/pi-tui';

import type { ShellApprovalComponent } from '../../src/shell-approval/ui.ts';

import {
  DEFAULT_HARNESS_CONFIG,
  harnessConfigFor,
  type HarnessConfig,
} from '../../src/harness-config.ts';
import shellPreflightExtension from '../../src/shell-approval/extension.ts';
import { AUTO_REVIEW_MIN_NODE_MAJOR } from '../../src/shell-approval/reviewer.ts';

const REVIEW_API = 'openai-codex-responses';
const REVIEW_PROVIDER = 'fake-provider';
const REVIEW_MODEL = 'fake-model';

const POLICY_SCRIPT = String.raw`
const fs = require("node:fs");
const action = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  decision: action.rules[0],
  reason: "fixture policy " + action.rules[0],
}));
`;

const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
const integrationSkip = NODE_MAJOR < AUTO_REVIEW_MIN_NODE_MAJOR
  ? `requires Node.js ${AUTO_REVIEW_MIN_NODE_MAJOR}+`
  : false;

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type NotificationLevel = 'info' | 'warning' | 'error';

interface NotificationRecord {
  readonly message: string;
  readonly level: NotificationLevel;
}

interface Capture {
  readonly api: ExtensionAPI;
  invoke(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown>;
}

/** Minimal typed ExtensionAPI surface: only registration and event dispatch. */
function captureExtensionApi(): Capture {
  const handlers = new Map<string, ExtensionHandler[]>();
  const api = {
    events: new EventEmitter(),
    on(event: string, handler: ExtensionHandler): () => void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(): void {},
  } as unknown as ExtensionAPI;
  return {
    api,
    async invoke(event, payload, ctx) {
      const registered = handlers.get(event) ?? [];
      assert.ok(registered.length > 0, `the extension must register a ${event} handler`);
      let result: unknown;
      for (const handler of registered) result = await handler(payload, ctx);
      return result;
    },
  };
}

interface ContextOptions {
  readonly cwd: string;
  readonly modelRegistry: ModelRegistry;
  readonly hasUI?: boolean;
  readonly mode?: string;
  readonly signal?: AbortSignal;
  readonly manualApproval?: 'approved' | 'rejected';
}

interface ContextCapture {
  readonly ctx: ExtensionContext;
  readonly statuses: (string | undefined)[];
  readonly notifications: NotificationRecord[];
}

function activeTheme(): Theme {
  initTheme('dark');
  const theme = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@earendil-works/pi-coding-agent:theme')
  ];
  assert.ok(theme, 'the active theme must be initialized');
  return theme as Theme;
}

function testTui(): TUI {
  return { requestRender() {} } as unknown as TUI;
}

/** Renders the real approval component and settles it through its own decision API. */
function displayApproval(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: { approved: boolean; reason: string }) => void,
  ) => ShellApprovalComponent,
  outcome: 'approved' | 'rejected',
): Promise<{ approved: boolean; reason: string }> {
  return new Promise(resolve => {
    const component = factory(testTui(), activeTheme(), new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager, resolve);
    component.render(80);
    component.decide(outcome);
    component.dispose();
  });
}

/** Minimal ExtensionContext with observable UI effects and real session runtime. */
function captureContext(options: ContextOptions): ContextCapture {
  const statuses: (string | undefined)[] = [];
  const notifications: NotificationRecord[] = [];
  const ctx = {
    cwd: options.cwd,
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? 'rpc',
    signal: options.signal,
    isProjectTrusted: () => true,
    modelRegistry: options.modelRegistry,
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus(_key: string, text: string | undefined): void {
        statuses.push(text);
      },
      notify(message: string, level: NotificationLevel): void {
        notifications.push({ message, level });
      },
      addAutocompleteProvider(): void {},
      async custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: { approved: boolean; reason: string }) => void,
        ) => ShellApprovalComponent,
      ): Promise<T> {
        if (options.manualApproval === undefined) {
          throw new Error('this fixture does not expect a manual approval dialog');
        }
        return await displayApproval(factory, options.manualApproval) as T;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, notifications };
}

async function reviewRuntime(response: FauxResponseFactory): Promise<{
  readonly registry: ModelRegistry;
  readonly faux: ReturnType<typeof fauxProvider>;
}> {
  const faux = fauxProvider({
    api: REVIEW_API,
    provider: REVIEW_PROVIDER,
    models: [{ id: REVIEW_MODEL, reasoning: true, contextWindow: 1_048_576 }],
  });
  faux.setResponses([response]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return { registry: new ModelRegistry(runtime), faux };
}

function approvalConfigForRules(
  mode: 'ask' | 'auto' | 'yolo',
  ruleFiles: readonly string[],
): HarnessConfig {
  return {
    ...DEFAULT_HARNESS_CONFIG,
    shell: {
      preflight: false,
      approval: {
        enabled: true,
        mode,
        command: [process.execPath, '-e', POLICY_SCRIPT],
        ruleFiles,
        commandTimeoutMs: 5_000,
        manualTimeoutMs: 1_000,
        notificationUrl: '',
        reviewer: {
          enabled: true,
          provider: REVIEW_PROVIDER,
          model: REVIEW_MODEL,
          timeoutMs: 5_000,
        },
      },
    },
  };
}

async function writePolicyRule(root: string, content: string, name = 'policy-rule.txt'): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, content, 'utf8');
  return file;
}

async function approvalConfig(
  root: string,
  mode: 'ask' | 'auto' | 'yolo',
  policy: 'allow' | 'review',
): Promise<HarnessConfig> {
  return approvalConfigForRules(mode, [await writePolicyRule(root, policy)]);
}

function withNotificationUrl(config: HarnessConfig, notificationUrl: string): HarnessConfig {
  return {
    ...config,
    shell: { ...config.shell, approval: { ...config.shell.approval, notificationUrl } },
  };
}

interface NotificationRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

interface NotificationReceiver {
  readonly url: string;
  readonly requests: NotificationRequest[];
  readonly arrived: Promise<NotificationRequest>;
  close(): Promise<void>;
}

/** Local receiver standing in for a Bark-style endpoint; records one request per delivery. */
async function notificationReceiver(
  reply: (request: NotificationRequest, response: http.ServerResponse) => void,
): Promise<NotificationReceiver> {
  const requests: NotificationRequest[] = [];
  let markArrived: (request: NotificationRequest) => void = () => {};
  const arrived = new Promise<NotificationRequest>(resolve => { markArrived = resolve; });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const received = {
        method: request.method ?? '',
        path: request.url ?? '',
        contentType: request.headers['content-type'],
        body,
      };
      requests.push(received);
      markArrived(received);
      reply(received, response);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    arrived,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

interface RunningExtension {
  readonly capture: Capture;
  readonly ctx: ExtensionContext;
  readonly statuses: (string | undefined)[];
  readonly notifications: NotificationRecord[];
  readonly toolCall: (command: string) => Promise<unknown>;
}

async function startExtension(
  config: HarnessConfig,
  context: ContextOptions,
): Promise<RunningExtension> {
  const capture = captureExtensionApi();
  harnessConfigFor(capture.api, config);
  shellPreflightExtension(capture.api);
  const ui = captureContext(context);
  await capture.invoke('session_start', {}, ui.ctx);
  return {
    capture,
    ctx: ui.ctx,
    statuses: ui.statuses,
    notifications: ui.notifications,
    toolCall: command => capture.invoke('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      input: { command },
    }, ui.ctx),
  };
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-shell-auto-review-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function autoReviewNotifications(notifications: readonly NotificationRecord[]): NotificationRecord[] {
  return notifications.filter(item => item.message.startsWith('Auto-review '));
}

function allowResponse(): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(JSON.stringify({
    risk_level: 'low',
    user_authorization: 'high',
    outcome: 'allow',
    rationale: 'The command only prints bounded local output inside the requested workspace.',
  }));
}

function denyResponse(): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(JSON.stringify({
    risk_level: 'high',
    user_authorization: 'low',
    outcome: 'deny',
    rationale: 'The command writes outside the requested workspace.',
  }));
}

function invalidResponse(): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage('not a review verdict');
}

test('auto-review allow resets the reviewing status, notifies info, and permits execution', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(allowResponse);
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(running.notifications, [{
    message: 'Auto-review allowed [Main]: printf hello',
    level: 'info',
  }]);
  assert.deepEqual(running.statuses, [
    'Permissions: Auto Approve',
    'Permissions: Auto Approve (reviewing)',
    'Permissions: Auto Approve',
  ]);
});

test('auto-review deny resets the reviewing status, notifies warning, and blocks execution', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(denyResponse);
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  const blocked = result as { readonly block?: unknown; readonly reason?: unknown };
  assert.equal(blocked.block, true);
  assert.equal(typeof blocked.reason, 'string');
  assert.match(
    blocked.reason as string,
    /^Command not executed: Automatic review denied execution: .*Do not attempt to bypass this decision/,
  );
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(running.notifications, [{
    message: 'Auto-review denied [Main]: printf hello',
    level: 'warning',
  }]);
  assert.deepEqual(running.statuses, [
    'Permissions: Auto Approve',
    'Permissions: Auto Approve (reviewing)',
    'Permissions: Auto Approve',
  ]);
});

test('an undecided review falls back to manual approval and resets the status after no_ui denial', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(invalidResponse);
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  assert.deepEqual(result, {
    block: true,
    reason: 'Command not executed: Manual approval denied (no_ui).',
  });
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(running.notifications, [{
    message: 'Auto-review could not decide; manual approval required [Main]: printf hello',
    level: 'warning',
  }]);
  assert.deepEqual(running.statuses, [
    'Permissions: Auto Approve',
    'Permissions: Auto Approve (reviewing)',
    'Permissions: Auto Approve (manual fallback)',
    'Permissions: Auto Approve',
  ]);
});

test('an undecided review can still be approved through manual fallback', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(invalidResponse);
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), {
    cwd: root,
    modelRegistry: registry,
    hasUI: true,
    mode: 'tui',
    manualApproval: 'approved',
  });

  const result = await running.toolCall('printf hello');

  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(autoReviewNotifications(running.notifications), [{
    message: 'Auto-review could not decide; manual approval required [Main]: printf hello',
    level: 'warning',
  }]);
  assert.deepEqual(running.statuses, [
    'Permissions: Auto Approve',
    'Permissions: Auto Approve (reviewing)',
    'Permissions: Auto Approve (manual fallback)',
    'Permissions: Auto Approve',
  ]);
});

test('cancelling an in-flight review resets the reviewing status without a decision notification', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  let startReview!: () => void;
  const reviewStarted = new Promise<void>(resolve => {
    startReview = resolve;
  });
  const { registry, faux } = await reviewRuntime((_context, streamOptions) => {
    startReview();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(allowResponse()), 5_000);
      streamOptions?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('review request aborted'));
      }, { once: true });
    });
  });
  const controller = new AbortController();
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), {
    cwd: root,
    modelRegistry: registry,
    signal: controller.signal,
  });

  const pending = running.toolCall('printf hello');
  await reviewStarted;
  controller.abort();
  const result = await pending;

  assert.deepEqual(result, {
    block: true,
    reason: 'Command not executed: approval cancelled.',
  });
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(running.notifications, []);
  assert.deepEqual(running.statuses, [
    'Permissions: Auto Approve',
    'Permissions: Auto Approve (reviewing)',
    'Permissions: Auto Approve',
  ]);
});

test('an explicit static allow never invokes the reviewer or emits review feedback', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(() => {
    throw new Error('the reviewer must not be called for a static allow');
  });
  const running = await startExtension(await approvalConfig(root, 'auto', 'allow'), { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(running.notifications, []);
  assert.deepEqual(running.statuses, ['Permissions: Auto Approve']);
});

test('Ask mode never invokes the reviewer or emits review feedback', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(() => {
    throw new Error('the reviewer must not be called in Ask mode');
  });
  const running = await startExtension(await approvalConfig(root, 'ask', 'review'), { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  assert.deepEqual(result, {
    block: true,
    reason: 'Command not executed: Manual approval denied (no_ui).',
  });
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(autoReviewNotifications(running.notifications), []);
  assert.deepEqual(running.statuses, [
    'Permissions: Ask',
    'Permissions: Ask',
  ]);
});

test('review feedback sanitizes terminal controls and truncates the command summary', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(allowResponse);
  const running = await startExtension(await approvalConfig(root, 'auto', 'review'), { cwd: root, modelRegistry: registry });
  const command = `printf 'safe\u001b[31mred\u001b[0m\u0007' ${'x'.repeat(200)}\nnext line`;

  const result = await running.toolCall(command);

  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 1);
  const [notification] = running.notifications;
  assert.ok(notification !== undefined);
  assert.equal(notification.level, 'info');
  const prefix = 'Auto-review allowed [Main]: ';
  assert.ok(notification.message.startsWith(prefix), notification.message);
  const summary = notification.message.slice(prefix.length);
  assert.doesNotMatch(summary, /[\x00-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(summary, /\u001b/);
  assert.ok(visibleWidth(summary) <= 100, `summary width ${visibleWidth(summary)}`);
  assert.ok(summary.endsWith('...'), summary);
  assert.match(summary, /^printf 'safered/);
});

test('rule files are cached per root until the session reloads, including read failures', {
  skip: integrationSkip,
}, async t => {
  const root = await tempRoot(t);
  const { registry, faux } = await reviewRuntime(allowResponse);
  faux.setResponses([allowResponse(), allowResponse()]);
  const present = await writePolicyRule(root, 'review', 'present.rule');
  const missing = path.join(root, 'missing.rule');
  const running = await startExtension(
    approvalConfigForRules('auto', [present, missing]),
    { cwd: root, modelRegistry: registry },
  );

  const blocked = await running.toolCall('printf hello') as { readonly block?: unknown; readonly reason?: unknown };
  assert.equal(blocked.block, true);
  assert.equal(typeof blocked.reason, 'string');
  const reason = blocked.reason as string;
  assert.match(reason, /rule/i);
  assert.match(reason, /file/i);
  assert.equal(faux.state.callCount, 0, 'an unreadable rule file must be denied before the reviewer');
  assert.deepEqual(running.statuses, ['Permissions: Auto Approve']);
  assert.equal(running.notifications.length, 1);
  const [ruleError] = running.notifications;
  assert.ok(ruleError !== undefined);
  assert.equal(ruleError.level, 'error');
  assert.match(ruleError.message, /^Rule file error: /);

  await writeFile(missing, 'review', 'utf8');
  const stillBlocked = await running.toolCall('printf hello') as { readonly block?: unknown };
  assert.equal(stillBlocked.block, true, 'the cached read failure survives until the session reloads');
  assert.equal(faux.state.callCount, 0);
  assert.equal(running.notifications.length, 2);
  assert.ok(running.notifications.every(item => item.level === 'error' && item.message.startsWith('Rule file error: ')));

  await running.capture.invoke('session_start', {}, running.ctx);
  const reviewed = await running.toolCall('printf hello');
  assert.equal(reviewed, undefined);
  assert.equal(faux.state.callCount, 1, 'a reloaded session reads the newly created rule file');
  assert.deepEqual(autoReviewNotifications(running.notifications), [{
    message: 'Auto-review allowed [Main]: printf hello',
    level: 'info',
  }]);

  await writeFile(present, 'allow', 'utf8');
  const stillReviewed = await running.toolCall('printf hello');
  assert.equal(stillReviewed, undefined);
  assert.equal(faux.state.callCount, 2, 'the cached rules ignore edits until the session reloads');
  assert.equal(autoReviewNotifications(running.notifications).length, 2);

  await running.capture.invoke('session_start', {}, running.ctx);
  const allowed = await running.toolCall('printf hello');
  assert.equal(allowed, undefined);
  assert.equal(faux.state.callCount, 2, 'the reloaded session reads the edited rules and skips the reviewer');
  assert.equal(autoReviewNotifications(running.notifications).length, 2);
  assert.equal(running.notifications.length, 4);
});

test('displaying a manual approval posts the generic payload to the configured URL', async t => {
  const root = await tempRoot(t);
  const target = await notificationReceiver((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"code":200,"message":"success"}');
  });
  t.after(() => target.close());
  const { registry } = await reviewRuntime(() => {
    throw new Error('Ask mode must not invoke the reviewer');
  });
  const config = withNotificationUrl(await approvalConfig(root, 'ask', 'review'), `${target.url}/synthetic-device-key`);
  const running = await startExtension(config, {
    cwd: root, modelRegistry: registry, hasUI: true, mode: 'tui', manualApproval: 'approved',
  });

  const result = await running.toolCall('printf hello');
  const [request] = await Promise.all([target.arrived, result]);

  assert.equal(result, undefined, 'the approval outcome is unchanged by the notification');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/synthetic-device-key');
  assert.equal(request.contentType, 'application/json');
  const payload = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(payload, {
    title: 'Shell approval required',
    body: `Agent: Main\nDirectory: ${root}\nCommand: printf hello`,
  });
  assert.deepEqual(autoReviewNotifications(running.notifications), []);
  assert.equal(running.notifications.some(item => item.message.includes('URL notification failed')), false);
});

test('a failed URL notification keeps the approval and never echoes the configured URL', async t => {
  const root = await tempRoot(t);
  const target = await notificationReceiver((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"message":"synthetic provider detail synthetic-device-key"}');
  });
  t.after(() => target.close());
  const { registry } = await reviewRuntime(() => {
    throw new Error('Ask mode must not invoke the reviewer');
  });
  const config = withNotificationUrl(await approvalConfig(root, 'ask', 'review'), `${target.url}/synthetic-device-key`);
  const running = await startExtension(config, {
    cwd: root, modelRegistry: registry, hasUI: true, mode: 'tui', manualApproval: 'approved',
  });

  const result = await running.toolCall('printf hello');
  await waitFor(
    () => running.notifications.some(item => item.message.includes('URL notification failed')),
    'the notification failure warning',
  );

  assert.equal(result, undefined, 'a notification failure must not change the approval');
  assert.equal(target.requests.length, 1, 'notifications are not retried');
  const warnings = running.notifications.filter(item => item.message.includes('URL notification failed'));
  assert.deepEqual(warnings, [{
    message: 'URL notification failed.',
    level: 'warning',
  }]);
  for (const notification of running.notifications) {
    assert.equal(notification.message.includes(target.url), false, notification.message);
    assert.equal(notification.message.includes('synthetic-device-key'), false, notification.message);
    assert.equal(notification.message.includes('provider detail'), false, notification.message);
  }
});

test('cancelling the session suppresses a late notification failure warning', async t => {
  const root = await tempRoot(t);
  let pending: http.ServerResponse | undefined;
  const target = await notificationReceiver((_request, response) => { pending = response; });
  t.after(() => target.close());
  const { registry } = await reviewRuntime(() => {
    throw new Error('Ask mode must not invoke the reviewer');
  });
  const config = withNotificationUrl(await approvalConfig(root, 'ask', 'review'), `${target.url}/synthetic-device-key`);
  const running = await startExtension(config, {
    cwd: root, modelRegistry: registry, hasUI: true, mode: 'tui', manualApproval: 'approved',
  });

  const result = await running.toolCall('printf hello');
  assert.equal(result, undefined);
  await target.arrived;
  await running.capture.invoke('session_shutdown', {}, running.ctx);

  assert.doesNotThrow(() => {
    pending?.writeHead(500, { 'Content-Type': 'application/json' });
    pending?.end('{"message":"late failure"}');
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(running.notifications.filter(item => item.message.includes('URL notification failed')), []);
  assert.equal(target.requests.length, 1);
});

test('a manual approval that never displays a dialog sends no notification', async t => {
  const root = await tempRoot(t);
  const target = await notificationReceiver((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"code":200}');
  });
  t.after(() => target.close());
  const { registry } = await reviewRuntime(() => {
    throw new Error('Ask mode must not invoke the reviewer');
  });
  const config = withNotificationUrl(await approvalConfig(root, 'ask', 'review'), `${target.url}/synthetic-device-key`);
  const running = await startExtension(config, { cwd: root, modelRegistry: registry });

  const result = await running.toolCall('printf hello');

  assert.deepEqual(result, {
    block: true,
    reason: 'Command not executed: Manual approval denied (no_ui).',
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(target.requests.length, 0);
  assert.deepEqual(running.notifications.filter(item => item.message.includes('URL notification failed')), []);
});
