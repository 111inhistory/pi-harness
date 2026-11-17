/** Namespace prose and native guidance identities from the current tool catalog. */
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { renderCurrentToolGuidance, toolGuidanceSection, type ToolGuidance } from '../tool-guidance.ts';
import { capabilityRef, mcpRef } from './refs.ts';
import { mcpIdentity } from './broker.ts';

type NamespaceTool = Pick<ToolInfo, 'name' | 'namespace'> & {
  readonly sourceInfo?: ToolInfo['sourceInfo'];
  readonly promptGuidelines?: ToolInfo['promptGuidelines'];
};

/**
 * The loaded-container facts guidance reads; the tool-access domain's
 * `ToolContainer` satisfies this structurally.
 *
 * `members` are the container's currently registered names. Guidance joins on
 * them instead of re-deriving container identity, which keeps one abstraction
 * for plain namespaces and MCP (the domain already normalizes
 * `namespace://mcp__git` and `mcp://git` into one container). Selection decides
 * eligibility only: the metadata text still comes from the registered tools'
 * namespace metadata, so no second catalog is introduced.
 */
export interface LoadedContainerGuidance {
  readonly members: readonly string[];
  /** A container-level blacklist rule hides the namespace guidance entirely. */
  readonly blocked: boolean;
}

function namespaceRefs(tool: NamespaceTool): string[] {
  const namespace = tool.namespace;
  if (!namespace?.name) return [];
  const refs = [capabilityRef('namespace', namespace.name)];
  const mcp = mcpIdentity(tool.name, namespace.name, tool.sourceInfo?.path ?? '');
  if (mcp && (namespace.name.startsWith('mcp__') || tool.sourceInfo?.source === 'mcp')) {
    refs.push(mcpRef(mcp.server));
  }
  return refs;
}

/**
 * Namespaces whose `namespace.instructions` text is already supplied natively
 * by at least one active, declared tool's `ToolDefinition.promptGuidelines`
 * (which the SDK renders into `<rules>`).
 */
export function nativelyGuidedNamespaces(
  tools: readonly NamespaceTool[],
  callable?: ReadonlySet<string>,
  declared?: ReadonlySet<string>,
): ReadonlySet<string> {
  const covered = new Set<string>();
  const activeSet = declared ?? callable;
  for (const tool of tools) {
    const namespace = tool.namespace;
    const instructions = namespace?.instructions?.trim();
    if (!namespace?.name || !instructions) continue;
    if (activeSet && !activeSet.has(tool.name)) continue;
    if (declared && !declared.has(tool.name)) continue;
    if (callable && !callable.has(tool.name)) continue;
    if (tool.promptGuidelines?.some((line) => line === namespace.instructions || line.includes(instructions))) {
      covered.add(namespace.name);
    }
  }
  return covered;
}

/** Current prose for already-discovered resources, including MCP source aliases. */
export function toolNamespaceInstructions(tools: readonly NamespaceTool[]): ReadonlyMap<string, string | null> {
  const instructions = new Map<string, string | null>();
  for (const tool of tools) {
    const text = tool.namespace?.instructions ?? '';
    for (const ref of namespaceRefs(tool)) {
      // Match discovery's first nonempty value, including an explicit empty
      // value when the current namespace has withdrawn its prose.
      if (!instructions.get(ref)) instructions.set(ref, text);
    }
  }
  return instructions;
}

/**
 * Registered namespaces that supply `namespace.instructions` without native
 * `ToolDefinition.promptGuidelines` emit dynamic guidance sections through
 * `before_agent_start`. Namespaces whose active declared tools already carry
 * their instructions via `promptGuidelines` rely on the SDK's `<rules>` section.
 *
 * An explicitly loaded container keeps its namespace guidance while every member
 * is inactive; only the current container-level blacklist removes it. Member
 * names still come from the caller's eligible catalog, so scope and member-level
 * blacklist filtering stay with the catalog owner.
 */
