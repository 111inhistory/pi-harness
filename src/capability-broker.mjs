/**
 * Read-only capability broker (v2 search/read contract).
 *
 * The public `capability` tool takes no arguments: the caller's conversation is
 * the request. Search runs inside an internal retrieval agent that calls this
 * module through two internal tools, `capability_search(query, src)` and
 * `submit_result(refs)`; the broker itself is model-free and deterministic.
 *
 * `search({ query, src, cwd, signal })` runs the fixed source groups:
 *
 *   src: "local"  tools + MCP + skills, concurrently, no network
 *   src: "remote" npm marketplace metadata only (uninstalled candidates)
 *   src: "all"    local groups and the remote group concurrently,
 *                 local groups first in the result
 *
 * Every result always carries `tools`, `mcp`, `skills`, `remote`,
 * `missingCapabilities` and `warnings`. A failing group never empties another
 * group: it is named in `warnings` and degrades `status` to "partial" (or
 * "failed" when every group failed). Remote failure/timeout never cancels the
 * local groups and is never presented as "the marketplace has nothing".
 *
 * Providers (all optional at construction, sync or async):
 *
 *   listTools()             -> ToolInfo[]              (pi.getAllTools())
 *   listActiveTools()       -> string[]                (pi.getActiveTools())
 *   discoverSkills(cwd)     -> { skills, diagnostics } | { skills, warnings } | Skill[]
 *                              (native pi 0.99 loadSkills result; normalized)
 *   readSkillFile(path)     -> string                  (defaults to a bounded UTF-8 file read)
 *   searchRemote(query, { signal }) -> { candidates }   (npm marketplace helper)
 *   readRemote(ref, { signal })     -> package metadata (npm marketplace helper)
 *   listInstalledPackages()         -> package sources  (for the exact-ref install check)
 *
 * ToolInfo is `{ name, description, parameters, exposure, namespace, sourceInfo }`.
 * Only visible capabilities are surfaced: `exposure === "hidden"` tools (registered
 * but unreachable) and `disableModelInvocation` skills (not model-invocable) are
 * excluded from search and rejected by `read`. MCP identity comes from the
 * tool's `namespace` (`mcp__<server>`), the harness `mcp__<server>__<tool>` name,
 * or an explicit `mcp:<server>[/<tool>]` source path, in that order of specificity.
 * Every namespace is one candidate with all visible members and shared
 * instructions, addressed by namespace://. MCP tools with no native namespace
 * use a server-level mcp:// candidate. Member lookups return the whole group. MCP-sourced tools without a
 * parseable identity keep the ordinary tool fallback (or their ordinary namespace).
 *
 * Hits carry stable URI refs, and `read(ref, { cwd, signal })` resolves exact
 * known resources only:
 *
 *   tool://<encoded-name>                     -> tool metadata JSON
 *   namespace://<encoded-name>                -> namespace instructions and all visible tool metadata
 *   mcp://<encoded-server>[/<encoded-tool>]   -> server/tool metadata JSON
 *   skill://<encoded-name>                    -> full skill body text
 *   npm://<encoded-package>@<version>         -> npm package metadata JSON
 *
 * Unknown schemes, malformed refs, unknown or hidden resources and unreadable
 * skill bodies fail explicitly; nothing is fabricated. Ranking is the v2 fixed
 * ladder: exact ref, identifier/name, token+prefix recall, then single-edit
 * fuzzy — candidate limits apply after namespace grouping. Fuzzy fires only after the primary local groups have settled with
 * no ref/name/token hit anywhere among them (the remote group applies the same
 * rule inside its own branch). Hits carry only the two public states
 * (available / needs_approval), never activation or connection substates; the
 * exact registry metadata for a tool lives in `read(tool://...)`. An exact npm
 * ref that the registry explicitly reports as absent is a legitimate no-hit;
 * transport, timeout and other registry failures degrade the remote group. An
 * exact npm ref for an already installed package or for a manifest without the
 * `pi-package` keyword is a warning, never a `needs_approval` installation
 * request. Discovery never installs, enables, downloads or executes a capability.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PI_PACKAGE_KEYWORD, packageNameFromSource } from "./capability-marketplace.mjs";

export const CAPABILITY_TOOL_NAME = "capability";

export const CAPABILITY_TOOL_DESCRIPTION =
  "Find reusable skills and task guidance alongside tools and MCP capabilities for the current task. " +
  "Uses this conversation; no arguments. Returns relevant refs and availability, including uninstalled package candidates. " +
  "A namespace is one candidate with its tools and shared instructions. " +
  "May activate selected tools already registered in this session, but never installs packages or executes capabilities. " +
  "For Skill discovery, use capability rather than manual filesystem or web searches unless the user explicitly requests those search methods.";

/**
 * Model-visible schema of the public tool. Empty on purpose: the request is the
 * caller's conversation, and search categories, candidate counts and budget
 * controls are fixed harness behavior that must never become model input.
 */
export const CAPABILITY_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});

/** Internal retrieval tool: only the nested capability search agent sees these. */
export const CAPABILITY_SEARCH_TOOL_NAME = "capability_search";

export const CAPABILITY_SEARCH_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({
    query: Object.freeze({
      type: "string",
      minLength: 1,
      description:
        "Keywords for relevant guidance (workflows, rules, preferences, or background) or tools, or a ref from an earlier result " +
        "(tool://read, namespace://subagent, mcp://firefox_devtools, skill://firefox-existing-profile, npm://pkg@1.0.0) " +
        "for an exact lookup.",
    }),
    src: Object.freeze({
      type: "string",
      enum: Object.freeze(["local", "remote", "all"]),
      description:
        "local: session tools, MCP servers and local skills. remote: uninstalled npm marketplace packages, " +
        "returned as installation requests. all: both, local hits first.",
    }),
  }),
  required: Object.freeze(["query", "src"]),
  additionalProperties: false,
});

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const SUBMIT_RESULT_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({
    refs: Object.freeze({
      type: "array",
      items: Object.freeze({ type: "string" }),
      description:
        "Relevant skill/guidance and tool refs from this invocation's capability_search results, most relevant first. Empty when nothing is relevant; " +
        "refs that no search returned are rejected.",
    }),
  }),
  required: Object.freeze(["refs"]),
  additionalProperties: false,
});

/** Deterministic bounds for every result list, body read and remote request. */
export const CAPABILITY_LIMITS = Object.freeze({
  tools: 8, // standalone tools or whole namespaces, not member count
  mcp: 8, // whole MCP groups
  skills: 6,
  remote: 5,
  skillBodies: 6,
  caveats: 12,
  caveatsPerSkill: 4,
  missingCapabilities: 6,
  warnings: 12,
  requestTokens: 128,
  matchTokensPerField: 4,
  bodyMatchTokens: 6,
  descriptionChars: 240,
  caveatChars: 240,
  skillBodyChars: 60_000,
  warningChars: 200,
  remoteTimeoutMs: 10_000,
});

const CAPABILITY_SCHEMES = new Set(["tool", "namespace", "mcp", "skill", "npm"]);
const MCP_NAME_PREFIX = "mcp__";
const DEFAULT_EXPOSURE = "direct";

// v2 ranking: exact ref, identifier/name, token+prefix, single-edit fuzzy last.
const MATCH_RANK = Object.freeze({ ref: 0, name: 1, token: 2, fuzzy: 3 });
const NAME_BONUS = 6;
const REF_SCORE = 1000;
const BODY_TOKEN_WEIGHT = 2;
const PREFIX_DISCOUNT = 0.5;
const FUZZY_SCORE = 1;
const MIN_PREFIX_TOKEN = 4;
const MIN_FUZZY_TOKEN = 4;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "that", "this", "these", "those", "use", "using", "used", "need",
  "needs", "want", "wants", "please", "how", "can", "could", "should", "would", "to", "of", "in", "on", "at", "by",
  "from", "it", "its", "is", "are", "be", "my", "me", "i", "you", "your", "we", "our", "do", "does", "make", "get",
  "have", "has", "was", "were", "will", "when", "where", "which", "what", "who", "why", "if", "then", "than", "so",
  "not", "no", "into", "out", "up", "about", "over", "after", "before",
]);

// High-frequency Chinese bigrams carry no capability signal; keeping them out of
// the recall pass keeps skill candidates (and their body reads) honest.
const CJK_STOP_BIGRAMS = new Set([
  "使用", "一个", "我们", "你们", "他们", "已有", "当前", "完成", "操作", "需要", "可以", "如何", "进行", "以及",
  "或者", "但是", "这个", "那个", "什么", "怎么", "我的", "你的", "然后", "之后", "如果", "因为", "所以", "已经",
]);

