/**
 * Protocol routing and the harness `read`/`write` overrides.
 *
 * The harness exposes resources that are not files — `agent://<id>` and
 * `history://<id>` from the subagent extension, and the capability refs
 * `tool://`, `mcp://`, `skill://` and `npm://` — through Pi's built-in
 * `read`/`write` tools, and it accepts explicit local `file://` URLs through
 * the same native definitions a bare path uses. This module owns the routing
 * policy and the override tool definitions. `extensions/protocol-io.mjs` binds
 * it to Pi (`pi.events`, `pi.registerTool`, and the native
 * `createReadToolDefinition` / `createWriteToolDefinition` factories);
 * `test/protocol-io.test.mjs` binds it to fakes with the same shapes.
 *
 * Policy:
 *
 * - A `path` is a protocol URI only when it starts with `<scheme>://`, or when
 *   it carries a `://` whose prefix is not a valid scheme (malformed). Those
 *   malformed URIs are rejected rather than treated as file names. Windows
 *   drive paths (`C:\dir`, `C:/dir`, `C://dir`) are file paths on Windows.
 * - An explicit `file://` URL (any scheme case) is not a protocol route: the
 *   override converts it with Node's URL parser and hands the path it names to
 *   the same native read/write definition a bare path uses, so parameters,
 *   image handling, offset/limit paging, the mutation queue, `ctx.cwd` and
 *   settings are exactly the native ones. A `file://` URL that names no local
 *   path (non-local host, malformed escape) fails instead of falling back to a
 *   relative file name; a lone `file:` prefix without `//` stays an ordinary
 *   filesystem path, and installers cannot claim the `file` scheme.
 * - Protocol URIs never fall back to the filesystem: an unregistered or
 *   unwritable scheme fails before any native tool runs and before any
 *   handler is called, and an already-aborted call starts no handler at all.
 * - Readers return full text and are executed before Pi's read machinery;
 *   the override then runs Pi's own read definition with protocol-backed read
 *   operations, so offset/limit, line/byte truncation and continuation notices
 *   are exactly the native ones. Protocol reads never return images.
 * - Writers return the text of the result (a string is shown verbatim, another
 *   value as JSON, nothing as a plain confirmation); a value that cannot be
 *   shown as text fails the write instead of reporting success. Handlers
 *   receive the caller's `{ signal }` as an extra options argument
 *   (`(uri, ctx, options)` for readers, `(uri, content, ctx, options)` for
 *   writers).
 *
 * Session registry (verified against the installed Pi 0.99.2):
 *
 * - `DefaultResourceLoader` owns one EventBus per session
 *   (dist/core/resource-loader.js) and gives every extension a wrapper object
 *   exposing `emit`/`on` over that bus, so two extensions of one session share
 *   bus identity but not wrapper identity; child sessions build their own
 *   loader and therefore their own bus. Because `pi.events` cannot be used as
 *   an identity key, installers of one session find each other with a
 *   synchronous attach handshake over the bus itself: the first installer owns
 *   the session router, later installers are handed the router through the
 *   envelope they emit and merge their schemes into it.
 * - Bus handlers run synchronously up to their first await
 *   (dist/core/event-bus.js `safeHandler`), which makes the handshake
 *   deterministic; the owner catches merge failures into the envelope because
 *   an escaped error would only reach Pi's `console.error`.
 * - Reload replaces the extension runtime on the same bus and
 *   `runtime.invalidate()` unsubscribes every subscription made through
 *   `pi.events.on` (dist/core/extensions/loader.js), so the next load elects a
 *   fresh owner and the previous router becomes unreachable with its tools.
 */

import { fileURLToPath } from "node:url";

/** Channel on which the installers of one session find the session router. */
export const ATTACH_CHANNEL = "pi-harness.protocol-io:attach";

const ATTACH_KIND = "protocol-io.attach";
const LOCAL_FILE_SCHEME = "file";
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const MALFORMED_PREFIX = /^[^\\/]*:\/\//;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

