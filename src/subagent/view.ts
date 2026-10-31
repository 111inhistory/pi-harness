/**
 * Readable per-Job views of subagent work.
 *
 * A view is derived data: summary, transcript and raw result of one Job,
 * written once when the Job ends and rebuilt from native storage whenever it is
 * missing. Nothing reads a view back to restore state. A Job's history bounds
 * are sealed when it ends, so its view never changes and is independent of
 * later rewinds of either the root or the actor conversation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeJsonlAtomic } from "./storage.ts";
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export interface JobView {
  readonly jobId: string;
  readonly agentId: string;
  readonly name: string | null;
  readonly round: number;
  readonly task: string | null;
  readonly roleId: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly error: { readonly code?: string; readonly message?: string } | null;
  readonly result: string | null;
  readonly budget: { readonly modelCalls?: number; readonly activeTimeMs?: number } | null;
  readonly previousJobId: string | null;
  readonly transcript: readonly unknown[];
}
export interface TranscriptMessage { role: string; [field: string]: unknown }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function jobViewPaths(viewsDir: string, jobId: string) {
  const dir = join(viewsDir, jobId);
  return { summary: join(dir, "summary.md"), transcript: join(dir, "transcript.jsonl"), result: join(dir, "result.txt") };
}

export function hasJobView(viewsDir: string, jobId: string): boolean {
  const paths = jobViewPaths(viewsDir, jobId);
  return existsSync(paths.summary) && existsSync(paths.transcript) && existsSync(paths.result);
}

/**
 * @param {string} viewsDir
 * @param {{
 *   jobId: string, agentId: string, name: string | null, round: number,
 *   task: string | null, roleId: string | null, model: string | null,
 *   status: string, error: { code?: string, message?: string } | null,
 *   result: string | null, budget: object | null,
 *   previousJobId: string | null, transcript: object[],
 * }} view
 */
export function writeJobView(viewsDir: string, view: JobView) {
  const paths = jobViewPaths(viewsDir, view.jobId);
  writeFileAtomic(paths.result, view.result ?? "");
  writeJsonlAtomic(paths.transcript, view.transcript);
  writeFileAtomic(paths.summary, renderSummary(viewsDir, view));
  return paths;
}

function renderSummary(viewsDir: string, view: JobView): string {
  const lines = [`# Subagent ${view.agentId}${view.name ? ` (${view.name})` : ""} — Job ${view.jobId}, round ${view.round}`, ""];
  lines.push(`- **Status**: \`${view.status}\``);
  if (view.roleId) lines.push(`- **Role**: \`${view.roleId}\``);
  if (view.model) lines.push(`- **Model**: \`${view.model}\``);
  if (view.budget) {
    const seconds = Math.round((view.budget.activeTimeMs ?? 0) / 1000);
    lines.push(`- **Budget usage**: ${view.budget.modelCalls ?? 0} model calls, ${seconds}s active`);
  }
  if (view.previousJobId) lines.push(`- **Previous round**: ${jobViewPaths(viewsDir, view.previousJobId).summary}`);
  if (view.task) lines.push("", "## Task", "", view.task.trim());
  if (view.error) lines.push("", "## Error", "", "```", `[${view.error.code ?? "error"}] ${view.error.message ?? ""}`, "```");
  lines.push("", "## Result", "", view.result?.trim() || "(No output recorded)");
  return `${lines.join("\n")}\n`;
}

function serializePart(part: unknown): Record<string, unknown> {
  if (!record(part)) return { type: "unknown" };
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "thinking") return { type: "thinking", text: String(part.thinking ?? part.text ?? "") };
  if (part.type === "image") return { type: "image", mimeType: part.mimeType ?? null };
  if (part.type === "toolCall") return { type: "tool_call", id: part.id ?? null, name: part.name ?? null, arguments: part.arguments ?? null };
  return { type: String(part.type ?? "unknown") };
}

function serializeMessage(message: unknown): TranscriptMessage | null {
  if (!record(message)) return null;
  const entry: TranscriptMessage = { role: typeof message.role === "string" ? message.role : "unknown" };
  if (typeof message.content === "string") entry.content = [{ type: "text", text: message.content }];
  else entry.content = Array.isArray(message.content) ? message.content.map(serializePart) : [];
  if (typeof message.toolCallId === "string") entry.toolCallId = message.toolCallId;
  if (typeof message.toolName === "string") entry.toolName = message.toolName;
  if (message.isError === true) entry.isError = true;
  if (typeof message.stopReason === "string") entry.stopReason = message.stopReason;
  if (typeof message.model === "string") entry.model = message.model;
  return entry;
}

/**
 * Serialize native session entries into a readable transcript. Custom
 * messages and compaction summaries keep their own roles, so a compacted or
 * notified conversation stays readable instead of silently dropping content.
 */
export function readTranscript(entries: readonly SessionEntry[]): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const serialized = serializeMessage(entry.message);
      if (serialized !== null) transcript.push(serialized);
    } else if (entry.type === "custom_message") {
      transcript.push({
        role: "custom",
        customType: entry.customType,
        display: entry.display,
        details: entry.details,
        content: typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content,
      });
    } else if (entry.type === "compaction") {
      transcript.push({ role: "compactionSummary", summary: String(entry.summary ?? "") });
    }
  }
  return transcript;
}
