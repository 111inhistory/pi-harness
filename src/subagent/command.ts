/**
 * `/subagent` command: the user-facing read/control entry for the current root.
 *
 * The command owns argument parsing, service resolution and error reporting.
 * Rendering lives in `status-view.ts`; state changes go through `RootService`
 * only. It never sends a message to a subagent or a peer session:
 * `sessions connect` only appends local context to the current conversation.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RootService } from "./root-service.ts";
import type { SessionConnect } from "./session-peers.ts";
import { SubagentError, type SignalAction, type SignalResult } from "./runtime.ts";
import { renderSubagentList } from "./status-view.ts";
import { type LiveSession } from "./session-directory.ts";
import { formatAddress, MAIN_ACTOR } from "./address.ts";

export type SubagentCommand =
  | { readonly verb: "list"; readonly all: boolean; readonly id: string | null }
  | { readonly verb: SignalAction; readonly target: string }
  | { readonly verb: "sessions" }
  | { readonly verb: "sessionsConnect"; readonly target: string };

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
          throw new SubagentError("invalid_command_args", "list --id requires an agent id.", { field: "id" });
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
    const [action, ...args] = rest;
    if (action === undefined) return { verb: "sessions" };
    if (action !== "connect") {
      throw new SubagentError("invalid_command_args", `Unknown sessions action: ${action}.`, { field: "sessions" });
    }
    const target = args.length === 1 ? args[0]!.trim() : "";
    if (target === "" || target.startsWith("-")) {
      throw new SubagentError("invalid_command_args", "sessions connect requires one live session uid or session id.", { field: "sessions" });
    }
    return { verb: "sessionsConnect", target };
  }

  if (verb === "interrupt" || verb === "stop") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) {
      throw new SubagentError("invalid_command_args",
        `${verb} requires one target: an agent id, a full logical address, main or children.`, { field: verb });
    }
    return { verb, target: rest[0]! };
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

function refusal(target: { readonly address: string; readonly status: string; readonly reason?: string }): string {
  switch (target.reason) {
    case "already_finished": return `${target.address} already finished.`;
    case "stopping": return `${target.address} is already stopping.`;
    case "finalizing": return `${target.address} is finalizing.`;
    case "budget_exceeded": return `${target.address} was stopped by its budget.`;
    case "interrupt_unsupported": return `${target.address} cannot be interrupted by this execution; nothing changed.`;
    default: return `Signal refused: ${target.address} (${target.status}).`;
  }
}

function describeSignal(result: SignalResult): string {
  const [only] = result.targets;
  if (result.targets.length === 1 && only !== undefined) {
    if (!only.ok) return refusal(only);
    if (only.status === "idle") return `${only.address} has no running job.`;
    if (result.action === "interrupt") return `Interrupted: ${only.address} (${only.status})`;
    return `Stop requested: ${only.address} (${only.status})`;
  }
  const ok = result.targets.filter((target) => target.ok).length;
  const lines = result.targets.map((target) => target.ok
    ? `  ${result.action === "interrupt" ? "interrupted" : "requested"}  ${target.address} (${target.status})`
    : `  refused    ${refusal(target)}`);
  return [
    `Signal ${result.action} for ${result.targets.length} agent(s): ${ok} accepted, ${result.targets.length - ok} refused`,
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
  const tree = await service.list(filter, MAIN_ACTOR);
  // The listing may have taken an await. Re-check ownership on the same
  // service before reading anything else: a retired root must not be read.
  try {
    service.assertCurrent();
  } catch {
    ctx.ui.notify("Root changed while listing; run /subagent again.", "info");
    return;
  }
  const actors = service.runtime.list().agents;
  const text = renderSubagentList({
    root: service.sessionId.slice(0, 8),
    tree,
    actors,
    models: new Map(actors.map(actor => [actor.agentId, service.actors.get(actor.agentId)?.modelRef?.id ?? "-"])),
  });
  ctx.ui.notify(text, "info");
}

/**
 * Every live session under this socket root, with the logical Main address the
 * model writes to. A user pastes that address into another session to let its
 * agents reach this one; the model never receives this catalog on its own.
 */
function renderSessions(sessions: readonly LiveSession[], currentSessionId: string): string {
  const lines = [`Live sessions (${sessions.length}):`];
  if (sessions.length === 0) lines.push("  none");
  for (const session of sessions) {
    const marker = session.sessionId === currentSessionId ? "*" : " ";
    const name = session.name === null ? "(unnamed)" : session.name;
    lines.push(`${marker} ${session.uid}  ${name}  pid ${session.pid}  ${session.cwd}`);
    lines.push(`    session ${session.sessionId}`);
    lines.push(`    main: ${formatAddress(session.uid, MAIN_ACTOR)}`);
  }
  return lines.join("\n");
}

