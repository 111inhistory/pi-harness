import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CAPABILITY_LIMITS,
  CAPABILITY_PARAMETERS,
  CAPABILITY_SEARCH_PARAMETERS,
  CAPABILITY_TOOL_NAME,
  SUBMIT_RESULT_PARAMETERS,
  createCapabilityBroker,
} from "../src/capability-broker.mjs";

const BASH = {
  name: "bash",
  description: "Run shell commands in the project workspace.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Shell command to run." } },
    required: ["command"],
  },
  exposure: "direct",
  sourceInfo: { path: "<builtin:bash>", source: "builtin", scope: "temporary", origin: "top-level" },
};

const LIST_PAGES = {
  name: "mcp__firefox_devtools__list_pages",
  description: "List the pages the connected Firefox instance has open.",
  parameters: {
    type: "object",
    properties: { includeClosed: { type: "boolean", description: "Include recently closed pages." } },
  },
  exposure: "direct",
  namespace: { name: "mcp__firefox_devtools", description: "Firefox DevTools MCP server." },
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "user", origin: "top-level" },
};

const RESTART_FIREFOX = {
  name: "mcp__firefox_devtools__restart_firefox",
  description: "Restart the connected Firefox instance with an optional profile path.",
  parameters: {
    type: "object",
    properties: { profilePath: { type: "string", description: "Profile directory to launch." } },
  },
  exposure: "direct",
  namespace: { name: "mcp__firefox_devtools", description: "Firefox DevTools MCP server." },
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "user", origin: "top-level" },
};

// A withdrawn server tool: registered but unreachable, must stay invisible.
const WITHDRAWN = {
  name: "mcp__firefox_devtools__withdrawn_navigate",
  description: "Navigate the connected Firefox page.",
  parameters: { type: "object", properties: {} },
  exposure: "hidden",
  namespace: { name: "mcp__firefox_devtools" },
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "user", origin: "top-level" },
};

const TOOLS = [BASH, LIST_PAGES, RESTART_FIREFOX, WITHDRAWN];
const ACTIVE_TOOLS = [LIST_PAGES.name];

const FIREFOX_SKILL = {
  name: "firefox-existing-profile",
  description: "接管 Firefox 已有 Profile（带登录态与扩展）的操作时序与限制规避。",
  filePath: "/skills/firefox-existing-profile/SKILL.md",
};

const FIREFOX_SKILL_BODY = [
  "# 接管已有 Profile",
  "",
  "## 限制",
  "",
  "- 不得把用户真实 Profile 直接传给 restart_firefox/profilePath；它会在指定路径下创建 firefox_devtools_mcp_profile，且不会迁移 Cookie、登录态和扩展。",
  "",
  "## 流程",
  "",
  "- 应先外部启动目标 Profile，再由 mcp:firefox-devtools 使用 --connect-existing 接管。",
  "- 使用 list_pages 验证连接状态。",
].join("\n");

test("already-active builtin and SDK additional tools are omitted from search, not schema reads", async () => {
  const additional = { ...BASH, name: "sdk_tool", sourceInfo: { source: "sdk" } };
  const broker = createCapabilityBroker(plainProviders({ listTools: () => [BASH, additional], listActiveTools: () => ["bash", "sdk_tool"] }));
  for (const query of ["bash", "tool://bash", "sdk_tool"]) {
    assert.deepEqual((await broker.search({ query, src: "local" })).tools, []);
  }
});

const ENGLISH_QUERY = "list pages in the connected Firefox and run shell commands";
const CHINESE_QUERY = "使用已有登录态和扩展的 Firefox 完成网页操作";

function plainProviders(overrides = {}) {
  return {
    listTools: () => TOOLS,
    listActiveTools: () => ACTIVE_TOOLS,
    discoverSkills: () => ({ skills: [FIREFOX_SKILL], diagnostics: [] }),
    readSkillFile: async () => FIREFOX_SKILL_BODY,
    ...overrides,
  };
}

/**
 * Releases only once every named provider has been entered, so a search that
 * awaits one branch before starting the next deadlocks instead of passing.
 */
function createLabelGate(labels) {
  const entered = [];
  let release;
  const closed = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async pass(label, value) {
      if (!entered.includes(label)) entered.push(label);
      if (labels.every((expected) => entered.includes(expected))) release();
      await closed;
      return value;
    },
  };
}