// Ordered most specific first: the first cue family a sentence matches decides
// its kind, and "note" is the fallback for an anchored sentence with no cue.
const CAVEAT_CUES = [
  {
    kind: "prohibition",
    cues: [
      "must not", "must never", "never ", "do not", "don't ", "cannot", "can not", "avoid ", "not allowed",
      "禁止", "不得", "不可", "不要", "严禁", "切勿",
    ],
  },
  {
    kind: "precondition",
    cues: [
      "must first", "before using", "before you", "before running", "requires ", "require ", "only if", "prerequisite",
      "must be started", "必须先", "需要先", "先", "前置", "前提",
    ],
  },
  {
    kind: "verification",
    cues: ["verify", "confirm", "ensure ", "check that", "验证", "确认", "复核"],
  },
  {
    kind: "workaround",
    cues: ["workaround", "instead", "fallback", "规避", "变通", "替代方案", "绕开"],
  },
  {
    kind: "procedure",
    cues: ["then ", "first, ", "first ", "step", "followed by", "流程", "步骤", "然后", "接着"],
  },
];

const SILENT_CUES = [
  "silently", "silent ", "no error", "without error", "without warning", "no warning", "does not report",
  "won't report", "静默", "无声", "不报错", "不会报错", "不会提示", "不会警告",
];

// A negated expected effect ("will not migrate cookies") breaks callers without
// raising anything, which is exactly the silent-failure class the broker must
// rank first. Kept deliberately narrow: effect verbs only, not any negation.
const OMITTED_EFFECT =
  /(does not|doesn't|will not|won't|不会|无法|不能)[^.;!?。！？；]{0,24}(migrat|persist|reus|carry|apply|sync|preserve|migrate|restore|保留|迁移|复制|同步|生效|携带|沿用|恢复)/;

const SELF_DESCRIBING_CUES = ["error message", "error explains", "self-describing", "会明确报错", "错误信息", "报错信息"];

const CAVEAT_KIND_RANK = { prohibition: 0, precondition: 1, procedure: 2, verification: 3, workaround: 4, note: 5 };

class BranchTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "BranchTimeoutError";
  }
}

function defer(search) {
  // Starting each branch body in a microtask keeps a synchronous provider throw
  // inside that branch's own rejection instead of escaping the search.
  return Promise.resolve().then(search);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorMessage(error, limits) {
  const text = error instanceof Error ? error.message : String(error);
  return truncate(text, limits.warningChars);
}

function truncate(text, max) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function collapse(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error("capability operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

/**
 * The npm marketplace helper marks an explicit "no such package or version"
 * answer with NpmNotFoundError (name/code/status). Only that failure is a
 * legitimate no-hit for an exact npm ref; transport, timeout and other registry
 * failures must degrade the remote source group instead.
 */
function isNotFoundError(error) {
  if (error === null || typeof error !== "object") return false;
  return (
    error.name === "NpmNotFoundError" ||
    error.code === "NPM_NOT_FOUND" ||
    error.status === 404 ||
    error.statusCode === 404
  );
}

/**
 * Finite, cancellable wrapper for a provider call: rejects with
 * BranchTimeoutError at `timeoutMs` even when the provider ignores signals, and
 * applies the caller's abort to the provider through a combined signal.
 */
function runBounded(task, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new BranchTimeoutError(timeoutMs)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const onAbort = () => finish(reject, abortError(signal.reason));
    if (signal) {
      if (signal.aborted) {
        finish(reject, abortError(signal.reason));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const taskSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    Promise.resolve()
      .then(() => task(taskSignal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function isCjkToken(token) {
  return token.length > 0 && token.charCodeAt(0) >= 0x4e00;
}

/** Latin words plus overlapping Han bigrams; the only tokenizer in this module. */
function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const tokens = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/gu)) {
    const run = match[0];
    if (run.charCodeAt(0) < 0x4e00) {
      if (run.length >= 2 && !STOP_WORDS.has(run)) tokens.push(run);
      continue;
    }
    if (run.length < 2) continue;
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!CJK_STOP_BIGRAMS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

/** Distinct query tokens, bounded so a huge query cannot blow up scoring. */
function requestTokens(query, limits) {
  return [...new Set(tokenize(query))].slice(0, limits.requestTokens);
}

function prefixSet(fieldTokens) {
  const prefixes = new Set();
  for (const token of fieldTokens) {
    for (let length = MIN_PREFIX_TOKEN; length < token.length; length += 1) {
      prefixes.add(token.slice(0, length));
    }
  }
  return prefixes;
}

/**
 * Field-weighted token recall. Exact token equality counts once; a query token
 * that is a prefix of a field token (devtool -> devtools) counts at half weight,
 * so an exact hit always outranks a prefix hit.
 */
function scoreFields(fields, tokens, limits) {
  let score = 0;
  const labels = [];
  const matchedTokens = new Set();
  for (const field of fields) {
    if (typeof field.text !== "string" || field.text.length === 0) continue;
    const fieldTokens = tokenSet(field.text);
    if (fieldTokens.size === 0) continue;
    let prefixes = null;
    let exact = 0;
    let prefix = 0;
    let counted = 0;
    for (const token of tokens) {
      if (counted >= limits.matchTokensPerField) break;
      if (fieldTokens.has(token)) {
        exact += 1;
        counted += 1;
        matchedTokens.add(token);
        continue;
      }
      if (token.length < MIN_PREFIX_TOKEN) continue;
      prefixes ??= prefixSet(fieldTokens);
      if (prefixes.has(token)) {
        prefix += 1;
        counted += 1;
        matchedTokens.add(token);
      }
    }
    if (exact + prefix === 0) continue;
    score += exact * field.weight + prefix * field.weight * PREFIX_DISCOUNT;
    labels.push(field.label);
  }
  return { score, labels, tokens: matchedTokens };
}

function identifierPattern(identifier) {
  const escaped = identifier
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[-_ ]+/g, "[-_ ]+");
  if (escaped.length === 0) return null;
  // `_` counts as an identifier character, so `read` never binds through
  // `read_file`, while `firefox_devtools` and `firefox-devtools` are the same
  // identifier.
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "i");
}

function matchesIdentifier(text, identifier) {
  if (typeof identifier !== "string" || identifier.trim().length < 3) return false;
  const pattern = identifierPattern(identifier);
  return pattern !== null && pattern.test(text);
}

/** Identifier/name tier: the query names the capability, or spells it out. */
function nameIdentifierMatch(query, identifier) {
  if (typeof identifier !== "string" || identifier.trim().length < 3) return false;
  if (query.trim().toLowerCase() === identifier.trim().toLowerCase()) return true;
  return matchesIdentifier(query, identifier);
}

function withinOneEdit(left, right) {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (longer.length - shorter.length > 1) return false;
  let edits = 0;
  let shortIndex = 0;
  let longIndex = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shorter.length === longer.length) {
      shortIndex += 1;
      longIndex += 1;
    } else {
      longIndex += 1;
    }
  }
  return true;
}

function fuzzyEvidence(tokens, fields, limit) {
  const matched = new Set();
  const labels = [];
  for (const field of fields) {
    if (typeof field.text !== "string" || field.text.length === 0) continue;
    const fieldTokens = [...tokenSet(field.text)].filter((token) => token.length >= MIN_FUZZY_TOKEN);
    if (fieldTokens.length === 0) continue;
    let count = 0;
    for (const token of tokens) {
      if (token.length < MIN_FUZZY_TOKEN || isCjkToken(token) || matched.has(token)) continue;
      if (!fieldTokens.some((fieldToken) => withinOneEdit(token, fieldToken))) continue;
      matched.add(token);
      count += 1;
      if (count >= limit) break;
    }
    if (count > 0) labels.push(field.label);
  }
  return { count: matched.size, labels, tokens: matched };
}

/**
 * Exact ref, identifier/name and token+prefix tiers for one candidate.
 * Returns null when the candidate does not match at these tiers; the caller may
 * then try the single-edit fuzzy fallback, but only while the whole source group
 * has no better match.
 */
function classifyCandidate(candidate, context, limits) {
  const scored = scoreFields(candidate.fields, context.tokens, limits);
  if (candidate.identifiers.some((identifier) => nameIdentifierMatch(context.query, identifier))) {
    return {
      match: "name",
      score: scored.score + NAME_BONUS,
      labels: [...new Set(["name", ...scored.labels])],
      tokens: scored.tokens,
    };
  }
  if (scored.score > 0) return { match: "token", score: scored.score, labels: scored.labels, tokens: scored.tokens };
  return null;
}

function classifyFuzzy(candidate, context, limits) {
  const fields = candidate.fuzzyFields ?? candidate.fields;
  const { count, labels, tokens } = fuzzyEvidence(context.tokens, fields, limits.matchTokensPerField);
  if (count === 0) return null;
  return { match: "fuzzy", score: count * FUZZY_SCORE, labels, tokens };
}

function compareHits(left, right) {
  const rank = (MATCH_RANK[left.match] ?? MATCH_RANK.fuzzy) - (MATCH_RANK[right.match] ?? MATCH_RANK.fuzzy);
  if (rank !== 0) return rank;
  if (right.score !== left.score) return right.score - left.score;
  return compareStrings(left.ref, right.ref);
}

function toolRef(name) {
  return `tool://${encodeURIComponent(name)}`;
}

function mcpServerRef(server) {
  return `mcp://${encodeURIComponent(server)}`;
}

function mcpRef(server, tool) {
  return tool === undefined || tool === null || tool === ""
    ? mcpServerRef(server)
    : `${mcpServerRef(server)}/${encodeURIComponent(tool)}`;
}

function packageRef(name, version) {
  return `npm://${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`malformed percent-encoding in ref segment "${value}"`);
  }
}

function parseCapabilityRef(ref) {
  const text = typeof ref === "string" ? ref.trim() : "";
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (match === null) {
    throw new Error(`capability ref must be a URI like tool://read, got ${JSON.stringify(text)}`);
  }
  const scheme = match[1].toLowerCase();
  if (!CAPABILITY_SCHEMES.has(scheme)) throw new Error(`unsupported capability protocol "${scheme}://"`);
  if (match[2].length === 0) throw new Error(`capability ref "${text}" names no resource`);
  return { scheme, rest: match[2] };
}

/** A ref-shaped query is an exact-lookup intent for its scheme's branch. */
function parseQueryRef(query) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(query);
  if (match === null) return null;
  const scheme = match[1].toLowerCase();
  if (!CAPABILITY_SCHEMES.has(scheme)) return null;
  return { scheme, rest: match[2] };
}

function parameterText(parameters, depth = 0) {
  if (parameters === null || typeof parameters !== "object" || depth > 3) return "";
  const parts = [];
  const properties = parameters.properties;
  if (properties !== null && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) {
      parts.push(key);
      if (value === null || typeof value !== "object") continue;
      if (typeof value.description === "string") parts.push(value.description);
      const nested = parameterText({ properties: value.properties, items: value.items }, depth + 1);
      if (nested.length > 0) parts.push(nested);
    }
  }
  if (parameters.items !== null && typeof parameters.items === "object") {
    const nested = parameterText(parameters.items, depth + 1);
    if (nested.length > 0) parts.push(nested);
  }
  return parts.join(" ");
}

