/**
 * Focused contract tests for the concrete native session factory.
 *
 * The factory is exercised against the real SDK resource loader, real
 * SettingsManager and real createAgentSession, with a provider-free faux model
 * catalog. The only test seams are the two host callbacks the factory declares
 * (child surface installation and parent capability lookup) plus the root
 * registry supplier; no legacy adapter code is copied here.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import test from "node:test";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache';
import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore, normalizeContext,
} from "@earendil-works/pi-ai";
import type { Api, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";

import { DEFAULT_HARNESS_CONFIG, resolveHarnessConfig } from "../../src/harness-config.ts";
import type { HarnessConfig } from "../../src/harness-config.ts";
import { capabilityAllowsTool } from "../../src/capability/scope.ts";
import type { CapabilityScopedTool, CapabilityToolCatalog } from "../../src/capability/scope.ts";
import { ModelRuntimeBridgeError } from "../../src/subagent/model-runtime.ts";
import { CACHE_IDENTITY_CUSTOM_TYPE } from "../../src/session-cache-runtime.ts";
import { createNativeSessionFactory } from "../../src/subagent/native-session.ts";
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { SubagentError } from "../../src/subagent/runtime.ts";
import type {
  NativeChildSurfaceScope,
  NativeOpenedSession,
  NativeSession,
  NativeSessionFactory,
  NativeSessionRequest,
} from "../../src/subagent/native-types.ts";

interface SurfaceInstallation {
  readonly api: ExtensionAPI;
  readonly scope: NativeChildSurfaceScope;
}

interface Harness {
  readonly root: string;
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly runtime: ModelRuntime;
  readonly parentTools: CapabilityScopedTool[];
  readonly surfaces: SurfaceInstallation[];
  readonly parentCalls: Array<string | null>;
  readonly factory: NativeSessionFactory;
  readonly mutable: {
    registry: unknown;
    surfaceHook: ((api: ExtensionAPI, scope: NativeChildSurfaceScope) => void) | null;
  };
}

async function harness(options: { config?: HarnessConfig } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "native-session-factory-"));
  const cwd = path.join(root, "work");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);

  const parentTools: CapabilityScopedTool[] = [
    { name: "capability" },
    { name: "surface_probe" },
    { name: "parent_only" },
    { name: "blocked_child" },
  ];
  const parentCatalog: CapabilityToolCatalog = { getAllTools: () => parentTools };
  const surfaces: SurfaceInstallation[] = [];
  const parentCalls: Array<string | null> = [];
  const mutable: Harness["mutable"] = { registry: { runtime }, surfaceHook: null };
  const factory = createNativeSessionFactory({
    agentDir,
    config: options.config ?? DEFAULT_HARNESS_CONFIG,
    modelRegistry: () => mutable.registry,
    installChildSurface: (api, scope) => {
      surfaces.push({ api, scope });
      api.registerTool({
        name: "surface_probe",
        label: "Surface Probe",
        description: "Prove the host installed this child surface.",
        parameters: { type: "object", properties: {} },
        defaultActive: false,
        execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
      });
      api.registerTool({
        name: "blocked_child",
        label: "Blocked Child",
        description: "Prove role denials reach the capability scope.",
        parameters: { type: "object", properties: {} },
        defaultActive: false,
        execute: async () => ({ content: [{ type: "text", text: "blocked" }], details: {} }),
      });
      mutable.surfaceHook?.(api, scope);
    },
    parentCapabilityScope: (originActor) => {
      parentCalls.push(originActor);
      return parentCatalog;
    },
  });
  return {
    root,
    cwd,
    model: faux.models[0],
    runtime,
    parentTools,
    surfaces,
    parentCalls,
    factory,
    mutable,
  };
}

interface RequestOptions {
  readonly agentId?: string;
  readonly inheritedTools?: readonly string[];
  readonly maxDepth?: number;
  readonly cwd?: string;
  readonly trusted?: boolean;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly model?: Model<Api> | null;
  readonly thinkingLevel?: string | null;
  readonly excludedTools?: readonly string[];
  readonly surface?: NativeChildSurfaceScope;
  readonly signal?: AbortSignal;
  readonly cacheKey?: string | null;
}

function request(h: Harness, options: RequestOptions = {}): NativeSessionRequest {
  const agentId = options.agentId ?? "sub_1";
  const cwd = options.cwd ?? h.cwd;
  const excludedTools = options.excludedTools ?? ["bash"];
  return {
    agentId,
    ...(options.inheritedTools === undefined ? {} : { inheritedTools: options.inheritedTools }),
    cwd,
    trusted: options.trusted ?? true,
    systemPrompt: options.systemPrompt === undefined ? "INHERITED SYSTEM PROMPT" : options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt ?? ["ROLE INSTRUCTIONS", "CHILD CONTEXT"],
    model: options.model === undefined ? h.model : options.model,
    thinkingLevel: options.thinkingLevel === undefined ? "high" : options.thinkingLevel,
    excludedTools,
    sessionManager: SessionManager.inMemory(cwd),
    surface: options.surface ?? {
      senderId: agentId,
      parentAgentId: agentId,
      capabilityParentId: "Main",
      depth: 1,
      maxDepth: options.maxDepth ?? DEFAULT_HARNESS_CONFIG.subagent.maxDepth,
      cwd,
      allowInherited: false,
      excludedTools: [...excludedTools],
    },
    signal: options.signal ?? new AbortController().signal,
    ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
  };
}

/**
 * Read the real AgentSession properties this factory's real SDK setup should
 * provide. The production port deliberately stays narrow, so the test narrows
 * structurally instead of casting the session to an unrelated shape.
 */
