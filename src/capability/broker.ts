import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import MiniSearch from 'minisearch';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../harness-config.ts';
import { CAPABILITY_DIAGNOSTIC_LIMITS } from './contracts.ts';
import { capabilityRef, mcpRef, toolRef } from './refs.ts';

/** The typed BM25 and resource bounds a broker uses for every search. */
export type CapabilitySearchConfig = HarnessConfig['capability']['search'];

/** Provider data is checked here before entering the search index. */
export interface CapabilityProviders {
  listTools?: () => unknown | Promise<unknown>;
  listActiveTools?: () => unknown | Promise<unknown>;
  discoverSkills?: (cwd: string) => unknown | Promise<unknown>;
  readSkillFile?: (filePath: string) => string | Promise<string>;
}

interface ToolMember {
  ref: string;
  name: string;
  description: string;
  exposure: string;
  tool?: string;
}

export interface CapabilitySearchHit {
  ref: string;
  name: string;
  description: string;
  filePath?: string;
  server?: string;
  kind: 'tool' | 'namespace' | 'mcp' | 'skill';
  status: 'available';
  match: 'ref' | 'bm25';
  score: number;
  reason: string;
  exposure?: string;
  source?: string;
  path?: string;
  namespace?: string;
  instructions?: string;
  toolCount?: number;
  tools?: ToolMember[];
}

export interface CapabilitySkillHit extends CapabilitySearchHit {
  filePath: string;
}

export interface CapabilitySearchResult {
  status: 'ok' | 'partial' | 'failed';
  tools: CapabilitySearchHit[];
  mcp: CapabilitySearchHit[];
  skills: CapabilitySkillHit[];
  remote: [];
  missingCapabilities: string[];
  warnings: string[];
}

interface McpIdentity { server: string; tool?: string; basis: string }
interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  exposure: string;
  source: string;
  path: string;
  namespace: string;
  namespaceDescription: string;
  instructions: string;
  mcp: McpIdentity | null;
  isMcp: boolean;
  active: boolean;
}
interface Skill { name: string; description: string; filePath: string }
interface Candidate {
  hit: CapabilitySearchHit;
  aliases: Set<string>;
  /** Each tool is indexed separately, while results are whole capabilities. */
  documents: string[];
}
interface Ranked { candidate: Candidate; score: number }
type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const truncate = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const errorText = (error: unknown): string => truncate(error instanceof Error ? error.message : String(error), CAPABILITY_DIAGNOSTIC_LIMITS.warningChars);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Capability search aborted', 'AbortError');
}

function mcpName(name: string): McpIdentity | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  if (!rest) return null;
  const double = rest.indexOf('__');
  const split = double > 0 ? double : rest.indexOf('_');
  const width = double > 0 ? 2 : 1;
  return split < 0
    ? { server: rest, basis: 'tool name' }
    : { server: rest.slice(0, split), tool: rest.slice(split + width), basis: 'tool name' };
}

function mcpIdentity(name: string, namespace: string, path: string): McpIdentity | null {
  const explicit = /^mcp:([^/]+)(?:\/(.+))?$/.exec(path);
  if (explicit?.[1]) return { server: explicit[1], ...(explicit[2] ? { tool: explicit[2] } : {}), basis: 'source path' };
  const bracketed = /^<mcp:(.+)>$/.exec(path);
  if (bracketed?.[1]) {
    const minted = mcpName(bracketed[1]);
    if (minted) return { ...minted, basis: 'source path' };
    const [server, ...tool] = bracketed[1].split('/');
    if (server) return { server, ...(tool.length ? { tool: tool.join('/') } : {}), basis: 'source path' };
  }
  const minted = mcpName(name);
  if (namespace.startsWith('mcp__')) {
    const server = namespace.slice(5);
    return { server, ...(minted?.server === server && minted.tool ? { tool: minted.tool } : {}), basis: 'namespace' };
  }
  return minted;
}