function normalizeToolInfo(entry, activeNames) {
  if (entry === null || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name.length === 0) return null;
  const exposure = typeof entry.exposure === "string" && entry.exposure.length > 0 ? entry.exposure : DEFAULT_EXPOSURE;
  // Pi ToolExposure "hidden" means registered but unreachable (a withdrawn or
  // disabled tool); it must never be discovered or read.
  if (exposure === "hidden") return null;
  const sourceInfo = entry.sourceInfo !== null && typeof entry.sourceInfo === "object" ? entry.sourceInfo : {};
  const namespace = entry.namespace !== null && typeof entry.namespace === "object" ? entry.namespace : {};
  const namespaceName = typeof namespace.name === "string" ? namespace.name : "";
  const tool = {
    name,
    exposure,
    description: typeof entry.description === "string" ? entry.description : "",
    promptGuidelines: ensureArray(entry.promptGuidelines).filter((line) => typeof line === "string" && line.length > 0),
    parameters: entry.parameters !== null && typeof entry.parameters === "object" ? entry.parameters : {},
    parametersText: parameterText(entry.parameters),
    source: typeof sourceInfo.source === "string" ? sourceInfo.source : "unknown",
    path: typeof sourceInfo.path === "string" ? sourceInfo.path : "",
    scope: typeof sourceInfo.scope === "string" ? sourceInfo.scope : "",
    origin: typeof sourceInfo.origin === "string" ? sourceInfo.origin : "",
    namespaceName,
    namespaceServer: namespaceName.startsWith(MCP_NAME_PREFIX) ? namespaceName.slice(MCP_NAME_PREFIX.length) : "",
    namespaceDescription: typeof namespace.description === "string" ? namespace.description : "",
    namespaceInstructions: typeof namespace.instructions === "string" ? namespace.instructions : "",
    active: activeNames.has(name),
    isMcp: false,
    mcpIdentity: null,
  };
  tool.isMcp =
    tool.source === "mcp" ||
    /^mcp:/.test(tool.path) ||
    /^<mcp:/i.test(tool.path) ||
    tool.namespaceServer.length > 0 ||
    tool.name.startsWith(MCP_NAME_PREFIX);
  if (tool.isMcp) tool.mcpIdentity = parseMcpIdentity(tool);
  return tool;
}

/**
 * Split a minted MCP tool name. The harness registers `mcp__<server>__<tool>`
 * with both halves sanitized; the doubled separator wins when present because it
 * carries the boundary the single-underscore form loses.
 */