/** The result of a user-issued connect, as the command reports it. */
function renderConnect(result: SessionConnect): string {
  const label = result.session.name === null
    ? result.session.uid
    : `${result.session.uid} (${result.session.name})`;
  const grant = result.alreadyEnabled.includes("msg_write") ? "already enabled" : "enabled";
  return [
    `Connected ${label} at ${result.session.cwd}`,
    `main: ${result.address}`,
    `msg_write: ${grant}`,
  ].join("\n");
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
    if (command.verb === "interrupt" || command.verb === "stop") {
      ctx.ui.notify(describeSignal(await service.signal(command.target, command.verb, MAIN_ACTOR)), "info");
      return;
    }
    if (command.verb === "sessions") {
      ctx.ui.notify(renderSessions(await service.listSessions(), service.sessionId), "info");
      return;
    }
    const result = await service.connectSession(command.target);
    ctx.ui.notify(renderConnect(result), "info");
  } catch (error) {
    report(ctx, error);
  }
}

/** Register the command on one Pi extension API. */
export function installSubagentCommand(
  api: ExtensionAPI,
  current: (ctx: ExtensionContext) => Promise<RootService>,
  sessionCandidates: () => Promise<readonly LiveSession[]>,
  activeRoot: () => RootService | null,
): void {
  api.registerCommand("subagent", {
    description: "Inspect agent activity, interrupt or stop agents, list live sessions, and connect one",
    getArgumentCompletions: async (prefix) => {
      const text = prefix.trimStart();
      const listTarget = /^list\s+--id\s+(\S*)$/.exec(text);
      const signalTarget = /^(interrupt|stop)\s+(\S*)$/.exec(text);
      if (listTarget || signalTarget) {
        const fragment = (listTarget?.[1] ?? signalTarget?.[2] ?? '').toLowerCase();
        const command = signalTarget?.[1] ?? 'list --id';
        const root = activeRoot();
        const actors = root?.runtime.list(signalTarget ? { status: 'running' } : null).agents ?? [];
        const items = actors.filter(actor => actor.agentId.startsWith(fragment)).map(actor => ({
          value: `${command} ${actor.agentId}`, label: actor.agentId,
        }));
        if (signalTarget && 'children'.startsWith(fragment)) {
          items.unshift({ value: `${command} children`, label: 'children' });
        }
        return items.length > 0 ? items : null;
      }
      const flag = /^list\s+(--\S*)$/.exec(text);
      if (flag !== null) {
        const items = [
          { value: 'list --all', label: '--all', description: 'Expand the whole tree' },
          { value: 'list --id ', label: '--id', description: 'Show one Agent and its children' },
        ].filter(item => item.label.startsWith(flag[1]!));
        return items.length > 0 ? items : null;
      }
      const action = /^sessions\s+(\S*)$/.exec(text);
      if (action !== null) {
        return "connect".startsWith(action[1]!)
          ? [{ value: "sessions connect ", label: "connect", description: "Append a live session's contact information and enable msg_write" }]
          : null;
      }
      const target = /^sessions\s+connect\s+(\S*)$/.exec(text);
      if (target !== null) {
        const fragment = target[1]!.toLowerCase();
        const sessions = await sessionCandidates();
        const items = sessions.filter(session =>
          session.uid.toLowerCase().startsWith(fragment)
          || session.sessionId.toLowerCase().startsWith(fragment)
          || session.name?.toLowerCase().includes(fragment))
          .map(session => ({
            value: `sessions connect ${session.uid}`,
            label: session.name === null ? session.uid : `${session.uid} · ${session.name}`,
            description: `${session.cwd} · ${session.sessionId}`,
          }));
        return items.length === 0 ? null : items;
      }
      const items = [
        { value: "list", label: "list", description: "Show the agent tree with live activity" },
        { value: "interrupt", label: "interrupt", description: "Cancel one agent's current native run, keep its Job" },
        { value: "stop", label: "stop", description: "End one agent's current Job, keep the Agent" },
        { value: "sessions", label: "sessions", description: "List live sessions and their cross-session addresses" },
      ].filter((item) => item.value.startsWith(prefix.trim()));
      return items.length === 0 ? null : items;
    },
    handler: async (raw, ctx) => {
      await run(raw, ctx, current);
    },
  });
}
