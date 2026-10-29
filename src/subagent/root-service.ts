import path from 'node:path';
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createSubagentStore, EVENTS, SUBAGENT_SESSIONS_DIR } from '../subagent-storage.mjs';
import { hasJobView, jobViewPaths, writeJobView, readTranscript } from '../subagent-view.mjs';
import { routeSubagent } from '../subagent-routing.mjs';
import { DEFAULT_SOCKET_DIR, deriveSessionUid } from '../ipc/socket.ts';
import { ensurePrivateSocketRoot } from '../ipc/platform.ts';
import { setCapabilityParent, type CapabilityToolCatalog } from '../capability/scope.ts';
import { ActorSessionStore } from './actor-sessions.ts';
import { AgentListeners } from './listeners.ts';
import { NativeJobRunner } from './native-runner.ts';
import { NativeDeliveryRouter } from './native-delivery.ts';
import { createNativeSessionFactory } from './native-session.ts';
import { installSessionSurface, type SubagentSurfaceCreateOptions } from './surface.ts';
import type { ManagedWriteHost } from './message-write.ts';
import type { NativeCustomHandoff, NativeRouteResult, NativeRoutingPort } from './native-types.ts';
import {
  createSubagentRuntime, copyInheritedEntries, SubagentError,
  type RuntimeEvent, type SubagentRuntime, type DetailedAgentItem,
  type CreatedAgents, type JobHistoryPaths, type FinalizeJobInput,
  type InheritedContext,
} from './runtime.ts';

interface RootServiceOptions {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly agentDir: string;
  readonly allocatedIds: Set<string>;
  ownsContext(): boolean;
}

type RootPhase = 'initializing' | 'open' | 'quiescing' | 'detached' | 'failed';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const transcriptObjects = (values: readonly unknown[]): object[] => values.map((value) => {
  if (!record(value)) throw new SubagentError('history_write_failed', 'A native transcript message is not an object.');
  return value;
});
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

/** One root's domain, native resources and write ownership. */
export class RootService implements ManagedWriteHost {
  readonly #options: RootServiceOptions;
  readonly runtime: SubagentRuntime;
  readonly actors: ActorSessionStore;
  readonly runner: NativeJobRunner;
  readonly listeners: AgentListeners;
  readonly #delivery: NativeDeliveryRouter;
  readonly #store: ReturnType<typeof createSubagentStore>;
  readonly #historyDir: string;
  readonly #pendingEvents: RuntimeEvent[] = [];
  readonly #retainedScopes = new Map<string, CapabilityToolCatalog>();
  #registry: ModelRegistry;
  #phase: RootPhase = 'initializing';
  #failure: Error | null = null;
  #persistenceFailure: Error | null = null;
  #retirement: Promise<void> | null = null;

