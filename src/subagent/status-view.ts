/**
 * Human-facing rendering for the `/subagent` command.
 *
 * Plain text only: the list mirrors pi-antigravity's command output (aligned
 * columns, one row per agent, footer summary). The tree and
 * history pointers come from the same `RootService` projection the
 * `subagent_list` tool receives; this module only decides layout.
 */
import { MAIN_ACTOR } from "./address.ts";
import type { AgentView, DetailedAgentItem } from "./runtime.ts";

export interface SubagentListInput {
  /** Short session label shown in the header. */
  readonly root: string;
  /** Windowed tree from `RootService.list`; `null` when the filter matched nothing. */
  readonly tree: DetailedAgentItem | null;
  /** Every actor of the current root, used for counts and hidden-node hints. */
  readonly actors: readonly AgentView[];
  readonly models?: ReadonlyMap<string, string>;
}

const KIND_WIDTH = "inherited".length;

/** Render the current root's subagent tree as one notify-sized text block. */
export function renderSubagentList(input: SubagentListInput): string {
  const rows: Array<{ readonly item: DetailedAgentItem; readonly depth: number }> = [];
  const walk = (item: DetailedAgentItem, depth: number): void => {
    if (item.id !== MAIN_ACTOR) rows.push({ item, depth });
    for (const child of item.children) walk(child, item.id === MAIN_ACTOR ? 1 : depth + 1);
  };
  if (input.tree !== null) walk(input.tree, 0);

  // The breakdown describes the active pool, matching the `active` count;
  // idle actors are history, not part of the current fan-out.
  const activeActors = input.actors.filter((agent) => agent.status === "running");
  const fresh = activeActors.filter((agent) => agent.kind === "fresh").length;
  const inherited = activeActors.length - fresh;
  const active = activeActors.length;
  const header = `Subagents · ${input.root} · ${input.actors.length} agents · ${active} active (${fresh} fresh / ${inherited} inherited)`;

  if (rows.length === 0) return `${header}\nNo visible subagents.`;

  // The canonical identity is always the logical address. A declared label is
  // display metadata appended in parentheses; an undeclared label adds nothing,
  // so it can never be confused with addressing or padded into a fake name.
  const identity = (item: DetailedAgentItem): string =>
    item.name === null || item.name === "" ? item.address : `${item.address} (${item.name})`;
  const identityWidth = Math.max(...rows.map((row) => identity(row.item).length));
  const roleWidth = Math.max(4, ...rows.map((row) => (row.item.role ?? "").length));
  const lines = rows.map(({ item, depth }) => {
    const role = item.role ?? "-";
    const kind = item.kind ?? "fresh";
    // Indentation is relative to the rendered subtree; the address stays absolute.
    return `${"  ".repeat(depth)}${identity(item).padEnd(identityWidth)}  `
      + `${kind.padEnd(KIND_WIDTH)}  ${role.padEnd(roleWidth)}  ${input.models?.get(item.id) ?? "-"}  ${item.status}`;
  });

  const hidden = input.actors.length - rows.length;
  const footer = [
    hidden > 0 ? `window shows ${rows.length} of ${input.actors.length}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
  return [header, ...lines, ...(footer === "" ? [] : [footer])].join("\n");
}