/** Include parameter names and descriptions, not executable or runtime metadata. */
function schemaText(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  const schema = record(value);
  const fields = [string(schema.description)];
  for (const [name, property] of Object.entries(record(schema.properties))) fields.push(name, schemaText(property, depth + 1));
  if (schema.items) fields.push(schemaText(schema.items, depth + 1));
  for (const key of ['anyOf', 'oneOf', 'allOf']) for (const variant of array(schema[key])) fields.push(schemaText(variant, depth + 1));
  return fields.join(' ');
}

async function registry(providers: CapabilityProviders): Promise<Tool[]> {
  if (!providers.listTools) throw new Error('listTools provider is not configured');
  if (!providers.listActiveTools) throw new Error('listActiveTools provider is not configured');
  const [rawTools, rawActive] = await Promise.all([providers.listTools(), providers.listActiveTools()]);
  const active = new Set(array(rawActive).map(string));
  return array(rawTools).flatMap((value): Tool[] => {
    const item = record(value);
    const name = string(item.name).trim();
    const exposure = string(item.exposure) || 'direct';
    if (!name || exposure === 'hidden') return [];
    const source = record(item.sourceInfo);
    const namespace = record(item.namespace);
    const namespaceName = string(namespace.name);
    const sourceName = string(source.source);
    const path = string(source.path);
    const isMcp = sourceName === 'mcp' || /^<?mcp:/.test(path) || namespaceName.startsWith('mcp__') || name.startsWith('mcp__');
    return [{ name, description: string(item.description), parameters: item.parameters, exposure,
      source: sourceName, path, namespace: namespaceName, namespaceDescription: string(namespace.description),
      instructions: string(namespace.instructions), isMcp,
      mcp: isMcp ? mcpIdentity(name, namespaceName, path) : null, active: active.has(name) }];
  });
}

async function skills(providers: CapabilityProviders, cwd: string): Promise<{ skills: Skill[]; warnings: string[] }> {
  if (!providers.discoverSkills) throw new Error('discoverSkills provider is not configured');
  const result = record(await providers.discoverSkills(cwd));
  const found = new Map<string, Skill>();
  for (const value of array(result.skills)) {
    const item = record(value);
    const name = string(item.name).trim();
    const path = string(item.filePath);
    if (!name || !path || item.disableModelInvocation === true) continue;
    const filePath = resolve(cwd, path);
    found.set(filePath, { name, description: string(item.description), filePath });
  }
  const warnings = array(result.diagnostics).flatMap((value) => {
    const diagnostic = record(value);
    const message = string(diagnostic.message);
    if (!message) return [];
    return [truncate(`skill discovery ${string(diagnostic.type) || 'warning'}: ${message}${diagnostic.path ? ` (${String(diagnostic.path)})` : ''}`, CAPABILITY_DIAGNOSTIC_LIMITS.warningChars)];
  });
  return { skills: [...found.values()], warnings };
}

function candidates(tools: Tool[], warnings: string[], limits: CapabilitySearchConfig['limits']): Candidate[] {
  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    if (tool.isMcp && !tool.mcp && !tool.namespace) warnings.push(`mcp tool "${tool.name}" exposes no parseable server identity`);
    if (!tool.namespace && !tool.isMcp && tool.active && ['builtin', 'sdk'].includes(tool.source)) continue;
    const key = tool.namespace ? capabilityRef('namespace', tool.namespace) : tool.mcp ? mcpRef(tool.mcp.server) : toolRef(tool.name);
    const group = groups.get(key) ?? [];
    group.push(tool);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]): Candidate => {
    const first = group[0]!;
    const isMcp = first.namespace ? first.namespace.startsWith('mcp__') : first.mcp !== null;
    const kind = isMcp ? 'mcp' : first.namespace ? 'namespace' : 'tool';
    const aliases = new Set([key]);
    const members = group.map((tool): ToolMember => {
      const memberRef = tool.mcp ? mcpRef(tool.mcp.server, tool.mcp.tool) : toolRef(tool.name);
      if (!isMcp) aliases.add(toolRef(tool.name));
      if (tool.mcp) { aliases.add(mcpRef(tool.mcp.server)); aliases.add(memberRef); }
      return { ref: memberRef, name: tool.name, description: truncate(tool.description, limits.descriptionChars),
        exposure: tool.exposure, ...(tool.mcp?.tool ? { tool: tool.mcp.tool } : {}) };
    });
    const hit: CapabilitySearchHit = {
      ref: key, name: first.namespace || first.mcp?.server || first.name,
      description: truncate(first.namespaceDescription || first.description, limits.descriptionChars),
      kind, status: 'available', match: 'bm25', score: 0, reason: 'BM25 metadata match',
      ...(first.namespace ? { namespace: first.namespace } : {}),
      ...(isMcp && first.mcp ? { server: first.mcp.server } : {}),
      ...(kind === 'tool' ? { exposure: first.exposure, source: first.source, path: first.path } : {
        instructions: group.find((tool) => tool.instructions)?.instructions ?? '', toolCount: group.length, tools: members,
      }),
    };
    return { hit, aliases, documents: group.map((tool) => [tool.name, tool.mcp?.server ?? '', tool.mcp?.tool ?? '',
      tool.namespace, tool.description, tool.namespaceDescription, tool.instructions, schemaText(tool.parameters)].join('\n')) };
  });
}

