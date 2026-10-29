/**
 * Per-operation capability qualification views.
 *
 * These tests exercise the production view API, not a copy of its logic. The
 * important properties are: one ancestor resolution per operation, O(1) name
 * checks afterwards, append-only learned qualification, denials that always
 * win (including after an earlier grant), fresh views after mid-turn growth,
 * detached snapshots, and the root/no-parent behavior of the compatibility
 * predicate.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityAllowsTool,
  capabilityAvailableTools,
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

test("role denials win at every level while earlier parent grants stay append-only", () => {
  const root = catalog(tool("read"), tool("write"));
  const middle = catalog(tool("read"));
  const leaf = catalog(tool("read"));
  setCapabilityParent(middle, root, ["write", "mcp__server__danger"]);
  setCapabilityParent(leaf, middle);

  const middleView = createCapabilityScopeView(middle);
  assert.equal(middleView.allows("write"), false);
  assert.equal(middleView.allows("mcp__server__danger"), false);

  const leafView = createCapabilityScopeView(leaf);
  assert.equal(leafView.allows("write"), false, "the middle denial propagates to the leaf");
  assert.equal(leafView.allows("mcp__server__danger"), false);
  assert.equal(leafView.allows("mcp__server__safe"), false);

  root.addTools("mcp__server__safe", "mcp__server__danger");
  const grown = createCapabilityScopeView(leaf);
  assert.equal(grown.allows("mcp__server__safe"), true);
  assert.equal(grown.allows("mcp__server__danger"), false);

  root.removeTools("mcp__server__safe");
  const retained = createCapabilityScopeView(leaf);
  assert.equal(retained.allows("mcp__server__safe"), true, "learned qualification is append-only");
  assert.equal(retained.available.has("write"), false, "denied names never enter availability");
});

test("a denial added after learning wins immediately for the scope and its descendants", () => {
  const root = catalog(tool("alpha"));
  const middle = catalog();
  const leaf = catalog();
  setCapabilityParent(middle, root);
  setCapabilityParent(leaf, middle);

  assert.equal(createCapabilityScopeView(leaf).allows("alpha"), true);
  assert.equal(createCapabilityScopeView(middle).available.has("alpha"), true);

  setCapabilityParent(middle, root, ["alpha"]);
  assert.equal(createCapabilityScopeView(middle).allows("alpha"), false);
  const denied = createCapabilityScopeView(leaf);
  assert.equal(denied.allows("alpha"), false, "a role denial wins over an earlier learned grant");
  assert.equal(denied.available.has("alpha"), false);

  setCapabilityParent(middle, root);
  const restored = createCapabilityScopeView(leaf);
  assert.equal(restored.allows("alpha"), true, "the append-only grant remains after the denial is removed");
  assert.equal(restored.available.has("alpha"), true);
});

test("eligibility growth is visible only to a fresh view, never to a retained one", () => {
  const root = catalog(tool("read"));
  const child = catalog(tool("read"));
  const leaf = catalog();
  setCapabilityParent(child, root);
  setCapabilityParent(leaf, child);

  const before = createCapabilityScopeView(leaf);
  assert.equal(before.allows("write"), false);
  root.addTools("write");
  assert.equal(before.allows("write"), false, "a view is a snapshot for its operation");
  assert.equal(before.available.has("write"), false);

  const after = createCapabilityScopeView(leaf);
  assert.equal(after.allows("write"), true, "a new operation sees mid-turn growth");

  root.removeTools("write");
  assert.equal(createCapabilityScopeView(leaf).allows("write"), true, "parent growth stays learned");
  assert.equal(after.allows("write"), true, "later parent changes do not rewrite an existing snapshot");

  let parent = root;
  setCapabilityParent(leaf, () => parent);
  const resolvedOnce = createCapabilityScopeView(leaf);
  parent = catalog(tool("other"));
  assert.equal(resolvedOnce.allows("other"), false, "the view resolved its parent once");
  assert.equal(createCapabilityScopeView(leaf).allows("other"), true, "the resolver is re-read per operation");
});

test("one view enumerates each ancestor once; per-tool compatibility repeats the ancestor chain", () => {
  const names = Array.from({ length: 40 }, (_, index) => `tool_${index}`);
  const tools = names.map((name) => tool(name));
  const root = catalog(...tools);
  const middle = catalog(...tools);
  const leaf = catalog(...tools);
  setCapabilityParent(middle, root);
  setCapabilityParent(leaf, middle);

  const before = root.calls.count + middle.calls.count + leaf.calls.count;
  const view = createCapabilityScopeView(leaf);
  const viewCalls = root.calls.count + middle.calls.count + leaf.calls.count - before;
  assert.equal(viewCalls, 3, "root, middle and leaf are each enumerated exactly once");

  for (let repeat = 0; repeat < 5; repeat += 1) {
    for (const name of names) assert.equal(view.allows(name), true);
  }
  assert.equal(
    root.calls.count + middle.calls.count + leaf.calls.count - before,
    3,
    "allows() does not enumerate any catalog",
  );

  root.calls.count = 0;
  middle.calls.count = 0;
  leaf.calls.count = 0;
  for (const name of names) assert.equal(capabilityAllowsTool(leaf, name), true);
  const perToolCalls = root.calls.count + middle.calls.count + leaf.calls.count;
  assert.equal(perToolCalls, names.length * 2, "the compatibility path repeats the parent chain per name");
  assert.ok(perToolCalls > viewCalls);
  assert.equal(leaf.calls.count, 0, "the compatibility path does not enumerate the queried scope");
});

test("views and available sets are detached snapshots; retaining them cannot change authority", () => {
  const root = catalog(tool("read"), tool("write"));
  const child = catalog(tool("read"));
  const denied = ["write"];
  setCapabilityParent(child, root, denied);
  denied.push("read");

  const first = createCapabilityScopeView(child);
  assert.equal(first.allows("read"), true, "the denied input array was copied");
  assert.equal(first.allows("write"), false);
  assert.equal(first.available.has("read"), true);
  assert.equal(first.available.has("write"), false);

  const mutableSnapshot = first.available as Set<string>;
  mutableSnapshot.add("write");
  mutableSnapshot.delete("read");
  assert.equal(createCapabilityScopeView(child).allows("write"), false);
  assert.equal(createCapabilityScopeView(child).allows("read"), true);

  const comparable = capabilityAvailableTools(child);
  assert.equal(comparable.has("read"), true);
  assert.equal(comparable.has("write"), false);
  assert.notEqual(comparable, first.available, "each call returns its own snapshot");

  const retained = createCapabilityScopeView(child);
  setCapabilityParent(child, root, ["read"]);
  assert.equal(first.allows("read"), true, "an existing view keeps its operation's answer");
  assert.equal(retained.allows("read"), true, "an existing view keeps its operation's answer");
  assert.equal(retained.available.has("read"), true);
  assert.equal(createCapabilityScopeView(child).allows("read"), false, "a fresh operation sees the current denial");

  root.addTools("after");
  assert.equal(first.allows("after"), false);
  assert.equal(retained.allows("after"), false);
  assert.equal(createCapabilityScopeView(child).allows("after"), true);
  assert.equal(retained.available.has("after"), false);
});

test("the root view keeps root qualification semantics while availability excludes hidden tools", () => {
  const root = catalog(tool("visible"), tool("hidden", "hidden"), tool("modelOnly", "model-only"));
  const rootView = createCapabilityScopeView(root);
  assert.equal(rootView.allows("visible"), true);
  assert.equal(rootView.allows("hidden"), true, "root qualification is denial-only, matching capabilityAllowsTool");
  assert.equal(capabilityAllowsTool(root, "hidden"), true);
  assert.equal(rootView.allows("unregistered"), true, "an unregistered name is still qualified at the root");
  assert.equal(rootView.available.has("visible"), true);
  assert.equal(rootView.available.has("modelOnly"), true);
  assert.equal(rootView.available.has("hidden"), false, "hidden tools never enter availability");
  assert.equal(rootView.available.has("unregistered"), false, "allows and available are not interchangeable");

  const child = catalog();
  setCapabilityParent(child, root);
  const childView = createCapabilityScopeView(child);
  assert.equal(childView.allows("hidden"), false);
  assert.equal(childView.allows("unregistered"), false);
  assert.equal(childView.available.has("visible"), true);
  assert.equal(childView.available.has("hidden"), false);

  setCapabilityParent(root, null, ["visible"]);
  const denied = createCapabilityScopeView(root);
  assert.equal(denied.allows("visible"), false);
  assert.equal(denied.allows("unregistered"), true);
  assert.equal(denied.available.has("visible"), false);
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
  assert.throws(
    () => capabilityAllowsTool(first, "read"),
    /capability scope parent chain contains a cycle/,
  );
});
