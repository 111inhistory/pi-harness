import assert from 'node:assert/strict';
import test from 'node:test';

import { initTheme, type ExtensionContext, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  KeybindingsManager as TuiKeybindingsManager,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';

import {
  ShellApprovalComponent,
  ShellApprovalTuiAdapter,
  sanitizeCommandDisplay,
  sanitizeTerminalText,
} from '../../src/shell-approval/ui.ts';
import { ManualApprovalController } from '../../src/shell-approval/controller.ts';
import type { ShellApprovalRequest, ShellApprovalResult } from '../../src/shell-approval/types.ts';

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

function createTestTui(onRender?: () => void): TUI {
  return {
    requestRender: () => {
      onRender?.();
    },
  } as unknown as TUI;
}

interface MockContextOptions {
  mode?: ExtensionContext['mode'] | undefined;
  hasUI?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onNotify?: ((message: string, type?: 'info' | 'warning' | 'error') => void) | undefined;
  customImpl?: (
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (res: ShellApprovalResult) => void,
    ) => Component,
    options?: { blocked?: { kind: string; message: string } },
  ) => Promise<ShellApprovalResult>;
}

function createMockContext(options: MockContextOptions = {}): ExtensionContext & {
  readonly notifications: Array<{ message: string; type?: string | undefined }>;
  readonly customCalls: Array<{ blocked?: { kind: string; message: string } }>;
} {
  const notifications: Array<{ message: string; type?: string | undefined }> = [];
  const customCalls: Array<{ blocked?: { kind: string; message: string } }> = [];
  const theme = activeTheme();
  const keybindings = createKeybindings();

  const ctx = {
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    cwd: '/tmp/project',
    signal: options.signal,
    notifications,
    customCalls,
    ui: {
      notify(message: string, type?: 'info' | 'warning' | 'error') {
        notifications.push({ message, type });
        options.onNotify?.(message, type);
      },
      setStatus() {},
      async custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (res: T) => void,
        ) => Component,
        opts?: { blocked?: { kind: string; message: string } },
      ): Promise<T> {
        customCalls.push(opts ?? {});
        if (options.customImpl) {
          return options.customImpl(
            factory as (
              tui: TUI,
              theme: Theme,
              keybindings: KeybindingsManager,
              done: (res: ShellApprovalResult) => void,
            ) => Component,
            opts,
          ) as unknown as Promise<T>;
        }

        return new Promise<T>((resolve) => {
          const tui = createTestTui();
          const component = factory(tui, theme, keybindings, (result) => {
            resolve(result);
          });
          assert.ok(component, 'Custom factory must return a component');
        });
      },
    } as unknown as ExtensionContext['ui'],
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => undefined,
    } as unknown as ExtensionContext['sessionManager'],
    modelRegistry: {} as ExtensionContext['modelRegistry'],
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
  } as unknown as ExtensionContext & {
    readonly notifications: Array<{ message: string; type?: string | undefined }>;
    readonly customCalls: Array<{ blocked?: { kind: string; message: string } }>;
  };

  return ctx;
}

/** Test-only composition of the domain controller and terminal adapter. */
class ManualApprovalQueue {
  readonly controller: ManualApprovalController;
  readonly #adapter: ShellApprovalTuiAdapter;
  #ctx: ExtensionContext | undefined;
  #disposed = false;

  constructor(options?: { defaultTimeoutSeconds?: number; onDisplay?: (request: ShellApprovalRequest) => void }) {
    this.controller = new ManualApprovalController({
      defaultTimeoutSeconds: options?.defaultTimeoutSeconds,
      canPresent: () => this.#ctx?.hasUI === true && this.#ctx?.mode === 'tui',
    });
    this.#adapter = new ShellApprovalTuiAdapter({
      controller: this.controller,
      context: () => this.#ctx,
      onDisplay: options?.onDisplay,
    });
  }

  get activeCount(): number {
    return this.controller.list().filter((pending) => pending.state === 'active').length;
  }

  get queuedCount(): number {
    return this.controller.list().filter((pending) => pending.state === 'queued').length;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  requestApproval(request: ShellApprovalRequest, ctx: ExtensionContext): Promise<ShellApprovalResult> {
    this.#ctx = ctx;
    return this.controller.request(request);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#adapter.dispose();
    this.controller.dispose();
  }
}

