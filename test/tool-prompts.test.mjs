import assert from "node:assert/strict";
import test from "node:test";

import workExtension from "../extensions/work.mjs";
import capabilityExtension from "../extensions/capability.mjs";
import subagentExtension from "../extensions/subagent.mjs";

// Capture registration only. No session, provider, credentials, or network is opened.
function registeredTools(extension, { active = [], handlers = new Map() } = {}) {
  const tools = new Map();
  extension({
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return active; },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    events: { emit() {}, on() { return () => {}; } },
  });
  return tools;
}

test("Subagent create asks only for primarily English requirements", () => {
  const tools = registeredTools(subagentExtension);
  const guidance = tools.get("subagent_create").promptGuidelines.join("\n");
  assert.ok(tools.get("subagent_create").promptGuidelines.includes("Write requirements for subagents primarily in English."));
  assert.doesNotMatch(guidance, /stronger English training|requested output language unchanged/);
  assert.doesNotMatch(tools.get("subagent_list").promptGuidelines.join("\n"), /primarily in English/);
});

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
  assert.match(tool.description, /filesystem or web searches unless the user explicitly requests those search methods/);
  assert.match(guidance, /Unless the user explicitly requests filesystem or web searches for Skills, do not search/);
  assert.match(guidance, /A general request to find Skills does not authorize bypassing Capability's configured selection/);
  assert.match(guidance, /Reading a returned Skill ref or its linked instructions is not a new discovery search/);
  assert.doesNotMatch(guidance, /when a needed operation is not covered/);
  assert.match(tool.description, /already registered in this session/);
  assert.match(tool.description, /never installs packages or executes capabilities/);
  assert.ok(tool.promptGuidelines.some((rule) => /needs_approval.*not permission/.test(rule)));
  assert.equal(registeredTools(capabilityExtension).has("write"), false, "Capability does not own write");
});

test("Capability hides only the native Skill prompt section, retaining task guidance", () => {
  const handlers = new Map();
  registeredTools(capabilityExtension, { handlers });
  const event = { systemPromptOptions: { skills: [{ name: "ppt-master" }], guidelines: ["Existing rule"], appendSystemPrompt: "Project context" } };
  handlers.get("before_agent_start")(event);
  assert.deepEqual(event.systemPromptOptions.skills, []);
  assert.deepEqual(event.systemPromptOptions.guidelines, ["Existing rule"]);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, "Project context");
});

test("retained declarations do not grant direct or nested execution rights", () => {
  const active = [];
  const handlers = new Map();
  const tools = registeredTools(capabilityExtension, { active, handlers });
  tools.set("disabled", { name: "disabled", exposure: "direct" });
  tools.set("withdrawn", { name: "withdrawn", exposure: "hidden" });
  tools.set("indirect", { name: "indirect", exposure: "deferred" });
  const guard = handlers.get("tool_call");
  for (const parentToolCallId of [undefined, "codemode-parent"]) {
    for (const toolName of ["disabled", "withdrawn", "missing"]) {
      assert.deepEqual(guard({ toolName, parentToolCallId }), {
        block: true, reason: `Tool ${toolName} is unavailable in this session; retained declarations do not enable execution.`,
      });
    }
    assert.equal(guard({ toolName: "indirect", parentToolCallId }), undefined);
  }
  active.push("disabled");
  assert.equal(guard({ toolName: "disabled" }), undefined);
});

test("Capability reports a missing Subagent dependency before opening an internal session", async () => {
  const tool = registeredTools(capabilityExtension).get("capability");
  const result = await tool.execute("missing", {}, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "failed");
  assert.match(result.details.warnings.join("\n"), /requires the Subagent extension.*need not be active/);
});