function inspectSession(session: NativeSession): {
  systemPrompt: string;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
} {
  if (!("systemPrompt" in session) || typeof session.systemPrompt !== "string") {
    throw new Error("the real AgentSession did not expose its system prompt");
  }
  if (!("settingsManager" in session) || !(session.settingsManager instanceof SettingsManager)) {
    throw new Error("the real AgentSession did not expose its SettingsManager");
  }
  if (!("resourceLoader" in session) || !(session.resourceLoader instanceof DefaultResourceLoader)) {
    throw new Error("the real AgentSession did not expose its DefaultResourceLoader");
  }
  return {
    systemPrompt: session.systemPrompt,
    settingsManager: session.settingsManager,
    resourceLoader: session.resourceLoader,
  };
}

async function close(h: Harness): Promise<void> {
  await rm(h.root, { recursive: true, force: true });
}

type UnknownRecord = Record<string, unknown>;

const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error('network access is forbidden in native-session-factory.test.ts');
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function record(value: unknown): UnknownRecord {
  const entry = asRecord(value);
  assert.ok(entry !== undefined);
  return entry;
}

function records(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = asRecord(entry);
    return parsed === undefined ? [] : [parsed];
  });
}

function toolNames(value: unknown): string[] {
  return records(value).flatMap((entry) => typeof entry['name'] === 'string' ? [entry['name']] : []);
}

function additionalToolNames(input: readonly unknown[]): string[] {
  return input.flatMap((item) => {
    const entry = asRecord(item);
    return entry?.['type'] === 'additional_tools' ? toolNames(entry['tools']) : [];
  });
}

function responsesInput(model: Model<Api>, messages: readonly unknown[]): readonly unknown[] {
  return convertResponsesMessages(
    model,
    normalizeContext({ messages: messages as Message[] }),
    new Set([model.provider]),
    {
      includeSystemPrompt: true,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    },
  ) as unknown as readonly unknown[];
}