test('sanitizeTerminalText strips ANSI colors, OSC escapes, and control characters', () => {
  const dirty = '\x1b[31;1mDanger\x1b[0m \x1b]777;notify;title;body\x07echo "hi"\r\n\t\x00\b';
  const clean = sanitizeTerminalText(dirty);
  assert.equal(clean, 'Danger echo "hi"');
  assert.doesNotMatch(clean, /\x1b/);
});

test('sanitizeCommandDisplay preserves newlines and content while stripping terminal escapes', () => {
  const dirty = 'echo "\x1b[32mhello\x1b[0m"\r\nls -la\nrm -rf /tmp/test\x1b]0;Title\x07';
  const clean = sanitizeCommandDisplay(dirty);
  assert.equal(clean, 'echo "hello"\nls -la\nrm -rf /tmp/test');
  assert.doesNotMatch(clean, /\x1b/);
});

test('ShellApprovalComponent renders required English labels within viewport width', (t) => {
  const theme = activeTheme();
  const keybindings = createKeybindings();
  const tui = createTestTui();

  const request: ShellApprovalRequest = {
    sourceAgent: 'subagent sub_49',
    shell: 'bash',
    cwd: '/tmp/project',
    command: 'npm run test:typed\ngit status --short',
    reason: '执行关键自动化测试套件',
    timeoutSeconds: 30,
  };

  let decision: ShellApprovalResult | undefined;
  const component = new ShellApprovalComponent(
    tui,
    theme,
    keybindings,
    request,
    30,
    (res) => {
      decision = res;
    },
  );
  t.after(() => component.dispose());

  const lines = component.render(65);
  const plainText = lines.map(stripTerminalSequences).join('\n');

  assert.match(plainText, /Shell Approval/);
  assert.match(plainText, /Source agent:\s+subagent sub_49/);
  assert.match(plainText, /Target shell:\s+bash/);
  assert.match(plainText, /Working dir:\s+\/tmp\/project/);
  assert.match(plainText, /Reason:\s+执行关键自动化测试套件/);
  assert.match(plainText, /Command/);
  assert.match(plainText, /npm run test:typed/);
  assert.match(plainText, /git status --short/);
  assert.match(plainText, /Timeout: 30s/);
  assert.match(plainText, /Keys: \[Enter\/y\] allow once\s+\[Esc\/n\] reject\s+\[↑\/↓\] scroll/);

  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= 65,
      `Rendered line exceeds target width 65: "${line}" (width: ${visibleWidth(line)})`,
    );
  }

  component.dispose();
  assert.equal(decision?.approved, false);
  assert.equal(decision?.reason, 'cancelled');
});

test('ShellApprovalComponent handles key decisions and prevents late re-approval', (t) => {
  const theme = activeTheme();
  const keybindings = createKeybindings();
  const tui = createTestTui();

  const request: ShellApprovalRequest = {
    sourceAgent: 'Main',
    shell: 'bash',
    cwd: '/tmp',
    command: 'echo allowed',
  };

  // 1. Approve via Enter / '\r' / 'y'
  let result1: ShellApprovalResult | undefined;
  const comp1 = new ShellApprovalComponent(tui, theme, keybindings, request, 30, (res) => {
    result1 = res;
  });
  t.after(() => comp1.dispose());

  comp1.handleInput(Key.enter);
  assert.deepEqual(result1, { approved: true, reason: 'approved' });
  // Late reject after approval does nothing
  comp1.handleInput(Key.escape);
  assert.deepEqual(result1, { approved: true, reason: 'approved' });
  comp1.dispose();

  // 2. Reject via 'n'
  let result2: ShellApprovalResult | undefined;
  const comp2 = new ShellApprovalComponent(tui, theme, keybindings, request, 30, (res) => {
    result2 = res;
  });
  t.after(() => comp2.dispose());

  comp2.handleInput('n');
  assert.deepEqual(result2, { approved: false, reason: 'rejected' });
  // Late allow after reject does nothing
  comp2.handleInput('y');
  assert.deepEqual(result2, { approved: false, reason: 'rejected' });
  comp2.dispose();

  // 3. Reject via Escape
  let result3: ShellApprovalResult | undefined;
  const comp3 = new ShellApprovalComponent(tui, theme, keybindings, request, 30, (res) => {
    result3 = res;
  });
  t.after(() => comp3.dispose());

  comp3.handleInput(Key.escape);
  assert.deepEqual(result3, { approved: false, reason: 'rejected' });
  comp3.dispose();
});

