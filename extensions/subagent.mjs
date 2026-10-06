/**
 * Subagent Pi extension.
 *
 * Registers model-facing `task` and `hub`, creates real Fresh/Inherited Pi
 * child sessions, enforces the two-level 4x4 topology, wires every Job Budget
 * into the Provider preflight and monotonic-time abort path, and connects the
 * runtime's message routing to native Pi message APIs.
 *
 * Routing:
 * - A Fresh Job's role, chat model, thinking level and tool allowlist are
 *   chosen by `src/subagent-routing.mjs` (two native Jev classifications)
 *   inside the Job itself, before its session exists, on the Job's own Budget.
 *   The caller supplies only the batch `context` and the `task` text. The
 *   resolved role, model and effective loadout are recorded in the actor's
 *   persisted record, so a revival reuses them and never reroutes; an actor
 *   whose routing never completed may route once on a later explicit message.
 * - Inherited Jobs keep the parent snapshot's model, thinking level, prompt
 *   and conversation; they never route.
 *
 * Messaging:
 * - `read`/`write` protocol support comes from the shared protocol installer:
 *   this extension registers the `agent` and `history` readers plus the
 *   `agent` writer for every surface (host = Main, each child = its agent).
 * - The writer binds the sender to the surface owner, so a child cannot spoof
 *   Main or a peer; `agent://all` is write-only and fans out to the sender's
 *   direct children through the runtime.
 * - A running child receives a message through native steering; a message that
 *   arrives between turns is delivered by that Job's own end-of-turn loop, so
 *   every message reaches the session exactly once and consumed steering is
 *   never replayed.
 * - A queued child receives its messages when the Job starts; an idle child is
 *   revived with a NEW Job (`continuedFromJobId`) rebuilt on its retained
 *   native session — or, when its first Job never ran at all (cancelled while
 *   queued), on the original seed that Job carries, so a never-started actor
 *   still gets its assignment and its first native session. The conversation
 *   continues with a fresh Budget and the original `agent://` result stays
 *   immutable.
 * - Job completion notifies its creator once, as a typed `agent-completion`
 *   native custom message: the root session receives it durably without
 *   starting a turn, a child creator receives it in its own conversation.
 *   Completion never creates a Job and never wakes an idle actor; only an
 *   explicit message does.
 *
 * History:
 * - Each Job's `history://` transcript is collected from the append-only
 *   SessionManager entry tree between the Job's start boundary and its current
 *   leaf, so native compaction neither truncates nor duplicates a Job's own
 *   messages. The recorded native entry ids are persisted with the rest of the
 *   registry state, so a restored Job's slice stays sealed at the leaf it
 *   reached instead of growing with a later continuation.
 *
 * Persistence (src/subagent-storage.mjs):
 * - The root session's active branch carries `subagent-state` custom entries
 *   (`pi.appendEntry`), each one JSON-safe checkpoint of the runtime registry
 *   plus the actor records; inherited snapshots are stored once as a native
 *   seeded session file and referenced from then on.
 * - Every actor owns one native Pi session file under
 *   `<agentDir>/subagent-sessions/<rootSessionId>/<agentId>.jsonl`; a record
 *   also carries the actor's native leaf anchor, so restarting from an earlier
 *   root branch (or a checkpoint) continues exactly the conversation that
 *   branch saw instead of turns a later branch appended. Restoring an anchor
 *   uses native tree navigation, which leaves the newer turns as an abandoned
 *   child branch.
 * - Jobs that were queued, running or stopping when the process went away are
 *   restored as explicitly failed interrupted Jobs: side effects are never
 *   rerun, and their history is sealed at the actor's checkpoint anchor.
 * - A checkpoint is the authoritative recovery point. Leaf anchors, per-Job
 *   history bounds and the recorded assignment are committed at every finalized
 *   native message — including a Job's first user message, before its provider
 *   request is dispatched — so an interrupted run recovers the progress it
 *   actually committed. Native turns a child file appended after the last
 *   checkpoint stay in that file as an abandoned child branch; recovery does
 *   not adopt them and never guesses from file order.
 * - Leaving a root session (reload, new, resume, fork, tree navigation) retires
 *   the old service and waits for every pending Job's native run to exit before
 *   the restored runtime is exposed, so two runs can never share one actor.
 * - A memory-only SDK root stays memory-only: no checkpoint entries are
 *   appended and no session files are written for it.
 *
 * The extension still does not implement blocking or schema output validation.
 */

import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { join } from "node:path";

import { SubagentError, copyInheritedEntries, createSubagentRuntime, parseProtocolRef } from "../src/subagent-runtime.mjs";
import { captureInheritedContext } from "../src/inherited-context.mjs";
import { installModelCallBudget } from "../src/pi-job-budget.mjs";
import { routeSubagent } from "../src/subagent-routing.mjs";
import { SUBAGENT_SESSIONS_DIR, createSubagentStore, SubagentStoreError } from "../src/subagent-storage.mjs";
import capabilityExtension from "./capability.mjs";
import {
  createAgentSocketServer,
  createBroadcastSocketServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
} from "../src/subagent-socket.mjs";
import {
  appendCleanJsonl,
  writeCompactedSummary,
  getSubagentHistoryPaths,
} from "../src/subagent-history.mjs";

const MAX_CONCURRENCY = 4;
const MAX_AGENT_DEPTH = 2;
const HARNESS_TOOLS = ["create", "task", "list", "stop", "hub", "capability"];
const ROOT_HARNESS_TOOLS = ["list", "stop", "hub", "capability"];
const MESSAGE_CUSTOM_TYPE = "agent-message";
const COMPLETION_CUSTOM_TYPE = "agent-completion";
/** Reserved broadcast target; `all` is never an actor identity. */
const BROADCAST_ACTOR_ID = "all";
/** Job statuses that never reached a terminal state in their own process. */
const LIVE_JOB_STATUSES = new Set(["queued", "running", "stopping"]);

const taskParameters = {
  type: "object",
  properties: {
    context: {
      type: "string",
      description: "Explicit background shared by every task in this batch.",
    },
    tasks: {
      type: "array",
      minItems: 1,
      description: "Independent tasks. Order is preserved in the result, but it does not create execution dependencies.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller-facing label; defaults to none." },
          task: { type: "string", description: "Self-contained instruction for this subagent." },
          inheritContext: {
            type: "boolean",
            description: "Create an Inherited Subagent from this session's context snapshot instead of a Fresh Subagent.",
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

const hubParameters = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["list", "jobs", "cancel"],
      description: "list: agents and their status. jobs: job snapshot. cancel: cancel one job.",
    },
    status: {
      type: "string",
      enum: ["running", "idle"],
      description: "Only for op \"list\": keep agents in this status.",
    },
    jobIds: {
      type: "array",
      items: { type: "string" },
      description: "Only for op \"jobs\": restrict the snapshot to these job IDs.",
    },
    jobId: { type: "string", description: "Only for op \"cancel\": the job to cancel." },
  },
  required: ["op"],
  additionalProperties: false,
};

export default function subagentExtension(pi) {
  /**
   * One extension instance serves one process, but the root session it belongs
   * to can be replaced (new/resume/fork), reloaded, or re-branched. The
   * controller owns the *current* per-session service; everything registered
   * here resolves it at call time, so a retired service can never answer for
   * the session that replaced it — and a replacement is only exposed after the
   * retired service's native runs have actually exited.
   */
  const controller = {
    pi,
    agentDir: getAgentDir(),
    settings: new Map(),
    /** Root-session service, rebuilt by session_start / the lazy entry. */
    service: null,
    /** In-flight retirement, so a replacement can wait for real quiescence. */
    retirement: null,
    /** In-flight activation, so concurrent entries share one service. */
    activation: null,
  };
  pi.on("session_start", async (_event, ctx) => {
    await activateRootSession(controller, ctx);
  });
  // Tree navigation moves the active branch without replacing the session.
  // Checkpoints are branch-scoped, so the registry follows the new branch.
  pi.on("session_tree", async (_event, ctx) => {
    await activateRootSession(controller, ctx);
  });
  pi.on("session_shutdown", async () => {
    await retireService(controller);
  });
  installSessionSurface(pi, (ctx) => rootService(controller, ctx), { allowInherited: true, parentAgentId: null, depth: 0 });
  installSocketAwareWrite(pi);
}

function installSocketAwareWrite(pi) {
  if (typeof pi.getAllTools !== "function") return;
  const tools = pi.getAllTools();
  const writeTool = tools.find((t) => t?.name === "write");
  if (writeTool && typeof writeTool.execute === "function" && !writeTool._socketAware) {
    const originalExecute = writeTool.execute;
    writeTool.execute = async function (toolCallId, params, signal, onUpdate, ctx) {
      if (typeof params?.path === "string" && params.path.endsWith(".sock")) {
        const targetPath = params.path.startsWith("/") ? params.path : join(ctx?.cwd || process.cwd(), params.path);
        await writeSocketOneWay(targetPath, params.content);
        return {
          content: [{ type: "text", text: `Successfully delivered message to socket ${params.path}` }],
        };
      }
      return originalExecute.call(this, toolCallId, params, signal, onUpdate, ctx);
    };
    writeTool._socketAware = true;
  }
}

/**
 * The service of the current root session, created on first use.
 *
 * `session_start` normally builds it; the lazy path covers hosts that call
 * tools before the start event reached this extension. A service is never
 * shared with a different root session: the previous one is retired first, and
 * a caller that arrives while a replacement is being built waits for it.
 */
async function rootService(controller, ctx) {
  const service = controller.service;
  if (service !== null && service.active) return service;
  return activateRootSession(controller, ctx);
}

