import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initTheme, type ExtensionContext, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  formatProgramStatus,
  Key,
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type ProgramStatus,
  type Terminal,
  type TUI,
} from '@earendil-works/pi-tui';

import {
  ShellApprovalComponent,
  sanitizeCommandDisplay,
  sanitizeTerminalText,
  ShellApprovalTuiAdapter,
} from '../../src/shell-approval/ui.ts';
import { ManualApprovalController } from '../../src/shell-approval/controller.ts';
import type { ShellApprovalRequest, ShellApprovalResult } from '../../src/shell-approval/types.ts';

function presentApprovals(t: test.TestContext, ctx: ExtensionContext) {
  const controller = new ManualApprovalController({ canPresent: () => ctx.hasUI && ctx.mode === 'tui' });
  const adapter = new ShellApprovalTuiAdapter({ controller, context: () => ctx });
  t.after(() => { controller.dispose(); adapter.dispose(); });
  return controller;
}

function activeTheme(): Theme {
  initTheme('dark');
  const theme = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@earendil-works/pi-coding-agent:theme')
  ];
  assert.ok(theme, 'Active theme must be initialized');
  return theme as Theme;
}

function createKeybindings(): KeybindingsManager {
  return new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
}

function createTestTui(): TUI {
  return {
    requestRender: () => {},
  } as unknown as TUI;
}

interface SdkProgramStatusReporter {
  setBlocked(source: string, status: { kind: 'permission' | 'question' | 'auth'; message: string } | undefined): void;
  report(): void;
}

/** Load Pi SDK's internal ProgramStatusReporter to verify exact OSC 7501 protocol pipeline. */
async function loadProgramStatusReporter(): Promise<new (getTerminal: () => Terminal, getSessionName: () => string | undefined) => SdkProgramStatusReporter> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const file = path.join(path.dirname(entry), 'modes/interactive/program-status-reporter.js');
  const module = await import(pathToFileURL(file).href) as unknown as { ProgramStatusReporter: new (getTerminal: () => Terminal, getSessionName: () => string | undefined) => SdkProgramStatusReporter };
  return module.ProgramStatusReporter;
}

/** Minimal terminal recording setProgramStatus calls. */
class ProgramStatusTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly reportedStatuses: ProgramStatus[] = [];
  readonly formattedSequences: string[] = [];

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  setProgramStatus(status: ProgramStatus): void {
    this.reportedStatuses.push(status);
    this.formattedSequences.push(formatProgramStatus(status));
  }
}

test('Pi SDK blocked permission -> OSC 7501 Program Status pipeline verification', async () => {
  const ProgramStatusReporterClass = await loadProgramStatusReporter();
  const terminal = new ProgramStatusTerminal();
  const reporter = new ProgramStatusReporterClass(
    () => terminal,
    () => 'test-root-session',
  );

  const blockedOption = {
    kind: 'permission' as const,
    message: 'Shell approval: git push --force',
  };

  // 1. Extension custom dialog opens with blocked option
  reporter.setBlocked('extension-dialog', blockedOption);

  assert.equal(terminal.reportedStatuses.length, 1);
  const latestStatus = terminal.reportedStatuses[0]!;
  assert.equal(latestStatus.state, 'blocked');
  assert.equal(latestStatus.kind, 'permission');
  assert.equal(latestStatus.message, 'Shell approval: git push --force');
  assert.equal(latestStatus.app, 'pi');

  // Verify formatted OSC 7501 sequence matches spec (\x1b]7501;... \x1b\)
  const oscSequence = terminal.formattedSequences[0]!;
  assert.ok(oscSequence.startsWith('\x1b]7501;'), `Must begin with OSC 7501: ${oscSequence}`);
  assert.ok(oscSequence.endsWith('\x1b\\') || oscSequence.endsWith('\x07'), `Must terminate with ST or BEL: ${oscSequence}`);
  assert.match(oscSequence, /state=blocked/);
  assert.match(oscSequence, /kind=permission/);
  assert.match(oscSequence, /app=pi/);

  // 2. Extension custom dialog closes (unmount)
  reporter.setBlocked('extension-dialog', undefined);

  assert.equal(terminal.reportedStatuses.length, 2);
  const clearedStatus = terminal.reportedStatuses[1]!;
  assert.notEqual(clearedStatus.state, 'blocked');
});