async function anthropicPayload(
  model: Model<'anthropic-messages'>,
  messages: readonly unknown[],
): Promise<UnknownRecord> {
  let captured: unknown;
  const stream = streamAnthropic(model, normalizeContext({ messages: messages as Message[] }), {
    apiKey: 'offline-fixture',
    cacheRetention: 'none',
    fetch: offlineFetch,
    onPayload: (payload) => {
      captured = payload;
      throw new Error('payload captured');
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  return record(captured);
}

interface InheritedRun {
  readonly opened: NativeOpenedSession;
  readonly manager: SessionManager;
  readonly prefix: readonly unknown[];
  readonly context: readonly unknown[];
  readonly parentSystem: Message;
}

async function inheritedRun(
  h: Harness,
  model: Model<Api>,
  options: {
    readonly appendSystemPrompt?: readonly string[];
    readonly excludedTools?: readonly string[];
  } = {},
): Promise<InheritedRun> {
  const manager = SessionManager.inMemory(h.cwd);
  const parentSystem: Message = {
    role: 'system',
    content: '',
    sections: {
      preamble: 'PARENT PROMPT',
      tools: '<tools>\nPARENT TOOLS: surface_probe\n</tools>',
      rules: '<rules>\nPARENT RULES\n</rules>',
      cwd: `<cwd>\n${h.cwd.replace(/\\/g, '/')}\n</cwd>`,
    },
    toolsAdded: [{
      name: 'surface_probe',
      description: 'Parent surface probe',
      parameters: { type: 'object', properties: {} },
    }],
    timestamp: 0,
  };
  manager.appendMessage(parentSystem);
  manager.appendMessage({ role: 'user', content: 'PARENT TASK', timestamp: 1 });
  const prefix = manager.buildSessionContext().messages;
  const input: NativeSessionRequest = {
    ...request(h, {
      model,
      ...(options.excludedTools === undefined ? {} : { excludedTools: options.excludedTools }),
    }),
    sessionManager: manager,
    systemPrompt: 'PARENT PROMPT',
    appendSystemPrompt: options.appendSystemPrompt ?? [
      'COMMON CHILD INSTRUCTIONS',
      'INHERITED CONTEXT',
      'SOCKET CONTEXT',
    ],
    inheritedTools: ['read', 'surface_probe'],
  };
  const opened = await h.factory.open(input);
  let context: readonly unknown[] = [];
  h.runtime.streamSimple = (_requestModel, requestContext) => {
    context = structuredClone(requestContext.messages) as unknown[];
    const reply = {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: 'text' as const, text: 'DONE' }],
      stopReason: 'stop' as const,
      timestamp: Date.now(),
      usage: {
        input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply });
    stream.end();
    return stream;
  };
  try {
    await opened.execution.prompt('CHILD TASK', { expandPromptTemplates: false });
    return { opened, manager, prefix, context, parentSystem };
  } catch (error) {
    await opened.execution.dispose();
    throw error;
  }
}

function assertNoForbiddenExecution(run: InheritedRun): void {
  const current = getCurrentTools(run.context as unknown as readonly { role: string }[]);
  const registered = new Set(run.opened.capabilityScope.getAllTools().map((tool) => tool.name));
  const active = new Set(run.opened.execution.session.getActiveToolNames());
  for (const name of ['parent_only', 'manual_parent']) {
    assert.ok(!registered.has(name), `${name} is not registered in the child`);
    assert.ok(!active.has(name), `${name} is not active`);
    assert.ok(!current.some((tool) => tool.name === name), `${name} is not declared`);
  }
  assert.equal(capabilityAllowsTool(run.opened.capabilityScope, 'blocked_child'), false);
  assert.ok(!active.has('blocked_child'), 'blocked_child is not active');
  assert.ok(!current.some((tool) => tool.name === 'blocked_child'), 'blocked_child is not declared');
}

test("the factory bridges the current root registry and refuses an unavailable runtime", async () => {
  const h = await harness();
  try {
    assert.doesNotThrow(() => h.factory.assertModelRuntime());

    h.mutable.registry = {};
    assert.throws(
      () => h.factory.assertModelRuntime(),
      (error: unknown) => error instanceof ModelRuntimeBridgeError && error.code === "model_runtime_unavailable",
    );
    await assert.rejects(
      h.factory.open(request(h)),
      (error: unknown) => error instanceof ModelRuntimeBridgeError && error.code === "model_runtime_unavailable",
    );
    assert.equal(h.surfaces.length, 0, "a bridge failure happens before child setup");
  } finally {
    await close(h);
  }
});

test("open builds the real child Pi, resource loader and capability scope", async () => {
  const h = await harness();
  const input = request(h, { excludedTools: ["bash", "blocked_child"] });
  const opened = await h.factory.open(input);
  try {
    assert.equal(h.surfaces.length, 1);
    const installed = h.surfaces[0];
    assert.ok(installed !== undefined);
    assert.equal(installed.scope, input.surface, "the factory returns the actual child scope");
    assert.ok(installed.api.getAllTools().some((tool) => tool.name === "capability"));
    assert.ok(installed.api.getAllTools().some((tool) => tool.name === "surface_probe"));
    assert.equal(opened.capabilityScope, installed.api);

    const inspection = inspectSession(opened.execution.session);
    assert.equal(inspection.settingsManager.isProjectTrusted(), true);
    assert.equal(inspection.resourceLoader.getSystemPrompt(), "INHERITED SYSTEM PROMPT");
    assert.deepEqual(inspection.resourceLoader.getAppendSystemPrompt(), ["ROLE INSTRUCTIONS", "CHILD CONTEXT"]);
    assert.equal(opened.execution.session.model?.id, "faux-1");
    assert.equal(opened.execution.session.thinkingLevel, "high");

    const active = opened.execution.session.getActiveToolNames();
    assert.ok(active.includes("read"));
    assert.ok(!active.includes("bash"), "the request's exclusion reaches createAgentSession");

    assert.equal(capabilityAllowsTool(opened.capabilityScope, "surface_probe"), true);
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "parent_only"), true);
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "blocked_child"), false);
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "bash"), false);
    assert.ok(h.parentCalls.length > 0);
    assert.ok(h.parentCalls.every((origin) => origin === "Main"));

    // A revived parent is looked up again instead of freezing the catalog that
    // the first eligibility query saw.
    h.parentTools.push({ name: "late_parent" });
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "late_parent"), true);
    assert.ok(h.parentCalls.length >= 2);
  } finally {
    await opened.execution.dispose();
    await close(h);
  }
});

