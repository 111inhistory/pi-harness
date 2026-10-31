import assert from 'node:assert/strict';
import test from 'node:test';
import { promptText } from '../../src/prompt-text.ts';
import {
  CAPABILITY_STEP_PARAMETERS,
  CAPABILITY_STEP_TOOL_NAME,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
} from '../../src/capability/contracts.ts';
import {
  CAPABILITY_DISCOVERY_PROMPT,
  CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  capabilityBudgetWarning,
} from '../../src/capability/agent.ts';
import { CAPABILITY_DISCOVERY_RECORD } from '../../src/capability/discovery-record.ts';
import { CAPABILITY_SECTION, capabilityPromptTranscript } from '../../src/capability/prompt.ts';
import capabilityExtension from '../../extensions/capability.ts';

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

  assert.equal(CAPABILITY_STEP_TOOL_NAME, 'capability_step');
  const schema = CAPABILITY_STEP_PARAMETERS as unknown as {
    type: string;
    required?: string[];
    additionalProperties: boolean;
    properties: {
      queries: { type: string; items: { type: string }; description: string };
      refs: { type: string; items: { type: string }; description: string };
      finish: { type: string; default: boolean; description: string };
    };
  };
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required ?? [], []);
  assert.equal(schema.additionalProperties, false);

  const stepParameters = object(object(tools.step).parameters);
  assert.equal(schema.properties.queries.type, 'array');
  assert.equal(schema.properties.queries.items.type, 'string');
  assert.equal(stepParameters.queries, schema.properties.queries.description);

  assert.equal(schema.properties.refs.type, 'array');
  assert.equal(schema.properties.refs.items.type, 'string');
  assert.equal(stepParameters.refs, schema.properties.refs.description);

  assert.equal(schema.properties.finish.type, 'boolean');
  assert.equal(schema.properties.finish.default, false);
  assert.equal(stepParameters.finish, schema.properties.finish.description);
});

test('retrieval prompts and budget guidance use external assets', () => {
  const discovery = asset('capability-discovery.json');
  const policy = asset('capability-policy.json');
  assert.equal(CAPABILITY_DISCOVERY_SYSTEM_PROMPT, discovery.system);
  assert.equal(CAPABILITY_DISCOVERY_PROMPT, discovery.user);
  for (const field of ['memoryHeader', 'budgetWrapUp', 'additiveExecutionBlocked']) {
    assert.equal(typeof policy[field], 'string');
    assert.ok(String(policy[field]).trim().length > 0);
  }
  assert.equal(capabilityBudgetWarning('warning text'), `warning text\n\n${String(policy.budgetWrapUp)}`);
});

test('registered Capability metadata uses external text', () => {
  const registered: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
  capabilityExtension({ registerTool: (tool: typeof registered[number]) => registered.push(tool), getAllTools: () => [], getActiveTools: () => [], on: () => () => {} } as unknown as Parameters<typeof capabilityExtension>[0]);
  const tool = registered.find((candidate) => candidate.name === CAPABILITY_TOOL_NAME);
  assert.ok(tool);
  assert.equal(tool.name, CAPABILITY_TOOL_NAME);
  assert.equal(tool.description, CAPABILITY_TOOL_DESCRIPTION);
  const text = publicText();
  assert.equal(tool.promptSnippet, text.snippet);
  assert.deepEqual(tool.promptGuidelines, text.guidelines);
});

test('memory projection uses the external policy header', () => {
  const result = { status: 'ok', tools: [{ ref: 'tool://test', name: 'test', description: 'test', exposure: 'direct' }], mcp: [], skills: [] };
  const branch = [{ type: 'custom', customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, result } }];
  const projected = capabilityPromptTranscript([{ role: 'system', content: 'Original system' }], branch);
  const section: unknown = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.equal(typeof section, 'string');
  assert.ok(String(section).includes(String(asset('capability-policy.json').memoryHeader)));
});
