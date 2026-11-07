import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  SessionManager, initTheme,
  type ExtensionAPI, type ExtensionCommandContext, type KeybindingsManager, type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  fauxProvider, InMemoryCredentialStore,
  type Api, type AssistantMessage, type Model,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager,
  type AgentSession, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, type TUI } from '@earendil-works/pi-tui';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai';
import { installBtwCommand } from '../../src/btw/command.ts';
import type { BtwPanel } from '../../src/btw/panel.ts';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];

/** Point the config loader at an empty user directory instead of the real one. */
async function agentRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-btw-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return root;
}

async function writeHarnessConfig(agentDir: string, value: unknown): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify(value), 'utf8');
}

function fixture(
  mode: ExtensionCommandContext['mode'] = 'tui',
  rows = 24,
  renderer: 'fullscreen' | 'regular' = 'fullscreen',
) {
  initTheme('dark');
  const theme = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('@earendil-works/pi-coding-agent:theme')] as Theme;
  const commands = new Map<string, Command>();
  const events = new Map<string, () => void | Promise<void>>();
  const notices: string[] = [];
  let panel: BtwPanel | undefined;
  let mounts = 0;
  let mounted = 0;
  let overlayRequests = 0;
  let mainAborts = 0;
  let closeImmediately = false;
  const manager = SessionManager.inMemory('/tmp/project');
  manager.appendMessage({ role: 'user', content: 'Main task', timestamp: 1 });
  const before = structuredClone(manager.getBranch());
  const pi = {
    getActiveTools: () => ['read'],
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on(name: string, callback: () => void | Promise<void>) { events.set(name, callback); return () => {}; },
  } as unknown as ExtensionAPI;
  installBtwCommand(pi);
  const ctx = {
    cwd: '/tmp/project', mode, hasUI: mode === 'tui',
    isProjectTrusted: () => false,
    sessionManager: manager,
    model: fauxProvider({ models: [{ id: 'fake-model' }] }).models[0],
    modelRegistry: {},
    getSystemPrompt: () => 'Main instructions',
    abort() { mainAborts++; },
    ui: {
      notify(message: string) { notices.push(message); },
      custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => BtwPanel, options?: { overlay?: boolean }) {
        mounts++;
        if (options?.overlay === true) overlayRequests++;
        return new Promise<void>((resolve, reject) => {
          let created: BtwPanel;
          try {
            created = factory({ mode: renderer, terminal: { rows, columns: 80 }, requestRender() {} } as unknown as TUI,
              theme, new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager, resolve);
          } catch (error) {
            reject(error);
            return;
          }
          panel = created;
          mounted++;
          if (closeImmediately) created.handleInput('\x1b');
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const invoke = (args = '') => commands.get('btw')!.handler(args, ctx);
  return {
    invoke, events, notices, manager, before,
    get panel() { return panel; },
    get mounts() { return mounts; },
    get mounted() { return mounted; },
    get overlayRequests() { return overlayRequests; },
    get mainAborts() { return mainAborts; },
    closeOnOpen() { closeImmediately = true; },
  };
}

test('/btw opens a composer without model work and leaves Main untouched', async (t) => {
  await agentRoot(t);
  const f = fixture();
  const pending = f.invoke();
  assert.ok(f.panel);
  assert.equal(f.mounts, 1);
  assert.equal(f.overlayRequests, 0, '/btw docks inline instead of floating over the transcript');
  f.panel.handleInput('\x1b');
  await pending;
  assert.equal(f.mainAborts, 0);
  assert.deepEqual(f.manager.getBranch(), f.before);
  assert.deepEqual(f.notices, []);
  // Closing releases the command lifetime so another snapshot can be opened.
  f.closeOnOpen();
  await f.invoke();
  assert.equal(f.mounts, 2);
  assert.equal(f.overlayRequests, 0);
});

test('/btw refuses a duplicate panel and session navigation closes the original', async (t) => {
  await agentRoot(t);
  const f = fixture();
  const pending = f.invoke();
  await f.invoke('second question');
  assert.equal(f.mounts, 1);
  assert.equal(f.overlayRequests, 0, '/btw docks inline instead of floating over the transcript');
  assert.match(f.notices[0]!, /already open/);
  await f.events.get('session_tree')!();
  await pending;
  assert.equal(f.mainAborts, 0);
  assert.deepEqual(f.manager.getBranch(), f.before);
});

test('/btw shutdown closes the panel before a queued initial question runs', async (t) => {
  await agentRoot(t);
  const f = fixture();
  const pending = f.invoke('why?');
  await f.events.get('session_shutdown')!();
  await pending;
  assert.equal(f.mainAborts, 0);
  assert.deepEqual(f.manager.getBranch(), f.before);
});

test('/btw rejects modes without a custom terminal UI', async (t) => {
  await agentRoot(t);
  for (const mode of ['print', 'rpc'] as const) {
    const f = fixture(mode);
    await f.invoke('why?');
    assert.equal(f.mounts, 0);
    assert.match(f.notices[0]!, /interactive terminal/);
  }
});

test('/btw refuses a terminal that cannot hold the dock minimum', async (t) => {
  await agentRoot(t);
  const f = fixture('tui', 6);
  await f.invoke('too small');

  assert.equal(f.mounts, 1, 'the command asks the SDK for the editor slot once');
  assert.equal(f.mounted, 0, 'the dock is never mounted below its minimum rows');
  assert.equal(f.panel, undefined);
  assert.match(f.notices[0] ?? '', /prefers at least 9 terminal rows for its 8-row dock; this terminal has 6/);
  assert.deepEqual(f.manager.getBranch(), f.before, 'a refused open leaves Main untouched');
});

test('/btw honours a configured minimum dock height', async (t) => {
  const root = await agentRoot(t);
  await writeHarnessConfig(root, { btw: { panelMinRows: 12 } });
  const f = fixture('tui', 20);
  const pending = f.invoke();
  assert.ok(f.panel);
  assert.equal(f.panel.render(60).length, 12, 'the configured floor wins over half of the claimable rows');
  f.panel.handleInput('\x1b');
  await pending;
});

test('/btw refuses a configured floor taller than the terminal', async (t) => {
  const root = await agentRoot(t);
  await writeHarnessConfig(root, { btw: { panelMinRows: 30 } });
  const f = fixture('tui', 24);
  await f.invoke('floor too tall');

  assert.equal(f.mounted, 0);
  assert.match(f.notices[0] ?? '', /prefers at least 31 terminal rows for its 30-row dock; this terminal has 24/);
});

test('/btw opens exactly at the required height and refuses one row short', async (t) => {
  await agentRoot(t);

  const exact = fixture('tui', 9);
  const pending = exact.invoke();
  assert.ok(exact.panel, 'nine rows are the preferred minimum plus one row for Main');
  assert.equal(exact.panel.render(60).length, 8, 'the dock keeps its configured minimum');
  exact.panel.handleInput('\x1b');
  await pending;

  const short = fixture('tui', 8);
  await short.invoke();
  assert.equal(short.mounted, 0, 'eight rows cannot hold the preferred minimum and a Main row');
  assert.match(short.notices[0] ?? '', /prefers at least 9 terminal rows/);
});


test('/btw refuses the regular renderer instead of shipping a keyboard-only dock', async (t) => {
  await agentRoot(t);
  const f = fixture('tui', 24, 'regular');
  await f.invoke('no mouse here');

  assert.equal(f.mounted, 0, 'the regular renderer never delivers mouse input to the dock');
  assert.match(f.notices[0] ?? '', /needs fullscreen TUI mode/);
  assert.deepEqual(f.manager.getBranch(), f.before);
});

/** A scripted assistant reply the offline runtime can stream. */
function scriptedReply(model: Model<Api>, text: string): AssistantMessageEventStream {
  const message: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
    usage: {
      input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'text_start', contentIndex: 0, partial: message });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end();
  return stream;
}

interface RealCommand {
  readonly invoke: (args: string) => Promise<void>;
  readonly notices: string[];
  readonly panels: BtwPanel[];
  readonly session: AgentSession;
  text(index: number): string;
}

/** The real-SDK fixture: a genuine parent session and command context. */
async function realCommand(t: TestContext): Promise<RealCommand> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-btw-command-real-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const socketDir = path.join(cwd, 'uds');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = socketDir;

  let session: AgentSession | undefined;
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* stale */ }
    try { session?.dispose(); } catch { /* already disposed */ }
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
    await rm(cwd, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'btw-command-fixture' }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const model = faux.models[0]! as Model<Api>;
  let replies = 0;
  runtime.streamSimple = (requestModel) => {
    replies++;
    return scriptedReply(requestModel as Model<Api>, `BTW_ANSWER_${String(replies)}`);
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
  });
  const commands = new Map<string, Command>();
  const panels: BtwPanel[] = [];
  const notices: string[] = [];
  let parentApi: ExtensionAPI | undefined;
  let parentCtx: ExtensionContext | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'PARENT_SYSTEM',
    extensionFactories: [{
      name: 'btw-command-real-fixture',
      factory(pi: ExtensionAPI) {
        parentApi = pi;
        pi.on('session_start', (_event, ctx) => { parentCtx = ctx; });
        const register = pi.registerCommand.bind(pi);
        pi.registerCommand = (name, command) => {
          commands.set(name, command);
          return register(name, command);
        };
        installBtwCommand(pi);
      },
    }],
  });
  await resourceLoader.reload();
  session = (await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'low', tools: [],
  })).session;
  await session.bindExtensions({});
  assert.ok(parentApi, 'the parent extension factory ran');
  assert.ok(parentCtx, 'session_start captured the real ExtensionContext');
  const api = parentApi;
  const base = parentCtx;

  const ctx = {
    ...base,
    mode: 'tui' as const,
    hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => BtwPanel) {
        return new Promise<void>((resolve, reject) => {
          let created: BtwPanel;
          try {
            created = factory(
              { mode: 'fullscreen', terminal: { rows: 30, columns: 100 }, requestRender() {} } as unknown as TUI,
              (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('@earendil-works/pi-coding-agent:theme')] as Theme,
              new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
              resolve,
            );
          } catch (error) {
            reject(error);
            return;
          }
          panels.push(created);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  return {
    session,
    notices,
    panels,
    async invoke(args: string): Promise<void> { await commands.get('btw')!.handler(args, ctx); },
    text(index: number): string {
      return (panels[index]?.render(100) ?? []).join('\n');
    },
  };
}

test('a rejected session cleanup still reports and lets /btw open again', async (t) => {
  initTheme('dark');
  const h = await realCommand(t);
  const parentSessionId = h.session.sessionManager.getSessionId();
  // A parent-loaded provider hook that fails for every non-parent session: the
  // /btw session does not load extensions of its own, so this is its only source.
  const unregister = registerSessionResourceCleanup((id) => {
    if (id !== parentSessionId) throw new Error('provider cleanup exploded');
  });
  t.after(unregister);

  const first = h.invoke('side question');
  await waitForText(h, 0, /BTW_ANSWER_1/);
  h.panels[0]!.handleInput('\x1b');
  await first;

  assert.equal(h.panels.length, 1, 'one dock was mounted');
  assert.ok(
    h.notices.some((notice) => /Closed \/btw, but its session cleanup failed: .*provider cleanup exploded/.test(notice)),
    `the failing cleanup is reported, not hidden: ${JSON.stringify(h.notices)}`,
  );

  // The command stays pending until the dock closes, so start it and observe the mount.
  const second = h.invoke('another question');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.panels.length, 2, 'the failed cleanup did not leave the command permanently open');
  assert.doesNotMatch(h.notices.join('\n'), /already open or closing/);
  h.panels[1]!.handleInput('\x1b');
  await second;
});

async function waitForText(h: RealCommand, index: number, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (pattern.test(h.text(index))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the side answer never appeared: ${h.text(index).slice(0, 400)}`);
}
