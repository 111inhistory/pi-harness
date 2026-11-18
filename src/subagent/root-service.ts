import path from 'node:path';
import { AsyncShellHost } from '../async-shell/host.ts';
import { installAsyncShellSurface } from '../async-shell/surface.ts';
import { installInheritedShellChecks } from '../shell-approval/bridge.ts';
import { cancelTask } from '../async-shell/cancel.ts';
import type { ShellResult } from '../async-shell/protocol.ts';
import { existsSync } from 'node:fs';
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../harness-config.ts';
import { createSubagentStore, EVENTS, SUBAGENT_SESSIONS_DIR } from './storage.ts';
import { hasJobView, jobViewPaths, writeJobView, readTranscript } from './view.ts';
import { interruptionNotice } from './prompt.ts';
import { routeSubagent } from './routing.ts';
import { loadPresets } from '../preset/config.ts';
import { DEFAULT_SOCKET_DIR, deriveSessionUid } from '../ipc/socket.ts';
import { sessionByUid, type LiveSession } from './session-directory.ts';
import {
  formatAddress, formatChildrenAddress, formatMainEndpointPath, MAIN_ACTOR,
  parseActorKey, parseAddress, type LogicalAddress,
} from './address.ts';
import { SessionPeers, type SessionConnect } from './session-peers.ts';
import { ensurePrivateSocketRoot } from '../ipc/platform.ts';
import { activateToolNames } from '../capability/activation.ts';
import { createToolAccessView } from '../capability/tool-access-view.ts';
import { setCapabilityParent, setCapabilityStartupBlacklist, type CapabilityToolCatalog } from '../capability/scope.ts';
import { ActorSessionStore } from './actor-sessions.ts';
import { RootListener } from './listeners.ts';
import { NativeJobRunner } from './native-runner.ts';
import { NativeDeliveryRouter } from './native-delivery.ts';
import type { DeliveryCustomMessage } from './delivery.ts';
import { createNativeSessionFactory } from './native-session.ts';
import { installSessionSurface, type SubagentSurfaceCreateOptions } from './surface.ts';
import type { ManagedWriteHost, ResolvedTarget } from './managed-send.ts';
import type { NativeLiveSnapshot, NativeRouteResult, NativeRoutingPort, NativeSessionEvent } from './native-types.ts';
import {
  createSubagentRuntime, copyInheritedEntries, SubagentError,
  type RuntimeEvent, type SubagentRuntime, type DetailedAgentItem,
  type CreatedBatch, type JobHistoryPaths, type FinalizeJobInput,
  type InheritedContext, type SignalResult,
  type BroadcastReceipt, type ExternalSender, type MessageReceipt,
} from './runtime.ts';

interface RootServiceOptions {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly agentDir: string;
  readonly allocatedIds: Set<string>;
  /**
   * The root's one resolved Harness snapshot. A direct programmatic
   * construction without a snapshot uses the built-in defaults; the extension
   * always passes the snapshot resolved for its session.
   */
  readonly config?: HarnessConfig;
  ownsContext(): boolean;
}

type RootPhase = 'initializing' | 'open' | 'quiescing' | 'detached' | 'failed';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const resultText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SubagentError('history_write_failed', 'The native task result is not text.');
  return value;
};

// Native captures originate in SDK context. Validate required chat fields at
// this opaque boundary; retain SDK-owned optional provider configuration intact.
function isCapturedChatModel(value: unknown): value is Model<Api> {
  if (!record(value) || (value.type !== undefined && value.type !== 'chat')) return false;
  if (!['id', 'name', 'api', 'provider', 'baseUrl'].every((key) => typeof value[key] === 'string')) return false;
  if (typeof value.reasoning !== 'boolean' || typeof value.contextWindow !== 'number' || typeof value.maxTokens !== 'number') return false;
  if (!Array.isArray(value.input) || !value.input.every((entry: unknown) => entry === 'text' || entry === 'image')) return false;
  const cost = value.cost;
  return record(cost) && ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => typeof cost[key] === 'number');
}

// Persisted Actor identities resolve through the catalog. An initial Inherited
// capture may be an SDK-supplied custom model not registered in that catalog.
function capturedModel(value: unknown, registry: ModelRegistry): Model<Api> | null {
  if (!record(value)) return null;
  if (typeof value.provider !== 'string' || typeof value.id !== 'string') return null;
  const catalog = registry.find(value.provider, value.id);
  if (catalog !== undefined) return catalog;
  if (isCapturedChatModel(value)) return value;
  throw new SubagentError('model_unavailable', `The captured model ${value.provider}/${value.id} is not in the current catalog.`);
}

type ResolvedRootServiceOptions = RootServiceOptions & { readonly config: HarnessConfig };