export class ProtocolIOError extends Error {
  /**
   * @param {string} code Machine-readable failure class.
   * @param {string} message Model-facing explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = "ProtocolIOError";
    this.code = code;
  }
}

/**
 * Classify a read/write `path` as a protocol URI or a filesystem path.
 *
 * The only explicit URL form is `<scheme>://`; a lone `file:` prefix without
 * `//` (for example `file:notes.txt`, `file:/dir`) stays a native filesystem
 * path and is never reinterpreted as URL shorthand.
 *
 * @param {unknown} input Raw `path` argument.
 * @param {{ platform?: string }} [options] Injectable platform for tests.
 * @returns {{ malformed: boolean, scheme: string | null, uri: string } | null}
 *   `null` for filesystem paths; otherwise the parsed URI with the scheme
 *   lowercased (`file://` URLs included), or `scheme: null` when the `://`
 *   prefix is malformed so callers can reject it explicitly. `uri` is always
 *   the input verbatim.
 */
export function parseProtocolUri(input, options = {}) {
  const uri = typeof input === "string" ? input : "";
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && WINDOWS_DRIVE_PREFIX.test(uri)) return null;
  const scheme = SCHEME_PREFIX.exec(uri);
  if (scheme !== null) return { malformed: false, scheme: scheme[1].toLowerCase(), uri };
  if (MALFORMED_PREFIX.test(uri)) return { malformed: true, scheme: null, uri };
  return null;
}

/**
 * Session router: scheme handlers plus the dispatch rules above.
 *
 * `register` validates the whole batch before it mutates anything, so a
 * rejected installer never leaves half of its schemes behind. Duplicate
 * schemes are a conflict, not last-write-wins: two installers owning one
 * scheme would silently shadow each other.
 *
 * @param {{ readers?: Record<string, Function> | Map<string, Function>, writers?: Record<string, Function> | Map<string, Function> }} [routes]
 */
export function createProtocolRouter(routes = {}) {
  const readers = new Map();
  const writers = new Map();
  const tables = { readers, writers };

  /** Merge schemes into this router; returns a disposer removing exactly those schemes. */
  function register(extra = {}) {
    const incoming = normalizeRoutes(extra);
    for (const kind of ["readers", "writers"]) {
      for (const scheme of incoming[kind].keys()) {
        if (tables[kind].has(scheme)) {
          const noun = kind === "readers" ? "reader" : "writer";
          throw new ProtocolIOError(
            "conflicting_route",
            `Protocol "${scheme}://" already has a ${noun} in this session; two installers cannot own the same scheme.`,
          );
        }
      }
    }
    const applied = [];
    for (const kind of ["readers", "writers"]) {
      for (const [scheme, handler] of incoming[kind]) {
        tables[kind].set(scheme, handler);
        applied.push([kind, scheme, handler]);
      }
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const [kind, scheme, handler] of applied) {
        if (tables[kind].get(scheme) === handler) tables[kind].delete(scheme);
      }
    };
  }

  register(routes);

  return {
    register,
    clear() {
      readers.clear();
      writers.clear();
    },
    readSchemes: () => [...readers.keys()].sort(),
    writeSchemes: () => [...writers.keys()].sort(),
    /**
     * Resolve one protocol read. The reader receives `(uri, ctx, options)`,
     * with `options.signal` the caller's abort signal, and must return the
     * full text. An already-aborted call is refused before the reader runs.
     */
    async read(uri, ctx, options = {}) {
      if (options?.signal?.aborted) throw new Error("Operation aborted");
      const parsed = parseProtocolUri(uri);
      if (parsed === null || parsed.malformed) {
        throw new ProtocolIOError("invalid_protocol_uri", `"${uri}" is not a valid protocol URI; expected <scheme>://<path>.`);
      }
      if (parsed.scheme === LOCAL_FILE_SCHEME) throw localFileSchemeError("reader");
      const reader = readers.get(parsed.scheme);
      if (reader === undefined) {
        throw new ProtocolIOError(
          "unsupported_protocol",
          `No reader is registered for "${parsed.scheme}://" in this session.${schemeSummary("Readable", readers)}`,
        );
      }
      const text = await reader(parsed.uri, ctx, options);
      if (typeof text !== "string") {
        throw new ProtocolIOError("invalid_reader_result", `The "${parsed.scheme}://" reader must return text; it returned ${typeLabel(text)}.`);
      }
      return text;
    },
    /**
     * Send one protocol write. The writer receives `(uri, content, ctx,
     * options)`, with `options.signal` the caller's abort signal, and returns
     * the result of the write; `writeResultText` turns it into the tool text
     * and fails the write when the value cannot be shown as text. An
     * already-aborted call is refused before the writer runs.
     */
    async write(uri, content, ctx, options = {}) {
      if (options?.signal?.aborted) throw new Error("Operation aborted");
      const parsed = parseProtocolUri(uri);
      if (parsed === null || parsed.malformed) {
        throw new ProtocolIOError("invalid_protocol_uri", `"${uri}" is not a valid protocol URI; expected <scheme>://<path>.`);
      }
      if (parsed.scheme === LOCAL_FILE_SCHEME) throw localFileSchemeError("writer");
      const writer = writers.get(parsed.scheme);
      if (writer === undefined) {
        throw new ProtocolIOError(
          "readonly_protocol",
          `Protocol "${parsed.scheme}://" is not writable in this session.${schemeSummary("Writable", writers)}`,
        );
      }
      if (typeof content !== "string") {
        throw new ProtocolIOError("invalid_content", `Protocol writes carry text only; received ${typeLabel(content)}.`);
      }
      return writeResultText(parsed.scheme, parsed.uri, await writer(parsed.uri, content, ctx, options));
    },
  };
}