test("settings are cached per cwd and project trust", async () => {
  const h = await harness();
  const projectSettings = path.join(h.cwd, ".pi", "settings.json");
  await mkdir(path.dirname(projectSettings), { recursive: true });
  await writeFile(projectSettings, JSON.stringify({ defaultTools: ["read"] }), "utf8");

  const first = await h.factory.open(request(h, { trusted: true, excludedTools: [] }));
  const second = await h.factory.open(request(h, { trusted: true, excludedTools: [] }));
  const untrusted = await h.factory.open(request(h, { trusted: false, excludedTools: [] }));
  try {
    const firstSettings = inspectSession(first.execution.session).settingsManager;
    const secondSettings = inspectSession(second.execution.session).settingsManager;
    const untrustedSettings = inspectSession(untrusted.execution.session).settingsManager;

    assert.equal(firstSettings, secondSettings, "same cwd and trust reuse one manager");
    assert.notEqual(firstSettings, untrustedSettings, "project trust is part of the cache key");
    assert.equal(firstSettings.isProjectTrusted(), true);
    assert.equal(untrustedSettings.isProjectTrusted(), false);
    assert.deepEqual(firstSettings.getSettings().defaultTools, ["read"]);
    assert.equal(untrustedSettings.getSettings().defaultTools, undefined);

    assert.ok(first.execution.session.getActiveToolNames().includes("read"));
    assert.ok(!first.execution.session.getActiveToolNames().includes("bash"));
    assert.ok(untrusted.execution.session.getActiveToolNames().includes("bash"));
  } finally {
    await first.execution.dispose();
    await second.execution.dispose();
    await untrusted.execution.dispose();
    await close(h);
  }
});

test("Fresh uses default extensions minus exclusions without installing the root harness twice", async () => {
  const h = await harness();
  const extensionPath = path.join(h.cwd, ".pi", "extensions", "default-tools.ts");
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = path.join(h.root, "agent");
  const lifecycle: unknown[] = [];
  h.mutable.surfaceHook = (api) => { api.events.on("fresh_defaults_lifecycle", (event) => lifecycle.push(event)); };
  await mkdir(path.dirname(extensionPath), { recursive: true });
  await writeFile(extensionPath, `export default function(pi) {
    for (const name of ["default_extension", "denied_extension", "optional_extension"]) {
      pi.registerTool({ name, label: name, description: name,
        parameters: { type: "object", properties: {} },
        defaultActive: name !== "optional_extension",
        execute: async () => ({ content: [{ type: "text", text: "child extension executed" }], details: {} }),
      });
    }
    pi.on("session_start", () => {
      pi.events.emit("fresh_defaults_lifecycle", "started");
      pi.setActiveTools([...pi.getActiveTools(), "denied_extension"]);
    });
    pi.on("session_shutdown", () => pi.events.emit("fresh_defaults_lifecycle", "stopped"));
  }`, "utf8");
  const rootEntries = ['subagent', 'capability', 'btw'].map(name =>
    new URL(`../../extensions/${name}.ts`, import.meta.url).pathname);
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  await writeFile(path.join(h.root, "agent", "settings.json"), JSON.stringify({
    packages: [packageRoot],
    extensions: rootEntries,
    defaultTools: ["+codemode"],
  }), "utf8");
  h.parentTools.push({ name: "default_extension" }, { name: "denied_extension" }, { name: "optional_extension" });
  const opened = await h.factory.open(request(h, {
    systemPrompt: null,
    excludedTools: ["write", "denied_extension"],
  }));
  try {
    const session = opened.execution.session;
    const active = session.getActiveToolNames();
    assert.ok(active.includes("read"));
    assert.ok(active.includes("bash"));
    assert.ok(active.includes("default_extension"), "extension defaults are retained, not replaced with a builtin allowlist");
    assert.ok(active.includes("codemode"), "defaultTools additions are honored");
    assert.ok(!active.includes("optional_extension"), "registered does not mean enabled by default");
    assert.ok(!active.includes("denied_extension"), "excludeTools wins even over extension self-activation");
    assert.ok(!active.includes("write"));
    const inspection = inspectSession(session);
    const loaded = inspection.resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions.some((extension) => extension.resolvedPath === extensionPath));
    assert.ok(!loaded.extensions.some(extension => rootEntries.includes(extension.resolvedPath)));
    assert.equal(loaded.extensions.filter(extension => path.basename(extension.resolvedPath) === 'result-rendering.ts').length, 1,
      'package registration keeps rendering but does not reinstall root services');
    assert.equal(h.surfaces.length, 1);
    assert.ok(loaded.extensions.some((extension) => extension.commands.has("mcp")), "Fresh retains the MCP execution backend");
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "default_extension"), true);
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "denied_extension"), false);
    assert.deepEqual(lifecycle, ["started"], "default extension session_start actually runs");
    const stored = JSON.parse(await readFile(path.join(h.root, "agent", "settings.json"), "utf8"));
    assert.deepEqual(stored.packages, [packageRoot], 'child filtering does not change package registration');
    assert.deepEqual(stored.extensions, rootEntries, "child-only resource exclusions do not change user settings");
  } finally {
    await opened.execution.dispose();
    assert.deepEqual(lifecycle, ["started", "stopped"], "extension sessions close with the child");
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await close(h);
  }
});