function parseMcpToolName(name) {
  if (typeof name !== "string" || !name.startsWith(MCP_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  if (rest.length === 0) return null;
  const double = rest.indexOf("__");
  if (double > 0 && double + 2 < rest.length) {
    return { server: rest.slice(0, double), tool: rest.slice(double + 2) };
  }
  const single = rest.indexOf("_");
  if (single === -1) return { server: rest, tool: undefined };
  const tool = rest.slice(single + 1);
  return { server: rest.slice(0, single), tool: tool.length > 0 ? tool : undefined };
}

/**
 * Best-effort server/tool identity: explicit source path (carries the original
 * server name), then the tool namespace (`mcp__<server>`, sanitized like the
 * harness does), then the minted tool name.
 */
function parseMcpIdentity(tool) {
  const path = tool.path.trim();
  const explicit = /^mcp:([^/]+)(?:\/(.+))?$/.exec(path);
  if (explicit !== null) {
    const server = explicit[1].trim();
    const toolName = explicit[2] !== undefined ? explicit[2].trim() : "";
    if (server.length > 0) return { server, tool: toolName.length > 0 ? toolName : undefined, basis: "source path" };
  }
  const bracketed = /^<mcp:(.+)>$/i.exec(path);
  if (bracketed !== null) {
    const inner = bracketed[1].trim();
    if (inner.length > 0 && !inner.startsWith(MCP_NAME_PREFIX)) {
      const slash = inner.indexOf("/");
      if (slash > 0) {
        const toolName = inner.slice(slash + 1).trim();
        return { server: inner.slice(0, slash), tool: toolName.length > 0 ? toolName : undefined, basis: "source path" };
      }
      return { server: inner, tool: undefined, basis: "source path" };
    }
    const fromPathName = parseMcpToolName(inner.length > 0 ? inner : tool.name);
    if (fromPathName !== null) return { ...fromPathName, basis: "source path" };
  }
  if (tool.namespaceServer.length > 0) {
    const fromName = parseMcpToolName(tool.name);
    const toolName = fromName !== null && fromName.server === tool.namespaceServer ? fromName.tool : undefined;
    return { server: tool.namespaceServer, tool: toolName, basis: "namespace" };
  }
  const fromName = parseMcpToolName(tool.name);
  if (fromName !== null) return { ...fromName, basis: "tool name" };
  return null;
}

async function snapshotRegistry(providers) {
  if (typeof providers.listTools !== "function") throw new Error("listTools provider is not configured");
  if (typeof providers.listActiveTools !== "function") throw new Error("listActiveTools provider is not configured");
  const [registry, activeNames] = await Promise.all([
    Promise.resolve(providers.listTools()),
    Promise.resolve(providers.listActiveTools()),
  ]);
  const active = new Set(ensureArray(activeNames).map((name) => String(name)));
  const tools = [];
  for (const entry of ensureArray(registry)) {
    const tool = normalizeToolInfo(entry, active);
    if (tool !== null) tools.push(tool);
  }
  return { tools, active };
}

function normalizeSkill(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name.length === 0) return null;
  // Skills marked disable-model-invocation are excluded from the model prompt by
  // Pi itself; they are not discoverable here either.
  if (entry.disableModelInvocation === true) return null;
  const filePath = typeof entry.filePath === "string" && entry.filePath.length > 0
    ? entry.filePath
    : typeof entry.path === "string"
      ? entry.path
      : "";
  return {
    name,
    description: typeof entry.description === "string" ? entry.description : "",
    filePath,
    source: typeof entry.source === "string" ? entry.source : "",
  };
}

/** Normalize native `loadSkills` output, the legacy `{ skills, warnings }` shape, or a bare array. */
function normalizeSkills(discovered) {
  const list = Array.isArray(discovered) ? discovered : ensureArray(discovered?.skills);
  return list.map(normalizeSkill).filter((skill) => skill !== null);
}

function normalizeSkillWarnings(discovered, limits) {
  if (Array.isArray(discovered)) return [];
  const warnings = [];
  for (const diagnostic of ensureArray(discovered?.diagnostics)) {
    if (diagnostic === null || typeof diagnostic !== "object") continue;
    const message = typeof diagnostic.message === "string" ? diagnostic.message : String(diagnostic.message ?? "");
    if (message.length === 0) continue;
    const type = typeof diagnostic.type === "string" && diagnostic.type.length > 0 ? diagnostic.type : "warning";
    const path = typeof diagnostic.path === "string" && diagnostic.path.length > 0 ? ` (${diagnostic.path})` : "";
    warnings.push(truncate(`skill discovery ${type}: ${message}${path}`, limits.warningChars));
  }
  for (const warning of ensureArray(discovered?.warnings)) {
    if (warning === null || typeof warning !== "object") continue;
    const message = typeof warning.message === "string" ? warning.message : String(warning.message ?? "");
    if (message.length === 0) continue;
    const skillPath = typeof warning.skillPath === "string" && warning.skillPath.length > 0 ? ` (${warning.skillPath})` : "";
    warnings.push(truncate(`skill discovery warning: ${message}${skillPath}`, limits.warningChars));
  }
  return warnings;
}

async function snapshotSkills(providers, cwd, limits) {
  if (typeof providers.discoverSkills !== "function") throw new Error("discoverSkills provider is not configured");
  const discovered = await providers.discoverSkills(cwd);
  return { skills: normalizeSkills(discovered), warnings: normalizeSkillWarnings(discovered, limits) };
}

async function readSkillText(skill, readSkillFile, limits) {
  if (typeof skill.filePath !== "string" || skill.filePath.length === 0) {
    throw new Error(`skill "${skill.name}" has no file path`);
  }
  const text = await readSkillFile(skill.filePath);
  if (typeof text !== "string") throw new Error(`skill "${skill.name}" reader returned no text`);
  return text.slice(0, limits.skillBodyChars);
}

function buildToolHit(tool, classified, limits) {
  return {
    ref: toolRef(tool.name),
    name: tool.name,
    description: truncate(tool.description, limits.descriptionChars),
    kind: "tool",
    status: "available",
    match: classified.match,
    score: classified.score,
    source: tool.source,
    path: tool.path,
    exposure: tool.exposure,
    reason: `matched ${classified.labels.length > 0 ? classified.labels.join(", ") : "query"}`,
  };
}

function memberSummary(tool, limits) {
  return {
    ref: tool.mcpIdentity ? mcpRef(tool.mcpIdentity.server, tool.mcpIdentity.tool) : toolRef(tool.name),
    name: tool.name,
    ...(tool.mcpIdentity?.tool ? { tool: tool.mcpIdentity.tool } : {}),
    description: truncate(tool.description, limits.descriptionChars),
    exposure: tool.exposure,
  };
}

function buildNamespaceHit(name, group, classified, limits) {
  return {
    ref: `namespace://${encodeURIComponent(name)}`,
    name,
    namespace: name,
    kind: "namespace",
    description: truncate(group.find((tool) => tool.namespaceDescription)?.namespaceDescription ?? "", limits.descriptionChars),
    instructions: group.find((tool) => tool.namespaceInstructions)?.namespaceInstructions ?? "",
    status: "available",
    match: classified.match,
    score: classified.score,
    reason: classified.reason ?? `matched ${classified.labels.join(", ")}`,
    toolCount: group.length,
    tools: group.map((tool) => memberSummary(tool, limits)),
  };
}

/** Collapse matching members before applying the candidate limit. */
function groupToolHits(hits, registry, limits) {
  const groups = new Map();
  const toolsByName = new Map(registry.tools.map((tool) => [tool.name, tool]));
  for (const tool of registry.tools) {
    const name = tool.namespaceServer ? "" : tool.namespaceName;
    if (!name) continue;
    const group = groups.get(name) ?? [];
    group.push(tool);
    groups.set(name, group);
  }
  const best = new Map();
  for (const hit of hits) {
    const name = hit.kind === "namespace" ? hit.namespace : toolsByName.get(hit.name)?.namespaceName;
    const key = name ? `namespace://${encodeURIComponent(name)}` : hit.ref;
    const previous = best.get(key);
    if (!previous || compareHits(hit, previous.hit) < 0) best.set(key, { hit, name });
  }
  return [...best.values()].map(({ hit, name }) => {
    if (!name) return hit;
    const classified = { match: hit.match, score: hit.score, labels: [], reason: hit.reason };
    return buildNamespaceHit(name, groups.get(name), classified, limits);
  }).sort(compareHits);
}

async function searchToolHits(registryPromise, context, limits) {
  const registry = await registryPromise;
  const covered = new Set();
  const hits = [];

  if (context.ref !== null && context.ref.scheme === "namespace") {
    const name = decodePart(context.ref.rest);
    const group = registry.tools.filter((tool) => !tool.namespaceServer && tool.namespaceName === name);
    if (group.length === 0) return { hits, fuzzy: [], covered, warnings: registry.tools.some((tool) => tool.namespaceName === name) ? [] : [`namespace "${name}" did not resolve`] };
    hits.push(buildNamespaceHit(name, group, { match: "ref", score: REF_SCORE, labels: ["ref"] }, limits));
    return { hits, fuzzy: [], covered, warnings: [] };
  }

  if (context.ref !== null && context.ref.scheme === "tool") {
    const warnings = [];
    let name = null;
    try {
      name = decodePart(context.ref.rest);
    } catch (error) {
      warnings.push(`tool ref lookup failed: ${errorMessage(error, limits)}`);
      return { hits, fuzzy: [], covered, warnings };
    }
    const tool = registry.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      warnings.push(`ref "${context.query}" did not resolve to a visible tool`);
      return { hits, fuzzy: [], covered, warnings };
    }
    // A tool with a parseable MCP identity is addressed by its mcp:// ref; the
    // tool:// alias would give one capability two identities.
    if (tool.mcpIdentity !== null && (!tool.namespaceName || tool.namespaceServer)) {
      warnings.push(
        `ref "${context.query}" names an MCP tool; MCP tools are addressed by their mcp://<server>/<tool> ref`,
      );
      return { hits, fuzzy: [], covered, warnings };
    }
    hits.push(buildToolHit(tool, { match: "ref", score: REF_SCORE, labels: ["ref"], tokens: new Set() }, limits));
    return { hits: groupToolHits(hits, registry, limits), fuzzy: [], covered, warnings };
  }

  const matched = [];
  const fuzzy = [];
  for (const tool of registry.tools) {
    // One capability, one identity: a tool whose server and tool halves are
    // parseable is reported by the MCP branch under its mcp:// ref only.
    // MCP-sourced tools without a parseable identity keep this fallback.
    if (tool.mcpIdentity !== null && (!tool.namespaceName || tool.namespaceServer)) continue;
    const candidate = {
      fields: [
        { label: "name", weight: 5, text: tool.name },
        { label: "description", weight: 2, text: tool.description },
        { label: "namespace", weight: 5, text: tool.namespaceName },
        { label: "namespace description", weight: 2, text: tool.namespaceDescription },
        { label: "instructions", weight: 2, text: tool.namespaceInstructions },
        { label: "parameters", weight: 2, text: tool.parametersText },
        { label: "source", weight: 1, text: `${tool.source} ${tool.path} ${tool.namespaceName}` },
      ],
      identifiers: [tool.name, tool.namespaceName].filter(Boolean),
      fuzzyFields: [
        { label: "name", weight: 5, text: tool.name },
        { label: "namespace", weight: 5, text: tool.namespaceName },
        { label: "description", weight: 2, text: `${tool.description} ${tool.namespaceDescription}` },
      ],
    };
    const classified = classifyCandidate(candidate, context, limits);
    if (classified !== null) matched.push({ tool, classified });
    else fuzzy.push({ kind: "tool", tool, candidate });
  }

  for (const { tool, classified } of matched) {
    for (const token of classified.tokens) covered.add(token);
    hits.push(buildToolHit(tool, classified, limits));
  }
  return { hits: groupToolHits(hits, registry, limits).slice(0, limits.tools), fuzzy, covered, warnings: [], registry };
}

