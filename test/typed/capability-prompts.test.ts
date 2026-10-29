import assert from 'node:assert/strict';
import test from 'node:test';
import { promptText } from '../../src/prompt-text.mjs';
import { CAPABILITY_SEARCH_PARAMETERS, CAPABILITY_TOOL_DESCRIPTION, CAPABILITY_TOOL_NAME, SUBMIT_RESULT_PARAMETERS } from '../../src/capability/contracts.ts';
import { CAPABILITY_DISCOVERY_PROMPT, CAPABILITY_DISCOVERY_SYSTEM_PROMPT, capabilityBudgetWarning } from '../../src/capability-agent.mjs';
import { CAPABILITY_DISCOVERY_RECORD } from '../../src/capability/discovery-record.ts';
import { CAPABILITY_SECTION, capabilityPromptTranscript } from '../../src/capability/prompt.ts';
import capabilityExtension from '../../extensions/capability.mjs';

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
const asset = (name: string): Record<string, unknown> => object(JSON.parse(promptText(name)));

function publicText() {
  const value = object(asset('capability-tools.json').capability);
  assert.equal(typeof value.description, 'string');
  assert.equal(typeof value.snippet, 'string');
  assert.ok(Array.isArray(value.guidelines));
  assert.ok(value.guidelines.every((entry: unknown) => typeof entry === 'string'));
  return value;
}

test('external Capability descriptions and parameter text remain connected to schemas', () => {
  const tools = asset('capability-tools.json');
  assert.equal(publicText().description, CAPABILITY_TOOL_DESCRIPTION);

  assert.equal(CAPABILITY_SEARCH_PARAMETERS.type, 'object');
  assert.deepEqual([...CAPABILITY_SEARCH_PARAMETERS.required], ['query', 'src']);
  assert.equal(CAPABILITY_SEARCH_PARAMETERS.additionalProperties, false);
  assert.equal(CAPABILITY_SEARCH_PARAMETERS.properties.query.type, 'string');
  assert.equal(CAPABILITY_SEARCH_PARAMETERS.properties.query.minLength, 1);
  assert.deepEqual([...CAPABILITY_SEARCH_PARAMETERS.properties.src.enum], ['local']);
  assert.ok(Object.isFrozen(CAPABILITY_SEARCH_PARAMETERS.properties.src.enum));
  const search = object(object(tools.search).parameters);
  assert.equal(search.query, CAPABILITY_SEARCH_PARAMETERS.properties.query.description);
  assert.equal(search.src, CAPABILITY_SEARCH_PARAMETERS.properties.src.description);
  assert.match(CAPABILITY_SEARCH_PARAMETERS.properties.src.description, /local:/);
  assert.doesNotMatch(CAPABILITY_SEARCH_PARAMETERS.properties.src.description, /\bremote:|\ball:/);

  assert.equal(SUBMIT_RESULT_PARAMETERS.type, 'object');
  assert.deepEqual([...SUBMIT_RESULT_PARAMETERS.required], ['refs']);
  assert.equal(SUBMIT_RESULT_PARAMETERS.additionalProperties, false);
  assert.equal(SUBMIT_RESULT_PARAMETERS.properties.refs.type, 'array');
  assert.equal(SUBMIT_RESULT_PARAMETERS.properties.refs.items.type, 'string');
  assert.equal(object(object(tools.submit).parameters).refs, SUBMIT_RESULT_PARAMETERS.properties.refs.description);
});

test('fixed policy text retains the actual interface/Skill path guidance', () => {
  const policy = asset('capability-policy.json');
  assert.equal(Object.hasOwn(policy, 'remoteSearchDisabled'), false);
  assert.equal(capabilityBudgetWarning('warning text'), `warning text\n\n${String(policy.budgetWrapUp)}`);
  assert.equal(typeof policy.memoryHeader, 'string');
  assert.match(String(policy.memoryHeader), /Use the selected tool declarations or returned interfaces for calls\. Read Skill entry files by their listed absolute paths\./);
  assert.doesNotMatch(String(policy.memoryHeader), /read returned tool:\/\/|namespace:\/\/ refs for interface details/);
  assert.equal(policy.submissionEmpty, 'Submission accepted: no relevant capability found. Stop now.');
});

test('registered Capability metadata uses external text without obsolete approval guidance', () => {
  const registered: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
  capabilityExtension({ registerTool: (tool: typeof registered[number]) => registered.push(tool), getAllTools: () => [], getActiveTools: () => [], on() {} });
  const tool = registered.find((candidate) => candidate.name === CAPABILITY_TOOL_NAME);
  assert.ok(tool);
  assert.equal(tool.name, CAPABILITY_TOOL_NAME);
  assert.equal(tool.description, CAPABILITY_TOOL_DESCRIPTION);
  const text = publicText();
  assert.equal(tool.promptSnippet, text.snippet);
  assert.deepEqual(tool.promptGuidelines, text.guidelines);
  assert.doesNotMatch([tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join('\n'), /needs_approval|approval receiver|npm marketplace/);
  assert.doesNotMatch(CAPABILITY_DISCOVERY_SYSTEM_PROMPT + CAPABILITY_DISCOVERY_PROMPT, /approval receiver|npm marketplace/);
});

test('memory projection uses the external policy header', () => {
  const result = { status: 'ok', tools: [{ ref: 'tool://test', name: 'test', description: 'test', exposure: 'direct' }], mcp: [], skills: [] };
  const branch = [{ type: 'custom', customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, result } }];
  const projected = capabilityPromptTranscript([{ role: 'system', content: 'Original system' }], branch);
  const section: unknown = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.equal(typeof section, 'string');
  assert.ok(String(section).includes(String(asset('capability-policy.json').memoryHeader)));
});