test("Inherited loads configured execution backends while retaining the captured prompt", async () => {
  const h = await harness();
  const extensionPath = path.join(h.cwd, ".pi", "extensions", "inherited.ts");
  await mkdir(path.dirname(extensionPath), { recursive: true });
  await writeFile(extensionPath, `export default function(pi) {
    pi.registerTool({name:'inherited_extension', label:'Inherited fixture', description:'Fixture',
      parameters:{type:'object', properties:{}}, defaultActive:false,
      execute:async()=>({content:[{type:'text',text:'CHILD_BACKEND'}],details:{}})});
  }`, "utf8");
  h.parentTools.push({name:'inherited_extension'});
  const input = { ...request(h), inheritedTools: ['read', 'inherited_extension'] };
  const opened = await h.factory.open(input);
  try {
    const inspection = inspectSession(opened.execution.session);
    assert.deepEqual(inspection.resourceLoader.getExtensions().errors, []);
    assert.equal(inspection.resourceLoader.getSystemPrompt(), "INHERITED SYSTEM PROMPT");
    assert.ok(inspection.resourceLoader.getExtensions().extensions.some(extension => extension.resolvedPath === extensionPath));
    assert.ok(opened.capabilityScope.getAllTools().some(tool => tool.name === 'inherited_extension'));
    assert.ok(!opened.execution.session.getActiveToolNames().includes('inherited_extension'), 'factory waits for registration without applying the inherited loadout');
    // The Runner applies the final permitted loadout after factory readiness.
    opened.execution.session.setActiveToolsByName([...input.inheritedTools]);
    assert.ok(inspection.resourceLoader.getExtensions().extensions.some(extension => extension.commands.has('mcp')));
    let calls = 0;
    h.runtime.streamSimple = (_model, context) => {
      calls++;
      assert.ok(getCurrentTools(context.messages).some(tool => tool.name === 'inherited_extension'));
      if (calls === 2) {
        const result = context.messages.findLast(message => message.role === 'toolResult');
        assert.ok(result?.role === 'toolResult' && result.content.some(part => part.type === 'text' && part.text === 'CHILD_BACKEND'));
      }
      const message = {
        role: 'assistant' as const, api: h.model.api, provider: h.model.provider, model: h.model.id,
        content: calls === 1 ? [{type:'toolCall' as const,id:'child-call',name:'inherited_extension',arguments:{}}] : [{type:'text' as const,text:'DONE'}],
        stopReason: calls === 1 ? 'toolUse' as const : 'stop' as const, timestamp: Date.now(),
        usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}},
      };
      const stream = new AssistantMessageEventStream();
      stream.push({type:'done',reason:message.stopReason,message});
      stream.end();
      return stream;
    };
    await opened.execution.prompt('Run the inherited tool.', {expandPromptTemplates:false});
    assert.equal(calls, 2);
  } finally {
    await opened.execution.dispose();
    await close(h);
  }
});

test("ordinary inherited Responses keeps the serialized parent prefix stable across the native tail patch", async () => {
  const h = await harness();
  h.parentTools.push({ name: 'manual_parent' });
  const model = {
    ...h.model,
    api: 'openai-responses',
    baseUrl: 'http://offline.invalid/v1',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  } as Model<Api>;
  const run = await inheritedRun(h, model, { excludedTools: ['bash', 'blocked_child'] });
  try {
    assert.deepEqual(run.context.slice(0, run.prefix.length), run.prefix);

    const baseline = responsesInput(model, run.prefix);
    const appended = responsesInput(model, run.context);
    assert.deepEqual(appended.slice(0, baseline.length), baseline);

    const baselineTools = additionalToolNames(baseline);
    const appendedTools = additionalToolNames(appended);
    assert.ok(baselineTools.includes('surface_probe'), 'the parent initial declaration is the anchor');
    assert.deepEqual(appendedTools.slice(0, baselineTools.length), baselineTools);
    assert.doesNotMatch(JSON.stringify(run.context), /toolsRemoved|tools_removed|tool_removal/);

    assertNoForbiddenExecution(run);
  } finally {
    await run.opened.execution.dispose();
    await close(h);
  }
});

