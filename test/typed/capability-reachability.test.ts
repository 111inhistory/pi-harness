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
import { setCapabilityPermissionDefaults } from '../../src/capability/scope.ts';
import { explicitlyDisabled } from '../../src/capability/tool-permission.ts';

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

test('reachability is checked after the existing hidden/disabled/scope reasons', () => {
  const fixture = host(baseTools, []);
  setCapabilityPermissionDefaults(fixture.api, ['manual_script']);
  const outcome = activateToolNames(fixture.api, ['hidden_tool', 'manual_script', 'codemode_only'], {
    disabled: (name) => explicitlyDisabled(fixture.api, [], name),
  });
  assert.deepEqual(outcome.skipped, [
    { name: 'hidden_tool', reason: 'hidden' },
    { name: 'manual_script', reason: 'disabled' },
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

test('/capability enable records an enabled rule and reports an unreachable tool', () => {
  const fixture = host(baseTools, []);
  const result = enableCapabilityTargets(fixture.api, ['codemode_only']);
  assert.deepEqual(result.enabled, ['codemode_only'], 'the durable enabled rule is written');
  assert.deepEqual(result.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.equal(fixture.entries().length, 1, 'one permission record is written');
  assert.equal(fixture.api.getActiveTools().includes('codemode_only'), false, 'an unreachable tool is not activated');
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

test('the model-facing partial result keeps which members were not enabled', async () => {
  const { capabilityPublicResult } = await import('../../src/capability/result.ts');
  const result = {
    status: 'partial',
    tools: [] as unknown[],
    mcp: [] as unknown[],
    skills: [] as unknown[],
    remote: [] as unknown[],
    missingCapabilities: [] as string[],
    warnings: ['capability discovery is partial: 1 selected tool has no usable call path in this session.'],
    unavailable: [{ name: 'mcp__svc__run', reason: 'it needs an enabled Codemode entry in this session, but Codemode is not enabled' }],
  };
  const published = capabilityPublicResult(result) as { unavailable?: { name: string; reason: string }[]; warnings?: unknown };
  assert.deepEqual(published.unavailable?.map((entry) => entry.name), ['mcp__svc__run']);
  assert.match(String(published.unavailable?.[0]?.reason), /Codemode/);
  assert.equal(published.warnings, undefined, 'raw diagnostic warnings stay internal');
});

// Folded-in coverage from the former independent "acceptance" file: the model
// discovery projection and the user enable operation must agree on reachability,
// and a dropped member must never become a successful selection.

const reachableUnder = (context: { codemodeAvailable: boolean }) =>
  (tool: { exposure?: string | undefined }) => toolReachability(tool.exposure, context) === null;

test('discovery and /capability enable agree: deferred/direct pass, codemode-only is refused while Codemode is off', () => {
  const off = host(baseTools, []);
  const context = { codemodeAvailable: codemodeAvailable(off.api) };
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

  const enabled = enableCapabilityTargets(off.api, ['deferred_tool', 'direct_tool', 'codemode_only']);
  assert.deepEqual([...enabled.enabled].sort(), ['codemode_only', 'deferred_tool', 'direct_tool'],
    'the enabled rules are durable for every resolved target');
  assert.deepEqual(enabled.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
});

test('a mixed selection records both rules and activates only the reachable member', () => {
  const off = host(baseTools, []);
  const result = enableCapabilityTargets(off.api, ['deferred_tool', 'codemode_only']);
  assert.deepEqual([...result.enabled].sort(), ['codemode_only', 'deferred_tool']);
  assert.deepEqual(result.skipped, [{ name: 'codemode_only', reason: 'unreachable' }]);
  assert.equal(off.entries().length, 1, 'one permission record carries both rules');
  const recorded = JSON.stringify(off.entries()[0]);
  assert.match(recorded, /deferred_tool/);
  assert.match(recorded, /codemode_only/);
  assert.deepEqual(off.api.getActiveTools(), ['deferred_tool'], 'only the reachable member is activated');
});

test('a Skill survives losing its only tool to reachability', () => {
  const off = host(baseTools, []);
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
  assert.deepEqual(retained.result.skills.map((skill) => skill.name), ['helpful'], 'a Skill is independent of tool reachability');
});

test('with Codemode active, both discovery and enable paths accept a codemode-only member', () => {
  const on = host(baseTools, ['codemode']);
  const context = { codemodeAvailable: codemodeAvailable(on.api) };
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
