import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from '@earendil-works/pi-coding-agent';

export interface MainInput {
  readonly text: string;
  readonly images?: readonly ImageContent[];
  readonly streamingBehavior?: 'steer' | 'followUp';
  readonly expandPromptTemplates?: boolean;
}

export interface MainInputAdmission {
  readonly generation: number;
  readonly sessionId: string;
  readonly disposition: 'handled' | 'queued' | 'started';
}

export interface MainCapabilities {
  readonly input: boolean;
  readonly interrupt: boolean;
  readonly compact: boolean;
  readonly events: boolean;
  readonly navigateTree: boolean;
  readonly reload: boolean;
  readonly newSession: boolean;
  readonly switchSession: boolean;
  readonly fork: boolean;
}

export interface MainState {
  /** SDK binding generation; the session application separately owns branch/root epochs. */
  readonly generation: number;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly name: string | null;
  readonly leafId: string | null;
  readonly model: { readonly provider: string; readonly id: string } | null;
  readonly thinkingLevel: string;
  readonly idle: boolean;
  readonly streaming: boolean;
  readonly compacting: boolean;
  readonly retrying: boolean;
  readonly pendingMessageCount: number;
  readonly activeTools: readonly string[];
  readonly capabilities: MainCapabilities;
}

export type MainEvent = {
  readonly generation: number;
  readonly sessionId: string;
} & (
  | { readonly type: 'native'; readonly event: AgentSessionEvent }
  | { readonly type: 'input_error'; readonly message: string }
);

export class MainControlError extends Error {
  readonly code: 'disposed' | 'unavailable' | 'session_replaced';
  constructor(code: 'disposed' | 'unavailable' | 'session_replaced', message: string) {
    super(message);
    this.code = code;
    this.name = 'MainControlError';
  }
}

