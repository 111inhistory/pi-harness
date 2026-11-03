/**
 * `/subagent` command: the user-facing read/stop entry for the current root.
 *
 * The command owns argument parsing, service resolution and error reporting.
 * Rendering lives in `status-view.ts`; state changes go through `RootService`
 * and `Runtime` only. It never sends messages to a subagent.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RootService } from "./root-service.ts";
import { SubagentError, type StopResult } from "./runtime.ts";
import { renderSubagentList } from "./status-view.ts";
import { crossSessionSupported, sessionMainAddress, type LiveSession } from "./session-directory.ts";

export type SubagentCommand =
  | { readonly verb: "list"; readonly all: boolean; readonly id: string | null }
  | { readonly verb: "stop"; readonly actorId: string }
  | { readonly verb: "stopAll" }
  | { readonly verb: "sessions" };

/** Parse the raw argument string without touching any service. */
export function parseCommand(raw: string): SubagentCommand {
  const tokens = raw.trim().split(/\s+/).filter((token) => token !== "");
  const [verb, ...rest] = tokens;
  if (verb === undefined) return { verb: "list", all: false, id: null };

  if (verb === "list") {
    let all = false;
    let id: string | null = null;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "--all") {
        all = true;
        continue;
      }
      if (token === "--id") {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new SubagentError("invalid_command_args", "list --id requires an actor id.", { field: "id" });
        }
        id = value;
        index += 1;
        continue;
      }
      throw new SubagentError("invalid_command_args", `Unknown list option: ${token}.`, { field: "list" });
    }
    return { verb: "list", all, id };
  }

  if (verb === "sessions") {
    if (rest.length > 0) throw new SubagentError("invalid_command_args", "sessions takes no arguments.", { field: "sessions" });
    return { verb: "sessions" };
  }

  if (verb === "stop") {
    if (rest.length === 1 && rest[0] === "--all") return { verb: "stopAll" };
    if (rest.length !== 1 || rest[0]!.startsWith("-")) {
      throw new SubagentError("invalid_command_args", "stop requires one actor id or --all.", { field: "stop" });
    }
    return { verb: "stop", actorId: rest[0]! };
  }

  throw new SubagentError("invalid_command_args", `Unknown subcommand: ${verb}.`, { field: "subcommand" });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(ctx: ExtensionContext, error: unknown): void {
  if (error instanceof SubagentError) {
    ctx.ui.notify(`${error.code}: ${error.message}`, "error");
    return;
  }
  ctx.ui.notify(messageOf(error), "error");
}

function describeStop(result: StopResult): string {
  if (result.ok) {
    if (result.status === "idle" || result.status === "stopped") return `${result.id} has no running job.`;
    return `Stop requested: ${result.id} (${result.status})`;
  }
  switch (result.reason) {
    case "already_finished": return `${result.id} already finished.`;
    case "stopping": return `${result.id} is already stopping.`;
    case "finalizing": return `${result.id} is finalizing.`;
    case "budget_exceeded": return `${result.id} was stopped by its budget.`;
    default: return `Stop refused: ${result.id} (${result.status}).`;
  }
}

/** Request cancellation for every running Job and summarize immediately. */
function stopAll(service: RootService): string {
  const running = service.runtime.jobs().jobs.filter((job) => job.status === "running");
  if (running.length === 0) return "No running jobs.";
  const outcomes = running.map((job) => {
    try {
      const result = service.runtime.cancelJob(job.jobId);
      return { agentId: job.agentId, ok: result.ok, reason: result.reason, failure: null as string | null };
    } catch (error) {
      return { agentId: job.agentId, ok: false, reason: undefined, failure: messageOf(error) };
    }
  });
  const requested = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.filter((outcome) => outcome.failure !== null).length;
  const refused = outcomes.length - requested - failed;
  const lines = outcomes.map((outcome) => outcome.failure !== null
    ? `  failed     ${outcome.agentId}: ${outcome.failure}`
    : `  ${outcome.ok ? "requested" : (outcome.reason ?? "refused")}  ${outcome.agentId}`);
  return [
    `Stop results for ${outcomes.length} job(s): ${requested} requested, ${refused} refused, ${failed} failed`,
    ...lines,
  ].join("\n");
}