function skillCandidate(skill: Skill): Candidate {
  return { hit: { ...skill, ref: skill.filePath, kind: 'skill', status: 'available', match: 'bm25', score: 0, reason: 'BM25 metadata match' },
    aliases: new Set([skill.filePath]), documents: [`${skill.name}\n${skill.description}`] };
}

/** MiniSearch owns tokenization, term statistics, length normalization and scoring. */
function rank(query: string, entries: Candidate[], search: CapabilitySearchConfig): Ranked[] {
  if (!entries.length) return [];
  const index = new MiniSearch<{ id: number; text: string }>({
    fields: ['text'],
    // BM25 values come from the resolved Harness config; d = 0 keeps standard
    // BM25 instead of the library's BM25+ variant.
    searchOptions: { bm25: search.bm25 },
  });
  const owners: Candidate[] = [];
  const documents = entries.flatMap((candidate) => candidate.documents.map((text) => {
    const id = owners.length;
    owners.push(candidate);
    return { id, text };
  }));
  index.addAll(documents);
  const best = new Map<Candidate, number>();
  const tokenize: (text: string) => string[] = MiniSearch.getDefault('tokenize');
  const boundedQuery = tokenize(query).slice(0, search.limits.requestTokens).join(' ');
  for (const match of index.search(boundedQuery)) {
    const candidate = typeof match.id === 'number' ? owners[match.id] : undefined;
    if (candidate && match.score > (best.get(candidate) ?? 0)) best.set(candidate, match.score);
  }
  return [...best].map(([candidate, score]) => ({ candidate, score }))
    .sort((a, b) => b.score - a.score || compare(a.candidate.hit.ref, b.candidate.hit.ref));
}

function exactRef(query: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(query);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const rest = match[2]!;
  if (scheme === 'mcp') {
    const slash = rest.indexOf('/');
    return mcpRef(decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash)), slash < 0 ? undefined : decodeURIComponent(rest.slice(slash + 1)));
  }
  return capabilityRef(scheme, decodeURIComponent(rest));
}

const emptyResult = (): CapabilitySearchResult => ({ status: 'ok', tools: [], mcp: [], skills: [], remote: [], missingCapabilities: [], warnings: [] });

