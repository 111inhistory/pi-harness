import assert from "node:assert/strict";
import test from "node:test";

import capabilityExtension from "../extensions/capability.mjs";

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
