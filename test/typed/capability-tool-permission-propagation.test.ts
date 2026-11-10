/**
 * Tool-permission propagation to subagent capability scopes.
 *
 * A child scope only learns names its parent's effective set exposes. RootService
 * therefore gives a child a root catalog with explicitly-disabled tools removed,
 * so a subagent created while a permission rule is active never qualifies the
 * prohibited tool. These cases assert that mechanism directly: the filtered
 * parent hides the disabled name, while an unfiltered parent lets the same child
 * learn it (the control), and group rules propagate by namespace as well as exact
 * names. Explicit enable is root-only and is deliberately not propagated here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_TOOL_PERMISSION_RECORD,
  explicitlyDisabled,
  type ToolPermissionManagedState,
  type ToolPermissionTool,
} from '../../src/capability/tool-permission.ts';
import { createCapabilityScopeView, setCapabilityParent } from '../../src/capability/scope.ts';

const tools: readonly ToolPermissionTool[] = [
  { name: 'read', exposure: 'direct' },
  { name: 'write', exposure: 'direct' },
  { name: 'bash', exposure: 'direct' },
  { name: 'mcp__github__search', exposure: 'codemode', namespace: { name: 'mcp__github', aliases: ['github'] } },
];

const host = { getAllTools: () => tools };

function branchWith(set: readonly { target: string; state: ToolPermissionManagedState }[]): readonly unknown[] {
  return [{ type: 'custom', customType: CAPABILITY_TOOL_PERMISSION_RECORD, data: { version: 1, set } }];
}

/** The filtered root scope RootService hands to a child's ancestor chain. */
function filteredRoot(branch: readonly unknown[]) {
  return { getAllTools: () => tools.filter((tool) => !explicitlyDisabled(host, branch, tool.name)) };
}

function childOf(parent: { getAllTools(): readonly ToolPermissionTool[] }) {
  const child = { getAllTools: () => tools };
  setCapabilityParent(child, parent);
  return createCapabilityScopeView(child);
}

test('a disabled exact tool on the parent branch is not qualified by a fresh child scope', () => {
  const view = childOf(filteredRoot(branchWith([{ target: 'write', state: 'disabled' }])));
  assert.equal(view.allows('write'), false, 'the disabled exact tool is not qualified');
  assert.equal(view.allows('read'), true, 'sibling tools are unaffected');
});

test('the control: without the filter the same child qualifies the tool', () => {
  const view = childOf({ getAllTools: () => tools });
  assert.equal(view.allows('write'), true, 'an unfiltered parent lets the child learn the name');
});

test('a disabled server group propagates by namespace to the child', () => {
  const view = childOf(filteredRoot(branchWith([{ target: 'mcp://github', state: 'disabled' }])));
  assert.equal(view.allows('mcp__github__search'), false, 'the group member is not qualified');
  assert.equal(view.allows('read'), true);
});

test('an explicitly enabled tool is not propagated as a grant to the child', () => {
  // The filtered root only removes disabled names; enabled state is root-only.
  // A child therefore sees the name as unmanaged and may still learn it only if
  // its own scope exposes it; the root filter must not treat enabled as disabled.
  const view = childOf(filteredRoot(branchWith([{ target: 'write', state: 'enabled' }])));
  assert.equal(view.allows('write'), true, 'enabled does not remove the name from the parent catalog');
});

test('a retained parent proxy applies a prohibition added after its first child', () => {
  const branch = { current: [] as readonly unknown[] };
  const host = { getAllTools: () => tools };
  // The stable root catalog. Filtering its getAllTools is not enough: the proxy
  // below accumulates learned names append-only, so an earlier grant survives.
  const root = { getAllTools: () => tools.filter((tool) => !explicitlyDisabled(host, branch.current, tool.name)) };
  // The retained proxy reused by every child of one parent (the real
  // #parentScope cache).
  const proxy = { getAllTools: () => tools };
  const excluded: readonly string[] = [];
  const refresh = (): void => {
    const disabled = tools.filter((tool) => explicitlyDisabled(host, branch.current, tool.name)).map((tool) => tool.name);
    setCapabilityParent(proxy, root, [...excluded, ...disabled]);
  };

  refresh();
  const first = childOf(proxy);
  assert.equal(first.allows('write'), true, 'the first child learns the tool');

  branch.current = branchWith([{ target: 'write', state: 'disabled' }]);
  refresh();
  const second = childOf(proxy);
  assert.equal(second.allows('write'), false, 'the retained proxy denies it for a later child');
});

test('a direct root child created after the parent disables a tool is denied', () => {
  const branch = { current: [] as readonly unknown[] };
  const host = { getAllTools: () => tools };
  const root = { getAllTools: () => tools };
  // RootService.#rootScope: the stable root catalog re-applies current denials.
  const resolveRoot = () => {
    setCapabilityParent(root, null, tools
      .filter((tool) => explicitlyDisabled(host, branch.current, tool.name))
      .map((tool) => tool.name));
    return root;
  };

  const first = childOf(resolveRoot());
  assert.equal(first.allows('write'), true, 'the first direct child learns the tool');

  branch.current = branchWith([{ target: 'write', state: 'disabled' }]);
  const second = childOf(resolveRoot());
  assert.equal(second.allows('write'), false, 'a later direct child of the same root is denied');
});

test('a live parent forwards the current root denial to a grandchild', () => {
  const branch = { current: [] as readonly unknown[] };
  const host = { getAllTools: () => tools };
  const root = { getAllTools: () => tools };
  const refreshRoot = () => {
    setCapabilityParent(root, null, tools
      .filter((tool) => explicitlyDisabled(host, branch.current, tool.name))
      .map((tool) => tool.name));
    return root;
  };
  // A live child resolves its parent lazily, like native-session's resolver.
  const live = { getAllTools: () => tools };
  setCapabilityParent(live, () => refreshRoot());

  const first = childOf(live);
  assert.equal(first.allows('write'), true, 'the first grandchild learns the tool');

  branch.current = branchWith([{ target: 'write', state: 'disabled' }]);
  const second = childOf(live);
  assert.equal(second.allows('write'), false, 'a later grandchild sees the live root denial');
});
