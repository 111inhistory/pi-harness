import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HARNESS_CONFIG } from "../../src/harness-config.ts";
import {
  createCapabilityBroker,
  type CapabilityProviders,
} from "../../src/capability/broker.ts";

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
  description: "Workflow for connecting to existing Firefox profile and devtools.",
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
  "- 应先外部启动目标 Profile，再由 mcp:firefox-devtools 接管。",
  "- 使用 list_pages 验证连接状态。",
].join("\n");

function plainProviders(overrides: Partial<CapabilityProviders> = {}): CapabilityProviders {
  return {
    listTools: () => TOOLS,
    listActiveTools: () => ACTIVE_TOOLS,
    discoverSkills: () => ({ skills: [FIREFOX_SKILL], diagnostics: [] }),
    readSkillFile: async () => FIREFOX_SKILL_BODY,
    ...overrides,
  };
}

test("already-active builtin and SDK additional tools are omitted from search", async () => {
  const additional = { ...BASH, name: "sdk_tool", sourceInfo: { source: "sdk" } };
  const broker = createCapabilityBroker(
    plainProviders({
      listTools: () => [BASH, additional],
      listActiveTools: () => ["bash", "sdk_tool"],
    }),
  );
  for (const query of ["bash", "tool://bash", "sdk_tool"]) {
    const result = await broker.search({ query, src: "local" });
    assert.deepEqual(result.tools, []);
  }
});

test("runs the local source groups concurrently and returns the host-facing result shape", async () => {
  let listToolsStarted = false;
  let listActiveToolsStarted = false;
  let discoverSkillsStarted = false;

  const broker = createCapabilityBroker(
    plainProviders({
      listTools: async () => {
        listToolsStarted = true;
        return TOOLS;
      },
      listActiveTools: async () => {
        listActiveToolsStarted = true;
        return ACTIVE_TOOLS;
      },
      discoverSkills: async () => {
        discoverSkillsStarted = true;
        return { skills: [FIREFOX_SKILL], diagnostics: [] };
      },
    }),
  );

  const result = await broker.search({ query: "firefox shell commands", src: "local" });

  assert.ok(listToolsStarted && listActiveToolsStarted && discoverSkillsStarted);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.remote, []);
  assert.ok(result.tools.length > 0, "expected tool hits");
  assert.ok(result.mcp.length > 0, "expected mcp hits");
  assert.ok(result.skills.length > 0, "expected skill hits");

  for (const hit of [...result.tools, ...result.mcp, ...result.skills]) {
    assert.equal(typeof hit.ref, "string");
    assert.equal(typeof hit.name, "string");
    assert.equal(typeof hit.description, "string");
    assert.ok(["tool", "namespace", "mcp", "skill"].includes(hit.kind));
    assert.equal(hit.status, "available");
    assert.ok(["bm25", "ref"].includes(hit.match));
    assert.equal(typeof hit.score, "number");
  }
});

test("isolates a failing local group and still returns other groups with partial status", async () => {
  const broker = createCapabilityBroker(
    plainProviders({
      discoverSkills: () => {
        throw new Error("skill index offline");
      },
    }),
  );

  const result = await broker.search({ query: "firefox", src: "local" });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.skills, []);
  assert.ok(result.mcp.length > 0);
  assert.ok(result.warnings.some((w) => /skills search failed: skill index offline/.test(w)));
});

test("reports failed status when every local group fails", async () => {
  const broker = createCapabilityBroker({
    listTools: () => {
      throw new Error("tools offline");
    },
    listActiveTools: () => [],
    discoverSkills: () => {
      throw new Error("skills offline");
    },
  });

  const result = await broker.search({ query: "firefox", src: "local" });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.mcp, []);
  assert.deepEqual(result.skills, []);
  assert.ok(result.warnings.some((w) => /tools search failed/.test(w)));
  assert.ok(result.warnings.some((w) => /skills search failed/.test(w)));
});

test("propagates caller aborts instead of reporting a partial result", async () => {
  const controller = new AbortController();
  controller.abort();
  const broker = createCapabilityBroker(plainProviders());

  await assert.rejects(
    broker.search({ query: "firefox", src: "local", signal: controller.signal }),
    (error: unknown) => error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)),
  );
});