/**
 * Build a fresh service for the session in `ctx`, after the previous one has
 * quiesced. Concurrent entries share one activation instead of retiring each
 * other's service.
 */
async function activateRootSession(controller, ctx) {
  const inFlight = controller.activation;
  if (inFlight !== null) return inFlight;
  const run = (async () => {
    await retireService(controller);
    const service = createService(controller, ctx);
    controller.service = service;
    restoreService(service, ctx);
    return service;
  })();
  controller.activation = run.finally(() => {
    controller.activation = null;
  });
  return controller.activation;
}

/**
 * Retire the current service: no callback of its runtime may touch a later
 * session's state, its protocol reads/writes fail with `runtime_closed`, and
 * this resolves only once every live Job's native run has exited. Suppressing
 * callbacks is not quiescence — a native run that is still streaming could
 * otherwise append to the same child session a restored runtime is about to
 * continue.
 */
async function retireService(controller) {
  const service = controller.service;
  if (service === null) return controller.retirement ?? undefined;
  controller.service = null;
  service.active = false;
  service.closed = true;

  if (service.socketServers) {
    for (const server of service.socketServers.values()) {
      try {
        await server.close();
      } catch {
        // ignore close error during retirement
      }
    }
    service.socketServers.clear();
  }
  // Every Job that has not reached a terminal state — queued, running or
  // stopping. A queued one ends immediately; a running one keeps its slot until
  // the adapter's native run settles.
  const jobIds = service.runtime
    .jobs()
    .jobs.filter((job) => LIVE_JOB_STATUSES.has(job.status))
    .map((job) => job.jobId);
  for (const jobId of jobIds) {
    try {
      service.runtime.cancelJob(jobId);
    } catch {
      // Already terminal: nothing to stop.
    }
  }
  const retirement = (async () => {
    try {
      await Promise.all(jobIds.map((jobId) => service.runtime.jobDone(jobId)));
    } catch {
      // Every Job still settles through its own handle; a failed wait here must
      // not leave a later session without its retirement record.
    } finally {
      service.retained.clear();
      service.liveJobs.clear();
    }
  })();
  controller.retirement = retirement;
  return retirement;
}

/** One root session's runtime, storage and retained actor records. */
function createService(controller, ctx) {
  const service = {
    controller,
    agentDir: controller.agentDir,
    settings: controller.settings,
    active: true,
    closed: false,
    /** False until the restored registry is adopted, so mid-restore state is never saved. */
    ready: false,
    /** Latched load failure: the extension fails closed instead of starting empty. */
    storageError: null,
    store: createStore(controller, ctx),
    /** Host UI, for reporting storage failures where the user can see them. */
    ui: ctx?.ui ?? null,
    /** Last checkpoint write failure; kept so it is never silently swallowed. */
    lastStorageError: null,
    /** Parent-session ModelRuntime, adopted through the checked bridge. */
    parentModelRuntime: null,
    /** Parent-session ModelRegistry, used by routing and model restore. */
    modelRegistry: ctx?.modelRegistry ?? null,
    /** Live runs by jobId: message hand-over goes through these sessions. */
    liveJobs: new Map(),
    /** Retained session descriptors, so an idle agent keeps its conversation. */
    retained: new Map(),
    /** Live Unix Domain Socket servers mapped by actor id or broadcast key. */
    socketServers: new Map(),
    runtime: null,
  };
  service.runtime = createSubagentRuntime({
    maxConcurrency: MAX_CONCURRENCY,
    startJob: (job) => startPiJob(service, job),
    deliverMessage: (request) => deliverMessage(service, request),
    deliverToMain: (message) => deliverToMain(service, message),
    // Checkpoints only exist on disk: a memory-only root runs without the hook
    // instead of exporting the whole registry state into a no-op callback.
    onStateChange: service.store.durable ? (state) => checkpoint(service, state) : undefined,
    readHistory: (request) => readNativeHistory(service, request),
  });
  // A revived actor can start a Job without any preceding `task` call in this
  // session, so the parent ModelRuntime is adopted here when the bridge is
  // available at all. A build without it fails the Job explicitly later.
  if (service.modelRegistry !== null) {
    try {
      adoptParentModelRuntime(service, service.modelRegistry);
    } catch {
      // modelRuntimeFor() reports the explicit error when a Job needs it.
    }
  }
  return service;
}

/** Root-session storage: `subagent-state` entries plus per-actor session files. */
function createStore(controller, ctx) {
  const sessionManager = ctx?.sessionManager;
  const sessionFile = sessionManager?.getSessionFile?.();
  const sessionId = sessionManager?.getSessionId?.();
  const durable = typeof sessionFile === "string" && sessionFile !== "" && typeof sessionId === "string" && sessionId !== "";
  return createSubagentStore({
    sessionFile,
    cwd: ctx?.cwd ?? process.cwd(),
    // A root session without a file is an explicit in-memory SDK host: its
    // subagents stay in memory too, and nothing is claimed durable.
    dir: durable ? join(controller.agentDir, SUBAGENT_SESSIONS_DIR, sessionId) : undefined,
    appendEntry: (customType, data) => controller.pi.appendEntry(customType, data),
    readBranch: () => sessionManager.getBranch(),
    // Every child-session read goes through the same native manager the rest of
    // Pi uses; the store never parses a session file itself.
    openSession: (file) => SessionManager.open(file),
  });
}

/** Adopt the persisted registry of this root session, or start empty. */
function restoreService(service, ctx) {
  let checkpoint;
  try {
    checkpoint = service.store.load();
  } catch (error) {
    return latchStorageError(service, ctx, error);
  }
  if (checkpoint === null) {
    service.ready = true;
    return;
  }
  let hydrated;
  try {
    hydrated = service.store.hydrate(checkpoint);
  } catch (error) {
    return latchStorageError(service, ctx, error);
  }
  try {
    // Actor records are a trust boundary of their own: a record whose id the
    // registry does not know would otherwise become permanent ghost state that
    // every later checkpoint re-exports. A registry the runtime itself cannot
    // read is left to restoreState below, which reports it precisely.
    const registry = hydrated.registry;
    const registered = Array.isArray(registry?.actors)
      ? new Set(
          registry.actors
            .filter((actor) => isPlainObject(actor) && typeof actor.agentId === "string")
            .map((actor) => actor.agentId),
        )
      : null;
    for (const [agentId, record] of Object.entries(hydrated.actors)) {
      if (registered !== null && !registered.has(agentId)) {
        throw new SubagentStoreError(
          "storage_corrupt",
          `Actor record ${agentId} does not match any actor of the persisted registry.`,
          { agentId },
        );
      }
      service.retained.set(agentId, restoreActor(service, agentId, record));
    }
    // Jobs that were live when the process went away become explicit failures
    // in restoreState; seal their history at the native leaf first, so the
    // slice a reader gets stays what that Job recorded.
    sealInterruptedHistory(service, hydrated.registry);
    // A Job killed during its first model call never observed its own turn
    // boundary, so the persisted assignment may already be in the native
    // transcript. The entries decide, not the last adapter observation: a
    // revival never restates an assignment the conversation holds.
    clearDeliveredAssignments(service, hydrated.registry);
    service.runtime.restoreState(hydrated.registry);
  } catch (error) {
    return latchStorageError(
      service,
      ctx,
      error instanceof SubagentStoreError
        ? error
        : new SubagentStoreError("storage_restore_failed", `The persisted subagent registry could not be restored: ${errorMessage(error)}`),
    );
  }
  service.ready = true;
  // The restored snapshot may already differ from disk (interrupted Jobs became
  // terminal failures), so write the post-restore state once.
  checkpointNow(service);
}

/**
 * Rebuild one actor's retained descriptor from its persisted record. The
 * conversation itself stays in its native session file, opened lazily by the
 * Job that continues it.
 *
 * The record is a version-1 storage object and is validated as one: a present
 * record with a missing or malformed field throws instead of being normalized,
 * because a dropped field would silently change who the actor is — a routed
 * identity would become a fresh one, a revival would land on a default model,
 * or a conversation would continue from an unknown position.
 */
