import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityAllowsTool, capabilityAvailableTools, setCapabilityParent } from '../src/capability/scope.ts';

const api = (names) => ({
  names,
  getActiveTools() { return this.names; },
  getAllTools() { return this.names.map(name => ({ name })); },
});

test('parent additions propagate through child eligibility; role denials win', () => {
  const root = api(['read', 'write']);
  const child = api(['read']);
  const leaf = api(['read']);
  setCapabilityParent(child, root, ['write', 'mcp__server__danger']);
  setCapabilityParent(leaf, child);
  assert.equal(capabilityAllowsTool(child, 'write'), false);
  assert.equal(capabilityAllowsTool(leaf, 'write'), false);
  assert.equal(capabilityAllowsTool(leaf, 'mcp__server__safe'), false);
  root.names.push('mcp__server__safe', 'mcp__server__danger');
  assert.equal(capabilityAllowsTool(leaf, 'mcp__server__safe'), true);
  assert.equal(capabilityAllowsTool(leaf, 'mcp__server__danger'), false);
  root.names = ['read'];
  assert.equal(capabilityAllowsTool(leaf, 'mcp__server__safe'), true, 'availability is append-only');
  assert.equal(capabilityAvailableTools(leaf).has('write'), false);
});

test('registered inactive parent tools also enter descendant eligibility', () => {
  const root = { getActiveTools: () => [], getAllTools: () => [{ name: 'new_tool' }, { name: 'hidden_tool', exposure: 'hidden' }] };
  const child = api([]);
  setCapabilityParent(child, root);
  assert.equal(capabilityAllowsTool(child, 'new_tool'), true);
  assert.equal(capabilityAllowsTool(child, 'hidden_tool'), false);
});

test('a child resolves the current parent API after revival', () => {
  const root = api(['read', 'bash']);
  let parent = api(['read']);
  setCapabilityParent(parent, root, ['bash']);
  const leaf = api(['read']);
  setCapabilityParent(leaf, () => parent);
  assert.equal(capabilityAllowsTool(leaf, 'bash'), false);
  parent = api(['read', 'bash']);
  setCapabilityParent(parent, root);
  assert.equal(capabilityAllowsTool(leaf, 'bash'), true);
});
