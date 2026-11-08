/**
 * Focused contract tests for the optional Shell Approval auto-review adapter.
 *
 * The package is optional and declares Node.js 24+. On Node 22 the adapter
 * must stop before loading it and return an explicit undecided result. The
 * integration cases run only when the runtime and package are both usable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
  InMemoryCredentialStore,
  type FauxResponseFactory,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import {
  AUTO_REVIEW_MIN_NODE_MAJOR,
  createShellReviewer,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_PROVIDER,
  type ShellReviewInput,
} from "../../src/shell-approval/reviewer.ts";

const NODE_MAJOR = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
const REVIEW_MODULE_SPECIFIER: string = "@mzwing/pi-permission-auto-review/review";
const packageAvailable = NODE_MAJOR >= AUTO_REVIEW_MIN_NODE_MAJOR && await (async (): Promise<boolean> => {
  try {
    const namespace: unknown = await import(REVIEW_MODULE_SPECIFIER);
    return namespace !== null && typeof namespace === "object";
  } catch {
    return false;
  }
})();
const integrationSkip = NODE_MAJOR < AUTO_REVIEW_MIN_NODE_MAJOR
  ? `requires Node.js ${AUTO_REVIEW_MIN_NODE_MAJOR}+`
  : packageAvailable ? false : "optional review package is unavailable";

const CODEX_API = "openai-codex-responses";

async function emptyRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

async function fauxRegistry(response: FauxResponseFactory): Promise<{
  readonly registry: ModelRegistry;
  readonly faux: ReturnType<typeof fauxProvider>;
}> {
  const faux = fauxProvider({
    api: CODEX_API,
    provider: DEFAULT_REVIEW_PROVIDER,
    models: [{ id: "codex-template", reasoning: true, contextWindow: 1_048_576 }],
  });
  faux.setResponses([response]);
  const runtime = await emptyRuntime();
  runtime.registerNativeProvider(faux.provider);
  return { registry: new ModelRegistry(runtime), faux };
}

function input(overrides: Partial<ShellReviewInput> = {}): ShellReviewInput {
  return {
    action: {
      shell: "bash",
      command: "printf hello",
      cwd: "/tmp/project",
      platform: "posix",
      source: "Main",
      reason: "The static policy left this ask open.",
    },
    context: { branch: [] },
    ...overrides,
  };
}

test("a runtime below the package minimum is explicitly undecided before loading", {
  skip: NODE_MAJOR >= AUTO_REVIEW_MIN_NODE_MAJOR ? "runtime satisfies the package minimum" : false,
}, async () => {
  const reviewer = createShellReviewer({ modelRegistry: new ModelRegistry(await emptyRuntime()) });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "unavailable");
  assert.match(result.reason, /Node\.js 24/);
  assert.match(result.reason, new RegExp(process.versions.node.replaceAll(".", "\\.")));
});

test("a missing optional review package is unavailability, not a denial", {
  skip: NODE_MAJOR < AUTO_REVIEW_MIN_NODE_MAJOR || packageAvailable
    ? "only runs on Node.js 24+ without the optional package"
    : false,
}, async () => {
  const reviewer = createShellReviewer({ modelRegistry: new ModelRegistry(await emptyRuntime()) });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "unavailable");
  assert.match(result.reason, /not installed|incompatible interface/);
});

test("a pre-aborted caller signal is cancelled before any model request", {
  skip: integrationSkip,
}, async () => {
  const { registry, faux } = await fauxRegistry(() => {
    throw new Error("the model must not be called");
  });
  const controller = new AbortController();
  controller.abort();

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const result = await reviewer.review(input({ signal: controller.signal }));

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "cancelled");
  assert.equal(faux.state.callCount, 0);
});

test("a valid assessment reuses the public prompt and returns allow", {
  skip: integrationSkip,
}, async () => {
  let capturedContext: TranscriptContext | null = null;
  let capturedModel: Model<string> | null = null;
  const { registry } = await fauxRegistry((context, _options, _state, model) => {
    capturedContext = context;
    capturedModel = model;
    return fauxAssistantMessage(JSON.stringify({
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
      rationale: "The command is a bounded local printf within the requested workspace.",
    }));
  });

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "allow");
  if (result.decision !== "allow") return;
  assert.equal(result.assessment.riskLevel, "low");
  assert.equal(result.assessment.userAuthorization, "high");
  assert.match(result.reason, /Automatic review allowed execution/);
  assert.match(result.reason, /risk: low; user authorization: high/);

  if (capturedContext === null) assert.fail("the public review prompt was not built");
  if (capturedModel === null) assert.fail("the hidden reviewer model was not selected");
  const context: TranscriptContext = capturedContext;
  const model: Model<string> = capturedModel;
  assert.equal(model.id, DEFAULT_REVIEW_MODEL, "the hidden reviewer model is derived");
  assert.equal(model.api, CODEX_API);

  const systemMessage = context.messages.find(message => message.role === "system");
  if (systemMessage?.role !== "system") assert.fail("the review system prompt was not sent");
  const systemPrompt = getSystemMessageText(systemMessage);
  assert.match(systemPrompt, /read-only automatic permission reviewer/);
  assert.match(systemPrompt, /# Security Policy/);

  const userMessage = context.messages.find(message => message.role === "user");
  if (userMessage?.role !== "user") assert.fail("the review user prompt was not sent");
  const userPrompt = contentText(userMessage.content);
  assert.match(userPrompt, /printf hello/);
  assert.match(userPrompt, /\/tmp\/project/);
  assert.match(userPrompt, /Main/);
  assert.match(userPrompt, /The static policy left this ask open\./);
});

test("a valid denial remains a denial", {
  skip: integrationSkip,
}, async () => {
  const { registry } = await fauxRegistry(() => fauxAssistantMessage(JSON.stringify({
    risk_level: "high",
    user_authorization: "low",
    outcome: "deny",
    rationale: "The command deletes data outside the requested scope.",
  })));

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "deny");
  if (result.decision !== "deny") return;
  assert.equal(result.assessment.riskLevel, "high");
  assert.match(result.reason, /Automatic review denied execution/);
});

test("an unparseable assessment defers instead of allowing", {
  skip: integrationSkip,
}, async () => {
  const { registry } = await fauxRegistry(() => fauxAssistantMessage("not a review verdict"));

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "invalid-response");
  assert.match(result.reason, /missing or unparseable assessment/);
});

test("a provider failure defers instead of allowing", {
  skip: integrationSkip,
}, async () => {
  const { registry } = await fauxRegistry(() => fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "fixture provider failure",
  }));

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "provider-error");
});

test("an unresolved dedicated model never falls back to another model", {
  skip: integrationSkip,
}, async () => {
  const registry = new ModelRegistry(await emptyRuntime());
  const reviewer = createShellReviewer({
    modelRegistry: registry,
    provider: "missing-provider",
    timeoutMs: 5_000,
  });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "model-unresolved");
  assert.match(result.reason, /missing-provider\/codex-auto-review/);
});

test("a request timeout defers without allowing", {
  skip: integrationSkip,
}, async () => {
  const { registry } = await fauxRegistry((_context, options) => new Promise(resolve => {
    options?.signal?.addEventListener("abort", () => {
      resolve(fauxAssistantMessage(JSON.stringify({ outcome: "allow", rationale: "late response" })));
    }, { once: true });
  }));

  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 20 });
  const result = await reviewer.review(input());

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "timeout");
  assert.match(result.reason, /timed out/);
});

test("caller cancellation aborts an in-flight request", {
  skip: integrationSkip,
}, async () => {
  const { registry } = await fauxRegistry((_context, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fauxAssistantMessage(JSON.stringify({
      outcome: "allow",
      rationale: "late response",
    }))), 5_000);
    options?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("request aborted"));
    }, { once: true });
  }));

  const controller = new AbortController();
  const reviewer = createShellReviewer({ modelRegistry: registry, timeoutMs: 5_000 });
  const pending = reviewer.review(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  const result = await pending;

  assert.equal(result.decision, "defer");
  if (result.decision !== "defer") return;
  assert.equal(result.failure, "cancelled");
});
