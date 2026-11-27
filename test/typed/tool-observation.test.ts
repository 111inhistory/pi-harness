import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type SessionEntry,
  type ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import {
  createLiveToolObservationTracker,
  extractBranchToolObservations,
  installToolObservation,
  parseCodemodeToolDetails,
  type ToolObservation,
} from '../../src/tool-observation.ts';

test('real SDK captures live nested -> outer order, typed codemode details, and persisted nested completeness', { timeout: 30000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-tool-obs-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  await mkdir(agentDir, { recursive: true });

  const liveObservations: ToolObservation[] = [];
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;

    const reply = (content: unknown[], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content,
      stopReason,
      timestamp: Date.now(),
      usage: {
        input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    } as AssistantMessage);

    let step = 0;
    const bigPayload = 'x'.repeat(9 * 1024);
    runtime.streamSimple = () => {
      const stream = new AssistantMessageEventStream();
      step += 1;
      let message: AssistantMessage;
      if (step === 1) {
        message = reply([{
          type: 'toolCall',
          id: 'call-cm-nested',
          name: 'codemode',
          arguments: {
            code: [
              'const okRes = await tools.echo_probe({ label: "alpha" });',
              'let errMsg = "";',
              'try { await tools.fail_probe({ label: "beta" }); } catch (e) { errMsg = e.message; }',
              'return { okRes, errMsg };',
            ].join('\n'),
          },
        }], 'toolUse');
      } else if (step === 2) {
        message = reply([{ type: 'text', text: 'turn 1 done' }], 'stop');
      } else if (step === 3) {
        // Runtime SyntaxError: proves error.kind="script" + name="SyntaxError" is not a compile-phase guarantee.
        message = reply([{
          type: 'toolCall',
          id: 'call-cm-syntax-throw',
          name: 'codemode',
          arguments: { code: 'throw new SyntaxError("runtime throw");' },
        }], 'toolUse');
      } else if (step === 4) {
        // Pure script with zero nested calls.
        message = reply([{
          type: 'toolCall',
          id: 'call-cm-pure',
          name: 'codemode',
          arguments: { code: 'return "pure-value";' },
        }], 'toolUse');
      } else if (step === 5) {
        // Exceeds SDK NESTED_CALL_LIMITS.maxArgumentBytesPerCall (8 KiB) -> persisted nestedCalls.complete === false.
        message = reply([{
          type: 'toolCall',
          id: 'call-cm-big-arg',
          name: 'codemode',
          arguments: { code: `return await tools.echo_probe({ label: ${JSON.stringify(bigPayload)} });` },
        }], 'toolUse');
      } else {
        message = reply([{ type: 'text', text: 'turn 2 done' }], 'stop');
      }
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      });
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({ codemode: { mode: 'on' } });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.registerTool({
            name: 'echo_probe',
            label: 'Echo probe',
            description: 'Echoes label',
            parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } as never,
            async execute(_id, params) {
              const label = String((params as { label: string }).label);
              return { content: [{ type: 'text', text: `echo:${label.length}` }], details: { ok: true } };
            },
          });
          pi.registerTool({
            name: 'fail_probe',
            label: 'Fail probe',
            description: 'Always fails',
            parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } as never,
            async execute(_id, params) {
              const label = String((params as { label: string }).label);
              return { content: [{ type: 'text', text: `boom:${label}` }], details: { failed: true }, isError: true };
            },
          });
          installCapabilityCodemode(pi, () => () => true, () => () => true);
          installToolObservation(pi, (obs) => { liveObservations.push(obs); });
        },
      ],
    });
    await resourceLoader.reload();

    const extensionErrors: unknown[] = [];
    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    session.setActiveToolsByName(['codemode', 'echo_probe', 'fail_probe']);

    await session.prompt('run turn 1');
    await session.prompt('run turn 2');
    assert.deepEqual(extensionErrors, []);

    // 1) Verify live order: nested events strictly precede outer codemode event, with zero duplicates.
    const turn1Ids = liveObservations.slice(0, 3).map((o) => o.callId);
    assert.deepEqual(turn1Ids, ['call-cm-nested/1', 'call-cm-nested/2', 'call-cm-nested']);
    assert.equal(new Set(liveObservations.map((o) => o.callId)).size, liveObservations.length);

    const [nestedOk, nestedErr, outerCm] = liveObservations.slice(0, 3);
    assert.equal(nestedOk!.isNested, true);
    assert.equal(nestedOk!.parentCallId, 'call-cm-nested');
    assert.equal(nestedOk!.toolName, 'echo_probe');
    assert.equal(nestedOk!.status, 'ok');
    assert.equal(nestedOk!.isError, false);
    assert.deepEqual(nestedOk!.input, { label: 'alpha' });

    assert.equal(nestedErr!.isNested, true);
    assert.equal(nestedErr!.parentCallId, 'call-cm-nested');
    assert.equal(nestedErr!.toolName, 'fail_probe');
    assert.equal(nestedErr!.status, 'error');
    assert.equal(nestedErr!.isError, true);
    assert.deepEqual(nestedErr!.input, { label: 'beta' });

    assert.equal(outerCm!.isNested, false);
    assert.equal(outerCm!.toolName, 'codemode');
    assert.equal(outerCm!.status, 'ok');
    assert.equal(outerCm!.nestedCompleteness, 'complete');
    assert.deepEqual(outerCm!.nestedCallIds, ['call-cm-nested/1', 'call-cm-nested/2']);
    assert.equal(outerCm!.codemode?.ok, true);
    assert.equal(outerCm!.codemode?.truncated, false);
    assert.equal(typeof outerCm!.codemode?.durationMs, 'number');
    const parsedDetails = parseCodemodeToolDetails(outerCm!.details);
    assert.ok(parsedDetails !== null);
    assert.deepEqual(parsedDetails.calls.map((c) => [c.id, c.name, c.status]), [
      ['call-cm-nested/1', 'echo_probe', 'ok'],
      ['call-cm-nested/2', 'fail_probe', 'error'],
    ]);

    // 2) Verify runtime SyntaxError reports raw kind + name without inventing a compile phase.
    const syntaxObs = liveObservations.find((o) => o.callId === 'call-cm-syntax-throw');
    assert.ok(syntaxObs !== undefined);
    assert.equal(syntaxObs.isError, true);
    assert.equal(syntaxObs.codemode?.ok, false);
    assert.deepEqual(syntaxObs.codemode?.error, { kind: 'script', name: 'SyntaxError' });
    assert.equal('phase' in (syntaxObs.codemode?.error ?? {}), false);

    // 3) Verify pure zero-nested codemode reports nestedCompleteness: 'none' live.
    const pureObs = liveObservations.find((o) => o.callId === 'call-cm-pure');
    assert.ok(pureObs !== undefined);
    assert.equal(pureObs.nestedCompleteness, 'none');

    // 4) Verify oversized nested argument was complete live, then becomes 'unknown' on persisted branch recovery.
    const bigLiveNested = liveObservations.find((o) => o.callId === 'call-cm-big-arg/1');
    const bigLiveOuter = liveObservations.find((o) => o.callId === 'call-cm-big-arg');
    assert.equal((bigLiveNested?.input?.['label'] as string | undefined)?.length, bigPayload.length);
    assert.equal(bigLiveOuter?.nestedCompleteness, 'complete');

    // 5) Recover observations from the real persisted SDK branch.
    const branchObs = extractBranchToolObservations(session.sessionManager.getBranch());
    assert.equal(new Set(branchObs.map((o) => o.callId)).size, branchObs.length);

    const b1Idx = branchObs.findIndex((o) => o.callId === 'call-cm-nested/1');
    const b2Idx = branchObs.findIndex((o) => o.callId === 'call-cm-nested/2');
    const bOuterIdx = branchObs.findIndex((o) => o.callId === 'call-cm-nested');
    assert.ok(b1Idx >= 0 && b1Idx < b2Idx && b2Idx < bOuterIdx);
    assert.deepEqual(branchObs[b1Idx]!.input, { label: 'alpha' });
    assert.equal(branchObs[b2Idx]!.status, 'error');
    assert.equal(branchObs[bOuterIdx]!.nestedCompleteness, 'complete');
    assert.deepEqual(branchObs[bOuterIdx]!.nestedCallIds, ['call-cm-nested/1', 'call-cm-nested/2']);

    const bPure = branchObs.find((o) => o.callId === 'call-cm-pure');
    assert.equal(bPure?.nestedCompleteness, 'none');

    const bBigNested = branchObs.find((o) => o.callId === 'call-cm-big-arg/1');
    const bBigOuter = branchObs.find((o) => o.callId === 'call-cm-big-arg');
    assert.equal(bBigNested?.input, undefined);
    assert.ok((bBigNested?.inputBytes ?? 0) > 8 * 1024);
    assert.equal(bBigOuter?.nestedCompleteness, 'unknown');
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('branch recovery marks legacy codemode entries lacking nestedCalls as unknown and deduplicates call IDs', () => {
  const legacyBranch: SessionEntry[] = [
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-11-27T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'legacy-cm', name: 'codemode', arguments: { code: 'await tools.bash({ command: "ls" });' } }],
        api: 'openai-responses',
        provider: 'fake-provider',
        model: 'fake-model',
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
        stopReason: 'toolUse',
        timestamp: 1,
      },
    },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-11-27T00:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'legacy-cm',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'Script completed' }],
        // Legacy pre-1.6.1 details (no typed ok/durationMs, no message.nestedCalls)
        details: { calls: [{ id: 'legacy-cm/1', name: 'bash', args: '{"command":"ls"}', status: 'ok' }] },
        isError: false,
        timestamp: 2,
      },
    },
    // Duplicate toolResult entry with same callId should be ignored.
    {
      type: 'message',
      id: 'e3',
      parentId: 'e2',
      timestamp: '2026-11-27T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'legacy-cm',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'duplicate' }],
        isError: false,
        timestamp: 3,
      },
    },
  ];

  const obs = extractBranchToolObservations(legacyBranch);
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.callId, 'legacy-cm');
  assert.equal(obs[0]!.nestedCompleteness, 'unknown');
  assert.equal(obs[0]!.codemode, undefined);
  assert.deepEqual(obs[0]!.input, { code: 'await tools.bash({ command: "ls" });' });
});