function mcpIdentifiers(hit) {
  const identifiers = [];
  if (typeof hit.server === "string" && hit.server.length > 0) {
    identifiers.push(hit.server, `mcp:${hit.server}`, mcpServerRef(hit.server));
  }
  if (typeof hit.name === "string" && hit.kind === "mcp" && hit.name !== hit.server) identifiers.push(hit.name);
  if (typeof hit.tool === "string" && hit.tool.length > 0) {
    identifiers.push(
      hit.tool,
      `${hit.server}/${hit.tool}`,
      `mcp:${hit.server}/${hit.tool}`,
      mcpRef(hit.server, hit.tool),
    );
    const segments = hit.tool.split("_");
    for (let start = 1; start < segments.length - 1; start += 1) {
      identifiers.push(segments.slice(start).join("_"));
    }
  }
  return identifiers.filter((identifier) => typeof identifier === "string" && identifier.length >= 3);
}


function buildMcpServerHit(server, group, classified, limits) {
  const description = group.find((tool) => tool.namespaceDescription.length > 0)?.namespaceDescription ?? "";
  return {
    ref: group[0].namespaceName ? `namespace://${encodeURIComponent(group[0].namespaceName)}` : mcpServerRef(server),
    name: group[0].namespaceName || server,
    description: truncate(
      description.length > 0 ? description : `MCP server with ${group.length} registered tool(s)`,
      limits.descriptionChars,
    ),
    kind: "mcp",
    status: "available",
    match: classified.match,
    score: classified.score,
    server,
    ...(group[0].namespaceName ? { namespace: group[0].namespaceName } : {}),
    instructions: group.find((tool) => tool.namespaceInstructions)?.namespaceInstructions ?? "",
    toolCount: group.length,
    tools: group.map((tool) => memberSummary(tool, limits)),
    reason: `matched ${classified.labels.length > 0 ? classified.labels.join(", ") : "query"}`,
  };
}

async function searchMcpHits(registryPromise, context, limits) {
  const registry = await registryPromise;
  const warnings = [];
  const covered = new Set();
  const hits = [];
  const groups = new Map();
  for (const tool of registry.tools) {
    if (!tool.isMcp || (tool.namespaceName && !tool.namespaceServer)) continue;
    if (tool.mcpIdentity === null) {
      warnings.push(`mcp tool "${tool.name}" exposes no parseable server identity`);
      continue;
    }
    const key = tool.namespaceName ? `namespace://${tool.namespaceName}` : mcpServerRef(tool.mcpIdentity.server);
    const group = groups.get(key) ?? [];
    group.push(tool);
    groups.set(key, group);
  }

  if (context.ref?.scheme === "namespace") {
    const name = decodePart(context.ref.rest);
    const group = [...groups.values()].find((members) => members[0].namespaceName === name);
    if (group) hits.push(buildMcpServerHit(group[0].mcpIdentity.server, group, { match: "ref", score: REF_SCORE, labels: ["ref"] }, limits));
    return { hits, fuzzy: [], covered, warnings };
  }

  if (context.ref !== null && context.ref.scheme === "mcp") {
    let server, toolName;
    try {
      const slash = context.ref.rest.indexOf("/");
      server = decodePart(slash === -1 ? context.ref.rest : context.ref.rest.slice(0, slash));
      if (slash !== -1 && context.ref.rest.slice(slash + 1)) toolName = decodePart(context.ref.rest.slice(slash + 1));
    } catch (error) {
      warnings.push(`mcp ref lookup failed: ${errorMessage(error, limits)}`);
      return { hits, fuzzy: [], covered, warnings };
    }
    const matches = [...groups.values()].filter((group) => group.some((tool) => tool.mcpIdentity.server === server &&
      (toolName === undefined || tool.mcpIdentity.tool === toolName || tool.name === toolName)));
    if (matches.length === 0) warnings.push(`ref "${context.query}" did not resolve to a visible MCP ${toolName === undefined ? "server" : "tool"}`);
    for (const group of matches) hits.push(buildMcpServerHit(group[0].mcpIdentity.server, group, { match: "ref", score: REF_SCORE, labels: ["ref"] }, limits));
    return { hits, fuzzy: [], covered, warnings };
  }

  const fuzzy = [];
  for (const group of groups.values()) {
    const server = group[0].mcpIdentity.server;
    const names = [group[0].namespaceName, ...group.flatMap((tool) => [tool.mcpIdentity.server, tool.name, tool.mcpIdentity.tool])].filter(Boolean);
    const description = group.map((tool) => `${tool.description} ${tool.namespaceDescription}`).join(" ");
    const candidate = {
      fields: [
        { label: "server name", weight: 5, text: server },
        { label: "tool name", weight: 5, text: names.join(" ") },
        { label: "description", weight: 2, text: description },
        { label: "instructions", weight: 2, text: group.find((tool) => tool.namespaceInstructions)?.namespaceInstructions ?? "" },
        { label: "source", weight: 1, text: group.map((tool) => tool.path).join(" ") },
      ],
      identifiers: [...names, ...group.map((tool) => `${server}/${tool.mcpIdentity.tool ?? ""}`)],
      fuzzyFields: [
        { label: "server name", weight: 5, text: server },
        { label: "tool name", weight: 5, text: names.join(" ") },
        { label: "description", weight: 2, text: description },
      ],
    };
    const classified = classifyCandidate(candidate, context, limits);
    if (classified === null) {
      fuzzy.push({ server, group, candidate });
      continue;
    }
    for (const token of classified.tokens) covered.add(token);
    hits.push({ ...buildMcpServerHit(server, group, classified, limits), reason: `matched ${classified.labels.join(", ")}; server from ${group[0].mcpIdentity.basis}` });
  }
  hits.sort(compareHits);
  return { hits: hits.slice(0, limits.mcp), fuzzy, covered, warnings };
}

function buildSkillHit(skill, classified, body, limits, exact) {
  return {
    ref: `skill://${encodeURIComponent(skill.name)}`,
    name: skill.name,
    description: truncate(skill.description, limits.descriptionChars),
    kind: "skill",
    status: "available",
    match: classified.match,
    score: classified.score,
    filePath: skill.filePath,
    reason: `matched ${classified.labels.length > 0 ? classified.labels.join(", ") : "query"}`,
    ...(exact && body !== null ? { body } : {}),
  };
}

async function searchSkillHits(skillsPromise, providers, context, limits, signal, readSkillFile) {
  const snapshot = await skillsPromise;
  const warnings = [...snapshot.warnings];
  const covered = new Set();
  const bodies = new Map();
  const hits = [];

  if (context.ref !== null && context.ref.scheme === "skill") {
    let name = null;
    try {
      name = decodePart(context.ref.rest);
    } catch (error) {
      warnings.push(`skill ref lookup failed: ${errorMessage(error, limits)}`);
      return { hits, fuzzy: [], bodies, covered, warnings };
    }
    const skill = snapshot.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      warnings.push(`ref "${context.query}" did not resolve to a visible skill`);
      return { hits, fuzzy: [], bodies, covered, warnings };
    }
    const ref = `skill://${encodeURIComponent(skill.name)}`;
    let body = null;
    try {
      body = await readSkillText(skill, readSkillFile, limits);
      bodies.set(ref, body);
    } catch (error) {
      // The skill still resolves (name/description are metadata); the failure is
      // reported instead of silently dropping the body.
      warnings.push(`skill "${skill.name}" body unreadable: ${errorMessage(error, limits)}`);
    }
    hits.push(buildSkillHit(skill, { match: "ref", score: REF_SCORE, labels: ["ref"], tokens: new Set() }, body, limits, true));
    return { hits, fuzzy: [], bodies, covered, warnings };
  }

  const candidates = [];
  const fuzzy = [];
  for (const skill of snapshot.skills) {
    const candidate = {
      fields: [
        { label: "name", weight: 5, text: skill.name },
        { label: "description", weight: 3, text: skill.description },
      ],
      identifiers: [skill.name],
      fuzzyFields: [
        { label: "name", weight: 5, text: skill.name },
        { label: "description", weight: 3, text: skill.description },
      ],
    };
    const classified = classifyCandidate(candidate, context, limits);
    if (classified !== null) candidates.push({ skill, classified });
    else fuzzy.push({ kind: "skill", skill, candidate });
  }

  candidates.sort(
    (left, right) => right.classified.score - left.classified.score || compareStrings(left.skill.name, right.skill.name),
  );
  // Second phase: read the body of the bounded candidate set and score it, so
  // constraints that live only in the body still reach the result.
  for (const candidate of candidates.slice(0, limits.skillBodies)) {
    if (signal?.aborted) throw abortError(signal.reason);
    const ref = `skill://${encodeURIComponent(candidate.skill.name)}`;
    let body = null;
    try {
      body = await readSkillText(candidate.skill, readSkillFile, limits);
      bodies.set(ref, body);
    } catch (error) {
      warnings.push(`skill "${candidate.skill.name}" body unreadable: ${errorMessage(error, limits)}`);
    }
    const bodyMatch = body === null ? { count: 0, tokens: [] } : matchBodyTokens(context.tokens, body, limits);
    for (const token of bodyMatch.tokens) covered.add(token);
    for (const token of candidate.classified.tokens) covered.add(token);
    const classified = {
      ...candidate.classified,
      score: candidate.classified.score + bodyMatch.count * BODY_TOKEN_WEIGHT,
      labels: bodyMatch.count > 0 ? [...candidate.classified.labels, "body"] : candidate.classified.labels,
    };
    hits.push(buildSkillHit(candidate.skill, classified, body, limits, false));
  }

  hits.sort(compareHits);
  return { hits: hits.slice(0, limits.skills), fuzzy, bodies, covered, warnings };
}

