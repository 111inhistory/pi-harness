import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_DISCOVERY_BUDGET,
  createCapabilityDiscovery,
  providerErrorDetail,
} from "../src/capability-agent.mjs";
import { CAPABILITY_SEARCH_TOOL_NAME, SUBMIT_RESULT_TOOL_NAME } from "../src/capability-broker.mjs";

const TOOL_HIT = {
  ref: "tool://read",
  name: "read",
  description: "Read a file from the workspace.",
  kind: "tool",
  status: "available",
  match: "name",
  score: 5,
  source: "builtin",
};
const MCP_HIT = {
  ref: "mcp://firefox-devtools/list_pages",
  name: "mcp__firefox-devtools__list_pages",
  description: "List the pages the connected Firefox instance has open.",
  kind: "mcp",
  status: "available",
  match: "token",
  score: 4,
  server: "firefox-devtools",
  tool: "list_pages",
};
const SKILL_HIT = {
  ref: "skill://firefox-existing-profile",
  name: "firefox-existing-profile",
  description: "Take over an existing Firefox profile with logins and extensions.",
  kind: "skill",
  status: "available",
  match: "ref",
  score: 3,
  filePath: "/skills/firefox-existing-profile/SKILL.md",
};
const REMOTE_HIT = {
  ref: "npm:@example/pi-tools@1.2.3",
  name: "@example/pi-tools",
  description: "Navigation helpers for Pi.",
  kind: "package",
  status: "needs_approval",
  match: "name",
  score: 2,
  source: "npm",
  version: "1.2.3",
};

function groupedResult(hits = []) {
  const groups = { tools: [], mcp: [], skills: [], remote: [] };
  for (const hit of hits) {
    groups[hit.kind === "tool" ? "tools" : hit.kind === "mcp" ? "mcp" : hit.kind === "skill" ? "skills" : "remote"].push(hit);
  }
  return { status: "ok", ...groups, missingCapabilities: [], warnings: [] };
}

function createFakeBroker({ results = {}, failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    async search({ query, src }) {
      calls.push({ query, src });
      if (failures[query]) throw new Error(failures[query]);
      return structuredClone(results[query] ?? groupedResult());
    },
  };
}

/**
 * Drive one discovery run against a fake broker and a scripted internal
 * session. `behavior` runs inside the session prompt and receives the tool
 * handles the engine registered; whatever it returns becomes the run's
 * assistant messages (the adapter's post-prompt report).
 */
async function runDiscovery({ broker, behavior, signal, openBehavior } = {}) {
  const state = { requests: [], prompts: [], aborts: 0, disposals: 0, disposedBeforeReturn: false };
  const openSession = async (request) => {
    state.requests.push(request);
    if (openBehavior) await openBehavior({ state, request });
    return {
      async prompt(text) {
        state.prompts.push(text);
        if (behavior) return await behavior({ state, request, text });
        return [];
      },
      abort() {
        state.aborts += 1;
      },
      async dispose() {
        // The shared Subagent execution dispose awaits its cleanups before it
        // resolves; discovery must await it before returning a result.
        await new Promise((resolve) => setTimeout(resolve, 1));
        state.disposals += 1;
      },
    };
  };
  const discovery = createCapabilityDiscovery({ broker, openSession });
  const result = await discovery.discover({ cwd: "/work", signal });
  return { result, state };
}

function toolOf(state, name) {
  return state.requests[0].customTools.find((tool) => tool.name === name);
}

