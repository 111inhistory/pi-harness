/**
 * Narrow ports and value shapes of the native Job runner.
 *
 * The runner owns exactly the physical side of one Job: the SDK Session, its
 * AbortController, the in-flight steers and the input buffer between turns.
 * The Subagent runtime alone owns the logical Job: status, stopping,
 * interruption and revival. Nothing here decides a Job's status, chooses a
 * revival or writes a terminal delivery.
 *
 * Every dependency of the runner is an explicit port with one owner; the root
 * service never passes its mutable service object. In particular the retained
 * actor descriptor is read and written only through {@link NativeActorStore},
 * so the runner cannot mutate the root's actor map behind its back.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { CapabilityToolCatalog } from "../capability/scope.ts";
import type { HarnessConfig } from "../harness-config.ts";
import type { InheritedContext, JobBudgetPort, StartedJobHandle } from "./runtime.ts";
import type { QueueCapable, TerminalStatus } from "./lifecycle.ts";

/** Provider/model pair a Job records for a later revival. */
export interface NativeModelRef {
  readonly provider: string;
  readonly id: string;
}

/**
 * The retained identity and native conversation of one actor.
 *
 * `sessionManager` is the live native manager while the actor's session is
 * open; `anchor` is the leaf a checkpoint may record and is deliberately a
 * separate field from the live manager's leaf, because an unflushed entry must
 * never become a durable anchor.
 */
export interface NativeRetainedActor {
  readonly sessionManager: SessionManager | null;
  readonly sessionFile: string | null;
  readonly anchor: string | null;
  readonly cwd: string;
  readonly trusted: boolean;
  readonly allowInherited: boolean;
  readonly systemPrompt: string | null;
  readonly roleId: string | null;
  readonly roleInstructions: string | null;
  readonly modelRef: NativeModelRef | null;
  readonly model: Model<Api> | null;
  readonly thinkingLevel: string | null;
  readonly tools: readonly string[] | null;
  readonly excludedTools: readonly string[] | null;
  readonly assignment: string | null;
  readonly routed: boolean;
}

/**
 * The root session's native session retention.
 *
 * `retain` replaces the descriptor and persists its checkpoint in one step.
 * The descriptor's `anchor` is the already-checked recorded leaf; the store
 * persists that value instead of recomputing it from the live manager.
 * `open` returns the manager the Job appends to (the live descriptor's manager,
 * or a store-opened session seeded from `seed`). `recordedAnchor` answers the
 * leaf a checkpoint may persist, and `restoreLeaf` moves a rebuilt conversation
 * to its recorded anchor, refusing an unknown one.
 */
export interface NativeActorStore {
  get(agentId: string): NativeRetainedActor | null;
  retain(agentId: string, descriptor: NativeRetainedActor): void;
  readonly durable: boolean;
  open(input: {
    readonly agentId: string;
    readonly retained: NativeRetainedActor | null;
    readonly seed: InheritedContext | null;
    readonly cwd: string;
  }): SessionManager;
  recordedAnchor(manager: SessionManager | null, fallback: string | null): string | null;
  restoreLeaf(input: {
    readonly manager: SessionManager;
    readonly agentId: string;
    readonly retained: NativeRetainedActor | null;
    readonly seed: InheritedContext | null;
  }): void;
}

/**
 * Live root-session guards. Starting a Job and writing its context are two
 * different questions and must not share one flag:
 *
 * - `canStartJob` answers whether the root admits *new* native work. It turns
 *   false as soon as the root begins quiescing.
 * - `mayPersist` answers whether this context still owns its writes. An old
 *   root stays the current owner while a BEFORE hook runs, so a run that
 *   already exists must still finish its identity, history and terminal writes
 *   even though no new Job may start under it.
 */
export interface NativeRootGuards {
  readonly storageError: Error | null;
  readonly canStartJob: boolean;
  readonly mayPersist: boolean;
}

/** Immutable root configuration a Job composes addresses and guidance from. */
export interface NativeRootConfig {
  readonly socketDir: string;
  readonly harness: HarnessConfig;
}

/** The captured parent model an Inherited Job runs on. */
export interface NativeModelResolver {
  /**
   * Resolve the captured model through the live catalog, or return it as
   * captured. A captured value that is not a usable chat model must fail with
   * `model_unavailable` instead of silently running on a default model.
   */
  inherited(captured: unknown): Model<Api> | null;
}

