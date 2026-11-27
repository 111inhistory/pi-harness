import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type ConfigContext = Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>;
type ConfigHost = Pick<ExtensionAPI, 'on'> & { readonly events?: ExtensionAPI['events'] };
export interface SlotSnapshot<T> { readonly value: T; readonly revision: number }

interface SlotSpec<T> {
  readonly name: string;
  readonly refreshable?: boolean;
  readonly shouldRefresh?: (ctx: ConfigContext) => boolean;
  readonly equals?: (previous: T, next: T) => boolean;
}

interface SyncSlotToken<T> extends SlotSpec<T> { readonly load: (ctx: ConfigContext) => T }
export function createSyncSlotToken<T>(spec: SyncSlotToken<T>): SyncSlotToken<T> { return spec; }
export function createAsyncSlotToken<T>(spec: SlotSpec<T>): SlotSpec<T> { return spec; }

export class ConfigStaleError extends Error {
  constructor() { super('The configuration scope changed.'); this.name = 'ConfigStaleError'; }
}

export type ConfigRefreshResult =
  | { readonly name: string; readonly status: 'updated' | 'unchanged' | 'skipped' }
  | { readonly name: string; readonly status: 'failed'; readonly keptPrevious: boolean; readonly error: unknown };

interface Cache<T> {
  snapshot?: SlotSnapshot<T>;
  failure?: { readonly error: unknown };
  inFlight?: Promise<Loaded<T>>;
}
interface Loaded<T> { readonly snapshot: SlotSnapshot<T>; readonly changed: boolean }
interface Scope {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly caches: Map<object, Cache<unknown>>;
  readonly controller: AbortController;
}
interface Refreshable {
  refresh(ctx: ConfigContext, scope: Scope): Promise<ConfigRefreshResult>;
}

