import assert from "node:assert/strict";
import test from "node:test";

import { promptText } from "../src/prompt-text.mjs";
import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_SEARCH_PARAMETERS,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
  SUBMIT_RESULT_PARAMETERS,
  SUBMIT_RESULT_TOOL_NAME,
} from "../src/capability-broker.mjs";
import {
  CAPABILITY_DISCOVERY_BUDGET,
  CAPABILITY_DISCOVERY_PROMPT,
  CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  CAPABILITY_REMOTE_SEARCH_DISABLED,
  capabilityBudgetWarning,
} from "../src/capability-agent.mjs";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../src/capability-prompt.mjs";
import capabilityExtension from "../extensions/capability.mjs";

test("capability-tools.json defines public and internal tool descriptions and guidelines", () => {
  const tools = JSON.parse(promptText("capability-tools.json"));

  assert.equal(typeof tools.capability.description, "string");
  assert.equal(tools.capability.description, CAPABILITY_TOOL_DESCRIPTION);
  assert.equal(typeof tools.capability.snippet, "string");
  assert.ok(Array.isArray(tools.capability.guidelines));
  assert.equal(tools.capability.guidelines.length, 7);

  assert.equal(typeof tools.search.description, "string");
  assert.equal(tools.search.parameters.query, CAPABILITY_SEARCH_PARAMETERS.properties.query.description);
  assert.equal(tools.search.parameters.src, CAPABILITY_SEARCH_PARAMETERS.properties.src.description);

  assert.equal(typeof tools.submit.description, "string");
  assert.equal(tools.submit.parameters.refs, SUBMIT_RESULT_PARAMETERS.properties.refs.description);
});

test("capability-policy.json defines fixed model-facing policy prose", () => {
  const policy = JSON.parse(promptText("capability-policy.json"));

  assert.equal(typeof policy.remoteSearchDisabled, "string");
  assert.equal(policy.remoteSearchDisabled, CAPABILITY_REMOTE_SEARCH_DISABLED);

  assert.equal(typeof policy.additiveExecutionBlocked, "string");
  assert.match(policy.additiveExecutionBlocked, /Capability discovery may execute only capability_search and submit_result/);

  assert.equal(typeof policy.budgetWrapUp, "string");
  assert.equal(capabilityBudgetWarning("warning text"), `warning text\n\n${policy.budgetWrapUp}`);

  assert.equal(typeof policy.memoryHeader, "string");
  assert.match(policy.memoryHeader, /Previously selected capabilities and guidance/);
  assert.match(policy.memoryHeader, /Use the selected tool declarations or returned interfaces for calls\. Read Skill entry files by their listed absolute paths\./);
  assert.doesNotMatch(policy.memoryHeader, /read returned tool:\/\/|namespace:\/\/ refs for interface details/);
  assert.equal(policy.submissionEmpty, 'Submission accepted: no relevant capability found. Stop now.');
  assert.equal(policy.submissionAccepted.replace('{count}', '2'), 'Submission accepted: 2 ref(s). Stop now; do not call more tools.');
});

test("markdown assets load verbatim for discovery system and user prompts", () => {
  const systemPrompt = promptText("capability-discovery-system.md");
  assert.equal(systemPrompt, CAPABILITY_DISCOVERY_SYSTEM_PROMPT);
  assert.match(systemPrompt, /You are the internal capability retrieval agent/);
  assert.match(systemPrompt, /Search local resources\. Remote package search is disabled/);

  const userPrompt = promptText("capability-discovery-user.md");
  assert.equal(userPrompt, CAPABILITY_DISCOVERY_PROMPT);
  assert.match(userPrompt, /Find reusable guidance and capabilities for the current task/);
  assert.match(userPrompt, /Remote search is disabled in this run/);
});

test("capabilityExtension registers prompt snippet and guidelines from external asset", () => {
  let registered = null;
  capabilityExtension({
    registerTool(tool) { registered = tool; },
    getAllTools() { return []; },
    getActiveTools() { return []; },
    on() {},
  });

  assert.ok(registered);
  assert.equal(registered.name, CAPABILITY_TOOL_NAME);
  assert.equal(registered.description, CAPABILITY_TOOL_DESCRIPTION);
  const tools = JSON.parse(promptText("capability-tools.json"));
  assert.equal(registered.promptSnippet, tools.capability.snippet);
  assert.deepEqual(registered.promptGuidelines, tools.capability.guidelines);
});

test("capabilityPromptTranscript renders memory header from external policy asset", () => {
  const policy = JSON.parse(promptText("capability-policy.json"));
  const sampleHit = {
    status: "ok",
    tools: [{ ref: "tool://test", name: "test", description: "A test tool", exposure: "direct" }],
    mcp: [],
    skills: [],
  };
  const branch = [{
    type: "message",
    message: { role: "toolResult", toolName: "capability", details: sampleHit },
  }];
  const projected = capabilityPromptTranscript([{ role: "system", content: "Original system" }], branch);
  const section = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.ok(section);
  assert.match(section, new RegExp(policy.memoryHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
