/**
 * The current independent declaration set for one ExtensionAPI host.
 *
 * The native loadout owns the real answer: it knows the `hiddenDeclarations`
 * mask and the lazy-schema projection. This leaf module only lets another
 * domain read that answer without importing the loadout and creating a cycle.
 *
 * Pi gives each extension its own API object even when they share one resource
 * loader, so a plain WeakMap is not enough: the capability extension publishes
 * its reader on the shared extension bus, and the RPC/subagent extension reads
 * it from that same bus. A host with no bus has no known declaration projection
 * and callers fall back to the registered exposure.
 */

type DeclarationsReader = () => ReadonlySet<string> | readonly string[];

interface VisibilityExchange {
  read?: DeclarationsReader;
}

/** The shared-bus subset this module needs; every ExtensionAPI has it. */
interface VisibilityHost {
  readonly events?:
    | {
        emit(event: string, data?: unknown): unknown;
        on(event: string, handler: (data: unknown) => void): unknown;
      }
    | undefined;
}

const CHANNEL = 'pi-harness:declaration-visibility';
const readers = new WeakMap<object, DeclarationsReader>();

/** Publish the live declaration reader owned by the native loadout. */
export function setIndependentDeclarations(host: object, read: DeclarationsReader): void {
  readers.set(host, read);
  // Another extension reads through its own API object; the bus is the only
  // shared object between them.
  (host as VisibilityHost).events?.on(CHANNEL, (data) => {
    const reader = readers.get(host);
    if (reader !== undefined) (data as VisibilityExchange).read = reader;
  });
}

/**
 * The names independently declared by the model-facing loadout right now, or
 * `null` when no host on this bus registered a native loadout.
 */
export function independentDeclarations(host: object): ReadonlySet<string> | null {
  let read = readers.get(host);
  if (read === undefined) {
    const exchange: VisibilityExchange = {};
    (host as VisibilityHost).events?.emit(CHANNEL, exchange);
    read = exchange.read;
    if (read !== undefined) readers.set(host, read);
  }
  if (read === undefined) return null;
  const value = read();
  return value instanceof Set ? value : new Set(value);
}
