import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { offlineMcpTransport } from './support/offline-mcp-transport.ts';
import capabilityExtension from '../../src/capability/extension.ts';
import { CAPABILITY_STEP_TOOL_NAME } from '../../src/capability/contracts.ts';
import type { CapabilityStepFeedback } from '../../src/capability/agent.ts';
import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { waitFor } from '../../test-support/async.ts';

test('only mode + lazySchemas keeps matched group names but withholds only the schema from declarations and the Codemode directory', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-lazy-schemas-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  await mkdir(agentDir, { recursive: true });
  // One group ref (MCP server) and one exact tool ref: both withhold the same way,
  // and the exact ref must not touch peers of the tool's namespace.
  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({ version: 1, capability: { lazySchemas: ['mcp://big', 'tool://fixture-report'] } }));
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  const calls: { server: string; arguments: unknown }[] = [];
  const reports: unknown[] = [];
  const lateReports: unknown[] = [];
  const requests: { messages: { role: string }[] }[] = [];
  const internalToolNames: string[][] = [];
  const errors: unknown[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.classify = async (classifier) => ({
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { ready: { type: 'bool', probability: 1 } }, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 2, output: 1, totalTokens: 3, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    const response = (content: unknown[], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(),
      usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    } as AssistantMessage);
    const toolCall = (name: string, args: Record<string, unknown>): AssistantMessage => response([
      { type: 'toolCall', id: `call-${name}`, name, arguments: args },
    ], 'toolUse');
    let rootStep = 0;
    let childStep = 0;
    let plainOnly = false;
    let directScript = false;
    let scriptCode = `
          const d = await describeTool('mcp__big__search');
          const raw = await describeTool('fixture-report');
          const callable = await describeTool('fixture_report');
          const ns = await describeNamespace('mcp__big');
          if (!ns || !ns.tools || !ns.tools.includes('mcp__big__search')) throw Error('describeNamespace missing member');
          const out = await tools.mcp__big__search({ q: 'x', options: { mode: 'exact' } });
          const report = await tools.fixture_report({ title: 'Selected document' });
          return { status: 'LAZY_OK', mcp: d, raw, callable, out, report };
        `;
    runtime.streamSimple = (_model, context) => {
      const stream = new AssistantMessageEventStream();
      const internal = getCurrentTools(context.messages).some((entry) => entry.name === CAPABILITY_STEP_TOOL_NAME);
      let message: AssistantMessage;
      if (internal) {
        internalToolNames.push(getCurrentTools(context.messages).map((entry) => entry.name));
        childStep++;
        if (childStep === 1) {
          message = toolCall(CAPABILITY_STEP_TOOL_NAME, { queries: ['search'], refs: [] });
        } else if (childStep === 2) {
          const result = context.messages.findLast((entry) => entry.role === 'toolResult' && entry.toolName === CAPABILITY_STEP_TOOL_NAME);
          assert.ok(result && result.role === 'toolResult');
          const body = result.content.find((part) => part.type === 'text');
          assert.ok(body?.type === 'text');
          const stepDetails = JSON.parse(body.text) as CapabilityStepFeedback;
          assert.equal(stepDetails.searches[0]?.mcp.length, 1);
          message = toolCall(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: ['namespace://mcp__big', 'namespace://reports'], finish: true });
        } else {
          message = response([{ type: 'text', text: 'done' }], 'stop');
        }
      } else {
        requests.push(structuredClone(context));
        rootStep++;
        if (plainOnly) message = response([{ type: 'text', text: 'Done' }], 'stop');
        else if (directScript) { directScript = false; plainOnly = true; message = toolCall('codemode', { code: scriptCode }); }
        else if (rootStep % 3 === 1) message = toolCall('capability', {});
        else if (rootStep % 3 === 2) message = toolCall('codemode', { code: scriptCode });
        else message = response([{ type: 'text', text: 'Done' }], 'stop');
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end();
      return stream;
    };

    const transport = (server: string) => offlineMcpTransport(message => {
      let result: unknown;
      if (message.method === 'initialize') result = {
        protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: server, version: '1' }, instructions: `PRIVATE_CATALOG_${server}`,
      };
      else if (message.method === 'tools/list') result = { tools: [{
        name: 'search', description: 'Search the large service',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'The required document query.' },
            options: { $ref: '#/$defs/SearchOptions' },
          },
          required: ['q'],
          $defs: { SearchOptions: {
            type: 'object', properties: { mode: { type: 'string', enum: ['exact', 'prefix'] } }, required: ['mode'],
          } },
        },
        outputSchema: {
          type: 'object', properties: { total: { type: 'integer' }, document: { type: 'string' } }, required: ['total'],
        },
      }] };
      else if (message.method === 'tools/call') {
        const params = message.params as { arguments: unknown };
        calls.push({ server, arguments: params.arguments });
        result = {
          content: [{ type: 'text', text: 'MCP_EXECUTED' }],
          structuredContent: { total: 1, document: 'Selected document' },
        };
      } else result = { resources: [], resourceTemplates: [] };
      return result;
    });
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
      codemode: { mode: 'only' }, defaultTools: ['+codemode'],
    });
    const controlled = {
      name: 'lazy-harness',
      factory(api: ExtensionAPI) {
        pi = api;
        capabilityExtension(api);
        api.registerTool({
          name: 'fixture-report', label: 'Fixture report', description: 'Build a selected document report.',
          namespace: { name: 'reports', description: 'Search document reports' }, defaultActive: false,
          promptGuidelines: ['REPORT_GUIDELINE: keep the document title.'],
          parameters: {
            type: 'object', properties: { title: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['title'],
          },
          async execute(_id, input) {
            reports.push(input);
            return { content: [{ type: 'text', text: `Report: ${input['title']}` }], details: {} };
          },
        });
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: true, servers: [
            { name: 'big', source: 'test', config: { command: 'unused', exposure: 'codemode' } },
          ] }),
          createTransport: (entry) => transport(entry.name),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const natives = [
      { name: 'codemode', factory: createCodemodeExtension(), replaceable: true },
      { name: 'tool-search', factory: createToolSearchExtension(), replaceable: true },
      { name: 'mcp', factory: createMcpExtension(), replaceable: true },
    ];
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [controlled, ...natives],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(pi);
    await waitFor(() => pi!.getAllTools().some((entry) => entry.name === 'mcp__big__search'));

    await session.prompt('Select the big service and read one interface lazily');

    // Interfaces after activation: the lazy member is neither independently
    // declared nor inlined in the Codemode description.
    const afterActivation = requests[1];
    assert.ok(afterActivation, 'the request after activation must be captured');
    const declared = getCurrentTools(afterActivation.messages as unknown as never);
    assert.ok(!declared.some((entry) => entry.name === 'mcp__big__search'),
      'the lazy member must not be independently declared');
    const codemode = declared.find((entry) => entry.name === 'codemode');
    assert.ok(codemode, 'codemode stays declared');
    const directoryOf = (request: { messages: { role: string }[] }): string =>
      String(getCurrentTools(request.messages as unknown as never)
        .find((entry) => entry.name === 'codemode')?.description ?? '');
    assert.doesNotMatch(String(codemode.description), /mcp__big__search\(args:/,
      'the lazy MCP schema is on demand');
    assert.doesNotMatch(String(codemode.description), /q\?*:\s*string/,
      'the parameter schema of the lazy member never reaches the Codemode declaration');

    // The capability result keeps the member name but not its schema.
    const selected = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'capability');
    assert.ok(selected?.role === 'toolResult');
    assert.equal(selected.isError, false, JSON.stringify(selected.content));
    const selectedBody = selected.content.find((part) => part.type === 'text');
    assert.ok(selectedBody?.type === 'text');
    const publicSelection = JSON.parse(selectedBody.text) as { mcp: { interface?: string; tools?: { name?: string }[]; parameters?: unknown }[] };
    const group = publicSelection.mcp[0];
    assert.ok(group?.interface, 'the group must advertise a Codemode query interface');
    assert.deepEqual(group?.tools?.map((member) => member.name), ['mcp__big__search'], 'the member name is retained');
    assert.equal(group?.parameters, undefined, 'the group schema is not repeated');

    // describeTool returns the full interface and the script can call it.
    const executed = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(executed?.role === 'toolResult');
    assert.equal(executed.isError, false, JSON.stringify(executed.content));
    assert.match(String(codemode.description), /fixture[_-]report/,
      'the selected report name stays in the Codemode directory');
    assert.match(String(codemode.description), /Build a selected document report\./,
      'the selected report description stays');
    assert.doesNotMatch(String(codemode.description), /REPORT_GUIDELINE/,
      'the withheld guideline is projected by the guidance section, not the directory');
    assert.doesNotMatch(String(codemode.description), /fixture_report\(args:/,
      'the selected report schema is on demand');
    const guidanceCounts = requests.map((request) => {
      const sections = JSON.stringify(request.messages
        .filter((message) => message.role === 'system' && 'sections' in message)
        .map((message) => (message as { sections?: unknown }).sections ?? {}));
      return sections.split('REPORT_GUIDELINE').length - 1;
    });
    assert.ok(guidanceCounts.every((count) => count <= 1),
      'the withheld guideline is never duplicated in one request');
    assert.ok(guidanceCounts.includes(1), 'the withheld guideline is still projected once');
    const executedBody = executed.content.find((part) => part.type === 'text');
    assert.ok(executedBody?.type === 'text');
    const output = JSON.parse(executedBody.text.split('Output:\n')[1]!) as {
      status: string; mcp: string; raw: string; callable: string;
      out: { structuredContent: { total: number; document: string } }; report: string;
    };
    assert.equal(output.status, 'LAZY_OK');
    assert.match(output.mcp, /Search the large service/);
    assert.match(output.mcp, /mcp__big__search\(args:/);
    assert.match(output.mcp, /The required document query\./);
    assert.match(output.mcp, /\bq: string/, 'required input remains required');
    assert.doesNotMatch(output.mcp, /\bq\?:/);
    assert.match(output.mcp, /options\?: \{ mode: "exact" \| "prefix"; \}/,
      'optional local-ref input is expanded into the callable type');
    assert.match(output.mcp, /total: number/, 'the MCP structured output schema remains available');
    assert.match(output.mcp, /document\?: string/);
    assert.equal(output.raw, output.callable, 'raw and script-visible identifiers describe the same tool');
    assert.match(output.raw, /Build a selected document report\./);
    assert.match(output.raw, /REPORT_GUIDELINE: keep the document title\./);
    assert.match(output.raw, /fixture_report\(args: \{ title: string; verbose\?: boolean; \}\)/);
    assert.match(output.raw, /Promise<string>/,
      'a tool without a structured output schema is described as the text the sandbox returns');
    assert.deepEqual(output.out.structuredContent, { total: 1, document: 'Selected document' });
    assert.equal(output.report, 'Report: Selected document');
    assert.deepEqual(calls, [{ server: 'big', arguments: { q: 'x', options: { mode: 'exact' } } }],
      'the described MCP arguments reach the actual server');
    assert.deepEqual(reports, [{ title: 'Selected document' }],
      'the advertised identifier executes the selected extension tool');

    // A follow-up discovery must not re-send the lazy member's full schema to its
    // internal retrieval model. The inherited declaration was hidden from the
    // parent request, so the child must apply the same lazy mask.
    await session.prompt('Discover again to confirm the lazy schema is not re-inherited');
    assert.ok(internalToolNames.length >= 2, 'the second discovery ran an internal retrieval session');
    for (const names of internalToolNames) {
      assert.ok(!names.includes('mcp__big__search'),
        'no Capability internal retrieval request may re-declare the lazy member');
    }

    // Per-tool suffix modifiers through the real command: an explicit no-lazy
    // override restores the inlined interface, an explicit lazy override withholds
    // it again, and a conflicting duplicate batch is rejected without a write.
    const inspectTurn = async (prompt: string): Promise<string> => {
      assert.ok(session);
      plainOnly = true;
      requests.length = 0;
      await session.prompt(prompt);
      const request = requests.at(-1);
      assert.ok(request, 'the inspection turn issues a request');
      return directoryOf(request);
    };

    await session.prompt('/capability activate fixture-report[no-lazy]');
    assert.match(await inspectTurn('Inspect the explicit schema-backed report'),
      /fixture_report\(args:/, 'no-lazy restores the inlined interface');

    await session.prompt('/capability activate fixture-report[lazy]');
    assert.doesNotMatch(await inspectTurn('Inspect the explicit schema-on-demand report'),
      /fixture_report\(args:/, 'lazy withholds the interface again');

    await session.prompt('/capability activate fixture-report[lazy] fixture-report[no-lazy]');
    assert.doesNotMatch(await inspectTurn('Inspect after the rejected conflicting batch'),
      /fixture_report\(args:/, 'the rejected batch leaves the previous lazy mode in force');

    // A manual lazy activation of a tool that was NEVER discovered must still
    // show its name and description: the Codemode directory is the only catalog
    // a only-mode model reads, and no discovery memory may be invented.
    assert.ok(pi);
    pi.registerTool({
      name: 'fixture-late', label: 'Fixture late', description: 'Late undiscovered report.',
      namespace: { name: 'reports', description: 'Search document reports' }, defaultActive: false,
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      async execute(_id, input) {
        lateReports.push(input);
        return { content: [{ type: 'text', text: `Late: ${input['title']}` }], details: {} };
      },
    });
    await session.prompt('/capability activate fixture-late[lazy]');
    plainOnly = true;
    requests.length = 0;
    await session.prompt('Inspect the undiscovered schema-on-demand tool');
    const auditRequest = requests.at(-1);
    assert.ok(auditRequest, 'the audit turn issues a request');
    const auditTools = getCurrentTools(auditRequest.messages as unknown as never);
    assert.ok(!auditTools.some((entry) => entry.name === 'fixture-late'),
      'the undiscovered tool has no native declaration');
    const auditRecords = session.sessionManager.getBranch().filter((entry) => entry.type === 'custom');
    const membershipRecords = auditRecords.filter((entry) => entry.customType === 'capability-tool-base' || entry.customType === 'capability-tool-dynamic');
    assert.match(JSON.stringify(membershipRecords), /fixture-late/,
      'the manual command writes base/dynamic membership records');
    const discoveryRecords = auditRecords.filter((entry) => /discover/i.test(String(entry.customType)));
    assert.doesNotMatch(JSON.stringify(discoveryRecords), /fixture-late/,
      'the manual command writes no discovery record for the tool');
    const auditDirectory = directoryOf(auditRequest);
    assert.match(auditDirectory, /fixture[_-]late/, 'the undiscovered tool name is visible');
    assert.match(auditDirectory, /Late undiscovered report\./, 'the undiscovered tool description is visible');
    assert.doesNotMatch(auditDirectory, /fixture_late\(args:/, 'the undiscovered tool schema is on demand');
    const auditSections = JSON.stringify(auditRequest.messages
      .filter((message) => message.role === 'system' && 'sections' in message)
      .map((message) => (message as { sections?: unknown }).sections ?? {}));
    assert.doesNotMatch(auditSections, /fixture[_-]late/,
      'a manual activation writes no discovery memory for the tool');

    // The sandbox still builds the full interface, so the undiscovered tool runs.
    scriptCode = 'const out = await tools.fixture_late({ title: "late" }); return out;';
    plainOnly = false;
    directScript = true;
    await session.prompt('Run the undiscovered report through Codemode');
    const lateResult = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(lateResult?.role === 'toolResult');
    assert.equal(lateResult.isError, false, JSON.stringify(lateResult.content));
    assert.deepEqual(lateReports, [{ title: 'late' }], 'the withheld tool executes through the sandbox');

    // A dynamic member covered only by the local blacklist is denied. Base
    // membership then overrides that same recorded ban (the ban stays stored),
    // and removing base reasserts it immediately.
    await session.prompt('/capability blacklist add fixture-report');
    scriptCode = `
          const out = await tools.mcp__big__search({ q: 'x', options: { mode: 'exact' } });
          const report = await tools.fixture_report({ title: 'Blocked document' });
          return { out, report };
        `;
    plainOnly = false;
    directScript = true;
    const reportsBefore = reports.length;
    await session.prompt('Try the blacklisted report through Codemode');
    const blocked = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(blocked?.role === 'toolResult');
    assert.equal(blocked.isError, true, 'the blacklisted dynamic member is denied inside the sandbox');
    assert.equal(reports.length, reportsBefore, 'the blocked call never reaches the extension');

    plainOnly = true;
    await session.prompt('/capability base add fixture-report');
    const branchBlacklist = JSON.stringify(session.sessionManager.getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === 'capability-tool-blacklist'));
    assert.match(branchBlacklist, /fixture-report/, 'the local ban stays recorded after base add');

    // The manual branch ban is a hard fence: base membership does not lift it.
    plainOnly = false;
    directScript = true;
    const reportsWhileBanned = reports.length;
    await session.prompt('Try the base member while the manual ban stands');
    const stillBanned = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(stillBanned?.role === 'toolResult');
    assert.equal(stillBanned.isError, true, 'the manual ban wins over the base member');
    assert.equal(reports.length, reportsWhileBanned, 'the banned base member never reaches the extension');

    // Removing the ban exposes the recorded base membership again.
    plainOnly = true;
    await session.prompt('/capability blacklist remove fixture-report');
    requests.length = 0;
    await session.prompt('Inspect the base member without the ban');
    const exceptionRequest = requests.at(-1);
    assert.ok(exceptionRequest, 'the base-member inspection turn issues a request');
    const exceptionDirectory = directoryOf(exceptionRequest);
    assert.match(exceptionDirectory, /fixture[_-]report/, 'the base member is visible once the ban is removed');
    assert.match(exceptionDirectory, /Build a selected document report\./);
    assert.doesNotMatch(exceptionDirectory, /fixture_report\(args:/, 'its schema stays withheld by mode');

    plainOnly = false;
    directScript = true;
    const reportsBeforeException = reports.length;
    await session.prompt('Run the base member through Codemode');
    const exceptionResult = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(exceptionResult?.role === 'toolResult');
    assert.equal(exceptionResult.isError, false, JSON.stringify(exceptionResult.content));
    assert.equal(reports.length, reportsBeforeException + 1, 'the recorded base member executes once the ban is removed');

    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
