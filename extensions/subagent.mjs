/**
 * Subagent tools, native SDK execution, socket delivery and history finalization.
 * Fresh jobs route on their own Budget; Inherited jobs retain the parent identity.
 * Each actor keeps its session and branch anchor across explicit revivals.
 * Runtime owns terminal outcomes; this adapter runs the SDK and writes history.
 * Root checkpoints are branch-scoped, while actor IDs are root-session-scoped.
 */

import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createWriteToolDefinition,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import path, { join } from "node:path";
import { SubagentError, copyInheritedEntries, createSubagentRuntime } from "../src/subagent-runtime.mjs";
import { ServiceLifecycle, takeQueuedMessages } from "../src/subagent/lifecycle.ts";
import { openSubagentExecution } from "../src/subagent/execution.ts";
import { createSteerDelivery, DELIVERY_CUSTOM_TYPE } from "../src/subagent/delivery.ts";
import { captureInheritedContext } from "../src/inherited-context.mjs";
import { ensurePrivateSocketRoot } from "../src/subagent-ipc.mjs";
import { installModelCallBudget } from "../src/pi-job-budget.mjs";
import { routeSubagent } from "../src/subagent-routing.mjs";
import { SUBAGENT_SESSIONS_DIR, createSubagentStore, SubagentStoreError } from "../src/subagent-storage.mjs";
import capabilityExtension from "./capability.mjs";
import { setCapabilityParent, capabilityAvailableTools, capabilityAllowsTool } from "../src/capability-scope.mjs";
import {
  createAgentSocketServer,
  createBroadcastSocketServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
  getBroadcastSocketPath,
  DEFAULT_SOCKET_DIR,
  endpointKey,
  isIpcPath,
  isInSocketDirectory,
  writeSocketOneWay,
  deriveSessionUid,
} from "../src/subagent-socket.mjs";
import {
  appendCleanJsonl,
  writeCompactedSummary,
  getSubagentHistoryPaths,
} from "../src/subagent-history.mjs";

const MAX_AGENT_DEPTH = 2;
const NATIVE_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const HARNESS_TOOLS = ["subagent_create", "subagent_list", "subagent_stop", "capability"];
const LEAF_HARNESS_TOOLS = ["subagent_list"];
const MESSAGE_CUSTOM_TYPE = "agent-message";
const COMPLETION_CUSTOM_TYPE = "agent-completion";
/** Job statuses that never reached a terminal state in their own process. */
const LIVE_JOB_STATUSES = new Set(["running", "stopping", "finalizing"]);

const SUBAGENT_NAMESPACE = Object.freeze({
  name: "subagent",
  description: "Delegate independent background tasks, exchange messages, and collect their results.",
  instructions: [
    "Where available, use subagent_create to delegate independent tasks. Fresh agents need self-contained task/context; inheritContext copies this session's snapshot. Agents share the working directory; avoid simultaneous edits to the same files.",
    "Each parent can have four active children, with two child levels. Each execution round ends with a host terminal notification carrying its status, job and round; use subagent_list and read history.summary for the outcome or history.cleanJsonl for full messages.",
    "running includes initialization; stopping waits for execution exit; finalizing writes history; stopped means ended, not necessarily succeeded. Use subagent_stop only to cancel unwanted work.",
    "To send a message, use write if enabled, otherwise msg_write, with the returned socket path and plain text content. The host binds the sender, frames the transport and omits from/to; do not write your own Socket client.",
    "To contact your direct parent, use your enabled write or msg_write with the parent socket stated in your agent context. Main's receiving socket is distinct from main/children.sock; the latter only broadcasts downward.",
    "A successful write is not a task result. Writing to a stopped agent starts a new run; wait for stopped before messaging an agent that is stopping or finalizing.",
    "Your children.sock endpoint broadcasts only to your direct children, never recursively. Query progress when needed, not in a tight loop.",
  ].join("\n"),
});

const taskParameters = {
  type: "object",
  properties: {
    context: {
      type: "string",
      description: "Background, constraints, and source material shared by every task in this batch.",
    },
    tasks: {
      type: "array",
      minItems: 1,
      description: "Independent tasks. Order is preserved in the result, but it does not create execution dependencies.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller-facing label; defaults to none." },
          task: { type: "string", description: "Self-contained assignment: deliverable, scope, and how to verify completion." },
          inheritContext: {
            type: "boolean",
            description: "Copy this session's conversation, system prompt, model, and thinking at creation time. Default false: start without this session's chat history.",
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
    /**
     * The current root-session service. `ServiceLifecycle` owns activation,
     * service-specific retirement and the generation guard, so a completed
     * retirement never becomes a permanent latch and a stale callback cannot
     * retire its successor.
     */
    lifecycle: new ServiceLifecycle({
      retire: (service) => retireService(controller, service),
    }),
    /** Allocated agent IDs per root session ID, preserved across branch switches. */
    allocatedAgentIdsBySession: new Map(),
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
    await controller.lifecycle.retire();
  });
  // Merge an undelivered Agent message with the terminal notice of the same
  // sender and execution round. Pi still owns steering, interruption and
  // continuation; this hook only supplies the finalized snapshot.
  pi.on("input", () => {
    // A new user input is an ordinary native boundary. Later content must not
    // merge into an older Agent event batch, even if the old batch was cleared.
    controller.lifecycle.service?.mainDelivery?.breakMergeKeys();
  });
  pi.on("message_start", (event) => {
    const service = controller.lifecycle.service;
    if (service === null || !service.active) return;
    const delivery = service.mainDelivery;
    if (delivery === undefined || delivery === null) return;
    // A real user input starts a new merge boundary; a custom delivery batch
    // is marked as started so preparation/history races can still finalize it.
    if (event.message?.role === "user") delivery.breakMergeKeys();
    delivery.messageStarted(event.message);
  });
  pi.on("agent_settled", () => {
    controller.lifecycle.service?.mainDelivery?.settle();
  });
  pi.on("agent_end", (event) => {
    // An aborted native turn is an ordinary cancellation boundary, not a
    // notification permission switch: release stale merge slots and let the
    // next real event stand alone.
    const last = event.messages?.at(-1);
    if (last?.role === "assistant" && last.stopReason === "aborted") {
      controller.lifecycle.service?.mainDelivery?.settle();
    }
  });
  pi.on("message_end", (event) => {
    const service = controller.lifecycle.service;
    if (service === null || !service.active) return undefined;
    const message = service.mainDelivery?.replaceMessage(event.message);
    return message === undefined ? undefined : { message };
  });
  installSessionSurface(pi, (ctx) => rootService(controller, ctx), { allowInherited: true, parentAgentId: null, depth: 0, senderId: "main" });
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
  const service = controller.lifecycle.service;
  if (service !== null && service.active) return service;
  return activateRootSession(controller, ctx);
}