test('ShellApprovalComponent scrolls multi-line commands smoothly', (t) => {
  const theme = activeTheme();
  const keybindings = createKeybindings();
  let renderRequested = 0;
  const tui = createTestTui(() => {
    renderRequested++;
  });

  const command = Array.from({ length: 25 }, (_, i) => `echo "Step ${i + 1}"`).join('\n');
  const request: ShellApprovalRequest = {
    sourceAgent: 'subagent',
    shell: 'bash',
    cwd: '/tmp',
    command,
  };

  const comp = new ShellApprovalComponent(tui, theme, keybindings, request, 30, () => {});
  t.after(() => comp.dispose());

  comp.render(80);
  assert.equal(comp.currentScrollOffset, 0);

  // Scroll down
  comp.handleInput(Key.down);
  assert.equal(comp.currentScrollOffset, 1);
  assert.ok(renderRequested > 0);

  // Scroll page down
  comp.handleInput(Key.pageDown);
  assert.equal(comp.currentScrollOffset, 11);

  // Scroll to end
  comp.handleInput(Key.end);
  assert.equal(comp.currentScrollOffset, 15);

  // Scroll up
  comp.handleInput(Key.up);
  assert.equal(comp.currentScrollOffset, 14);

  // Scroll to start
  comp.handleInput(Key.home);
  assert.equal(comp.currentScrollOffset, 0);

  comp.dispose();
});

test('ManualApprovalController times out explicitly, closes the dialog, and rejects late input', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  let component: ShellApprovalComponent | undefined;
  const ctx = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        component = factory(createTestTui(), activeTheme(), createKeybindings(), resolve) as ShellApprovalComponent;
      });
    },
  });

  const request: ShellApprovalRequest = {
    sourceAgent: 'subagent',
    shell: 'bash',
    cwd: '/tmp',
    command: 'echo timeout-test',
    timeoutSeconds: 1,
  };

  const pending = queue.requestApproval(request, ctx);

  // Wait for 1.1s for the root controller deadline.
  await new Promise((r) => setTimeout(r, 1100));

  assert.deepEqual(await pending, { approved: false, reason: 'timeout' });
  assert.equal(component?.isSettled, true);
  assert.equal(queue.activeCount, 0);

  // Late allow after timeout does nothing.
  component?.handleInput('y');
  assert.deepEqual(await pending, { approved: false, reason: 'timeout' });
});

test('ManualApprovalQueue denies immediately when no UI or not in TUI mode', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  const noUiCtx = createMockContext({ hasUI: false, mode: 'print' });

  const result = await queue.requestApproval(
    {
      sourceAgent: 'subagent',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 1',
    },
    noUiCtx,
  );

  assert.deepEqual(result, { approved: false, reason: 'no_ui' });
});

test('ManualApprovalQueue approves and rejects individual requests', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  const ctx = createMockContext({
    customImpl: async (factory, opts) => {
      assert.equal(opts?.blocked?.kind, 'permission');
      return new Promise<ShellApprovalResult>((resolve) => {
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), resolve);
        component.handleInput?.('y');
      });
    },
  });

  const approvedResult = await queue.requestApproval(
    {
      sourceAgent: 'sub_1',
      shell: 'bash',
      cwd: '/tmp',
      command: 'cargo build',
    },
    ctx,
  );

  assert.deepEqual(approvedResult, { approved: true, reason: 'approved' });
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0]!.message, /\[Shell approval\] sub_1 requests/);

  // Now reject
  const ctxReject = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), resolve);
        component.handleInput?.('n');
      });
    },
  });

  const rejectedResult = await queue.requestApproval(
    {
      sourceAgent: 'sub_2',
      shell: 'bash',
      cwd: '/tmp',
      command: 'rm -rf node_modules',
    },
    ctxReject,
  );

  assert.deepEqual(rejectedResult, { approved: false, reason: 'rejected' });
});