/**
 * Attach routes to the session that owns `bus`.
 *
 * The first caller of a session owns the router and installs the read/write
 * overrides; every later caller on the same bus (a second extension of the
 * same session, or the pre-trust preload and the final load pass, which share
 * one runtime and one bus) joins it. Different sessions have different buses,
 * so routes never leak between them.
 *
 * `bus` is `pi.events` or a fake with the same `{ emit, on }` shape.
 *
 * @returns {{ owner: boolean, router: ReturnType<typeof createProtocolRouter>, dispose: () => void }}
 */
export function attachProtocolRouter(bus, routes = {}) {
  if (!bus || typeof bus.emit !== "function" || typeof bus.on !== "function") {
    throw new ProtocolIOError("invalid_event_bus", "attachProtocolRouter requires an EventBus with emit(channel, data) and on(channel, handler).");
  }
  const pending = normalizeRoutes(routes);
  const envelope = { kind: ATTACH_KIND, routes: pending, router: null, error: null, dispose: null };
  bus.emit(ATTACH_CHANNEL, envelope);
  if (envelope.error) throw envelope.error;
  if (envelope.router !== null) {
    return { owner: false, router: envelope.router, dispose: envelope.dispose ?? (() => {}) };
  }
  const router = createProtocolRouter(pending);
  const unsubscribe = bus.on(ATTACH_CHANNEL, (message) => {
    if (!message || message.kind !== ATTACH_KIND || message.router !== null) return;
    message.router = router;
    try {
      message.dispose = router.register(message.routes);
    } catch (error) {
      message.error = error;
    }
  });
  let disposed = false;
  return {
    owner: true,
    router,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      router.clear();
    },
  };
}

// Appended to Pi's native read/write descriptions so the model knows the tools
// also resolve URIs registered by session extensions; the native name, snippet,
// guidelines, renderers, constrained sampling and schema stay intact.
const READ_URI_HINT =
  "Also reads resources registered by session extensions as protocol URIs of the form <scheme>://<path> " +
  "(for example agent://<id>, history://<id>, skill://<name> or tool://<name>); offset and limit apply to their " +
  "text the same way, and a URI whose scheme has no registered reader is refused instead of being treated as a " +
  "file. A local file:// URL reads the file it names, exactly like its path.";
const READ_PATH_HINT = "A registered resource URI of the form <scheme>://<path> or a local file:// URL is also accepted.";
const WRITE_URI_HINT =
  "Also writes registered message URIs of the form <scheme>://<id> as plain-text messages; currently only " +
  "agent://<id> (including agent://Main) is writable, and content is the message body. A local file:// URL writes " +
  "the file it names, exactly like its path. A protocol write never executes tools, MCP servers or other " +
  "capabilities, and an unregistered or read-only scheme is refused without touching the filesystem.";