test("ordinary inherited Anthropic keeps its initial anchor and serialized parent prefix stable", async () => {
  const h = await harness();
  h.parentTools.push({ name: 'manual_parent' });
  const model = {
    ...h.model,
    api: 'anthropic-messages',
    baseUrl: 'http://offline.invalid',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  } as Model<Api>;
  const run = await inheritedRun(h, model, { excludedTools: ['bash', 'blocked_child'] });
  try {
    assert.deepEqual(run.context.slice(0, run.prefix.length), run.prefix);

    const baseline = await anthropicPayload(model as Model<'anthropic-messages'>, run.prefix);
    const appended = await anthropicPayload(model as Model<'anthropic-messages'>, run.context);
    assert.deepEqual(appended['system'], baseline['system']);
    assert.deepEqual(appended['tools'], baseline['tools']);
    assert.deepEqual(appended['betas'], baseline['betas']);
    const baselineMessages = records(baseline['messages']);
    assert.deepEqual(records(appended['messages']).slice(0, baselineMessages.length), baselineMessages);

    assert.deepEqual(toolNames(appended['tools']), ['surface_probe', '__pi_deferred_placeholder__']);
    const betas = appended['betas'];
    assert.ok(Array.isArray(betas) && betas.includes('inline-tools-2026-09-15'));
    assert.match(String(JSON.stringify(appended)), /COMMON CHILD INSTRUCTIONS/);
    assert.doesNotMatch(String(JSON.stringify(appended)), /tool_removal|toolsRemoved|tools_removed/);

    assertNoForbiddenExecution(run);
  } finally {
    await run.opened.execution.dispose();
    await close(h);
  }
});

type OnPayload = (payload: unknown, model: unknown) => unknown | Promise<unknown>;

function assistantReply(model: Model<Api>): AssistantMessageEventStream {
  const message = {
    role: 'assistant' as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text' as const, text: 'DONE' }],
    stopReason: 'stop' as const,
    timestamp: Date.now(),
    usage: {
      input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end();
  return stream;
}

test("native cache installer uses the inherited parent key instead of the local manager id", async () => {
  const h = await harness();
  const model = {
    ...h.model,
    api: 'openai-responses',
    baseUrl: 'http://offline.invalid/v1',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  } as Model<Api>;
  const input = request(h, { model, cacheKey: 'parent-cache-key' });
  const opened = await h.factory.open(input);
  try {
    let onPayload: OnPayload | undefined;
    let sessionId: string | undefined;
    h.runtime.streamSimple = (_requestModel, _context, options) => {
      onPayload = options?.onPayload as OnPayload | undefined;
      sessionId = options?.sessionId;
      return assistantReply(model);
    };
    await opened.execution.prompt('cache probe', { expandPromptTemplates: false });

    assert.ok(onPayload, 'the cache installer must compose an onPayload hook');
    const nativeKey = clampOpenAIPromptCacheKey(sessionId);
    assert.ok(nativeKey);
    assert.equal(sessionId, input.sessionManager.getSessionId());
    assert.notEqual(sessionId, 'parent-cache-key', 'local manager identity remains distinct');

    const adapted = await onPayload({ prompt_cache_key: nativeKey }, model) as Record<string, unknown>;
    assert.equal(adapted['prompt_cache_key'], 'parent-cache-key');

    const entry = input.sessionManager.getBranch().findLast((candidate) => {
      const value = candidate as { type?: string; customType?: string };
      return value.type === 'custom' && value.customType === CACHE_IDENTITY_CUSTOM_TYPE;
    }) as { data?: { key?: string } } | undefined;
    assert.equal(entry?.data?.key, 'parent-cache-key');
  } finally {
    await opened.execution.dispose();
    await close(h);
  }
});

test("fresh native session keeps its own local cache key", async () => {
  const h = await harness();
  const model = {
    ...h.model,
    api: 'openai-responses',
    baseUrl: 'http://offline.invalid/v1',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  } as Model<Api>;
  const input = request(h, { model, systemPrompt: null, appendSystemPrompt: ['FRESH CHILD'] });
  const opened = await h.factory.open(input);
  try {
    let onPayload: OnPayload | undefined;
    let sessionId: string | undefined;
    h.runtime.streamSimple = (_requestModel, _context, options) => {
      onPayload = options?.onPayload as OnPayload | undefined;
      sessionId = options?.sessionId;
      return assistantReply(model);
    };
    await opened.execution.prompt('fresh cache probe', { expandPromptTemplates: false });

    assert.ok(onPayload, 'the cache installer must compose an onPayload hook');
    const localKey = clampOpenAIPromptCacheKey(sessionId);
    assert.ok(localKey);
    assert.equal(sessionId, input.sessionManager.getSessionId());
    const adapted = await onPayload({ prompt_cache_key: localKey }, model) as Record<string, unknown>;
    assert.equal(adapted['prompt_cache_key'], localKey);
    assert.ok(!input.sessionManager.getBranch().some((candidate) => {
      const value = candidate as { type?: string; customType?: string };
      return value.type === 'custom' && value.customType === CACHE_IDENTITY_CUSTOM_TYPE;
    }), 'a fresh session writes no inherited identity');
  } finally {
    await opened.execution.dispose();
    await close(h);
  }
});

test("native cache hook gives an existing final onPayload override priority", async () => {
  const h = await harness();
  h.mutable.surfaceHook = (api) => {
    api.on('before_provider_request', (event) => ({
      ...(event.payload as Record<string, unknown>),
      prompt_cache_key: 'hook-final-key',
    }));
  };
  const model = {
    ...h.model,
    api: 'openai-responses',
    baseUrl: 'http://offline.invalid/v1',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  } as Model<Api>;
  const input = request(h, { model, cacheKey: 'parent-cache-key' });
  const opened = await h.factory.open(input);
  try {
    let onPayload: OnPayload | undefined;
    let sessionId: string | undefined;
    h.runtime.streamSimple = (_requestModel, _context, options) => {
      onPayload = options?.onPayload as OnPayload | undefined;
      sessionId = options?.sessionId;
      return assistantReply(model);
    };
    await opened.execution.prompt('composition probe', { expandPromptTemplates: false });

    assert.ok(onPayload);
    const nativeKey = clampOpenAIPromptCacheKey(sessionId);
    assert.ok(nativeKey);
    const adapted = await onPayload({ prompt_cache_key: nativeKey }, model) as Record<string, unknown>;
    assert.equal(adapted['prompt_cache_key'], 'hook-final-key', 'the existing hook has final authority');

    const entry = input.sessionManager.getBranch().findLast((candidate) => {
      const value = candidate as { type?: string; customType?: string };
      return value.type === 'custom' && value.customType === CACHE_IDENTITY_CUSTOM_TYPE;
    }) as { data?: { key?: string } } | undefined;
    assert.equal(entry?.data?.key, 'hook-final-key', 'the observed final key is recorded on lineage');
  } finally {
    await opened.execution.dispose();
    await close(h);
  }
});

test("Inherited refuses captured extension names without a child backend", async () => {
  const h = await harness();
  try {
    const input = {...request(h), inheritedTools:['parent_only']};
    await assert.rejects(h.factory.open(input),
      (error: unknown) => error instanceof SubagentError && error.code === 'inherited_tool_unavailable' && error.message.includes('parent_only'));
  } finally { await close(h); }
});

test("an unknown recorded thinking level fails explicitly before child setup", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      h.factory.open(request(h, { thinkingLevel: "ultra" })),
      (error: unknown) =>
        error instanceof SubagentError &&
        error.code === "invalid_request" &&
        error.detail["thinkingLevel"] === "ultra",
    );
    assert.equal(h.surfaces.length, 0, "no child Pi is built for an invalid recorded level");
    assert.equal(h.parentCalls.length, 0);
  } finally {
    await close(h);
  }
});

