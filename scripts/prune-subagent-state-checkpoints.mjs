#!/usr/bin/env node
/**
 * Prune redundant `subagent-state` checkpoints from a Pi session JSONL.
 *
 * Pi appends a complete subagent registry snapshot on every mutating
 * transition (src/subagent-runtime.mjs exportState + #markDirty), and the
 * session format has no delete/compaction API. A long-lived session therefore
 * accumulates thousands of full snapshots even though restore only reads the
 * newest checkpoint on the active branch (src/subagent-storage.mjs load()).
 *
 * What this tool does:
 *
 * - Keeps every non-checkpoint entry (messages, compactions, labels, ...).
 * - Keeps the newest checkpoint on every branch leaf by default, so reloading
 *   any current leaf still restores its subagent registry.
 * - Optionally keeps only the checkpoint needed by the file's last entry
 *   (`--active-only`), which is the maximum-shrink mode.
 * - Pins checkpoints referenced by compaction/label/context-edit/branch-summary
 *   entries, so those references do not become dangling.
 * - Reparents surviving entries to their nearest surviving ancestor. A removed
 *   checkpoint is a `custom` entry, not a conversation message, so this keeps
 *   the message path and branch structure intact.
 * - Preserves the last entry in file order. SessionManager uses that entry as
 *   `leafId` (`_buildIndex`), so the active leaf does not move.
 *
 * What it does not do:
 *
 * - It cannot preserve an arbitrary historical restore point. If every
 *   checkpoint before a chosen older entry is removed, restoring from that
 *   older point starts with an empty subagent registry. Use the default
 *   leaf-preserving mode (or keep the checkpoints you need) if that matters.
 * - It never touches per-actor session files under
 *   `<agentDir>/subagent-sessions/<sessionId>/`. Checkpoints may reference
 *   those files as inherited-context seeds; deleting them makes hydrate() fail.
 *
 * Usage:
 *   node scripts/prune-subagent-state-checkpoints.mjs <session.jsonl> [options]
 *
 * Options:
 *   -o, --output <file>    Write result here (default: <input>.pruned.jsonl)
 *       --in-place         Replace the input, after a timestamped backup
 *       --active-only      Keep only the checkpoint needed by the last entry
 *       --dry-run          Report what would change; write nothing
 *       --custom-type <t>  Checkpoint custom type (repeatable; default subagent-state)
 *       --force            Overwrite an existing output file
 *   -h, --help             Show this help
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { once } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";

const DEFAULT_CUSTOM_TYPES = ["subagent-state"];

const USAGE = `Usage: node scripts/prune-subagent-state-checkpoints.mjs <session.jsonl> [options]

Remove redundant subagent-state checkpoints from a Pi session JSONL and repair
the tree's parentId links.

Options:
  -o, --output <file>    Write result here (default: <input>.pruned.jsonl)
      --in-place         Replace the input, after a timestamped backup
      --active-only      Keep only the checkpoint needed by the last entry
      --dry-run          Report what would change; write nothing
      --custom-type <t>  Checkpoint custom type (repeatable; default subagent-state)
      --force            Overwrite an existing output file
  -h, --help             Show this help
`;

function fail(message) {
  throw new Error(message);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function defaultOutput(input) {
  const name = basename(input);
  const base = name.toLowerCase().endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return join(dirname(input), `${base}.pruned.jsonl`);
}

function timestampForBackup() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "in-place": { type: "boolean" },
        "active-only": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "custom-type": { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) fail(`Expected exactly one session JSONL path.\n\n${USAGE}`);

  const input = resolve(positionals[0]);
  if (!existsSync(input)) fail(`Input does not exist: ${input}`);
  if (!statSync(input).isFile()) fail(`Input is not a regular file: ${input}`);

  const inPlace = values["in-place"] === true;
  const dryRun = values["dry-run"] === true;
  const activeOnly = values["active-only"] === true;
  const customTypes = new Set(
    Array.isArray(values["custom-type"]) && values["custom-type"].length > 0
      ? values["custom-type"]
      : DEFAULT_CUSTOM_TYPES,
  );
  for (const type of customTypes) {
    if (typeof type !== "string" || type === "") fail("A checkpoint custom type must be a non-empty string.");
  }

  if (inPlace && values.output !== undefined) fail("--in-place and --output cannot be combined.");
  const output = inPlace ? input : resolve(values.output ?? defaultOutput(input));
  if (!inPlace && output === input) {
    fail("Refusing to write over the input without --in-place (use --in-place for a backed-up rewrite).");
  }
  if (!dryRun && !inPlace && existsSync(output) && values.force !== true) {
    fail(`Output already exists: ${output}\nUse --force to overwrite it, or choose another --output.`);
  }

  return {
    input,
    output,
    inPlace,
    dryRun,
    activeOnly,
    customTypes,
    force: values.force === true,
  };
}

/** Read the whole tree once, keeping only metadata (never the large payloads). */
async function scanSession(input, customTypes) {
  const entries = new Map();
  const order = [];
  let headerCount = 0;
  let headerBytes = 0;
  let lineCount = 0;
  let totalBytes = 0;

  const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
  for await (const raw of lines) {
    lineCount += 1;
    if (raw.trim() === "") continue;
    totalBytes += Buffer.byteLength(raw) + 1;

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (error) {
      fail(`${input}:${lineCount}: invalid JSON (${error.message})`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${input}:${lineCount}: an entry must be a JSON object.`);
    }

    if (entry.type === "session") {
      headerCount += 1;
      headerBytes += Buffer.byteLength(raw) + 1;
      continue;
    }
    if (typeof entry.id !== "string" || entry.id === "") {
      fail(`${input}:${lineCount}: entry has no string id.`);
    }
    if (entries.has(entry.id)) {
      fail(`${input}:${lineCount}: duplicate entry id ${JSON.stringify(entry.id)}.`);
    }

    const parentId = entry.parentId ?? null;
    if (parentId !== null && typeof parentId !== "string") {
      fail(`${input}:${lineCount}: entry ${entry.id} has a non-string parentId.`);
    }

    // Match the extension's legacy and current storage shapes.
    const isCheckpoint =
      customTypes.has(entry.type) ||
      (entry.type === "custom" && customTypes.has(entry.customType));

    // References that must stay valid even when their checkpoint is otherwise
    // old enough to remove. They are all native entry-id fields, not message
    // content.
    const refs = [];
    for (const key of ["firstKeptEntryId", "targetId", "fromId"]) {
      if (typeof entry[key] === "string") refs.push(entry[key]);
    }

    entries.set(entry.id, {
      id: entry.id,
      parentId,
      isCheckpoint,
      bytes: Buffer.byteLength(raw) + 1,
      refs,
    });
    order.push(entry.id);
  }

  if (order.length === 0) fail(`No session entries found in ${input}.`);
  if (headerCount > 1) fail(`${input}: expected at most one session header, found ${headerCount}.`);
  return { entries, order, headerCount, headerBytes, lineCount, totalBytes };
}

/**
 * A leaf is an entry with no known child. The file's last entry is always a
 * leaf and is also what SessionManager treats as the active leaf on reload.
 */
function findLeaves({ entries, order }) {
  const children = new Set();
  for (const meta of entries.values()) {
    if (meta.parentId !== null && meta.parentId !== meta.id && entries.has(meta.parentId)) {
      children.add(meta.parentId);
    }
  }
  return order.filter((id) => !children.has(id));
}

/** Walk from `startId` toward the root and return the nearest checkpoint id. */
function nearestCheckpoint(entries, startId) {
  const seen = new Set();
  let current = startId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const meta = entries.get(current);
    if (meta === undefined) return null;
    if (meta.isCheckpoint) return current;
    current = meta.parentId;
  }
  return null;
}

function selectCheckpointsToKeep({ entries, order, leaves, activeOnly }) {
  const kept = new Set();
  const leafKept = new Set();

  if (activeOnly) {
    const active = order.at(-1);
    const checkpoint = active === undefined ? null : nearestCheckpoint(entries, active);
    if (checkpoint !== null) {
      kept.add(checkpoint);
      leafKept.add(checkpoint);
    }
  } else {
    for (const leaf of leaves) {
      const checkpoint = nearestCheckpoint(entries, leaf);
      if (checkpoint !== null) {
        kept.add(checkpoint);
        leafKept.add(checkpoint);
      }
    }
  }

  // Pin checkpoints referenced by native entries. Removing one would leave a
  // compaction boundary, label, edit, or branch summary pointing at an id that
  // no longer exists.
  let pinned = 0;
  for (const meta of entries.values()) {
    for (const ref of meta.refs) {
      const target = entries.get(ref);
      if (target?.isCheckpoint === true && !kept.has(ref)) {
        kept.add(ref);
        pinned += 1;
      }
    }
  }

  return { kept, leafKept, pinned };
}

/** Whether a checkpoint is removed by this run. */
function keptEntryIds(entries, keptCheckpoints) {
  const kept = new Set();
  for (const meta of entries.values()) {
    if (!meta.isCheckpoint || keptCheckpoints.has(meta.id)) kept.add(meta.id);
  }
  return kept;
}

/**
 * Parent for a surviving entry: its nearest surviving ancestor. An originally
 * missing parent is preserved rather than guessed, so this tool never invents
 * a relationship that was not in the file.
 */
function survivingParent(entries, kept, meta, removedParentCache = new Map()) {
  if (meta.parentId === null) return null;
  if (kept.has(meta.parentId)) return meta.parentId;
  if (removedParentCache.has(meta.parentId)) return removedParentCache.get(meta.parentId);

  const seen = new Set();
  let current = meta.parentId;
  while (current !== null && !kept.has(current)) {
    if (seen.has(current)) fail(`Cycle while reparenting entry ${meta.id}.`);
    seen.add(current);
    const parent = entries.get(current);
    if (parent === undefined) break;
    current = parent.parentId;
  }

  removedParentCache.set(meta.parentId, current);
  return current;
}

async function writeStream(stream, text) {
  if (!stream.write(text)) await once(stream, "drain");
}

async function writePruned({ input, output, entries, kept, checkpointIds }) {
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  const removed = new Set([...checkpointIds].filter((id) => !kept.has(id)));
  const parentCache = new Map();
  let writtenBytes = 0;
  let writtenEntries = 0;

  let stream;
  try {
    stream = createWriteStream(temporary, { flags: "wx" });
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });

    for await (const raw of lines) {
      if (raw.trim() === "") continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch (error) {
        fail(`${input}: invalid JSON while writing (${error.message})`);
      }

      if (entry.type !== "session") {
        if (typeof entry.id !== "string" || !entries.has(entry.id)) {
          fail(`${input}: entry disappeared between the scan and the rewrite.`);
        }
        if (!kept.has(entry.id)) {
          if (!removed.has(entry.id)) fail(`Internal error: refusing to drop non-checkpoint entry ${entry.id}.`);
          continue;
        }
      }

      let text = raw;
      if (entry.type !== "session") {
        const meta = entries.get(entry.id);
        const parentId = survivingParent(entries, kept, meta, parentCache);
        if (parentId !== meta.parentId) {
          entry.parentId = parentId;
          text = JSON.stringify(entry);
        }
      }

      const line = `${text}\n`;
      await writeStream(stream, line);
      writtenBytes += Buffer.byteLength(line);
      writtenEntries += 1;
    }

    stream.end();
    await finished(stream);
    stream = null;
    return { temporary, writtenBytes, writtenEntries };
  } catch (error) {
    stream?.destroy();
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const scan = await scanSession(options.input, options.customTypes);
  if (scan.headerCount === 0) {
    process.stderr.write("warning: no session header found; treating the file as a headerless JSONL tree.\n");
  }
  const leaves = findLeaves(scan);
  if (leaves.length === 0) fail("The session tree has no leaves; refusing to rewrite a cyclic tree.");
  const checkpointIds = scan.order.filter((id) => scan.entries.get(id).isCheckpoint);

  if (checkpointIds.length === 0) {
    process.stdout.write(
      `No ${[...options.customTypes].join("/")} checkpoints found; nothing to prune. Input left unchanged.\n`,
    );
    return;
  }

  const { kept, leafKept, pinned } = selectCheckpointsToKeep({
    entries: scan.entries,
    order: scan.order,
    leaves,
    activeOnly: options.activeOnly,
  });
  const keptEntries = keptEntryIds(scan.entries, kept);
  const removed = checkpointIds.length - kept.size;
  const estimatedBytes =
    scan.headerBytes +
    scan.order
      .filter((id) => keptEntries.has(id))
      .reduce((sum, id) => sum + scan.entries.get(id).bytes, 0);

  process.stdout.write(`input:            ${options.input}\n`);
  process.stdout.write(`checkpoint types: ${[...options.customTypes].join(", ")}\n`);
  process.stdout.write(
    `tree:             ${scan.order.length} entries, ${leaves.length} leaf/leaves` +
      `${options.activeOnly ? " (active-only mode)" : ""}\n`,
  );
  process.stdout.write(
    `checkpoints:      ${checkpointIds.length} total, ${kept.size} kept ` +
      `(${leafKept.size} leaf restores, ${pinned} pinned by references), ${removed} removed\n`,
  );
  process.stdout.write(`bytes:            ${formatBytes(scan.totalBytes)} input, `);
  if (options.dryRun) {
    process.stdout.write(`~${formatBytes(estimatedBytes)} after prune (estimate)\n`);
    process.stdout.write("dry run:          no file written\n");
    return;
  }

  if (removed === 0) {
    process.stdout.write("nothing to remove; input left unchanged.\n");
    return;
  }

  const result = await writePruned({
    input: options.input,
    output: options.output,
    entries: scan.entries,
    kept: keptEntries,
    checkpointIds,
  });

  try {
    if (options.inPlace) {
      const backup = `${options.input}.pre-prune-${timestampForBackup()}-${process.pid}.bak`;
      renameSync(options.input, backup);
      try {
        renameSync(result.temporary, options.input);
      } catch (error) {
        renameSync(backup, options.input);
        rmSync(result.temporary, { force: true });
        throw error;
      }
      process.stdout.write(`bytes:            ${formatBytes(scan.totalBytes)} -> ${formatBytes(result.writtenBytes)}\n`);
      process.stdout.write(`entries:          ${scan.order.length} -> ${result.writtenEntries}\n`);
      process.stdout.write(`backup:           ${backup}\n`);
      process.stdout.write(`output:           ${options.input}\n`);
    } else {
      if (options.force && existsSync(options.output)) rmSync(options.output, { force: true });
      renameSync(result.temporary, options.output);
      process.stdout.write(`bytes:            ${formatBytes(scan.totalBytes)} -> ${formatBytes(result.writtenBytes)}\n`);
      process.stdout.write(`entries:          ${scan.order.length} -> ${result.writtenEntries}\n`);
      process.stdout.write(`output:           ${options.output}\n`);
    }
  } catch (error) {
    rmSync(result.temporary, { force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
