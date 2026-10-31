/**
 * Exact behavior pins for the shared tool-loadout policy.
 *
 * The surface (capture warnings) and the native Job runner (Inherited loadout)
 * both execute this one implementation, so these cases verify the ordering
 * and depth rules that both call sites depend on. `subagent-surface.test.ts`
 * still covers the capture side end to end, and `native-job-runner.test.ts`
 * covers the execution side; this file pins the shared core itself.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  droppedInheritedTools,
  harnessToolsForDepth,
  inheritedToolNames,
  transplantableToolNames,
} from "../../src/subagent/tool-policy.ts";
import type { ToolPolicyTool } from "../../src/subagent/tool-policy.ts";

const MAX_DEPTH = 2;
const HARNESS: readonly string[] = [
  "subagent_create",
  "subagent_list",
  "subagent_stop",
  "capability",
  "msg_write",
];
const LEAF: readonly string[] = ["subagent_list", "msg_write"];

function tools(catalog: ReadonlyArray<{ name: string; source?: string }>): ToolPolicyTool[] {
  return catalog.map((tool) => (
    tool.source === undefined ? { name: tool.name } : { name: tool.name, sourceInfo: { source: tool.source } }
  ));
}

test("harness tools follow the configured depth boundary in declared order", () => {
  assert.deepEqual(harnessToolsForDepth(-1, MAX_DEPTH), HARNESS);
  assert.deepEqual(harnessToolsForDepth(0, MAX_DEPTH), HARNESS);
  assert.deepEqual(harnessToolsForDepth(MAX_DEPTH - 1, MAX_DEPTH), HARNESS);
  assert.deepEqual(harnessToolsForDepth(MAX_DEPTH, MAX_DEPTH), LEAF);
  assert.deepEqual(harnessToolsForDepth(MAX_DEPTH + 3, MAX_DEPTH), LEAF);
  // A deeper configured maximum moves the leaf boundary with it.
  assert.deepEqual(harnessToolsForDepth(2, 3), HARNESS);
  assert.deepEqual(harnessToolsForDepth(3, 3), LEAF);
  // A maximum depth of one makes the first child a leaf.
  assert.deepEqual(harnessToolsForDepth(1, 1), LEAF);
});

test("transplantable names always include harness and file tools", () => {
  assert.deepEqual(
    [...transplantableToolNames([], 0, MAX_DEPTH)].sort(),
    ["capability", "msg_write", "read", "subagent_create", "subagent_list", "subagent_stop", "write"],
  );
  assert.deepEqual(
    [...transplantableToolNames([], MAX_DEPTH, MAX_DEPTH)].sort(),
    ["msg_write", "read", "subagent_list", "write"],
  );
  // Only a built-in source is transplantable; extension tools are not.
  assert.deepEqual(
    [...transplantableToolNames(tools([
      { name: "read", source: "builtin" },
      { name: "grep", source: "builtin" },
      { name: "extension_tool", source: "extension" },
      { name: "no_source" },
    ]), 0, MAX_DEPTH)].sort(),
    ["capability", "grep", "msg_write", "read", "subagent_create", "subagent_list", "subagent_stop", "write"],
  );
  // A duplicated built-in collapses in the set.
  assert.equal(transplantableToolNames(tools([{ name: "grep", source: "builtin" }]), 0, MAX_DEPTH).size, 8);
});

test("dropped tools keep capture order, dedupe, and ignore non-names", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "extension_tool", source: "extension" },
    { name: "other_extension", source: "extension" },
  ]);

  assert.deepEqual(
    droppedInheritedTools(catalog, ["extension_tool", "read", "other_extension", "extension_tool"], 0, MAX_DEPTH),
    ["extension_tool", "other_extension"],
  );
  // Harness and file tools are never dropped below the leaf depth.
  assert.deepEqual(
    droppedInheritedTools(catalog, ["subagent_create", "capability", "write", "msg_write", "read"], 0, MAX_DEPTH),
    [],
  );
  // At the leaf depth a child may not hold create/stop/capability, so those are dropped.
  assert.deepEqual(
    droppedInheritedTools(catalog, ["subagent_create", "subagent_list", "capability"], MAX_DEPTH, MAX_DEPTH),
    ["subagent_create", "capability"],
  );
  // Malformed captured values contribute nothing instead of inventing names.
  assert.deepEqual(droppedInheritedTools(catalog, undefined, 0, MAX_DEPTH), []);
  assert.deepEqual(droppedInheritedTools(catalog, "read", 0, MAX_DEPTH), []);
  assert.deepEqual(droppedInheritedTools(catalog, ["", 7, null, "extension_tool"], 0, MAX_DEPTH), ["extension_tool"]);
});

test("the inherited allowlist keeps capture order, then appends harness tools", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "write", source: "builtin" },
    { name: "extension_tool", source: "extension" },
  ]);

  // Capture order is preserved; harness tools fill the tail in declared order.
  assert.deepEqual(
    inheritedToolNames(catalog, ["write", "read"], 0, MAX_DEPTH),
    ["write", "read", "subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"],
  );
  // An already-captured harness tool keeps its captured position and is not repeated.
  assert.deepEqual(
    inheritedToolNames(catalog, ["capability", "read"], 0, MAX_DEPTH),
    ["capability", "read", "subagent_create", "subagent_list", "subagent_stop", "msg_write"],
  );
  // Non-transplantable and duplicate entries never reach the allowlist.
  assert.deepEqual(
    inheritedToolNames(catalog, ["extension_tool", "read", "read", "write"], 0, MAX_DEPTH),
    ["read", "write", "subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"],
  );
  // At the leaf depth only the list harness tool is appended.
  assert.deepEqual(inheritedToolNames(catalog, ["read"], MAX_DEPTH, MAX_DEPTH), ["read", "subagent_list", "msg_write"]);
  // Malformed capture falls back to exactly the harness tools.
  assert.deepEqual(inheritedToolNames(catalog, null, 0, MAX_DEPTH), [...HARNESS]);
});

test("allowlist and dropped list stay consistent for the same capture", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "write", source: "builtin" },
    { name: "extension_tool", source: "extension" },
  ]);
  const captured = ["extension_tool", "read", "subagent_stop", "write", "extension_tool"];
  for (const depth of [0, 1, MAX_DEPTH]) {
    const dropped = droppedInheritedTools(catalog, captured, depth, MAX_DEPTH);
    const allowed = inheritedToolNames(catalog, captured, depth, MAX_DEPTH);

    // Every dropped name is absent; allowed names are deduplicated.
    for (const name of dropped) assert.ok(!allowed.includes(name), `${name} dropped but allowed at ${depth}`);
    assert.equal(new Set(allowed).size, allowed.length);
    // The harness tools of this depth are all present, and no foreign name is.
    for (const name of harnessToolsForDepth(depth, MAX_DEPTH)) assert.ok(allowed.includes(name));
    // Dropped + allowed explain the captured names plus the harness tail.
    const explained = new Set([...allowed, ...dropped]);
    for (const name of captured) assert.ok(explained.has(name));
  }
});

test("file-backed harness tools still follow the depth boundary", () => {
  const catalog: ToolPolicyTool[] = [
    { name: "subagent_create", sourceInfo: { source: "local", path: "/tmp/project/extensions/harness.ts" } },
    { name: "capability", sourceInfo: { source: "local", path: "/tmp/project/extensions/harness.ts" } },
    { name: "mcp__configured__inspect", sourceInfo: { source: "local", path: "/tmp/project/extensions/harness.ts" } },
  ];
  const captured = ["subagent_create", "capability", "mcp__configured__inspect"];
  // At the leaf, the file-backed Harness registrations are still gated by depth;
  // other file-backed tools remain transplantable.
  assert.deepEqual(droppedInheritedTools(catalog, captured, 1, 1), ["subagent_create", "capability"]);
  assert.deepEqual(inheritedToolNames(catalog, captured, 1, 1), [
    "mcp__configured__inspect", "subagent_list", "msg_write",
  ]);
  // Above the leaf the same capture keeps the full Harness loadout.
  assert.deepEqual(droppedInheritedTools(catalog, captured, 1, 2), []);
  assert.deepEqual(inheritedToolNames(catalog, captured, 1, 2), [
    "subagent_create", "capability", "mcp__configured__inspect", "subagent_list", "subagent_stop", "msg_write",
  ]);
});

test("file-backed extensions and MCP backends may recreate inherited tool registrations", () => {
  const catalog: ToolPolicyTool[] = [
    {name:'configured_tool',sourceInfo:{source:'local',path:'/tmp/fixture/extension.ts'}},
    {name:'mcp__configured__inspect',sourceInfo:{source:'local',path:'/tmp/fixture/harness.ts'}},
    {name:'inline_only',sourceInfo:{source:'inline',path:'<inline:fixture>'}},
  ];
  assert.deepEqual(droppedInheritedTools(catalog,['configured_tool','mcp__configured__inspect','inline_only'],1,MAX_DEPTH),['inline_only']);
  assert.deepEqual(inheritedToolNames(catalog,['configured_tool','mcp__configured__inspect'],1,MAX_DEPTH),
    ['configured_tool','mcp__configured__inspect',...HARNESS]);
});