test('live tracker deduplicates call IDs, detects unobserved placeholder calls, and clears on reset', () => {
  const tracker = createLiveToolObservationTracker();
  const nestedEvent = {
    type: 'tool_result',
    toolCallId: 'p1/1',
    parentToolCallId: 'p1',
    toolName: 'read',
    input: { path: 'a.ts' },
    content: [{ type: 'text', text: 'ok' }],
    details: undefined,
    isError: false,
  } as ToolResultEvent;

  assert.ok(tracker.observe(nestedEvent) !== null);
  assert.equal(tracker.observe(nestedEvent), null, 'duplicate callId is dropped');

  // Outer codemode reports a second call whose id stayed placeholder "p1/?" (never observed live).
  const outerEvent = {
    type: 'tool_result',
    toolCallId: 'p1',
    toolName: 'codemode',
    input: { code: '...' },
    content: [{ type: 'text', text: 'Script failed' }],
    details: {
      calls: [
        { id: 'p1/1', name: 'read', args: '{"path":"a.ts"}', status: 'ok' },
        { id: 'p1/?', name: 'bash', args: '{"command":"sleep 9"}', status: 'cancelled' },
      ],
      ok: false,
      durationMs: 12,
      truncated: false,
      error: { kind: 'aborted' },
    },
    isError: true,
  } as ToolResultEvent;

  const outer = tracker.observe(outerEvent);
  assert.ok(outer !== null);
  assert.equal(outer.status, 'cancelled');
  assert.equal(outer.nestedCompleteness, 'unknown');
  assert.deepEqual(outer.nestedCallIds, ['p1/1']);

  tracker.reset();
  assert.ok(tracker.observe(nestedEvent) !== null, 'reset clears bounded deduplication state');
});