  constructor(options: RootServiceOptions) {
    this.#options = options;
    this.#registry = options.context.modelRegistry;
    const manager = options.context.sessionManager;
    const sessionId = manager.getSessionId();
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
        openForAppend: (agentId, file, anchor, actorCwd) => {
          const opened = this.#store.openForAppend(agentId, file, anchor, actorCwd);
          // This manager is created by our injected SessionManager.open above.
          if (!(opened.manager instanceof SessionManager)) throw new SubagentError('storage_corrupt', 'Storage returned a non-native session manager.');
          return { ...opened, manager: opened.manager };
        },
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
      socketDir, baseSocketDir: socketRoot,
      actors: () => this.runtime.list().agents,
      isAccepting: () => this.active,
      send: (command) => this.sendMessage(command),
      onError: (error) => this.#report(error),
    });
    const sessions = createNativeSessionFactory({
      agentDir: options.agentDir,
      modelRegistry: () => this.#registry,
      parentCapabilityScope: (id) => this.#parentScope(id),
      installChildSurface: (api, scope) => installSessionSurface(api, async () => {
        this.assertOperational();
        return this;
      }, { callerId: scope.senderId, depth: scope.depth, allowInherited: scope.allowInherited, cwd: scope.cwd }),
    });
    const owner = this;
    this.runner = new NativeJobRunner({
      root: {
        get storageError() { return owner.#failure; },
        get canStartJob() { return owner.active; },
        get mayPersist() { return owner.#mayPersist(); },
      },
      config: { socketDir }, actors: this.actors, sessions,
      models: { inherited: (model) => capturedModel(model, this.#registry) },
      routing: { route: (input) => this.#route(input) },
      tools: { catalog: () => options.api.getAllTools() },
      listeners: { sync: () => this.listeners.sync() },
      notify: (message) => this.#report(new Error(message)),
    });
    this.runtime = createSubagentRuntime({
      socketDir,
      isIdTaken: (id) => options.allocatedIds.has(id),
      onIdAllocated: (id) => options.allocatedIds.add(id),
      startJob: (request) => this.runner.start(request),
      finalizeJob: (input) => this.#finalize(input),
      // Pure path projection only. Reading/rebuilding belongs to list(), not
      // domain transitions or notification publication.
      historyPaths: (jobId) => this.#historyPaths(jobId),
      deliverMessage: (input) => this.#delivery.toAgent(input),
      deliverToMain: (message) => this.#delivery.toMain(message),
      onEvent: (event) => this.#event(event),
      prepareInherited: ({ agentId, snapshot }) => {
        if (!this.#store.durable) return { ...snapshot, entries: copyInheritedEntries(snapshot.entries) };
        if (!Array.isArray(snapshot.entries)) throw new SubagentError('invalid_state', 'The captured seed has no native entries.');
        const { entries, ...metadata } = snapshot;
        const seed = this.#store.writeSeed(agentId, entries, typeof snapshot.cwd === 'string' ? snapshot.cwd : cwd);
        return { ...metadata, seedFile: seed.file, seedLeafId: seed.seedLeafId };
      },
    });
    this.#delivery = new NativeDeliveryRouter({
      runtime: this.runtime, runner: this.runner,
      ownsContext: () => this.#mayPersist(),
      canWake: () => this.active,
      sendToMain: (message, triggerTurn) => options.api.sendMessage(message, { triggerTurn, deliverAs: 'steer' }),
      appendRetained: (agentId, message) => this.#appendNotice(agentId, message),
      onError: (error) => this.#report(error),
    });
    // Validate the private root inside initialize(), so failure is latched and
    // tools report it rather than repeatedly rebuilding an insecure service.
    this.#socketRoot = socketRoot;
  }

  readonly #socketRoot: string;
  get active(): boolean { return this.#phase === 'open' && this.#failure === null && this.#options.ownsContext(); }
  get closed(): boolean { return this.#phase === 'detached'; }

  assertOperational(): void {
    if (this.#failure !== null) throw this.#failure;
    if (!this.active) throw new SubagentError('runtime_closed', 'The root is not accepting new operations.');
  }

  async initialize(): Promise<void> {
    try {
      if (process.platform !== 'win32') ensurePrivateSocketRoot(this.#socketRoot);
      const state: unknown = this.#store.load();
      if (!record(state) || !Array.isArray(state.actors) || !Array.isArray(state.jobs)) throw new SubagentError('storage_corrupt', 'The registry has no Actor or Job lists.');
      for (const id of this.#store.takenIds()) this.#options.allocatedIds.add(id);
      const jobs = state.jobs.map((value: unknown) => {
        if (!record(value)) throw new SubagentError('storage_corrupt', 'A stored Job is not an object.');
        return value;
      });
      for (const actor of state.actors) {
        if (!record(actor) || typeof actor.agentId !== 'string') throw new SubagentError('storage_corrupt', 'A stored Actor has no ID.');
        if (actor.record == null) continue;
        const first = jobs.find((job) => job.agentId === actor.agentId && job.continuedFromJobId === null);
        const seed = first && record(first.spec) && record(first.spec.inheritedContext) ? first.spec.inheritedContext : null;
        this.actors.restoreIdentity({ agentId: actor.agentId, record: actor.record, anchor: actor.anchor, seed });
      }
      const restoredJobs = jobs.map((job) => {
        if (job.end != null) return job;
        if (typeof job.agentId !== 'string') throw new SubagentError('storage_corrupt', 'A Job has no Actor ID.');
        const seed = record(job.spec) && record(job.spec.inheritedContext) ? job.spec.inheritedContext : null;
        const start = job.started === true ? job.startEntryId : seed?.seedLeafId ?? null;
        if (start !== null && typeof start !== 'string') throw new SubagentError('storage_corrupt', 'A Job has malformed native start bounds.');
        const end = this.actors.recoveryBoundEnd({ agentId: job.agentId, startEntryId: start }) ?? start;
        this.actors.seal(job.agentId, end);
        return { ...job, history: { startEntryId: start, endEntryId: end } };
      });
      this.runtime.restoreState({ ...state, jobs: restoredJobs });
      const initial = jobs.filter((job) => job.continuedFromJobId === null).map((job) => {
        if (typeof job.agentId !== 'string') throw new SubagentError('storage_corrupt', 'A Job has no Actor ID.');
        const start = job.startEntryId ?? null;
        if (start !== null && typeof start !== 'string') throw new SubagentError('storage_corrupt', 'A Job has malformed native start bounds.');
        return { agentId: job.agentId, startEntryId: start };
      });
      this.actors.restateAssignments(initial);
      this.#phase = 'open';
      for (const event of this.#pendingEvents.splice(0)) this.#event(event);
      await this.listeners.sync();
    } catch (error) {
      this.#failure = errorOf(error);
      this.#phase = 'failed';
      this.#report(this.#failure);
    }
  }

  async create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedAgents> {
    this.assertOperational();
    this.#registry = ctx.modelRegistry;
    const result = this.runtime.create(batch, options);
    if (this.#persistenceFailure !== null) throw this.#persistenceFailure;
    try { await this.listeners.sync(); } catch (error) {
      // Registration already committed. Do not misreport it as an uncreated
      // batch and encourage the caller to create duplicate Actors.
      this.#report(errorOf(error));
      return { ...result, warnings: [...(result.warnings ?? []), `IPC listener setup failed: ${errorOf(error).message}`] };
    }
    return result;
  }

  async list(filter: unknown, callerId: string): Promise<{ items: DetailedAgentItem[] }> {
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
    for (const item of result.items) {
      if (item.id === 'Main') { item.status = this.#options.context.isIdle() ? 'idle' : 'running'; continue; }
      const jobId = latest.get(item.id);
      if (jobId === undefined) continue;
      try { const history = this.#view(jobId); if (history !== null) item.history = { jobId, ...history }; }
      catch (error) { item.historyError = { code: 'history_read_failed', message: errorOf(error).message }; }
    }
    return result;
  }

  stop(target: unknown) { this.assertOperational(); return this.runtime.stop(target); }
  resolveEndpoint(address: string) { this.assertOperational(); return this.listeners.resolve(address); }
  isReservedPath(address: string) { return this.listeners.isReservedPath(address); }
  sendMessage(command: Parameters<SubagentRuntime['sendMessage']>[0]) {
    this.assertOperational();
    return this.runtime.sendMessage(command);
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#phase = 'quiescing';
    const jobs = this.runtime.jobs().jobs.filter((job) => ['running', 'stopping', 'finalizing'].includes(job.status));
    for (const job of jobs) if (job.status === 'running') this.runtime.cancelJob(job.jobId);
    this.#retirement = (async () => {
      const results = await Promise.allSettled([this.listeners.close(), ...jobs.map((job) => this.runtime.jobDone(job.jobId))]);
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
      if (!this.#store.durable) return;
      const descriptor = this.actors.get(job.agentId);
      const record = this.runtime.jobRecord(job.jobId);
      if (record === null) throw new SubagentError('invalid_state', 'The finalizing Job has no history record.');
      writeJobView(this.#historyDir, { ...record, ...job, ...outcome,
        result: resultText(outcome.result), transcript: transcriptObjects(outcome.transcript ?? []),
        roleId: descriptor?.roleId ?? null, model: descriptor?.modelRef?.id ?? null });
    } finally { this.actors.seal(job.agentId, outcome.history?.endEntryId ?? null); }
    // Runtime emits the ONE terminal event, including historyState/Error,
    // after this hook settles. The view writer never publishes job-end.
  }

  #historyPaths(jobId: string): JobHistoryPaths | null {
    if (!this.#store.durable) return null;
    const paths = jobViewPaths(this.#historyDir, jobId);
    return { summary: paths.summary, cleanJsonl: paths.transcript };
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
    return { summary: paths.summary, cleanJsonl: paths.transcript };
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

  async #route(input: Parameters<NativeRoutingPort['route']>[0]): Promise<NativeRouteResult> {
    const value: unknown = await routeSubagent({ ...input, registry: this.#registry, configPath: path.join(this.#options.agentDir, 'subagent-routing.json') });
    if (!record(value) || typeof value.roleId !== 'string' || typeof value.instructions !== 'string' || typeof value.thinkingLevel !== 'string' ||
        !Array.isArray(value.excludeTools) || !value.excludeTools.every((name: unknown): name is string => typeof name === 'string') ||
        !Array.isArray(value.enableTools) || !value.enableTools.every((name: unknown): name is string => typeof name === 'string')) throw new SubagentError('routing_unavailable', 'Routing returned a malformed identity.');
    const model = capturedModel(value.model, this.#registry);
    if (model === null) throw new SubagentError('model_unavailable', 'Routing returned no usable model.');
    return { roleId: value.roleId, instructions: value.instructions, model, thinkingLevel: value.thinkingLevel, excludeTools: value.excludeTools, enableTools: value.enableTools };
  }
  #report(error: Error): void {
    try { this.#options.context.ui?.notify(error.message, 'error'); } catch { /* error remains on the owning operation */ }
  }
}