function matchBodyTokens(tokens, body, limits) {
  const fieldTokens = tokenSet(body);
  const matched = [];
  for (const token of tokens) {
    if (!fieldTokens.has(token)) continue;
    matched.push(token);
    if (matched.length >= limits.bodyMatchTokens) break;
  }
  return { count: matched.length, tokens: matched };
}

function normalizeRemoteCandidates(value) {
  if (Array.isArray(value)) return { candidates: value, warnings: [] };
  if (value !== null && typeof value === "object") {
    return {
      candidates: ensureArray(value.candidates),
      warnings: ensureArray(value.warnings).filter((warning) => typeof warning === "string" && warning.length > 0),
    };
  }
  return { candidates: [], warnings: [] };
}

function remoteFields(candidate) {
  return [
    { label: "name", weight: 5, text: typeof candidate.name === "string" ? candidate.name : "" },
    { label: "description", weight: 2, text: typeof candidate.description === "string" ? candidate.description : "" },
    {
      label: "keywords",
      weight: 2,
      text: ensureArray(candidate.keywords).filter((keyword) => typeof keyword === "string").join(" "),
    },
  ];
}

function remoteIdentifiers(candidate) {
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return [name, unscoped].filter((identifier) => identifier.length > 0);
}

function buildRemoteHit(candidate, classified, source, limits) {
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const version = typeof candidate.version === "string" ? candidate.version : "";
  if (name.length === 0 || version.length === 0) return null;
  return {
    ref: packageRef(name, version),
    name,
    description: truncate(candidate.description, limits.descriptionChars),
    kind: "package",
    status: "needs_approval",
    match: classified.match,
    score: classified.score,
    source: typeof candidate.source === "string" && candidate.source.length > 0 ? candidate.source : source,
    version,
    ...(typeof candidate.publisher === "string" && candidate.publisher.length > 0 ? { publisher: candidate.publisher } : {}),
    ...(typeof candidate.date === "string" && candidate.date.length > 0 ? { date: candidate.date } : {}),
    ...(candidate.links !== null && typeof candidate.links === "object" ? { links: candidate.links } : {}),
    reason: `matched ${classified.labels.length > 0 ? classified.labels.join(", ") : "query"}; uninstalled npm package`,
  };
}

/**
 * Installed npm package names for the exact-ref check. Keyword searches filter
 * through the marketplace helper; an exact ref bypasses that path, so the same
 * identity check has to run here or an already configured package would come
 * back as an installation request. Fails closed when the source list is not
 * configured, exactly like the keyword path.
 */
async function installedPackageNames(providers) {
  const source = providers.listInstalledPackages;
  if (source === undefined || source === null) {
    throw new Error(
      "installed packages are not configured; refusing to present installed packages as new install requests",
    );
  }
  const listed = typeof source === "function" ? await source() : await source;
  const names = new Set();
  for (const entry of ensureArray(listed)) {
    const name = packageNameFromSource(entry);
    if (name !== null) names.add(name);
  }
  return names;
}

/** Pi packages carry the documented `pi-package` keyword; nothing else is eligible. */
function isPiPackage(metadata) {
  return ensureArray(metadata?.keywords).some(
    (keyword) => typeof keyword === "string" && keyword.trim().toLowerCase() === PI_PACKAGE_KEYWORD,
  );
}

async function searchRemoteHits(providers, context, limits, signal) {
  const warnings = [];
  const covered = new Set();
  const hits = [];

  // An exact npm ref resolves through readRemote alone; only a keyword search
  // needs the registry search endpoint, so the guards differ per path.
  if (context.ref !== null && context.ref.scheme === "npm") {
    if (typeof providers.readRemote !== "function") throw new Error("readRemote provider is not configured");
    let metadata = null;
    try {
      metadata = await runBounded(
        (taskSignal) => Promise.resolve(providers.readRemote(context.query, { signal: taskSignal })),
        { signal, timeoutMs: limits.remoteTimeoutMs },
      );
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (error instanceof BranchTimeoutError) throw error;
      // Only an explicit not-found from the registry is a legitimate no-hit;
      // transport, timeout and other registry failures degrade the source group.
      if (!isNotFoundError(error)) throw error;
      warnings.push(`remote ref "${context.query}" did not resolve: ${errorMessage(error, limits)}`);
      return { hits, fuzzy: [], covered, warnings };
    }
    const resolved = metadata !== null && typeof metadata === "object" ? metadata : null;
    if (resolved !== null) {
      const installed = await installedPackageNames(providers);
      const name = packageNameFromSource(typeof resolved.name === "string" ? resolved.name : null);
      if (name !== null && installed.has(name)) {
        warnings.push(`remote ref "${context.query}" is already installed; it is not an installation request`);
        return { hits, fuzzy: [], covered, warnings };
      }
      if (!isPiPackage(resolved)) {
        warnings.push(
          `remote ref "${context.query}" is not a Pi package: its manifest does not carry the "${PI_PACKAGE_KEYWORD}" keyword`,
        );
        return { hits, fuzzy: [], covered, warnings };
      }
    }
    const hit = buildRemoteHit(resolved ?? {}, { match: "ref", score: REF_SCORE, labels: ["ref"], tokens: new Set() }, "npm", limits);
    if (hit !== null) hits.push(hit);
    else warnings.push(`remote ref "${context.query}" resolved to metadata without a name and version`);
    return { hits, fuzzy: [], covered, warnings };
  }

  if (typeof providers.searchRemote !== "function") throw new Error("searchRemote provider is not configured");
  const result = normalizeRemoteCandidates(
    await runBounded(
      (taskSignal) => Promise.resolve(providers.searchRemote(context.query, { signal: taskSignal })),
      { signal, timeoutMs: limits.remoteTimeoutMs },
    ),
  );
  warnings.push(...result.warnings);

  const matched = [];
  const unmatched = [];
  for (const candidate of result.candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const classified = classifyCandidate(
      {
        fields: remoteFields(candidate),
        identifiers: remoteIdentifiers(candidate),
        fuzzyFields: [
          { label: "name", weight: 5, text: typeof candidate.name === "string" ? candidate.name : "" },
          { label: "keywords", weight: 2, text: ensureArray(candidate.keywords).join(" ") },
        ],
      },
      context,
      limits,
    );
    if (classified !== null) matched.push({ candidate, classified });
    else unmatched.push(candidate);
  }
  // The remote group applies its own single-edit fallback only when its own
  // primary layer found nothing (and never for a ref-shaped query); the local
  // fuzzy decision belongs to the settled local groups.
  if (matched.length === 0 && context.ref === null) {
    for (const candidate of unmatched) {
      const fuzzy = classifyFuzzy(
        {
          fields: [],
          identifiers: [],
          fuzzyFields: [
            { label: "name", weight: 5, text: typeof candidate.name === "string" ? candidate.name : "" },
            { label: "keywords", weight: 2, text: ensureArray(candidate.keywords).join(" ") },
          ],
        },
        context,
        limits,
      );
      if (fuzzy === null) continue;
      for (const token of fuzzy.tokens) covered.add(token);
      matched.push({ candidate, classified: fuzzy });
    }
  }

  for (const { candidate, classified } of matched) {
    for (const token of classified.tokens) covered.add(token);
    const hit = buildRemoteHit(candidate, classified, "npm", limits);
    if (hit !== null) hits.push(hit);
  }
  hits.sort(compareHits);
  return { hits: hits.slice(0, limits.remote), covered, warnings };
}

function splitSentences(line) {
  return line
    .split(/(?<=[.!?。！？])\s*/u)
    .map((sentence) => collapse(sentence))
    .filter((sentence) => sentence.length >= 8);
}