function restoreActor(service, agentId, record) {
  if (!isPlainObject(record)) {
    throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} has no version-1 record object.`, { agentId });
  }
  const cwd = requiredActorText(agentId, record, "cwd");
  const sessionFile = requiredActorText(agentId, record, "sessionFile");
  if (record.leafId !== null && (typeof record.leafId !== "string" || record.leafId === "")) {
    // A version-1 checkpoint always records where the actor's conversation
    // stood. Without it, a later revival could continue from turns that belong
    // to an abandoned root branch, so refuse instead of guessing.
    throw new SubagentStoreError(
      "storage_corrupt",
      `Actor ${agentId} records a native session file but no leaf anchor; refusing to continue it from an unknown position.`,
      { agentId },
    );
  }
  const routed = requiredActorBoolean(agentId, record, "routed");
  const modelRef = restoreActorModel(agentId, record, routed);
  return {
    sessionManager: null,
    sessionFile,
    /** Native leaf of this actor's conversation as of the checkpoint. */
    anchor: typeof record.leafId === "string" ? record.leafId : null,
    cwd,
    trusted: requiredActorBoolean(agentId, record, "trusted"),
    allowInherited: requiredActorBoolean(agentId, record, "allowInherited"),
    systemPrompt: nullableActorText(agentId, record, "systemPrompt"),
    roleId: nullableActorText(agentId, record, "roleId"),
    roleInstructions: nullableActorText(agentId, record, "roleInstructions"),
    modelRef,
    model: resolveModel(service.modelRegistry, modelRef),
    // Any native thinking level, not only the routing levels: an inherited
    // actor carries its parent's level verbatim.
    thinkingLevel: nullableActorText(agentId, record, "thinkingLevel"),
    tools: restoreActorTools(agentId, record),
    assignment: nullableActorText(agentId, record, "assignment"),
    routed,
  };
}

/** A required non-empty text field of a version-1 actor record. */
function requiredActorText(agentId, record, field) {
  const value = record[field];
  if (typeof value === "string" && value !== "") return value;
  throw new SubagentStoreError(
    "storage_corrupt",
    `Actor ${agentId} records no valid ${field}; refusing to rebuild a partial identity.`,
    { agentId, field },
  );
}

/** A required boolean field of a version-1 actor record. */
function requiredActorBoolean(agentId, record, field) {
  const value = record[field];
  if (typeof value === "boolean") return value;
  throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
}

/** A nullable text field of a version-1 actor record. */
function nullableActorText(agentId, record, field) {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
}

/**
 * The model reference of a version-1 actor record. A routed actor must carry a
 * usable provider/id pair: without it a revival would silently continue the
 * conversation on whatever model the native session falls back to. A fresh
 * actor whose routing never settled legitimately records none — its first Job
 * routes again, on its own Budget. A recorded-but-malformed reference always
 * throws, so it can never degrade into either case.
 */
function restoreActorModel(agentId, record, routed) {
  const value = record.model;
  if (value === null || value === undefined) {
    if (!routed) return null;
    throw new SubagentStoreError(
      "storage_corrupt",
      `Routed actor ${agentId} records no model reference; refusing to continue it on a default model.`,
      { agentId },
    );
  }
  if (
    !isPlainObject(value) ||
    typeof value.provider !== "string" ||
    value.provider === "" ||
    typeof value.id !== "string" ||
    value.id === ""
  ) {
    throw new SubagentStoreError(
      "storage_corrupt",
      `Actor ${agentId} records a malformed model reference; refusing to continue its conversation on another model.`,
      { agentId },
    );
  }
  return { provider: value.provider, id: value.id };
}

/** The recorded tool loadout; a present value must be a list of tool names. */
function restoreActorTools(agentId, record) {
  const value = record.tools;
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed tool loadout.`, { agentId });
  }
  return [...value];
}

/**
 * The leaf a checkpoint may record for an actor: the native manager's leaf, but
 * only once its entries have reached the session file. Entries a native manager
 * still holds unflushed (a fresh conversation's first append, for example) must
 * never become a durable anchor — a dangling id would fail the next revival
 * instead of recreating a genuinely not-started conversation.
 */
function recordedAnchor(service, agentId, manager, fallback) {
  if (manager === null) return fallback ?? null;
  if (service.store.durable && !service.store.hasSessionFile(agentId)) return null;
  return manager.getLeafId() ?? null;
}

/** The native leaf an actor's conversation stands at, for the next checkpoint. */
function currentAnchor(service, agentId, descriptor) {
  return recordedAnchor(service, agentId, descriptor.sessionManager ?? null, descriptor.anchor ?? null);
}

function resolveModel(registry, modelRef) {
  if (modelRef === null) return null;
  try {
    return registry?.find?.(modelRef.provider, modelRef.id) ?? null;
  } catch {
    return null;
  }
}

function latchStorageError(service, ctx, error) {
  const wrapped =
    error instanceof SubagentStoreError
      ? error
      : new SubagentStoreError("storage_read_failed", `The persisted subagent registry could not be read: ${errorMessage(error)}`);
  service.storageError = wrapped;
  service.ready = true;
  try {
    ctx?.ui?.notify?.(`Subagent persistence is unavailable: ${wrapped.message} Reload the session to retry.`, "error");
  } catch {
    // A host without a UI still fails closed; the error surfaces on use.
  }
  return undefined;
}

