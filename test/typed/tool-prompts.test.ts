import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../../extensions/capability.ts';

type Handler = (event: unknown) => unknown;
function fixture() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { name: string; exposure?: string }>();
  const active: string[] = [];
  // Registration-only fake: no tool execution, provider or session is opened.
  const api = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active,
    on(event: string, handler: Handler) { handlers.set(event, handler); return () => {}; },
    events: { emit() {}, on() { return () => {}; } },
  } as unknown as ExtensionAPI;
  capabilityExtension(api);
  return { handlers, tools, active };
}

test('Capability hides only the native Skill section, retaining task guidance', () => {
  const { handlers } = fixture();
  const event = { systemPromptOptions: { skills: [{ name: 'fixture' }], guidelines: ['EXISTING_RULE'], appendSystemPrompt: 'PROJECT_CONTEXT' } };
  handlers.get('before_agent_start')!(event);
  assert.deepEqual(event.systemPromptOptions.skills, []);
  assert.deepEqual(event.systemPromptOptions.guidelines, ['EXISTING_RULE']);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, 'PROJECT_CONTEXT');
});

test('retained declarations do not enable direct or nested execution', () => {
  const { handlers, tools, active } = fixture();
  tools.set('disabled', { name: 'disabled', exposure: 'direct' });
  tools.set('withdrawn', { name: 'withdrawn', exposure: 'hidden' });
  tools.set('indirect', { name: 'indirect', exposure: 'deferred' });
  const guard = handlers.get('tool_call')!;
  for (const parentToolCallId of [undefined, 'codemode-parent']) {
    for (const toolName of ['disabled', 'withdrawn', 'missing']) {
      const verdict = guard({ toolName, parentToolCallId });
      assert.ok(verdict && typeof verdict === 'object' && 'block' in verdict && verdict.block === true);
    }
    assert.equal(guard({ toolName: 'indirect', parentToolCallId }), undefined);
  }
  active.push('disabled');
  assert.equal(guard({ toolName: 'disabled' }), undefined);
});
