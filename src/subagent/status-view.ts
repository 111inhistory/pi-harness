/**
 * Human-facing rendering for the `/subagent` command.
 *
 * Plain text only: the list mirrors pi-antigravity's command output (aligned
 * columns, one row per actor, footer summary) and never renders state itself.
 * The tree and status come from `RootService`/`Runtime`; this module only
 * decides layout.
 */
import type { AgentView, DetailedAgentItem, JobView } from "./runtime.ts";

export interface SubagentListInput {
  /** Short session label shown in the header. */
  readonly root: string;
  /** Windowed tree from `RootService.list`; `null` when the filter matched nothing. */
  readonly tree: DetailedAgentItem | null;
  /** Every actor of the current root, used for counts and hidden-node hints. */
  readonly actors: readonly AgentView[];
  readonly jobs: readonly JobView[];
  readonly roles: ReadonlyMap<string, string | null>;
  readonly historyDir: string | null;
}

const KIND_WIDTH = "inherited".length;
const STATUS_WIDTH = "finalizing".length;
const LIVE_STATUSES = new Set(["running", "stopping", "finalizing"]);

function glyph(status: string): string {
  if (status === "running") return "●";
  if (status === "stopping" || status === "finalizing") return "◐";
  return "○";
}

function liveStatus(actor: AgentView | undefined, job: JobView | undefined): string {
  if (actor?.status !== "running") return "idle";
  return job !== undefined && LIVE_STATUSES.has(job.status) ? job.status : "running";
}

/** Render the current root's subagent tree as one notify-sized text block. */
export function renderSubagentList(input: SubagentListInput): string {
  const actors = new Map(input.actors.map((agent) => [agent.agentId, agent]));
  const live = new Map<string, JobView>();
  for (const job of input.jobs) {
    if (LIVE_STATUSES.has(job.status)) live.set(job.agentId, job);
  }

  const rows: Array<{ readonly item: DetailedAgentItem; readonly depth: number }> = [];
  const walk = (item: DetailedAgentItem, depth: number): void => {
    if (item.id !== "Main") rows.push({ item, depth });
    for (const child of item.children) walk(child, item.id === "Main" ? 1 : depth + 1);
  };
  if (input.tree !== null) walk(input.tree, 0);

  // The breakdown describes the active pool, matching the `active` count;
  // idle actors are history, not part of the current fan-out.
  const activeActors = input.actors.filter((agent) => agent.status === "running");
  const fresh = activeActors.filter((agent) => agent.kind === "fresh").length;
  const inherited = activeActors.length - fresh;
  const active = activeActors.length;
  const header = `Subagents · ${input.root} · ${input.actors.length} actors · ${active} active (${fresh} fresh / ${inherited} inherited)`;

  if (rows.length === 0) return `${header}\nNo visible subagents.`;

  const idWidth = Math.max(...rows.map((row) => row.item.id.length));
  const roleWidth = Math.max(4, ...rows.map((row) => (input.roles.get(row.item.id) ?? "").length));
  const lines = rows.map(({ item, depth }) => {
    const job = live.get(item.id);
    const calls = job?.budget === undefined ? "–" : `${job.budget.modelCalls} calls`;
    const role = input.roles.get(item.id) ?? "-";
    const status = liveStatus(actors.get(item.id), job);
    const kind = item.kind ?? actors.get(item.id)?.kind ?? "fresh";
    // Indentation is relative to the rendered subtree; the depth column is absolute.
    const absoluteDepth = actors.get(item.id)?.depth ?? depth;
    return `${"  ".repeat(depth)}${glyph(status)} ${item.id.padEnd(idWidth)}  d${absoluteDepth}  `
      + `${kind.padEnd(KIND_WIDTH)}  ${role.padEnd(roleWidth)}  ${status.padEnd(STATUS_WIDTH)}  ${calls}`;
  });

  const hidden = input.actors.length - rows.length;
  const footer = [
    hidden > 0 ? `window shows ${rows.length} of ${input.actors.length}` : null,
    input.historyDir === null ? null : `history ${input.historyDir}`,
  ].filter((part): part is string => part !== null).join(" · ");
  return [header, ...lines, ...(footer === "" ? [] : [footer])].join("\n");
}