function classifyCaveat(sentence) {
  const text = sentence.toLowerCase();
  for (const family of CAVEAT_CUES) {
    if (family.cues.some((cue) => text.includes(cue))) return family.kind;
  }
  return "note";
}

function detectFailureVisibility(sentence) {
  const text = sentence.toLowerCase();
  if (SILENT_CUES.some((cue) => text.includes(cue)) || OMITTED_EFFECT.test(text)) return "silent";
  if (SELF_DESCRIBING_CUES.some((cue) => text.includes(cue))) return "self-describing";
  return "unknown";
}

function caveatPriority(caveat) {
  if (caveat.kind === "prohibition" || caveat.kind === "precondition") {
    return caveat.failureVisibility === "silent" ? 0 : 1;
  }
  return CAVEAT_KIND_RANK[caveat.kind] ?? CAVEAT_KIND_RANK.note;
}

function caveatId(caveat) {
  const key = `${caveat.kind}\u0000${caveat.targets.join(",")}\u0000${caveat.summary.toLowerCase()}`;
  return `caveat-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

function extractCaveats({ skill, text, where, anchors, limits }) {
  const found = [];
  let section;
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      section = heading[1].trim();
      continue;
    }
    for (const sentence of splitSentences(line)) {
      const targets = [
        ...new Set(
          anchors
            .filter((anchor) => anchor.identifiers.some((identifier) => matchesIdentifier(sentence, identifier)))
            .map((anchor) => anchor.ref),
        ),
      ].sort(compareStrings);
      if (targets.length === 0) continue;
      found.push({
        kind: classifyCaveat(sentence),
        targets,
        summary: truncate(sentence, limits.caveatChars),
        failureVisibility: detectFailureVisibility(sentence),
        sources: [
          {
            skill: skill.ref,
            filePath: skill.filePath,
            ...(section !== undefined && section.length > 0 ? { section } : {}),
            where,
          },
        ],
      });
      if (found.length >= limits.caveatsPerSkill) return found;
    }
  }
  return found;
}

function mergeCaveats(found, limits) {
  const merged = new Map();
  for (const caveat of found) {
    const id = caveatId(caveat);
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { id, ...caveat });
      continue;
    }
    for (const source of caveat.sources) {
      const duplicate = existing.sources.some(
        (known) =>
          known.skill === source.skill &&
          known.filePath === source.filePath &&
          known.where === source.where &&
          known.section === source.section,
      );
      if (!duplicate) existing.sources.push(source);
    }
  }
  return [...merged.values()]
    .sort((left, right) => caveatPriority(left) - caveatPriority(right) || compareStrings(left.id, right.id))
    .slice(0, limits.caveats);
}

/**
 * Skills are a knowledge layer over executable candidates, so a skill binds only
 * through identifiers its text spells out: tool names, server names, `mcp:` refs
 * or the minted `mcp__<server>__<tool>` spelling.
 */
function bindAndExtract(skillHits, toolHits, mcpHits, bodies, limits) {
  const anchors = [
    ...toolHits.map((hit) => ({ ref: hit.ref, identifiers: [hit.name, hit.ref, ...ensureArray(hit.tools).flatMap((tool) => [tool.name, tool.ref])] })),
    ...mcpHits.map((hit) => ({ ref: hit.ref, identifiers: [...mcpIdentifiers(hit), ...ensureArray(hit.tools).flatMap((tool) => [tool.name, tool.ref, tool.tool].filter(Boolean))] })),
  ];
  const found = [];
  const bySkill = new Map();

  for (const skill of skillHits) {
    const body = bodies.get(skill.ref) ?? "";
    const text = `${skill.name}\n${skill.description}\n${body}`;
    const targets = [
      ...new Set(
        anchors
          .filter((anchor) => anchor.identifiers.some((identifier) => matchesIdentifier(text, identifier)))
          .map((anchor) => anchor.ref),
      ),
    ].sort(compareStrings);
    for (const where of ["description", "body"]) {
      const source = where === "body" ? body : skill.description;
      if (source.length === 0) continue;
      found.push(...extractCaveats({ skill, text: source, where, anchors, limits }));
    }
    bySkill.set(skill.ref, targets);
  }

  const caveats = mergeCaveats(found, limits);
  return { caveats, bySkill };
}

function buildMissingCapabilities(tokens, covered, empty, limits) {
  const missing = [];
  for (const token of tokens) {
    if (covered.has(token) || isCjkToken(token)) continue;
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    missing.push(token);
    if (missing.length >= limits.missingCapabilities) break;
  }
  const lines = missing.map((token) => `No tool, MCP capability, skill, or package matched "${token}".`);
  if (lines.length === 0 && empty) lines.push("No tool, MCP capability, skill, or package matched the query.");
  return lines;
}

/**
 * v2 fuzzy fallback for the settled local groups. The caller applies it only
 * when no local group produced a single ref/name/token hit, so a single-edit
 * near miss can never appear next to, or ahead of, a real match.
 */
function applyFuzzyPhase({ tools, mcp, skills }, context, limits) {
  if (tools !== undefined) {
    const fuzzyHits = [];
    for (const entry of ensureArray(tools.fuzzy)) {
      const classified = classifyFuzzy(entry.candidate, context, limits);
      if (classified === null) continue;
      for (const token of classified.tokens) tools.covered.add(token);
      fuzzyHits.push(buildToolHit(entry.tool, classified, limits));
    }
    tools.hits = groupToolHits(fuzzyHits, tools.registry, limits).slice(0, limits.tools);
  }
  if (mcp !== undefined) {
    const fuzzyHits = [];
    for (const entry of ensureArray(mcp.fuzzy)) {
      const classified = classifyFuzzy(entry.candidate, context, limits);
      if (classified === null) continue;
      for (const token of classified.tokens) mcp.covered.add(token);
      fuzzyHits.push(buildMcpServerHit(entry.server, entry.group, classified, limits));
    }
    mcp.hits = fuzzyHits.sort(compareHits).slice(0, limits.mcp);
  }
  if (skills !== undefined) {
    const fuzzyHits = [];
    for (const entry of ensureArray(skills.fuzzy)) {
      const classified = classifyFuzzy(entry.candidate, context, limits);
      if (classified === null) continue;
      for (const token of classified.tokens) skills.covered.add(token);
      fuzzyHits.push(buildSkillHit(entry.skill, classified, null, limits, false));
    }
    fuzzyHits.sort(compareHits);
    skills.hits = fuzzyHits.slice(0, limits.skills);
  }
}

function toolPayload(tool) {
  return {
    ref: toolRef(tool.name),
    kind: "tool",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.promptGuidelines.length > 0 ? { promptGuidelines: tool.promptGuidelines } : {}),
    exposure: tool.exposure,
    active: tool.active,
    source: tool.source,
    path: tool.path,
    ...(tool.scope.length > 0 ? { scope: tool.scope } : {}),
    ...(tool.origin.length > 0 ? { origin: tool.origin } : {}),
    ...(tool.namespaceName.length > 0 ? { namespace: tool.namespaceName } : {}),
    ...(tool.mcpIdentity !== null
      ? {
          server: tool.mcpIdentity.server,
          ...(tool.mcpIdentity.tool !== undefined ? { tool: tool.mcpIdentity.tool } : {}),
          serverIdentityBasis: tool.mcpIdentity.basis,
        }
      : {}),
  };
}

/**
 * Build a broker over injected providers. Search and read are read-only and
 * side-effect free: they never install, enable, download or execute anything,
 * and the only filesystem access is the bounded skill body read.
 */
export function createCapabilityBroker(providers = {}) {
  const readSkillFile = typeof providers.readSkillFile === "function"
    ? providers.readSkillFile
    : async (filePath) => {
        if (typeof filePath !== "string" || filePath.length === 0) throw new Error("skill has no file path");
        return readFile(filePath, "utf8");
      };

  function failedResult(message) {
    return {
      status: "failed",
      tools: [],
      mcp: [],
      skills: [],
      remote: [],
      missingCapabilities: [],
      warnings: [message],
    };
  }

  async function search({ query, src, cwd = process.cwd(), signal } = {}) {
    throwIfAborted(signal);
    const text = typeof query === "string" ? query.trim() : "";
    if (text.length === 0) return failedResult("capability search query must be a non-empty string");
    if (src !== "local" && src !== "remote" && src !== "all") {
      throw new Error(`capability search src must be "local", "remote" or "all", got ${JSON.stringify(src)}`);
    }

    const context = {
      query: text,
      cwd,
      tokens: requestTokens(text, CAPABILITY_LIMITS),
      ref: parseQueryRef(text),
    };
    const wantLocal = src !== "remote";
    const wantRemote = src !== "local";

    // Local groups start together and the remote group joins them when asked;
    // the shared registry/skill snapshots keep the concurrent groups from
    // re-reading the same provider twice.
    const registryPromise = wantLocal ? defer(() => snapshotRegistry(providers)) : null;
    const skillsPromise = wantLocal ? defer(() => snapshotSkills(providers, cwd, CAPABILITY_LIMITS)) : null;

    const branches = [];
    if (wantLocal) {
      branches.push(["tools", defer(() => searchToolHits(registryPromise, context, CAPABILITY_LIMITS))]);
      branches.push(["mcp", defer(() => searchMcpHits(registryPromise, context, CAPABILITY_LIMITS))]);
      branches.push([
        "skills",
        defer(() => searchSkillHits(skillsPromise, providers, context, CAPABILITY_LIMITS, signal, readSkillFile)),
      ]);
    }
    if (wantRemote) {
      branches.push(["remote", defer(() => searchRemoteHits(providers, context, CAPABILITY_LIMITS, signal))]);
    }

    const outcomes = await Promise.allSettled(branches.map(([, promise]) => promise));
    if (signal?.aborted) throw abortError(signal.reason);

    const warnings = [];
    const failed = [];
    const byLabel = new Map();
    for (let index = 0; index < branches.length; index += 1) {
      const [label] = branches[index];
      const outcome = outcomes[index];
      if (outcome.status === "fulfilled") {
        byLabel.set(label, outcome.value);
        warnings.push(...ensureArray(outcome.value.warnings));
        continue;
      }
      failed.push(label);
      warnings.push(`${label} search failed: ${errorMessage(outcome.reason, CAPABILITY_LIMITS)}`);
    }

    // v2 fuzzy fallback: single-edit near misses surface only after every local
    // group settled with no ref/name/token hit anywhere among them, and never
    // for a ref-shaped query. The remote group applies its own rule internally.
    if (
      wantLocal &&
      context.ref === null &&
      ["tools", "mcp", "skills"].every((label) => (byLabel.get(label)?.hits.length ?? 0) === 0)
    ) {
      applyFuzzyPhase(
        { tools: byLabel.get("tools"), mcp: byLabel.get("mcp"), skills: byLabel.get("skills") },
        context,
        CAPABILITY_LIMITS,
      );
    }

    const toolHits = byLabel.get("tools")?.hits ?? [];
    const mcpHits = byLabel.get("mcp")?.hits ?? [];
    const skillOutcome = byLabel.get("skills");
    const rawSkillHits = skillOutcome?.hits ?? [];
    const bodies = skillOutcome?.bodies ?? new Map();
    const remoteHits = byLabel.get("remote")?.hits ?? [];

    // Caveats and cross-class binding run after the parallel search: they need
    // the Tool and MCP hits the Skill branch cannot see while it is searching.
    const { caveats, bySkill } = bindAndExtract(rawSkillHits, toolHits, mcpHits, bodies, CAPABILITY_LIMITS);
    const skills = rawSkillHits.map((hit) => ({
      ...hit,
      bindsTo: bySkill.get(hit.ref) ?? [],
      caveats: caveats.filter((caveat) => caveat.sources.some((source) => source.skill === hit.ref)),
    }));

    const covered = new Set();
    for (const outcome of byLabel.values()) {
      for (const token of outcome.covered ?? []) covered.add(token);
    }
    const empty = toolHits.length === 0 && mcpHits.length === 0 && rawSkillHits.length === 0 && remoteHits.length === 0;
    const status = failed.length === 0 ? "ok" : failed.length === branches.length ? "failed" : "partial";

    return {
      status,
      tools: toolHits,
      mcp: mcpHits,
      skills,
      remote: remoteHits,
      missingCapabilities:
        context.ref === null ? buildMissingCapabilities(context.tokens, covered, empty, CAPABILITY_LIMITS) : [],
      warnings: [...new Set(warnings)].slice(0, CAPABILITY_LIMITS.warnings),
    };
  }

  async function readTool(ref, rest) {
    const name = decodePart(rest);
    const registry = await snapshotRegistry(providers);
    const tool = registry.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`unknown tool: ${ref}`);
    return JSON.stringify(toolPayload(tool), null, 2);
  }

  async function readNamespace(ref, rest) {
    const name = decodePart(rest);
    const registry = await snapshotRegistry(providers);
    const group = registry.tools.filter((tool) => tool.namespaceName === name);
    if (group.length === 0) throw new Error(`unknown namespace: ${ref}`);
    return JSON.stringify({ ...buildNamespaceHit(name, group, { match: "ref", score: REF_SCORE, labels: ["ref"] }, CAPABILITY_LIMITS), tools: group.map(toolPayload) }, null, 2);
  }

  async function readMcp(ref, rest, limits) {
    const slash = rest.indexOf("/");
    const server = decodePart(slash === -1 ? rest : rest.slice(0, slash));
    const encodedTool = slash === -1 ? undefined : rest.slice(slash + 1);
    const toolName = encodedTool !== undefined && encodedTool.length > 0 ? decodePart(encodedTool) : undefined;
    const registry = await snapshotRegistry(providers);
    const group = registry.tools.filter(
      (tool) => tool.isMcp && tool.mcpIdentity !== null && tool.mcpIdentity.server === server,
    );
    if (group.length === 0) throw new Error(`unknown MCP server: ${ref}`);
    if (toolName === undefined) {
      return JSON.stringify(
        {
          ref: mcpServerRef(server),
          kind: "mcp",
          server,
          description: group.find((tool) => tool.namespaceDescription.length > 0)?.namespaceDescription ?? "",
          ...(group[0].namespaceName ? { namespace: group[0].namespaceName } : {}),
          instructions: group.find((tool) => tool.namespaceInstructions)?.namespaceInstructions ?? "",
          active: group.some((tool) => tool.active),
          tools: group.map((tool) => ({
            ref: mcpRef(server, tool.mcpIdentity.tool),
            name: tool.name,
            description: truncate(tool.description, limits.descriptionChars),
            ...(tool.mcpIdentity.tool !== undefined ? { tool: tool.mcpIdentity.tool } : {}),
            active: tool.active,
            exposure: tool.exposure,
          })),
        },
        null,
        2,
      );
    }
    const tool = group.find((candidate) => candidate.mcpIdentity.tool === toolName || candidate.name === toolName);
    if (tool === undefined) throw new Error(`unknown MCP tool: ${ref}`);
    return JSON.stringify(
      {
        ...toolPayload(tool),
        ref: mcpRef(server, tool.mcpIdentity.tool),
        kind: "mcp",
        server,
        ...(tool.mcpIdentity.tool !== undefined ? { tool: tool.mcpIdentity.tool } : {}),
      },
      null,
      2,
    );
  }

  async function readSkill(ref, rest, cwd, limits, signal) {
    const name = decodePart(rest);
    const snapshot = await snapshotSkills(providers, cwd, limits);
    const skill = snapshot.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) throw new Error(`unknown skill: ${ref}`);
    throwIfAborted(signal);
    try {
      return await readSkillText(skill, readSkillFile, limits);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      throw new Error(`skill "${name}" body unreadable: ${errorMessage(error, limits)}`);
    }
  }

  async function readPackage(ref, limits, signal) {
    if (typeof providers.readRemote !== "function") throw new Error("remote marketplace helper is not configured");
    let value;
    try {
      value = await runBounded(
        (taskSignal) => Promise.resolve(providers.readRemote(ref, { signal: taskSignal })),
        { signal, timeoutMs: limits.remoteTimeoutMs },
      );
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (error instanceof BranchTimeoutError) {
        throw new Error(`remote marketplace read for ${ref} timed out after ${limits.remoteTimeoutMs}ms`);
      }
      throw error;
    }
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") throw new Error(`remote marketplace returned no metadata for ${ref}`);
    return JSON.stringify(value, null, 2);
  }

  async function read(ref, { cwd = process.cwd(), signal } = {}) {
    throwIfAborted(signal);
    const parsed = parseCapabilityRef(ref);
    let text;
    switch (parsed.scheme) {
      case "tool":
        text = await readTool(ref, parsed.rest);
        break;
      case "namespace":
        text = await readNamespace(ref, parsed.rest);
        break;
      case "mcp":
        text = await readMcp(ref, parsed.rest, CAPABILITY_LIMITS);
        break;
      case "skill":
        text = await readSkill(ref, parsed.rest, cwd, CAPABILITY_LIMITS, signal);
        break;
      case "npm":
        text = await readPackage(ref, CAPABILITY_LIMITS, signal);
        break;
      default:
        throw new Error(`unsupported capability protocol "${parsed.scheme}://"`);
    }
    throwIfAborted(signal);
    return text;
  }

  return { search, read };
}
