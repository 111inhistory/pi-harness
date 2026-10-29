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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { capabilityAllowsTool } from "../../src/capability/scope.ts";
import type { CapabilityScopedTool, CapabilityToolCatalog } from "../../src/capability/scope.ts";
import { ModelRuntimeBridgeError } from "../../src/subagent/model-runtime.ts";
import { createNativeSessionFactory } from "../../src/subagent/native-session.ts";
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
