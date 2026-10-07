import assert from "node:assert/strict";
import test from "node:test";

import workExtension from "../extensions/work.mjs";
import capabilityExtension from "../extensions/capability.mjs";

// Capture registration only. No session, provider, credentials, or network is opened.
function registeredTools(extension) {
  const tools = new Map();
  extension({
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    events: { emit() {}, on() { return () => {}; } },
  });
  return tools;
}

test("work guidance describes the actual actions without implying execution", async () => {
  const tool = registeredTools(workExtension).get("work");
  assert.ok(tool.promptSnippet);
  for (const action of tool.parameters.properties.action.enum) assert.ok(tool.description.includes(action));
  assert.match(tool.description, /does not execute tasks/);
  assert.ok(tool.promptGuidelines.some((rule) => /focus changes only the view/.test(rule)));
  const created = await tool.execute("add", { action: "add", attach: "root", items: [{ title: "Inspect the code" }] });
  assert.equal(created.details.response.ok, true);
});

test("capability guidance covers reuse and missing capabilities without implying installation", () => {
  const tool = registeredTools(capabilityExtension).get("capability");
  assert.ok(tool.promptSnippet);
  assert.deepEqual(tool.parameters.properties, {});
  assert.match(tool.description, /reusable skills and task guidance alongside tools and MCP/);
  const guidance = tool.promptGuidelines.join("\n");
  assert.match(guidance, /find missing capabilities or reuse established guidance/);
  assert.match(guidance, /rules, preferences, fixed background/);
  assert.match(guidance, /generic tool description may not fit/);
  assert.match(guidance, /not before every tool call/);
  assert.match(guidance, /task-level discovery of guidance and tool names/);
  assert.match(guidance, /unfamiliar tools used through codemode.*describeTool or describeNamespace/);
  assert.match(guidance, /Do not use searchTools as a separate discovery workflow/);
  assert.doesNotMatch(guidance, /when a needed operation is not covered/);
  assert.match(tool.description, /already registered in this session/);
  assert.match(tool.description, /never installs packages or executes capabilities/);
  assert.ok(tool.promptGuidelines.some((rule) => /needs_approval.*not permission/.test(rule)));
  assert.equal(registeredTools(capabilityExtension).has("write"), false, "Capability does not own write");
});

test("Capability reports a missing Subagent dependency before opening an internal session", async () => {
  const tool = registeredTools(capabilityExtension).get("capability");
  const result = await tool.execute("missing", {}, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "failed");
  assert.match(result.details.warnings.join("\n"), /requires the Subagent extension.*need not be active/);
});