test('bounded tracker caps call IDs and parent buckets, degrading to unknown on overflow', () => {
  const tracker = createLiveToolObservationTracker({ maxTrackedCallIds: 2, maxTrackedParents: 1, maxChildrenPerParent: 1 });
  const mkNested = (id: string, parent: string) => ({
    type: 'tool_result',
    toolCallId: id,
    parentToolCallId: parent,
    toolName: 'read',
    input: { path: 'a.ts' },
    content: [],
    details: undefined,
    isError: false,
  } as ToolResultEvent);
  const mkOuter = (id: string, calls: { id: string; name: string; args: string; status: 'ok' }[]) => ({
    type: 'tool_result',
    toolCallId: id,
    toolName: 'codemode',
    input: { code: '' },
    content: [],
    details: { calls, ok: true, durationMs: 1, truncated: false },
    isError: false,
  } as ToolResultEvent);

  // Exceed maxTrackedCallIds (2): 3rd event triggers overflow and degrades outer to 'unknown'.
  assert.ok(tracker.observe(mkNested('p1/1', 'p1')) !== null);
  assert.ok(tracker.observe(mkNested('p1/2', 'p1')) !== null);
  const outerOverflow = tracker.observe(mkOuter('p1', [{ id: 'p1/1', name: 'read', args: '{}', status: 'ok' }]));
  assert.equal(outerOverflow?.nestedCompleteness, 'unknown');

  // Reset restores normal bounded tracking; test maxTrackedParents (1).
  tracker.reset();
  const parentTracker = createLiveToolObservationTracker({ maxTrackedCallIds: 10, maxTrackedParents: 1, maxChildrenPerParent: 5 });
  assert.ok(parentTracker.observe(mkNested('a/1', 'a')) !== null);
  assert.ok(parentTracker.observe(mkNested('b/1', 'b')) !== null);
  const bOuter = parentTracker.observe(mkOuter('b', [{ id: 'b/1', name: 'read', args: '{}', status: 'ok' }]));
  assert.equal(bOuter?.nestedCompleteness, 'unknown');
});

