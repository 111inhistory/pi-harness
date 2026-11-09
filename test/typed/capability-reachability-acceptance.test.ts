/**
 * P2 acceptance: model discovery and /capability enable must agree on which
 * selected tools the session can actually call, and a dropped member must never
 * become a successful selection. These cases drive the two public paths over the
 * same fixture: the discovery projection (`retainReachableSelectedTools` + the
 * shared `toolReachability`) and the user enable operation
 * (`enableCapabilityTargets`). They also pin that deferred/direct tools need no
 * Codemode, while a `codemode`-exposure member does, and that Skills survive a
 * dropped tool.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateToolNames, codemodeAvailable, toolReachability,
  type ActivationHost, type ReachabilityContext,
} from '../../src/capability/activation.ts';
import { enableCapabilityTargets } from '../../src/capability/enable.ts';
import { retainReachableSelectedTools } from '../../src/capability/tool-catalog.ts';

interface FakeTool {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name: string; aliases?: readonly string[] };
}
type Entry = { type: string; customType: string; data?: unknown };

function host(initial: readonly FakeTool[], active: readonly string[] = []) {
  const state = { tools: initial.map((tool) => ({ ...tool })), active: new Set(active), entries: [] as Entry[] };
  const api: ActivationHost & { appendEntry(type: string, data?: unknown): void } = {
    getAllTools: () => state.tools,
    getActiveTools: () => [...state.active],
    setActiveTools(names: string[]) {
      state.active = new Set(names.filter((name) => state.tools.some(
        (tool) => tool.name === name && tool.exposure !== 'hidden')));
    },
    appendEntry(customType: string, data?: unknown) { state.entries.push({ type: 'custom', customType, data }); },
  };
  return { api, activeNames: () => [...state.active], entries: () => state.entries };
}

const tools: readonly FakeTool[] = [
  { name: 'deferred_tool', exposure: 'deferred' },
  { name: 'direct_tool', exposure: 'direct' },
  { name: 'codemode_only', exposure: 'codemode' },
  { name: 'codemode', exposure: 'direct' },
];

const reachableUnder = (context: ReachabilityContext) =>
  (tool: { exposure?: string | undefined }) => toolReachability(tool.exposure, context) === null;

test('deferred and direct tools are callable with Codemode off; a codemode-only tool is not', () => {
  const off = host(tools, []);
  const context = { codemodeAvailable: codemodeAvailable(off.api) };
  assert.equal(context.codemodeAvailable, false);

  // Discovery path.
  const selection = {
    status: 'ok' as const,
    tools: [
      { ref: 'tool://deferred_tool', name: 'deferred_tool', kind: 'tool' },
      { ref: 'tool://direct_tool', name: 'direct_tool', kind: 'tool' },
      { ref: 'tool://codemode_only', name: 'codemode_only', kind: 'tool' },
    ],
    mcp: [],
    skills: [],
  };
  const retained = retainReachableSelectedTools(selection, off.api, reachableUnder(context));
  assert.deepEqual(retained.result.tools.map((hit) => hit.name), ['deferred_tool', 'direct_tool']);
  assert.deepEqual(retained.dropped, ['codemode_only']);

  // Enable path agrees.
  const enabled = enableCapabilityTargets(off.api, ['deferred_tool', 'direct_tool', 'codemode_only']);
  assert.deepEqual([...enabled.enabled].sort(), ['deferred_tool', 'direct_tool']);
  assert.deepEqual(enabled.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
});

test('enabling a mixed selection while Codemode is off records only the callable member', () => {
  const off = host(tools, []);
  const result = enableCapabilityTargets(off.api, ['deferred_tool', 'codemode_only']);
  assert.deepEqual(result.enabled, ['deferred_tool']);
  assert.deepEqual(result.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.equal(off.entries().length, 1, 'only the reachable member is recorded');
  const recorded = JSON.stringify(off.entries()[0]);
  assert.match(recorded, /deferred_tool/);
  assert.doesNotMatch(recorded, /codemode_only/);
});

test('a selection whose only tool is unreachable records nothing', () => {
  const off = host(tools, []);
  const result = enableCapabilityTargets(off.api, ['codemode_only']);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.equal(off.entries().length, 0, 'no discovery or manual record for an unreachable selection');
});

test('with Codemode active and eligible, both paths accept a codemode-only member', () => {
  const on = host(tools, ['codemode']);
  const context = { codemodeAvailable: codemodeAvailable(on.api) };
  assert.equal(context.codemodeAvailable, true);

  const selection = {
    status: 'ok' as const,
    tools: [{ ref: 'tool://codemode_only', name: 'codemode_only', kind: 'tool' }],
    mcp: [],
    skills: [],
  };
  assert.deepEqual(retainReachableSelectedTools(selection, on.api, reachableUnder(context)).dropped, []);

  const enabled = enableCapabilityTargets(on.api, ['codemode_only']);
  assert.deepEqual(enabled.enabled, ['codemode_only']);
  assert.deepEqual(enabled.skipped, []);
});

test('a Skill survives losing its only tool to reachability', () => {
  const off = host(tools, []);
  const context = { codemodeAvailable: codemodeAvailable(off.api) };
  const selection = {
    status: 'ok' as const,
    tools: [] as { ref: string; name: string; kind: string }[],
    mcp: [{ ref: 'mcp://srv', name: 'srv', kind: 'mcp', tools: [
      { ref: 'tool://codemode_only', name: 'codemode_only', kind: 'tool' },
    ] }],
    skills: [{ ref: 'skill://helpful', name: 'helpful', kind: 'skill' }],
  };
  const retained = retainReachableSelectedTools(selection, off.api, reachableUnder(context));
  assert.deepEqual(retained.dropped, ['codemode_only']);
  assert.equal(retained.result.mcp.length, 0, 'the empty MCP group is dropped');
  assert.deepEqual(retained.result.skills.map((s) => s.name), ['helpful'], 'a successful Skill is independent of tool reachability');
});

test('activation refuses a codemode-only tool but still activates deferred/direct (shared judgement)', () => {
  const off = host(tools, []);
  const outcome = activateToolNames(off.api, ['deferred_tool', 'direct_tool', 'codemode_only']);
  assert.deepEqual([...outcome.activated].sort(), ['deferred_tool', 'direct_tool']);
  assert.deepEqual(outcome.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
});
