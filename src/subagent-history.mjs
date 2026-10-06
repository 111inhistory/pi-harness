import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_HISTORY_DIR = ".pi/subagents";

export function getSubagentHistoryPaths(id, baseDir = DEFAULT_HISTORY_DIR) {
  const dir = path.join(baseDir, id);
  return {
    dir,
    summary: path.join(dir, "summary.md"),
    cleanJsonl: path.join(dir, "session.clean.jsonl"),
  };
}

export async function ensureHistoryDir(id, baseDir = DEFAULT_HISTORY_DIR) {
  const { dir } = getSubagentHistoryPaths(id, baseDir);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Append one clean structural event to session.clean.jsonl.
 * Strips any streaming token chunks and keeps semantic line events.
 */
export async function appendCleanJsonl(id, event, { baseDir = DEFAULT_HISTORY_DIR } = {}) {
  if (!event || typeof event !== "object") return;

  // Filter out raw stream deltas if passed accidentally
  if (event.type === "stream_chunk" || event.type === "delta" || event.type === "token") {
    return;
  }

  const { cleanJsonl } = getSubagentHistoryPaths(id, baseDir);
  await ensureHistoryDir(id, baseDir);

  const line = JSON.stringify({
    ...event,
    timestamp: event.timestamp || Date.now(),
  }) + "\n";

  await fsp.appendFile(cleanJsonl, line, "utf-8");
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
  { append = false, baseDir = DEFAULT_HISTORY_DIR } = {},
) {
  const { summary } = getSubagentHistoryPaths(id, baseDir);
  await ensureHistoryDir(id, baseDir);

  const sections = [];

  if (!append || round === 1 || !fs.existsSync(summary)) {
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

  if (append && fs.existsSync(summary)) {
    await fsp.appendFile(summary, "\n" + content, "utf-8");
  } else {
    await fsp.writeFile(summary, content, "utf-8");
  }

  return summary;
}
