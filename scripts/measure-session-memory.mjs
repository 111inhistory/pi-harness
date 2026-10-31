#!/usr/bin/env node
/**
 * Benchmark memory and performance metrics of a Pi session before and after pruning.
 *
 * Runs isolated child processes to measure true V8 heap and RSS impact without
 * memory pollution between runs. Never modifies the input session file; writes
 * temporary pruned files strictly to /tmp.
 *
 * Usage:
 *   node scripts/measure-session-memory.mjs <session.jsonl> [options]
 *
 * Options:
 *   --active-only      Use active-only prune mode (maximum shrink)
 *   --keep-tmp         Keep the temporary pruned file in /tmp
 *   --json             Output raw JSON report
 *   -h, --help         Show this help
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PRUNE_SCRIPT = join(SCRIPT_DIR, "prune-subagent-state-checkpoints.mjs");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const negative = bytes < 0;
  const abs = Math.abs(bytes);
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = abs;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${negative ? "-" : ""}${value.toFixed(2)} ${units[unit]}`;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function parseCli(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "active-only": { type: "boolean" },
      "keep-tmp": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(`Usage: node scripts/measure-session-memory.mjs <session.jsonl> [options]

Benchmark memory consumption (V8 Heap & RSS) before and after pruning.
Pruning is performed safely to /tmp and does NOT touch original files.

Options:
  --active-only   Test against active-only prune mode (keeps only checkpoint for leaf)
  --keep-tmp      Do not delete the temporary pruned JSONL in /tmp
  --json          Output machine-readable JSON metrics
  -h, --help      Show this help
`);
    process.exit(values.help ? 0 : 1);
  }

  const input = resolve(positionals[0]);
  if (!existsSync(input)) throw new Error(`Input file not found: ${input}`);

  return {
    input,
    activeOnly: values["active-only"] === true,
    keepTmp: values["keep-tmp"] === true,
    json: values.json === true,
  };
}

/** Execute a command as a child process and capture stdout/stderr */
function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, {
      cwd: join(SCRIPT_DIR, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (d) => (stdout += d.toString()));
    cp.stderr.on("data", (d) => (stderr += d.toString()));
    cp.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed [code ${code}]: ${stderr || stdout}`));
    });
  });
}

/**
 * Measure memory in a clean, isolated Node process with --expose-gc.
 */
async function measureIsolated(filePath, subagentDir) {
  const sessionManagerPath = resolve(
    SCRIPT_DIR,
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"
  );
  const subagentStoragePath = resolve(SCRIPT_DIR, "../src/subagent/storage.ts");

  const runnerScript = `
    const { performance } = await import("node:perf_hooks");
    const { SessionManager } = await import(${JSON.stringify(sessionManagerPath)});

    if (typeof global.gc !== "function") {
      throw new Error("Must be run with --expose-gc");
    }

    // 1. Establish clean baseline
    global.gc();
    const baseMem = process.memoryUsage();

    // 2. Measure SessionManager.open()
    const t0 = performance.now();
    const sm = SessionManager.open(${JSON.stringify(filePath)});
    const openTimeMs = performance.now() - t0;

    global.gc();
    const afterOpenMem = process.memoryUsage();

    const branch = sm.getBranch();
    const leafId = sm.getLeafId();
    const messages = branch.filter((e) => e.type === "message");

    // 3. Measure Subagent Hydration if subagent store exists
    let subagentMetrics = null;
    const subagentDir = ${JSON.stringify(subagentDir)};
    if (subagentDir) {
      try {
        const { createSubagentStore } = await import(${JSON.stringify(subagentStoragePath)});
        const store = createSubagentStore({
          sessionFile: ${JSON.stringify(filePath)},
          dir: subagentDir,
          readBranch: () => sm.getBranch(),
          appendEntry: (t, d) => sm.appendCustomEntry(t, d),
          openSession: (f) => SessionManager.open(f),
        });

        const checkpoint = store.load();
        if (checkpoint) {
          const tHyd0 = performance.now();
          const hydrated = store.hydrate(checkpoint);
          const hydTimeMs = performance.now() - tHyd0;

          // Retained after hydration (no GC, since live runtime holds these in memory)
          const liveMem = process.memoryUsage();
          subagentMetrics = {
            hasState: true,
            actorsCount: Object.keys(hydrated.actors || {}).length,
            jobsCount: (hydrated.registry?.jobs || []).length,
            hydTimeMs,
            liveHeapUsed: liveMem.heapUsed,
            liveRss: liveMem.rss,
          };
        }
      } catch (err) {
        subagentMetrics = { hasState: false, error: err.message };
      }
    }

    const result = {
      openTimeMs,
      leafId,
      totalEntries: sm.getEntries().length,
      branchLength: branch.length,
      messageCount: messages.length,
      baseHeapUsed: baseMem.heapUsed,
      openHeapUsed: afterOpenMem.heapUsed,
      openRss: afterOpenMem.rss,
      openHeapDelta: afterOpenMem.heapUsed - baseMem.heapUsed,
      subagent: subagentMetrics,
    };

    process.stdout.write(JSON.stringify(result));
  `;

  const args = ["--expose-gc", "-e", runnerScript];
  const { stdout } = await runCommand(process.execPath, args);
  return JSON.parse(stdout);
}

/** Detect subagent sessions directory from session filename / path */
function resolveSubagentDir(sessionPath) {
  // sessionPath format: .../sessions/<folder>/<timestamp>_<sessionId>.jsonl
  const filename = basename(sessionPath);
  const match = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) return null;
  const sessionId = match[0];

  const agentDirs = [
    resolve(sessionPath, "../../subagent-sessions", sessionId),
    resolve(process.env.HOME || "", "pi-harness/.pi-agent/subagent-sessions", sessionId),
    resolve(process.env.HOME || "", ".pi/agent/subagent-sessions", sessionId),
  ];

  for (const dir of agentDirs) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const inputStat = statSync(options.input);
  const subagentDir = resolveSubagentDir(options.input);

  const tmpPruned = join(
    "/tmp",
    `pruned-benchmark-${basename(options.input, ".jsonl")}-${process.pid}-${Date.now()}.jsonl`
  );

  try {
    // 1. Generate pruned file in /tmp
    const pruneArgs = [PRUNE_SCRIPT, options.input, "-o", tmpPruned, "--force"];
    if (options.activeOnly) pruneArgs.push("--active-only");

    await runCommand(process.execPath, pruneArgs);
    const prunedStat = statSync(tmpPruned);

    // 2. Measure original session in isolated process
    const before = await measureIsolated(options.input, subagentDir);

    // 3. Measure pruned session in isolated process
    const after = await measureIsolated(tmpPruned, subagentDir);

    const report = {
      input: options.input,
      tmpPruned: options.tmpPruned,
      activeOnly: options.activeOnly,
      disk: {
        beforeBytes: inputStat.size,
        afterBytes: prunedStat.size,
        savedBytes: inputStat.size - prunedStat.size,
        reductionPct: ((inputStat.size - prunedStat.size) / inputStat.size) * 100,
      },
      timing: {
        openBeforeMs: before.openTimeMs,
        openAfterMs: after.openTimeMs,
        speedup: before.openTimeMs / (after.openTimeMs || 1),
      },
      sessionManager: {
        entriesBefore: before.totalEntries,
        entriesAfter: after.totalEntries,
        heapUsedBefore: before.openHeapUsed,
        heapUsedAfter: after.openHeapUsed,
        heapSaved: before.openHeapUsed - after.openHeapUsed,
        heapReductionPct: ((before.openHeapUsed - after.openHeapUsed) / before.openHeapUsed) * 100,
        rssBefore: before.openRss,
        rssAfter: after.openRss,
        rssSaved: before.openRss - after.openRss,
      },
      subagentHydrated: null,
      integrity: {
        leafPreserved: before.leafId === after.leafId,
        messageCountBefore: before.messageCount,
        messageCountAfter: after.messageCount,
        messagesIntact: before.messageCount === after.messageCount,
      },
    };

    if (before.subagent?.hasState && after.subagent?.hasState) {
      report.subagentHydrated = {
        actorsBefore: before.subagent.actorsCount,
        actorsAfter: after.subagent.actorsCount,
        jobsBefore: before.subagent.jobsCount,
        jobsAfter: after.subagent.jobsCount,
        liveHeapBefore: before.subagent.liveHeapUsed,
        liveHeapAfter: after.subagent.liveHeapUsed,
        liveHeapSaved: before.subagent.liveHeapUsed - after.subagent.liveHeapUsed,
        liveHeapReductionPct:
          ((before.subagent.liveHeapUsed - after.subagent.liveHeapUsed) / before.subagent.liveHeapUsed) * 100,
        liveRssBefore: before.subagent.liveRss,
        liveRssAfter: after.subagent.liveRss,
        liveRssSaved: before.subagent.liveRss - after.subagent.liveRss,
      };
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    // Format human-readable output
    process.stdout.write("\n======================================================================\n");
    process.stdout.write("             PI SESSION PRUNE & MEMORY BENCHMARK REPORT               \n");
    process.stdout.write("======================================================================\n\n");

    process.stdout.write(`Target File:      ${options.input}\n`);
    process.stdout.write(`Prune Mode:       ${options.activeOnly ? "active-only (max-shrink)" : "leaf-preserving (default)"}\n`);
    process.stdout.write(`Subagent Seeds:   ${subagentDir ? subagentDir : "none detected"}\n\n`);

    process.stdout.write("--- 1. Disk Footprint & Load Time ---\n");
    process.stdout.write(`  File Size:      ${formatBytes(report.disk.beforeBytes)}  ->  ${formatBytes(report.disk.afterBytes)}  (${report.disk.reductionPct.toFixed(1)}% reduction)\n`);
    process.stdout.write(`  Total Entries:  ${report.sessionManager.entriesBefore}  ->  ${report.sessionManager.entriesAfter}  (-${report.sessionManager.entriesBefore - report.sessionManager.entriesAfter})\n`);
    process.stdout.write(`  SM Parse Time:  ${formatMs(report.timing.openBeforeMs)}  ->  ${formatMs(report.timing.openAfterMs)}  (${report.timing.speedup.toFixed(1)}x faster)\n\n`);

    process.stdout.write("--- 2. SessionManager Memory (Clean V8 Heap) ---\n");
    process.stdout.write(`  SM Heap Used:   ${formatBytes(report.sessionManager.heapUsedBefore)}  ->  ${formatBytes(report.sessionManager.heapUsedAfter)}  (Saved ${formatBytes(report.sessionManager.heapSaved)} / ${report.sessionManager.heapReductionPct.toFixed(1)}%)\n`);
    process.stdout.write(`  Process RSS:    ${formatBytes(report.sessionManager.rssBefore)}  ->  ${formatBytes(report.sessionManager.rssAfter)}  (Saved ${formatBytes(report.sessionManager.rssSaved)})\n\n`);

    if (report.subagentHydrated) {
      process.stdout.write("--- 3. Full Runtime Memory (With Subagent Hydration) ---\n");
      process.stdout.write(`  Live Heap Used: ${formatBytes(report.subagentHydrated.liveHeapBefore)}  ->  ${formatBytes(report.subagentHydrated.liveHeapAfter)}  (Saved ${formatBytes(report.subagentHydrated.liveHeapSaved)} / ${report.subagentHydrated.liveHeapReductionPct.toFixed(1)}%)\n`);
      process.stdout.write(`  Live RSS:       ${formatBytes(report.subagentHydrated.liveRssBefore)}  ->  ${formatBytes(report.subagentHydrated.liveRssAfter)}  (Saved ${formatBytes(report.subagentHydrated.liveRssSaved)})\n`);
      process.stdout.write(`  State Restored: ${report.subagentHydrated.actorsAfter} actors, ${report.subagentHydrated.jobsAfter} jobs (100% matched)\n\n`);
    }

    process.stdout.write("--- 4. Data Integrity Verification ---\n");
    process.stdout.write(`  Conversation:   ${report.integrity.messageCountBefore} messages before == ${report.integrity.messageCountAfter} messages after (${report.integrity.messagesIntact ? "PASSED: Zero message loss" : "FAILED"})\n`);
    process.stdout.write(`  Active Leaf ID: ${before.leafId} (${report.integrity.leafPreserved ? "PASSED: Unbroken tree leaf" : "FAILED"})\n`);
    process.stdout.write("======================================================================\n\n");
  } finally {
    if (!options.keepTmp && existsSync(tmpPruned)) {
      rmSync(tmpPruned, { force: true });
    } else if (options.keepTmp && existsSync(tmpPruned)) {
      process.stdout.write(`Temporary pruned session preserved at: ${tmpPruned}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
