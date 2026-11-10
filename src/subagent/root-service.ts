import path from 'node:path';
import { AsyncShellHost } from '../async-shell/host.ts';
import { installAsyncShellSurface } from '../async-shell/surface.ts';
import { installInheritedShellChecks } from '../shell-approval/bridge.ts';
import { cancelTask } from '../async-shell/tmux.ts';
import type { ShellResult } from '../async-shell/protocol.ts';
import { existsSync } from 'node:fs';
import { temporaryResultDirectory } from './temporary-results.ts';
import { resultNeedsFile } from './result.ts';
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../harness-config.ts';
import { createSubagentStore, EVENTS, SUBAGENT_SESSIONS_DIR, writeFileAtomic } from './storage.ts';
import { hasJobView, jobViewPaths, writeJobView, readTranscript } from './view.ts';
import { routeSubagent } from './routing.ts';
import { DEFAULT_SOCKET_DIR, deriveSessionUid, getAgentSocketPath } from '../ipc/socket.ts';
import type { LiveSession } from './session-directory.ts';
import { SessionPeers, type SessionConnect } from './session-peers.ts';
import { ensurePrivateSocketRoot } from '../ipc/platform.ts';
import { activateToolNames } from '../capability/activation.ts';
import { createToolPermissionResolver, explicitlyDisabled } from '../capability/tool-permission.ts';
import { setCapabilityParent, type CapabilityToolCatalog } from '../capability/scope.ts';
import { ActorSessionStore } from './actor-sessions.ts';
import { AgentListeners } from './listeners.ts';
import { NativeJobRunner } from './native-runner.ts';
import { NativeDeliveryRouter } from './native-delivery.ts';
import type { DeliveryCustomMessage } from './delivery.ts';
import { createNativeSessionFactory } from './native-session.ts';
import { installSessionSurface, type SubagentSurfaceCreateOptions } from './surface.ts';
import type { ManagedWriteHost, SessionEndpoint } from './message-write.ts';
import type { NativeCustomHandoff, NativeLiveSnapshot, NativeRouteResult, NativeRoutingPort, NativeSessionEvent, NativeStartedJob } from './native-types.ts';
import {
  createSubagentRuntime, copyInheritedEntries, SubagentError,
  type RuntimeEvent, type SubagentRuntime, type DetailedAgentItem,
  type CreatedAgents, type JobHistoryPaths, type FinalizeJobInput,
  type InheritedContext, type JobRequest,
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
  readonly listeners: AgentListeners;
  readonly shell: AsyncShellHost;
  readonly #delivery: NativeDeliveryRouter;
  readonly #peers: SessionPeers;
  readonly #store: ReturnType<typeof createSubagentStore<SessionManager>>;
  readonly #historyDir: string;
  #temporaryResults: string | null = null;
  readonly #pendingEvents: RuntimeEvent[] = [];
  #creation: { gate: Promise<void>; ready: Promise<void>[] } | null = null;
  readonly #retainedScopes = new Map<string, { proxy: CapabilityToolCatalog; excluded: readonly string[] }>();
  /**
   * The root catalog as a child's parent chain sees it, with explicitly
   * managed tools (disabled or root-only enabled) removed. Stable per root because the capability scope keys on
   * the catalog object; `getAllTools` reads the current root branch so a rule
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
    this.shell = new AsyncShellHost({
      address: (actorId) => getAgentSocketPath(actorId, socketDir),
      accepting: () => this.active,
      wake: (actorId) => this.runner.wake(actorId),
      deliver: (actorId, result) => this.#shellResult(actorId, result),
      cancel: cancelTask,
    });
    this.listeners = new AgentListeners({
      socketDir, baseSocketDir: socketRoot, sessionId: this.sessionId,
      maxDepth: this.#options.config.subagent.maxDepth,
      actors: () => this.runtime.list().agents,
      isAccepting: () => this.active,
      send: (command) => this.sendMessage(command),
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
          this.assertOperational();
          return this;
        }, {
          callerId: scope.senderId,
          depth: scope.depth,
          allowInherited: scope.allowInherited,
          cwd: scope.cwd,
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
      config: { socketDir, harness: this.#options.config }, actors: this.actors, sessions,
      models: { inherited: (model) => capturedModel(model, this.#registry) },
      routing: { route: (input) => this.#route(input) },
      tools: { catalog: () => options.api.getAllTools() },
      work: { hasPending: (agentId) => this.runtime.hasActiveChildren(agentId) || this.shell.hasPending(agentId) },
      notify: (message) => this.#report(new Error(message)),
    });
    this.runtime = createSubagentRuntime({
      socketDir,
      config: this.#options.config,
      isIdTaken: (id) => options.allocatedIds.has(id),
      onIdAllocated: (id) => options.allocatedIds.add(id),
      startJob: (request) => {
        const creation = this.#creation;
        const handle = creation === null ? this.runner.start(request) : this.#startAfterListeners(request, creation.gate);
        creation?.ready.push(handle.ready);
        return handle;
      },
      finalizeJob: (input) => this.#finalize(input),
      // Pure path projection only. Reading/rebuilding belongs to list(), not
      // domain transitions or notification publication.
      historyPaths: (jobId) => this.#historyPaths(jobId),
      resultPath: (jobId) => this.#resultPath(jobId),
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
      appendRetained: (agentId, message) => this.#appendNotice(agentId, message),
      onError: (error) => this.#report(error),
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
  /** Compaction holds SDK handoff; admitted messages remain owned by this root. */
  #compaction: { readonly promise: Promise<void>; readonly resolve: () => void } | null = null;
  readonly #mainDeliveries: Array<{ message: DeliveryCustomMessage; triggerTurn: boolean }> = [];
  #mainDeliveryDrain: Promise<void> | null = null;
  /** The resolved nesting limit of this root's snapshot. */
  get maxDepth(): number { return this.#options.config.subagent.maxDepth; }
  get active(): boolean { return this.#phase === 'open' && this.#failure === null && this.#options.ownsContext(); }
  get closed(): boolean { return this.#phase === 'detached'; }

  assertOperational(): void {
    if (this.#failure !== null) throw this.#failure;
    if (!this.active) throw new SubagentError('runtime_closed', 'The root is not accepting new operations.');
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
        const start = job.started === true ? job.startEntryId : seed?.seedLeafId ?? null;
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
      this.#failure = errorOf(error);
      this.#phase = 'failed';
      this.#report(this.#failure);
    }
  }

  async create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedAgents> {
    this.assertOperational();
    this.#registry = ctx.modelRegistry;
    let open!: () => void;
    let fail!: (error: unknown) => void;
    const creation = { gate: new Promise<void>((resolve, reject) => { open = resolve; fail = reject; }), ready: [] as Promise<void>[] };
    let result: CreatedAgents;
    this.#creation = creation;
    try {
      result = this.runtime.create(batch, options);
    } finally {
      this.#creation = null;
    }
    try {
      if (this.#persistenceFailure !== null) throw this.#persistenceFailure;
      await this.listeners.sync();
      open();
    } catch (error) {
      fail(error);
    }
    const started = await Promise.allSettled(creation.ready);
    const failures = started.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [`${result.items[index]!.id}: ${errorOf(outcome.reason).message}`] : []);
    if (failures.length) throw new SubagentError('start_failed',
      `Subagent startup failed: ${failures.join('; ')}. Registered agents: ${result.items.map((item) => item.id).join(', ')}; do not recreate this batch.`);
    return { ...result, items: result.items.map(item => {
      const actor = this.actors.get(item.id);
      return { ...item, role: actor?.roleId ?? null, model: actor?.modelRef?.id ?? null };
    }) };
  }

  #startAfterListeners(request: JobRequest, gate: Promise<void>): NativeStartedJob {
    let handle: NativeStartedJob | null = null;
    let cancelled = false;
    const start = gate.then(() => {
      if (cancelled) throw new SubagentError('cancelled', 'Subagent startup was cancelled.');
      handle = this.runner.start(request);
      return handle;
    });
    const ready = start.then(started => started.ready);
    void ready.catch(() => {});
    return { ready, done: start.then(started => started.done), cancel() { cancelled = true; handle?.cancel(); } };
  }

  async list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null> {
    this.assertOperational();
    if (!record(filter)) throw new SubagentError('invalid_request', 'List parameters must be an object.');
    if (filter.id !== undefined && typeof filter.id !== 'string') throw new SubagentError('invalid_request', 'List id must be a string.');
    if (filter.all !== undefined && typeof filter.all !== 'boolean') throw new SubagentError('invalid_request', 'List all must be a boolean.');
    const result = this.runtime.listDetailed({
      ...(typeof filter.id === 'string' ? { id: filter.id } : {}),
      ...(typeof filter.all === 'boolean' ? { all: filter.all } : {}),
    }, { callerId });
    const latest = new Map<string, string>();
    for (const job of this.runtime.jobs().jobs) {
      if (['completed', 'failed', 'cancelled'].includes(job.status)) latest.set(job.agentId, job.jobId);
    }
    const enrich = (item: DetailedAgentItem): void => {
      if (item.id === 'Main') item.status = this.#options.context.isIdle() ? 'idle' : 'running';
      else {
        const jobId = latest.get(item.id);
        if (jobId !== undefined) {
          try { const history = this.#view(jobId); if (history !== null) item.history = { jobId, ...history }; }
          catch (error) { item.historyError = { code: 'history_read_failed', message: errorOf(error).message }; }
        }
      }
      item.children.forEach(enrich);
    };
    if (result) {
      enrich(result);
      if (this.#store.durable) result.historyDir = this.#historyDir;
    }
    return result;
  }

  stop(target: unknown) { this.assertOperational(); return this.runtime.stop(target); }
  resolveEndpoint(address: string) { this.assertOperational(); return this.listeners.resolve(address); }
  sendMessage(command: Parameters<SubagentRuntime['sendMessage']>[0]) {
    this.assertOperational();
    return this.runtime.sendMessage(command);
  }

  /** Observe one live Job's full native event stream (null when it has no live run). */
  subscribeJobEvents(jobId: string, listener: (event: NativeSessionEvent) => void): (() => void) | null {
    this.assertOperational();
    return this.runner.subscribeJobEvents(jobId, listener);
  }

  /** Read one live Job's current end boundary (undefined when it has no live run). */
  liveEndEntryId(jobId: string): string | null | undefined {
    this.assertOperational();
    return this.runner.liveEndEntryId(jobId);
  }

  /** Read one live Job's stream projection (null when it has no live run). */
  liveSnapshot(jobId: string): NativeLiveSnapshot | null {
    this.assertOperational();
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
    if (actorId === 'Main') {
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
  sessionEndpoint(address: string): Promise<SessionEndpoint> { return this.#peers.endpoint(address); }
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
    const outcome = activateToolNames(api, ['msg_write'], {
      disabled: (name) => explicitlyDisabled(api, branch, name),
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
  sendCrossSession(command: Parameters<SessionPeers['send']>[0]): Promise<void> { return this.#peers.send(command); }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#phase = 'quiescing';
    // Release the compaction hold and retain accepted messages in the original
    // context before detaching; quiescence prevents them from waking Main.
    this.endCompaction();
    const jobs = this.runtime.jobs().jobs.filter((job) => ['running', 'stopping', 'finalizing'].includes(job.status));
    for (const job of jobs) if (job.status === 'running') this.runtime.cancelJob(job.jobId);
    this.#retirement = (async () => {
      const results = await Promise.allSettled([
        this.shell.close(),
        this.listeners.close(),
        this.#peers.close(),
        ...jobs.map((job) => this.runtime.jobDone(job.jobId)),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      // Job completion can enqueue its final notice. Drain after all producers
      // retire, while this generation still owns the original SDK context.
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
      if (!this.#store.durable) {
        const text = resultText(outcome.result);
        if (text !== null && resultNeedsFile(text)) {
          this.#temporaryResults ??= temporaryResultDirectory();
          writeFileAtomic(path.join(this.#temporaryResults, `${job.jobId}.txt`), text);
        }
        return;
      }
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
    const file = this.#store.durable ? jobViewPaths(this.#historyDir, jobId).result
      : this.#temporaryResults === null ? null : path.join(this.#temporaryResults, `${jobId}.txt`);
    return file !== null && existsSync(file) ? file : null;
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

  async #appendNotice(agentId: string, message: NativeCustomHandoff): Promise<boolean> {
    if (!this.#mayPersist()) return false;
    const retained = this.actors.get(agentId);
    if (retained === null) return false;
    const manager = this.actors.open({ agentId, retained, seed: null, cwd: retained.cwd });
    this.actors.restoreLeaf({ manager, agentId, retained, seed: null });
    const anchor = manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    this.actors.checkpointAppendedAnchor({ agentId, manager, anchor });
    return true;
  }

  /**
   * The root catalog a child's ancestor chain starts from.
   *
   * Current prohibitions are re-applied as denials on every resolution, so a
   * direct root child, a live parent and a retained proxy all see a rule added
   * after the first child. The learned set is append-only, so filtering
   * `getAllTools` alone cannot revoke an earlier grant; a denial is applied
   * whenever a view is built. Explicit enable is root-only and is not
   * propagated.
   */
  #rootScope(): CapabilityToolCatalog {
    const catalog = this.#rootScopeCache ??= {
      getAllTools: () => this.#options.api.getAllTools(),
    };
    setCapabilityParent(catalog, null, this.#childDeniedNames());
    return catalog;
  }

  /**
   * Tools a child must not inherit right now: explicitly disabled names and
   * explicitly enabled names, because an enable is root-only.
   */
  #childDeniedNames(): string[] {
    const api = this.#options.api;
    const branch = this.#options.context.sessionManager.getBranch();
    const tools = api.getAllTools();
    const permissions = createToolPermissionResolver(api, tools, branch);
    return tools
      .filter((tool) => permissions.disabled(tool.name) || permissions.enabled(tool.name))
      .map((tool) => tool.name);
  }

  #parentScope(agentId: string | null): CapabilityToolCatalog {
    if (agentId === null) return this.#rootScope();
    const live = this.runner.childScope(agentId);
    if (live !== null) return live;
    // Prohibitions are expressed as scope denials, not only by filtering the
    // stable catalog: a denial is applied when a view is built, so a new child
    // of a retained parent learns the current rule even though the parent
    // catalog object itself never changes.
    const disabled = this.#childDeniedNames();
    const retained = this.#retainedScopes.get(agentId);
    if (retained !== undefined) {
      setCapabilityParent(retained.proxy, this.#rootScope(), [...retained.excluded, ...disabled]);
      return retained.proxy;
    }
    const scope = this.actors.toolScope(agentId);
    if (scope === null) throw new SubagentError('unknown_agent', `Missing parent capability scope for ${agentId}.`);
    const proxy: CapabilityToolCatalog = { getAllTools: () => {
      const current = new Set(this.actors.toolScope(agentId)?.tools ?? []);
      return this.#options.api.getAllTools().filter((tool) => current.has(tool.name));
    } };
    setCapabilityParent(proxy, this.#rootScope(), [...scope.excludedTools, ...disabled]);
    this.#retainedScopes.set(agentId, { proxy, excluded: scope.excludedTools });
    return proxy;
  }

  #route(input: Parameters<NativeRoutingPort['route']>[0]): Promise<NativeRouteResult> {
    return routeSubagent({
      ...input,
      registry: this.#registry,
      configPath: path.join(this.#options.agentDir, 'subagent-routing.json'),
      retry: this.#options.config.subagent.routingRetry,
    });
  }
  #report(error: Error): void {
    try { this.#options.context.ui?.notify(error.message, 'error'); } catch { /* error remains on the owning operation */ }
  }
}
