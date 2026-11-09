import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CodemodeSandbox, parseCodemodeSource, renderToolSample, type CodemodeTool, type CodemodeJsonSchema, toCodemodeIdentifier } from '@earendil-works/pi-codemode';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ClassifierContext, ImagesContext, ModelType, Usage } from '@earendil-works/pi-ai';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfigProvider } from '../harness-config.ts';
import { promptString } from '../prompt-text.ts';
import { lazySchemasActive, matchesLazySchemaRef, parseLazySchemaRefs } from './lazy-schemas.ts';

const codemodeScope = promptString('native-discovery.json', 'codemodeScope');

const STORE = 'codemode-store';
let workers = 0;
const workerWaiters: (() => void)[] = [];

function workerMaximum(): number {
  const configured = Number(process.env['PI_CODEMODE_MAX_WORKERS']);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 2;
}

async function reserveWorker(signal: AbortSignal | undefined, deadline: number): Promise<() => void> {
  while (workers >= workerMaximum()) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const index = workerWaiters.indexOf(wake);
        if (index !== -1) workerWaiters.splice(index, 1);
        if (error) {
          reject(error);
          if (workers < workerMaximum()) workerWaiters[0]?.();
        } else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(new DOMException('Codemode aborted while waiting for a worker.', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('Codemode worker admission timed out.')), Math.max(0, deadline - performance.now()));
      workerWaiters.push(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  if (signal?.aborted || performance.now() >= deadline) {
    // Admission was handed to this waiter. If it cannot consume the free slot,
    // pass that wake-up on rather than strand the next waiter until its deadline.
    workerWaiters[0]?.();
    if (signal?.aborted) throw new DOMException('Codemode aborted before starting.', 'AbortError');
    throw new Error('Codemode worker admission timed out.');
  }
  workers++;
  return () => { workers--; workerWaiters[0]?.(); };
}

function readStore(ctx: ExtensionToolContext): Record<string, unknown> {
  const store: Record<string, unknown> = Object.create(null);
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== STORE) continue;
    const data = entry.data as { set?: Record<string, unknown>; delete?: string[] } | undefined;
    if (!data || typeof data !== 'object') continue;
    for (const [key, value] of Object.entries(data.set ?? {})) store[key] = value;
    for (const key of data.delete ?? []) delete store[key];
  }
  return store;
}

function textOf(value: AgentToolResult<unknown>): string {
  return value.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function declaration(tool: AgentTool, guidelines: readonly string[] = []): Omit<CodemodeTool, 'execute'> {
  return { name: tool.name, description: [tool.description, ...guidelines].join('\n'), inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as CodemodeJsonSchema } : {}) };
}

function argsOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected function arguments.');
  return value;
}

function modelType(value: unknown): ModelType {
  if (value === 'chat' || value === 'classifier' || value === 'image') return value;
  throw new Error('Model type must be chat, classifier or image.');
}

function modelInfo<T extends object>(model: T): Omit<T, 'headers'> {
  const { headers: _privateHeaders, ...info } = model as T & { headers?: unknown };
  return info;
}