/**
 * Build a fresh service for the session in `ctx`, after the previous one has
 * quiesced. Concurrent entries share one activation instead of retiring each
 * other's service.
 */
async function activateRootSession(controller, ctx) {
  return controller.lifecycle.activate(async (generation) => {
    const service = createService(controller, ctx);
    service.generation = generation;
    await restoreService(service, ctx);
    return service;
  });
}

/**
 * Retire the current service: no callback of its runtime may touch a later
 * session's state, its protocol reads/writes fail with `runtime_closed`, and
 * this resolves only once every live Job's native run has exited. Suppressing
 * callbacks is not quiescence — a native run that is still streaming could
 * otherwise append to the same child session a restored runtime is about to
 * continue.
 */
async function retireService(controller, service) {
  service.active = false;
  service.closed = true;

  // Invalidate pending merge slots before any callback can enqueue into the
  // generation that is leaving. A later session starts with a fresh delivery
  // coordinator rather than inheriting an in-flight slot.
  service.mainDelivery?.retire();
  for (const delivery of service.agentDeliveries.values()) delivery.retire();
  service.agentDeliveries.clear();

  const liveJobs = service.runtime
    ? service.runtime.jobs().jobs.filter((job) => LIVE_JOB_STATUSES.has(job.status))
    : [];

  for (const job of liveJobs) {
    if (job.status === "running") {
      try {
        service.runtime.cancelJob(job.jobId);
      } catch {
        // Already terminal: nothing to stop.
      }
    }
  }

  const closeSocketsPromise = (async () => {
    await service.socketChanges;
    if (service.socketServers) {
      for (const server of service.socketServers.values()) {
        try {
          await server.close();
        } catch {
          // ignore close error during retirement
        }
      }
      service.socketServers.clear();
      service.registeredSockets?.clear();
    }
  })();

  try {
    await Promise.all([
      closeSocketsPromise,
      ...liveJobs.map((job) => service.runtime.jobDone(job.jobId)),
    ]);
  } catch {
    // Every Job still settles through its own handle; a failed wait here must
    // not skip the remaining generation cleanup.
  } finally {
    service.retained.clear();
    service.liveJobs.clear();
  }
}

