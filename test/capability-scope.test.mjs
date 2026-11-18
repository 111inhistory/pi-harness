import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityScopeView, setCapabilityParent } from '../src/capability/scope.ts';

const api = (names) => ({
  names,
  getActiveTools() { return this.names; },
  getAllTools() { return this.names.map(name => ({ name })); },
});

const allows = (scope, name) => createCapabilityScopeView(scope).allows(name);

test('children may use tools absent from parent while ancestor denials still win', () => {
  const root = api(['read']);
  const child = api(['read', 'child_only']);
  const leaf = api(['read', 'child_only', 'leaf_only']);
  setCapabilityParent(child, root, ['write', 'mcp__server__danger']);
  setCapabilityParent(leaf, child);

  assert.equal(allows(child, 'write'), false);
  assert.equal(allows(leaf, 'write'), false);
  assert.equal(allows(leaf, 'mcp__server__danger'), false);
  assert.equal(allows(child, 'child_only'), true);
  assert.equal(allows(leaf, 'leaf_only'), true);
  assert.equal(createCapabilityScopeView(leaf).root, false);
});

test('denial predicates apply to child-only tools and unregistered names', () => {
  const root = api([]);
  setCapabilityParent(root, null, [], (name) => name.startsWith('blocked_'));
  const child = {
    getActiveTools: () => [],
    getAllTools: () => [{ name: 'child_tool' }, { name: 'blocked_child' }],
  };
  setCapabilityParent(child, root);

  const view = createCapabilityScopeView(child);
  assert.equal(view.allows('child_tool'), true);
  assert.equal(view.allows('blocked_child'), false);
  assert.equal(view.allows('blocked_unregistered'), false);
});

test('a child resolves the current parent API after revival', () => {
  const root = api(['read', 'bash']);
  let parent = api(['read']);
  setCapabilityParent(parent, root, ['bash']);
  const leaf = api(['read']);
  setCapabilityParent(leaf, () => parent);
  assert.equal(allows(leaf, 'bash'), false);
  parent = api(['read', 'bash']);
  setCapabilityParent(parent, root);
  assert.equal(allows(leaf, 'bash'), true);
});
