/**
 * P1 acceptance: the MCP adapter must preserve each tool's native exposure.
 *
 * The old adapter rewrote every non-hidden MCP tool to `deferred`. That erased
 * the difference between `direct`, `codemode` and `deferred`, which is what
 * `codemode.mode: "only"` and the declaration mask key off. These cases run the
 * real MCP extension through `installCapabilityMcp` with an offline transport and
 * assert the registered exposure, and that activation is decided by Capability
 * (every MCP tool starts inactive) rather than by the exposure rewrite.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { offlineMcpTransport } from './support/offline-mcp-transport.ts';

import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { waitFor } from '../../test-support/async.ts';

function offlineTransport(server: string, tool: string) {
  return offlineMcpTransport(message => {
    let result: unknown;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: tool, description: `${server} tool`, inputSchema: { type: 'object', properties: {} } }] };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'OK' }] };
    } else {
      result = { resources: [], resourceTemplates: [] };
    }
    return result;
  });
}

test('MCP adapter preserves native tool exposure and keeps tools inactive', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-exposure-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  const errors: unknown[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;

    // One server per exposure. `direct` is the case the old rewrite silently
    // turned into `deferred`; `codemode` is the script-only default.
    const servers = [
      { server: 'srv_direct', tool: 'inspect', exposure: 'direct' },
      { server: 'srv_codemode', tool: 'inspect', exposure: 'codemode' },
      { server: 'srv_deferred', tool: 'inspect', exposure: 'deferred' },
      { server: 'srv_hidden', tool: 'inspect', exposure: 'hidden' },
    ] as const;

    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
    const controlled = {
      name: 'harness-mcp-exposure',
      factory(api: ExtensionAPI) {
        pi = api;
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: servers.map((s) => ({
            name: s.server, source: 'test', config: { command: 'unused', exposure: s.exposure },
          })) }),
          createTransport: (entry) => offlineTransport(entry.name, 'inspect'),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [controlled],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime,
      model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(pi);
    for (const s of servers) {
      await waitFor(() => pi!.getAllTools().some((entry) => entry.name === `mcp__${s.server}__inspect`));
    }

    const exposureOf = (name: string) => pi!.getAllTools().find((entry) => entry.name === name)?.exposure;
    // The old rewrite turned every non-hidden MCP tool into `deferred`; this is
    // the case that catches it, because `direct` is what `only` mode hides.
    assert.equal(exposureOf('mcp__srv_direct__inspect'), 'direct', 'direct MCP tool must not be rewritten to deferred');
    // The SDK maps MCP config `codemode` to tool-level `deferred` (to keep the
    // tool out of the codemode description); the adapter must not change that.
    assert.equal(exposureOf('mcp__srv_codemode__inspect'), 'deferred', 'MCP codemode exposure maps to deferred and stays deferred');
    assert.equal(exposureOf('mcp__srv_deferred__inspect'), 'deferred', 'deferred exposure must survive');
    assert.equal(exposureOf('mcp__srv_hidden__inspect'), 'hidden', 'hidden exposure must stay hidden');

    // Capability owns activation: an exposed MCP tool is registered but not active.
    for (const s of servers.filter((entry) => entry.exposure !== 'hidden')) {
      assert.ok(!pi.getActiveTools().includes(`mcp__${s.server}__inspect`),
        `${s.server} tool must start inactive so Capability decides what to declare`);
    }
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

/**
 * Switching `codemode.mode` between `on` and `only` changes only the request
 * declaration projection. The set of active (enabled) tools must stay identical:
 * `only` hides direct declarations, it does not disable the tools.
 */
test('on vs only keeps the same active set and only hides direct declarations', () => {
  let mode: 'on' | 'only' = 'on';
  const definitions = new Map<string, import('@earendil-works/pi-coding-agent').ToolDefinition>();
  let active = ['codemode', 'direct_tool', 'deferred_tool'];
  const pi = {
    registerTool: (tool: import('@earendil-works/pi-coding-agent').ToolDefinition) => { definitions.set(tool.name, tool); },
    registerCommand: () => {},
    on: () => {},
    getSettings: () => ({ codemode: { mode } }),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
    getAllTools: () => [...definitions.values()],
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const declared = installCapabilityCodemode(pi, () => () => true, () => () => true);
  const names = ['codemode', 'direct_tool', 'deferred_tool'];
  const tools: AgentTool[] = names.map((name) => ({
    name, label: name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  }));
  const exposure = (name: string) => name === 'codemode' ? 'model-only' as const
    : name === 'direct_tool' ? 'direct' as const : 'deferred' as const;
  const runLoadout = () => definitions.get('codemode')!.prepareLoadout!({
    declared: tools, callable: tools.slice(1), registered: tools,
    getExposure: exposure, getNamespace: () => undefined, getPromptGuidelines: () => [],
  });

  pi.setActiveTools(names);
  runLoadout();
  const activeOn = [...pi.getActiveTools()].sort();
  assert.deepEqual([...declared()].sort(), [...names].sort(), 'on mode declares every active tool');

  mode = 'only';
  runLoadout();
  assert.deepEqual([...pi.getActiveTools()].sort(), activeOn, 'the active/enabled set never changes with mode');
  assert.ok(![...declared()].includes('direct_tool'), 'only mode hides the direct declaration');
  assert.ok([...declared()].includes('deferred_tool'), 'deferred stays declared in only mode');
  assert.ok([...declared()].includes('codemode'), 'codemode itself stays declared');
});
