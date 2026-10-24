/**
 * Shared inherited-context snapshot for capability discovery and subagents.
 *
 * One capture is one frozen view of a live session: the raw session header and
 * branch entries (never a projection, a flattened transcript or a task summary),
 * plus the system prompt, selected model, thinking level and active tool names
 * at that instant. Consumers seed an in-memory SessionManager with `entries`,
 * so native conversation blocks survive verbatim - thinking with its provider
 * signature, tool calls, tool results and every other native entry.
 *
 * The one normalization: tool calls that have no result yet are removed from
 * the trailing assistant message, because the spawning call itself is still
 * executing while its tool snapshots the context, and a provider request that
 * replayed such a call would be incomplete. Thinking, text, resolved calls and
 * their results stay exactly as the session holds them. A trailing message
 * that held nothing but the pending call(s) is dropped, and the entries that
 * followed it are re-linked to its parent, so the branch stays connected;
 * nothing is fabricated to replace it. The header is copied with a fresh
 * session id: the child keeps the conversation, never the caller's session
 * identity. Harness `subagent-*` bookkeeping entries are dropped the same way.
 */

import { randomUUID } from "node:crypto";

import { isHarnessEntry, withoutEntries } from "./subagent-storage.mjs";

/**
 * The inherited session keeps the caller's conversation, not the caller's
 * session identity: the header is copied with a fresh session id so the child's
 * request-scoped ids, provider cache attribution and any future persistence can
 * never alias the caller's session. Every other header field and every branch
 * entry stays exactly as captured.
 */
function withOwnSessionId(entries) {
  let replaced = false;
  return entries.map((entry) => {
    if (replaced || entry?.type !== "session" || typeof entry.id !== "string") return entry;
    replaced = true;
    return { ...entry, id: randomUUID() };
  });
}

function toolResultIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") ids.add(message.toolCallId);
  }
  return ids;
}

function trailingAssistantIndex(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
      return index;
    }
  }
  return -1;
}

/**
 * Remove the in-flight tool call(s) from the trailing assistant message while
 * keeping every unrelated native block. Entries are copied, never mutated: the
 * captured session keeps its own live objects. A message that held nothing but
 * the pending call(s) is dropped and its followers are re-linked; nothing is
 * fabricated to replace it.
 */
function withoutInFlightToolCalls(entries) {
  const index = trailingAssistantIndex(entries);
  if (index === -1) return entries;
  const message = entries[index].message;
  if (!message.content.some((block) => block?.type === "toolCall")) return entries;
  const resolved = toolResultIds(entries);
  const content = message.content.filter((block) => block?.type !== "toolCall" || resolved.has(block.id));
  if (content.length === message.content.length) return entries;
  if (content.length === 0) return withoutEntries(entries, (entry) => entry === entries[index]);
  const copy = [...entries];
  copy[index] = { ...entries[index], message: { ...message, content } };
  return copy;
}

/**
 * Snapshot the calling context for an inherited child session.
 *
 * @param {object} pi extension API; `getActiveTools()` is read at capture time.
 * @param {object} ctx tool execution context of the spawning call.
 * @returns {{
 *   capturedAt: number,
 *   cwd: string,
 *   systemPrompt: string,
 *   model: object | null,
 *   thinkingLevel: string | null,
 *   tools: string[],
 *   entries: object[],
 * }} native session header plus branch entries, ready to seed
 *   `SessionManager.inMemory(cwd, {}, entries)`.
 */
export function captureInheritedContext(pi, ctx) {
  const sessionManager = ctx.sessionManager;
  const header = sessionManager.getHeader();
  const branch = sessionManager.getBranch();
  return {
    capturedAt: Date.now(),
    cwd: ctx.cwd,
    systemPrompt: ctx.getSystemPrompt(),
    model: ctx.model ?? null,
    thinkingLevel: ctx.thinkingLevel ?? null,
    tools: pi.getActiveTools(),
    // Harness bookkeeping never enters model context, so a child does not inherit it.
    entries: withOwnSessionId(withoutInFlightToolCalls(withoutEntries(header ? [header, ...branch] : branch, isHarnessEntry))),
  };
}
