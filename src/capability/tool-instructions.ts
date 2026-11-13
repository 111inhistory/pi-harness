/** Namespace prose and native guidance identities from the current tool catalog. */
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { renderCurrentToolGuidance, toolGuidanceSection, type ToolGuidance } from '../tool-guidance.ts';
import { capabilityRef, mcpRef } from './refs.ts';
import { mcpIdentity } from './broker.ts';

type NamespaceTool = Pick<ToolInfo, 'name' | 'namespace'> & {
  readonly sourceInfo?: ToolInfo['sourceInfo'];
  readonly promptGuidelines?: ToolInfo['promptGuidelines'];
};

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
 */
export function registeredToolGuidance(
  tools: readonly NamespaceTool[],
  assets: readonly ToolGuidance[] = [],
  callable?: ReadonlySet<string>,
  declared?: ReadonlySet<string>,
): readonly ToolGuidance[] {
  const covered = new Set(assets.flatMap(entry => entry.namespace ? [entry.namespace] : []));
  for (const name of nativelyGuidedNamespaces(tools, callable, declared)) {
    covered.add(name);
  }
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const name = tool.namespace?.name;
    if (!name || covered.has(name) || (callable && !callable.has(tool.name))) continue;
    const members = groups.get(name) ?? [];
    members.push(tool.name);
    groups.set(name, members);
  }
  const instructions = toolNamespaceInstructions(tools);
  const initialAssets = assets.filter(entry => !callable || entry.tools.some(name => callable.has(name))).map(entry => ({
    ...entry,
    ...(callable ? { eligible: entry.tools.some(name => callable.has(name)) } : {}),
  }));
  return [...initialAssets, ...[...groups].map(([namespace, members]): ToolGuidance => ({
    id: `namespace:${namespace}`,
    namespace,
    tools: members,
    text: instructions.get(capabilityRef('namespace', namespace)) ?? '',
    ...(callable ? { eligible: members.some(name => callable.has(name)) } : {}),
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
