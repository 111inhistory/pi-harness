import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SubagentRoutingError, routeSubagent, loadSubagentRoutingConfig } from "../src/subagent-routing.mjs";

const CLASSIFIER = { type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" };
const GEMINI = { type: "chat", provider: "openrouter", id: "~google/gemini-pro-latest" };
const DEEPSEEK = { type: "chat", provider: "openrouter", id: "~deepseek/deepseek-pro-latest" };

const CONFIG = {
  version: 2,
  classifier: { provider: "openrouter", id: "~typesafe/jev-latest" },
  instructions: {
    role: "Select the role for delegated_assignment.",
    model: "Select the model for delegated_assignment under selected_role.",
  },
  roles: [
    { id: "researcher", instructions: "RESEARCH INSTRUCTIONS", excludeTools: ["edit", "write", "grep", "find", "ls"], enableTools: ["msg_write"] },
    { id: "executor", instructions: "EXECUTOR INSTRUCTIONS", excludeTools: ["grep", "find", "ls"], enableTools: [] },
    { id: "reviewer", instructions: "REVIEWER INSTRUCTIONS", excludeTools: ["bash", "edit", "write", "grep", "find", "ls"], enableTools: ["msg_write"] },
  ].map((role) => ({
    ...role,
    candidates: [
      { model: "gemini", thinking: role.id === "executor" ? "medium" : (role.id === "researcher" ? "medium" : "high") },
      { model: "deepseek", thinking: role.id === "executor" ? "high" : (role.id === "researcher" ? "medium" : "high") },
    ],
  })),
  models: [
    { id: "gemini", provider: "openrouter", model: "~google/gemini-pro-latest", preference: "GEMINI PREFERENCE" },
    { id: "deepseek", provider: "openrouter", model: "~deepseek/deepseek-pro-latest", preference: "DEEPSEEK PREFERENCE" },
  ],
};

function choice(selected, probabilities) {
  return { type: "choice", choice: selected, probabilities, confidence: 0.9 };
}

function stopped(answers) {
  return { api: "typesafe-system-one", provider: "openrouter", model: "~typesafe/jev-latest", answers, stopReason: "stop", timestamp: 0 };
}

function failed(message) {
  return { api: "typesafe-system-one", provider: "openrouter", model: "~typesafe/jev-latest", answers: {}, stopReason: "error", errorMessage: message, timestamp: 0 };
}

function createRegistry({ classifier = CLASSIFIER, models = new Map([["~google/gemini-pro-latest", GEMINI], ["~deepseek/deepseek-pro-latest", DEEPSEEK]]), responses = [] } = {}) {
  const calls = [];
  return {
    calls,
    findOfType(type, provider, id) {
      if (type !== "classifier") return undefined;
      if (!classifier || classifier.provider !== provider || classifier.id !== id) return undefined;
      return classifier;
    },
    find(provider, id) {
      return models.get(id);
    },
    async classify(model, context, options) {
      calls.push({ model, context, options });
      const response = responses[calls.length - 1];
      return typeof response === "function" ? response({ model, context, options, index: calls.length }) : response;
    },
  };
}

function createBudget(refusals = []) {
  const debits = [];
  return {
    debits,
    beginModelCall() {
      const sequence = debits.length + 1;
      debits.push(sequence);
      return refusals[sequence - 1] ?? { ok: true, sequence };
    },
  };
}

function routingError(code) {
  return (error) => error instanceof SubagentRoutingError && error.code === code;
}

test("routes with exactly two classifier calls over the full assignment", async () => {
  const registry = createRegistry({
    responses: [
      stopped({ role: choice("executor", { researcher: 0.02, executor: 0.95, reviewer: 0.03 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
    ],
  });
  const budget = createBudget();
  const result = await routeSubagent({ registry, budget, task: "TASK", context: "CONTEXT", config: CONFIG });

  assert.equal(registry.calls.length, 2);
  assert.deepEqual(budget.debits, [1, 2]);

  const [first, second] = registry.calls;
  assert.equal(first.model, CLASSIFIER);
  assert.deepEqual(first.context.state, { delegated_assignment: "# Batch context\n\nCONTEXT\n\n# Task\n\nTASK" });
  assert.equal(first.context.questions.role.instructions, CONFIG.instructions.role);
  assert.deepEqual(first.context.questions.role.criteria, {
    researcher: "RESEARCH INSTRUCTIONS",
    executor: "EXECUTOR INSTRUCTIONS",
    reviewer: "REVIEWER INSTRUCTIONS",
  });

  // Stage 2 reads the actual selected role text, not the label, and the same assignment.
  assert.deepEqual(second.context.state, {
    delegated_assignment: "# Batch context\n\nCONTEXT\n\n# Task\n\nTASK",
    selected_role: { id: "executor", instructions: "EXECUTOR INSTRUCTIONS" },
  });
  assert.equal(second.context.questions.model.instructions, CONFIG.instructions.model);
  assert.deepEqual(second.context.questions.model.criteria, {
    gemini: "GEMINI PREFERENCE",
    deepseek: "DEEPSEEK PREFERENCE",
  });

  assert.equal(result.roleId, "executor");
  assert.equal(result.instructions, "EXECUTOR INSTRUCTIONS");
  assert.equal(result.model, DEEPSEEK);
  assert.equal(result.thinkingLevel, "high");
  assert.deepEqual(result.excludeTools, ["grep", "find", "ls"]);
  assert.deepEqual(result.enableTools, []);
  assert.equal("tools" in result, false);
});

test("keeps batch context bytes; a blank context falls back to the task alone", async () => {
  const registry = createRegistry({
    responses: [
      stopped({ role: choice("researcher", { researcher: 0.8, executor: 0.1, reviewer: 0.1 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
      stopped({ role: choice("researcher", { researcher: 0.8, executor: 0.1, reviewer: 0.1 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
    ],
  });
  await routeSubagent({ registry, budget: createBudget(), task: "TASK", context: "  padded  ", config: CONFIG });
  assert.equal(registry.calls[0].context.state.delegated_assignment, "# Batch context\n\n  padded  \n\n# Task\n\nTASK");

  await routeSubagent({ registry, budget: createBudget(), task: "TASK", context: "  \n ", config: CONFIG });
  assert.equal(registry.calls[2].context.state.delegated_assignment, "TASK");
});

test("selects the probability argmax and keeps ties in the configured criteria order", async () => {
  const registry = createRegistry({
    responses: [
      stopped({ role: choice("reviewer", { researcher: 0.1, executor: 0.2, reviewer: 0.7 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.3, deepseek: 0.7 }) }),
      stopped({ role: choice("researcher", { researcher: 0.4, executor: 0.4, reviewer: 0.4 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.4, deepseek: 0.6 }) }),
    ],
  });
  const first = await routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG });
  assert.equal(first.roleId, "reviewer");
  assert.equal(registry.calls[1].context.state.selected_role.instructions, "REVIEWER INSTRUCTIONS");

  const second = await routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG });
  assert.equal(second.roleId, "researcher");
  assert.equal(registry.calls[3].context.state.selected_role.id, "researcher");
});

test("uses the selected candidate's direct thinking level", async () => {
  const registry = createRegistry({
    responses: [
      stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
      stopped({ model: choice("gemini", { gemini: 0.9, deepseek: 0.1 }) }),
    ],
  });
  const result = await routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG });
  assert.equal(result.model, GEMINI);
  assert.equal(result.thinkingLevel, "medium", "the selected candidate's direct level is authoritative");
});

test("the chosen candidate's direct level decides thinking for a multi-model pool", async () => {
  const config = structuredClone(CONFIG);
  config.roles.find((role) => role.id === "executor").candidates = [
    { model: "gemini", thinking: "low" },
    { model: "deepseek", thinking: "high" },
  ];
  const registry = createRegistry({ responses: [
    stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
    stopped({ model: choice("deepseek", { gemini: 0.2, deepseek: 0.8 }) }),
  ] });
  const result = await routeSubagent({ registry, budget: createBudget(), task: "TASK", config });
  assert.equal(result.model, DEEPSEEK);
  assert.equal(result.thinkingLevel, "high", "selecting deepseek also selects its direct candidate thinking");
  assert.equal(registry.calls[1].context.questions.model.criteria.deepseek, "DEEPSEEK PREFERENCE");
});

test("an explicitly unsupported model thinking level fails instead of being silently rewritten", async () => {
  const restricted = { ...DEEPSEEK, thinkingLevelMap: { high: null } };
  const registry = createRegistry({
    models: new Map([["~google/gemini-pro-latest", GEMINI], ["~deepseek/deepseek-pro-latest", restricted]]),
    responses: [
      stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
    ],
  });
  await assert.rejects(
    routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_thinking_unsupported"),
  );
});

test("an aborted signal stops before any provider dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  const registry = createRegistry();
  const budget = createBudget();

  await assert.rejects(
    routeSubagent({ registry, budget, task: "TASK", signal: controller.signal, config: CONFIG }),
    routingError("routing_aborted"),
  );
  assert.equal(registry.calls.length, 0);
  assert.deepEqual(budget.debits, []);
});

test("an abort inside the first classification suppresses the second call", async () => {
  const controller = new AbortController();
  const registry = createRegistry({
    responses: [
      ({ options }) => {
        assert.equal(options.signal, controller.signal);
        controller.abort();
        return stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) });
      },
    ],
  });
  const budget = createBudget();

  await assert.rejects(
    routeSubagent({ registry, budget, task: "TASK", signal: controller.signal, config: CONFIG }),
    routingError("routing_aborted"),
  );
  assert.equal(registry.calls.length, 1);
  assert.deepEqual(budget.debits, [1]);
});

test("a native aborted result is reported as an abort, not as a selection", async () => {
  const registry = createRegistry({ responses: [{ api: "typesafe-system-one", answers: {}, stopReason: "aborted", timestamp: 0 }] });
  await assert.rejects(
    routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_aborted"),
  );
  assert.equal(registry.calls.length, 1);
});

test("a refused budget debit stops the route before the second call is dispatched", async () => {
  const refusal = {
    ok: false,
    reason: "budget_exceeded",
    terminal: { status: "failed", termination: "budget_exhausted", truncated: true, error: { code: "budget_exceeded", detail: {} } },
    error: { code: "budget_exceeded", detail: {} },
  };
  const registry = createRegistry({
    responses: [stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) })],
  });
  const budget = createBudget([null, refusal]);

  await assert.rejects(
    routeSubagent({ registry, budget, task: "TASK", config: CONFIG }),
    routingError("budget_exceeded"),
  );
  assert.deepEqual(budget.debits, [1, 2]);
  assert.equal(registry.calls.length, 1);
});