/** Public controls only. The embedding host owns SDK sessions and runtime rebind hooks. */
export function createSdkMainControls(options: { session: AgentSession; runtime?: AgentSessionRuntime }) {
  let session: AgentSession | undefined = options.session;
  let runtime = options.runtime;
  let generation = 1;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const observers = new Set<(event: MainEvent) => void>();
  const pendingAdmissions = new Set<(error: Error) => void>();

  function current(): AgentSession {
    if (disposed) throw new MainControlError('disposed', 'Main controls have been disposed.');
    if (session === undefined) throw new MainControlError('unavailable', 'No Main SDK session is bound.');
    return session;
  }
  function emit(event: MainEvent): void {
    for (const observer of observers) {
      try { observer(event); }
      catch { /* An observer cannot change the outcome of admitted SDK work. */ }
    }
  }
  function attach(): void {
    if (session === undefined || observers.size === 0) return;
    const bound = session;
    const ownGeneration = generation;
    unsubscribe = bound.subscribe(event => {
      if (session === bound && generation === ownGeneration && !disposed) {
        emit({ type: 'native', event, generation: ownGeneration, sessionId: bound.sessionId });
      }
    });
  }
  function releaseAdmissions(error: Error): void {
    for (const reject of pendingAdmissions) reject(error);
    pendingAdmissions.clear();
  }
  function runtimeForCurrent(): AgentSessionRuntime {
    const bound = current();
    if (runtime === undefined) throw new MainControlError('unavailable', 'This host has no session runtime for replacement operations.');
    if (runtime.session !== bound) throw new MainControlError('session_replaced', 'The embedding host must bind its current SDK session before controlling it.');
    return runtime;
  }
  function capabilities(): MainCapabilities {
    const bound = current();
    const replace = runtime !== undefined && runtime.session === bound;
    return { input: true, interrupt: true, compact: true, events: true, navigateTree: true, reload: true,
      newSession: replace, switchSession: replace, fork: replace };
  }

  return {
    capabilities,
    state(): MainState {
      const bound = current();
      return { generation, sessionId: bound.sessionId, sessionFile: bound.sessionFile ?? null,
        name: bound.sessionName ?? null, leafId: bound.sessionManager.getLeafId(),
        model: bound.model === undefined ? null : { provider: bound.model.provider, id: bound.model.id },
        thinkingLevel: bound.thinkingLevel, idle: bound.isIdle, streaming: bound.isStreaming,
        compacting: bound.isCompacting, retrying: bound.isRetrying,
        pendingMessageCount: bound.pendingMessageCount, activeTools: bound.getActiveToolNames(), capabilities: capabilities() };
    },
    subscribe(observer: (event: MainEvent) => void): () => void {
      current();
      // Separate registrations of the same callback have independent lifetimes.
      const subscription = (event: MainEvent) => observer(event);
      observers.add(subscription);
      if (observers.size === 1) attach();
      return () => {
        observers.delete(subscription);
        if (observers.size === 0) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
    /** Called explicitly by the owner before binding the replacement session's extensions. */
    bindSession(next: AgentSession | undefined): void {
      if (disposed) throw new MainControlError('disposed', 'Main controls have been disposed.');
      if (session === next) return;
      unsubscribe?.(); unsubscribe = undefined;
      generation++;
      releaseAdmissions(new MainControlError('session_replaced', 'The session changed during submission; its handoff outcome is unknown. Do not replay automatically.'));
      session = next;
      attach();
    },
    submitInput(input: MainInput): Promise<MainInputAdmission> {
      const bound = current();
      const ownGeneration = generation;
      const sessionId = bound.sessionId;
      return new Promise((resolve, reject) => {
        let admitted = false;
        pendingAdmissions.add(reject);
        const fail = (error: unknown) => {
          pendingAdmissions.delete(reject);
          if (!admitted) reject(error);
          else if (!disposed && session === bound && generation === ownGeneration) {
            emit({ type: 'input_error', message: error instanceof Error ? error.message : String(error), generation: ownGeneration, sessionId });
          }
        };
        try {
          // SDK admission occurs before the run finishes. Attach rejection handling
          // immediately; errors after admission are events, never a replay signal.
          void bound.prompt(input.text, {
            ...(input.images === undefined ? {} : { images: [...input.images] }),
            ...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
            ...(input.expandPromptTemplates === undefined ? {} : { expandPromptTemplates: input.expandPromptTemplates }),
            preflightResult(disposition) {
              if (disposed || session !== bound || generation !== ownGeneration) return;
              admitted = true;
              pendingAdmissions.delete(reject);
              resolve({ disposition, generation: ownGeneration, sessionId });
            },
          }).then(() => { pendingAdmissions.delete(reject); }, fail);
        } catch (error) { fail(error); }
      });
    },
    steer(text: string, images?: readonly ImageContent[]) { return current().steer(text, images === undefined ? undefined : [...images]); },
    followUp(text: string, images?: readonly ImageContent[]) { return current().followUp(text, images === undefined ? undefined : [...images]); },
    interrupt() { return current().abort(); },
    compact(instructions?: string) { return current().compact(instructions); },
    navigateTree(targetId: string, options?: Parameters<AgentSession['navigateTree']>[1]) { return current().navigateTree(targetId, options); },
    reload() { return current().reload(); },
    newSession(options?: { parentSession?: string }) { return runtimeForCurrent().newSession(options); },
    switchSession(sessionPath: string, options?: { cwdOverride?: string }) { return runtimeForCurrent().switchSession(sessionPath, options); },
    fork(entryId: string, options?: { position?: 'before' | 'at' }) { return runtimeForCurrent().fork(entryId, options); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.(); unsubscribe = undefined;
      releaseAdmissions(new MainControlError('disposed', 'Main controls were disposed during submission; its handoff outcome is unknown. Do not replay automatically.'));
      observers.clear();
      session = undefined;
      runtime = undefined;
    },
  };
}

export type SdkMainControls = ReturnType<typeof createSdkMainControls>;
