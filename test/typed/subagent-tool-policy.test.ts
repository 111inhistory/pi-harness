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

import { MAX_AGENT_DEPTH } from "../../src/subagent/runtime.ts";
import {
  droppedInheritedTools,
  harnessToolsForDepth,
  inheritedToolNames,
  transplantableToolNames,
} from "../../src/subagent/tool-policy.ts";
import type { ToolPolicyTool } from "../../src/subagent/tool-policy.ts";

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

test("harness tools follow the depth boundary in declared order", () => {
  assert.deepEqual(harnessToolsForDepth(-1), HARNESS);
  assert.deepEqual(harnessToolsForDepth(0), HARNESS);
  assert.deepEqual(harnessToolsForDepth(MAX_AGENT_DEPTH - 1), HARNESS);
  assert.deepEqual(harnessToolsForDepth(MAX_AGENT_DEPTH), LEAF);
  assert.deepEqual(harnessToolsForDepth(MAX_AGENT_DEPTH + 3), LEAF);
});

test("transplantable names always include harness and file tools", () => {
  assert.deepEqual(
    [...transplantableToolNames([], 0)].sort(),
    ["capability", "msg_write", "read", "subagent_create", "subagent_list", "subagent_stop", "write"],
  );
  assert.deepEqual(
    [...transplantableToolNames([], MAX_AGENT_DEPTH)].sort(),
    ["msg_write", "read", "subagent_list", "write"],
  );
  // Only a built-in source is transplantable; extension tools are not.
  assert.deepEqual(
    [...transplantableToolNames(tools([
      { name: "read", source: "builtin" },
      { name: "grep", source: "builtin" },
      { name: "extension_tool", source: "extension" },
      { name: "no_source" },
    ]), 0)].sort(),
    ["capability", "grep", "msg_write", "read", "subagent_create", "subagent_list", "subagent_stop", "write"],
  );
  // A duplicated built-in collapses in the set.
  assert.equal(transplantableToolNames(tools([{ name: "grep", source: "builtin" }]), 0).size, 8);
});

test("dropped tools keep capture order, dedupe, and ignore non-names", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "extension_tool", source: "extension" },
    { name: "other_extension", source: "extension" },
  ]);

  assert.deepEqual(
    droppedInheritedTools(catalog, ["extension_tool", "read", "other_extension", "extension_tool"], 0),
    ["extension_tool", "other_extension"],
  );
  // Harness and file tools are never dropped below the leaf depth.
  assert.deepEqual(
    droppedInheritedTools(catalog, ["subagent_create", "capability", "write", "msg_write", "read"], 0),
    [],
  );
  // At the leaf depth a child may not hold create/stop/capability, so those are dropped.
  assert.deepEqual(
    droppedInheritedTools(catalog, ["subagent_create", "subagent_list", "capability"], MAX_AGENT_DEPTH),
    ["subagent_create", "capability"],
  );
  // Malformed captured values contribute nothing instead of inventing names.
  assert.deepEqual(droppedInheritedTools(catalog, undefined, 0), []);
  assert.deepEqual(droppedInheritedTools(catalog, "read", 0), []);
  assert.deepEqual(droppedInheritedTools(catalog, ["", 7, null, "extension_tool"], 0), ["extension_tool"]);
});

test("the inherited allowlist keeps capture order, then appends harness tools", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "write", source: "builtin" },
    { name: "extension_tool", source: "extension" },
  ]);

  // Capture order is preserved; harness tools fill the tail in declared order.
  assert.deepEqual(
    inheritedToolNames(catalog, ["write", "read"], 0),
    ["write", "read", "subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"],
  );
  // An already-captured harness tool keeps its captured position and is not repeated.
  assert.deepEqual(
    inheritedToolNames(catalog, ["capability", "read"], 0),
    ["capability", "read", "subagent_create", "subagent_list", "subagent_stop", "msg_write"],
  );
  // Non-transplantable and duplicate entries never reach the allowlist.
  assert.deepEqual(
    inheritedToolNames(catalog, ["extension_tool", "read", "read", "write"], 0),
    ["read", "write", "subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"],
  );
  // At the leaf depth only the list harness tool is appended.
  assert.deepEqual(inheritedToolNames(catalog, ["read"], MAX_AGENT_DEPTH), ["read", "subagent_list", "msg_write"]);
  // Malformed capture falls back to exactly the harness tools.
  assert.deepEqual(inheritedToolNames(catalog, null, 0), [...HARNESS]);
});

test("allowlist and dropped list stay consistent for the same capture", () => {
  const catalog = tools([
    { name: "read", source: "builtin" },
    { name: "write", source: "builtin" },
    { name: "extension_tool", source: "extension" },
  ]);
  const captured = ["extension_tool", "read", "subagent_stop", "write", "extension_tool"];
  for (const depth of [0, 1, MAX_AGENT_DEPTH]) {
    const dropped = droppedInheritedTools(catalog, captured, depth);
    const allowed = inheritedToolNames(catalog, captured, depth);

    // Every dropped name is absent; allowed names are deduplicated.
    for (const name of dropped) assert.ok(!allowed.includes(name), `${name} dropped but allowed at ${depth}`);
    assert.equal(new Set(allowed).size, allowed.length);
    // The harness tools of this depth are all present, and no foreign name is.
    for (const name of harnessToolsForDepth(depth)) assert.ok(allowed.includes(name));
    // Dropped + allowed explain the captured names plus the harness tail.
    const explained = new Set([...allowed, ...dropped]);
    for (const name of captured) assert.ok(explained.has(name));
  }
});

test("file-backed extensions and MCP backends may recreate inherited tool registrations", () => {
  const catalog: ToolPolicyTool[] = [
    {name:'configured_tool',sourceInfo:{source:'local',path:'/tmp/fixture/extension.ts'}},
    {name:'mcp__configured__inspect',sourceInfo:{source:'local',path:'/tmp/fixture/harness.ts'}},
    {name:'inline_only',sourceInfo:{source:'inline',path:'<inline:fixture>'}},
  ];
  assert.deepEqual(droppedInheritedTools(catalog,['configured_tool','mcp__configured__inspect','inline_only'],1),['inline_only']);
  assert.deepEqual(inheritedToolNames(catalog,['configured_tool','mcp__configured__inspect'],1),
    ['configured_tool','mcp__configured__inspect',...HARNESS]);
});