function deadline(ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
    timer.unref();
  });
  return { expired, clear: () => clearTimeout(timer) };
}

test("runs the local source groups concurrently and returns the host-facing result shape", async () => {
  const gate = createLabelGate(["tools", "active", "skills"]);
  const broker = createCapabilityBroker(
    plainProviders({
      listTools: () => gate.pass("tools", TOOLS),
      listActiveTools: () => gate.pass("active", ACTIVE_TOOLS),
      discoverSkills: () => gate.pass("skills", { skills: [FIREFOX_SKILL], diagnostics: [] }),
      searchRemote: async () => {
        throw new Error("src=local must not touch the marketplace");
      },
    }),
  );
  const timeout = deadline(500);
  try {
    const result = await Promise.race([
      broker.search({ query: ENGLISH_QUERY, src: "local", cwd: "/tmp" }),
      timeout.expired,
    ]);
    assert.notEqual(result, "deadline", "branches must overlap: every provider resolved before all searches started");
    assert.deepEqual([...gate.entered].sort(), ["active", "skills", "tools"]);

    assert.deepEqual(
      Object.keys(result),
      ["status", "tools", "mcp", "skills", "remote", "missingCapabilities", "warnings"],
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.remote, [], "src=local never returns remote candidates");
    assert.ok(result.tools.length > 0, "tool hits expected");
    assert.ok(result.mcp.length > 0, "mcp hits expected");
    assert.ok(result.skills.length > 0, "skill hits expected");
    for (const hits of [result.tools, result.mcp, result.skills]) {
      assert.ok(hits.length <= 8);
      assert.equal(new Set(hits.map((hit) => hit.ref)).size, hits.length, "refs must be unique per group");
      for (const hit of hits) {
        assert.equal(typeof hit.ref, "string");
        assert.equal(typeof hit.name, "string");
        assert.equal(typeof hit.description, "string");
        assert.ok(["tool", "mcp", "skill", "package"].includes(hit.kind));
        assert.equal(hit.status, "available", "local hits are available, only remote hits need approval");
        assert.ok(["ref", "name", "token", "fuzzy"].includes(hit.match));
        assert.equal(typeof hit.score, "number");
      }
    }
    assert.deepEqual(result.warnings, []);
  } finally {
    timeout.clear();
    gate.release();
  }
});

test("isolates a failing local group and still returns the other groups", async () => {
  const broker = createCapabilityBroker(
    plainProviders({
      discoverSkills: async () => {
        throw new Error("skill index offline");
      },
    }),
  );

  const result = await broker.search({ query: ENGLISH_QUERY, src: "local", cwd: "/tmp" });
  assert.equal(result.status, "partial");
  assert.ok(result.tools.length > 0);
  assert.ok(result.mcp.length > 0);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.warnings, ["skills search failed: skill index offline"]);
});

test("reports failed when every local group fails and keeps every class", async () => {
  const broker = createCapabilityBroker({
    listTools: async () => {
      throw new Error("registry unavailable");
    },
    listActiveTools: async () => {
      throw new Error("registry unavailable");
    },
    discoverSkills: async () => {
      throw new Error("skill index offline");
    },
  });

  const result = await broker.search({ query: "firefox", src: "local", cwd: "/tmp" });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.mcp, []);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.remote, []);
  assert.deepEqual(result.warnings, [
    "tools search failed: registry unavailable",
    "mcp search failed: registry unavailable",
    "skills search failed: skill index offline",
  ]);
});

test("propagates caller aborts instead of reporting a partial result", async () => {
  const presettled = new AbortController();
  presettled.abort();
  const local = createCapabilityBroker(plainProviders());
  await assert.rejects(
    local.search({ query: "firefox", src: "local", cwd: "/tmp", signal: presettled.signal }),
    (error) => error.name === "AbortError",
  );
});