test("discovery supplies guidance-aware instructions and returns selected skill and tool refs together", async () => {
  const broker = createFakeBroker({ results: { firefox: groupedResult([TOOL_HIT, SKILL_HIT, REMOTE_HIT]) } });
  const { result, state } = await runDiscovery({
    broker,
    async behavior({ request, text }) {
      assert.match(request.instructions, /rules, preferences, fixed background/);
      assert.match(request.instructions, /Generic tool descriptions do not replace/);
      assert.match(request.instructions, /Search local resources\. Remote package search is disabled/);
      assert.match(text, /guidance and tool refs together/);
      assert.match(text, /Remote search is disabled in this run/);
      const search = request.customTools.find((tool) => tool.name === CAPABILITY_SEARCH_TOOL_NAME);
      const submit = request.customTools.find((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME);
      assert.match(search.description, /reusable guidance and missing operations/);
      assert.match(submit.description, /guidance and tool refs together/);
      await search.execute("search", { query: "firefox", src: "local" });
      await submit.execute("submit", { refs: [SKILL_HIT.ref, TOOL_HIT.ref] });
      return [];
    },
  });
  assert.deepEqual(result.skills, [SKILL_HIT]);
  assert.deepEqual(result.tools, [TOOL_HIT]);
  assert.deepEqual(result.remote, [], "unselected candidates are not returned");
  assert.deepEqual(result.coverage, { local: "searched", remote: "not_searched" });
  assert.equal(state.prompts.length, 1);
  assert.equal(state.disposals, 1);
});

test("a namespace is submitted by its group ref and retains all member metadata", async () => {
  const namespace = {
    ref: "namespace://subagent", kind: "namespace", name: "subagent", namespace: "subagent",
    status: "available", instructions: "Collect results with subagent_list.", toolCount: 2,
    tools: [{ ref: "tool://subagent_create", name: "subagent_create" }, { ref: "tool://subagent_list", name: "subagent_list" }],
  };
  const broker = createFakeBroker({ results: { agents: { ...groupedResult(), tools: [namespace] } } });
  const { result } = await runDiscovery({
    broker,
    async behavior({ request }) {
      const search = request.customTools.find((tool) => tool.name === CAPABILITY_SEARCH_TOOL_NAME);
      const submit = request.customTools.find((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME);
      await search.execute("search", { query: "agents", src: "local" });
      const member = await submit.execute("member", { refs: [namespace.tools[0].ref] });
      assert.equal(member.isError, true, "members are not independent candidates");
      assert.match(member.content[0].text, /Unknown ref/);
      await submit.execute("group", { refs: [namespace.ref] });
      return [];
    },
  });
  assert.deepEqual(result.tools, [namespace]);
});

test("invented refs are rejected and accepted refs return their real metadata", async () => {
  const broker = createFakeBroker({ results: { firefox: groupedResult([TOOL_HIT, MCP_HIT, SKILL_HIT, REMOTE_HIT]) } });
  const { result, state } = await runDiscovery({
    broker,
    behavior: async ({ state, request }) => {
      const search = toolOf(state, CAPABILITY_SEARCH_TOOL_NAME);
      const found = await search.execute("call-1", { query: "firefox", src: "local" });
      assert.equal(found.isError, undefined);

      const submit = toolOf(state, SUBMIT_RESULT_TOOL_NAME);
      const rejected = await submit.execute("call-2", { refs: ["skill://made-up", TOOL_HIT.ref] });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /skill:\/\/made-up/);

      const remoteRejected = await submit.execute("call-2b", { refs: [TOOL_HIT.ref, REMOTE_HIT.ref] });
      assert.equal(remoteRejected.isError, true, "remote candidates are not selectable while approval is unsupported");
      assert.match(remoteRejected.content[0].text, /npm:@example\/pi-tools@1\.2\.3/);

      const accepted = await submit.execute("call-3", {
        refs: [SKILL_HIT.ref, ` ${TOOL_HIT.ref} `, TOOL_HIT.ref],
      });
      assert.equal(accepted.isError, undefined);
      assert.equal(accepted.terminate, true);

      // A batched call that lands after the accepted submission must not run,
      // and no further provider request may be dispatched.
      const closed = await search.execute("call-4", { query: "firefox", src: "local" });
      assert.equal(closed.isError, true);
      assert.equal(request.beforeRequest()?.stop, true);

      // A provider failure reported after a settled submission must not
      // replace the accepted result.
      return [{ role: "assistant", stopReason: "error", errorMessage: "late failure" }];
    },
  });
  assert.equal(broker.calls.length, 1, "no search may run after an accepted submission");
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.tools.map((hit) => hit.ref),
    [TOOL_HIT.ref],
  );
  assert.deepEqual(
    result.skills.map((hit) => hit.ref),
    [SKILL_HIT.ref],
  );
  assert.deepEqual(result.remote, [], "remote candidates never enter the selected result");
  assert.deepEqual(result.coverage, { local: "searched", remote: "not_searched" });
  assert.deepEqual(result.mcp, []);
  assert.equal(result.tools[0].source, "builtin");
  assert.equal(result.skills[0].description, SKILL_HIT.description);
  assert.equal(state.prompts.length, 1, "one run is exactly one prompt; no planning call follows the submission");
  assert.equal(state.disposals, 1, "the run awaits the shared execution dispose before returning");
});