/** One routed identity for a Fresh Job. */
export interface NativeRouteResult {
  readonly roleId: string;
  readonly instructions: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: string;
  readonly excludeTools: readonly string[];
  readonly enableTools: readonly string[];
}

/** Fresh routing; the closure owns the registry and the config path. */
export interface NativeRoutingPort {
  route(input: {
    readonly task: string;
    readonly context: string;
    readonly signal: AbortSignal;
    readonly budget: JobBudgetPort;
  }): Promise<NativeRouteResult>;
}

/** The one shape the inherited-loadout filter needs from a parent tool. */
export interface NativeToolDescriptor {
  readonly name: string;
  readonly sourceInfo?: { readonly source?: string | undefined } | undefined;
}

/** The parent session's tool catalog (transplantability of inherited tools). */
export interface NativeToolCatalogProvider {
  catalog(): readonly NativeToolDescriptor[];
}

/** Narrow child Pi surface the runner needs for capability eligibility. */
export type NativeChildApi = CapabilityToolCatalog;

/** What the child factory installs for one Job's child Pi. */
export interface NativeChildSurfaceScope {
  /** The child's own sender id (this Job's agent id). */
  readonly senderId: string;
  /** What the child's create/list tools report as their parent (this Job's agent id). */
  readonly parentAgentId: string | null;
  /**
   * The actor whose live child surface is this child's capability parent — the
   * spawning caller, not this Job's own agent. The factory resolves it lazily
   * through the runner's `childScope()` so a revived parent is looked up anew.
   */
  readonly capabilityParentId: string | null;
  readonly depth: number;
  /** The root's resolved maximum nesting depth; this child's tool set follows it. */
  readonly maxDepth: number;
  readonly cwd: string;
  readonly allowInherited: boolean;
  /** Final exclusion list, including this depth's depth-gated harness tools. */
  readonly excludedTools: readonly string[];
}

/** A custom message body as the SDK custom-message path accepts it. */
export type NativeCustomContent = string | (TextContent | ImageContent)[];

export interface NativeCustomMessageBody {
  readonly customType: string;
  readonly content: NativeCustomContent;
  readonly display: boolean;
  readonly details: unknown;
}

export interface NativeCustomMessageOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** A custom message already resolved to its native conversation shape. */
export interface NativeCustomMessage extends NativeCustomMessageBody {
  readonly role: "custom";
  readonly timestamp: number;
}

/**
 * One resolved custom message waiting for this Job's own loop. Every buffered
 * event stays its own native entry; nothing is concatenated with another event.
 */
export interface NativePendingCustom {
  readonly kind: "custom";
  readonly from: string;
  readonly message: NativeCustomMessage;
}

export type NativePendingInput = NativePendingCustom;

export interface NativeSessionEvent {
  readonly type?: string | undefined;
}

/** A snapshot of one live native run, read without consuming its events. */
export interface NativeLiveSnapshot {
  /** The leaf id when the Job started. */
  readonly startEntryId: string | null;
  /** The current leaf id (the recorded end of what the run produced so far). */
  readonly endEntryId: string | null;
  /** Completed native messages produced since the start boundary. */
  readonly messages: readonly unknown[];
  /** Raw native entries produced since the start boundary. */
  readonly entries: readonly unknown[];
  /** The cumulative assistant partial being streamed right now, if any. */
  readonly partial: unknown | null;
}

/** The Agent queue surface the end-of-turn loop reads parked messages through. */
export interface NativeQueueAgent extends QueueCapable, Pick<Agent, 'streamFunction' | 'prepareRequest'> {
  hasQueuedMessages(): boolean;
}

/** The physical SDK session of one Job, as the runner uses it. */
export interface NativeSession {
  readonly isStreaming: boolean;
  readonly model: Model<Api> | null | undefined;
  readonly thinkingLevel: string | null | undefined;
  readonly agent: NativeQueueAgent | undefined;
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  sendCustomMessage(message: NativeCustomMessageBody, options?: NativeCustomMessageOptions): Promise<void>;
  subscribe(listener: (event: NativeSessionEvent) => void): () => void;
  clearQueue?(): unknown;
  steer(text: string): Promise<unknown>;
  abort(): Promise<void>;
}

