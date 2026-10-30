import assert from 'node:assert/strict';

/** Flatten only the public children tree, for count/find assertions in tests. */
export function treeNodes(root: unknown): Record<string, unknown>[] {
  if (root === null) return [];
  assert.ok(typeof root === 'object' && root !== null && !Array.isArray(root));
  const node = root as Record<string, unknown>;
  assert.ok(Array.isArray(node.children), 'list nodes must expose children, not flat parentId rows');
  assert.equal('parentId' in node, false);
  assert.equal('items' in node, false);
  return [node, ...node.children.flatMap(treeNodes)];
}