test("empty refs are only a no-match after a completed search", async () => {
  const broker = createFakeBroker({ results: { nothing: groupedResult() } });
  const { result, state } = await runDiscovery({
    broker,
    behavior: async ({ state }) => {
      const submit = toolOf(state, SUBMIT_RESULT_TOOL_NAME);
      const early = await submit.execute("call-1", { refs: [] });
      assert.equal(early.isError, true);

      await toolOf(state, CAPABILITY_SEARCH_TOOL_NAME).execute("call-2", { query: "nothing", src: "local" });
      const accepted = await submit.execute("call-3", { refs: [] });
      assert.equal(accepted.isError, undefined);
      assert.equal(accepted.terminate, true);
    },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.missingCapabilities, ["nothing"]);
  assert.deepEqual([result.tools, result.mcp, result.skills, result.remote], [[], [], [], []]);
  assert.deepEqual(result.coverage, { local: "searched", remote: "not_searched" });
});

test("a failed search is explicit and cannot become a silent no-match", async () => {
  const broker = createFakeBroker({ failures: { firefox: "registry request timed out" } });
  const { result, state } = await runDiscovery({
    broker,
    behavior: async ({ state }) => {
      const failed = await toolOf(state, CAPABILITY_SEARCH_TOOL_NAME).execute("call-1", { query: "firefox", src: "local" });
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /registry request timed out/);

      const empty = await toolOf(state, SUBMIT_RESULT_TOOL_NAME).execute("call-2", { refs: [] });
      assert.equal(empty.isError, true);
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.warnings.some((warning) => /registry request timed out/.test(warning)));
  assert.deepEqual(result.missingCapabilities, []);
});

test("degraded local searches downgrade a no-match submission to partial", async () => {
  const broker = createFakeBroker({
    results: { localThing: groupedResult() },
    failures: { brokenThing: "skill index offline" },
  });
  const { result, state } = await runDiscovery({
    broker,
    behavior: async ({ state }) => {
      const search = toolOf(state, CAPABILITY_SEARCH_TOOL_NAME);
      await search.execute("call-1", { query: "brokenThing", src: "local" });
      await search.execute("call-2", { query: "localThing", src: "local" });
      await toolOf(state, SUBMIT_RESULT_TOOL_NAME).execute("call-3", { refs: [] });
    },
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.missingCapabilities, ["localThing"]);
  assert.ok(result.warnings.some((warning) => /skill index offline/.test(warning)));
  assert.deepEqual(result.coverage, { local: "searched", remote: "not_searched" });
});

test("remote search is disabled, never reaches the broker, and is reported as not searched", async () => {
  const broker = createFakeBroker({ results: { firefox: groupedResult([TOOL_HIT]) } });
  const { result, state } = await runDiscovery({
    broker,
    async behavior({ state, request }) {
      assert.match(request.instructions, /Remote package search is disabled/);
      const search = toolOf(state, CAPABILITY_SEARCH_TOOL_NAME);
      const remote = await search.execute("call-1", { query: "firefox", src: "remote" });
      assert.equal(remote.isError, true);
      assert.match(remote.content[0].text, /disabled until a user approval receiver exists/);
      assert.match(remote.content[0].text, /not evidence that no remote resource exists/);
      const all = await search.execute("call-2", { query: "firefox", src: "all" });
      assert.equal(all.isError, true);
      await search.execute("call-3", { query: "firefox", src: "local" });
      await toolOf(state, SUBMIT_RESULT_TOOL_NAME).execute("call-4", { refs: [TOOL_HIT.ref] });
    },
  });
  assert.deepEqual(broker.calls, [{ query: "firefox", src: "local" }], "no remote or combined search reaches the broker");
  assert.deepEqual(result.remote, []);
  assert.deepEqual(result.coverage, { local: "searched", remote: "not_searched" });
  assert.deepEqual(result.tools.map((hit) => hit.ref), [TOOL_HIT.ref]);
});

test("a failed or unstarted run reports that local was not searched", async () => {
  const broker = createFakeBroker({ failures: { firefox: "registry request timed out" } });
  const { result } = await runDiscovery({
    broker,
    behavior: async ({ state }) => {
      await toolOf(state, CAPABILITY_SEARCH_TOOL_NAME).execute("call-1", { query: "firefox", src: "local" });
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.coverage, { local: "not_searched", remote: "not_searched" });
});

test("a model failure is explicit and the internal session is disposed", async () => {
  const { result, state } = await runDiscovery({
    broker: createFakeBroker(),
    behavior: async () => {
      throw new Error("provider stream failed");
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.warnings.some((warning) => /provider stream failed/.test(warning)));
  assert.equal(state.disposals, 1);
});

test("a provider error inside a resolved prompt is reported with its detail", async () => {
  const { result, state } = await runDiscovery({
    broker: createFakeBroker(),
    behavior: async () => [
      { role: "assistant", stopReason: "toolUse", content: [] },
      { role: "toolResult", toolCallId: "call-1", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: "Overloaded (529)" },
    ],
  });
  assert.equal(result.status, "failed");
  assert.ok(
    result.warnings.some((warning) => warning.includes("Overloaded (529)")),
    "the provider's own error detail must surface",
  );
  assert.equal(state.disposals, 1);
});

test("providerErrorDetail classifies only this run's failed attempt", () => {
  assert.equal(providerErrorDetail([{ role: "assistant", stopReason: "stop" }]), null);
  assert.equal(providerErrorDetail([]), null);
  assert.equal(providerErrorDetail(null), null);
  assert.equal(
    providerErrorDetail([{ role: "assistant", stopReason: "error", errorMessage: "boom" }]),
    "boom",
  );
  assert.equal(
    providerErrorDetail([{ role: "assistant", stopReason: "error" }]),
    "the provider reported an error",
  );
  // The last assistant message decides, whatever trails it.
  assert.equal(
    providerErrorDetail([
      { role: "assistant", stopReason: "error", errorMessage: "first" },
      { role: "assistant", stopReason: "stop" },
      { role: "toolResult", toolCallId: "call-1" },
    ]),
    null,
  );
});

test("caller cancellation aborts and disposes instead of returning a no-match", async () => {
  const controller = new AbortController();
  const broker = createFakeBroker();
  const { result, state } = await runDiscovery({
    broker,
    signal: controller.signal,
    behavior: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual([result.tools, result.mcp, result.skills, result.remote], [[], [], [], []]);
  assert.ok(result.warnings.length > 0, "a cancelled run is never silent");
  assert.equal(broker.calls.length, 0);
  assert.equal(state.aborts, 1);
  assert.equal(state.disposals, 1);
});

test("an abort while the session is opening never prompts", async () => {
  const controller = new AbortController();
  const broker = createFakeBroker();
  const { result, state } = await runDiscovery({
    broker,
    signal: controller.signal,
    openBehavior: async () => {
      controller.abort();
    },
    behavior: async () => {
      throw new Error("the internal session must not be prompted after an abort");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(state.requests.length, 1, "the check runs once the session has opened");
  assert.equal(state.requests[0].signal, controller.signal, "the caller signal is forwarded to the shared execution");
  assert.deepEqual(state.prompts, [], "no prompt is dispatched");
  assert.equal(state.aborts, 1, "the opened session is aborted");
  assert.equal(state.disposals, 1);
  assert.equal(broker.calls.length, 0);
});

test("an aborted signal before the session starts never opens it", async () => {
  const controller = new AbortController();
  controller.abort();
  const broker = createFakeBroker();
  const { result, state } = await runDiscovery({ broker, signal: controller.signal });
  assert.equal(result.status, "failed");
  assert.deepEqual(state.requests, [], "no session is opened");
  assert.deepEqual(state.prompts, []);
  assert.equal(state.disposals, 0, "there is nothing to dispose");
  assert.equal(broker.calls.length, 0);
});

test("a run that never submits is reported as a failure, not a no-match", async () => {
  const { result } = await runDiscovery({
    broker: createFakeBroker({ results: { firefox: groupedResult([TOOL_HIT]) } }),
    behavior: async ({ state }) => {
      await toolOf(state, CAPABILITY_SEARCH_TOOL_NAME).execute("call-1", { query: "firefox", src: "local" });
      return [{ role: "assistant", stopReason: "stop", content: [] }];
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.missingCapabilities, [], "only an accepted submission can report nothing missing");
  assert.ok(result.warnings.length > 0);
});

test("an exhausted internal budget is reported as an explicit failure", async () => {
  const { result, state } = await runDiscovery({
    broker: createFakeBroker(),
    behavior: async ({ request }) => {
      // The engine hands the host the run's fixed internal budget; the shared
      // Pi hook (tested in pi-job-budget.test.mjs) charges each model call.
      assert.deepEqual(request.budget.profile, CAPABILITY_DISCOVERY_BUDGET);
      for (let call = 1; call <= 8; call += 1) request.budget.beginModelCall();
      assert.equal(request.budget.beginModelCall().ok, false);
      assert.equal(request.budget.check().terminal.status, "failed");
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual([result.tools, result.mcp, result.skills, result.remote], [[], [], [], []]);
  assert.equal(state.disposals, 1);
});

test("an openSession failure is explicit", async () => {
  const discovery = createCapabilityDiscovery({
    broker: createFakeBroker(),
    openSession: async () => {
      throw new Error("resource loader failed");
    },
  });
  const result = await discovery.discover({ cwd: "/work" });
  assert.equal(result.status, "failed");
  assert.ok(result.warnings.some((warning) => /resource loader failed/.test(warning)));
});