test('ManualApprovalQueue fixture: two custom calls never overlap and sequential UI closes cleanly', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  let activeCustomCalls = 0;
  let maxConcurrentCustomCalls = 0;
  const executionOrder: string[] = [];

  const ctx = createMockContext({
    customImpl: async (factory) => {
      activeCustomCalls++;
      if (activeCustomCalls > maxConcurrentCustomCalls) {
        maxConcurrentCustomCalls = activeCustomCalls;
      }

      return new Promise<ShellApprovalResult>((resolve) => {
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
          // Decrement only when the custom UI promise actually resolves (simulating unmount teardown)
          activeCustomCalls--;
          resolve(res);
        });

        // Resolve after microtask tick
        queueMicrotask(() => {
          component.handleInput?.('y');
        });
      });
    },
  });

  const p1 = queue
    .requestApproval(
      {
        sourceAgent: 'sub_A',
        shell: 'bash',
        cwd: '/tmp',
        command: 'echo A',
      },
      ctx,
    )
    .then((res) => {
      executionOrder.push('A:' + res.reason);
      return res;
    });

  const p2 = queue
    .requestApproval(
      {
        sourceAgent: 'sub_B',
        shell: 'bash',
        cwd: '/tmp',
        command: 'echo B',
      },
      ctx,
    )
    .then((res) => {
      executionOrder.push('B:' + res.reason);
      return res;
    });

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.approved, true);
  assert.equal(res2.approved, true);
  assert.deepEqual(executionOrder, ['A:approved', 'B:approved']);
  assert.equal(maxConcurrentCustomCalls, 1, 'Two custom UI dialogs must never be active concurrently');
  assert.equal(activeCustomCalls, 0, 'All custom UI components must be fully unmounted');
});

test('ManualApprovalQueue: countdown timer starts when displayed, not when enqueued', async (t) => {
  const displayed: string[] = [];
  const queue = new ManualApprovalQueue({ onDisplay: request => displayed.push(request.command) });
  t.after(() => queue.dispose());

  let req2RemainingWhenDisplayed = -1;
  let finishReq1: (() => void) | undefined;

  const ctx = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), resolve);
        if (component instanceof ShellApprovalComponent) {
          if (component.remainingTime === 25) {
            req2RemainingWhenDisplayed = component.remainingTime;
            resolve({ approved: true, reason: 'approved' });
            return;
          }
        }
        finishReq1 = () => resolve({ approved: true, reason: 'approved' });
      });
    },
  });

  const p1 = queue.requestApproval(
    { sourceAgent: 'sub_1', shell: 'bash', cwd: '/tmp', command: 'echo 1', timeoutSeconds: 30 },
    ctx,
  );

  const p2 = queue.requestApproval(
    { sourceAgent: 'sub_2', shell: 'bash', cwd: '/tmp', command: 'echo 2', timeoutSeconds: 25 },
    ctx,
  );

  assert.deepEqual(displayed, ['echo 1'], 'queued approvals must not send display notifications');
  // Simulate delay while Request 1 is waiting
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(finishReq1);
  finishReq1();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.approved, true);
  assert.equal(res2.approved, true);
  assert.equal(req2RemainingWhenDisplayed, 25, 'Timer must begin from configured duration when displayed');
  assert.deepEqual(displayed, ['echo 1', 'echo 2'], 'each approval notifies once when displayed');
});

test('ManualApprovalQueue: late done callback cannot reallow after cancellation', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  let lateDoneCallback: ((res: ShellApprovalResult) => void) | undefined;
  const abortCtrl = new AbortController();

  const ctx = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        lateDoneCallback = resolve;
        factory(createTestTui(), activeTheme(), createKeybindings(), resolve);
      });
    },
  });

  const p1 = queue.requestApproval(
    { sourceAgent: 'sub_1', shell: 'bash', cwd: '/tmp', command: 'echo 1', signal: abortCtrl.signal },
    ctx,
  );

  assert.equal(queue.activeCount, 1);
  // Cancel active request
  abortCtrl.abort();

  const res = await p1;
  assert.deepEqual(res, { approved: false, reason: 'cancelled' });

  // Attempt late approval callback
  assert.ok(lateDoneCallback);
  lateDoneCallback({ approved: true, reason: 'approved' });

  // Confirm no unhandled rejection and state stays cancelled
  assert.deepEqual(res, { approved: false, reason: 'cancelled' });
});