test("a namespace returns all visible members as one candidate, including on member and fuzzy lookup", async () => {
  const namespace = { name: "agents", description: "Independent workers", instructions: "NamespaceOnlyNeedle: collect results before concluding." };
  const members = Array.from({ length: 20 }, (_, index) => ({
    name: "worker_" + index, description: index === 0 ? "UniqueOperation" : "Complementary operation",
    namespace, exposure: index === 19 ? "hidden" : "direct", parameters: { type: "object", properties: {} },
  }));
  const before = structuredClone(members);
  const broker = createCapabilityBroker({ listTools: () => members, listActiveTools: () => [], discoverSkills: () => [] });
  for (const query of ["UniqueOperation", "NamespaceOnlyNeedle", "namespace://agents", "tool://worker_0", "agens"]) {
    const result = await broker.search({ query, src: "local" });
    assert.equal(result.tools.length, 1, query);
    const hit = result.tools[0];
    assert.equal(hit.kind, "namespace");
    assert.equal(hit.ref, "namespace://agents");
    assert.equal(hit.toolCount, 19);
    assert.deepEqual(hit.tools.map((tool) => tool.name), members.slice(0, 19).map((tool) => tool.name));
    assert.equal(hit.instructions, namespace.instructions);
    if (query === "agens") assert.equal(hit.match, "fuzzy");
  }
  assert.deepEqual(members, before);
});

test("candidate limits count namespaces rather than their members for tools and MCP", async () => {
  for (const mcp of [false, true]) {
    const members = Array.from({ length: 10 }, (_, group) => Array.from({ length: 20 }, (_, index) => ({
      name: mcp ? `mcp__group_${group}__operation_${index}` : `operation_${group}_${index}`,
      description: "CandidateLimitNeedle",
      namespace: { name: (mcp ? "mcp__" : "") + "group_" + group },
      exposure: "codemode",
    }))).flat();
    const broker = createCapabilityBroker({ listTools: () => members, listActiveTools: () => [], discoverSkills: () => [] });
    const result = await broker.search({ query: "CandidateLimitNeedle", src: "local" });
    const hits = mcp ? result.mcp : result.tools;
    assert.equal(hits.length, mcp ? CAPABILITY_LIMITS.mcp : CAPABILITY_LIMITS.tools);
    assert.equal(new Set(hits.map((hit) => hit.ref)).size, hits.length);
    assert.ok(hits.every((hit) => hit.toolCount === 20 && hit.tools.length === 20));
  }
});

test("an ordinary namespace groups MCP-sourced and ordinary tools together", async () => {
  const namespace = { name: "mixed", description: "Mixed capability" };
  const tools = [
    { ...BASH, namespace },
    { ...LIST_PAGES, namespace },
  ];
  const broker = createCapabilityBroker({ listTools: () => tools, listActiveTools: () => [], discoverSkills: () => [] });
  const result = await broker.search({ query: "list pages", src: "local" });
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.mcp, []);
  assert.equal(result.tools[0].ref, "namespace://mixed");
  assert.deepEqual(result.tools[0].tools.map((tool) => tool.name), tools.map((tool) => tool.name));
});

test("MCP candidate identity follows native namespaces, not inferred backend server names", async () => {
  const namespace = { name: "mcp__bundle", instructions: "SharedNamespaceNeedle" };
  const first = { ...LIST_PAGES, namespace, sourceInfo: { source: "mcp", path: "mcp:first/list_pages" } };
  const second = { ...RESTART_FIREFOX, namespace, sourceInfo: { source: "mcp", path: "mcp:second/restart_firefox" } };
  const broker = createCapabilityBroker({ listTools: () => [first, second], listActiveTools: () => [], discoverSkills: () => [] });
  for (const query of ["SharedNamespaceNeedle", "namespace://mcp__bundle", "mcp://second/restart_firefox"]) {
    const result = await broker.search({ query, src: "local" });
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.mcp.length, 1);
    assert.equal(result.mcp[0].ref, "namespace://mcp__bundle");
    assert.deepEqual(result.mcp[0].tools.map((tool) => tool.name), [first.name, second.name]);
  }
  const split = createCapabilityBroker({
    listTools: () => [
      { ...first, namespace: { name: "mcp__one" }, description: "SplitNamespaceNeedle" },
      { ...second, namespace: { name: "mcp__two" }, sourceInfo: { source: "mcp", path: "mcp:first/restart_firefox" }, description: "SplitNamespaceNeedle" },
    ],
    listActiveTools: () => [], discoverSkills: () => [],
  });
  const result = await split.search({ query: "SplitNamespaceNeedle", src: "local" });
  assert.deepEqual(result.mcp.map((hit) => hit.ref), ["namespace://mcp__one", "namespace://mcp__two"]);
});