test("classifier errors surface explicitly and can never become a selection", async () => {
  const registry = createRegistry({ responses: [failed("401 Unauthorized: provider has no credentials")] });
  await assert.rejects(
    routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG }),
    (error) =>
      error instanceof SubagentRoutingError &&
      error.code === "routing_classification_failed" &&
      error.detail.nativeError === "401 Unauthorized: provider has no credentials" &&
      error.detail.stage === 1,
  );
  assert.equal(registry.calls.length, 1);

  const thrown = createRegistry({
    responses: [
      () => {
        throw new Error("socket closed");
      },
    ],
  });
  await assert.rejects(
    routeSubagent({ registry: thrown, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_classification_failed"),
  );
});

test("a missing classifier fails before any call is attempted", async () => {
  const registry = createRegistry({ classifier: null });
  await assert.rejects(
    routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_classifier_unavailable"),
  );
  assert.equal(registry.calls.length, 0);
});

test("answers outside the configured criteria or without a full distribution are rejected", async () => {
  const unknownLabel = createRegistry({ responses: [stopped({ role: choice("root", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) })] });
  await assert.rejects(
    routeSubagent({ registry: unknownLabel, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_invalid_answer"),
  );
  assert.equal(unknownLabel.calls.length, 1);

  const partial = createRegistry({ responses: [stopped({ role: { type: "choice", choice: "executor", probabilities: { executor: 1 } } })] });
  await assert.rejects(
    routeSubagent({ registry: partial, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_invalid_answer"),
  );
});

test("a selected candidate missing from the catalog or not a chat model fails instead of executing", async () => {
  const registry = createRegistry({
    models: new Map([["~google/gemini-pro-latest", GEMINI]]),
    responses: [
      stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
    ],
  });
  await assert.rejects(
    routeSubagent({ registry, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_model_unavailable"),
  );

  const wrongType = createRegistry({
    models: new Map([["~google/gemini-pro-latest", GEMINI], ["~deepseek/deepseek-pro-latest", CLASSIFIER]]),
    responses: [
      stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
      stopped({ model: choice("deepseek", { gemini: 0.1, deepseek: 0.9 }) }),
    ],
  });
  await assert.rejects(
    routeSubagent({ registry: wrongType, budget: createBudget(), task: "TASK", config: CONFIG }),
    routingError("routing_model_invalid"),
  );
});

test("a malformed config fails before any classifier call", async () => {
  const registry = createRegistry();
  const budget = createBudget();

  const badThinking = structuredClone(CONFIG);
  badThinking.roles[0].candidates[0].thinking = "max";
  await assert.rejects(
    routeSubagent({ registry, budget, task: "TASK", config: badThinking }),
    routingError("routing_invalid_config"),
  );

  const noCandidates = { ...CONFIG, models: [] };
  await assert.rejects(
    routeSubagent({ registry, budget, task: "TASK", config: noCandidates }),
    routingError("routing_invalid_config"),
  );

  for (const patch of [{ tools: ["read"] }, { excludeTools: undefined }, { enableTools: "msg_write" }, { enableTools: ["*"] }]) {
    const config = structuredClone(CONFIG);
    Object.assign(config.roles[0], patch);
    await assert.rejects(routeSubagent({ registry, budget, task: "TASK", config }), routingError("routing_invalid_config"));
  }
  assert.equal(registry.calls.length, 0);
  assert.deepEqual(budget.debits, []);
});

test("the shipped template loads from an explicit config path and drives both calls", async () => {
  const config = JSON.parse(readFileSync(new URL("../config/subagent-routing.json", import.meta.url), "utf8"));
  const [role] = config.roles;
  const [candidate] = config.models;
  const classifier = { type: "classifier", provider: config.classifier.provider, id: config.classifier.id };
  const model = { type: "chat", provider: candidate.provider, id: candidate.model };
  const votes = (ids, winner) => Object.fromEntries(ids.map((id) => [id, id === winner ? 0.9 : 0.1 / (ids.length - 1)]));
  const registry = createRegistry({
    classifier,
    models: new Map([[candidate.model, model]]),
    responses: [
      stopped({ role: choice(role.id, votes(config.roles.map((entry) => entry.id), role.id)) }),
      stopped({ model: choice(candidate.id, votes(role.candidates.map((entry) => entry.model), candidate.id)) }),
    ],
  });

  const result = await routeSubagent({ registry, budget: createBudget(), task: "TASK", configPath: fileURLToPath(new URL("../config/subagent-routing.json", import.meta.url)) });
  assert.equal(registry.calls.length, 2);
  assert.equal(registry.calls[0].model, classifier);
  assert.equal(result.roleId, role.id);
  assert.equal(result.instructions, role.instructions);
  assert.equal(result.model, model);
});

test("Pi user routing config is re-read and never falls back to the bundled template", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-user-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "subagent-routing.json");
  const registry = createRegistry();
  const budget = createBudget();
  await assert.rejects(routeSubagent({ registry, budget, task: "TASK", configPath }), (error) => error.code === "routing_invalid_config" && error.message.includes(configPath));
  assert.equal(registry.calls.length, 0);
  assert.deepEqual(budget.debits, []);
  writeFileSync(configPath, JSON.stringify(CONFIG));
  assert.deepEqual(loadSubagentRoutingConfig(configPath), CONFIG);
  const changed = structuredClone(CONFIG);
  changed.models[1].provider = "deepseek";
  changed.models[1].model = "deepseek-flash";
  writeFileSync(configPath, JSON.stringify(changed));
  assert.deepEqual(loadSubagentRoutingConfig(configPath), changed, "config changes need no module reload");
  writeFileSync(configPath, "{");
  assert.throws(() => loadSubagentRoutingConfig(configPath), (error) => error.code === "routing_invalid_config");
});

test("reviewer has only Sol; its direct high thinking skips model classification", async () => {
  const config = loadSubagentRoutingConfig(fileURLToPath(new URL("../config/subagent-routing.json", import.meta.url)));
  const sol = { type: "chat", provider: "openai-codex", id: "gpt-6.1-sol" };
  const registry = createRegistry({ models: new Map([[sol.id, sol]]), responses: [stopped({ role: choice("reviewer", { researcher: 0.1, executor: 0.1, reviewer: 0.8 }) })] });
  const budget = createBudget();
  const result = await routeSubagent({ registry, budget, task: "Independently review", config });
  assert.equal(result.model, sol);
  assert.equal(result.thinkingLevel, "high");
  assert.equal(registry.calls.length, 1);
  assert.deepEqual(budget.debits, [1]);
});

test("role pools share global Preferences and constrain model classification", async () => {
  const config = structuredClone(CONFIG);
  config.models.push({ id: "sol", provider: "openai-codex", model: "gpt-6.1-sol", preference: "GENERAL SOL PREFERENCE" });
  config.roles.find((role) => role.id === "executor").candidates = [
    { model: "gemini", thinking: "low" },
    { model: "sol", thinking: "high" },
  ];
  const registry = createRegistry({ responses: [
    stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
    stopped({ model: choice("gemini", { gemini: 0.9, sol: 0.1 }) }),
  ] });
  const result = await routeSubagent({ registry, budget: createBudget(), task: "TASK", config });
  assert.deepEqual(registry.calls[1].context.questions.model.criteria, { gemini: "GEMINI PREFERENCE", sol: "GENERAL SOL PREFERENCE" });
  assert.equal(result.thinkingLevel, "low", "same global model can have a different direct role-local level");
  const outside = createRegistry({ responses: [
    stopped({ role: choice("executor", { researcher: 0.1, executor: 0.8, reviewer: 0.1 }) }),
    stopped({ model: choice("deepseek", { gemini: 0.1, sol: 0.1, deepseek: 0.8 }) }),
  ] });
  await assert.rejects(routeSubagent({ registry: outside, budget: createBudget(), task: "TASK", config }), routingError("routing_invalid_answer"));
});

test("a missing singleton model fails without switching to another role's models", async () => {
  const config = loadSubagentRoutingConfig(fileURLToPath(new URL("../config/subagent-routing.json", import.meta.url)));
  const registry = createRegistry({ responses: [stopped({ role: choice("reviewer", { researcher: 0.1, executor: 0.1, reviewer: 0.8 }) })] });
  await assert.rejects(routeSubagent({ registry, budget: createBudget(), task: "Review", config }), routingError("routing_model_unavailable"));
  assert.equal(registry.calls.length, 1);
});

test("empty, duplicate, unknown and inverted role pool entries fail before classification", async () => {
  for (const pool of [[], [{ model: "missing", thinking: "high" }],
    [{ model: "gemini", thinking: { min: "low", max: "high" } }],
    [{ model: "gemini", thinking: "max" }],
    [{ model: "gemini", thinking: "high" }, { model: "gemini", thinking: "high" }]]) {
    const config = structuredClone(CONFIG);
    config.roles[0].candidates = pool;
    const registry = createRegistry();
    await assert.rejects(routeSubagent({ registry, budget: createBudget(), task: "TASK", config }), routingError("routing_invalid_config"));
    assert.equal(registry.calls.length, 0);
  }
});