/** One root's domain, native resources and write ownership. */
export class RootService implements ManagedWriteHost {
  readonly #options: ResolvedRootServiceOptions;
  /** Session this root was created for; identifies the data the service owns. */
  readonly sessionId: string;
  readonly runtime: SubagentRuntime;
  readonly actors: ActorSessionStore;
  readonly runner: NativeJobRunner;
  readonly listeners: RootListener;
  readonly shell: AsyncShellHost;
  readonly #delivery: NativeDeliveryRouter;
  readonly #peers: SessionPeers;
  readonly #store: ReturnType<typeof createSubagentStore<SessionManager>>;
  readonly #historyDir: string;
  readonly #pendingEvents: RuntimeEvent[] = [];
  #creation: { ready: { agentId: string; ready: Promise<void> }[] } | null = null;
  readonly #retainedScopes = new Map<string, CapabilityToolCatalog>();
  /**
   * The root catalog as a child's parent chain sees it, with explicitly
   * managed tools removed: a disabled tool is a hard denial, while a
   * root-only enabled tool is denied only when it has no independent child
   * Harness grant. Stable per root because the capability scope keys on the
   * catalog object; `getAllTools` reads the current root branch so a rule
   * added later is filtered for views built afterwards. The authoritative
   * prohibition is the live denial applied by {@link #parentScope}: a learned
   * catalog is append-only, so filtering alone cannot revoke a name an earlier
   * view already learned.
   */
  #rootScopeCache: CapabilityToolCatalog | null = null;
  #registry: ModelRegistry;
  #phase: RootPhase = 'initializing';
  #failure: Error | null = null;
  #persistenceFailure: Error | null = null;
  #retirement: Promise<void> | null = null;

