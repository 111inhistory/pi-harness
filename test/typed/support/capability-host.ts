import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent';
import { installCapabilityCommand } from '../../../src/capability/command.ts';
import type { ToolPermissionTool } from '../../../src/capability/tool-permission.ts';

export interface CapabilityTestTool extends ToolPermissionTool { readonly description?: string }
export interface CapabilityTestEntry { type: string; customType?: string; data?: unknown; message?: unknown }

/** Registry and persistence ports only; permission decisions run in production code. */
export function capabilityHost(
  initial: readonly CapabilityTestTool[], active: readonly string[] = [],
  selection: 'visible' | 'registered' | 'all' = 'visible',
) {
  let tools = initial.map(tool => ({ ...tool }));
  const entries: CapabilityTestEntry[] = [];
  let selected = new Set(active);
  let appendFailure = false;
  const api = {
    entries,
    getAllTools: () => tools,
    getActiveTools: () => [...selected],
    activeNames: () => [...selected],
    setActiveTools(names: string[]) {
      selected = new Set(names.filter(name => selection === 'all' || tools.some(tool =>
        tool.name === name && (selection === 'registered' || tool.exposure !== 'hidden'))));
    },
    appendEntry(customType: string, data?: unknown) {
      if (appendFailure) throw new Error('the session branch is read-only');
      entries.push({ type: 'custom', customType, data });
    },
  };
  return {
    // Command installation needs the SDK type; this fixture implements only the ports above.
    api: api as unknown as ExtensionAPI & typeof api,
    branch: () => entries,
    activeNames: api.activeNames,
    entries: () => entries,
    failAppend(value: boolean) { appendFailure = value; },
    register(tool: CapabilityTestTool) {
      const index = tools.findIndex(candidate => candidate.name === tool.name);
      if (index < 0) tools.push({ ...tool });
      else tools[index] = { ...tool };
    },
    unregister(name: string) {
      tools = tools.filter(tool => tool.name !== name);
    },
  };
}

export function capabilityCommand(
  fixture: ReturnType<typeof capabilityHost>,
  select?: (labels: readonly string[]) => string | undefined,
  readBranch: () => readonly unknown[] = fixture.branch,
) {
  const notifications: { text: string; type: string }[] = [];
  let registered: RegisteredCommand | undefined;
  Object.assign(fixture.api, {
    registerCommand(name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) {
      registered = { name, ...options } as RegisteredCommand;
    },
  });
  installCapabilityCommand(fixture.api);
  assert.ok(registered);
  const command = registered;
  const context = {
    ui: {
      notify(text: string, type = 'info') { notifications.push({ text, type }); },
      select: async (_title: string, labels: string[]) => select?.(labels),
    },
    sessionManager: { getBranch: readBranch },
  } as unknown as ExtensionCommandContext;
  return {
    notifications,
    completions: async (prefix: string) => (await command.getArgumentCompletions?.(prefix)) ?? null,
    run: async (raw: string) => { await command.handler(raw, context); },
  };
}