/** Reuse native model execution; resolve only catalog identities, never caller URLs/headers. */
function modelGlobals(ctx: ExtensionToolContext, addUsage: (usage: Usage | undefined) => void): CodemodeTool[] {
  const registry = ctx.modelRegistry;
  let active = 0;
  const waiting: (() => void)[] = [];
  const admit = async () => {
    if (active < 4) { active++; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return [
    { name: 'models.getModelsOfType', spread: true, execute(value) {
      const [type, provider] = argsOf(value);
      return registry.getModelsOfType(modelType(type), typeof provider === 'string' ? provider : undefined).map(modelInfo);
    } },
    { name: 'models.getAvailableOfType', spread: true, async execute(value, { signal }) {
      const [type, provider] = argsOf(value);
      return (await registry.getAvailableOfType(modelType(type), typeof provider === 'string' ? provider : undefined, { signal })).map(modelInfo);
    } },
    { name: 'models.getModelOfType', spread: true, execute(value) {
      const [type, provider, id] = argsOf(value);
      if (typeof provider !== 'string' || typeof id !== 'string') throw new Error('Expected model provider and id.');
      const model = registry.getModelOfType(modelType(type), provider, id);
      return model ? modelInfo(model) : undefined;
    } },
    ...(['classifier', 'image'] as const).map((type): CodemodeTool => ({
      name: type === 'classifier' ? 'models.classify' : 'models.generateImages', spread: true,
      async execute(value, { signal }) {
        const [input, context] = argsOf(value);
        if (!input || typeof input !== 'object') throw new Error('Expected a model catalog identity.');
        const { provider, id } = input as { provider?: unknown; id?: unknown };
        if (typeof provider !== 'string' || typeof id !== 'string') throw new Error('Expected model provider and id.');
        if (!context || typeof context !== 'object') throw new Error('Expected a model context.');
        await admit();
        try {
          if (signal.aborted) throw new DOMException('Codemode model call was aborted.', 'AbortError');
          if (type === 'classifier') {
            const model = registry.getModelOfType('classifier', provider, id);
            if (!model) throw new Error('Classifier is not in the model catalog.');
            const result = await registry.classify(model, context as ClassifierContext, { signal });
            addUsage(result.usage);
            return result;
          }
          const model = registry.getModelOfType('image', provider, id);
          if (!model) throw new Error('Image model is not in the model catalog.');
          const result = await registry.generateImages(model, context as ImagesContext, { signal });
          addUsage(result.usage);
          return result;
        } finally { release(); }
      },
    })),
  ];
}

function scopeDescription(description: string): string {
  return description.replace(/^.*searchTools.*$/gm, () => codemodeScope);
}

/**
 * The sandbox only reads a tool's name and description: `ALL_TOOLS` lists
 * `{ name, description }` and declarations are rendered host-side for
 * `describeTool`. One plain line keeps that catalog small; the parameter schema
 * and prompt guidelines stay in the full declaration.
 */
function summary(tool: AgentTool): string {
  const line = (tool.description ?? '').split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Keep Pi's Codemode declaration/loadout/renderers, but use its public sandbox
 * with an explicit global list. The built-in executor always installs searchTools;
 * this adapter never registers it. ALL_TOOLS and description helpers see only the
 * current active, permitted tools, not Pi's complete deferred registry.
 *
 * Both admission ports return one per-name predicate per operation, so the
 * caller resolves its view once and the loops below reuse it.
 */
export function installCapabilityCodemode(
  pi: ExtensionAPI,
  permitsFor: (ctx: ExtensionToolContext) => (name: string) => boolean,
  permitsDeclarationFor: () => (name: string) => boolean,
  configFor: HarnessConfigProvider = () => DEFAULT_HARNESS_CONFIG,
): () => ReadonlySet<string> {
  let hiddenDeclarations = new Set<string>();
  // Lazy-schema projection needs the effective harness config, which is loaded
  // from a context. Track the current one so prepareLoadout can read the refs
  // without an extra parameter on this entry point.
  let currentContext: ExtensionContext | undefined;
  pi.on('session_start', (_event, ctx) => { currentContext = ctx; });
  pi.on('before_agent_start', (_event, ctx) => { currentContext = ctx; });
  createCodemodeExtension()({
    ...pi,
    registerTool(definition) {
      // This factory registers one known tool; erase the API's unrelated generic
      // registrations without casting executable results or tool contexts.
      const native = definition as ToolDefinition;
      pi.registerTool({
        ...native,
        description: scopeDescription(native.description),
        prepareLoadout(loadout) {
          const active = new Set(loadout.declared.map((tool) => tool.name));
          const admits = permitsDeclarationFor();
          // Lazy schemas: while Codemode is active in only mode, matched groups
          // are withheld from the Codemode directory and from their own native
          // declaration. execute() still builds the full sandbox declarations, so
          // describeTool/executeTool keep working.
          const refs = parseLazySchemaRefs(currentContext ? configFor(currentContext).capability.lazySchemas : []);
          const lazy = lazySchemasActive(pi) && !refs.empty
            ? new Set(loadout.callable
                .filter((tool) => active.has(tool.name) && matchesLazySchemaRef(refs, tool.name, loadout.getNamespace(tool.name)))
                .map((tool) => tool.name))
            : new Set<string>();
          const scoped = { ...loadout, callable: loadout.callable.filter((tool) => active.has(tool.name) && admits(tool.name) && !lazy.has(tool.name)) };
          const changes = native.prepareLoadout?.(scoped);
          hiddenDeclarations = new Set([...(changes?.hiddenDeclarations ?? []), ...lazy]);
          const codemodeDescription = changes?.descriptions?.['codemode'];
          const descriptions = codemodeDescription === undefined
            ? changes?.descriptions
            : { ...changes?.descriptions, codemode: scopeDescription(codemodeDescription) };
          if (changes === undefined && lazy.size === 0) return undefined;
          return { ...(changes ?? {}), hiddenDeclarations: [...hiddenDeclarations], ...(descriptions === undefined ? {} : { descriptions }) };
        },
        // Pi uses this from the MCP `tool_call` handler to wait for the servers a call
        // may reach. A script's sandbox sees the already-active local catalog, so
        // neither listing (ALL_TOOLS, describeTool, describeNamespace) nor a lookup
        // needs an outer wait, and claiming every active tool would stall on unrelated
        // MCP servers. Nested calls still wait natively for their own server: the
        // sandbox executes them through `ctx.executeTool`, whose `tool_call` event is
        // handled by the MCP extension for the tool's owner before it runs.
        reachesTools: () => [],
        async execute(toolCallId, input, signal, onUpdate, ctx) {
          const config = configFor(ctx);
          const started = performance.now();
          const parsed = parseCodemodeSource((input as { code: string }).code);
          const active = new Set(pi.getActiveTools());
          const admits = permitsFor(ctx);
          const tools = ctx.tools.filter((tool) => tool.name !== 'codemode' && active.has(tool.name) && admits(tool.name));
          const declarations = new Map(tools.map((tool) => [tool.name, renderToolSample(declaration(tool,
            pi.getAllTools().find((entry) => entry.name === tool.name)?.promptGuidelines))]));
          const summaries = new Map(tools.map((tool) => [tool.name, summary(tool)]));
          const calls: { id: string; name: string; args: string; status: string; durationMs?: number; error?: string }[] = [];
          const publish = () => onUpdate?.({ content: [], details: { calls: calls.map((call) => ({ ...call })) } });
          let usage: Usage | undefined;
          const addUsage = (next: Usage | undefined) => {
            if (!next) return;
            if (!usage) { usage = structuredClone(next); return; }
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] += next[key];
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] += next.cost[key];
          };
          const deadline = parsed.options.timeoutMs === undefined ? Infinity : started + parsed.options.timeoutMs;
          let reservation: (() => void) | undefined = await reserveWorker(signal, Math.min(deadline, started + 60000));
          let sandbox: CodemodeSandbox | undefined;
          try {
            sandbox = new CodemodeSandbox({
              timeoutMs: Math.max(1, deadline - performance.now()),
              memoryLimitBytes: config.codemode.memoryLimitBytes,
              acquireWorker: () => {
                if (!reservation) throw new Error('Codemode worker reservation was already consumed.');
                const release = reservation; reservation = undefined; return release;
              },
              tools: tools.map((tool) => ({
                ...declaration(tool),
                description: summaries.get(tool.name) ?? '',
                async execute(args, { signal: nestedSignal }) {
                  const row = { id: `${toolCallId}/?`, name: tool.name, args: (JSON.stringify(args) ?? 'undefined').slice(0, 200), status: 'running' } as (typeof calls)[number];
                  calls.push(row); publish();
                  const start = performance.now();
                  try {
                    const outcome = await ctx.executeTool(tool.name, args, { signal: nestedSignal });
                    row.id = outcome.toolCall.id;
                    row.status = outcome.isError ? 'error' : 'ok';
                    if (tool.outputSchema && outcome.result.structuredContent !== undefined) return outcome.result.structuredContent;
                    const text = textOf(outcome.result);
                    if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed.`);
                    return text;
                  } catch (error) {
                    row.status = nestedSignal.aborted ? 'cancelled' : 'error';
                    row.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
                    throw error;
                  } finally { row.durationMs = performance.now() - start; publish(); }
                },
              })),
              globals: [
                { name: 'describeTool', spread: true, execute(value) {
                  const name = String(argsOf(value)[0]);
                  const tool = tools.find((entry) => entry.name === name || toCodemodeIdentifier(entry.name) === name);
                  return tool ? declarations.get(tool.name) : undefined;
                } },
                // Names and namespace metadata only; member schemas stay in describeTool.
                { name: 'describeNamespace', spread: true, execute(value) {
                  const name = String(argsOf(value)[0]);
                  const members = tools.filter((tool) => {
                    const ns = pi.getAllTools().find((entry) => entry.name === tool.name)?.namespace;
                    return ns && [ns.name, ...(ns.aliases ?? [])].some((alias) => alias === name || toCodemodeIdentifier(alias) === toCodemodeIdentifier(name));
                  });
                  if (!members.length) return undefined;
                  const ns = pi.getAllTools().find((entry) => entry.name === members[0]!.name)?.namespace;
                  return { ...ns, tools: members.map((tool) => tool.name) };
                } },
                ...modelGlobals(ctx, addUsage),
              ],
            });
            const result = await sandbox.execute(parsed.code, { ...(signal ? { signal } : {}), store: readStore(ctx) });
            if (result.ok && (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length)) pi.appendEntry(STORE, result.storeWrites);
            const output = result.output.filter((item) => item.type === 'text').map((item) => item.text);
            if (result.ok && result.value !== undefined) output.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value));
            if (!result.ok) output.push(`Script error: ${result.error.message}`);
            let text = output.join('\n');
            const limit = (parsed.options.maxOutputTokens ?? config.codemode.defaultMaxOutputTokens) * 4;
            let fullOutputPath: string | undefined;
            if (text.length > limit) {
              fullOutputPath = path.join(await mkdtemp(path.join(tmpdir(), 'pi-codemode-')), 'output.txt');
              await writeFile(fullOutputPath, text, { mode: 0o600 });
              text = `${text.slice(0, Math.floor(limit / 2))}\n…output truncated…\n${text.slice(-Math.floor(limit / 2))}\n[Full output: ${fullOutputPath}]`;
            }
            return {
              content: [
                { type: 'text' as const, text: `Script ${result.ok ? 'completed' : 'failed'}\nWall time ${((performance.now() - started) / 1000).toFixed(3)} seconds\nOutput:\n${text}` },
                ...result.output.filter((item) => item.type === 'image').map(({ type, data, mimeType }) => ({ type, data, mimeType })),
              ],
              details: { calls: calls.map((call) => ({ ...call, status: call.status === 'running' ? 'cancelled' : call.status })), ...(fullOutputPath ? { fullOutputPath } : {}) },
              ...(usage ? { usage: structuredClone(usage) } : {}),
              ...(result.ok ? {} : { isError: true }),
            };
          } finally {
            try { await sandbox?.close(); } finally { reservation?.(); }
          }
        },
      });
    },
  });
  // An active codemode/deferred tool can still have a direct declaration.
  // Reuse the native loadout's actual mask, not the global mode setting.
  return () => {
    const active = pi.getActiveTools();
    return new Set(active.filter((name) => !active.includes('codemode') || !hiddenDeclarations.has(name)));
  };
}