const WRITE_PATH_HINT = "A registered writable message URI (currently agent://<id>) or a local file:// URL is also accepted.";
const WRITE_CONTENT_HINT = "For a message URI this is the plain-text message body; for a file:// URL it is the file content.";

/**
 * Build the `read`/`write` tool definitions that expose protocol routes
 * through Pi's tools.
 *
 * Native factories are injected so the policy is testable without the Pi
 * package: `createNativeRead(cwd, { operations })` and `createNativeWrite(cwd)`
 * are Pi's `createReadToolDefinition`/`createWriteToolDefinition`. Ordinary
 * file reads ask `nativeReadOptions` for the session's read options on every
 * call (settings are unavailable during extension load, so the adapter resolves
 * them lazily) and reuse the native definition per `(cwd, autoResizeImages)`
 * pair.
 *
 * The override keeps the native name, labels, prompt snippet, guidelines,
 * renderers, constrained sampling and parameter schema, and appends the URI
 * support to the tool description and to the `path`/`content` property
 * descriptions, so the model is not left with a file-only description while
 * protocol URIs are dispatched. The append always says "registered": schemes
 * that no extension registered are refused, never assumed to exist.
 *
 * An explicit local `file://` URL is converted to the path it names and runs
 * through the same native definition (and same `(cwd, autoResizeImages)`
 * instance) as a bare path; every other protocol URI dispatches to the router.
 *
 * @param {{ router: object, createNativeRead: Function, createNativeWrite: Function,
 *           cwd?: string, nativeReadOptions?: () => object | undefined }} options
 */
export function createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd = process.cwd(), nativeReadOptions } = {}) {
  if (!router || typeof router.read !== "function" || typeof router.write !== "function") {
    throw new ProtocolIOError("invalid_router", "createProtocolOverrides requires a protocol router from createProtocolRouter().");
  }
  if (typeof createNativeRead !== "function" || typeof createNativeWrite !== "function") {
    throw new ProtocolIOError(
      "invalid_native_factory",
      "createProtocolOverrides requires createNativeRead and createNativeWrite (Pi's createReadToolDefinition/createWriteToolDefinition).",
    );
  }
  if (nativeReadOptions !== undefined && typeof nativeReadOptions !== "function") {
    throw new ProtocolIOError("invalid_native_factory", "nativeReadOptions must be a function returning read tool options.");
  }

  const baseRead = createNativeRead(cwd);
  const nativeWrite = createNativeWrite(cwd);
  const fileReads = new Map();
  // Ordinary-file reads resolve the session's read options on every call and
  // reuse the native definition per (cwd, autoResizeImages) pair, so a setting
  // change takes effect without freezing the first observed value.
  const fileRead = (ctx) => {
    const readCwd = ctx?.cwd ?? cwd;
    const options = nativeReadOptions === undefined ? undefined : nativeReadOptions();
    const flag = options?.autoResizeImages;
    const key = `${readCwd}\u0000${flag === undefined ? "default" : String(flag)}`;
    let definition = fileReads.get(key);
    if (definition === undefined) {
      definition = options === undefined || options === null ? createNativeRead(readCwd) : createNativeRead(readCwd, options);
      fileReads.set(key, definition);
    }
    return definition;
  };

  const read = {
    ...baseRead,
    description: appendHint(baseRead.description, READ_URI_HINT),
    parameters: withPropertyDescription(baseRead.parameters, "path", READ_PATH_HINT),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parsed = parseProtocolUri(params?.path);
      if (parsed === null) return fileRead(ctx).execute(toolCallId, params, signal, onUpdate, ctx);
      // An explicit file URL is the same native read of the path it names.
      if (parsed.scheme === LOCAL_FILE_SCHEME) {
        return fileRead(ctx).execute(toolCallId, withLocalPath(params, parsed.uri), signal, onUpdate, ctx);
      }
      // Protocol branch: resolve the reader first so an unknown or malformed
      // scheme fails before any native read machinery or filesystem access.
      const text = await router.read(parsed.uri, ctx, { signal });
      const definition = createNativeRead(ctx?.cwd ?? cwd, {
        operations: {
          access: async () => {},
          readFile: async () => Buffer.from(text, "utf8"),
        },
      });
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };

  const write = {
    ...nativeWrite,
    description: appendHint(nativeWrite.description, WRITE_URI_HINT),
    parameters: withPropertyDescription(
      withPropertyDescription(nativeWrite.parameters, "path", WRITE_PATH_HINT),
      "content",
      WRITE_CONTENT_HINT,
    ),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parsed = parseProtocolUri(params?.path);
      if (parsed === null) return nativeWrite.execute(toolCallId, params, signal, onUpdate, ctx);
      // An explicit file URL is the same native write of the path it names,
      // including its mutation queue and parent-directory creation.
      if (parsed.scheme === LOCAL_FILE_SCHEME) {
        return nativeWrite.execute(toolCallId, withLocalPath(params, parsed.uri), signal, onUpdate, ctx);
      }
      const text = await router.write(parsed.uri, params?.content, ctx, { signal });
      return { content: [{ type: "text", text }] };
    },
  };

  return { read, write };
}