  constructor(options: RootServiceOptions) {
    this.#options = { ...options, config: options.config ?? DEFAULT_HARNESS_CONFIG };
    this.#registry = options.context.modelRegistry;
    const manager = options.context.sessionManager;
    const sessionId = manager.getSessionId();
    this.sessionId = sessionId;
    const sessionFile = manager.getSessionFile();
    const cwd = options.context.cwd;
    const durable = typeof sessionFile === 'string' && sessionFile !== '';
    const socketRoot = path.resolve(cwd, DEFAULT_SOCKET_DIR);
    const socketDir = path.join(socketRoot, deriveSessionUid(sessionId));
    this.#historyDir = path.join(options.agentDir, SUBAGENT_SESSIONS_DIR, sessionId, 'views');
    this.#store = createSubagentStore({
      ...(durable ? { dir: path.join(options.agentDir, SUBAGENT_SESSIONS_DIR, sessionId) } : {}),
      appendEntry: (kind: string, data: unknown) => options.api.appendEntry(kind, data),
      readBranch: () => manager.getBranch(),
      readEntries: () => manager.getEntries(),
      openSession: (file: string, overrideCwd?: string) => SessionManager.open(file, undefined, overrideCwd),
    });
    this.actors = new ActorSessionStore({
      storage: {
        durable: this.#store.durable,
        openForAppend: (agentId, file, anchor, actorCwd) => this.#store.openForAppend(agentId, file, anchor, actorCwd),
        readSlice: (...args) => this.#store.readSlice(...args),
        hasRecordedTurn: (...args) => this.#store.hasRecordedTurn(...args),
        interruptedEnd: (...args) => this.#store.interruptedEnd(...args),
      },
      guard: { mayPersist: () => this.#mayPersist() },
      models: { find: (model) => this.#registry.find(model.provider, model.id) ?? null },
      metadata: {
        appendIdentity: ({ agentId, patch, anchor }) => this.#append(EVENTS.actor, { agentId, ...patch, anchor }),
        appendAnchor: (data) => this.#append(EVENTS.anchor, data),
      },
    });
    this.#socketDir = socketDir;
    // Callbacks, cross-session peers and local controls all reach the one main
    // endpoint; the frame, not the destination path, names the owning Actor.
    const mainAddress = formatMainEndpointPath(socketDir);
    this.shell = new AsyncShellHost({
      mainAddress: () => mainAddress,
      accepting: () => this.active,
      wake: (actorId) => this.runner.wake(actorId),
      deliver: (actorId, result) => this.#shellResult(actorId, result),
      cancel: cancelTask,
    });
    this.listeners = new RootListener({
      mainAddress,
      socketRoot,
      // Windows Named Pipes have no directory of their own to release.
      mainDirectory: process.platform === 'win32' ? null : socketDir,
      isAccepting: () => this.active,
      deliver: (input) => this.#deliver(input),
      receiveShell: (actorId, frame) => this.shell.receive(actorId, frame),
      onError: (error) => this.#report(error),
    });
    const sessions = createNativeSessionFactory({
      agentDir: options.agentDir,
      config: this.#options.config,
      modelRegistry: () => this.#registry,
      parentCapabilityScope: (id) => this.#parentScope(id),
      installChildSurface: (api, scope) => {
        installInheritedShellChecks(api, options.api, scope.senderId);
        installAsyncShellSurface(api, async () => {
          this.assertOperational();
          return this.shell;
        }, scope.senderId);
        installSessionSurface(api, async () => {
          this.assertCurrent();
          return this;
        }, {
          callerId: scope.senderId,
          depth: scope.depth,
          allowInherited: scope.allowInherited,
          maxDepth: scope.maxDepth,
          capacityFor: () => this.#options.config.subagent,
        });
      },
    });
    const owner = this;
    this.runner = new NativeJobRunner({
      root: {
        get storageError() { return owner.#failure; },
        get canStartJob() { return owner.active; },
        get mayPersist() { return owner.#mayPersist(); },
      },
      config: { harness: this.#options.config }, actors: this.actors, sessions,
      models: { inherited: (model) => capturedModel(model, this.#registry) },
      routing: { route: (input) => this.#route(input) },
      tools: { catalog: () => options.api.getAllTools() },
      work: { hasPending: (agentId) => this.runtime.hasActiveChildren(agentId) || this.shell.hasPending(agentId) },
      notify: (message) => this.#report(new Error(message)),
    });
    this.runtime = createSubagentRuntime({
      session: deriveSessionUid(sessionId),
      config: this.#options.config,
      isIdTaken: (id) => options.allocatedIds.has(id),
      onIdAllocated: (id) => options.allocatedIds.add(id),
      startJob: (request) => {
        // One external endpoint is bound for the whole generation, so a new
        // batch has nothing to publish. Its readiness is still reported by the
        // synchronous create call, so collect each started Job handle here.
        const handle = this.runner.start(request);
        this.#creation?.ready.push({ agentId: request.agentId, ready: handle.ready });
        return handle;
      },
      finalizeJob: (input) => this.#finalize(input),
      // Pure path projection only. Reading/rebuilding belongs to list(), not
      // domain transitions or notification publication.
      historyPaths: (jobId) => this.#historyPaths(jobId),
      // Interrupt cancels the current native run only; the runner appends the
      // sender-bound notice and the same Job/Actor/Budget continue. A refusal
      // stays a refusal; it never degrades into a stop.
      interruptJob: async ({ jobId, from }) => {
        const outcome = await this.runner.interrupt(jobId, { from, content: interruptionNotice(from) });
        return outcome.accepted ? { ok: true } : { ok: false, reason: outcome.reason };
      },
      deliverMessage: (input) => this.#delivery.toAgent(input),
      deliverToMain: (message) => this.#delivery.toMain(message),
      onEvent: (event) => this.#event(event),
      onChildrenSettled: (agentId) => this.runner.wake(agentId),
      prepareInherited: ({ agentId, snapshot }) => {
        if (!this.#store.durable) return { ...snapshot, entries: copyInheritedEntries(snapshot.entries) };
        if (!Array.isArray(snapshot.entries)) throw new SubagentError('invalid_state', 'The captured seed has no native entries.');
        const { entries, ...metadata } = snapshot;
        const seed = this.#store.writeSeed(agentId, entries, typeof snapshot.cwd === 'string' ? snapshot.cwd : cwd);
        return { ...metadata, seedFile: seed.file, seedLeafId: seed.seedLeafId };
      },
    });
    this.#delivery = new NativeDeliveryRouter({
      runner: this.runner,
      ownsContext: () => this.#mayPersist(),
      canWake: () => this.active,
      activateReply: () => this.#activateReplyTool(),
      sendToMain: (message, triggerTurn) => this.#acceptMainDelivery(message, triggerTurn),
    });
    // Validate the private root inside initialize(), so failure is latched and
    // tools report it rather than repeatedly rebuilding an insecure service.
    this.#socketRoot = socketRoot;
    this.#peers = new SessionPeers({
      api: options.api, context: options.context, root: socketRoot, sessionId,
      assertOperational: () => this.assertOperational(),
      waitForCompaction: () => this.#compaction?.promise ?? Promise.resolve(),
      report: error => this.#report(error),
    });
  }

  readonly #socketRoot: string;
  readonly #socketDir: string;
  /** Compaction holds SDK handoff; admitted messages remain owned by this root. */
  #compaction: { readonly promise: Promise<void>; readonly resolve: () => void } | null = null;
  readonly #mainDeliveries: Array<{ message: DeliveryCustomMessage; triggerTurn: boolean }> = [];
  #mainDeliveryDrain: Promise<void> | null = null;
  /** The resolved nesting limit of this root's snapshot. */
  get maxDepth(): number { return this.#options.config.subagent.maxDepth; }
  get active(): boolean { return this.#phase === 'open' && this.#failure === null && this.#options.ownsContext(); }
  get closed(): boolean { return this.#phase === 'detached'; }

  /** Current ownership permits inspection and cancellation after a write failure. */
  assertCurrent(): void {
    if (this.#phase === 'failed' && this.#options.ownsContext() && this.#failure !== null) throw this.#failure;
    if (this.#phase !== 'open' || !this.#options.ownsContext()) {
      throw new SubagentError('runtime_closed', 'The root is not accepting new operations.');
    }
  }

  assertOperational(): void {
    this.assertCurrent();
    if (this.#failure !== null) throw this.#failure;
  }

  async initialize(): Promise<void> {
    try {
      if (process.platform !== 'win32') ensurePrivateSocketRoot(this.#socketRoot);
      const state = this.#store.load();
      for (const id of this.#store.takenIds()) this.#options.allocatedIds.add(id);
      const jobs = state.jobs;
      for (const actor of state.actors) {
        if (actor.record == null) continue;
        const first = jobs.find((job) => job.agentId === actor.agentId && job.continuedFromJobId === null);
        const seed = first && record(first.spec) && record(first.spec.inheritedContext) ? first.spec.inheritedContext : null;
        this.actors.restoreIdentity({ agentId: actor.agentId, record: actor.record, anchor: actor.anchor, seed });
      }
      const restoredJobs = jobs.map((job) => {
        if (job.end != null) return job;
        const seed = record(job.spec) && record(job.spec.inheritedContext) ? job.spec.inheritedContext : null;
        // An unstarted continuation still owns only the interval after the
        // Actor's sealed checkpoint, never the preceding Job's conversation.
        const start = job.started === true ? job.startEntryId
          : job.continuedFromJobId !== null ? this.actors.get(job.agentId)?.anchor ?? null
          : seed?.seedLeafId ?? null;
        if (start !== null && typeof start !== 'string') throw new SubagentError('storage_corrupt', 'A Job has malformed native start bounds.');
        const end = this.actors.recoveryBoundEnd({ agentId: job.agentId, startEntryId: start }) ?? start;
        this.actors.seal(job.agentId, end);
        return { ...job, history: { startEntryId: start, endEntryId: end } };
      });
      this.runtime.restoreState({ ...state, jobs: restoredJobs });
      const initial = jobs.filter((job) => job.continuedFromJobId === null).map((job) => {
        const start = job.startEntryId ?? null;
        if (start !== null && typeof start !== 'string') throw new SubagentError('storage_corrupt', 'A Job has malformed native start bounds.');
        return { agentId: job.agentId, startEntryId: start };
      });
      this.actors.restateAssignments(initial);
      this.#phase = 'open';
      for (const event of this.#pendingEvents.splice(0)) this.#event(event);
      await this.listeners.sync();
      await this.#peers.publish();
    } catch (error) {
      const primary = errorOf(error);
      this.#failure = primary;
      this.#phase = 'failed';
      // Release whatever this failed generation published: the single bound
      // endpoint and its now-empty directory. A cleanup failure must not be
      // swallowed: this generation stays fenced and both causes are reported.
      try {
        await this.listeners.close();
      } catch (cleanupError) {
        this.#failure = new AggregateError([primary, cleanupError], 'The root failed to initialize and did not release its endpoint.');
      }
      this.#report(this.#failure);
    }
  }

  async create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedBatch> {
    this.assertOperational();
    this.#registry = ctx.modelRegistry;
    const creation = { ready: [] as { agentId: string; ready: Promise<void> }[] };
    let created: CreatedBatch;
    this.#creation = creation;
    try {
      created = this.runtime.create(batch, options);
      if (this.#persistenceFailure !== null) throw this.#persistenceFailure;
    } finally {
      this.#creation = null;
    }
    // A Job handle exists only after Runtime registered the whole batch, so a
    // startup failure leaves the registered Actors in place: the caller gets
    // the registered batch and must not recreate it.
    const started = await Promise.allSettled(creation.ready.map(item => item.ready));
    const failures = started.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ agentId: creation.ready[index]!.agentId,
          code: outcome.reason instanceof SubagentError ? outcome.reason.code : 'session_unavailable',
          message: errorOf(outcome.reason).message }] : []);
    if (failures.length) throw new SubagentError('start_failed',
      `Subagent startup failed: ${failures.map(item => item.agentId + ': ' + item.message).join('; ')}. Registered agents: ${created.items.map((item) => item.id).join(', ')}; do not recreate this batch.`,
      { registered: created.items, failures });
    // The settled routing identity is host-attached after readiness; the domain
    // item carries no role or model of its own.
    return { ...created, items: created.items.map(item => {
      const actor = this.actors.get(item.id);
      return { ...item, role: actor?.roleId ?? null, model: actor?.modelRef?.id ?? null };
    }) };
  }

  async list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null> {
    this.assertCurrent();
    if (!record(filter)) throw new SubagentError('invalid_request', 'List parameters must be an object.');
    if (filter.id !== undefined && typeof filter.id !== 'string') throw new SubagentError('invalid_request', 'List id must be a string.');
    if (filter.all !== undefined && typeof filter.all !== 'boolean') throw new SubagentError('invalid_request', 'List all must be a boolean.');
    const result = this.runtime.listDetailed({
      ...(typeof filter.id === 'string' ? { id: filter.id } : {}),
      ...(typeof filter.all === 'boolean' ? { all: filter.all } : {}),
    }, { callerId });
    const latest = new Map<string, string>();
    const live = new Map<string, string>();
    for (const job of this.runtime.jobs().jobs) {
      if (['completed', 'failed', 'cancelled'].includes(job.status)) latest.set(job.agentId, job.jobId);
      else live.set(job.agentId, job.jobId);
    }
    // List output carries the role, not execution configuration or activity.
    const enrich = (item: DetailedAgentItem): void => {
      const actor = this.actors.get(item.id);
      item.role = actor?.roleId ?? null;
      const liveJobId = live.get(item.id);
      if (liveJobId !== undefined) item.status = this.runner.executionStatus(liveJobId) ?? "running";
      const jobId = latest.get(item.id);
      if (jobId !== undefined) {
        try { const history = this.#view(jobId); if (history !== null) item.history = history; }
        catch (error) { item.historyError = { code: 'history_read_failed', message: errorOf(error).message }; }
      }
      item.children.forEach(enrich);
    };
    if (result) {
      enrich(result);
    }
    return result;
  }

  /**
   * Interrupt or stop one explicit target.
   *
   * The caller is bound here: a tool/RPC caller passes its own local key, and
   * the root turns it into a full sender address. `target` is a full logical
   * address from the model/RPC path; the CLI convenience forms (`main`,
   * `children`, an actor key) are expanded to this session's address. A target
   * in another session is refused: signal is a same-root control.
   */
  signal(target: string, action: 'interrupt' | 'stop', callerId: string): Promise<SignalResult> {
    this.assertCurrent();
    const own = deriveSessionUid(this.sessionId);
    const parsed = parseAddress(target) ?? localSignalAddress(own, target);
    if (parsed === null || parsed.session !== own) {
      throw new SubagentError('invalid_target', 'Signal requires a full logical address in this session.');
    }
    const from = parseAddress(callerId) ?? localSignalAddress(own, callerId);
    if (from === null || from.session !== own) {
      throw new SubagentError('invalid_target', 'The signal sender is not a local Agent address.');
    }
    return this.runtime.signal({ from: from.address, to: parsed.address, action });
  }

  /** Classify one logical target against this root and the live session directory. */
  resolveTarget(address: string): Promise<ResolvedTarget> {
    this.assertOperational();
    return this.#peers.target(address);
  }

  sendMessage(command: Parameters<SubagentRuntime['sendMessage']>[0]) {
    this.assertOperational();
    return this.runtime.sendMessage(command);
  }

  sendCrossSession(command: Parameters<SessionPeers['send']>[0]): Promise<void> {
    this.assertOperational();
    return this.#peers.send(command);
  }

  /**
   * Bind one declared sender at the IPC boundary.
   *
   * A bare local actor key is bound to this session; a foreign `<hex>:main`
   * must name a live registered session and reaches Runtime as the typed
   * external Main sender with that session's reply address. The declared
   * string is not authority: Runtime still applies recipient admission.
   */
  async #bindSender(from: string): Promise<{ sender: string; external?: ExternalSender }> {
    // The wire always carries a full logical address: a bare local key is not a
    // sender identity here, so an external client cannot omit its session.
    const claimed = parseAddress(from);
    if (claimed === null || claimed.kind !== 'actor') {
      throw new SubagentError('unknown_sender', 'The IPC sender is not a full logical Agent address.');
    }
    if (claimed.session === deriveSessionUid(this.sessionId)) return { sender: claimed.key };
    if (claimed.key !== MAIN_ACTOR) {
      throw new SubagentError('invalid_target', 'Cross-session messages are Main-to-Main only.');
    }
    const session = await sessionByUid(this.#socketRoot, claimed.session);
    if (session === null) {
      throw new SubagentError('unknown_session', 'The sending session is not registered under this socket root.');
    }
    return {
      sender: MAIN_ACTOR,
      // The reply address is the peer's logical Main address, the same kind of
      // target msg_write accepts; the endpoint path stays internal.
      external: { sessionId: session.sessionId, sender: from, replyTo: formatAddress(session.uid, MAIN_ACTOR) },
    };
  }

  /** Admit one external message frame; the root owns sender and target binding. */
  async #deliver(input: { from: string; to: string; content: string }): Promise<MessageReceipt | BroadcastReceipt> {
    this.assertOperational();
    const to = parseAddress(input.to);
    if (to === null || to.session !== deriveSessionUid(this.sessionId)) {
      throw new SubagentError('cross_session_target', 'An external frame may only address this session.');
    }
    const bound = await this.#bindSender(input.from);
    if (bound.external !== undefined && (to.kind !== 'actor' || to.key !== MAIN_ACTOR)) {
      throw new SubagentError('invalid_target', 'Cross-session messages are Main-to-Main only.');
    }
    // Runtime admits an external write only when the declared sender is the
    // resolved remote Main itself; the bound descriptor is the authority.
    return this.runtime.sendMessage({ from: bound.external?.sender ?? bound.sender, to: input.to, content: input.content,
      ...(bound.external === undefined ? {} : { external: bound.external }) });
  }

  /** Observe one live Job's full native event stream (null when it has no live run). */
  subscribeJobEvents(jobId: string, listener: (event: NativeSessionEvent) => void): (() => void) | null {
    this.assertCurrent();
    return this.runner.subscribeJobEvents(jobId, listener);
  }

  /** Read one live Job's current end boundary (undefined when it has no live run). */
  liveEndEntryId(jobId: string): string | null | undefined {
    this.assertCurrent();
    return this.runner.liveEndEntryId(jobId);
  }

  /** Read one live Job's stream projection (null when it has no live run). */
  liveSnapshot(jobId: string): NativeLiveSnapshot | null {
    this.assertCurrent();
    return this.runner.liveSnapshot(jobId);
  }

  async #shellResult(actorId: string, result: ShellResult): Promise<void> {
    const gate = this.#compaction;
    if (gate !== null) await gate.promise;
    this.assertOperational();
    const message = {
      customType: 'async-shell-result',
      content: JSON.stringify(result),
      display: true,
      details: { source: 'host', result },
    };
    if (actorId === MAIN_ACTOR) {
      await this.#options.api.sendMessage(message, { triggerTurn: true, deliverAs: 'steer' });
      return;
    }
    const job = this.runtime.jobs().jobs.find(item => item.agentId === actorId && item.status === 'running');
    // Cancellation may already have closed input before surface shutdown
    // revokes the lease. Keep that result in task logs; never revive a cancelled
    // Actor just to consume its command's terminal event.
    if (job === undefined) throw new SubagentError('job_closed', 'The async shell owner no longer has a live Job.');
    try {
      const outcome = await this.runner.handoffCustom(job.jobId, { from: 'async-shell', ...message });
      if (!outcome.accepted) throw new SubagentError('job_closed', 'The async shell owner no longer accepts input.');
    } catch (error) {
      // A failed handoff may already be queued. Stop this Job and report the
      // failure; never replay the event or complete from its old waiting text.
      this.runtime.cancelJob(job.jobId);
      throw error;
    }
  }

  /** The socket root every live session of this user publishes itself under. */
  get socketRoot(): string { return this.#socketRoot; }

  listSessions(): Promise<LiveSession[]> { return this.#peers.list(); }
  connectSession(target: string): Promise<SessionConnect> { return this.#peers.connect(target); }

  /**
   * A peer session addressed this Main; make the reply tool callable before the
   * triggered turn starts. This is receipt-scoped activation, not a grant: it
   * writes no capability record and does not load the rest of the namespace.
   */
  #activateReplyTool(): void {
    // An already active tool is complete, including a manual tool the user
    // enabled: activation must not re-judge it as manual_only and report a
    // false failure. Only an inactive tool goes through the normal activation
    // path, which keeps manual tools closed without an explicit grant.
    if (this.#options.api.getActiveTools().includes('msg_write')) return;
    const api = this.#options.api;
    const branch = this.#options.context.sessionManager.getBranch();
    const access = createToolAccessView(api, branch);
    const outcome = activateToolNames(api, ['msg_write'], {
      blocked: (name) => access.blocked(name),
    });
    if (outcome.activated.length > 0 || outcome.alreadyActive.length > 0) return;
    const reason = outcome.skipped.find((skip) => skip.name === 'msg_write')?.reason ?? 'not_activated';
    this.#report(new Error(`The cross-session reply tool is unavailable: ${reason}.`));
  }

  /**
   * Admit messages immediately while native compaction holds SDK handoff.
   * The root owns the queued payloads until one handoff attempt each; callers
   * can finish without waiting for the summary model request.
   */
  async #acceptMainDelivery(message: DeliveryCustomMessage, triggerTurn: boolean): Promise<void> {
    if (!this.#mayPersist()) throw new SubagentError('runtime_closed', 'The original root no longer owns this delivery.');
    if (this.#compaction !== null || this.#mainDeliveryDrain !== null || this.#mainDeliveries.length > 0) {
      // Admission transfers ownership to this root. The caller need not wait
      // for compaction or replay a message whose SDK handoff is still pending.
      this.#mainDeliveries.push({ message, triggerTurn });
      this.#flushMainDeliveries();
      return;
    }
    await this.#handoffMain(message, triggerTurn);
  }

  async #handoffMain(message: DeliveryCustomMessage, triggerTurn: boolean): Promise<void> {
    if (!this.#mayPersist()) throw new SubagentError('runtime_closed', 'The original root no longer owns this delivery.');
    await this.#options.api.sendMessage(message, { triggerTurn: triggerTurn && this.active, deliverAs: 'steer' });
  }

  #flushMainDeliveries(): void {
    if (this.#compaction !== null || this.#mainDeliveryDrain !== null || this.#mainDeliveries.length === 0) return;
    const operation = Promise.resolve().then(() => this.#drainMainDeliveries());
    this.#mainDeliveryDrain = operation;
    void operation.then(() => {
      this.#mainDeliveryDrain = null;
      this.#flushMainDeliveries();
    });
  }

  async #drainMainDeliveries(): Promise<void> {
    while (this.#compaction === null && this.#mainDeliveries.length > 0) {
      const delivery = this.#mainDeliveries.shift()!;
      try {
        await this.#handoffMain(delivery.message, delivery.triggerTurn);
      } catch (error) {
        // A failed SDK handoff may already be queued. Report once; never replay.
        this.#report(errorOf(error));
      }
    }
  }

  beginCompaction(): void {
    if (!this.active || this.#compaction !== null) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.#compaction = { promise, resolve };
  }

  endCompaction(): void {
    const gate = this.#compaction;
    if (gate === null) return;
    this.#compaction = null;
    gate.resolve();
    this.#flushMainDeliveries();
  }

  syncSessionName(name: string | null): Promise<void> { return this.#peers.syncName(name); }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#phase = 'quiescing';
    // Release the compaction hold and retain accepted messages in the original
    // context before detaching; quiescence prevents them from waking Main.
    this.endCompaction();
    const jobs = this.runtime.jobs().jobs.filter((job) => ['running', 'stopping', 'finalizing'].includes(job.status));
    for (const job of jobs) if (job.status === 'running') this.runtime.cancelJob(job.jobId);
    this.#retirement = (async () => {
      const results: Array<PromiseSettledResult<unknown>> = [];
      // Shell first: cancellation may still report a terminal callback, and the
      // main endpoint has to stay bound until those leases actually exit. Then
      // the endpoint, then the published session record, then Job settlement.
      for (const operation of [() => this.shell.close(), () => this.listeners.close(), () => this.#peers.close()]) {
        results.push(...await Promise.allSettled([operation()]));
      }
      results.push(...await Promise.allSettled(jobs.map((job) => this.runtime.jobDone(job.jobId))));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      // A settling Job can enqueue an accepted Main delivery. Drain after all
      // producers retire, while this generation still owns the original context.
      this.#flushMainDeliveries();
      if (this.#mainDeliveryDrain !== null) await this.#mainDeliveryDrain;
      this.#phase = 'detached';
      if (this.#persistenceFailure !== null) throw this.#persistenceFailure;
      if (failures.length !== 0) throw new AggregateError(failures.map((result) => result.reason), 'The root did not retire all resources.');
    })();
    return this.#retirement;
  }

  #mayPersist(): boolean {
    return (this.#phase === 'open' || this.#phase === 'quiescing') && this.#failure === null && this.#options.ownsContext();
  }
  #append(kind: string, data: object): void {
    if (!this.#mayPersist()) {
      const error = new SubagentError('runtime_closed', 'The original root no longer owns metadata writes.');
      this.#report(error);
      throw error;
    }
    try { this.#store.append(kind, data); } catch (error) {
      this.#failure = errorOf(error);
      this.#persistenceFailure = this.#failure;
      this.#report(this.#failure);
      throw error;
    }
  }
  #event(event: RuntimeEvent): void {
    if (this.#phase === 'initializing') { this.#pendingEvents.push(event); return; }
    const { type, ...data } = event;
    this.#append(({ job: EVENTS.job, 'job-start': EVENTS.jobStart, 'job-end': EVENTS.jobEnd })[type], data);
  }

  async #finalize({ job, outcome }: FinalizeJobInput): Promise<void> {
    try {
      // An in-memory root has no durable view to write; its live projection is
      // the Job record, so finishing writes nothing outside the process.
      if (!this.#store.durable) return;
      const descriptor = this.actors.get(job.agentId);
      const record = this.runtime.jobRecord(job.jobId);
      if (record === null) throw new SubagentError('invalid_state', 'The finalizing Job has no history record.');
      writeJobView(this.#historyDir, { ...record, ...job, ...outcome,
        result: resultText(outcome.result), transcript: outcome.transcript ?? [],
        roleId: descriptor?.roleId ?? null, model: descriptor?.modelRef?.id ?? null });
    } finally { this.actors.seal(job.agentId, outcome.history?.endEntryId ?? null); }
    // Runtime emits the ONE terminal event, including historyState/Error,
    // after this hook settles. The view writer never publishes job-end.
  }

  #resultPath(jobId: string): string | null {
    if (!this.#store.durable) return null;
    const file = jobViewPaths(this.#historyDir, jobId).result;
    return existsSync(file) ? file : null;
  }

  #historyPaths(jobId: string): JobHistoryPaths | null {
    if (!this.#store.durable) return null;
    const paths = jobViewPaths(this.#historyDir, jobId);
    const result = this.#resultPath(jobId);
    return { summary: paths.summary, cleanJsonl: paths.transcript, ...(result === null ? {} : { result }) };
  }

  #view(jobId: string): JobHistoryPaths | null {
    if (!this.#store.durable) return null;
    const job = this.runtime.jobRecord(jobId);
    if (job === null) return null;
    if (!hasJobView(this.#historyDir, jobId)) {
      const entries = job.history !== null && job.history.startEntryId !== job.history.endEntryId
        ? this.actors.readInterval({ agentId: job.agentId, ...job.history }) ?? [] : [];
      const descriptor = this.actors.get(job.agentId);
      writeJobView(this.#historyDir, { ...job, result: resultText(job.result), transcript: readTranscript(entries), roleId: descriptor?.roleId ?? null, model: descriptor?.modelRef?.id ?? null });
    }
    const paths = jobViewPaths(this.#historyDir, jobId);
    return { summary: paths.summary, cleanJsonl: paths.transcript, result: paths.result };
  }

  /**
   * Root scope carrying Main's configured startup blacklist and live branch/preset
   * blacklist predicate. Preserves both Main's same-name namespace/container
   * denials and child-specific metadata pattern matches without sharing the
   * per-name cache across Main and child catalogs.
   */
  #rootScope(): CapabilityToolCatalog {
    const catalog = this.#rootScopeCache ??= {
      getAllTools: () => this.#options.api.getAllTools(),
    };
    setCapabilityStartupBlacklist(catalog, this.#options.config.capability.blacklist);
    const api = this.#options.api;
    const branch = this.#options.context.sessionManager.getBranch();
    const mainAccess = createToolAccessView(api, branch);
    const mainBlocked = new Set(
      api.getAllTools().filter((tool) => mainAccess.blocked(tool.name)).map((tool) => tool.name),
    );
    const childAccess = createToolAccessView(api, branch);
    setCapabilityParent(
      catalog,
      null,
      [],
      (name, tool) => mainBlocked.has(name)
        || (tool !== undefined ? childAccess.factsFor(tool).blocked : childAccess.blocked(name)),
    );
    return catalog;
  }

  #parentScope(agentId: string | null): CapabilityToolCatalog {
    if (agentId === null) return this.#rootScope();
    const live = this.runner.childScope(agentId);
    if (live !== null) return live;
    const scope = this.actors.toolScope(agentId);
    if (scope === null) throw new SubagentError('unknown_agent', `Missing parent capability scope for ${agentId}.`);
    const proxy = this.#retainedScopes.get(agentId) ?? { getAllTools: () => [] };
    this.#retainedScopes.set(agentId, proxy);
    const parentAgentId = this.runtime.parentAgentId(agentId);
    setCapabilityParent(proxy, () => this.#parentScope(parentAgentId), scope.excludedTools);
    return proxy;
  }

  #route(input: Parameters<NativeRoutingPort['route']>[0]): Promise<NativeRouteResult> {
    const loaded = loadPresets({ cwd: input.cwd, agentDir: this.#options.agentDir, projectTrusted: input.trusted });
    for (const warning of loaded.warnings) this.#options.context.ui?.notify(warning, 'warning');
    return routeSubagent({
      ...input,
      presets: loaded.presets,
      registry: this.#registry,
      configPath: path.join(this.#options.agentDir, 'subagent-routing.json'),
      retry: this.#options.config.subagent.routingRetry,
    });
  }
  #report(error: Error): void {
    try { this.#options.context.ui?.notify(error.message, 'error'); } catch { /* error remains on the owning operation */ }
  }
}

/**
 * Expand one CLI convenience selector to a full address in this session.
 * `children` names the root actor's direct children; an Actor key names that
 * Actor. Anything else is not a local selector, so the caller sees invalid_target.
 */
function localSignalAddress(session: string, selector: string): LogicalAddress | null {
  if (selector === 'children') return parseAddress(formatChildrenAddress(session, MAIN_ACTOR));
  return parseActorKey(selector) === null ? null : parseAddress(formatAddress(session, selector));
}