async function showList(
  service: RootService,
  command: Extract<SubagentCommand, { verb: "list" }>,
  ctx: ExtensionContext,
): Promise<void> {
  const filter: { all?: boolean; id?: string } = {};
  if (command.all) filter.all = true;
  if (command.id !== null) filter.id = command.id;
  const tree = await service.list(filter, "Main");
  // The listing may have taken an await. Re-check ownership on the same
  // service before reading anything else: a retired root must not be read.
  try {
    service.assertOperational();
  } catch {
    ctx.ui.notify("Root changed while listing; run /subagent again.", "info");
    return;
  }
  const actors = service.runtime.list().agents;
  const jobs = service.runtime.jobs().jobs;
  const roles = new Map(actors.map((agent) => [agent.agentId, service.actors.get(agent.agentId)?.roleId ?? null]));
  const text = renderSubagentList({
    root: service.sessionId.slice(0, 8),
    tree,
    actors,
    jobs,
    roles,
    historyDir: tree?.historyDir ?? null,
  });
  ctx.ui.notify(text, "info");
}

/**
 * Every live session under this socket root, with the managed socket address of
 * its Main. A user pastes that address into another session to let its agents
 * reach this one; the model never receives this catalog on its own.
 */
function renderSessions(sessions: readonly LiveSession[], currentSessionId: string): string {
  if (!crossSessionSupported()) {
    return "Cross-session discovery is not available on this platform yet (POSIX only).";
  }
  const lines = [`Live sessions (${sessions.length}):`];
  if (sessions.length === 0) lines.push("  none");
  for (const session of sessions) {
    const marker = session.sessionId === currentSessionId ? "*" : " ";
    const name = session.name === null ? "(unnamed)" : session.name;
    lines.push(`${marker} ${session.uid}  ${name}  pid ${session.pid}  ${session.cwd}`);
    lines.push(`    session ${session.sessionId}`);
    lines.push(`    main: ${sessionMainAddress(session)}`);
  }
  return lines.join("\n");
}

async function run(raw: string, ctx: ExtensionContext, current: (ctx: ExtensionContext) => Promise<RootService>): Promise<void> {
  let command: SubagentCommand;
  try {
    command = parseCommand(raw);
  } catch (error) {
    report(ctx, error);
    return;
  }

  let service: RootService;
  try {
    service = await current(ctx);
  } catch (error) {
    report(ctx, error);
    return;
  }

  try {
    if (command.verb === "list") {
      await showList(service, command, ctx);
      return;
    }
    if (command.verb === "stop") {
      ctx.ui.notify(describeStop(service.stop(command.actorId)), "info");
      return;
    }
    if (command.verb === "sessions") {
      ctx.ui.notify(renderSessions(await service.listSessions(), service.sessionId), "info");
      return;
    }
    ctx.ui.notify(stopAll(service), "info");
  } catch (error) {
    report(ctx, error);
  }
}

/** Register the command on one Pi extension API. */
export function installSubagentCommand(
  api: ExtensionAPI,
  current: (ctx: ExtensionContext) => Promise<RootService>,
): void {
  api.registerCommand("subagent", {
    description: "Inspect subagents of the current root, stop them, and list live sessions",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "list", label: "list", description: "Show the subagent tree" },
        { value: "stop", label: "stop", description: "Stop one actor or --all" },
        { value: "sessions", label: "sessions", description: "List live sessions and their cross-session addresses" },
      ].filter((item) => item.value.startsWith(prefix.trim()));
      return items.length === 0 ? null : items;
    },
    handler: async (raw, ctx) => {
      await run(raw, ctx, current);
    },
  });
}