test("a child surface that fails to install fails before an SDK session is created", async () => {
  const h = await harness();
  h.mutable.surfaceHook = () => { throw new Error("surface installation failed"); };
  try {
    await assert.rejects(
      h.factory.open(request(h)),
      (error: unknown) =>
        error instanceof SubagentError &&
        error.code === "session_unavailable" &&
        error.message.includes("surface installation failed"),
    );
    assert.equal(h.surfaces.length, 1, "the host callback did run and its failure was reported");
  } finally {
    await close(h);
  }
});

test("an abort during child setup disposes the created SDK session", async () => {
  const h = await harness();
  const controller = new AbortController();
  h.mutable.surfaceHook = () => { controller.abort(); };
  try {
    await assert.rejects(
      h.factory.open(request(h, { signal: controller.signal })),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(h.surfaces.length, 1, "the child surface existed before the abort was observed");
  } finally {
    await close(h);
  }
});


test("Inherited waits for deferred MCP registration, restores its declaration, and calls the child backend", {timeout:15000}, async () => {
  const h = await harness();
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(h.root,'agent');
  const name = 'mcp__inherited_fixture__inspect';
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line); if(message.id===undefined)return;
      let result={};
      if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      if(message.method==='tools/list')result={tools:[{name:'inspect',description:'Inherited inspection',inputSchema:{type:'object',properties:{}}}]};
      if(message.method==='tools/call')result={content:[{type:'text',text:'CHILD_MCP_BACKEND'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
    });
  `;
  await writeFile(path.join(h.root,'agent','mcp.json'),JSON.stringify({autoEnableCodemode:false,mcpServers:{
    inherited_fixture:{command:process.execPath,args:['-e',script],exposure:'deferred'},
  }}));
  h.parentTools.push({name});
  const model = {...h.model,api:'openai-codex-responses' as Api};
  const input = {...request(h,{model,excludedTools:[]}),inheritedTools:['read',name]};
  input.sessionManager.appendCustomEntry('capability-discovery', {version:1,result:{status:'ok',tools:[],skills:[],
    mcp:[{ref:`tool://${name}`,name,kind:'tool',status:'available',server:'inherited_fixture'}],
    coverage:{local:'searched',remote:'not_searched'},
  }});
  input.sessionManager.appendMessage({role:'system',content:'PARENT_DECLARATIONS',timestamp:0,
    toolsAdded:[{name,description:'Inherited inspection',parameters:{type:'object',properties:{}}}],
  });
  const opened = await h.factory.open(input);
  try {
    assert.ok(opened.capabilityScope.getAllTools().some(tool=>tool.name===name));
    // The SDK may restore historical declarations as tools register; the Runner
    // still applies the final permitted loadout once after factory readiness.
    opened.execution.session.setActiveToolsByName([...input.inheritedTools]);
    assert.ok(opened.execution.session.getActiveToolNames().includes(name));
    let calls=0;
    h.runtime.streamSimple=(_model,context)=>{
      calls++;
      const declared=getCurrentTools(context.messages);
      assert.equal(declared.filter(tool=>tool.name===name).length,1,'inherited declaration is callable once, not a stale placeholder');
      const wire = convertResponsesMessages(model, context as unknown as TranscriptContext, new Set([model.provider]), {
        supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
      });
      const additions = wire.filter(item => item.type === 'additional_tools').flatMap(item => item.tools);
      assert.ok(additions.some(tool => tool.type === 'function' && tool.name === name), 'Responses wire preserves the inherited callable interface');
      if(calls===2){
        const result=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName===name);
        assert.ok(result?.role==='toolResult'&&result.content.some(part=>part.type==='text'&&part.text.includes('CHILD_MCP_BACKEND')));
      }
      const message={role:'assistant' as const,api:model.api,provider:model.provider,model:model.id,
        content:calls===1?[{type:'toolCall' as const,id:'mcp-call',name,arguments:{}}]:[{type:'text' as const,text:'DONE'}],
        stopReason:calls===1?'toolUse' as const:'stop' as const,timestamp:Date.now(),
        usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}},
      };
      const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
    };
    await opened.execution.prompt('Inspect the inherited resource.',{expandPromptTemplates:false});
    assert.equal(calls,2,JSON.stringify(input.sessionManager.getBranch()));
  } finally {
    await opened.execution.dispose();
    if(previousAgentDir===undefined)delete process.env['PI_CODING_AGENT_DIR'];else process.env['PI_CODING_AGENT_DIR']=previousAgentDir;
    await close(h);
  }
});