export function registeredToolGuidance(
  tools: readonly NamespaceTool[],
  assets: readonly ToolGuidance[] = [],
  callable?: ReadonlySet<string>,
  declared?: ReadonlySet<string>,
  containers: readonly LoadedContainerGuidance[] = [],
  /**
   * Names whose native declaration is withheld by an explicit schema mode. They
   * keep dynamic namespace guidance even when no member is callable, but they
   * never count as native `promptGuidelines` coverage because that declaration is
   * not sent; their own text comes from {@link withheldToolGuidance}.
   */
  schemaWithheld: ReadonlySet<string> = NO_WITHHELD,
): readonly ToolGuidance[] {
  const covered = new Set(assets.flatMap(entry => entry.namespace ? [entry.namespace] : []));
  for (const name of nativelyGuidedNamespaces(tools, callable, declared)) {
    covered.add(name);
  }
  // A live, unblocked loaded container (or a withheld declaration) keeps
  // guidance available while none of its members is currently callable. A
  // container-level blacklist hides the namespace guide together with member
  // execution, so it never joins here.
  const loadedMembers = new Map<string, LoadedContainerGuidance>();
  for (const container of containers) {
    if (container.blocked) continue;
    for (const member of container.members) loadedMembers.set(member, container);
  }
  const groups = new Map<string, { readonly members: string[]; loaded: boolean }>();
  for (const tool of tools) {
    const name = tool.namespace?.name;
    if (!name || covered.has(name)) continue;
    const visible = loadedMembers.has(tool.name) || schemaWithheld.has(tool.name);
    if (!visible && callable && !callable.has(tool.name)) continue;
    const group = groups.get(name) ?? { members: [], loaded: false };
    group.members.push(tool.name);
    group.loaded ||= visible;
    groups.set(name, group);
  }
  const instructions = toolNamespaceInstructions(tools);
  const initialAssets = assets.filter(entry => !callable || entry.tools.some(name => callable.has(name))).map(entry => ({
    ...entry,
    ...(callable ? { eligible: entry.tools.some(name => callable.has(name)) } : {}),
  }));
  return [...initialAssets, ...[...groups].map(([namespace, group]): ToolGuidance => ({
    id: `namespace:${namespace}`,
    namespace,
    tools: group.members,
    text: instructions.get(capabilityRef('namespace', namespace)) ?? '',
    // A loaded container is eligible even when all of its members are currently
    // inactive; its guidance must outlive member deactivation.
    ...(group.loaded ? {} : callable ? { eligible: group.members.some(name => callable.has(name)) } : {}),
  }))];
}

/**
 * Omit shared prose from `<capabilities>` memory when either a rendered dynamic
 * guidance section or a declared tool's native `promptGuidelines` already
 * supplies it in the current request.
 */
export function projectedNamespaceRefs(
  guidance: readonly ToolGuidance[],
  tools: readonly NamespaceTool[],
  rendered: Readonly<Record<string, string>> = renderCurrentToolGuidance(guidance),
  declared?: ReadonlySet<string>,
  callable?: ReadonlySet<string>,
): ReadonlySet<string> {
  const emitted = new Set<string>(nativelyGuidedNamespaces(tools, callable, declared));
  for (const entry of guidance) {
    if (!entry.namespace || rendered[toolGuidanceSection(entry.id)] === undefined) continue;
    emitted.add(entry.namespace);
  }
  return new Set(tools.flatMap(tool => tool.namespace && emitted.has(tool.namespace.name) ? namespaceRefs(tool) : []));
}

/** No tool has an explicit schema-mode override in the common case. */
const NO_WITHHELD: ReadonlySet<string> = new Set();

/** Remove the namespace's shared instruction text from one per-tool guideline. */
function withoutNamespaceText(line: string, namespaceInstructions: string): string {
  const normalized = line.trim();
  if (namespaceInstructions === '') return normalized;
  return normalized
    .split(namespaceInstructions)
    .map(part => part.trim())
    .filter(part => part !== '')
    .join(' ');
}

/**
 * Current per-tool instructions for tools whose native declaration is withheld
 * by an explicit schema mode.
 *
 * A withheld declaration does not reach the SDK's `<rules>`, so its
 * `ToolDefinition.promptGuidelines` would otherwise disappear. This emits them
 * through the existing dynamic guidance section path and keeps the namespace
 * guide in its canonical loaded-container section:
 *
 * - the shared namespace instruction text is stripped, so the namespace guide is
 *   not repeated once per tool;
 * - identical remaining lines are emitted once, even across several withheld
 *   tools;
 * - a tool with nothing but the shared text emits no entry.
 */
export function withheldToolGuidance(
  tools: readonly NamespaceTool[],
  withheld: ReadonlySet<string>,
): readonly ToolGuidance[] {
  if (withheld.size === 0) return [];
  const emitted = new Set<string>();
  const entries: ToolGuidance[] = [];
  for (const tool of tools) {
    if (!withheld.has(tool.name)) continue;
    const namespaceInstructions = tool.namespace?.instructions?.trim() ?? '';
    const lines: string[] = [];
    for (const guideline of tool.promptGuidelines ?? []) {
      const line = withoutNamespaceText(guideline, namespaceInstructions);
      if (line === '' || emitted.has(line)) continue;
      emitted.add(line);
      lines.push(line);
    }
    if (lines.length === 0) continue;
    entries.push({ id: `tool:${tool.name}`, tools: [tool.name], text: lines.join('\n') });
  }
  return entries;
}