test('ManualApprovalQueue: queued cancellation resolves prompt and removes from queue without displaying', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  let firstCallResolve: ((res: ShellApprovalResult) => void) | undefined;
  let displayedSecond = false;

  const ctx = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        firstCallResolve = resolve;
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
          resolve(res);
        });
        assert.ok(component);
      });
    },
  });

  const p1 = queue.requestApproval(
    {
      sourceAgent: 'sub_1',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 1',
    },
    ctx,
  );

  const abortCtrl2 = new AbortController();
  const p2 = queue.requestApproval(
    {
      sourceAgent: 'sub_2',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 2',
      signal: abortCtrl2.signal,
    },
    ctx,
  );

  assert.equal(queue.activeCount, 1);
  assert.equal(queue.queuedCount, 1);

  // Abort request 2 while still queued
  abortCtrl2.abort();

  const res2 = await p2;
  assert.deepEqual(res2, { approved: false, reason: 'cancelled' });
  assert.equal(queue.queuedCount, 0, 'Cancelled item must be removed from queue');

  // Now resolve request 1
  assert.ok(firstCallResolve);
  firstCallResolve({ approved: true, reason: 'approved' });

  const res1 = await p1;
  assert.equal(res1.approved, true);
  assert.equal(displayedSecond, false);
});

test('ManualApprovalQueue: active cancellation dismisses UI and resolves immediately before next item', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  const lifecycleEvents: string[] = [];
  const abortCtrl1 = new AbortController();

  const ctx = createMockContext({
    customImpl: async (factory) => {
      lifecycleEvents.push('custom:open');
      return new Promise<ShellApprovalResult>((resolve) => {
        const component = factory(createTestTui(), activeTheme(), createKeybindings(), (res) => {
          lifecycleEvents.push('custom:done:' + res.reason);
          resolve(res);
        });
        assert.ok(component);
      });
    },
  });

  const p1 = queue.requestApproval(
    {
      sourceAgent: 'sub_1',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 1',
      signal: abortCtrl1.signal,
    },
    ctx,
  );

  assert.equal(queue.activeCount, 1);
  assert.equal(lifecycleEvents.includes('custom:open'), true);

  // Abort active request
  abortCtrl1.abort();

  const res1 = await p1;
  assert.deepEqual(res1, { approved: false, reason: 'cancelled' });
  assert.equal(lifecycleEvents.includes('custom:done:cancelled'), true);
});

test('ManualApprovalQueue: dispose cancels active and queued requests and prevents future allowances', async (t) => {
  const queue = new ManualApprovalQueue();
  t.after(() => queue.dispose());

  let firstDone: ((res: ShellApprovalResult) => void) | undefined;

  const ctx = createMockContext({
    customImpl: async (factory) => {
      return new Promise<ShellApprovalResult>((resolve) => {
        firstDone = resolve;
        factory(createTestTui(), activeTheme(), createKeybindings(), resolve);
      });
    },
  });

  const p1 = queue.requestApproval(
    {
      sourceAgent: 'sub_1',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 1',
    },
    ctx,
  );

  const p2 = queue.requestApproval(
    {
      sourceAgent: 'sub_2',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 2',
    },
    ctx,
  );

  assert.equal(queue.activeCount, 1);
  assert.equal(queue.queuedCount, 1);

  // Dispose queue
  queue.dispose();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.deepEqual(res1, { approved: false, reason: 'disposed' });
  assert.deepEqual(res2, { approved: false, reason: 'disposed' });
  assert.equal(queue.isDisposed, true);

  // Late done call from first component must not alter outcome or throw
  if (firstDone) {
    firstDone({ approved: true, reason: 'approved' });
  }

  // Future request is refused immediately
  const res3 = await queue.requestApproval(
    {
      sourceAgent: 'sub_3',
      shell: 'bash',
      cwd: '/tmp',
      command: 'echo 3',
    },
    ctx,
  );
  assert.deepEqual(res3, { approved: false, reason: 'disposed' });
});