test("classifies exact refs, identifiers, tokens and single-edit fuzzy", async () => {
  const broker = createCapabilityBroker(plainProviders());

  const exact = await broker.search({ query: "tool://bash", src: "local", cwd: "/tmp" });
  assert.equal(exact.tools.length, 1);
  assert.equal(exact.tools[0].ref, "tool://bash");
  assert.equal(exact.tools[0].match, "ref");
  assert.deepEqual(exact.missingCapabilities, []);

  const named = await broker.search({ query: "list pages", src: "local", cwd: "/tmp" });
  const namedTool = named.mcp.find((hit) => hit.ref === "namespace://mcp__firefox_devtools");
  assert.ok(namedTool, "list pages must resolve the MCP tool by its tool-half identifier");
  assert.equal(namedTool.match, "name");

  const prefixed = await broker.search({ query: "devtool", src: "local", cwd: "/tmp" });
  const prefixHit = prefixed.mcp.find((hit) => hit.ref === "namespace://mcp__firefox_devtools");
  assert.ok(prefixHit, "devtool must recall devtools through the prefix tier");
  assert.equal(prefixHit.match, "token");

  const fuzzy = await broker.search({ query: "basch", src: "local", cwd: "/tmp" });
  assert.equal(fuzzy.tools.length, 1);
  assert.equal(fuzzy.tools[0].match, "fuzzy", "a single-edit near miss is reported as fuzzy");
  assert.equal(fuzzy.tools[0].ref, "tool://bash");

  const suppressed = await broker.search({ query: "bash basch", src: "local", cwd: "/tmp" });
  assert.deepEqual(
    suppressed.tools.map((hit) => hit.ref),
    ["tool://bash"],
    "fuzzy candidates must not appear next to an exact-tier match",
  );
  assert.equal(suppressed.tools[0].match, "name");
});

test("keeps the fuzzy fallback out while another local group has a primary match", async () => {
  const broker = createCapabilityBroker(plainProviders());

  // `basch` is one edit from `bash`, but the skill group matches `限制` at the
  // token tier, so no local group may fall back and bash never surfaces.
  const suppressed = await broker.search({ query: "限制 basch", src: "local", cwd: "/tmp" });
  assert.ok(suppressed.skills.length > 0, "the skill group must match at the token tier");
  for (const group of [suppressed.tools, suppressed.mcp, suppressed.skills]) {
    assert.ok(group.every((hit) => hit.match !== "fuzzy"), "no group may fall back while another local group matched");
  }
  assert.ok(suppressed.tools.every((hit) => hit.ref !== "tool://bash"));

  // With no primary hit anywhere local, the fallback opens up.
  const fallback = await broker.search({ query: "basch", src: "local", cwd: "/tmp" });
  assert.deepEqual(fallback.tools.map((hit) => hit.ref), ["tool://bash"]);
  assert.equal(fallback.tools[0].match, "fuzzy");
  assert.deepEqual(fallback.mcp, []);
});