export function createConfigLifecycle() {
  let scope: Scope | undefined;
  let generation = 0;
  let revision = 0;
  let closed = false;
  const refreshable = new Map<object, Refreshable>();

  function current(ctx: ConfigContext): Scope {
    if (closed) throw new ConfigStaleError();
    const trusted = ctx.isProjectTrusted();
    if (scope?.cwd !== ctx.cwd || scope.trusted !== trusted) {
      scope?.caches.clear();
      const previous = scope;
      scope = { cwd: ctx.cwd, trusted, caches: new Map(), controller: new AbortController() };
      previous?.controller.abort();
    }
    return scope;
  }

  function assertScope(ctx: ConfigContext, expected: Scope): void {
    if (closed || scope !== expected || expected.cwd !== ctx.cwd || expected.trusted !== ctx.isProjectTrusted()) throw new ConfigStaleError();
  }

  function cacheFor<T>(owner: Scope, token: SlotSpec<T>): Cache<T> {
    // The same module-owned token is the only key through which this slot is accessed.
    const previous = owner.caches.get(token) as Cache<T> | undefined;
    if (previous !== undefined) return previous;
    const cache: Cache<T> = {};
    owner.caches.set(token, cache);
    return cache;
  }

  function mayRefresh<T>(token: SlotSpec<T>, fn: (ctx: ConfigContext, owner: Scope, cache: Cache<T>) => Loaded<T> | Promise<Loaded<T>>,
    shouldRefresh = token.shouldRefresh): void {
    if (!token.refreshable || refreshable.has(token)) return;
    refreshable.set(token, {
      async refresh(ctx, owner) {
        const cache = cacheFor(owner, token);
        try {
          if (shouldRefresh?.(ctx) === false) return { name: token.name, status: 'skipped' };
          const loaded = await fn(ctx, owner, cache);
          assertScope(ctx, owner);
          return { name: token.name, status: loaded.changed ? 'updated' : 'unchanged' };
        } catch (error) {
          assertScope(ctx, owner);
          return { name: token.name, status: 'failed', keptPrevious: cache.snapshot !== undefined, error };
        }
      },
    });
  }

  function publish<T>(token: SlotSpec<T>, cache: Cache<T>, value: T): Loaded<T> {
    delete cache.failure;
    const previous = cache.snapshot;
    if (previous !== undefined && token.equals?.(previous.value, value)) return { snapshot: previous, changed: false };
    const snapshot = { value, revision: ++revision };
    cache.snapshot = snapshot;
    return { snapshot, changed: true };
  }

  function bindSyncSlot<T>(token: SyncSlotToken<T>) {
    function load(ctx: ConfigContext, owner: Scope, cache: Cache<T>): Loaded<T> {
      try {
        const value = token.load(ctx);
        assertScope(ctx, owner);
        return publish(token, cache, value);
      } catch (error) {
        assertScope(ctx, owner);
        if (token.refreshable && cache.snapshot === undefined) cache.failure = { error };
        throw error;
      }
    }
    mayRefresh(token, load);
    return {
      read(ctx: ConfigContext): SlotSnapshot<T> {
        const owner = current(ctx);
        const cache = cacheFor(owner, token);
        if (cache.snapshot !== undefined) return cache.snapshot;
        if (cache.failure !== undefined) throw cache.failure.error;
        return load(ctx, owner, cache).snapshot;
      },
      peek: (ctx: ConfigContext) => cacheFor(current(ctx), token).snapshot,
    };
  }

  function bindAsyncSlot<T>(token: SlotSpec<T>, loader: (ctx: ConfigContext) => Promise<T>, shouldRefresh = token.shouldRefresh) {
    function load(ctx: ConfigContext, owner: Scope, cache: Cache<T>): Promise<Loaded<T>> {
      const pending = Promise.resolve().then(() => {
        assertScope(ctx, owner);
        return loader(ctx);
      }).then(value => {
        assertScope(ctx, owner);
        return publish(token, cache, value);
      }, error => {
        assertScope(ctx, owner);
        if (token.refreshable && cache.snapshot === undefined) cache.failure = { error };
        throw error;
      }).finally(() => {
        if (cache.inFlight === pending) delete cache.inFlight;
      });
      cache.inFlight = pending;
      return pending;
    }
    mayRefresh(token, async (ctx, owner, cache) => {
      // Let admitted readers finish on their snapshot. Two physical loads for
      // the same slot never overlap, so an older one cannot overtake a refresh.
      while (cache.inFlight !== undefined) {
        try { await cache.inFlight; } catch { /* A refresh can recover a failed load. */ }
        assertScope(ctx, owner);
      }
      return load(ctx, owner, cache);
    }, shouldRefresh);
    return {
      async read(ctx: ConfigContext): Promise<SlotSnapshot<T>> {
        const owner = current(ctx);
        const cache = cacheFor(owner, token);
        if (cache.snapshot !== undefined) return cache.snapshot;
        if (cache.inFlight === undefined && cache.failure !== undefined) throw cache.failure.error;
        const loaded = await (cache.inFlight ?? load(ctx, owner, cache));
        assertScope(ctx, owner);
        return loaded.snapshot;
      },
      peek: (ctx: ConfigContext) => cacheFor(current(ctx), token).snapshot,
    };
  }

  return {
    bindSyncSlot, bindAsyncSlot,
    get generation() { return generation; },
    scopeSignal(ctx: ConfigContext): AbortSignal { return current(ctx).controller.signal; },
    captureScope(ctx: ConfigContext): () => boolean {
      const owner = current(ctx);
      return () => !closed && scope === owner && owner.cwd === ctx.cwd && owner.trusted === ctx.isProjectTrusted();
    },
    reset(shutdown: boolean): void {
      generation += 1;
      closed = shutdown;
      scope?.caches.clear();
      const previous = scope;
      scope = undefined;
      previous?.controller.abort();
    },
    async refreshLeaves(ctx: ConfigContext): Promise<readonly ConfigRefreshResult[]> {
      const owner = current(ctx);
      const results: ConfigRefreshResult[] = [];
      for (const slot of refreshable.values()) {
        assertScope(ctx, owner);
        results.push(await slot.refresh(ctx, owner));
      }
      assertScope(ctx, owner);
      return results;
    },
  };
}

const CHANNEL = 'pi-harness:config-lifecycle';
type ConfigLifecycle = ReturnType<typeof createConfigLifecycle>;
interface Exchange { lifecycle?: ConfigLifecycle }

export function configLifecycleFor(pi: ConfigHost): ConfigLifecycle {
  const exchange: Exchange = {};
  pi.events?.emit(CHANNEL, exchange);
  if (exchange.lifecycle !== undefined) return exchange.lifecycle;
  const lifecycle = createConfigLifecycle();
  pi.events?.on(CHANNEL, request => { (request as Exchange).lifecycle = lifecycle; });
  pi.on('session_start', () => lifecycle.reset(false));
  pi.on('session_shutdown', () => lifecycle.reset(true));
  return lifecycle;
}