/**
 * Install the protocol-aware `read`/`write` tools for one Pi session.
 *
 * Every extension that owns protocol schemes calls this once during load with
 * its own `(pi, { readers, writers })`; the first call installs the tool
 * overrides (which replace the built-ins of the same name in the session tool
 * registry), the rest merge their schemes into the same router. readOnly skips
 * write registration when another extension owns the native write backend; a
 * joining installer does not change the elected owner's registration mode.
 *
 * @param {{ registerTool: Function, events: { emit: Function, on: Function } }} pi
 * @param {{ readers?: object, writers?: object, createNativeRead: Function, createNativeWrite: Function, nativeReadOptions?: Function, readOnly?: boolean }} options
 */
export function installProtocolOverrides(pi, { readers = {}, writers = {}, createNativeRead, createNativeWrite, nativeReadOptions, readOnly = false } = {}) {
  if (!pi || typeof pi.registerTool !== "function") {
    throw new ProtocolIOError("invalid_pi_api", "installProtocolOverrides requires a Pi ExtensionAPI with registerTool().");
  }
  const events = pi.events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") {
    throw new ProtocolIOError("invalid_pi_api", "installProtocolOverrides requires pi.events with emit(channel, data) and on(channel, handler).");
  }
  if (typeof createNativeRead !== "function" || typeof createNativeWrite !== "function") {
    throw new ProtocolIOError("invalid_native_factory", "installProtocolOverrides requires createNativeRead and createNativeWrite.");
  }
  const attached = attachProtocolRouter(events, { readers, writers });
  if (!attached.owner) return attached;
  const overrides = createProtocolOverrides({ router: attached.router, createNativeRead, createNativeWrite, nativeReadOptions });
  pi.registerTool(overrides.read);
  if (!readOnly) pi.registerTool(overrides.write);
  return attached;
}

function normalizeRoutes(routes) {
  const source = routes ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new ProtocolIOError("invalid_routes", "Protocol routes must be an object with optional readers and writers maps.");
  }
  const normalized = { readers: new Map(), writers: new Map() };
  for (const kind of ["readers", "writers"]) {
    for (const [rawScheme, handler] of routeEntries(source[kind], kind)) {
      const scheme = typeof rawScheme === "string" ? rawScheme.trim().toLowerCase() : "";
      if (!SCHEME_NAME.test(scheme)) {
        throw new ProtocolIOError("invalid_scheme", `Protocol ${kind} key ${JSON.stringify(rawScheme)} is not a valid scheme; use lowercase names such as "agent".`);
      }
      if (scheme === LOCAL_FILE_SCHEME) {
        throw new ProtocolIOError("reserved_scheme", `Protocol ${kind} cannot claim "file://": it is the local filesystem scheme and the read/write tools resolve it themselves.`);
      }
      if (typeof handler !== "function") {
        throw new ProtocolIOError("invalid_routes", `Protocol ${kind}["${scheme}"] must be a function.`);
      }
      if (normalized[kind].has(scheme)) {
        throw new ProtocolIOError("invalid_routes", `Protocol ${kind} declares "${scheme}://" twice.`);
      }
      normalized[kind].set(scheme, handler);
    }
  }
  return normalized;
}