test("a namespace returns all visible members as one candidate on member or namespace lookup", async () => {
  const namespace = {
    name: "agents",
    description: "Independent workers",
    instructions: "Collect results before concluding.",
  };
  const members = Array.from({ length: 20 }, (_, index) => ({
    name: `worker_${index}`,
    description: index === 0 ? "UniqueOperation specialized tool" : "Complementary operation tool",
    namespace,
    exposure: index === 19 ? "hidden" : "direct",
    parameters: { type: "object", properties: {} },
  }));

  const broker = createCapabilityBroker({
    listTools: () => members,
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  for (const query of ["UniqueOperation", "Collect results", "namespace://agents", "tool://worker_0"]) {
    const result = await broker.search({ query, src: "local" });
    assert.equal(result.tools.length, 1, `expected 1 namespace hit for query "${query}"`);
    const hit = result.tools[0]!;
    assert.equal(hit.kind, "namespace");
    assert.equal(hit.ref, "namespace://agents");
    assert.equal(hit.toolCount, 19, "hidden member must be excluded from visible count");
    assert.deepEqual(
      hit.tools?.map((tool) => tool.name),
      members.slice(0, 19).map((tool) => tool.name),
    );
    assert.equal(hit.instructions, namespace.instructions);
  }
});

test("candidate limits count namespaces rather than their members for tools and MCP", async () => {
  for (const mcp of [false, true]) {
    const members = Array.from({ length: 10 }, (_, group) =>
      Array.from({ length: 20 }, (_, index) => ({
        name: mcp ? `mcp__group_${group}__operation_${index}` : `operation_${group}_${index}`,
        description: "CandidateLimitNeedle specialized operation",
        namespace: { name: (mcp ? "mcp__" : "") + "group_" + group },
        exposure: "direct",
      })),
    ).flat();

    const broker = createCapabilityBroker({
      listTools: () => members,
      listActiveTools: () => [],
      discoverSkills: () => ({ skills: [] }),
    });

    const result = await broker.search({ query: "CandidateLimitNeedle", src: "local" });
    const hits = mcp ? result.mcp : result.tools;
    assert.equal(hits.length, mcp ? DEFAULT_HARNESS_CONFIG.capability.search.limits.mcp : DEFAULT_HARNESS_CONFIG.capability.search.limits.tools);
    assert.equal(new Set(hits.map((hit) => hit.ref)).size, hits.length);
    assert.ok(hits.every((hit) => hit.toolCount === 20 && hit.tools?.length === 20));
  }
});

test("an ordinary namespace groups MCP-sourced and ordinary tools together", async () => {
  const namespace = { name: "mixed", description: "Mixed capability tools" };
  const tools = [
    { ...BASH, namespace },
    { ...LIST_PAGES, namespace },
  ];

  const broker = createCapabilityBroker({
    listTools: () => tools,
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  const result = await broker.search({ query: "list pages", src: "local" });
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.mcp, []);
  assert.equal(result.tools[0]!.ref, "namespace://mixed");
  assert.deepEqual(
    result.tools[0]!.tools?.map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
});

test("MCP candidate identity follows native namespaces, not inferred backend server names", async () => {
  const namespace = { name: "mcp__bundle", instructions: "SharedNamespaceNeedle instructions" };
  const first = { ...LIST_PAGES, namespace, sourceInfo: { source: "mcp", path: "mcp:first/list_pages" } };
  const second = { ...RESTART_FIREFOX, namespace, sourceInfo: { source: "mcp", path: "mcp:second/restart_firefox" } };

  const broker = createCapabilityBroker({
    listTools: () => [first, second],
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  for (const query of ["SharedNamespaceNeedle", "namespace://mcp__bundle", "mcp://first/list_pages"]) {
    const result = await broker.search({ query, src: "local" });
    assert.deepEqual(result.tools, []);
    assert.equal(result.mcp.length, 1);
    assert.equal(result.mcp[0]!.ref, "namespace://mcp__bundle");
    assert.deepEqual(
      result.mcp[0]!.tools?.map((tool) => tool.name),
      [first.name, second.name],
    );
  }
});

test("excludes hidden tools from search results", async () => {
  const broker = createCapabilityBroker(plainProviders());
  const result = await broker.search({ query: "navigate firefox page", src: "local" });
  assert.ok(result.tools.every((hit) => hit.name !== WITHDRAWN.name));
  assert.ok(result.mcp.every((hit) => hit.tools?.every((t) => t.name !== WITHDRAWN.name)));
});

test("exact ref lookup resolves tools, namespaces, mcp, and skills without fallback", async () => {
  const broker = createCapabilityBroker(plainProviders());

  const exactTool = await broker.search({ query: "tool://bash", src: "local" });
  assert.equal(exactTool.tools.length, 1);
  assert.equal(exactTool.tools[0]!.ref, "tool://bash");
  assert.equal(exactTool.tools[0]!.match, "ref");

  const exactMcp = await broker.search({ query: "mcp://firefox_devtools/list_pages", src: "local" });
  assert.equal(exactMcp.mcp.length, 1);
  assert.equal(exactMcp.mcp[0]!.match, "ref");
  assert.equal(exactMcp.mcp[0]!.ref, "namespace://mcp__firefox_devtools");

  const exactSkill = await broker.search({ query: FIREFOX_SKILL.filePath, src: "local" });
  assert.equal(exactSkill.skills.length, 1);
  assert.equal(exactSkill.skills[0]!.match, "ref");
  assert.equal(exactSkill.skills[0]!.filePath, FIREFOX_SKILL.filePath);

  const missingRef = await broker.search({ query: "tool://non_existent_tool", src: "local" });
  assert.deepEqual(missingRef.tools, []);

  const aliasMcp = await broker.search({ query: `tool://${LIST_PAGES.name}`, src: "local" });
  assert.deepEqual(aliasMcp.tools, []);
  assert.ok(aliasMcp.warnings.some((w) => /names an MCP tool/.test(w)));
});

test("reads skill bodies through bounded reader capped at skillBodies limit", async () => {
  const openedFiles: string[] = [];
  const candidateCount = DEFAULT_HARNESS_CONFIG.capability.search.limits.skillBodies + 4;
  const broker = createCapabilityBroker({
    listTools: () => [],
    listActiveTools: () => [],
    discoverSkills: () => ({
      skills: Array.from({ length: candidateCount }, (_, i) => ({
        name: `deploy-step-${i}`,
        description: `Deployment pipeline workflow step ${i}`,
        filePath: `/skills/deploy-${i}/SKILL.md`,
      })),
      diagnostics: [],
    }),
    readSkillFile: async (filePath) => {
      openedFiles.push(filePath);
      return "# Deployment workflow body\n";
    },
  });

  const result = await broker.search({ query: "deployment pipeline", src: "local" });
  assert.equal(result.status, "ok");
  assert.ok(openedFiles.length <= DEFAULT_HARNESS_CONFIG.capability.search.limits.skillBodies);
  assert.equal(openedFiles.length, DEFAULT_HARNESS_CONFIG.capability.search.limits.skillBodies);
  assert.ok(result.skills.length <= DEFAULT_HARNESS_CONFIG.capability.search.limits.skills);
});

test("tolerates unreadable skill body and records normalized warning", async () => {
  const broker = createCapabilityBroker({
    listTools: () => [],
    listActiveTools: () => [],
    discoverSkills: () => ({
      skills: [
        { name: "broken-skill", description: "Broken skill workflow", filePath: "/missing/SKILL.md" },
        { name: "healthy-skill", description: "Healthy skill workflow", filePath: "/ok/SKILL.md" },
      ],
      diagnostics: [{ type: "error", message: "frontmatter invalid", path: "/side/SKILL.md" }],
    }),
    readSkillFile: async (filePath) => {
      if (filePath === "/missing/SKILL.md") throw new Error("ENOENT file not found");
      return "Healthy workflow body content.";
    },
  });

  const result = await broker.search({ query: "skill workflow", src: "local" });
  assert.equal(result.status, "ok");
  assert.equal(result.skills.length, 2);
  assert.ok(result.warnings.some((w) => /broken-skill.*unreadable.*ENOENT/.test(w)));
  assert.ok(result.warnings.some((w) => /frontmatter invalid/.test(w)));
});

test("rejects a blank query without searching and requires src to be 'local'", async () => {
  const broker = createCapabilityBroker({
    listTools: () => {
      throw new Error("must not be called");
    },
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  const empty = await broker.search({ query: "   ", src: "local" });
  assert.equal(empty.status, "failed");
  assert.ok(empty.warnings.some((w) => /query must be a non-empty string/.test(w)));

  await assert.rejects(
    broker.search({ query: "firefox", src: "remote" }),
    /src must be "local"/,
  );
});

test("BM25 ranks a rare query term above repetition of a common term", async () => {
  const broker = createCapabilityBroker({
    listTools: () => [
      {
        name: "docker_inspect",
        description: "Inspect container state and network metadata in local daemon.",
        exposure: "direct",
        sourceInfo: { source: "tool" },
      },
      {
        name: "git_commit",
        description: "Record commit changes to the local repository.",
        exposure: "direct",
        sourceInfo: { source: "tool" },
      },
      {
        name: "system_status",
        description: "Display local local local local local local local local host system and process status.",
        exposure: "direct",
        sourceInfo: { source: "tool" },
      },
    ],
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  const result = await broker.search({ query: "local container", src: "local" });
  assert.equal(result.status, "ok");
  assert.ok(result.tools.length >= 1);
  assert.equal(result.tools[0]!.name, "docker_inspect");
  assert.ok(result.tools[0]!.score > 0);
});

test("unmatched query returns empty candidates and populates missingCapabilities", async () => {
  const broker = createCapabilityBroker(plainProviders());
  const result = await broker.search({ query: "completely_unmatched_xyz_token", src: "local" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.mcp, []);
  assert.deepEqual(result.skills, []);
  assert.ok(result.missingCapabilities.length > 0);
  assert.ok(result.missingCapabilities[0]!.includes("completely_unmatched_xyz_token"));
});

test("default tokenizer matches exact non-ASCII tokens delimited by whitespace or punctuation", async () => {
  const broker = createCapabilityBroker({
    listTools: () => [
      {
        name: "db_tool",
        description: "数据库 指南： 用于 执行 SQL 查询。",
        exposure: "direct",
        sourceInfo: { source: "tool" },
      },
    ],
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [] }),
  });

  const matched = await broker.search({ query: "数据库", src: "local" });
  assert.equal(matched.tools.length, 1);
  assert.equal(matched.tools[0]!.name, "db_tool");
  assert.ok(matched.tools[0]!.score > 0);

  const unmatched = await broker.search({ query: "网络", src: "local" });
  assert.equal(unmatched.tools.length, 0);
});

test("custom BM25 k, b and d reach MiniSearch while exact refs and group ranking stay stable", async () => {
  const tools = [
    { name: "alpha_tool", description: "deploy deploy deploy deploy deploy deploy deploy pipeline alpha", exposure: "direct" },
    { name: "beta_tool", description: "deploy pipeline beta", exposure: "direct" },
    { name: "gamma_tool", description: "unrelated gamma", exposure: "direct" },
  ];
  const providers = { listTools: () => tools, listActiveTools: () => [], discoverSkills: () => ({ skills: [] }) };
  const search = DEFAULT_HARNESS_CONFIG.capability.search;
  const variants = {
    default: search.bm25,
    k: { k: 0.1, b: 0.9, d: 0 },
    b: { k: 0.9, b: 0, d: 0 },
    d: { k: 0.9, b: 0.9, d: 2 },
  };
  const scores = new Map<string, number>();
  for (const [name, bm25] of Object.entries(variants)) {
    const broker = createCapabilityBroker(providers, { ...search, bm25 });
    const result = await broker.search({ query: "deploy pipeline alpha", src: "local" });
    assert.deepEqual(result.tools.map((hit) => hit.name), ["alpha_tool", "beta_tool"],
      `group ranking uses the highest member score for ${name}`);
    scores.set(name, result.tools[0]!.score);
    const exact = await broker.search({ query: "tool://beta_tool", src: "local" });
    assert.equal(exact.tools.length, 1);
    assert.equal(exact.tools[0]!.match, "ref");
    assert.equal(exact.tools[0]!.score, 0, "exact ref lookup never consults BM25 parameters");
  }
  const base = scores.get("default")!;
  assert.ok(scores.get("k")! < base, "lower k reduces repeated-term saturation");
  assert.notEqual(scores.get("b"), base, "b changes length normalization");
  assert.ok(scores.get("d")! > base, "positive d adds the BM25+ delta");
});

function limitedProviders(opened: string[]) {
  const namespaceMembers = (namespace: string, label: string) => Array.from({ length: 2 }, (_, index) => ({
    name: `${namespace}_op_${index}`,
    description: `${label} member ${index}`,
    namespace: { name: namespace, description: `${label} namespace description long enough to truncate` },
    exposure: "direct",
  }));
  const mcpMembers = (server: string, label: string) => Array.from({ length: 2 }, (_, index) => ({
    name: `mcp__${server}__op_${index}`,
    description: `${label} member ${index}`,
    namespace: { name: `mcp__${server}`, description: `${label} namespace description long enough to truncate` },
    sourceInfo: { source: "mcp", path: `mcp:${server}/op_${index}` },
    exposure: "direct",
  }));
  return {
    listTools: () => [
      ...namespaceMembers("alpha_ns", "LimitNeedle alpha"),
      ...namespaceMembers("beta_ns", "LimitNeedle beta"),
      ...mcpMembers("mcp_alpha", "McpLimitNeedle alpha"),
      ...mcpMembers("mcp_beta", "McpLimitNeedle beta"),
      { name: "beta_only", description: "BetaToken specialized tool", exposure: "direct" },
    ],
    listActiveTools: () => [],
    discoverSkills: () => ({
      skills: Array.from({ length: 3 }, (_, index) => ({
        name: `skill-${index}`,
        description: "SkillNeedle deployment workflow",
        filePath: `/skills/deploy-${index}/SKILL.md`,
      })),
    }),
    readSkillFile: async (filePath: string) => {
      opened.push(filePath);
      return "0123456789ABCDEF BODYNEEDLE";
    },
  };
}

test("custom search limits bound query terms, result groups, descriptions and body candidates", async () => {
  const opened: string[] = [];
  const search = DEFAULT_HARNESS_CONFIG.capability.search;
  const limits = { ...search.limits, tools: 1, mcp: 1, skills: 1, skillBodies: 2, requestTokens: 1,
    descriptionChars: 24, skillBodyChars: 12 };
  const broker = createCapabilityBroker(limitedProviders(opened), { ...search, limits });

  const tools = await broker.search({ query: "LimitNeedle", src: "local" });
  assert.equal(tools.tools.length, limits.tools);
  const namespace = tools.tools[0]!;
  assert.equal(namespace.kind, "namespace");
  assert.equal(namespace.tools?.length, 2, "a candidate limit never truncates selected namespace members");
  assert.ok(namespace.description.length <= limits.descriptionChars);
  assert.match(namespace.description, /…$/, "descriptionChars bounds the broker summary");

  const mcp = await broker.search({ query: "McpLimitNeedle", src: "local" });
  assert.equal(mcp.mcp.length, limits.mcp);
  assert.equal(mcp.mcp[0]!.tools?.length, 2);

  const skills = await broker.search({ query: "SkillNeedle", src: "local" });
  assert.equal(skills.skills.length, limits.skills);
  assert.equal(opened.length, limits.skillBodies, "only the metadata-ranked body candidates are read");

  const custom = await broker.search({ query: "GammaToken BetaToken", src: "local" });
  assert.deepEqual(custom.tools, [], "requestTokens limits the query to its first default-tokenizer term");
  const defaults = createCapabilityBroker(limitedProviders(opened), search);
  const unbounded = await defaults.search({ query: "GammaToken BetaToken", src: "local" });
  assert.deepEqual(unbounded.tools.map((hit) => hit.name), ["beta_only"]);
});

test("custom skillBodyChars bounds the body text admitted to the index", async () => {
  const search = DEFAULT_HARNESS_CONFIG.capability.search;
  const providers = {
    listTools: () => [],
    listActiveTools: () => [],
    discoverSkills: () => ({ skills: [{ name: "skill-0", description: "deployment workflow", filePath: "/skills/deploy/SKILL.md" }] }),
    readSkillFile: async () => "0123456789ABCDEF BODYNEEDLE",
  };
  const custom = createCapabilityBroker(providers, { ...search, limits: { ...search.limits, skillBodyChars: 12 } });
  const defaults = createCapabilityBroker(providers, search);
  const bounded = await custom.search({ query: "deployment BODYNEEDLE", src: "local" });
  const full = await defaults.search({ query: "deployment BODYNEEDLE", src: "local" });
  assert.equal(bounded.skills.length, 1);
  assert.equal(full.skills.length, 1);
  assert.ok(bounded.skills[0]!.score < full.skills[0]!.score, "a truncated body cannot contribute the later term");
});
