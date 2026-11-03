import path from 'node:path';
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
import { DEFAULT_SOCKET_DIR, deriveSessionUid, endpointKey, getAgentSocketPath } from '../ipc/socket.ts';
import {
  assertCrossSessionSupported, crossSessionSupported, liveSessions, registerSession,
  sendToSessionEndpoint, unregisterSession, updateSessionName,
  type LiveSession,
} from './session-directory.ts';
import { ensurePrivateSocketRoot } from '../ipc/platform.ts';
import { activateToolNames } from '../capability/activation.ts';
import { setCapabilityParent, type CapabilityToolCatalog } from '../capability/scope.ts';
import { ActorSessionStore } from './actor-sessions.ts';
import { AgentListeners } from './listeners.ts';
import { NativeJobRunner } from './native-runner.ts';
import { NativeDeliveryRouter } from './native-delivery.ts';
import { createNativeSessionFactory } from './native-session.ts';
import { installSessionSurface, type SubagentSurfaceCreateOptions } from './surface.ts';
import type { ManagedWriteHost, SessionEndpoint } from './message-write.ts';
import type { NativeCustomHandoff, NativeRouteResult, NativeRoutingPort, NativeStartedJob } from './native-types.ts';
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
  readonly #delivery: NativeDeliveryRouter;
  readonly #store: ReturnType<typeof createSubagentStore<SessionManager>>;
  readonly #historyDir: string;
  #temporaryResults: string | null = null;
  readonly #pendingEvents: RuntimeEvent[] = [];
  #creation: { gate: Promise<void>; ready: Promise<void>[] } | null = null;
  readonly #retainedScopes = new Map<string, CapabilityToolCatalog>();
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
    this.listeners = new AgentListeners({
      socketDir, baseSocketDir: socketRoot, sessionId: this.sessionId,
      maxDepth: this.#options.config.subagent.maxDepth,
      actors: () => this.runtime.list().agents,
      isAccepting: () => this.active,
      send: (command) => this.sendMessage(command),
      onError: (error) => this.#report(error),
    });
    const sessions = createNativeSessionFactory({
      agentDir: options.agentDir,
      config: this.#options.config,
      modelRegistry: () => this.#registry,
      parentCapabilityScope: (id) => this.#parentScope(id),
      installChildSurface: (api, scope) => installSessionSurface(api, async () => {
        this.assertOperational();
        return this;
      }, {
        callerId: scope.senderId,
        depth: scope.depth,
        allowInherited: scope.allowInherited,
        cwd: scope.cwd,
        maxDepth: scope.maxDepth,
        capacityFor: () => this.#options.config.subagent,
      }),
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
      children: { hasActiveChildren: (agentId) => this.runtime.hasActiveChildren(agentId) },
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
      sendToMain: async (message, triggerTurn) => {
        const gate = this.#compaction;
        if (gate !== null) await gate.promise;
        // Quiescing still owns the old root: a terminal notice may be retained
        // after retirement starts. Only a detached root refuses the handover.
        if (!this.#mayPersist()) {
          throw new SubagentError('runtime_closed', 'The original root no longer owns this delivery.');
        }
        // Waking is a current-state decision, not a snapshot taken before the gate.
        await options.api.sendMessage(message, { triggerTurn: triggerTurn && this.active, deliverAs: 'steer' });
      },
      appendRetained: (agentId, message) => this.#appendNotice(agentId, message),
      onError: (error) => this.#report(error),
    });
    // Validate the private root inside initialize(), so failure is latched and
    // tools report it rather than repeatedly rebuilding an insecure service.
    this.#socketRoot = socketRoot;
  }

  readonly #socketRoot: string;
  /** Native compaction rewrites the context; deliveries wait for it to finish. */
  #compaction: { readonly promise: Promise<void>; readonly resolve: () => void } | null = null;
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
      await this.#publishSession();
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

  /** The socket root every live session of this user publishes itself under. */
  get socketRoot(): string { return this.#socketRoot; }

  /** Live sessions reachable from here, including this one. Empty where unsupported. */
  listSessions(): Promise<LiveSession[]> {
    return crossSessionSupported() ? liveSessions(this.#socketRoot) : Promise.resolve([]);
  }

  /**
   * Classify a managed address against this root and the shared directory.
   *
   * This is the one place that decides whether a path is local, this session's
   * own Main, another live session's Main, or another session's non-Main
   * endpoint. It uses the same address space as every other `msg_write` call.
   */
  async sessionEndpoint(address: string): Promise<SessionEndpoint> {
    const ownSocketDir = path.join(this.#socketRoot, deriveSessionUid(this.sessionId));
    if (endpointKey(address) === endpointKey(getAgentSocketPath('Main', ownSocketDir))) {
      return { kind: 'self' };
    }
    const live = await liveSessions(this.#socketRoot);
    for (const session of live) {
      if (session.sessionId === this.sessionId) continue;
      if (endpointKey(address) === endpointKey(getAgentSocketPath('Main', session.socketDir))) {
        return { kind: 'session', session };
      }
    }
    const prefix = `${path.sep}`;
    for (const session of live) {
      if (session.sessionId === this.sessionId) continue;
      if (address.startsWith(session.socketDir + prefix)) return { kind: 'foreign' };
    }
    return { kind: 'local' };
  }

  /**
   * A peer session addressed this Main; make the reply tool callable before the
   * triggered turn starts. This is receipt-scoped activation, not a grant: it
   * writes no capability record and does not load the rest of the namespace.
   */
  #activateReplyTool(): void {
    const outcome = activateToolNames(this.#options.api, ['msg_write']);
    if (outcome.activated.length > 0 || outcome.alreadyActive.length > 0) return;
    const reason = outcome.skipped.find((skip) => skip.name === 'msg_write')?.reason ?? 'not_activated';
    this.#report(new Error(`The cross-session reply tool is unavailable: ${reason}.`));
  }

  /**
   * Hold deliveries while native compaction rewrites the context.
   *
   * A steer handed to the SDK mid-compaction can land inside the rewritten
   * boundary or interleave with the retried turn. The extension opens this gate
   * on `session_before_compact` and closes it on `session_compact` or
   * `session_compact_failed`; every Main delivery waits here.
   */
  beginCompaction(): void {
    if (this.#compaction !== null) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.#compaction = { promise, resolve };
  }

  endCompaction(): void {
    const gate = this.#compaction;
    if (gate === null) return;
    this.#compaction = null;
    gate.resolve();
  }

  /**
   * Mirror a native session rename into the shared directory.
   *
   * The SDK reports the new name; this session owns its record, so it rewrites
   * only the name and keeps the rest of the published identity. Reachability is
   * auxiliary: a failed update is reported, never fatal.
   */
  async syncSessionName(name: string | null): Promise<void> {
    if (!crossSessionSupported()) return;
    try {
      await updateSessionName(this.#socketRoot, { sessionId: this.sessionId, name });
    } catch (error) {
      this.#report(new Error(`This session's published name was not updated: ${errorOf(error).message}`));
    }
  }

  /**
   * Deliver one message to another live session's Main.
   *
   * The receiving root owns admission: this call only frames the sender and
   * writes one NDJSON request to the target's managed Main endpoint. An error
   * response, a timeout or a disconnect does not prove the message was not
   * handed over, so nothing is retried here.
   */
  async sendCrossSession(command: {
    readonly target: LiveSession;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    this.assertOperational();
    assertCrossSessionSupported();
    return sendToSessionEndpoint({
      sender: { sessionId: this.sessionId, uid: deriveSessionUid(this.sessionId) },
      ...command,
    });
  }

  /**
   * Publish this session for cross-session addressing. Reachability is
   * auxiliary: a failed publish is reported, and this root keeps running.
   */
  async #publishSession(): Promise<void> {
    // Windows is explicitly out of scope; no record is published there.
    if (!crossSessionSupported()) return;
    try {
      await registerSession(this.#socketRoot, {
        sessionId: this.sessionId,
        cwd: this.#options.context.cwd,
        name: this.#options.context.sessionManager.getSessionName() ?? null,
      });
    } catch (error) {
      this.#report(new Error(`This session is not reachable from other sessions: ${errorOf(error).message}`));
    }
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#phase = 'quiescing';
    // Release deliveries waiting on a compaction that will never finish here;
    // they fail the active check instead of hanging past retirement.
    this.endCompaction();
    const jobs = this.runtime.jobs().jobs.filter((job) => ['running', 'stopping', 'finalizing'].includes(job.status));
    for (const job of jobs) if (job.status === 'running') this.runtime.cancelJob(job.jobId);
    this.#retirement = (async () => {
      const results = await Promise.allSettled([
        this.listeners.close(),
        unregisterSession(this.#socketRoot, this.sessionId),
        ...jobs.map((job) => this.runtime.jobDone(job.jobId)),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
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

  #parentScope(agentId: string | null): CapabilityToolCatalog {
    if (agentId === null) return this.#options.api;
    const live = this.runner.childScope(agentId);
    if (live !== null) return live;
    let proxy = this.#retainedScopes.get(agentId);
    if (proxy !== undefined) return proxy;
    const scope = this.actors.toolScope(agentId);
    if (scope === null) throw new SubagentError('unknown_agent', `Missing parent capability scope for ${agentId}.`);
    proxy = { getAllTools: () => {
      const current = new Set(this.actors.toolScope(agentId)?.tools ?? []);
      return this.#options.api.getAllTools().filter((tool) => current.has(tool.name));
    } };
    setCapabilityParent(proxy, this.#options.api, scope.excludedTools);
    this.#retainedScopes.set(agentId, proxy);
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
