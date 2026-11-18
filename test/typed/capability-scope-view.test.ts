/**
 * Per-operation capability qualification views.
 *
 * These tests exercise the production view API: negative-fence inheritance
 * (ancestor denials and dynamic denial predicates), child independence from
 * parent tool catalogs, lazy/single catalog enumeration when predicates exist,
 * detached views, and cycle protection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCapabilityScopeView,
  setCapabilityParent,
  type CapabilityScopedTool,
  type CapabilityToolCatalog,
} from "../../src/capability/scope.ts";

interface CatalogCalls {
  count: number;
}

interface MutableCatalog extends CapabilityToolCatalog {
  readonly calls: CatalogCalls;
  setTools(next: readonly CapabilityScopedTool[]): void;
  addTools(...names: readonly string[]): void;
  removeTools(...names: readonly string[]): void;
}

function tool(name: string, exposure?: string): CapabilityScopedTool {
  return exposure === undefined ? { name } : { name, exposure };
}

function catalog(...initial: readonly CapabilityScopedTool[]): MutableCatalog {
  let tools = [...initial];
  const calls: CatalogCalls = { count: 0 };
  return {
    calls,
    getAllTools(): readonly CapabilityScopedTool[] {
      calls.count += 1;
      return tools;
    },
    setTools(next: readonly CapabilityScopedTool[]): void {
      tools = [...next];
    },
    addTools(...names: readonly string[]): void {
      tools = [...tools, ...names.map((name) => tool(name))];
    },
    removeTools(...names: readonly string[]): void {
      const removed = new Set(names);
      tools = tools.filter((entry) => !removed.has(entry.name));
    },
  };
}

test("ancestor denials propagate down while children can use tools absent from ancestors", () => {
  const root = catalog(tool("read"));
  const middle = catalog(tool("read"), tool("middle_only"));
  const leaf = catalog(tool("read"), tool("leaf_only"), tool("write"));
  setCapabilityParent(middle, root, ["write", "mcp__server__danger"]);
  setCapabilityParent(leaf, middle);

  const middleView = createCapabilityScopeView(middle);
  assert.equal(middleView.root, false);
  assert.equal(middleView.allows("write"), false);
  assert.equal(middleView.allows("mcp__server__danger"), false);
  assert.equal(middleView.allows("middle_only"), true);

  const leafView = createCapabilityScopeView(leaf);
  assert.equal(leafView.root, false);
  assert.equal(leafView.allows("write"), false, "the middle denial propagates to the leaf");
  assert.equal(leafView.allows("mcp__server__danger"), false);
  assert.equal(leafView.allows("leaf_only"), true, "leaf tools absent from parent are allowed");
});

test("denials and dynamic predicates apply immediately on fresh views", () => {
  const root = catalog(tool("alpha"));
  const middle = catalog();
  const leaf = catalog(tool("alpha"), tool("child_ns_tool"));
  setCapabilityParent(middle, root);
  setCapabilityParent(leaf, middle);

  assert.equal(createCapabilityScopeView(leaf).allows("alpha"), true);

  setCapabilityParent(middle, root, ["alpha"]);
  assert.equal(createCapabilityScopeView(middle).allows("alpha"), false);
  assert.equal(createCapabilityScopeView(leaf).allows("alpha"), false);

  setCapabilityParent(middle, root);
  assert.equal(createCapabilityScopeView(leaf).allows("alpha"), true);

  setCapabilityParent(root, null, [], (name) => name === "child_ns_tool");
  assert.equal(createCapabilityScopeView(leaf).allows("child_ns_tool"), false);
});

test("parent resolver is re-read per operation and retained views stay isolated", () => {
  const root = catalog(tool("read"));
  let parent = catalog(tool("read"));
  setCapabilityParent(parent, root, ["write"]);

  const leaf = catalog(tool("read"), tool("write"));
  setCapabilityParent(leaf, () => parent);

  const first = createCapabilityScopeView(leaf);
  assert.equal(first.allows("write"), false);

  parent = catalog(tool("read"));
  setCapabilityParent(parent, root, []);
  assert.equal(first.allows("write"), false, "a retained view keeps its operation's answer");
  assert.equal(createCapabilityScopeView(leaf).allows("write"), true, "a fresh view re-reads the resolver");
});

test("one view skips catalog enumeration without predicates and enumerates once with predicates", () => {
  const names = Array.from({ length: 40 }, (_, index) => `tool_${index}`);
  const tools = names.map((name) => tool(name));
  const root = catalog(...tools);
  const middle = catalog(...tools);
  const leaf = catalog(...tools);
  setCapabilityParent(middle, root);
  setCapabilityParent(leaf, middle);

  const view = createCapabilityScopeView(leaf);
  for (const name of names) assert.equal(view.allows(name), true);
  assert.equal(root.calls.count, 0);
  assert.equal(middle.calls.count, 0);
  assert.equal(leaf.calls.count, 0, "no catalog is enumerated when no predicate is present");

  setCapabilityParent(root, null, [], () => false);
  const predicateView = createCapabilityScopeView(leaf);
  for (let repeat = 0; repeat < 5; repeat += 1) {
    for (const name of names) assert.equal(predicateView.allows(name), true);
  }
  assert.equal(root.calls.count, 0);
  assert.equal(middle.calls.count, 0);
  assert.equal(leaf.calls.count, 1, "the queried catalog is enumerated at most once when predicates exist");
});

test("denied arrays are copied so mutating the input cannot change authority", () => {
  const root = catalog(tool("read"), tool("write"));
  const child = catalog(tool("read"));
  const denied = ["write"];
  setCapabilityParent(child, root, denied);
  denied.push("read");

  const first = createCapabilityScopeView(child);
  assert.equal(first.allows("read"), true, "the denied input array was copied");
  assert.equal(first.allows("write"), false);

  const retained = createCapabilityScopeView(child);
  setCapabilityParent(child, root, ["read"]);
  assert.equal(first.allows("read"), true, "an existing view keeps its operation's answer");
  assert.equal(retained.allows("read"), true, "an existing view keeps its operation's answer");
  assert.equal(createCapabilityScopeView(child).allows("read"), false, "a fresh operation sees the current denial");
});

test("root and child keep negative-check semantics for any name", () => {
  const root = catalog(tool("visible"), tool("hidden", "hidden"));
  const rootView = createCapabilityScopeView(root);
  assert.equal(rootView.root, true);
  assert.equal(rootView.allows("visible"), true);
  assert.equal(rootView.allows("hidden"), true);
  assert.equal(rootView.allows("unregistered"), true);

  const child = catalog();
  setCapabilityParent(child, root);
  const childView = createCapabilityScopeView(child);
  assert.equal(childView.root, false);
  assert.equal(childView.allows("hidden"), true);
  assert.equal(childView.allows("unregistered"), true);

  setCapabilityParent(root, null, ["visible"]);
  const denied = createCapabilityScopeView(root);
  assert.equal(denied.allows("visible"), false);
  assert.equal(denied.allows("unregistered"), true);
});

test("a cyclic parent chain fails closed instead of recursing", () => {
  const first = catalog(tool("read"));
  const second = catalog(tool("read"));
  setCapabilityParent(first, second);
  setCapabilityParent(second, first);
  assert.throws(
    () => createCapabilityScopeView(first),
    /capability scope parent chain contains a cycle/,
  );
});