/** One root session's runtime, storage and retained actor records. */
function createService(controller, ctx) {
  const sessionId = ctx?.sessionManager?.getSessionId?.() || ctx?.sessionId || "default";
  const sessionUid = deriveSessionUid(sessionId);
  const baseSocketDir = path.resolve(ctx?.cwd ?? process.cwd(), DEFAULT_SOCKET_DIR);
  // Validate/create the managed root before any session directory or listener.
  // Nested session directories are still validated by each listener; this is
  // the fail-fast boundary for a symlinked/non-directory/non-private root.
  ensurePrivateSocketRoot(baseSocketDir);
  const socketDir = path.join(baseSocketDir, sessionUid);
  const historyDir = path.join(".pi/subagents", sessionUid);
  const cwd = ctx?.cwd ?? process.cwd();

  let allocatedAgentIds = controller.allocatedAgentIdsBySession.get(sessionId);
  if (!allocatedAgentIds) {
    allocatedAgentIds = new Set();
    controller.allocatedAgentIdsBySession.set(sessionId, allocatedAgentIds);
  }

  // Rebuild allocated agent IDs from all entries in the root SessionManager across all branches
  const sessionManager = ctx?.sessionManager;
  if (sessionManager && typeof sessionManager.getEntries === "function") {
    try {
      const allEntries = sessionManager.getEntries();
      for (const entry of allEntries) {
        if (entry.type === "subagent-state" || entry.customType === "subagent-state") {
          const stateData = entry.data || entry;
          if (Array.isArray(stateData.actors)) {
            for (const actor of stateData.actors) {
              if (actor.agentId && actor.agentId !== "Main") {
                allocatedAgentIds.add(actor.agentId);
              }
            }
          }
        }
      }
    } catch {}
  }

  const service = {
    controller,
    agentDir: controller.agentDir,
    settings: controller.settings,
    sessionUid,
    baseSocketDir,
    socketDir,
    historyDir,
    cwd,
    allocatedAgentIds,
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
    /**
     * One coordinator for the root conversation. Service retirement retires it,
     * so a slot from an old branch can never replace a message in the new one.
     */
    mainDelivery: null,
    /** One delivery coordinator per Subagent conversation receiving child events. */
    agentDeliveries: new Map(),
    /** Retained session descriptors, so an idle agent keeps its conversation. */
    retained: new Map(),
    /** Live Unix Domain Socket servers mapped by actor id or broadcast key. */
    socketServers: new Map(),
    registeredSockets: new Map(),
    socketChanges: Promise.resolve(),
    /** Per-run history writer and metadata, released after finalization. */
    jobHistory: new Map(),
    runtime: null,
  };
  // Root queue observation gap in Pi 1.4: ExtensionContext exposes only
  // `hasPendingMessages()`, backed by the textual steering/follow-up mirrors.
  // It does not include custom steered messages and there is no public Agent
  // reference in the root extension context. Passing it as `hasPendingMessages`
  // would report a live custom batch as cleared. The root coordinator therefore
  // omits the oracle and relies on message_start/input/agent_settled boundaries.
  // A native clearQueue() while the root is busy emits none of those events, so
  // that specific boundary cannot be observed without an SDK API change.
  service.mainDelivery = createSteerDelivery({
    isActive: () => service.active && !service.closed,
    send: (payload) => {
      if (!service.active || service.closed) throw new Error("Subagent service was retired before delivery.");
      // The host owns wake/interruption semantics: this is exactly a native
      // steer message, not a second notification state machine. Pi accepts the
      // custom-message fields, not the internal transport envelope.
      const { customType, content, display, details } = payload;
      service.controller.pi.sendMessage({ customType, content, display, details }, { triggerTurn: true, deliverAs: "steer" });
    },
  });
  service.runtime = createSubagentRuntime({
    socketDir,
    historyDir,
    isAgentIdTaken: (id) => service.allocatedAgentIds.has(id),
    onAgentIdAllocated: (agentId) => service.allocatedAgentIds.add(agentId),
    startJob: (job) => startPiJob(service, job),
    finalizeJob: (arg) => finalizePiJob(service, arg),
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
async function restoreService(service, ctx) {
  let checkpoint;
  try {
    checkpoint = service.store.load();
  } catch (error) {
    return latchStorageError(service, ctx, error);
  }
  if (checkpoint === null) {
    service.ready = true;
    await withSocketChanges(service, async () => { await listenAgent(service, "Main"); });
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
  for (const agent of service.runtime.list().agents) service.allocatedAgentIds.add(agent.agentId);
  await withSocketChanges(service, async () => {
    await listenAgent(service, "Main");
    await restoreListenerGroup(service, null);
  });
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
    excludedTools: Array.isArray(record.excludedTools) ? [...record.excludedTools] : null,
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
 * Submit one event to the root delivery coordinator.
 *
 * Both explicit peer messages and terminal notices use Pi's ordinary steer
 * path. The coordinator merges an undelivered message with the terminal notice
 * of the same sender/round before Pi seals it into history; Pi still owns
 * queueing, interruption and continuation.
 */
async function deliverToMain(service, message) {
  if (!service.active || service.mainDelivery === null) return;
  if (message?.type === "completion" || message?.type === "notification") {
    const sourceId = typeof message.from === "string" ? message.from : message.subagentId;
    if (typeof sourceId !== "string" || sourceId === "") return;
    const result = service.mainDelivery.enqueue({
      sourceId,
      round: Number.isInteger(message.round) ? message.round : 1,
      content: typeof message.content === "string" ? message.content : formatCompletion(message),
      terminal: {
        status: typeof message.status === "string" ? message.status : "failed",
        details: completionDetails(message),
      },
    });
    if (!result.accepted) {
      service.ui?.notify?.(`Terminal notification for ${sourceId} was not accepted: ${result.reason ?? "inactive"}`, "error");
    }
    return;
  }
  if (typeof message.from !== "string" || message.from === "") return;
  service.mainDelivery.enqueue({
    sourceId: message.from,
    round: Number.isInteger(message.round) ? message.round : 1,
    content: formatPeerMessage(message),
  });
}

/**
 * Deliver one terminal notice to a Subagent parent.
 *
 * An idle/stopped parent is woken through the runtime's ordinary continuation
 * Job path, so the same child-limit admission and a fresh Budget apply. A live
 * parent takes the notice through its native custom-message path and may
 * continue its turn. If the continuation is refused, the notice is appended to
 * the retained conversation instead. Delivery is attempted exactly once.
 */
function deliveryForAgent(service, agentId) {
  const existing = service.agentDeliveries.get(agentId);
  if (existing !== undefined) return existing;
  const delivery = createSteerDelivery({
    isActive: () => service.active && !service.closed,
    hasPendingMessages: (batchId) => {
      const live = [...service.liveJobs.values()].find((run) => run.agentId === agentId && !run.closed);
      if (live?.pending.some((entry) => entry.kind === "custom" && entry.details?.batchId === batchId)) return true;
      const agent = live?.session?.agent;
      if (agent === undefined) return false;
      // Our custom payloads always use steering. Preview all steering entries
      // synchronously, without consuming them or changing the user's mode.
      const mode = agent.steeringMode;
      try {
        agent.steeringMode = "all";
        return agent.peekQueuedMessages().some((message) => message.role === "custom" &&
          message.customType === "agent-delivery" && message.details?.batchId === batchId);
      } finally {
        agent.steeringMode = mode;
      }
    },
    send: (payload) => sendAgentDeliveryPayload(service, agentId, payload),
  });
  service.agentDeliveries.set(agentId, delivery);
  return delivery;
}

/** Send one coordinator payload into a live Subagent conversation or its retained record. */
async function sendAgentDeliveryPayload(service, agentId, payload) {
  const { customType, content, display, details } = payload;
  const entry = { customType, content, display, details };
  const live = [...service.liveJobs.values()].find((run) => run.agentId === agentId && !run.closed);
  if (live === undefined) {
    appendCustomToRetained(service, agentId, entry);
    return;
  }
  if (live.session === null || !live.session.isStreaming) {
    // Routing/setup has no native consumer yet, and an idle session must not be
    // started concurrently with the primary prompt. Keep the custom envelope
    // in the Job's existing pending buffer; the first-prompt flush or the
    // end-of-job drain owns the one native append/run.
    live.pending.push({
      kind: "custom",
      from: typeof details?.sourceId === "string" ? details.sourceId : "",
      content,
      text: content,
      customType,
      display,
      details,
      message: {
        role: "custom",
        customType,
        content,
        display,
        details,
        timestamp: Date.now(),
      },
    });
    return;
  }
  // Track the native custom steer exactly like a peer steer: the Job's
  // end-of-turn loop waits for it before closing the session.
  const operation = (async () => {
    await live.session.sendCustomMessage(entry, { triggerTurn: true, deliverAs: "steer" });
  })();
  live.steers.add(operation);
  try {
    await operation;
  } finally {
    live.steers.delete(operation);
  }
}

async function deliverMessage(service, { agentId, jobId, message }) {
  if (!service.active) return { accepted: false, reason: "runtime_retired" };
  if (message?.type === "completion" || message?.type === "notification") {
    // An idle parent wakes through the ordinary continuation Job path, with
    // the same child-limit admission and a fresh Budget. A busy or stopping
    // parent keeps the notice in its current conversation instead.
    if (typeof jobId !== "string" || service.liveJobs.get(jobId)?.closed === true) {
      const wake = service.runtime?.reviveWithNotification?.(agentId, message);
      if (wake?.woken === true) return { accepted: true, mode: "revived", jobId: wake.jobId };
    }
    const sourceId = typeof message.from === "string" ? message.from : message.subagentId;
    if (typeof jobId === "string" && typeof sourceId === "string" && sourceId !== "") {
      const result = deliveryForAgent(service, agentId).enqueue({
        sourceId,
        round: Number.isInteger(message.round) ? message.round : 1,
        content: typeof message.content === "string" ? message.content : formatCompletion(message),
        terminal: {
          status: typeof message.status === "string" ? message.status : "failed",
          details: completionDetails(message),
        },
      });
      if (result.accepted) return { accepted: true, mode: "delivered" };
    }
    // The append is awaited: a rejected native append must stay inside the
    // completion's own one-attempt boundary instead of escaping as an
    // unhandled rejection from a discarded promise. Its outcome never affects
    // the Job that sent the notice.
    await appendCompletion(service, agentId, typeof jobId === "string" ? jobId : null, message);
    return { accepted: true, mode: "retained" };
  }

  const sourceId = message?.from;
  if (typeof jobId === "string" && typeof sourceId === "string" && sourceId !== "") {
    const result = deliveryForAgent(service, agentId).enqueue({
      sourceId,
      round: Number.isInteger(message.round) ? message.round : 1,
      content: formatPeerMessage(message),
    });
    if (!result.accepted) return { accepted: false, reason: result.reason ?? "delivery_rejected" };
    return { accepted: true, mode: "delivered" };
  }
  return deliverToLiveJob(service, { agentId, jobId, message });
}

async function appendCompletion(service, agentId, jobId, message) {
  const content = formatCompletion(message);
  const details = completionDetails(message);
  const entry = { customType: COMPLETION_CUSTOM_TYPE, content, display: true, details };
  try {
    const live = jobId === null ? null : (service.liveJobs.get(jobId) ?? null);
    if (live != null && live.closed) {
      try {
        await service.runtime?.jobDone?.(jobId);
      } catch {}
      if (service.closed) return;
    } else if (live?.session != null) {
      const manager = service.retained.get(agentId)?.sessionManager ?? null;
      const before = manager?.getLeafId() ?? null;
      // A live Subagent parent is still an ordinary Pi session: a terminal
      // notice may wake/continue it, exactly like any other steer message.
      await live.session.sendCustomMessage(entry, { triggerTurn: true });
      const after = manager?.getLeafId() ?? null;
      if (after !== before) checkpointAppendedAnchor(service, agentId, after);
      return;
    }
    appendCustomToRetained(service, agentId, entry);
  } catch {
    // A notification is attempted once: it is never queued, retried or replayed.
  }
}

function appendCustomToRetained(service, agentId, entry) {
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
  const entryId = sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  if (durableAppend && typeof entryId === "string") checkpointAppendedAnchor(service, agentId, entryId);
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

// Serialize listener ownership changes, not Jobs or message processing.
function withSocketChanges(service, operation) {
  const run = service.socketChanges.then(() => {
    assertOperational(service);
    return operation();
  });
  service.socketChanges = run.catch(() => {});
  return run;
}

async function listenAgent(service, id) {
  const wrapper = ensureAgentSocketServer(service, id);
  if (!wrapper) throw new Error(`Cannot establish IPC listener for ${id}.`);
  // `ready` settles after ownership preparation and binding. Waiting on the
  // server's "listening" event would hang when prepare rejects asynchronously.
  await wrapper.ready;
}

async function listenBroadcast(service, parentId) {
  const wrapper = ensureBroadcastSocketServer(service, parentId);
  if (!wrapper) throw new Error(`Cannot establish broadcast listener for ${parentId ?? "Main"}.`);
  await wrapper.ready;
}

async function closeListener(service, key) {
  const wrapper = service.socketServers.get(key);
  if (!wrapper) return;
  await wrapper.close();
  service.socketServers.delete(key);
  service.registeredSockets.delete(endpointKey(wrapper.socketPath));
}

async function closeStoppedBranch(service, id, agents) {
  const actor = agents.find((agent) => agent.agentId === id);
  if (!actor || service.runtime.list().agents.find((entry) => entry.agentId === id)?.status === "running") return;
  await closeListener(service, id);
  // A buffered connection may have revived this actor while close drained it.
  if (service.runtime.list().agents.find((entry) => entry.agentId === id)?.status === "running") {
    if (!service.closed) await listenAgent(service, id);
    return;
  }
  await closeListener(service, `broadcast:${id}`);
  for (const child of agents.filter((agent) => agent.parentAgentId === id)) await closeStoppedBranch(service, child.agentId, agents);
}

async function restoreListenerGroup(service, parentId, includeId) {
  const selected = new Set(service.runtime.listenerGroup(parentId, includeId));
  const agents = service.runtime.list().agents;
  for (const key of [...service.socketServers.keys()]) {
    const actor = agents.find((agent) => agent.agentId === key);
    if (actor?.parentAgentId === parentId && !selected.has(key)) await closeStoppedBranch(service, key, agents);
  }
  if (includeId) service.runtime.assertMessageAdmission(includeId);
  for (const id of service.runtime.listenerGroup(parentId, includeId)) await listenAgent(service, id);
  await listenBroadcast(service, parentId);
}

async function findSocketEndpoint(service, address) {
  assertOperational(service);
  const key = endpointKey(address);
  const resident = service.registeredSockets.get(key);
  if (resident) return resident;
  // Search only this session's registry. Never infer Actor ownership from basename.
  const actors = service.runtime.list().agents;
  for (const actor of [{ agentId: "Main", depth: 0 }, ...actors]) {
    const id = actor.agentId;
    if (endpointKey(getAgentSocketPath(id, service.socketDir)) === key) return { isManaged: true, isBroadcast: false, targetId: id };
    if ((id === "Main" || actor.depth < MAX_AGENT_DEPTH) && endpointKey(getBroadcastSocketPath(id, service.socketDir)) === key) {
      return { isManaged: true, isBroadcast: true, parentId: id === "Main" ? "main" : id };
    }
  }
  if (await isInSocketDirectory(address, service.baseSocketDir)) {
    throw new SubagentError("unknown_endpoint", "No registered Agent owns this IPC address.");
  }
  return { isManaged: false };
}

async function sendManagedSocket(service, endpoint, address, content) {
  return withSocketChanges(service, async () => {
    if (endpoint.isBroadcast) {
      await listenBroadcast(service, endpoint.parentId);
    } else if (endpoint.targetId === "Main") {
      await listenAgent(service, "Main");
    } else {
      service.runtime.assertMessageAdmission(endpoint.targetId);
      const actor = service.runtime.list().agents.find((entry) => entry.agentId === endpoint.targetId);
      await restoreListenerGroup(service, actor.parentAgentId, actor.agentId);
    }
    return writeSocketOneWay(address, content);
  });
}

function ensureAgentSocketServer(service, agentId) {
  if (service.socketServers.has(agentId)) return service.socketServers.get(agentId);
  try {
    const socketPath = getAgentSocketPath(agentId, service.socketDir);
    const server = createAgentSocketServer({
      id: agentId,
      socketDir: service.socketDir,
      root: service.baseSocketDir,
      onMessage: (msg) => {
        const content = typeof msg === "string" ? msg : (msg?.content ?? JSON.stringify(msg));
        const from = (typeof msg === "object" && msg !== null && typeof msg.from === "string" && msg.from !== "")
          ? msg.from
          : "Main";
        // Main's receiving endpoint accepts a host-bound write from Main itself;
        // the runtime's actor-to-actor rule still rejects self-sends elsewhere.
        if (agentId === "Main" && from === "Main") {
          deliverToMain(service, { type: "message", from, content }).catch((err) => {
            service.ui?.notify?.(`Failed to deliver socket message to Main: ${err.message}`, "error");
          });
          return;
        }
        service.runtime
          ?.sendMessage({
            from,
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
    service.registeredSockets?.set(endpointKey(socketPath), {
      isManaged: true,
      isBroadcast: false,
      targetId: agentId,
    });
    return server;
  } catch {
    // Socket initialization error is non-fatal for session startup
  }
}

function ensureBroadcastSocketServer(service, parentId) {
  const normId = parentId || "main";
  const key = `broadcast:${normId}`;
  if (service.socketServers.has(key)) return service.socketServers.get(key);
  try {
    const broadcastSocketPath = getBroadcastSocketPath(normId, service.socketDir);
    const server = createBroadcastSocketServer({
      parentId: normId,
      socketDir: service.socketDir,
      root: service.baseSocketDir,
      getDirectChildren: () => {
        // Broadcast is topology, not the bounded list window: every current
        // direct child is a recipient, and each still follows the ordinary
        // send/admission/continuation rules below.
        const pId = normId === "main" || normId === "Main" ? null : normId;
        return service.runtime
          .list()
          .agents.filter((agent) => agent.parentAgentId === pId)
          .map((agent) => agent.agentId);
      },
      deliverMessage: (childId, msg) => {
        const content = typeof msg === "string" ? msg : (msg?.content ?? JSON.stringify(msg));
        return service.runtime?.sendMessage({
          from: normId === "main" || normId === "Main" ? "Main" : normId,
          to: childId,
          content,
        });
      },
    });
    service.socketServers.set(key, server);
    service.registeredSockets?.set(endpointKey(broadcastSocketPath), {
      isManaged: true,
      isBroadcast: true,
      parentId: normId,
    });
    return server;
  } catch {
    // Broadcast socket initialization error is non-fatal
  }
}

const listParameters = {
  type: "object",
  properties: {
    all: { type: "boolean", description: "Show every agent, including Main and stopped agents, without group limits. Default false." },
    id: {
      type: "string",
      description: "Optional agent id to filter the visible list. Use all: true to query outside the default view.",
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

function installSessionSurface(pi, resolveService, { allowInherited, parentAgentId, depth, cwd, senderId = "main" }) {
  const workCwd = typeof cwd === "string" ? cwd : process.cwd();
  if (depth < MAX_AGENT_DEPTH) {
    pi.registerTool(createTool(pi, resolveService, { allowInherited, parentAgentId, depth, cwd: workCwd }));
  }
  pi.registerTool(listTool(resolveService, senderId === "main" ? "Main" : senderId));
  if (depth < MAX_AGENT_DEPTH) pi.registerTool(stopTool(resolveService));

  const writeOps = createSocketAwareWriteOperations({
    senderId,
    onCheckStatus: async (agentId) => {
      try {
        const service = await resolveService();
        const item = service?.runtime?.listDetailed({ id: agentId })?.items?.[0];
        return item?.status ?? null;
      } catch {
        return null;
      }
    },
    isReservedPath: (address) => isInSocketDirectory(address, path.resolve(workCwd, DEFAULT_SOCKET_DIR)),
    resolveEndpoint: async (address) => findSocketEndpoint(await resolveService(), address),
    sendManaged: async (endpoint, address, content) => sendManagedSocket(await resolveService(), endpoint, address, content),
  });
  const messageTool = createWriteToolDefinition(workCwd, { operations: writeOps });
  pi.registerTool({
    ...messageTool,
    name: "msg_write",
    defaultActive: false,
    label: "Send Agent Message",
    description: "Send a plain-text message to a managed Agent IPC endpoint: Unix Socket or Windows Named Pipe. The host binds the sender and transport framing. Omit from/to, JSON or NDJSON envelopes, and trailing newlines. Cannot write files.",
    promptSnippet: "Send plain-text messages to agents through their Socket paths",
    promptGuidelines: ["Provide the message body as plain text content; do not add from/to, JSON/NDJSON framing, a trailing newline, or a custom Socket client."],
    parameters: {
      ...messageTool.parameters,
      properties: {
        ...messageTool.parameters.properties,
        path: { type: "string", description: "Returned Unix Socket or Windows Named Pipe address." },
        content: { type: "string", description: "Plain-text message body. The host frames the transport and binds the sender." },
      },
    },
    async execute(...args) {
      if (!isIpcPath(args[1].path)) throw new Error("msg_write requires an IPC endpoint address.");
      return messageTool.execute(...args);
    },
  });
  pi.registerTool(messageTool);
}

function createTool(pi, resolveService, { allowInherited, parentAgentId, depth }) {
  return {
    name: "subagent_create",
    namespace: SUBAGENT_NAMESPACE,
    defaultActive: false,
    label: "Create Subagent",
    description:
      "Create independent background agents. Returns each agent's id, status, socket, and history paths; does not wait for results.",
    promptSnippet: "Delegate independent tasks to background agents",
    promptGuidelines: [
      ...SUBAGENT_NAMESPACE.instructions.split("\n"),
      "Write requirements for subagents primarily in English.",
    ],
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
      await withSocketChanges(service, () => restoreListenerGroup(service, parentAgentId));
      return respond(response);
    },
  };
}

function listTool(resolveService, callerId) {
  return {
    name: "subagent_list",
    namespace: SUBAGENT_NAMESPACE,
    defaultActive: false,
    label: "List Subagents",
    description:
      "List the parent, peers (including self), and own children. Each group is capped at the per-parent concurrency limit: active first, then most recently stopped. Main also expands visible active children; stopped nodes and peers are not expanded. Set all: true for every agent. Main has no subagent history paths. Does not wait for completion.",
    promptSnippet: "Check background agent progress and history paths",
    promptGuidelines: SUBAGENT_NAMESPACE.instructions.split("\n"),
    parameters: listParameters,
    async execute(_toolCallId, params) {
      const service = await resolveService();
      assertOperational(service);
      const result = service.runtime.listDetailed(params, { callerId });
      return respond(result);
    },
  };
}

function stopTool(resolveService) {
  return {
    name: "subagent_stop",
    namespace: SUBAGENT_NAMESPACE,
    defaultActive: false,
    label: "Stop Subagent",
    description:
      "Request cancellation of an agent by id. May return stopping or finalizing while execution or history writes finish; does not wait for shutdown.",
    promptSnippet: "Cancel a background agent's current run",
    promptGuidelines: SUBAGENT_NAMESPACE.instructions.split("\n"),
    parameters: stopParameters,
    async execute(_toolCallId, params) {
      const service = await resolveService();
      assertOperational(service);
      const result = service.runtime.stop(params.id);
      return respond(result);
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
  return depth < MAX_AGENT_DEPTH ? HARNESS_TOOLS : LEAF_HARNESS_TOOLS;
}

function transplantableToolNames(pi, childDepth) {
  const names = new Set([...harnessToolsForDepth(childDepth), "read", "write", "msg_write"]);
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
 * tools. A Fresh Job uses the SDK's initial loadout, filtered by its parent's
 * eligibility and the routed role's explicit blacklist.
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

// A stopped/restored parent still owns its last loadout. This view is only
// permission metadata, never transplanted execution handles.
function parentCapabilityApi(service, agentId) {
  if (!agentId) return service.controller.pi;
  const live = [...service.liveJobs.values()].find((job) => job.agentId === agentId && job.pi);
  const record = service.retained.get(agentId);
  if (live?.pi && !live.closed) return live.pi;
  if (!record) throw new Error(`Missing parent capability scope for ${agentId}`);
  const names = new Set(record.tools ?? []);
  const api = {
    getActiveTools: () => [...names],
    getAllTools: () => service.controller.pi.getAllTools().filter((tool) => names.has(tool.name)),
  };
  setCapabilityParent(api, service.controller.pi, record.excludedTools ?? []);
  return api;
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
  let execution = null;
  let updateRetainedTools = null;
  let finalizeActor = null;
  let unsubscribe = null;
  let unsubscribeBudget = null;
  let unsubscribeClean = null;
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
  const live = { jobId: request.jobId, agentId: request.agentId, session: null, execution: null, pending: [], steers: new Set(), closed: false };
  // Startup input assigned to this Job, including the trigger of a revival, runs first.
  for (const message of request.pendingMessages) {
    const text = message.type === "notification" ? formatCompletion(message) : formatPeerMessage(message);
    live.pending.push({ from: message.from, content: message.content, text });
  }
  service.liveJobs.set(request.jobId, live);
  // The runtime owns what an expired Budget does to the Job: checkBudget()
  // routes a hard failure through its stopping transition, which cancels this
  // handle — cancelled/closed plus both abort signals — once it is assigned.
  const stopBudgetWatch = watchBudget(request.budget, request.checkBudget);
  // One reusable cleanup set: the execution handle owns it once a native
  // session exists, and the failure path before creation still releases it.
  const releaseJobResources = () => {
    stopBudgetWatch();
    unsubscribeClean?.();
    unsubscribeBudget?.();
    unsubscribe?.();
  };

  const done = (async () => {
    // A retired service must never start native work for a session that no
    // longer exists; its Jobs fail explicitly instead.
    if (!service.active || service.closed) {
      throw new SubagentError("runtime_closed", "This subagent runtime was retired; the Job was not started.");
    }
    // A continuation whose actor never started — a task cancelled while it was
    // before SDK initialization — rebuilds its first native session from the original seed;
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
    let enabledTools = [];
    let excludedTools = retained?.excludedTools ?? (retained?.roleId ? NATIVE_TOOL_NAMES.filter((name) => !plannedTools?.includes(name)) : []);
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
        configPath: join(service.controller.agentDir, "subagent-routing.json"),
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
      excludedTools = [...routed.excludeTools];
      enabledTools = [...routed.enableTools];
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
        excludedTools,
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
        setCapabilityParent(childPi, () => parentCapabilityApi(service, request.origin?.agentId), [...excludedTools, ...(request.depth >= MAX_AGENT_DEPTH ? ["capability", "subagent_create", "subagent_stop"] : [])]);
        capabilityExtension(childPi, { discovery: request.depth < MAX_AGENT_DEPTH });
        live.pi = childPi;
        // A child surface always speaks for the service that created it, never
        // for a later root session.
        installSessionSurface(childPi, () => service, {
          // Inherited children must not create further Inherited Subagents.
          allowInherited,
          parentAgentId: request.agentId,
          depth: request.depth,
          cwd,
          senderId: request.agentId,
        });
        // This Subagent conversation is the recipient of its own children's
        // events. The same coordinator that queued an ordinary message can
        // therefore merge the terminal notice of that sender and round before
        // Pi writes it to history.
        childPi.on("input", () => {
          service.agentDeliveries.get(request.agentId)?.breakMergeKeys();
        });
        childPi.on("message_start", (event) => {
          const delivery = service.agentDeliveries.get(request.agentId);
          if (delivery === undefined) return;
          if (event.message?.role === "user") delivery.breakMergeKeys();
          delivery.messageStarted(event.message);
        });
        childPi.on("agent_settled", () => {
          service.agentDeliveries.get(request.agentId)?.settle();
        });
        childPi.on("agent_end", (event) => {
          const last = event.messages?.at(-1);
          if (last?.role === "assistant" && last.stopReason === "aborted") {
            service.agentDeliveries.get(request.agentId)?.settle();
          }
        });
        childPi.on("message_end", (event) => {
          const delivery = service.agentDeliveries.get(request.agentId);
          if (delivery === undefined) return undefined;
          const message = delivery.replaceMessage(event.message);
          return message === undefined ? undefined : { message };
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
      appendSystemPrompt: [
        ...(roleInstructions !== null ? [roleInstructions] : []),
        `You are Subagent ${request.agentId}. Your direct parent is ${request.origin?.agentId ?? "Main"}. To message that parent, use your enabled write or msg_write with parentSocket ${getAgentSocketPath(request.origin?.agentId ?? "Main", service.socketDir)} and plain text content; omit from and to. The host frames the transport and binds your sender identity. Your execution round also ends with an automatic host notification; do not send a separate completion message unless you have content the parent needs.`,
      ],
    });
    await resourceLoader.reload();
    throwIfBudgetFailed(request.budget);

    // Creation owns the SDK Session immediately: the returned execution handle
    // is registered here, before the next Budget check can throw, so a Budget
    // failure can never leak a created session.
    execution = await openSubagentExecution(
      {
        cwd,
        agentDir: service.agentDir,
        settingsManager: settings,
        modelRuntime,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        excludeTools: [...excludedTools, ...(request.depth >= MAX_AGENT_DEPTH ? ["capability", "subagent_create", "subagent_stop"] : [])],
        sessionManager,
        resourceLoader,
      },
      { signal: abort.signal },
    );
    session = execution.session;
    live.session = session;
    live.execution = execution;
    execution.addCleanup(releaseJobResources);
    throwIfBudgetFailed(request.budget);
    plannedTools = [...new Set([...(plannedTools ?? session.getActiveToolNames()), ...enabledTools, ...harnessToolsForDepth(request.depth)])];
    session.setActiveToolsByName(plannedTools.filter((name) => capabilityAllowsTool(live.pi, name)));
    capabilityAvailableTools(live.pi);
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

    // This Job's history is scoped by the append-only SessionManager tree: the
    // boundary is the leaf at start, and native compaction appends entries
    // instead of rewriting or dropping them. The boundary is recorded before
    // the run so a Job that dies mid-turn still has a sealed start.
    const boundary = sessionManager.getLeafId();
    const jobMessages = () => messagesAfter(sessionManager, boundary);
    // Bounds only, and no empty transcript: a Job keeps no in-memory messages
    // until its final outcome, so every live read resolves the native entries.
    request.recordHistory(undefined, { startEntryId: boundary, endEntryId: boundary });

    await withSocketChanges(service, async () => {
      const actor = service.runtime.list().agents.find((entry) => entry.agentId === request.agentId);
      await restoreListenerGroup(service, actor.parentAgentId, actor.agentId);
      if (request.depth < MAX_AGENT_DEPTH && request.continuedFromJobId) await restoreListenerGroup(service, request.agentId);
    });

    const history = { spec: request.spec, roleId, model, appendChain: Promise.resolve(), errors: [] };
    service.jobHistory.set(request.jobId, history);
    const queueCleanAppend = (event) => {
      history.appendChain = history.appendChain.then(async () => {
        try {
          await appendCleanJsonl(request.agentId, event, { baseDir: service.historyDir, cwd: service.cwd });
        } catch (err) {
          // Keep every failure: a later successful append must not hide a
          // partial transcript. The finalization hook reports all of them
          // while the Job outcome stays frozen.
          history.errors.push(err);
          service.ui?.notify?.(`Clean JSONL error on ${request.agentId}: ${err.message}`, "error");
        }
      });
    };

    let jobErr = null;

    if (!cancelled) {
      unsubscribeClean = session.subscribe((event) => {
        try {
          if (!event || typeof event !== "object") return;
          const type = event.type;
          if (type === "message_start") {
            queueCleanAppend({
              type: "message_start",
              role: event.message?.role,
              timestamp: Date.now(),
            });
          } else if (type === "tool_execution_start") {
            queueCleanAppend({
              type: "tool_execution_start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              timestamp: Date.now(),
            });
          } else if (type === "tool_execution_end") {
            queueCleanAppend({
              type: "tool_execution_end",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
              result: event.result,
              timestamp: Date.now(),
            });
          } else if (type === "message_end") {
            const message = event.message;
            const custom = message?.role === "custom";
            queueCleanAppend({
              type: "message_end",
              role: message?.role,
              content: message?.content,
              stopReason: message?.stopReason,
              usage: message?.usage,
              // Host terminal/ordinary delivery is distinguishable from Agent
              // text only through these custom-message fields; dropping them
              // loses job/round/status metadata from the clean JSONL audit.
              ...(custom
                ? { customType: message?.customType, display: message?.display, details: message?.details }
                : {}),
              timestamp: typeof message?.timestamp === "number" ? message.timestamp : Date.now(),
            });
          }
        } catch {}
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
      const startupCustom = assigned.filter((entry) => entry.kind === "custom");
      const assignedText = assigned.filter((entry) => entry.kind !== "custom");
      const prompt = isContinuation
        ? composeContinuationPrompt(assignedText, pendingAssignment)
        : composePrompt(pendingAssignment, assignedText);
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
        // Resolve startup custom snapshots and append their typed native
        // history BEFORE the primary prompt. This is the same merge path as
        // parked replay, so coalesced content and terminal details survive.
        const startupDelivery = service.agentDeliveries.get(request.agentId) ?? null;
        for (const entry of startupCustom) {
          let resolved = entry.message;
          if (startupDelivery !== null && resolved?.customType === DELIVERY_CUSTOM_TYPE) {
            resolved = startupDelivery.replaceMessage(resolved) ?? resolved;
          }
          if (resolved?.role !== "custom" || typeof resolved.customType !== "string") continue;
          await session.sendCustomMessage(
            {
              customType: resolved.customType,
              content: resolved.content,
              display: resolved.display,
              details: resolved.details,
            },
            { triggerTurn: false },
          );
        }
        // Whatever the run then does — finish, fail or be stopped — its own
        // outcome decides the Job; the prompt submission itself is final.
        try {
          await execution.prompt(prompt, { expandPromptTemplates: false });
        } finally {
          markAssignmentDelivered();
        }
        throwIfBudgetFailed(request.budget);
        if (!cancelled) {
          const messages = jobMessages();
          assertRunCompleted(messages);
          await drainLiveMessages(live, sessionManager, service);
          throwIfBudgetFailed(request.budget);
        }
      } catch (error) {
        jobErr = error;
      }
    } else {
      try {
        await execution.abort();
      } catch {}
    }

    if (jobErr) throw jobErr;
    return {
      status: cancelled ? "cancelled" : "completed",
      result: readFinalText(jobMessages()),
      messages: readTranscript(entriesAfter(sessionManager, boundary)),
      history: { startEntryId: boundary, endEntryId: sessionManager.getLeafId() },
    };
  })().finally(async () => {
    live.closed = true;
    service.liveJobs.delete(request.jobId);
    // A revival reuses the loadout the run actually ended with — capability
    // activation can open tools mid-run — never the pre-run allowlist.
    if (!service.closed) finalizeActor?.();
    if (execution === null) releaseJobResources();
    if (execution !== null) {
      try {
        await execution.dispose();
      } catch (error) {
        service.ui?.notify?.(`Subagent session cleanup failed for ${request.agentId}: ${errorMessage(error)}`, "error");
      }
    }
  });

  return {
    cancel: () => {
      cancelled = true;
      live.closed = true;
      abort.abort();
      const pending = execution?.abort();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    },
    done,
  };
}

/**
 * Finalize Job history in clean JSONL and Markdown summary.
 * Invoked once per job by Runtime with frozen outcome.
 */
async function finalizePiJob(service, { job, outcome }) {
  const { spec = {}, roleId, model, appendChain, errors = [] } = service.jobHistory.get(job.jobId) ?? {};
  const failures = [...errors];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await appendChain;
    await attempt(() => appendCleanJsonl(
      job.agentId,
      {
        type: "job_end",
        jobId: outcome.jobId,
        round: outcome.round,
        status: outcome.status,
        error: outcome.error,
        budget: outcome.budget,
        timestamp: Date.now(),
      },
      { baseDir: service.historyDir, cwd: service.cwd },
    ));
    await attempt(() => writeCompactedSummary(
      job.agentId,
      {
        name: spec.name ?? job.name,
        task: typeof spec.task === "string" ? spec.task : "",
        role: roleId ?? null,
        model: modelRefOf(model)?.id ?? (typeof model === "string" ? model : null),
        budget: outcome.budget,
        result: outcome.result || (outcome.error ? `Terminated with error: ${outcome.error.message}` : "(No output recorded)"),
        status: outcome.status,
        error: outcome.error?.message ?? null,
        round: outcome.round,
      },
      { append: outcome.round > 1, baseDir: service.historyDir, cwd: service.cwd },
    ));
  } finally {
    service.jobHistory.delete(job.jobId);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `History finalization failed for ${job.agentId}.`);
  }
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
      excludedTools: [...(descriptor.excludedTools ?? [])],
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
  if (message?.type === "notification") {
    return `[Subagent ${message.subagentId || message.from} ${message.status}]: ${message.content || ""}`;
  }
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
  if (message?.type === "notification") {
    return {
      type: "notification",
      from: message.from ?? message.subagentId ?? null,
      subagentId: message.subagentId || message.from,
      jobId: message.jobId ?? null,
      round: message.round ?? null,
      status: message.status ?? "failed",
      error: message.error ?? null,
      history: message.history ?? getSubagentHistoryPaths(message.subagentId || message.from),
      content: message.content ?? null,
    };
  }
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
        await (live.execution ?? live.session).steer(text);
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
async function drainLiveMessages(live, sessionManager, service) {
  if (live.session === null) return;
  for (;;) {
    while (live.steers.size > 0) {
      await Promise.all([...live.steers]);
    }
    const parked = takeParkedMessages(live.session);
    const buffered = live.pending.splice(0);
    if (parked.length === 0 && buffered.length === 0) {
      live.closed = true;
      return;
    }
    const delivery = service?.agentDeliveries?.get(live.agentId) ?? null;
    // Replay each parked native message with its original semantics. A parked
    // `agent-delivery` custom message is only the first snapshot: resolve it
    // through the recipient coordinator so coalesced content and the terminal
    // notice are not lost before the custom message re-enters the session.
    for (const message of parked) {
      if (message?.role === "custom") {
        await replayParkedCustom(live, sessionManager, message, delivery);
      } else {
        await replayParkedUser(live, sessionManager, message);
      }
    }
    const bufferedText = [];
    for (const entry of buffered) {
      if (entry.kind === "custom") {
        await replayParkedCustom(live, sessionManager, entry.message, delivery);
      } else {
        bufferedText.push(entry);
      }
    }
    if (bufferedText.length > 0) {
      const boundary = sessionManager.getLeafId();
      const run = live.execution ?? live.session;
      await run.prompt(bufferedText.map((entry) => entry.text).join("\n\n"), {
        expandPromptTemplates: false,
      });
      assertRunCompleted(messagesAfter(sessionManager, boundary));
    }
  }
}

async function replayParkedCustom(live, sessionManager, message, delivery) {
  let resolved = message;
  if (message.customType === DELIVERY_CUSTOM_TYPE && delivery !== null) {
    resolved = delivery.replaceMessage(message) ?? message;
  }
  if (resolved?.role !== "custom" || typeof resolved.customType !== "string") return;
  const boundary = sessionManager.getLeafId();
  // The supported AgentSession path preserves customType/display/details and
  // runs the same ModelCall Budget hooks as any other turn. Re-feeding the
  // snapshot as plain user text would both lose host metadata and replay only
  // the first delta.
  const operation = (async () => {
    await live.session.sendCustomMessage(
      {
        customType: resolved.customType,
        content: resolved.content,
        display: resolved.display,
        details: resolved.details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  })();
  live.steers.add(operation);
  try {
    await operation;
  } finally {
    live.steers.delete(operation);
  }
  assertRunCompleted(messagesAfter(sessionManager, boundary));
}

async function replayParkedUser(live, sessionManager, message) {
  const content = message?.content;
  const texts = [];
  const images = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part?.type === "image") images.push(part);
    }
  }
  const text = texts.join("\n");
  if (text === "" && images.length === 0) return;
  const boundary = sessionManager.getLeafId();
  const run = live.execution ?? live.session;
  await run.prompt(text, {
    expandPromptTemplates: false,
    ...(images.length > 0 ? { images } : {}),
  });
  assertRunCompleted(messagesAfter(sessionManager, boundary));
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
 * Remove and return every message parked in the session's own queues. They
 * were never consumed, so the Job's end-of-turn loop owns their delivery; a
 * steering message the run already consumed is gone from the queue and is
 * never replayed. Custom messages stay custom instead of being flattened.
 */
function takeParkedMessages(session) {
  const agent = session?.agent;
  if (typeof agent?.hasQueuedMessages !== "function" || !agent.hasQueuedMessages()) return [];
  let probeSequence = 0;
  // Both queue modes are forced to "all" only for this synchronous read. The
  // probes make `peekQueuedMessages()` select each queue in turn, so multiple
  // steering messages and follow-ups are preserved rather than reduced to the
  // next default-mode batch. No private queue field is touched.
  const queued = takeQueuedMessages(agent, (queue) => ({
    role: "user",
    content: [{ type: "text", text: `\u0000subagent-queue-probe-${queue}-${++probeSequence}` }],
    timestamp: 0,
  }));
  // Agent queues are empty now; clear the AgentSession text mirrors without
  // dropping any custom message (they were returned above).
  session.clearQueue?.();
  return queued;
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
 * before SDK initialization — the original assignment is restated before them, so the new Job
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
