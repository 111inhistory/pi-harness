#!/usr/bin/env node
/**
 * Online acceptance entry for manual capabilities.
 *
 * Runs a real SDK session with the real harness assembly, a real model from the
 * configured providers and the real MCP servers from `mcp.json`. The offline
 * suite (`test/typed/capability-manual-sdk.test.ts`) covers the same contract
 * with a scripted model and a synthetic stdio server; this entry repeats it
 * against the user's own providers and MCP servers.
 *
 * The manual policy is passed to this session in memory. For MCP tools the list
 * is resolved from the names that actually registered (a server name with a
 * hyphen maps to a sanitized tool prefix) and written into the same config
 * object the command's prepare reads, so `/capability enable` re-applies the
 * identical list. The script never edits `harness.json`. It never creates, edits or deletes configuration, never
 * prints credentials, URLs, headers, environment values or tool result values,
 * and writes no session file. By default it only lists and activates MCP tools;
 * `--call` makes the model call one explicitly chosen read-only tool once, so the
 * operator decides which server-side effect, if any, a run has.
 *
 * Requirements (the script only checks them):
 *   - model auth: `auth.json` in the agent directory or a provider environment key
 *   - `<agentDir>/mcp.json` with at least one enabled server
 *
 * Usage:
 *   node --import tsx scripts/verify-capability-manual-online.mjs [options]
 *
 * Options:
 *   --agent-dir <dir>   Pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
 *   --model <p/id>      Model to use (default: the first model with configured auth)
 *   --server <name>     MCP server from mcp.json (default: the first enabled server)
 *   --call <tool>       After enablement, make the model call this MCP tool once
 *   --args <json>       Arguments for --call (default: {})
 *   --tool <name>       Manual fixture tool name (default: manual_fixture)
 *   --timeout <ms>      Whole-run timeout (default: 300000)
 *   --wait <ms>         How long to wait for the MCP server to register (default: 30000)
 *   -h, --help
 *
 * Exit codes: 0 pass, 1 failed verification, 2 missing dependencies.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../extensions/capability.ts';
import { manualToolMatcher } from '../src/capability/manual-tools.ts';
import { installCapabilityMcp } from '../src/capability/native-discovery.ts';
import { capabilityRootOnlyPolicy, setCapabilityRootOnlyPolicy } from '../src/capability/scope.ts';
import { loadHarnessConfig } from '../src/harness-config.ts';
import { installResultRendering } from '../src/result-rendering.ts';
import subagentExtension from '../src/subagent/extension.ts';

const { values: options } = parseArgs({
  options: {
    'agent-dir': { type: 'string' },
    model: { type: 'string' },
    server: { type: 'string' },
    tool: { type: 'string', default: 'manual_fixture' },
    call: { type: 'string' },
    args: { type: 'string', default: '{}' },
    timeout: { type: 'string', default: '300000' },
    wait: { type: 'string', default: '30000' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (options.help) {
  process.stdout.write(`Online manual-capability acceptance.

  node --import tsx scripts/verify-capability-manual-online.mjs [--agent-dir DIR] [--model PROVIDER/ID]
                                                              [--server NAME] [--tool NAME] [--call TOOL]
                                                              [--args JSON] [--timeout MS] [--wait MS]

Exit codes: 0 pass, 1 failed verification, 2 missing dependencies.
`);
  process.exit(0);
}

const agentDir = path.resolve(options['agent-dir'] ?? process.env['PI_CODING_AGENT_DIR'] ?? path.join(process.env['HOME'] ?? '.', '.pi', 'agent'));
const cwd = process.cwd();
const toolName = options.tool;
const MARKER = 'MANUAL_ONLINE_FIXTURE_EXECUTED';
const blocked = [];
const failures = [];
const report = (line) => process.stdout.write(`${line}\n`);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const mcpConfig = await readJson(path.join(agentDir, 'mcp.json'));
const serverNames = Object.entries(mcpConfig?.mcpServers ?? {})
  .filter(([, config]) => config === null || typeof config !== 'object' || config.enabled !== false)
  .map(([name]) => name);
if (serverNames.length === 0) blocked.push(`no enabled MCP server in ${path.join(agentDir, 'mcp.json')}`);
const server = options.server ?? serverNames[0];
if (server !== undefined && serverNames.length > 0 && !serverNames.includes(server)) {
  blocked.push(`MCP server "${server}" is not enabled in mcp.json`);
}

const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const available = await runtime.getAvailable().catch(() => []);
if (available.length === 0) blocked.push('no model with configured auth (auth.json or provider environment keys)');
let model = available[0];
if (options.model !== undefined) {
  const slash = options.model.indexOf('/');
  model = slash > 0 ? runtime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1)) ?? undefined : undefined;
  if (model === undefined) blocked.push(`model "${options.model}" is not registered`);
}

if (blocked.length > 0) {
  report('[blocked] online acceptance needs, and did not find:');
  for (const item of blocked) report(`  - ${item}`);
  report('');
  report('The script created and changed nothing. Add the missing configuration, then rerun:');
  report('  node --import tsx scripts/verify-capability-manual-online.mjs');
  process.exit(2);
}

const config = loadHarnessConfig({ cwd, agentDir, projectTrusted: false });
const manualConfig = {
  ...config,
  capability: {
    ...config.capability,
    // The MCP entries are added after registration, from the names the server
    // really registered: a raw server name is not the tool prefix (for example
    // computer-use-linux registers mcp__computer_use_linux__*).
    manualTools: [toolName, 'read_mcp_resource'],
  },
};

const workDir = await mkdtemp(path.join(tmpdir(), 'pi-manual-online-'));
process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(workDir, 'uds');
let harnessApi;
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
});
let session;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  session?.dispose();
}, Number(options.timeout));

try {
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      {
        name: 'manual-online-fixture',
        factory: (api) => {
          api.registerTool({
            name: toolName,
            label: 'Manual online fixture',
            description: 'Returns a fixed marker. Only the user may enable it.',
            parameters: { type: 'object', properties: {} },
            defaultActive: true,
            async execute() {
              return { content: [{ type: 'text', text: MARKER }], details: {} };
            },
          });
        },
      },
      {
        // The real harness assembly, with this run's in-memory manual policy and
        // a temporary MCP log, so the user's agent directory is not written.
        name: 'harness',
        factory: (api) => {
          harnessApi = api;
          installResultRendering(api);
          // Capability goes first so its fixed config becomes this surface's
          // provider; the other installs reuse it instead of reading the disk.
          capabilityExtension(api, { config: manualConfig });
          subagentExtension(api);
          installCapabilityMcp(api, { logPath: path.join(workDir, 'mcp.log') });
        },
      },
    ],
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) throw new Error(`extension load failed: ${loadErrors.map(String).join('; ')}`);

  session = (await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  })).session;
  await session.bindExtensions({});
  report(`[info] provider=${model.provider} model=${model.id} server=${server} agentDir=${agentDir}`);

  const deadline = Date.now() + Number(options.wait);
  const belongsToServer = (tool) => tool.namespace?.aliases?.includes(server) === true
    || tool.namespace?.name === `mcp__${server}`;
  while (Date.now() < deadline && !session.getAllTools().some(belongsToServer)) {
    await sleep(100);
  }
  const mcpTools = session.getAllTools().filter(belongsToServer);
  if (mcpTools.length === 0) throw new Error(`MCP server "${server}" registered no tools; pick another with --server`);
  const resourceReader = session.getAllTools().some((tool) => tool.name === 'read_mcp_resource');
  if (harnessApi === undefined) throw new Error('the harness extension factory did not run');

  // Resolve the manual names from what actually registered, write them into the
  // config source the command's prepare reads, and apply the same policy now.
  // Mutating the one config object (not adding a restore hook) keeps the runtime
  // policy and the command's re-application identical.
  const manualNames = [toolName, ...(resourceReader ? ['read_mcp_resource'] : []), ...mcpTools.map((tool) => tool.name)];
  const manualPolicy = manualToolMatcher(manualNames);
  manualConfig.capability.manualTools = manualNames;
  setCapabilityRootOnlyPolicy(harnessApi, manualPolicy);
  if (manualPolicy(toolName) !== true) failures.push(`the manual policy does not cover ${toolName}`);
  if (options.call !== undefined) {
    if (!mcpTools.some((tool) => tool.name === options.call)) {
      throw new Error(`--call ${options.call} is not a tool of server "${server}"; choose one of: ${mcpTools.map((tool) => tool.name).join(',')}`);
    }
    if (manualPolicy(options.call) !== true) failures.push(`the manual policy does not cover ${options.call}`);
    if (capabilityRootOnlyPolicy(harnessApi)?.(options.call) !== true) failures.push(`the session policy does not cover ${options.call}`);
    report(`[info] manual policy covers ${options.call} by exact registered name`);
  }

  await session.prompt('Reply with the single word READY. Do not call any tool.');
  if (session.getActiveToolNames().includes(toolName)) failures.push(`${toolName} stayed active before /capability enable`);
  const activeMcpBefore = mcpTools.filter((tool) => session.getActiveToolNames().includes(tool.name));
  if (activeMcpBefore.length > 0) failures.push(`MCP tools were active before /capability enable: ${activeMcpBefore.map((tool) => tool.name).join(',')}`);
  report(`[info] before enable: active=${session.getActiveToolNames().length} fixtureActive=${session.getActiveToolNames().includes(toolName)}`);

  const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === 'capability');
  if (command === undefined) throw new Error('/capability is not registered');
  const notices = [];
  const commandContext = session.extensionRunner.createCommandContext();
  Object.defineProperty(commandContext, 'ui', {
    value: { notify: (text, type = 'info') => { notices.push({ text, type }); } },
  });
  const enableNames = [toolName, ...(resourceReader ? ['read_mcp_resource'] : []), ...mcpTools.map((tool) => tool.name)];
  await command.handler(`enable ${enableNames.join(' ')}`, commandContext);
  report(`[info] /capability enable -> ${notices.map((notice) => notice.type).join(',') || 'no notice'}`);
  for (const name of enableNames) {
    if (!session.getActiveToolNames().includes(name)) failures.push(`${name} was not activated by /capability enable`);
  }
  if (options.call !== undefined) {
    // The command re-applies the policy from the config source; prove that source
    // and the resulting runtime policy still classify the target as manual.
    if (!manualConfig.capability.manualTools.includes(options.call)) {
      failures.push(`the config source does not list ${options.call} as manual`);
    }
    if (capabilityRootOnlyPolicy(harnessApi)?.(options.call) !== true) {
      failures.push(`the command re-application dropped ${options.call} from the manual policy`);
    }
    report(`[info] after /capability enable the manual policy still covers ${options.call}`);
  }

  await session.prompt(`Call the tool ${toolName} exactly once and reply with its output verbatim.`);
  const fixture = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === toolName);
  if (fixture === undefined) failures.push(`the model did not call ${toolName} after enablement`);
  else if (fixture.isError === true || !JSON.stringify(fixture.content).includes(MARKER)) {
    failures.push(`${toolName} did not return its marker`);
  } else {
    report(`[info] ${toolName} executed through the real model`);
  }
  report(`[info] MCP tools activated: ${mcpTools.length}; resource reader ${resourceReader ? 'enabled' : 'not registered by this server'}`);

  if (options.call !== undefined) {
    const callArgs = JSON.parse(options.args);
    await session.prompt(`Call the tool ${options.call} exactly once with these arguments: ${JSON.stringify(callArgs)}. Reply with its raw output.`);
    const result = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === options.call);
    if (result === undefined) failures.push(`the model did not call ${options.call}`);
    else {
      // Redacted evidence: shape and size only, never the server's values.
      const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const parts = [...new Set(result.content.map((part) => part.type))].join('+');
      if (result.isError === true) {
        failures.push(`${options.call} failed (parts=${parts} bytes=${text.length}); the result body is not printed`);
      } else {
        let keys = null;
        try {
          const parsed = JSON.parse(text);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) keys = Object.keys(parsed);
        } catch { /* not JSON */ }
        report(`[info] call ${options.call} args=${JSON.stringify(callArgs)} ok parts=${parts} bytes=${text.length} keys=${keys === null ? 'non-json' : keys.join(',')}`);
      }
    }
  }

  if (failures.length > 0) {
    report('[failed]');
    for (const failure of failures) report(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    report(options.call === undefined
      ? '[pass] manual gating and /capability enable verified online; no MCP tool was called'
      : `[pass] manual gating, /capability enable and one real MCP query call (${options.call}) verified online`);
  }
} catch (error) {
  report(`[failed] ${timedOut ? 'timed out; ' : ''}${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* already stale */ }
  session?.dispose();
  // Give the MCP stdio transports a moment to close their children.
  await sleep(500);
  await rm(workDir, { recursive: true, force: true });
  // MCP child processes and harness listeners may outlive dispose(); exit
  // explicitly so a passing run does not hang the shell.
  process.exit(process.exitCode ?? 0);
}