/** Fail an operation explicitly instead of silently operating without state. */
function assertOperational(service) {
  if (service.storageError !== null) throw service.storageError;
  if (service.closed || !service.active) {
    throw new SubagentError("runtime_closed", "This subagent runtime is shutting down.");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Protocol surface for one session.
 *
 * Scheme handlers are bound to the surface owner: the writer's sender is the
 * surface owner (a child can never spoof Main or a peer), and the caller's
 * signal is forwarded so an aborted write never changes runtime state. The
 * service is resolved per call, so a root-session replacement is picked up
 * without reinstalling the surface.
 */
function protocolSurface(resolveService, parentAgentId) {
  const actorId = parentAgentId ?? "Main";
  const reader = async (uri, ctx) => {
    const service = await resolveService(ctx);
    assertOperational(service);
    const parsed = parseProtocolRef(uri);
    if (parsed === null) {
      throw new SubagentError(
        "invalid_ref",
        `${JSON.stringify(uri)} is not a supported subagent reference; use agent://, agent://<agentId> or history://<agentId>.`,
      );
    }
    const mainStatus = typeof ctx?.isIdle === "function" ? (ctx.isIdle() ? "idle" : "running") : undefined;
    return JSON.stringify(service.runtime.readProtocol(uri, { mainStatus }), null, 2);
  };
  const writer = async (uri, content, ctx, options) => {
    const service = await resolveService(ctx);
    assertOperational(service);
    const parsed = parseProtocolRef(uri);
    if (parsed !== null && parsed.kind === "broadcast") {
      // Write-only: fans out to the sender's direct children through the same
      // single-target send each child would get, and reports each recipient.
      return service.runtime.sendMessage({ from: actorId, to: BROADCAST_ACTOR_ID, content, signal: options?.signal });
    }
    if (parsed === null || parsed.kind !== "result") {
      throw new SubagentError(
        "invalid_ref",
        `Only agent://<agentId>, agent://Main and agent://all are writable; ${JSON.stringify(uri)} is not a message target.`,
      );
    }
    return service.runtime.sendMessage({ from: actorId, to: parsed.agentId, content, signal: options?.signal });
  };
  return { readers: { agent: reader, history: reader }, writers: { agent: writer } };
}

/**
 * Deliver a message to the root session through native Pi messaging.
 *
 * An explicit peer message may wake the root session. A Job completion is a
 * durable typed notification instead: it is appended to the context (immediately
 * when idle, at the end of the running turn otherwise) and never starts a turn,
 * so a finished subagent cannot trigger a new root run on its own.
 */
async function deliverToMain(service, message) {
  if (!service.active) return;
  if (message?.type === "completion") {
    service.controller.pi.sendMessage(
      {
        customType: COMPLETION_CUSTOM_TYPE,
        content: formatCompletion(message),
        display: true,
        details: completionDetails(message),
      },
      { triggerTurn: false },
    );
    return;
  }
  service.controller.pi.sendMessage(
    {
      customType: MESSAGE_CUSTOM_TYPE,
      content: formatPeerMessage(message),
      display: true,
      details: { from: message.from, to: "Main" },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * A completion keeps the same native custom-message path as a peer message, but
 * with its own type and without prompting: the runtime passes the creator's
 * live running Job id, or null when the creator is idle, queued or stopping. A
 * live creator gets the notice at the end of its current turn; an idle creator
 * gets it appended durably to its retained conversation, where its next normal
 * turn reads it. It never creates a Job, and it is attempted exactly once.
 */
async function deliverMessage(service, { agentId, jobId, message }) {
  if (!service.active) return { accepted: false, reason: "runtime_retired" };
  if (message?.type === "completion") {
    // The append is awaited: a rejected native append must stay inside the
    // completion's own one-attempt boundary instead of escaping as an
    // unhandled rejection from a discarded promise. Its outcome never affects
    // the Job that sent the notice.
    await appendCompletion(service, agentId, typeof jobId === "string" ? jobId : null, message);
    return { accepted: true, mode: "retained" };
  }
  return deliverToLiveJob(service, { agentId, jobId, message });
}

async function appendCompletion(service, agentId, jobId, message) {
  const content = formatCompletion(message);
  const details = completionDetails(message);
  const entry = { customType: COMPLETION_CUSTOM_TYPE, content, display: true, details };
  try {
    const live = jobId === null ? null : (service.liveJobs.get(jobId) ?? null);
    if (live?.session != null) {
      // Pi queues this behind the current turn, or appends it durably between
      // turns. A landed append moves the actor's leaf; checkpoint it right
      // here so a reload before any later mutation keeps the notice that was
      // written. A queued append lands at the end of the running turn and the
      // Job's later boundaries read the same manager, so it is checkpointed
      // there.
      const manager = service.retained.get(agentId)?.sessionManager ?? null;
      const before = manager?.getLeafId() ?? null;
      await live.session.sendCustomMessage(entry, { triggerTurn: false });
      const after = manager?.getLeafId() ?? null;
      if (after !== before) checkpointAppendedAnchor(service, agentId, after);
      return;
    }
    const retained = service.retained.get(agentId) ?? null;
    const sessionManager =
      retained?.sessionManager ??
      (service.store.durable ? SessionManager.open(service.store.childSessionFile(agentId)) : null);
    if (sessionManager === null) return;
    // A restored actor's file is opened just for this append: place the notice
    // where that checkpoint's conversation stands — never on a branch appended
    // afterwards — and record the new leaf so the next revival keeps it. Only a
    // conversation that already reached its file can carry a durable anchor;
    // a notice native storage has not flushed is not adopted either. An idle
    // actor's live manager takes the same checkpoint: without it the root
    // branch would keep the previous leaf and a reload would branch back
    // behind the notice that is already in the child session file.
    const durableAppend = service.store.durable && service.store.hasSessionFile(agentId);
    restoreChildLeaf(sessionManager, agentId, retained, null);
    const entryId = sessionManager.appendCustomMessageEntry(COMPLETION_CUSTOM_TYPE, content, true, details);
    if (durableAppend && typeof entryId === "string") checkpointAppendedAnchor(service, agentId, entryId);
  } catch {
    // A notification is attempted once: it is never queued, retried or replayed.
  }
}

/**
 * Checkpoint the anchor a completion append just moved its actor to. A live
 * manager's checkpoint reads its own current leaf through `currentAnchor()`,
 * while a restored descriptor takes the appended entry id directly. Both land
 * here only once the notice is in the actor's session file: an append native
 * storage has not flushed must not become a durable anchor, exactly like
 * `recordedAnchor()` decides for a live descriptor.
 */
function checkpointAppendedAnchor(service, agentId, anchor) {
  const retained = service.retained.get(agentId) ?? null;
  if (retained === null) return;
  if (!(service.store.durable && service.store.hasSessionFile(agentId))) return;
  if (typeof anchor !== "string" || anchor === "") return;
  retained.anchor = anchor;
  persistActors(service);
}

function ensureAgentSocketServer(service, agentId) {
  if (service.socketServers.has(agentId)) return;
  try {
    const server = createAgentSocketServer({
      id: agentId,
      onMessage: (msg) => {
        const content = typeof msg === "string" ? msg : msg?.content || JSON.stringify(msg);
        service.runtime
          ?.sendMessage({
            from: "Main",
            to: agentId,
            content,
          })
          .catch((err) => {
            service.ui?.notify?.(`Failed to deliver socket message to ${agentId}: ${err.message}`, "error");
          });
      },
      onError: (err) => {
        service.ui?.notify?.(`Socket error on ${agentId}: ${err.message}`, "error");
      },
    });
    service.socketServers.set(agentId, server);
  } catch {
    // Socket initialization error is non-fatal for session startup
  }
}

function ensureBroadcastSocketServer(service, parentId) {
  const normId = parentId || "main";
  const key = `broadcast:${normId}`;
  if (service.socketServers.has(key)) return;
  try {
    const server = createBroadcastSocketServer({
      parentId: normId,
      getDirectChildren: () => {
        const list = service.runtime?.list();
        const pId = normId === "main" || normId === "Main" ? null : normId;
        return (list?.agents ?? []).filter((a) => a.parentAgentId === pId).map((a) => a.agentId);
      },
      deliverMessage: (childId, msg) => {
        const content = typeof msg === "string" ? msg : msg?.content || JSON.stringify(msg);
        return service.runtime?.sendMessage({
          from: normId === "main" || normId === "Main" ? "Main" : normId,
          to: childId,
          content,
        });
      },
    });
    service.socketServers.set(key, server);
  } catch {
    // Broadcast socket initialization error is non-fatal
  }
}

const listParameters = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Optional subagent id to query a specific agent. Omit to list all agents.",
    },
  },
};

const stopParameters = {
  type: "object",
  required: ["id"],
  properties: {
    id: {
      type: "string",
      description: "The subagent id to stop.",
    },
  },
};

function installSessionSurface(pi, resolveService, { allowInherited, parentAgentId, depth }) {
  if (depth < MAX_AGENT_DEPTH) {
    pi.registerTool(createTool(pi, resolveService, { allowInherited, parentAgentId, depth }));
    pi.registerTool(taskTool(pi, resolveService, { allowInherited, parentAgentId, depth }));
  }
  pi.registerTool(listTool(resolveService));
  pi.registerTool(stopTool(resolveService));
  pi.registerTool(hubTool(resolveService));
}

function createTool(pi, resolveService, { allowInherited, parentAgentId, depth }) {
  return {
    name: "create",
    label: "Create Subagent",
    description:
      "Create subagents that run in the background (deferred). Returns unified short id (sub_01), communication socket path " +
      "and dual history file paths (summary.md and session.clean.jsonl). Message the subagent by writing to its socket.",
    parameters: taskParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = await resolveService(ctx);
      assertOperational(service);
      adoptParentModelRuntime(service, ctx.modelRegistry);
      service.modelRegistry = ctx.modelRegistry;
      const response = service.runtime.create(params, {
        parentAgentId,
        allowInherited,
        origin: {
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
          sessionId: ctx.sessionManager.getSessionId(),
          agentId: parentAgentId,
          mode: ctx.mode,
        },
        captureInheritedContext: () => captureContextForChild(pi, ctx, depth + 1),
      });
      return respond(response);
    },
  };
}

function listTool(resolveService) {
  return {
    name: "list",
    label: "List Subagents",
    description:
      "Query subagent status, budget usage, write socket path and dual history paths. Optionally filter by agent id.",
    parameters: listParameters,
    async execute(_toolCallId, params) {
      const service = await resolveService();
      assertOperational(service);
      const result = service.runtime.listDetailed(params);
      return respond(result);
    },
  };
}

function stopTool(resolveService) {
  return {
    name: "stop",
    label: "Stop Subagent",
    description:
      "Gracefully stop a running or queued subagent by id. Once stopped, its dual history files are flushed and ready to read. " +
      "Writing a message to its socket later will revive it.",
    parameters: stopParameters,
    async execute(_toolCallId, params) {
      const service = await resolveService();
      assertOperational(service);
      const result = service.runtime.stop(params.id);
      return respond(result);
    },
  };
}

function taskTool(pi, resolveService, { allowInherited, parentAgentId, depth }) {
  return {
    name: "task",
    label: "Task",
    description:
      "Create subagents that run in the background (deferred). Validates the whole batch first and registers it atomically; " +
      "each registered entry gets a stable agentId and jobId, in input order. The subagent's role, model, thinking level and " +
      "tools are chosen automatically; the caller supplies only context and the task text. Results are read later through " +
      "agent://<agentId> and history://<agentId> (or hub jobs). Message a running or idle agent with write agent://<agentId> " +
      "(agent://Main reaches this session, agent://all reaches this agent's direct children); an idle recipient is revived with " +
      "a new Job that continues its conversation, while an agent that is still stopping its previous run rejects the write with " +
      "agent_busy. Completion does not start a new parent turn, and this tool does not touch work items.",
    parameters: taskParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = await resolveService(ctx);
      assertOperational(service);
      adoptParentModelRuntime(service, ctx.modelRegistry);
      service.modelRegistry = ctx.modelRegistry;
      const response = service.runtime.task(params, {
        parentAgentId,
        allowInherited,
        origin: {
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
          sessionId: ctx.sessionManager.getSessionId(),
          agentId: parentAgentId,
          mode: ctx.mode,
        },
        // The warning for non-transplantable parent tools is generated here, at
        // capture time, and rides the snapshot: the runtime reports it on the
        // entry and job views, and persistence carries it to a revival.
        captureInheritedContext: () => captureContextForChild(pi, ctx, depth + 1),
      });
      return respond(response);
    },
  };
}

function hubTool(resolveService) {
  return {
    name: "hub",
    label: "Hub",
    description:
      "Coordinate subagents. list: agents with their status. jobs: queued/running/stopping/terminal job snapshot, optionally filtered " +
      "by jobIds. cancel: cancel one queued or running job without cancelling its siblings or parent; a cancelled running job keeps " +
      "its slot until its native run exits.",
    parameters: hubParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = await resolveService(ctx);
      assertOperational(service);
      const { op } = params;
      if (op === "list") {
        if (params.jobId !== undefined || params.jobIds !== undefined) {
          throw new SubagentError("invalid_request", "hub list does not accept jobId or jobIds.");
        }
        return respond(service.runtime.list(params.status === undefined ? undefined : { status: params.status }));
      }
      if (op === "jobs") {
        if (params.jobId !== undefined || params.status !== undefined) {
          throw new SubagentError("invalid_request", "hub jobs accepts only the optional jobIds filter.");
        }
        return respond(service.runtime.jobs(params.jobIds === undefined ? undefined : { jobIds: params.jobIds }));
      }
      if (op === "cancel") {
        if (typeof params.jobId !== "string" || params.jobId === "") {
          throw new SubagentError("invalid_request", "hub cancel requires a jobId.");
        }
        if (params.status !== undefined || params.jobIds !== undefined) {
          throw new SubagentError("invalid_request", "hub cancel accepts only jobId.");
        }
        const response = service.runtime.cancelJob(params.jobId);
        const text = response.ok
          ? response.job.status === "stopping"
            ? `Job ${params.jobId} is stopping; its cancelled payload is published when the native run exits.`
            : `Job ${params.jobId} cancelled.`
          : response.reason === "stopping"
            ? `Job ${params.jobId} is already stopping.`
            : `Job ${params.jobId} already finished with status "${response.job.status}".`;
        return respond({ ...response, message: text });
      }
      throw new SubagentError("invalid_request", `Unknown hub op "${String(op)}"; expected list, jobs or cancel.`);
    },
  };
}