export function createCapabilityBroker(
  providers: CapabilityProviders,
  searchConfig: CapabilitySearchConfig = DEFAULT_HARNESS_CONFIG.capability.search,
) {
  const readSkill = providers.readSkillFile ?? ((filePath: string) => readFile(filePath, 'utf8'));
  return {
    async search({ query, src, cwd = process.cwd(), signal }: { query?: unknown; src?: unknown; cwd?: string; signal?: AbortSignal } = {}): Promise<CapabilitySearchResult> {
      const limits = searchConfig.limits;
      checkAbort(signal);
      const text = string(query).trim();
      const result = emptyResult();
      if (!text) return { ...result, status: 'failed', warnings: ['capability search query must be a non-empty string'] };
      if (src !== 'local') throw new Error(`capability search src must be "local", got ${JSON.stringify(src)}`);
      const snapshots = await Promise.allSettled([
        Promise.resolve().then(() => registry(providers)),
        Promise.resolve().then(() => skills(providers, cwd)),
      ]);
      checkAbort(signal);
      const [toolSnapshot, skillSnapshot] = snapshots;
      let failed = 0;
      const tools = toolSnapshot.status === 'fulfilled' ? toolSnapshot.value : [];
      if (toolSnapshot.status === 'rejected') {
        result.warnings.push(`tools search failed: ${errorText(toolSnapshot.reason)}`, `mcp search failed: ${errorText(toolSnapshot.reason)}`);
        failed += 2;
      }
      const entries = candidates(tools, result.warnings, limits);
      if (skillSnapshot.status === 'fulfilled') {
        entries.push(...skillSnapshot.value.skills.map(skillCandidate));
        result.warnings.push(...skillSnapshot.value.warnings);
      } else {
        result.warnings.push(`skills search failed: ${errorText(skillSnapshot.reason)}`);
        failed += 1;
      }
      result.status = failed === 3 ? 'failed' : failed ? 'partial' : 'ok';
      const requested = exactRef(text);
      const exactSkill = entries.find((candidate) => candidate.hit.kind === 'skill' && candidate.hit.filePath === text);
      const exact = requested !== null || exactSkill !== undefined;
      let ranked: Ranked[] = exact
        ? entries.filter((candidate) => candidate.aliases.has(requested ?? text)).map((candidate) => ({ candidate, score: 0 }))
        : rank(text, entries, searchConfig);
      if (requested?.startsWith('tool://') && !ranked.length) {
        const name = decodeURIComponent(requested.slice('tool://'.length));
        if (tools.some((tool) => tool.name === name && tool.mcp)) result.warnings.push(`ref "${text}" names an MCP tool; MCP tools are addressed by their mcp://<server>/<tool> ref`);
      }
      // Only top metadata matches are opened; no catalog-wide body scan.
      const selectedSkills = ranked.filter(({ candidate }) => candidate.hit.kind === 'skill').slice(0, limits.skillBodies);
      const selectedSkillSet = new Set(selectedSkills.map(({ candidate }) => candidate));
      const readBodies = new Set<string>();
      for (const { candidate } of selectedSkills) {
        checkAbort(signal);
        try {
          const body = (await readSkill(candidate.hit.filePath!)).slice(0, limits.skillBodyChars);
          readBodies.add(candidate.hit.ref);
          candidate.documents[0] += `\n${body}`;
        } catch (error) { result.warnings.push(`skill "${candidate.hit.name}" body unreadable: ${errorText(error)}`); }
      }
      checkAbort(signal);
      if (!exact && readBodies.size) ranked = rank(text, entries.filter((candidate) => candidate.hit.kind !== 'skill' || selectedSkillSet.has(candidate)), searchConfig);
      for (const { candidate, score } of ranked) {
        const hit = { ...candidate.hit, score, match: exact ? 'ref' as const : 'bm25' as const,
          reason: exact ? 'Exact reference lookup' : readBodies.has(candidate.hit.ref) ? 'BM25 metadata and body match' : candidate.hit.reason };
        if (hit.kind === 'skill') {
          if (selectedSkillSet.has(candidate) && result.skills.length < limits.skills) result.skills.push({ ...hit, filePath: hit.filePath! });
        } else if (hit.kind === 'mcp') {
          if (result.mcp.length < limits.mcp) result.mcp.push(hit);
        } else if (result.tools.length < limits.tools) result.tools.push(hit);
      }
      if (!failed && !result.tools.length && !result.mcp.length && !result.skills.length) {
        result.missingCapabilities.push(`No local capability matched "${truncate(text, limits.descriptionChars)}".`);
      }
      result.warnings = [...new Set(result.warnings)].slice(0, CAPABILITY_DIAGNOSTIC_LIMITS.warnings);
      return result;
    },
  };
}
