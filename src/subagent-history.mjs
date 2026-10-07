import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_HISTORY_DIR = ".pi/subagents";

export function getSubagentHistoryPaths(id, baseDir = DEFAULT_HISTORY_DIR, options = {}) {
  const cwd = typeof options === "string" ? options : options?.cwd;
  const dir = path.join(baseDir, id);
  const resolvedDir = cwd ? path.resolve(cwd, dir) : path.resolve(dir);
  return {
    dir,
    summary: path.join(dir, "summary.md"),
    cleanJsonl: path.join(dir, "session.clean.jsonl"),
    resolvedDir,
    resolvedSummary: path.join(resolvedDir, "summary.md"),
    resolvedCleanJsonl: path.join(resolvedDir, "session.clean.jsonl"),
  };
}

export async function ensureHistoryDir(id, baseDir = DEFAULT_HISTORY_DIR, options = {}) {
  const cwd = typeof options === "string" ? options : options?.cwd;
  const { resolvedDir } = getSubagentHistoryPaths(id, baseDir, { cwd });
  await fsp.mkdir(resolvedDir, { recursive: true });
  return resolvedDir;
}

/**
 * Append one clean structural event to session.clean.jsonl.
 * Strips any streaming token chunks and keeps semantic line events.
 */
export async function appendCleanJsonl(id, event, { baseDir = DEFAULT_HISTORY_DIR, cwd } = {}) {
  if (!event || typeof event !== "object") return;

  // Filter out raw stream deltas if passed accidentally
  if (event.type === "stream_chunk" || event.type === "delta" || event.type === "token") {
    return;
  }

  const { resolvedCleanJsonl, resolvedDir } = getSubagentHistoryPaths(id, baseDir, { cwd });
  await fsp.mkdir(resolvedDir, { recursive: true });

  const line = JSON.stringify({
    ...event,
    timestamp: event.timestamp || Date.now(),
  }) + "\n";

  await fsp.appendFile(resolvedCleanJsonl, line, "utf-8");
}

/**
 * Write or append OMP-style Compacted Markdown summary to summary.md.
 * In a revival turn (round > 1 or append: true), appends a continuation section.
 */
export async function writeCompactedSummary(
  id,
  {
    name,
    task,
    role,
    model,
    budget,
    toolCalls = [],
    result = "",
    status = "completed",
    error = null,
    round = 1,
  },
  { append = false, baseDir = DEFAULT_HISTORY_DIR, cwd } = {},
) {
  const { resolvedSummary, resolvedDir } = getSubagentHistoryPaths(id, baseDir, { cwd });
  await fsp.mkdir(resolvedDir, { recursive: true });

  const sections = [];

  if (!append || round === 1 || !fs.existsSync(resolvedSummary)) {
    sections.push(`# Subagent Summary: ${name || id} (${id})`);
    sections.push(`- **Status**: \`${status}\``);
    if (role) sections.push(`- **Role**: \`${role}\``);
    if (model) sections.push(`- **Model**: \`${model}\``);
    if (budget) {
      sections.push(
        `- **Budget Usage**: ${budget.modelCalls ?? 0} model calls, ${Math.round((budget.activeTimeMs ?? 0) / 1000)}s active`,
      );
    }
    if (task) {
      sections.push(`\n## Original Task\n\n${task.trim()}`);
    }
  } else {
    sections.push(`\n## Continuation / Round ${round}`);
    sections.push(`- **Status**: \`${status}\``);
    if (budget) {
      sections.push(
        `- **Cumulative Budget Usage**: ${budget.modelCalls ?? 0} model calls, ${Math.round((budget.activeTimeMs ?? 0) / 1000)}s active`,
      );
    }
  }

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    sections.push("\n### Tool Actions");
    for (const call of toolCalls) {
      const toolName = call.tool || call.name || "unknown";
      const args = call.input || call.arguments ? JSON.stringify(call.input || call.arguments) : "";
      const errorMark = call.isError ? " [FAILED]" : "";
      sections.push(`- \`${toolName}\`${errorMark}: ${args}`);
    }
  }

  if (error) {
    sections.push(`\n### Error / Warning\n\n\`\`\`\n${error}\n\`\`\``);
  }

  if (result) {
    sections.push(`\n### Output / Findings\n\n${result.trim()}`);
  }

  const content = sections.join("\n") + "\n";

  if (append && fs.existsSync(resolvedSummary)) {
    await fsp.appendFile(resolvedSummary, "\n" + content, "utf-8");
  } else {
    await fsp.writeFile(resolvedSummary, content, "utf-8");
  }

  return resolvedSummary;
}