test("falls back to fuzzy skills when every local group is otherwise empty", async () => {
  const broker = createCapabilityBroker({
    listTools: () => [],
    listActiveTools: () => [],
    discoverSkills: () => ({
      skills: [
        { name: "broken-firefox", description: "Firefox workflow.", filePath: "/missing/SKILL.md" },
        { name: "healthy-firefox", description: "Firefox workflow.", filePath: "/ok/SKILL.md" },
      ],
      diagnostics: [],
    }),
    readSkillFile: async () => "",
  });
  const result = await broker.search({ query: "firefux", src: "local", cwd: "/tmp" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.mcp, []);
  assert.deepEqual(result.skills.map((hit) => hit.name), ["broken-firefox", "healthy-firefox"]);
  assert.deepEqual(result.skills.map((hit) => hit.match), ["fuzzy", "fuzzy"]);
  assert.deepEqual(result.missingCapabilities, [], "a fuzzy hit still covers its query token");
});

test("excludes hidden tools from search", async () => {
  const broker = createCapabilityBroker(plainProviders());
  const result = await broker.search({ query: "navigate the firefox page", src: "local", cwd: "/tmp" });
  assert.ok(
    result.tools.every((hit) => hit.name !== WITHDRAWN.name),
    "a hidden tool must never be discovered",
  );
  assert.ok(
    result.mcp.every((hit) => hit.ref !== "mcp://firefox_devtools/withdrawn_navigate"),
    "a hidden MCP tool must never be discovered",
  );
});

test("reads MCP identity from namespace, minted name and explicit provenance path", async () => {
  const cases = [
    {
      query: "firefox list pages",
      tool: {
        name: "mcp__firefox_devtools__list_pages",
        description: "List pages in the connected browser.",
        exposure: "direct",
        namespace: { name: "mcp__firefox_devtools" },
        sourceInfo: { path: "builtin:mcp", source: "builtin" },
      },
      expected: { ref: "mcp://firefox_devtools/list_pages", server: "firefox_devtools", tool: "list_pages", basis: "namespace" },
    },
    {
      // Explicit provenance paths carry the original (dash-preserving) server name.
      query: "firefox list pages",
      tool: {
        name: "mcp__firefox_devtools_list_pages",
        description: "List pages in the connected browser.",
        exposure: "direct",
        sourceInfo: { path: "mcp:firefox-devtools/list_pages", source: "mcp" },
      },
      expected: { ref: "mcp://firefox-devtools/list_pages", server: "firefox-devtools", tool: "list_pages", basis: "source path" },
    },
    {
      query: "seedpatch bank",
      tool: {
        name: "mcp__seedpatch-client__bank",
        description: "Read the bank ledger.",
        exposure: "direct",
        namespace: { name: "mcp__seedpatch_client" },
        sourceInfo: { path: "<mcp:mcp__seedpatch-client__bank>", source: "mcp" },
      },
      expected: { ref: "mcp://seedpatch-client/bank", server: "seedpatch-client", tool: "bank", basis: "source path" },
    },
  ];

  for (const item of cases) {
    const broker = createCapabilityBroker(
      plainProviders({
        listTools: () => [item.tool],
        listActiveTools: () => [],
        discoverSkills: () => ({ skills: [], diagnostics: [] }),
      }),
    );
    const result = await broker.search({ query: item.query, src: "local", cwd: "/tmp" });
    assert.equal(result.mcp.length, 1);
    const hit = result.mcp[0];
    assert.equal(hit.ref, item.tool.namespace ? `namespace://${item.tool.namespace.name}` : `mcp://${item.expected.server}`);
    assert.equal(hit.server, item.expected.server);
    assert.equal(hit.tools.length, 1);
    assert.equal(hit.tools[0].ref, item.expected.ref);
    assert.equal(hit.tools[0].name, item.tool.name);
    assert.match(hit.reason, new RegExp(`server from ${item.expected.basis}`));
  }

  const anonymous = createCapabilityBroker(
    plainProviders({
      listTools: () => [
        {
          name: "acme_query",
          description: "Query the acme service.",
          exposure: "direct",
          sourceInfo: { path: "<extension:acme_query>", source: "mcp" },
        },
      ],
      listActiveTools: () => [],
      discoverSkills: () => ({ skills: [], diagnostics: [] }),
    }),
  );
  const anonymousResult = await anonymous.search({ query: "acme query", src: "local", cwd: "/tmp" });
  assert.deepEqual(anonymousResult.mcp, [], "an unparseable server identity is never invented");
  assert.deepEqual(anonymousResult.warnings, ['mcp tool "acme_query" exposes no parseable server identity']);
  assert.ok(anonymousResult.tools.length > 0, "the tools group still reports the registered tool");
});

test("binds skills to matched refs and extracts their caveats", async () => {
  const broker = createCapabilityBroker(
    plainProviders({
      readSkillFile: async (filePath) => {
        assert.equal(filePath, FIREFOX_SKILL.filePath);
        return FIREFOX_SKILL_BODY;
      },
    }),
  );

  const result = await broker.search({ query: CHINESE_QUERY, src: "local", cwd: "/tmp" });
  assert.equal(result.status, "ok");
  const skill = result.skills.find((hit) => hit.filePath === FIREFOX_SKILL.filePath);
  assert.ok(skill, "the firefox skill must be recalled");
  assert.match(skill.reason, /body/);
  assert.deepEqual(skill.bindsTo, ["namespace://mcp__firefox_devtools"]);

  const prohibition = skill.caveats.find((caveat) => caveat.kind === "prohibition");
  assert.ok(prohibition, "the prohibition sentence must become a caveat");
  assert.equal(prohibition.failureVisibility, "silent");
  assert.deepEqual(prohibition.targets, ["namespace://mcp__firefox_devtools"]);
  assert.deepEqual(prohibition.sources, [
    { skill: FIREFOX_SKILL.filePath, filePath: FIREFOX_SKILL.filePath, section: "限制", where: "body" },
  ]);
  assert.ok(skill.caveats.some((caveat) => caveat.kind === "precondition" && caveat.targets.includes("namespace://mcp__firefox_devtools")));
  assert.ok(
    skill.caveats.some(
      (caveat) => caveat.kind === "verification" && caveat.targets.includes("namespace://mcp__firefox_devtools"),
    ),
  );
  assert.equal(skill.caveats[0].kind, "prohibition", "silent prohibitions rank first");
});

test("extracts a caveat from a skill description that names a hit", async () => {
  const broker = createCapabilityBroker(
    plainProviders({
      discoverSkills: () => ({
        skills: [{ name: "desc-caveat", description: "Prefer list_pages to verify the connection.", filePath: "/x/SKILL.md" }],
        diagnostics: [],
      }),
      readSkillFile: async () => "",
    }),
  );
  const result = await broker.search({ query: "list pages", src: "local", cwd: "/tmp" });
  const skill = result.skills.find((hit) => hit.filePath === "/x/SKILL.md");
  assert.ok(skill);
  const caveat = skill.caveats.find((entry) => entry.sources.some((source) => source.where === "description"));
  assert.ok(caveat, "a description-named anchor must still produce a caveat");
  assert.deepEqual(caveat.targets, ["namespace://mcp__firefox_devtools"]);
});

test("reads skill bodies through the bounded default file reader", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capability-broker-"));
  try {
    const filePath = path.join(directory, "SKILL.md");
    await writeFile(filePath, "# Temp skill\n\n- Use list_pages before acting.\n", "utf8");
    const broker = createCapabilityBroker({
      listTools: () => [],
      listActiveTools: () => [],
      discoverSkills: () => ({
        skills: [{ name: "temp-skill", description: "List pages workflow.", filePath: "SKILL.md" }],
        diagnostics: [],
      }),
    });

    const result = await broker.search({ query: "list_pages", src: "local", cwd: directory });
    assert.equal(result.status, "ok");
    assert.equal(result.skills.length, 1);
    assert.match(result.skills[0].reason, /body/);
    assert.deepEqual(result.warnings, []);

    assert.equal(result.skills[0].ref, filePath);
    assert.equal(result.skills[0].filePath, filePath);
    assert.equal(result.skills[0].body, undefined, 'return an entry path, not the Skill body');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps recall hits when a single skill body cannot be read and normalizes diagnostics", async () => {
  const broker = createCapabilityBroker({
    listTools: () => [],
    listActiveTools: () => [],
    discoverSkills: () => ({
      skills: [
        { name: "broken-firefox", description: "Firefox workflow.", filePath: "/missing/SKILL.md" },
        { name: "healthy-firefox", description: "Firefox workflow.", filePath: "/ok/SKILL.md" },
      ],
      diagnostics: [{ type: "error", message: "frontmatter invalid", path: "/side/SKILL.md" }],
    }),
    readSkillFile: async (filePath) => {
      if (filePath === "/missing/SKILL.md") throw new Error("ENOENT");
      return "Use list_pages before acting.";
    },
  });

  const result = await broker.search({ query: "firefox workflow", src: "local", cwd: "/tmp" });
  assert.equal(result.status, "ok", "one unreadable body must not fail the skill group");
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["broken-firefox", "healthy-firefox"],
  );
  assert.ok(result.warnings.includes('skill "broken-firefox" body unreadable: ENOENT'));
  assert.ok(result.warnings.includes("skill discovery error: frontmatter invalid (/side/SKILL.md)"));

  const exact = await broker.search({ query: "/missing/SKILL.md", src: "local", cwd: "/tmp" });
  assert.equal(exact.status, "ok");
  assert.equal(exact.skills.length, 1);
  assert.equal(exact.skills[0].match, "ref");
  assert.equal(exact.skills[0].body, undefined, "an unreadable body is never fabricated");
  assert.ok(exact.warnings.includes('skill "broken-firefox" body unreadable: ENOENT'));
});



