/**
 * Capability activation reachability.
 *
 * A selected tool is only publishable when the model has some execution entry
 * for it. A `deferred`/`direct` tool is declared once active, so it needs no
 * Codemode. A `codemode`-exposure tool is only callable from a script, so it is
 * unreachable unless this session has an active, eligible Codemode entry. These
 * cases pin the shared judgement used by model discovery and `/capability
 * enable`, and that a dropped member never becomes a successful selection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateToolNames, codemodeAvailable, toolReachability, type ActivationHost,
} from '../../src/capability/activation.ts';
import {
  describeEnableSkip, enableCapabilityTargets,
} from '../../src/capability/enable.ts';
import { retainReachableSelectedTools } from '../../src/capability/tool-catalog.ts';
import { manualToolMatcher } from '../../src/capability/manual-tools.ts';
import { setCapabilityRootOnlyPolicy } from '../../src/capability/scope.ts';

interface FakeTool {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name: string; aliases?: readonly string[] };
}

type Entry = { type: string; customType: string; data?: unknown };

function host(initial: readonly FakeTool[], active: readonly string[] = []) {
  const state = {
    tools: initial.map((tool) => ({ ...tool })),
    active: new Set(active),
    entries: [] as Entry[],
  };
  const api: ActivationHost & { appendEntry(type: string, data?: unknown): void } = {
    getAllTools: () => state.tools,
    getActiveTools: () => [...state.active],
    setActiveTools(names: string[]) {
      state.active = new Set(names.filter((name) => state.tools.some(
        (tool) => tool.name === name && tool.exposure !== 'hidden')));
    },
    appendEntry(customType: string, data?: unknown) {
      state.entries.push({ type: 'custom', customType, data });
    },
  };
  return { api, activeNames: () => [...state.active], entries: () => state.entries };
}

const baseTools: readonly FakeTool[] = [
  { name: 'deferred_tool', description: 'Deferred', exposure: 'deferred' },
  { name: 'direct_tool', description: 'Direct', exposure: 'direct' },
  { name: 'codemode_only', description: 'Script only', exposure: 'codemode' },
  { name: 'hidden_tool', description: 'Hidden', exposure: 'hidden' },
  { name: 'manual_script', description: 'Manual script', exposure: 'codemode' },
  { name: 'codemode', description: 'Run scripts', exposure: 'direct' },
];

test('reachability depends on the exposure and whether Codemode is usable', () => {
  const off = { codemodeAvailable: false };
  const on = { codemodeAvailable: true };
  assert.equal(toolReachability('deferred', off), null, 'deferred is declared when active');
  assert.equal(toolReachability('direct', off), null, 'direct is declared when active');
  assert.equal(toolReachability(undefined, off), null, 'an unset exposure is direct');
  assert.equal(toolReachability('codemode', off), 'unreachable', 'script-only needs Codemode');
  assert.equal(toolReachability('codemode', on), null, 'script-only is reachable with Codemode');
});

test('codemodeAvailability requires an active and eligible Codemode tool', () => {
  const inactive = host(baseTools, []);
  assert.equal(codemodeAvailable(inactive.api), false);
  const active = host(baseTools, ['codemode']);
  assert.equal(codemodeAvailable(active.api), true);
  const missing = host([{ name: 'deferred_tool', exposure: 'deferred' }], []);
  assert.equal(codemodeAvailable(missing.api), false);
});

test('activation accepts deferred/direct tools and refuses a script-only tool without Codemode', () => {
  const fixture = host(baseTools, []);
  const outcome = activateToolNames(fixture.api, ['deferred_tool', 'direct_tool', 'codemode_only']);
  assert.deepEqual([...outcome.activated].sort(), ['deferred_tool', 'direct_tool']);
  assert.deepEqual(outcome.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.ok(fixture.activeNames().includes('deferred_tool'));
  assert.ok(fixture.activeNames().includes('direct_tool'));
  assert.ok(!fixture.activeNames().includes('codemode_only'));
});

test('a script-only tool activates once Codemode is active and eligible', () => {
  const fixture = host(baseTools, ['codemode']);
  const outcome = activateToolNames(fixture.api, ['codemode_only']);
  assert.deepEqual(outcome.activated, ['codemode_only']);
  assert.deepEqual(outcome.skipped, []);
});

test('reachability is checked after the existing hidden/manual/scope reasons', () => {
  const fixture = host(baseTools, []);
  setCapabilityRootOnlyPolicy(fixture.api, manualToolMatcher(['manual_script']));
  const outcome = activateToolNames(fixture.api, ['hidden_tool', 'manual_script', 'codemode_only']);
  assert.deepEqual(outcome.skipped, [
    { name: 'hidden_tool', reason: 'hidden' },
    { name: 'manual_script', reason: 'manual_only' },
    { name: 'codemode_only', reason: 'unreachable' },
  ]);
});

test('retainReachableSelectedTools drops only unreachable members and keeps non-tool identities', () => {
  const fixture = host(baseTools, []);
  const result = {
    status: 'ok' as const,
    tools: [
      { ref: 'tool://deferred_tool', name: 'deferred_tool', kind: 'tool' },
      { ref: 'tool://codemode_only', name: 'codemode_only', kind: 'tool' },
    ],
    mcp: [
      { ref: 'mcp://srv', name: 'srv_group', kind: 'mcp', tools: [
        { ref: 'tool://deferred_tool', name: 'deferred_tool', kind: 'tool' },
        { ref: 'tool://codemode_only', name: 'codemode_only', kind: 'tool' },
      ] },
    ],
    skills: [],
  };
  const retained = retainReachableSelectedTools(
    result, fixture.api, (tool) => toolReachability(tool.exposure, { codemodeAvailable: false }) === null,
  );
  assert.deepEqual([...retained.dropped].sort(), ['codemode_only', 'codemode_only']);
  assert.deepEqual(retained.result.tools.map((hit) => hit.name), ['deferred_tool']);
  assert.deepEqual(retained.result.mcp[0]?.tools?.map((member) => member.name), ['deferred_tool']);
  assert.equal((retained.result.mcp[0] as { toolCount?: number } | undefined)?.toolCount, 1);
});

test('/capability enable refuses a script-only tool while Codemode is off and records nothing', () => {
  const fixture = host(baseTools, []);
  const result = enableCapabilityTargets(fixture.api, ['codemode_only']);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.equal(fixture.entries().length, 0, 'no discovery or manual record for an unreachable tool');
});

test('/capability enable records a script-only tool once Codemode is active', () => {
  const fixture = host(baseTools, ['codemode']);
  const result = enableCapabilityTargets(fixture.api, ['codemode_only']);
  assert.deepEqual(result.enabled, ['codemode_only']);
  assert.deepEqual(result.skipped, []);
  assert.equal(fixture.entries().length, 1);
});

test('the refusal text names the missing Codemode entry', () => {
  assert.match(describeEnableSkip({ name: 'codemode_only', reason: 'unreachable' }), /Codemode/);
});