function respond(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

// Tools registered by other extensions expose no execute handle publicly, so
// only built-in tools and the harness tools can be transplanted into a child.
// `capability` is part of the child harness surface (the child factory
// registers the capability extension in every child session).
function harnessToolsForDepth(depth) {
  return depth < MAX_AGENT_DEPTH ? HARNESS_TOOLS : ROOT_HARNESS_TOOLS;
}

function transplantableToolNames(pi, childDepth) {
  const names = new Set(harnessToolsForDepth(childDepth));
  for (const tool of pi.getAllTools()) {
    if (tool?.sourceInfo?.source === "builtin") names.add(tool.name);
  }
  return names;
}

/**
 * Tools the parent had active that Pi's public API cannot transplant into a
 * child session: tools contributed by other extensions expose no execute handle
 * a fresh session could re-register. The list is host-generated at capture
 * time and is what both the recorded warning and the child allowlist use.
 */
function droppedInheritedTools(pi, inheritedTools, childDepth) {
  const transplantable = transplantableToolNames(pi, childDepth);
  const dropped = [];
  for (const name of Array.isArray(inheritedTools) ? inheritedTools : []) {
    if (typeof name === "string" && name !== "" && !transplantable.has(name) && !dropped.includes(name)) dropped.push(name);
  }
  return dropped;
}

/**
 * The operator-facing form of a dropped-tool list. Inherited Subagents cannot
 * silently lose the parent's extension tools: the warning travels with the
 * captured snapshot, so it survives persistence and reaches the entry metadata
 * of the initial `task` response and of `hub jobs`.
 */
function inheritedToolsWarning(dropped) {
  return `Not transplantable through Pi's public API, so the inherited child does not have them: ${dropped.join(", ")}.`;
}

/**
 * Capture one inherited-context snapshot for a child at `childDepth`, with the
 * host-generated `warnings` for whatever the child cannot inherit.
 */
function captureContextForChild(pi, ctx, childDepth) {
  const snapshot = captureInheritedContext(pi, ctx);
  const dropped = droppedInheritedTools(pi, snapshot?.tools, childDepth);
  return dropped.length === 0 ? snapshot : { ...snapshot, warnings: [inheritedToolsWarning(dropped)] };
}

/**
 * The tool allowlist an Inherited Job starts with: the captured parent loadout
 * filtered to what Pi's public API can transplant, plus this depth's harness
 * tools. A Fresh Job's allowlist comes from the routed role (see
 * `routedToolNames`) and is resolved inside the Job, after routing.
 */
function inheritedToolNames(pi, snapshot, childDepth) {
  const dropped = new Set(droppedInheritedTools(pi, snapshot?.tools, childDepth));
  const tools = [];
  for (const name of Array.isArray(snapshot?.tools) ? snapshot.tools : []) {
    if (typeof name === "string" && name !== "" && !dropped.has(name) && !tools.includes(name)) tools.push(name);
  }
  for (const name of harnessToolsForDepth(childDepth)) {
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

/** The routed role's configured tools plus this depth's harness tools. */
function routedToolNames(roleTools, childDepth) {
  const tools = [];
  for (const name of Array.isArray(roleTools) ? roleTools : []) {
    if (typeof name === "string" && name !== "" && !tools.includes(name)) tools.push(name);
  }
  for (const name of harnessToolsForDepth(childDepth)) {
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

function settingsFor(service, cwd, trusted) {
  const key = `${cwd}\u0000${trusted}`;
  const cached = service.settings.get(key);
  if (cached) return cached;
  const settings = SettingsManager.create(cwd, service.agentDir, { projectTrusted: trusted });
  service.settings.set(key, settings);
  return settings;
}

/**
 * Child sessions and revived agents must run on the parent session's exact
 * ModelRuntime so extension-registered providers, virtual-model routing and
 * runtime credentials stay available. Pi 0.99 builds `new ModelRegistry(<session
 * runtime>)` (agent-session.js) and the compiled facade keeps that runtime as
 * the plain property `runtime`; there is no public accessor. This is the single
 * explicit compatibility boundary of this extension: when the bridge is
 * unavailable, the Job fails with an explicit error instead of silently
 * running on a fresh runtime that lost those registrations.
 */
function adoptParentModelRuntime(service, registry) {
  const candidate = registry?.runtime;
  const usable =
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.streamSimple === "function" &&
    typeof candidate.getAuth === "function" &&
    typeof candidate.getRegisteredProviderIds === "function";
  if (!usable) {
    throw new SubagentError(
      "model_runtime_unavailable",
      "this Pi build does not expose the session ModelRuntime through ModelRegistry.runtime, so subagent sessions " +
        "cannot reuse the parent session's provider registrations and virtual models; refusing to silently fall back " +
        "to a fresh runtime",
    );
  }
  service.parentModelRuntime = candidate;
}

function modelRuntimeFor(service) {
  if (service.parentModelRuntime === null) {
    throw new SubagentError(
      "model_runtime_unavailable",
      "No parent ModelRuntime was captured for this subagent runtime; refusing to silently fall back to a fresh runtime.",
    );
  }
  return service.parentModelRuntime;
}

function budgetFailure(terminal) {
  const code = terminal?.error?.code === "job_expired" ? "job_expired" : "budget_exceeded";
  const message = code === "job_expired" ? "Subagent job lifetime expired." : "Subagent execution budget exhausted.";
  return new SubagentError(code, message, terminal?.error?.detail ?? {});
}

function throwIfBudgetFailed(budget) {
  const terminal = budget.check().terminal;
  if (terminal?.status === "failed") throw budgetFailure(terminal);
}

/**
 * Watch this Job's Budget from the adapter between native events. The verdict
 * comes from the runtime's own observation point (`request.checkBudget`): an
 * expired lease must stop the Job through the runtime's stopping transition,
 * which cancels this handle — its cancelled/closed flags and the abort signals
 * the classification and the native run use. A local abort here would instead
 * leave `hub jobs` reporting a running Job while writes are still accepted
 * into a run that is already dying. The watcher itself only decides when to
 * look again; a terminal verdict ends it, and the Job's teardown releases it.
 */
function watchBudget(budget, checkBudget) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    if (checkBudget().terminal) return;
    const detail = budget.snapshot({ detail: true });
    const lifetimeRemaining = detail.profile.lifetimeMs - detail.elapsedMs;
    const activeRemaining = detail.running
      ? detail.profile.activeTimeMs.hard - detail.activeTimeMs
      : Number.POSITIVE_INFINITY;
    const delay = Math.max(1, Math.min(lifetimeRemaining, activeRemaining));
    timer = setTimeout(schedule, delay);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function startPiJob(service, request) {
  let session = null;
  let updateRetainedTools = null;
  // Teardown runs outside the run closure below, so the two operations it needs
  // — refresh the actor record from the finished session, then checkpoint it —
  // are handed back to this scope once the session exists.
  let finalizeActor = null;
  let unsubscribe = null;
  let unsubscribeBudget = null;
  let cancelled = false;
  // Job cancellation reaches the two routing classifications through this
  // signal, so an aborted Job never dispatches a classifier request.
  const abort = new AbortController();
  const isContinuation = request.continuedFromJobId !== null;
  // Normalized to null: `Map.get` answers undefined for an actor that never
  // started, and the descriptor checks below are written against null.
  const retained = isContinuation ? (service.retained.get(request.agentId) ?? null) : null;
  // Live hand-over state for this run. `pending` holds messages this Job owns
  // that have not reached the session yet; the end-of-turn loop below delivers
  // them exactly once. `steers` holds only the native steer calls that are in
  // flight right now: they are promises, not delivery records — the loop waits
  // for them before it may close the Job, because a steer that has not landed
  // yet must not be overtaken by the session dispose. There is no
  // acknowledgement bookkeeping: a message native steering took is owned by
  // that session and is never replayed.
  const live = { jobId: request.jobId, agentId: request.agentId, session: null, pending: [], steers: new Set(), closed: false };
  // Messages the runtime assigned to this Job (queued at start, or the trigger
  // of a revival Job) run first.
  for (const message of request.pendingMessages) {
    live.pending.push({ from: message.from, content: message.content, text: formatPeerMessage(message) });
  }
  service.liveJobs.set(request.jobId, live);
  // The runtime owns what an expired Budget does to the Job: checkBudget()
  // routes a hard failure through its stopping transition, which cancels this
  // handle — cancelled/closed plus both abort signals — once it is assigned.
  const stopBudgetWatch = watchBudget(request.budget, request.checkBudget);

  const done = (async () => {
    // A retired service must never start native work for a session that no
    // longer exists; its Jobs fail explicitly instead.
    if (!service.active || service.closed) {
      throw new SubagentError("runtime_closed", "This subagent runtime was retired; the Job was not started.");
    }
    // A continuation whose actor never started — a task cancelled while it was
    // still queued — rebuilds its first native session from the original seed;
    // an actor that already has a conversation ignores the seed entirely.
    const spec = request.spec;
    const seed = isContinuation ? (spec.seed ?? null) : spec;
    if (isContinuation && retained === null && seed === null) {
      throw new SubagentError(
        "continuation_unavailable",
        `No retained session and no original seed for ${request.agentId}; this agent cannot be revived.`,
      );
    }
    // Where this Job's identity and context come from: the actor's retained
    // record, or the initial seed of an actor that never started (its own
    // `task`, or the seed a continuation carries).
    const configSpec = retained === null ? seed : null;
    const snapshot = configSpec?.inheritedContext ?? null;
    const inherited = configSpec !== null && configSpec.inheritContext === true;
    const cwd = retained?.cwd ?? snapshot?.cwd ?? request.origin?.cwd ?? process.cwd();
    const trusted = retained === null ? request.origin?.trusted === true : retained.trusted;
    const settings = settingsFor(service, cwd, trusted);
    const modelRuntime = modelRuntimeFor(service);
    throwIfBudgetFailed(request.budget);

    // What this Job must restate: a first Job carries its own assignment, a
    // continuation carries whatever its conversation never recorded.
    let pendingAssignment = retained !== null ? (retained.assignment ?? null) : assignmentText(configSpec);

    // Identity the Job runs with. An Inherited Job keeps the captured parent
    // identity; a settled actor keeps the role/model/loadout already recorded;
    // only a Fresh Job whose routing never completed routes here, inside the
    // Job and on its own Budget.
    let identitySettled = retained !== null ? retained.routed : inherited;
    let roleId = retained?.roleId ?? null;
    let roleInstructions = retained?.roleInstructions ?? null;
    let systemPrompt = retained?.systemPrompt ?? (inherited && typeof snapshot?.systemPrompt === "string" ? snapshot.systemPrompt : null);
    let model = retained?.model ?? null;
    let thinkingLevel = retained?.thinkingLevel ?? null;
    let plannedTools = retained?.tools ?? null;
    if (retained !== null && retained.routed && retained.modelRef !== null && model === null) {
      throw new SubagentError(
        "model_unavailable",
        `The model ${retained.modelRef.provider}/${retained.modelRef.id} recorded for ${request.agentId} is not in the model ` +
          "catalog, so its conversation cannot continue on it.",
        { agentId: request.agentId, model: retained.modelRef },
      );
    }
    if (retained === null && inherited) {
      // The captured parent identity: same model, thinking level, prompt. An
      // Inherited Job never routes, and resolving the captured model through
      // the catalog keeps the same identity on a refreshed catalog entry.
      const captured = snapshot?.model ?? null;
      model = resolveModel(service.modelRegistry, modelRefOf(captured)) ?? captured;
      thinkingLevel = typeof snapshot?.thinkingLevel === "string" ? snapshot.thinkingLevel : null;
      plannedTools = inheritedToolNames(service.controller.pi, snapshot, request.depth);
      identitySettled = true;
    } else if (!identitySettled) {
      const routingSpec = retained !== null ? seed : configSpec;
      if (routingSpec?.inheritContext === true) {
        throw new SubagentError(
          "routing_unavailable",
          `An Inherited actor ${request.agentId} has no captured identity to continue from.`,
          { agentId: request.agentId },
        );
      }
      const routed = await routeSubagent({
        registry: service.modelRegistry,
        task: typeof routingSpec?.task === "string" ? routingSpec.task : "",
        context: typeof routingSpec?.context === "string" ? routingSpec.context : "",
        signal: abort.signal,
        budget: request.budget,
      });
      throwIfBudgetFailed(request.budget);
      roleId = routed.roleId;
      roleInstructions = routed.instructions;
      model = routed.model;
      thinkingLevel = routed.thinkingLevel;
      plannedTools = routedToolNames(routed.tools, request.depth);
      identitySettled = true;
    }

    const sessionManager = retained?.sessionManager ?? openChildSession(service, request.agentId, snapshot, cwd);
    restoreChildLeaf(sessionManager, request.agentId, retained, snapshot);
    const sessionFile = service.store.durable ? service.store.childSessionFile(request.agentId) : null;
    const allowInherited = retained === null ? configSpec.inheritContext !== true : retained.allowInherited;

    // What this agent is, written down before the first setup await a cancel
    // can land on: a write to this id must find a usable conversation even when
    // the run is stopped during resource loading or session creation. The
    // effective fields are refreshed as soon as the native session exists.
    const effective = { tools: null, model: null, thinkingLevel: null };
    // The descriptor is what a checkpoint persists for this actor: it is
    // written on its own at every message boundary (the runtime's checkpoint
    // then carries it) and followed by an explicit checkpoint only when the
    // mutation did not move runtime state.
    const writeDescriptor = () => {
      service.retained.set(request.agentId, {
        sessionManager,
        sessionFile,
        anchor: recordedAnchor(service, request.agentId, sessionManager, retained?.anchor ?? null),
        cwd,
        trusted,
        allowInherited,
        systemPrompt,
        roleId,
        roleInstructions,
        modelRef: modelRefOf(effective.model ?? model),
        model: effective.model ?? model,
        thinkingLevel: effective.thinkingLevel ?? thinkingLevel ?? null,
        tools: effective.tools ?? plannedTools,
        assignment: pendingAssignment,
        routed: identitySettled,
      });
    };
    const retain = () => {
      writeDescriptor();
      persistActors(service);
    };
    retain();

    const childFactory = {
      name: `subagent:${request.agentId}`,
      // One controlled surface per child: capability discovery and the
      // protocol wrappers first, then the task/hub tools for this depth.
      factory: (childPi) => {
        capabilityExtension(childPi);
        // A child surface always speaks for the service that created it, never
        // for a later root session.
        installSessionSurface(childPi, () => service, {
          // Inherited children must not create further Inherited Subagents.
          allowInherited,
          parentAgentId: request.agentId,
          depth: request.depth,
        });
      },
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: service.agentDir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [childFactory],
      // An Inherited child keeps the parent's system prompt; a Fresh child keeps
      // Pi's own prompt and appends the routed role's full instructions.
      ...(systemPrompt !== null ? { systemPrompt } : {}),
      ...(roleInstructions !== null ? { appendSystemPrompt: [roleInstructions] } : {}),
    });
    await resourceLoader.reload();
    throwIfBudgetFailed(request.budget);

    const created = await createAgentSession({
      cwd,
      agentDir: service.agentDir,
      settingsManager: settings,
      modelRuntime,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(plannedTools !== null && plannedTools.length > 0 ? { tools: plannedTools } : {}),
      sessionManager,
      resourceLoader,
    });
    throwIfBudgetFailed(request.budget);
    session = created.session;
    live.session = session;
    // The session's own loadout and model are what a revival must reuse:
    // capability activation opens tools during the run that the pre-run seed
    // never mentioned, and a run that was stopped still keeps them.
    effective.tools = activeToolNames(session);
    effective.model = session.model ?? null;
    effective.thinkingLevel = session.thinkingLevel ?? null;
    retain();
    updateRetainedTools = () => {
      const tools = activeToolNames(session);
      if (tools !== null) effective.tools = tools;
      writeDescriptor();
    };
    finalizeActor = () => {
      updateRetainedTools();
      retain();
    };
    unsubscribeBudget = installModelCallBudget(session, request.budget);

    if (cancelled) {
      await session.abort();
      return { result: "", messages: [] };
    }

    // This Job's history is scoped by the append-only SessionManager tree: the
    // boundary is the leaf at start, and native compaction appends entries
    // instead of rewriting or dropping them. The boundary is recorded before
    // the run so a Job that dies mid-turn still has a sealed start.
    const boundary = sessionManager.getLeafId();
    const jobMessages = () => messagesAfter(sessionManager, boundary);
    // Bounds only, and no empty transcript: a Job keeps no in-memory messages
    // until its final outcome, so every live read resolves the native entries.
    request.recordHistory(undefined, { startEntryId: boundary, endEntryId: boundary });

    ensureAgentSocketServer(service, request.agentId);
    ensureBroadcastSocketServer(service, request.origin?.agentId ?? null);

    const unsubscribeClean = session.subscribe((event) => {
      if (event?.type === "tool_call" || event?.type === "tool_result" || event?.type === "message_end") {
        appendCleanJsonl(request.agentId, event).catch(() => {});
      }
    });

    // Every finalized native message commits the Job's progress: the history
    // bounds move to the entry that just landed, and the actor record's leaf
    // anchor follows it (a custom message that never reaches the file never
    // becomes an anchor). The first user message therefore reaches the
    // checkpoint before the provider request it belongs to is dispatched, so an
    // interrupted run is recovered at what it actually committed rather than at
    // its startup state. One subscription per Job, released in the finally.
    unsubscribe = session.subscribe((event) => {
      if (event?.type !== "message_end" && event?.type !== "turn_end" && event?.type !== "agent_end") return;
      // The transcript is not copied here: readers and the final outcome
      // resolve it through the native session (the readHistory hook), so live
      // progress costs one descriptor refresh plus the moved bounds.
      updateRetainedTools?.();
      request.recordHistory(undefined, { startEntryId: boundary, endEntryId: sessionManager.getLeafId() });
    });

    // Messages this Job owns enter the first prompt; anything that arrives
    // while the run is live is steered natively or carried by the loop below.
    const assigned = live.pending.splice(0);
    if (isContinuation && assigned.length === 0) {
      throw new SubagentError("continuation_unavailable", `Continuation Job ${request.jobId} has no message to deliver.`);
    }
    const prompt = isContinuation
      ? composeContinuationPrompt(assigned, pendingAssignment)
      : composePrompt(pendingAssignment, assigned);
    // The assignment belongs to the conversation as soon as the session
    // recorded anything; until then a later revival must restate it.
    const markAssignmentDelivered = () => {
      if (pendingAssignment === null) return;
      if (messagesAfter(sessionManager, boundary).length === 0) return;
      pendingAssignment = null;
      retain();
    };

    try {
      throwIfBudgetFailed(request.budget);
      // Whatever the run then does — finish, fail or be stopped — its own
      // outcome decides the Job; the prompt submission itself is final.
      try {
        await session.prompt(prompt, { expandPromptTemplates: false });
      } finally {
        markAssignmentDelivered();
      }
      throwIfBudgetFailed(request.budget);
      if (cancelled) return cancelledOutcome(sessionManager, boundary);
      // A provider failure still resolves the native prompt, so success is
      // decided by this run's own output — never by an earlier Job's answer.
      const messages = jobMessages();
      assertRunCompleted(messages);
      await drainLiveMessages(live, sessionManager);
      throwIfBudgetFailed(request.budget);
      const finalResultText = readFinalText(jobMessages());
      writeCompactedSummary(
        request.agentId,
        {
          name: request.spec?.name,
          task: typeof request.spec?.task === "string" ? request.spec.task : "",
          role: roleId,
          model: modelRefOf(model)?.id ?? (typeof model === "string" ? model : null),
          budget: request.budget.snapshot(),
          result: finalResultText,
          status: "completed",
          round: isContinuation ? 2 : 1,
        },
        { append: isContinuation },
      ).catch(() => {});
      return {
        result: finalResultText,
        messages: readTranscript(entriesAfter(sessionManager, boundary)),
        history: { startEntryId: boundary, endEntryId: sessionManager.getLeafId() },
      };
    } catch (error) {
      // A cancelled run is reported as cancelled by the registry, not as a failure.
      if (cancelled) return cancelledOutcome(sessionManager, boundary);
      throwIfBudgetFailed(request.budget);
      throw error;
    }
  })().finally(() => {
    live.closed = true;
    service.liveJobs.delete(request.jobId);
    // A revival reuses the loadout the run actually ended with — capability
    // activation can open tools mid-run — never the pre-run allowlist.
    if (!service.closed) finalizeActor?.();
    stopBudgetWatch();
    unsubscribeClean?.();
    unsubscribeBudget?.();
    unsubscribe?.();
    session?.dispose();
  });

  return {
    cancel: () => {
      cancelled = true;
      live.closed = true;
      abort.abort();
      const pending = session?.abort();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    },
    done,
  };
}

/** The model identity a revival resolves through the catalog. */
function modelRefOf(model) {
  if (!model || typeof model !== "object") return null;
  if (typeof model.provider !== "string" || typeof model.id !== "string") return null;
  return { provider: model.provider, id: model.id };
}

/**
 * Point an actor's native conversation at the leaf its checkpoint recorded, so
 * a revival continues exactly the conversation that root branch saw. Without
 * this, a root session restored from an earlier branch would read turns a later
 * (abandoned) branch appended to the child file.
 *
 * Only a conversation that was rebuilt from persisted state is moved: a live
 * descriptor's manager already holds the authoritative leaf, and the anchor
 * would be a stale view of it. The anchor is the actor record's leaf; a
 * never-started actor anchors on the last entry of the seed it was created
 * from. Native tree navigation does the move (`branch`), which leaves any
 * recorded turns after that leaf in place as an abandoned child branch instead
 * of deleting or rewriting them.
 */
function restoreChildLeaf(sessionManager, agentId, retained, snapshot) {
  if (retained !== null && retained.sessionManager !== null) return;
  const anchor =
    retained !== null
      ? retained.anchor
      : snapshot !== null && Array.isArray(snapshot.entries) && snapshot.entries.length > 0
        ? snapshot.entries[snapshot.entries.length - 1].id
        : null;
  if (typeof anchor !== "string" || anchor === "") return;
  if (sessionManager.getLeafId() === anchor) return;
  if (sessionManager.getEntry(anchor) === undefined) {
    throw new SubagentError(
      "session_anchor_unavailable",
      `The recorded conversation leaf ${anchor} of ${agentId} is not in its native session; refusing to continue it from a ` +
        "later position that may belong to another branch.",
      { agentId, anchor },
    );
  }
  sessionManager.branch(anchor);
}

/**
 * The native session a Job appends to. A durable root gives every actor its own
 * session file — an inherited actor's file starts as the captured seed, a fresh
 * one is created by the native SessionManager on its first entry — while a
 * memory-only root keeps its actors in memory.
 */
function openChildSession(service, agentId, snapshot, cwd) {
  const store = service.store;
  if (store === null || !store.durable) {
    return snapshot
      ? SessionManager.inMemory(snapshot.cwd ?? cwd, {}, copyInheritedEntries(snapshot.entries))
      : SessionManager.inMemory(cwd);
  }
  if (snapshot !== null && Array.isArray(snapshot.entries)) store.writeSeedIfMissing(agentId, snapshot.entries);
  return SessionManager.open(store.childSessionFile(agentId));
}

/** The persisted record of every retained actor; JSON-safe by construction. */
function exportActors(service) {
  const actors = {};
  for (const [agentId, descriptor] of service.retained) {
    actors[agentId] = {
      sessionFile: descriptor.sessionFile ?? null,
      // Where this actor's conversation stood when the checkpoint was written;
      // a revival branches the native session back to it.
      leafId: currentAnchor(service, agentId, descriptor),
      cwd: descriptor.cwd,
      trusted: descriptor.trusted === true,
      allowInherited: descriptor.allowInherited === true,
      systemPrompt: descriptor.systemPrompt ?? null,
      roleId: descriptor.roleId ?? null,
      roleInstructions: descriptor.roleInstructions ?? null,
      model: descriptor.modelRef ?? null,
      thinkingLevel: descriptor.thinkingLevel ?? null,
      tools: Array.isArray(descriptor.tools) ? [...descriptor.tools] : null,
      assignment: descriptor.assignment ?? null,
      routed: descriptor.routed === true,
    };
  }
  return actors;
}

/**
 * One checkpoint on the root branch: the runtime's JSON-safe state plus the
 * actor records. Called at mutating boundaries only; a read-only poll never
 * writes. Storage failures are reported, never swallowed, but they do not
 * remove the in-memory registry: the session keeps running and the next
 * checkpoint tries again.
 */
function checkpoint(service, state) {
  if (!service.active || service.closed || !service.ready || service.storageError !== null) return;
  if (service.store === null || !service.store.durable) return;
  try {
    service.store.save({ registry: state, actors: exportActors(service) });
  } catch (error) {
    reportStorageError(service, error);
  }
}

/** Checkpoint the current runtime state, for adapter-side mutations. */
function checkpointNow(service) {
  if (service.runtime === null) return;
  checkpoint(service, service.runtime.exportState());
}

function persistActors(service) {
  checkpointNow(service);
}

function reportStorageError(service, error) {
  const message = errorMessage(error);
  service.lastStorageError = message;
  try {
    service.ui?.notify?.(`Subagent state could not be checkpointed: ${message}`, "error");
  } catch {
    // A host without a UI keeps the failure on the service instead.
  }
}

/**
 * An interrupted Job may have recorded its assignment prompt without the
 * adapter observing the turn boundary (the process died mid-request). The
 * native entries are authoritative, so the restatement text is dropped for any
 * actor whose own conversation already holds a user or assistant message.
 */
function clearDeliveredAssignments(service, registry) {
  if (!service.store.durable) return;
  const jobs = [...eachRegistryJob(registry)];
  for (const [agentId, descriptor] of service.retained) {
    if (descriptor.assignment === null) continue;
    const initial = jobs.find((job) => job.agentId === agentId && job.continuedFromJobId === null) ?? null;
    const boundary = initial?.history?.startEntryId ?? null;
    // The anchor is what the revival will continue from, so the probe reads the
    // conversation as of that leaf — never a turn appended afterwards.
    if (service.store.hasRecordedTurn(agentId, boundary, descriptor.anchor)) descriptor.assignment = null;
  }
}

/**
 * A Job that was still live when the process went away is restored as an
 * explicit failure, and its history is sealed at the actor's checkpoint anchor:
 * the saved root branch is authoritative, and whatever the child file appended
 * after that checkpoint stays native-file data that recovery does not adopt.
 */
function sealInterruptedHistory(service, registry) {
  if (!service.store.durable) return;
  for (const job of eachRegistryJob(registry)) {
    if (!LIVE_JOB_STATUSES.has(job.status)) continue;
    const anchor = service.retained.get(job.agentId)?.anchor ?? null;
    if (typeof anchor !== "string" || anchor === "") continue;
    if (!isPlainObject(job.history)) {
      // A Job that never recorded bounds started at its conversation's
      // beginning and ends where the checkpoint anchor stands.
      job.history = { startEntryId: null, endEntryId: anchor };
      continue;
    }
    if (job.history.endEntryId !== anchor) job.history.endEntryId = anchor;
  }
}

function* eachRegistryJob(registry) {
  const jobs = registry?.jobs;
  const list = Array.isArray(jobs) ? jobs : isPlainObject(jobs) ? Object.values(jobs) : [];
  for (const job of list) {
    if (isPlainObject(job)) yield job;
  }
}

/** Resolve a restored Job's transcript through the actor's native session file. */
function readNativeHistory(service, { agentId, jobId, history }) {
  if (!service.active || service.storageError !== null) return [];
  // A live actor is read from its running native session — a memory-only root
  // keeps its whole transcript there — while a restored one is read from its
  // session file. Either way the recorded bounds decide the slice, so a read
  // never adopts entries a checkpoint did not account for.
  const live = service.retained.get(agentId)?.sessionManager ?? null;
  return readTranscript(service.store.readHistory({ agentId, jobId, ...(history ?? {}) }, live));
}

/** The typed completion notice text: refs, never the subagent's full answer. */
function formatCompletion(message) {
  const facts = [];
  if (typeof message.status === "string" && message.status !== "") facts.push(`status ${message.status}`);
  if (typeof message.jobId === "string" && message.jobId !== "") facts.push(`job ${message.jobId}`);
  if (typeof message.resultRef === "string" && message.resultRef !== "") facts.push(`result ${message.resultRef}`);
  if (typeof message.historyRef === "string" && message.historyRef !== "") facts.push(`history ${message.historyRef}`);
  const head = facts.length === 0 ? `[Subagent ${message.from} finished]` : `[Subagent ${message.from} finished — ${facts.join(", ")}]`;
  const body = typeof message.content === "string" ? message.content.trim() : "";
  return body === "" ? head : `${head}\n${body}`;
}

function completionDetails(message) {
  return {
    type: "completion",
    from: message.from,
    jobId: message.jobId ?? null,
    status: message.status ?? null,
    resultRef: message.resultRef ?? null,
    historyRef: message.historyRef ?? null,
  };
}

/**
 * Hand one message to a live run. Native steering owns it from there: Pi
 * drains a queued steering message before the run settles, so it reaches the
 * model exactly once and is never replayed afterwards. A message that arrives
 * while the session is not streaming (session startup, or the gap between two
 * turns) is buffered and delivered by this Job's own end-of-turn loop.
 *
 * The steer is registered as in flight before it is awaited: it crosses an
 * async gap, and the end-of-turn loop must not close the Job (and dispose the
 * session) underneath a steer that has not landed yet. Registering it
 * synchronously, and completing it before any close decision, is what makes
 * the accepted answer true — the loop waits for the live set to drain first.
 * A steer that completed is never retracted just because the run closed: the
 * run may have consumed it, and re-sending would duplicate it.
 */
async function deliverToLiveJob(service, { jobId, message }) {
  const live = service.liveJobs.get(jobId);
  if (live === undefined || live.closed) {
    return { accepted: false, reason: "job_closed" };
  }
  const text = formatPeerMessage(message);
  if (live.session !== null && live.session.isStreaming) {
    const steer = (async () => {
      try {
        await live.session.steer(text);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    live.steers.add(steer);
    let failure;
    try {
      failure = await steer;
    } finally {
      live.steers.delete(steer);
    }
    if (failure !== null) return { accepted: false, reason: failure };
    return { accepted: true, mode: "steered" };
  }
  live.pending.push({ from: message.from, content: message.content, text });
  return { accepted: true, mode: "pending" };
}

/**
 * Deliver everything this Job still owns as further turns of the same Job and
 * Budget: texts native steering left parked when the run settled, and messages
 * buffered while no stream was active. Clearing the native queue hands each
 * parked text to this loop exactly once, so nothing is replayed.
 *
 * The loop first waits for every steer that is still in flight, then checks
 * both sources and closes in the same synchronous step when they are empty:
 * a hand-over therefore either lands inside a round of this Job or is refused
 * by the closed flag — never accepted into a session that is being disposed.
 * There is no round cap: a message this Job accepted is always delivered as a
 * further turn or refused by that closed flag, never dropped by an exhausted
 * counter. What bounds the loop is the Job's own Budget — every round runs a
 * model request, which an exhausted Budget refuses — and the fact that a
 * round only happens while a message is actually waiting.
 *
 * Each round is classified like the first prompt: a round whose run failed
 * stops the Job instead of being treated as delivered work.
 */
async function drainLiveMessages(live, sessionManager) {
  if (live.session === null) return;
  for (;;) {
    while (live.steers.size > 0) {
      await Promise.all([...live.steers]);
    }
    const parked = takeParkedTexts(live.session);
    const buffered = live.pending.splice(0);
    if (parked.length === 0 && buffered.length === 0) {
      live.closed = true;
      return;
    }
    const boundary = sessionManager.getLeafId();
    await live.session.prompt([...parked, ...buffered.map((entry) => entry.text)].join("\n\n"), {
      expandPromptTemplates: false,
    });
    assertRunCompleted(messagesAfter(sessionManager, boundary));
  }
}

/** Native messages appended since a boundary, for run classification. */
function messagesAfter(sessionManager, boundary) {
  return messagesOf(entriesAfter(sessionManager, boundary));
}

function messagesOf(entries) {
  const messages = [];
  for (const entry of entries) {
    if (entry.type === "message") messages.push(entry.message);
  }
  return messages;
}

/**
 * Raw SessionManager entries appended since a boundary.
 *
 * A Job's history is scoped by the append-only entry tree rather than the
 * compaction-aware projection: a summarization entry, an append-only context
 * edit or a projection that is shorter than the previous one cannot move the
 * boundary or truncate this Job's own entries.
 */
function entriesAfter(sessionManager, boundary) {
  const branch = sessionManager.getBranch();
  if (boundary === null || boundary === undefined) return branch;
  const at = branch.findIndex((entry) => entry.id === boundary);
  return at === -1 ? [] : branch.slice(at + 1);
}

/** Partial output of an aborted run; the registry reports the Job as cancelled. */
function cancelledOutcome(sessionManager, boundary) {
  const entries = entriesAfter(sessionManager, boundary);
  return {
    result: readFinalText(messagesOf(entries)),
    messages: readTranscript(entries),
    history: { startEntryId: boundary, endEntryId: sessionManager.getLeafId() },
  };
}

/**
 * Classify the attempt that just settled. `AgentSession.prompt()` resolves on a
 * provider failure too — the transcript just keeps an assistant message with
 * `stopReason: "error"` — so a Job must inspect the run's own output instead of
 * assuming success, and it must never fall back to an earlier Job's answer.
 *
 * @returns {object} the final assistant message of the run
 */
function assertRunCompleted(messages) {
  let last = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      last = messages[index];
      break;
    }
  }
  if (last === null) {
    throw new SubagentError(
      "empty_response",
      "The run produced no assistant message; the Job is marked failed instead of reporting an earlier answer.",
    );
  }
  if (last.stopReason === "error") {
    const detail =
      typeof last.errorMessage === "string" && last.errorMessage !== "" ? last.errorMessage : "the provider reported an error";
    throw new SubagentError("provider_error", `The provider request failed: ${detail}`, { stopReason: last.stopReason });
  }
  if (last.stopReason === "aborted") {
    throw new SubagentError("run_aborted", "The run was aborted before it produced a final answer.", {
      stopReason: last.stopReason,
    });
  }
  return last;
}

/**
 * Remove and return the texts still parked in the session's own queues. They
 * were never consumed, so the Job's end-of-turn loop owns their delivery; a
 * steering message the run already consumed is gone from the queue and is
 * never replayed.
 */
function takeParkedTexts(session) {
  const agent = session?.agent;
  if (typeof agent?.hasQueuedMessages !== "function" || !agent.hasQueuedMessages()) return [];
  const queued = typeof agent.peekQueuedMessages === "function" ? agent.peekQueuedMessages() : [];
  agent.clearAllQueues?.();
  const texts = [];
  for (const message of queued) {
    const text = textOf(message?.content);
    if (text !== "") texts.push(text);
  }
  return texts;
}

/**
 * Text handed to a session. Attribution comes from the host-bound sender, so
 * a message body can never impersonate another actor.
 */
function formatPeerMessage(message) {
  return `[Message from ${message.from}]\n${message.content}`;
}

/**
 * The assignment text of a first Job: its batch context plus the task itself.
 * It is also what a revival restates when the conversation never recorded it.
 *
 * The context bytes stay verbatim (only whitespace-only context collapses to
 * the task alone), so the text the routing classifier judges and the text the
 * child conversation records are byte-identical.
 */
function assignmentText(spec) {
  const task = typeof spec?.task === "string" ? spec.task : "";
  const context = typeof spec?.context === "string" ? spec.context : "";
  return context.trim() === "" ? task : `# Batch context\n\n${context}\n\n# Task\n\n${task}`;
}

/** Peer messages for a fresh/inherited Job, appended after the assignment. */
function composePrompt(assignment, messages) {
  if (messages.length === 0) return assignment;
  return `${assignment}\n\n# Messages from other agents\n\n${messages.map((entry) => entry.text).join("\n\n")}`;
}

/**
 * Peer messages for a revival Job. When the actor never recorded anything —
 * its first Job was stopped during setup, or cancelled while it was still
 * queued — the original assignment is restated before them, so the new Job
 * has the context its conversation is missing.
 */
function composeContinuationPrompt(messages, assignment) {
  const restating = typeof assignment === "string" && assignment !== "";
  const parts = [];
  if (restating) {
    parts.push(
      "# Original assignment",
      "",
      "This agent's first Job was stopped before its conversation recorded anything, so its assignment is restated here.",
      "",
      assignment,
      "",
    );
  }
  parts.push(
    "# New message",
    "",
    restating
      ? "The messages below arrived while this agent had no recorded conversation and start its first run."
      : "The previous Job for this agent had already finished. The messages below arrived afterwards and start this new Job.",
    "",
    messages.map((entry) => entry.text).join("\n\n"),
  );
  return parts.join("\n");
}

/** The session's own tool loadout, or null when it cannot be read. */
function activeToolNames(session) {
  try {
    const names = session?.getActiveToolNames?.();
    return Array.isArray(names) && names.length > 0 ? [...names] : null;
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Final assistant text inside exactly these messages. */
function readFinalText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text !== "") return text;
  }
  return "";
}

function serializePart(part) {
  if (!part || typeof part !== "object") return { type: "unknown" };
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "thinking") return { type: "thinking", text: String(part.thinking ?? part.text ?? "") };
  if (part.type === "image") return { type: "image", mimeType: part.mimeType ?? null };
  const toolName = part.toolName ?? part.name;
  if (part.type === "toolCall" || part.type === "tool_call" || typeof toolName === "string") {
    return { type: "tool_call", name: toolName ?? null, arguments: part.arguments ?? part.input ?? null };
  }
  return { type: String(part.type ?? "unknown") };
}

function serializeMessage(message) {
  if (!message || typeof message !== "object") return null;
  const entry = { role: typeof message.role === "string" ? message.role : "unknown" };
  if (typeof message.content === "string") {
    entry.content = [{ type: "text", text: message.content }];
  } else if (Array.isArray(message.content)) {
    entry.content = message.content.map(serializePart);
  } else {
    entry.content = [];
  }
  if (typeof message.toolCallId === "string") entry.toolCallId = message.toolCallId;
  if (message.isError === true) entry.isError = true;
  if (typeof message.provider === "string") entry.provider = message.provider;
  if (typeof message.model === "string") entry.model = message.model;
  if (message.usage !== undefined) entry.usage = message.usage;
  return entry;
}

/**
 * Serialize raw SessionManager entries into one Job's `history://` transcript.
 * Message entries carry the native message; a custom message entry and a
 * compaction summary appear as their own roles so a compacted conversation
 * stays readable instead of silently dropping content.
 */
function readTranscript(entries) {
  const transcript = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const serialized = serializeMessage(entry.message);
      if (serialized !== null) transcript.push(serialized);
    } else if (entry.type === "custom_message") {
      transcript.push({
        role: "custom",
        customType: entry.customType,
        content: typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content,
      });
    } else if (entry.type === "compaction") {
      transcript.push({ role: "compactionSummary", summary: String(entry.summary ?? "") });
    }
  }
  return transcript;
}