test("reports an MCP namespace once, with all visible members under its namespace ref", async () => {
  const broker = createCapabilityBroker(plainProviders());
  const result = await broker.search({ query: "list pages", src: "local", cwd: "/tmp" });
  assert.equal(result.mcp.length, 1);
  assert.equal(result.mcp[0].ref, "namespace://mcp__firefox_devtools");
  assert.deepEqual(result.mcp[0].tools.map((tool) => tool.name), [LIST_PAGES.name, RESTART_FIREFOX.name]);
  assert.equal(result.mcp[0].toolCount, 2);
  const exactMember = await broker.search({ query: "mcp://firefox_devtools/list_pages", src: "local" });
  assert.deepEqual(exactMember.mcp.map((hit) => hit.ref), ["namespace://mcp__firefox_devtools"]);
  assert.deepEqual(exactMember.mcp[0].tools.map((tool) => tool.name), [LIST_PAGES.name, RESTART_FIREFOX.name]);
  assert.ok(
    result.tools.every((hit) => hit.name !== LIST_PAGES.name),
    "the same MCP tool must not also appear under a tool:// identity",
  );

  const alias = await broker.search({ query: `tool://${LIST_PAGES.name}`, src: "local", cwd: "/tmp" });
  assert.deepEqual(alias.tools, []);
  assert.deepEqual(alias.warnings, [
    `ref "tool://${LIST_PAGES.name}" names an MCP tool; MCP tools are addressed by their mcp://<server>/<tool> ref`,
  ]);

});

