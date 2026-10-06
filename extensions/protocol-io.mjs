/**
 * Protocol IO extension: protocol-aware `read`/`write` for one Pi session.
 *
 * `installProtocolIO(pi, { readers, writers })` makes the session's `read`
 * tool resolve protocol URIs registered by this session's extensions and makes
 * `write` accept the writable ones (only `agent://<id>` in this harness).
 * Everything else — every ordinary filesystem path, every explicit local
 * `file://` URL, every offset/limit, every image read, every approval — goes
 * to Pi's native read/write definitions unchanged; only the tool and
 * `path`/`content` descriptions gain a short note about registered URIs, while
 * the native schema, prompt snippet, guidelines and renderers stay intact.
 *
 * Both `extensions/capability.mjs` (tool/mcp/skill/npm readers) and
 * `extensions/subagent.mjs` (agent/history readers, agent writer) call this
 * installer during extension load. The first call of a session installs the
 * read/write overrides and owns the session's scheme router; later calls merge
 * their schemes into the same router, so registrations compose and no
 * duplicate tools are registered. Sessions (including child sessions) are
 * isolated by their own EventBus; `/reload` invalidates the old subscriptions
 * and the next load elects a fresh owner. See src/protocol-io.mjs for the
 * verified Pi lifecycle details and the routing policy.
 */

import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

import { installProtocolOverrides } from "../src/protocol-io.mjs";

/**
 * @param {{ registerTool: Function, getSettings?: Function, events: { emit: Function, on: Function } }} pi Extension API.
 * @param {{ readers?: Record<string, Function>, writers?: Record<string, Function> }} [routes]
 *   Reader: `async (uri, ctx, options) -> string` (full text; the override
 *   applies native offset/limit and truncation). Writer: `async (uri, content,
 *   ctx, options) -> unknown`, whose result becomes the tool text (a string is
 *   shown verbatim, another value as JSON, nothing as a plain confirmation;
 *   a value that cannot be shown as text fails the write). `options.signal` is
 *   the caller's abort signal; an already-aborted call refuses before the
 *   handler runs. Schemes are lowercase; the URI reaches the handler verbatim.
 *   `file` is reserved for local file URLs and cannot be registered.
 * @returns {{ owner: boolean, router: object, dispose: () => void }}
 */
export function installProtocolIO(pi, { readers = {}, writers = {} } = {}) {
  return installProtocolOverrides(pi, {
    readers,
    writers,
    createNativeRead: createReadToolDefinition,
    createNativeWrite: createWriteToolDefinition,
    nativeReadOptions: () => nativeReadOptions(pi),
  });
}

// Pi builds its native read tool with the persisted images.autoResize setting
// (agent-session.js `_buildRuntime`), which is not readable while extensions
// load. The override asks for it on every ordinary-file read and caches native
// definitions per (cwd, flag) in src/protocol-io.mjs, so a change takes effect
// without freezing the first observed value. When settings are unavailable,
// Pi's documented default stays in effect.
function nativeReadOptions(pi) {
  try {
    return { autoResizeImages: pi.getSettings()?.images?.autoResize ?? true };
  } catch {
    return undefined;
  }
}

// The file lives next to the loadable extensions, so it stays harmless when it
// is listed as one: it then installs the overrides with no routes, and every
// protocol URI fails explicitly instead of falling through to the filesystem.
export default installProtocolIO;