test('installToolObservation invokes every pi.on off handler idempotently on dispose and session_shutdown', () => {
  const makeMockPi = () => {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const offCalls: string[] = [];
    const pi = {
      on(event: string, handler: (...args: unknown[]) => void) {
        let set = handlers.get(event);
        if (!set) { set = new Set(); handlers.set(event, set); }
        set.add(handler);
        return () => {
          offCalls.push(event);
          set!.delete(handler);
        };
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers, offCalls };
  };

  // Case 1: explicit dispose detaches all handlers and is idempotent.
  {
    const { pi, handlers, offCalls } = makeMockPi();
    const received: ToolObservation[] = [];
    const dispose = installToolObservation(pi, (obs) => received.push(obs));
    assert.equal(handlers.get('tool_result')?.size, 1);
    dispose();
    dispose();
    assert.equal(offCalls.length, 7);
    for (const set of handlers.values()) assert.equal(set.size, 0);
    assert.equal(received.length, 0);
  }

  // Case 2: session_shutdown detaches all handlers and later dispose() is a safe no-op.
  {
    const { pi, handlers, offCalls } = makeMockPi();
    const dispose = installToolObservation(pi, () => {});
    const shutdownHandlers = [...(handlers.get('session_shutdown') ?? [])];
    assert.equal(shutdownHandlers.length, 1);
    shutdownHandlers[0]!();
    assert.equal(offCalls.length, 7);
    for (const set of handlers.values()) assert.equal(set.size, 0);
    dispose();
    assert.equal(offCalls.length, 7);
  }
});