test("returns the same result for the same query and providers", async () => {
  const first = await createCapabilityBroker(plainProviders()).search({ query: CHINESE_QUERY, src: "local", cwd: "/tmp" });
  const second = await createCapabilityBroker(plainProviders()).search({ query: CHINESE_QUERY, src: "local", cwd: "/tmp" });
  assert.deepEqual(first, second);
});

test("rejects a blank query without searching anything and an invalid src", async () => {
  const broker = createCapabilityBroker(
    plainProviders({
      listTools: () => {
        throw new Error("must not be called");
      },
    }),
  );

  const result = await broker.search({ query: "   ", src: "local", cwd: "/tmp" });
  assert.deepEqual(result, {
    status: "failed",
    tools: [],
    mcp: [],
    skills: [],
    remote: [],
    missingCapabilities: [],
    warnings: ["capability search query must be a non-empty string"],
  });

  await assert.rejects(broker.search({ query: "firefox", src: "somewhere", cwd: "/tmp" }), /src must be/);
});

test("exposes the no-argument public schema and the internal retrieval schemas", () => {
  assert.equal(CAPABILITY_TOOL_NAME, "capability");
  assert.deepEqual(CAPABILITY_PARAMETERS, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.ok(Object.isFrozen(CAPABILITY_PARAMETERS));

  assert.equal(CAPABILITY_SEARCH_PARAMETERS.type, "object");
  assert.deepEqual([...CAPABILITY_SEARCH_PARAMETERS.required], ["query", "src"]);
  assert.deepEqual(CAPABILITY_SEARCH_PARAMETERS.properties.src.enum, ["local", "remote", "all"]);
  assert.equal(CAPABILITY_SEARCH_PARAMETERS.properties.query.minLength, 1);
  assert.equal(CAPABILITY_SEARCH_PARAMETERS.additionalProperties, false);

  assert.equal(SUBMIT_RESULT_PARAMETERS.type, "object");
  assert.deepEqual([...SUBMIT_RESULT_PARAMETERS.required], ["refs"]);
  assert.equal(SUBMIT_RESULT_PARAMETERS.properties.refs.type, "array");
  assert.equal(SUBMIT_RESULT_PARAMETERS.properties.refs.items.type, "string");
  assert.equal(SUBMIT_RESULT_PARAMETERS.additionalProperties, false);
  assert.equal(CAPABILITY_LIMITS.remote, 5);
});