test('custom UI restoration fixture: queue never overlaps dialogs', async (t) => {

  const dialogStack: Component[] = [];
  let isEditorRestored = true;
  const events: string[] = [];

  const ctx: ExtensionContext = {
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp/project',
    signal: undefined,
    ui: {
      notify() {},
      setStatus() {},
      async custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (res: T) => void,
        ) => Component,
      ): Promise<T> {
        events.push('custom:start');
        isEditorRestored = false;

        return new Promise<T>((resolve) => {
          const component = factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
            events.push('done:called');
            // Simulate SDK InteractiveMode.restoreEditor()
            const idx = dialogStack.indexOf(component);
            if (idx !== -1) dialogStack.splice(idx, 1);
            isEditorRestored = dialogStack.length === 0;
            events.push('editor:restored');
            resolve(res);
          });

          dialogStack.push(component);
          assert.equal(dialogStack.length, 1, 'Only one custom component may be mounted at a time');

          queueMicrotask(() => {
            component.handleInput?.('y');
          });
        });
      },
    } as unknown as ExtensionContext['ui'],
    sessionManager: {} as unknown as ExtensionContext['sessionManager'],
    modelRegistry: {} as unknown as ExtensionContext['modelRegistry'],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  };

  const queue = presentApprovals(t, ctx);
  const req1: ShellApprovalRequest = { sourceAgent: 'agent_1', shell: 'bash', cwd: '/tmp', command: 'echo 1' };
  const req2: ShellApprovalRequest = { sourceAgent: 'agent_2', shell: 'bash', cwd: '/tmp', command: 'echo 2' };

  const p1 = queue.request(req1);
  const p2 = queue.request(req2);

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.approved, true);
  assert.equal(res2.approved, true);

  // Confirm exact order of lifecycle events:
  // custom:start -> done:called -> editor:restored -> custom:start -> done:called -> editor:restored
  assert.deepEqual(events, [
    'custom:start',
    'done:called',
    'editor:restored',
    'custom:start',
    'done:called',
    'editor:restored',
  ]);
  assert.equal(isEditorRestored, true);
});

test('Root session navigation cancellation: dispose closes active UI and resolves queue promptly without hanging', async (t) => {

  let activeCustomClosed = false;
  let activeComponent: Component | null = null;

  const ctx: ExtensionContext = {
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp/project',
    signal: undefined,
    ui: {
      notify() {},
      setStatus() {},
      async custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (res: T) => void,
        ) => Component,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          activeComponent = factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
            activeCustomClosed = true;
            resolve(res);
          });
        });
      },
    } as unknown as ExtensionContext['ui'],
    sessionManager: {} as unknown as ExtensionContext['sessionManager'],
    modelRegistry: {} as unknown as ExtensionContext['modelRegistry'],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  };

  const queue = presentApprovals(t, ctx);
  const p1 = queue.request({ sourceAgent: 'agent_1', shell: 'bash', cwd: '/tmp', command: 'sleep 10' });
  const p2 = queue.request({ sourceAgent: 'agent_2', shell: 'bash', cwd: '/tmp', command: 'sleep 20' });

  assert.equal(queue.list().filter(item => item.state === 'active').length, 1);
  assert.equal(queue.list().filter(item => item.state === 'queued').length, 1);
  assert.ok(activeComponent);

  // Simulate session_before_switch / session_before_fork
  queue.dispose();

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.deepEqual(res1, { approved: false, reason: 'disposed' });
  assert.deepEqual(res2, { approved: false, reason: 'disposed' });
  assert.equal(activeCustomClosed, true, 'Active custom dialog must close when session is navigated');
  assert.equal(queue.list().length, 0);
  assert.deepEqual(await queue.request({ sourceAgent: 'Main', shell: 'bash', cwd: '/tmp', command: 'echo disposed' }),
    { approved: false, reason: 'disposed' });
});

test('Ctrl-C abort signal immediately cancels active UI dialog and unblocks caller', async (t) => {

  const abortCtrl = new AbortController();
  let dialogUnmounted = false;

  const ctx: ExtensionContext = {
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp/project',
    signal: abortCtrl.signal, // Session-level abort (Ctrl-C)
    ui: {
      notify() {},
      setStatus() {},
      async custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (res: T) => void,
        ) => Component,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
            dialogUnmounted = true;
            resolve(res);
          });
        });
      },
    } as unknown as ExtensionContext['ui'],
    sessionManager: {} as unknown as ExtensionContext['sessionManager'],
    modelRegistry: {} as unknown as ExtensionContext['modelRegistry'],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  };

  const queue = presentApprovals(t, ctx);
  const p = queue.request(
    { sourceAgent: 'agent_1', shell: 'bash', cwd: '/tmp', command: 'echo test', signal: ctx.signal },
  );

  assert.equal(queue.list().length, 1);

  // Trigger Ctrl-C / interrupt
  abortCtrl.abort();

  const res = await p;
  assert.deepEqual(res, { approved: false, reason: 'cancelled' });
  assert.equal(dialogUnmounted, true, 'Custom UI must unmount upon Ctrl-C abort');
});

test('Literal escape commands (e.g. printf "\\x1b...") are preserved without loss of text', () => {
  const literalCommand = `printf '\\x1b[31mRed\\x1b[0m\\n' && echo "\\033[1mBold\\033[0m"`;
  const displayed = sanitizeCommandDisplay(literalCommand);
  assert.equal(displayed, literalCommand, 'Literal escape strings in commands must not be stripped');

  const titleWithLiteral = `run: printf '\\x1b[32m'`;
  const sanitizedTitle = sanitizeTerminalText(titleWithLiteral);
  assert.equal(sanitizedTitle, titleWithLiteral);
});
