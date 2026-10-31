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
import test from "node:test";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxProvider, InMemoryCredentialStore, getCurrentTools } from "@earendil-works/pi-ai";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";

import { capabilityAllowsTool } from "../../src/capability/scope.ts";
import type { CapabilityScopedTool, CapabilityToolCatalog } from "../../src/capability/scope.ts";
import { ModelRuntimeBridgeError } from "../../src/subagent/model-runtime.ts";
import { createNativeSessionFactory } from "../../src/subagent/native-session.ts";
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { SubagentError } from "../../src/subagent/runtime.ts";
import type {
  NativeChildSurfaceScope,
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

async function harness(): Promise<Harness> {
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
  readonly cwd?: string;
  readonly trusted?: boolean;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly model?: Model<Api> | null;
  readonly thinkingLevel?: string | null;
  readonly excludedTools?: readonly string[];
  readonly surface?: NativeChildSurfaceScope;
  readonly signal?: AbortSignal;
}

function request(h: Harness, options: RequestOptions = {}): NativeSessionRequest {
  const agentId = options.agentId ?? "sub_1";
  const cwd = options.cwd ?? h.cwd;
  const excludedTools = options.excludedTools ?? ["bash"];
  return {
    agentId,
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
      cwd,
      allowInherited: false,
      excludedTools: [...excludedTools],
    },
    signal: options.signal ?? new AbortController().signal,
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
  await writeFile(path.join(h.root, "agent", "settings.json"), JSON.stringify({
    extensions: [new URL("../../extensions/harness.ts", import.meta.url).pathname],
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
    assert.ok(!loaded.extensions.some((extension) => extension.resolvedPath.endsWith("/extensions/harness.ts")));
    assert.equal(h.surfaces.length, 1);
    assert.ok(loaded.extensions.some((extension) => extension.commands.has("mcp")), "Fresh retains the MCP execution backend");
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "default_extension"), true);
    assert.equal(capabilityAllowsTool(opened.capabilityScope, "denied_extension"), false);
    assert.deepEqual(lifecycle, ["started"], "default extension session_start actually runs");
    const stored = JSON.parse(await readFile(path.join(h.root, "agent", "settings.json"), "utf8"));
    assert.deepEqual(stored.extensions, [new URL("../../extensions/harness.ts", import.meta.url).pathname], "child-only resource exclusions do not change user settings");
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