test("capability discovery follows the configured maximum depth", async () => {
  const shallowHarness = await harness();
  try {
    const shallow = await shallowHarness.factory.open(request(shallowHarness, {
      surface: { ...request(shallowHarness).surface, depth: 1, maxDepth: 2 },
    }));
    try {
      assert.ok(shallow.capabilityScope.getAllTools().some((tool) => tool.name === "capability"),
        "a child below the configured leaf keeps discovery");
    } finally {
      await shallow.execution.dispose();
    }
  } finally {
    await close(shallowHarness);
  }

  const leafHarness = await harness({ config: resolveHarnessConfig([{ source: "test", value: { subagent: { maxDepth: 1 } } }]) });
  try {
    const leaf = await leafHarness.factory.open(request(leafHarness, {
      surface: { ...request(leafHarness).surface, depth: 1, maxDepth: 1 },
    }));
    try {
      assert.ok(!leaf.capabilityScope.getAllTools().some((tool) => tool.name === "capability"),
        "the configured leaf depth loses discovery");
    } finally {
      await leaf.execution.dispose();
    }
  } finally {
    await close(leafHarness);
  }

  const deeperHarness = await harness({ config: resolveHarnessConfig([{ source: "test", value: { subagent: {
    maxDepth: 3,
    budgetsByDepth: {
      3: {
        modelCalls: { soft: 5, hard: 7 },
        activeTimeMs: { soft: 1_000, hard: 2_000 },
        lifetimeMs: 5_000,
      },
    },
  } } }]) });
  try {
    const deeper = await deeperHarness.factory.open(request(deeperHarness, {
      surface: { ...request(deeperHarness).surface, depth: 2, maxDepth: 3 },
    }));
    try {
      assert.ok(deeper.capabilityScope.getAllTools().some((tool) => tool.name === "capability"),
        "raising maxDepth moves the leaf boundary with it");
    } finally {
      await deeper.execution.dispose();
    }
  } finally {
    await close(deeperHarness);
  }
});

test("inherited MCP registration waits only the configured timeout", async () => {
  const h = await harness({
    config: resolveHarnessConfig([{ source: "test", value: { subagent: { inheritedToolWaitMs: 20 } } }]),
  });
  const started = performance.now();
  try {
    await assert.rejects(
      h.factory.open({ ...request(h), inheritedTools: ["mcp__missing__probe"] }),
      (error: unknown) => error instanceof SubagentError &&
        error.code === "inherited_tool_unavailable" &&
        error.message.includes("mcp__missing__probe"),
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 8_000, `the configured wait replaced the 10s default (elapsed ${Math.round(elapsed)}ms)`);
  } finally {
    await close(h);
  }
});