function appendHint(description, hint) {
  return typeof description === "string" && description.length > 0 ? `${description} ${hint}` : hint;
}

function localFileSchemeError(role) {
  return new ProtocolIOError(
    "reserved_scheme",
    `"file://" is the local filesystem scheme and has no protocol ${role}; the read/write tools resolve it themselves.`,
  );
}

/**
 * Convert an explicit `file://` URL to the absolute path the native tools take
 * for the same file. Node's URL parser and `fileURLToPath` own the platform
 * rules (host handling, percent decoding, Windows drive and UNC paths); a URL
 * that names no local path fails here instead of reaching the filesystem as an
 * unexpected relative file name.
 */
function localFilePath(uri) {
  try {
    return fileURLToPath(new URL(uri));
  } catch (error) {
    throw new ProtocolIOError("invalid_file_url", `${JSON.stringify(uri)} is not a local file URL: ${messageOf(error)}`);
  }
}

function withLocalPath(params, uri) {
  return { ...params, path: localFilePath(uri) };
}

/**
 * The tool text of one protocol write: the writer's own text, its JSON when it
 * returned a value, or a plain confirmation when it returned nothing. Writers
 * owe no receipt shape, but a value that cannot be shown as text fails the
 * write instead of silently reporting success.
 */
function writeResultText(scheme, uri, result) {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return `Wrote to ${uri}.`;
  let text;
  try {
    text = JSON.stringify(result);
  } catch (error) {
    throw new ProtocolIOError(
      "invalid_writer_result",
      `The "${scheme}://" writer returned a result that cannot be shown as text: ${messageOf(error)}`,
    );
  }
  if (text === undefined) {
    throw new ProtocolIOError(
      "invalid_writer_result",
      `The "${scheme}://" writer returned ${typeLabel(result)}, which cannot be shown as text.`,
    );
  }
  return text;
}

/**
 * Copy of a parameter schema whose `property` description carries the extra
 * hint. TypeBox keeps its `~kind` marker as a non-enumerable own property and
 * the tool argument validator dispatches on it
 * (@earendil-works/pi-ai dist/utils/validation.js, typebox Memory.Create), so
 * the clone copies full property descriptors instead of spreading. Untouched
 * sibling nodes keep their identity and the input schema is never mutated.
 */
function withPropertyDescription(parameters, property, hint) {
  const properties = parameters?.properties;
  const target = properties?.[property];
  if (!properties || typeof properties !== "object" || !target || typeof target !== "object") return parameters;
  const described = cloneSchemaNode(target);
  Object.defineProperty(described, "description", {
    value: appendHint(target.description, hint),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const nextProperties = cloneSchemaNode(properties);
  Object.defineProperty(nextProperties, property, { value: described, enumerable: true, configurable: true, writable: true });
  const nextParameters = cloneSchemaNode(parameters);
  Object.defineProperty(nextParameters, "properties", { value: nextProperties, enumerable: true, configurable: true, writable: true });
  return nextParameters;
}

function cloneSchemaNode(node) {
  return Object.create(Object.getPrototypeOf(node), Object.getOwnPropertyDescriptors(node));
}

function routeEntries(handlers, kind) {
  if (handlers === undefined) return [];
  if (handlers instanceof Map) return handlers;
  if (handlers !== null && typeof handlers === "object" && !Array.isArray(handlers)) return Object.entries(handlers);
  throw new ProtocolIOError("invalid_routes", `Protocol ${kind} must be a { scheme: handler } map.`);
}

function schemeSummary(label, table) {
  const schemes = [...table.keys()].sort();
  if (schemes.length === 0) return ` ${label} protocols: none.`;
  return ` ${label} protocols: ${schemes.map((scheme) => `${scheme}://`).join(", ")}.`;
}

function typeLabel(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