/**
 * The execution wrapper the runner owns once a session exists. Creation and
 * disposal are the same physical ownership the shared execution module already
 * provides; the runner registers its per-Job release as a cleanup so disposal
 * owns cleanup instead of a racing `Promise.race`.
 */
export interface NativeExecution {
  readonly session: NativeSession;
  prompt(prompt: string, options: {
    readonly expandPromptTemplates: false;
    readonly images?: ImageContent[];
  }): Promise<void>;
  steer(text: string): Promise<unknown>;
  abort(): Promise<void>;
  addCleanup(cleanup: () => void | Promise<void>): void;
  dispose(): Promise<void>;
}

/** Everything the child session factory needs for one Job. */
export interface NativeSessionRequest {
  readonly inheritedTools?: readonly string[];
  readonly agentId: string;
  readonly cwd: string;
  readonly trusted: boolean;
  readonly systemPrompt: string | null;
  readonly appendSystemPrompt: readonly string[];
  readonly model: Model<Api> | null;
  /** A recorded thinking level verbatim; the factory owns SDK narrowing. */
  readonly thinkingLevel: string | null;
  readonly excludedTools: readonly string[];
  readonly sessionManager: SessionManager;
  readonly surface: NativeChildSurfaceScope;
  readonly signal: AbortSignal;
  readonly cacheKey?: string | null | undefined;
}

/** A session the factory opened and the child surface it installed. */
export interface NativeOpenedSession {
  readonly execution: NativeExecution;
  readonly capabilityScope: NativeChildApi;
}

/**
 * Settings, resource and SDK session factory. The closure owns the settings
 * cache, the parent ModelRuntime, the child resource loader and the extension
 * factory; the runner only decides *when* a Job needs a session.
 *
 * Child tool installation stays here, in the parent's factory callback: `open`
 * must build the child Pi, install the capability parent and this depth's
 * harness tools from `request.surface`, and return that child Pi's capability
 * catalog as `capabilityScope`. The runner never registers a tool.
 */
export interface NativeSessionFactory {
  /**
   * Fail before routing when the parent ModelRuntime bridge is unavailable, so
   * a Job never spends routing model calls it cannot execute.
   */
  assertModelRuntime(): void;
  open(request: NativeSessionRequest): Promise<NativeOpenedSession>;
}

/** One peer message handed to a live run. */
export interface NativePeerHandoff {
  readonly from: string;
  readonly content: string;
  /** Sender execution round, when the runtime supplied one. Default: 1. */
  readonly round?: string | number | undefined;
  /** Sender Job id, when the runtime supplied one. */
  readonly jobId?: string | undefined;
  /** Sending session, when the runtime admitted a cross-session sender. */
  readonly external?: { readonly sessionId: string; readonly sender: string; readonly replyTo: string } | undefined;
}

/**
 * One custom envelope handed to a live run. Delivery payloads carry text
 * content; a parked array-bodied custom message stays internal to the loop.
 */
export interface NativeCustomHandoff {
  readonly from: string;
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: unknown;
}

export type NativeHandoffResult =
  | { readonly accepted: true; readonly mode: 'steered' | 'pending'; readonly reason?: never }
  | { readonly accepted: false; readonly reason: 'job_closed'; readonly mode?: never };

/** The adapter outcome the Subagent runtime normalizes and adjudicates. */
export interface NativeJobOutcome {
  readonly status: TerminalStatus;
  readonly error?: unknown;
  readonly result?: string;
  readonly transcript?: unknown[];
  readonly history?: {
    readonly startEntryId: string | null;
    readonly endEntryId: string | null;
  } | null;
}

/** The physical handle the runtime receives from the runner. */
export interface NativeStartedJob extends StartedJobHandle {
  /** Resolves once routing, session construction and the initial input are ready. */
  readonly ready: Promise<void>;
  readonly done: Promise<NativeJobOutcome>;
  readonly cancel: () => void;
}

export interface NativeJobRunnerDeps {
  readonly root: NativeRootGuards;
  readonly config: NativeRootConfig;
  readonly actors: NativeActorStore;
  readonly sessions: NativeSessionFactory;
  readonly models: NativeModelResolver;
  readonly routing: NativeRoutingPort;
  readonly tools: NativeToolCatalogProvider;
  /** Direct children and external shell tasks owned by the current execution. */
  readonly work: { hasPending(agentId: string): boolean };
  readonly notify?: ((message: string, level: "error") => void) | undefined;
}
