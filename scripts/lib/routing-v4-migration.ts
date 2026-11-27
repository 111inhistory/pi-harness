/**
 * Offline v3 -> v4 routing migration library.
 *
 * Moves legacy `[classifier]` out of `<agentDir>/subagent-routing.toml` (v3 -> v4)
 * into `<agentDir>/harness.json` (`classifier.models`). Designed strictly for
 * stopped sessions with no concurrent editors; two-file replacement is not an
 * atomic transaction under concurrent modification or power loss.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { HARNESS_CONFIG_VERSION, harnessConfigBody, resolveHarnessConfig, type ClassifierModelRef } from '../../src/harness-config.ts';
import { RoutingConfigError, validateRoutingConfig, type RoutingConfig } from '../../src/subagent/routing.ts';

export const BACKUP_SUFFIX = '.pre-routing-v4';

export interface LegacyRoutingConfig {
  readonly version: 3;
  readonly classifier: ClassifierModelRef;
  readonly instructions: RoutingConfig['instructions'];
  readonly roles: RoutingConfig['roles'];
}

export interface PlannedChange {
  readonly path: string;
  readonly backupPath?: string;
  readonly before?: Buffer;
  readonly after: Buffer;
}

export interface RoutingV4Plan {
  readonly agentDir: string;
  readonly classifier: ClassifierModelRef | null;
  /** Fixed commit order: harness.json first, subagent-routing.toml second. */
  readonly changes: readonly PlannedChange[];
}

export interface ApplyFaultHooks {
  readonly rename?: (oldPath: string, newPath: string) => void;
  readonly openCreate?: (filePath: string, flags: number, mode: number) => number;
  readonly writeCreate?: (fd: number, data: Buffer) => void;
}

export class MigrationApplyError extends Error {
  readonly committed: readonly string[];
  readonly backups: readonly string[];
  readonly recoveryCommands: readonly string[];
  readonly partialFragment: string | undefined;

  constructor(
    message: string,
    info: {
      readonly committed: readonly string[];
      readonly backups: readonly string[];
      readonly recoveryCommands: readonly string[];
      readonly partialFragment?: string;
    },
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MigrationApplyError';
    this.committed = info.committed;
    this.backups = info.backups;
    this.recoveryCommands = info.recoveryCommands;
    this.partialFragment = info.partialFragment;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a legacy v3 routing document offline. Only `version === 3` and
 * `classifier` live here; all other fields delegate to production v4
 * `validateRoutingConfig` so legacy scripts never duplicate the schema.
 */
export function validateLegacyRoutingConfig(value: unknown): LegacyRoutingConfig {
  if (!isPlainRecord(value) || value.version !== 3) {
    throw new RoutingConfigError('must be a version 3 routing config');
  }
  const classifier = value.classifier;
  if (
    !isPlainRecord(classifier)
    || Object.keys(classifier).some((k) => k !== 'provider' && k !== 'id')
    || !isFilled(classifier.provider)
    || !isFilled(classifier.id)
  ) {
    throw new RoutingConfigError('classifier must contain only a non-empty provider and id');
  }
  const rest: Record<string, unknown> = { version: 4 };
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'version' && key !== 'classifier') rest[key] = entry;
  }
  const v4 = validateRoutingConfig(rest);
  return {
    version: 3,
    classifier: { provider: classifier.provider, id: classifier.id },
    instructions: v4.instructions,
    roles: v4.roles,
  };
}

/**
 * Verify each role preserves candidate key insertion order after TOML
 * round-trip; routing breaks probability ties by `Object.keys` order.
 */
export function assertRoutingCandidateOrder(
  expected: { readonly roles: readonly { readonly id: string; readonly candidates: Readonly<Record<string, unknown>> }[] },
  actual: { readonly roles: readonly { readonly id: string; readonly candidates: Readonly<Record<string, unknown>> }[] },
): void {
  assert.equal(actual.roles.length, expected.roles.length, 'TOML serialization changed role count');
  for (let i = 0; i < expected.roles.length; i++) {
    const exp = expected.roles[i]!;
    const act = actual.roles[i]!;
    assert.equal(act.id, exp.id, `TOML serialization changed role order at index ${i}`);
    const expKeys = Object.keys(exp.candidates);
    const actKeys = Object.keys(act.candidates);
    if (expKeys.length !== actKeys.length || expKeys.some((key, idx) => actKeys[idx] !== key)) {
      throw new Error(
        `role "${exp.id}" candidate order would change from [${expKeys.join(', ')}] to [${actKeys.join(', ')}] during TOML serialization, which alters tie-break order; refusing silent reorder`,
      );
    }
  }
}

function inspectRegularFile(filePath: string): { readonly exists: boolean } {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${filePath}: refusing symbolic link`);
    if (!stat.isFile()) throw new Error(`${filePath}: expected a regular file`);
    return { exists: true };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { exists: false };
    throw error;
  }
}

function assertBackupAbsent(backupPath: string): void {
  try {
    const stat = lstatSync(backupPath);
    if (stat.isSymbolicLink()) throw new Error(`${backupPath}: refusing symbolic link at backup path`);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${backupPath}: backup already exists; move it aside instead of overwriting prior backups`);
}

export function rollbackCommandsFor(changes: readonly PlannedChange[]): readonly string[] {
  return changes.map((change) =>
    change.backupPath !== undefined
      ? `cp -p -- ${shellQuote(change.backupPath)} ${shellQuote(change.path)}`
      : `rm -- ${shellQuote(change.path)}`,
  );
}

/** Validate `<agentDir>/subagent-routing.toml` and `<agentDir>/harness.json` read-only. */
export function planRoutingV4Migration(rawAgentDir: string): RoutingV4Plan {
  const agentDir = path.resolve(rawAgentDir);
  if (!statSync(agentDir).isDirectory()) throw new Error(`${agentDir}: expected an agent directory`);

  const routingPath = path.join(agentDir, 'subagent-routing.toml');
  const harnessPath = path.join(agentDir, 'harness.json');

  const routingStat = inspectRegularFile(routingPath);
  if (!routingStat.exists) throw new Error(`${routingPath}: missing subagent-routing.toml`);
  const routingBefore = readFileSync(routingPath);
  const routingParsed = parse(routingBefore.toString('utf8'));
  if (!isPlainRecord(routingParsed)) throw new Error(`${routingPath}: expected a routing config table`);

  const harnessStat = inspectRegularFile(harnessPath);
  let harnessBefore: Buffer | undefined;
  let harnessParsed: Record<string, unknown> | undefined;
  let existingModels: readonly ClassifierModelRef[] = [];
  if (harnessStat.exists) {
    harnessBefore = readFileSync(harnessPath);
    const parsedJson: unknown = JSON.parse(harnessBefore.toString('utf8'));
    if (!isPlainRecord(parsedJson)) throw new Error(`${harnessPath}: must contain a JSON object`);
    // The offline converter can be run before the separate Harness migration.
    harnessParsed = Object.hasOwn(parsedJson, 'version') ? harnessConfigBody(parsedJson, harnessPath) : parsedJson;
    existingModels = resolveHarnessConfig([{ source: harnessPath, value: harnessParsed }]).classifier.models;
  }

  if (routingParsed.version === 4) {
    validateRoutingConfig(routingParsed);
    if (existingModels.length === 0) {
      throw new Error(`${routingPath}: already version 4, but ${harnessPath} has no classifier.models`);
    }
    return { agentDir, classifier: null, changes: [] };
  }

  const legacy = validateLegacyRoutingConfig(routingParsed);
  const targetV4: RoutingConfig = { version: 4, instructions: legacy.instructions, roles: legacy.roles };
  const nextRoutingText = stringify(targetV4);
  const reparsedRouting = validateRoutingConfig(parse(nextRoutingText));
  assert.deepStrictEqual(reparsedRouting, targetV4, 'TOML serialization changed routing semantics');
  assertRoutingCandidateOrder(targetV4, reparsedRouting);

  const changes: PlannedChange[] = [];
  const classifier = legacy.classifier;
  const exactMatch = existingModels.length === 1
    && existingModels[0]!.provider === classifier.provider
    && existingModels[0]!.id === classifier.id;

  if (!exactMatch) {
    if (existingModels.length > 0) {
      throw new Error(
        `conflict: ${harnessPath} configures classifier.models (${JSON.stringify(existingModels)}), differing from ${routingPath} [classifier] (${JSON.stringify(classifier)}); reconcile manually`,
      );
    }
    const existingClassifier = harnessParsed !== undefined && isPlainRecord(harnessParsed.classifier)
      ? harnessParsed.classifier
      : {};
    const nextHarnessObj: Record<string, unknown> = {
      version: HARNESS_CONFIG_VERSION,
      ...(harnessParsed ?? {}),
      classifier: { ...existingClassifier, models: [classifier] },
    };
    const nextHarnessText = `${JSON.stringify(nextHarnessObj, null, 2)}\n`;
    const reparsedHarness = JSON.parse(nextHarnessText) as Record<string, unknown>;
    const resolvedNext = resolveHarnessConfig([{ source: harnessPath, value: harnessConfigBody(reparsedHarness, harnessPath) }]);
    assert.deepStrictEqual(resolvedNext.classifier.models, [classifier]);
    for (const [key, value] of Object.entries(harnessParsed ?? {})) {
      if (key !== 'classifier') assert.deepStrictEqual(reparsedHarness[key], value);
    }
    const harnessBackupPath = `${harnessPath}${BACKUP_SUFFIX}`;
    if (harnessStat.exists) assertBackupAbsent(harnessBackupPath);
    changes.push({
      path: harnessPath,
      ...(harnessStat.exists ? { backupPath: harnessBackupPath, before: harnessBefore! } : {}),
      after: Buffer.from(nextHarnessText, 'utf8'),
    });
  }

  const routingBackupPath = `${routingPath}${BACKUP_SUFFIX}`;
  assertBackupAbsent(routingBackupPath);
  changes.push({
    path: routingPath,
    backupPath: routingBackupPath,
    before: routingBefore,
    after: Buffer.from(nextRoutingText, 'utf8'),
  });
  return { agentDir, classifier, changes };
}

function tryUnlink(filePath: string): void {
  try { unlinkSync(filePath); } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/**
 * Apply planned changes in fixed order (`harness.json` -> `subagent-routing.toml`).
 * Re-verifies inputs before writing, writes `wx` backups, stages updates, and
 * emits backup-preserving recovery commands if a later commit fails.
 */
export function applyRoutingV4Migration(
  plan: RoutingV4Plan,
  faults: ApplyFaultHooks = {},
): readonly string[] {
  if (plan.changes.length === 0) return [];
  const doRename = faults.rename ?? renameSync;
  const doOpenCreate = faults.openCreate ?? openSync;
  const doWriteCreate = faults.writeCreate ?? ((fd: number, data: Buffer) => writeFileSync(fd, data));

  // Re-verify preconditions immediately before writing anything.
  for (const change of plan.changes) {
    const current = inspectRegularFile(change.path);
    if (change.before !== undefined) {
      if (!current.exists) throw new Error(`${change.path}: disappeared after preflight`);
      if (Buffer.compare(readFileSync(change.path), change.before) !== 0) {
        throw new Error(`${change.path}: modified after preflight; refusing to overwrite`);
      }
      if (change.backupPath !== undefined) assertBackupAbsent(change.backupPath);
    } else if (current.exists) {
      throw new Error(`${change.path}: appeared after preflight; refusing to overwrite`);
    }
  }

  const backups: string[] = [];
  const staged = new Map<string, string>();
  const committed: PlannedChange[] = [];
  // Best-effort cleanup of temp files we own; never masks the primary error.
  const cleanupStaged = (): string => {
    const leftover: string[] = [];
    for (const [target, stagePath] of [...staged]) {
      staged.delete(target);
      try { tryUnlink(stagePath); } catch { leftover.push(stagePath); }
    }
    return leftover.length === 0 ? '' : ` (failed to remove temp file(s): ${leftover.join(', ')})`;
  };

  try {
    // 1) Byte-exact backups (wx, 0o600) for all modified existing files.
    for (const change of plan.changes) {
      if (change.backupPath === undefined || change.before === undefined) continue;
      writeFileSync(change.backupPath, change.before, { flag: 'wx', mode: 0o600 });
      assert.equal(Buffer.compare(readFileSync(change.backupPath), change.before), 0);
      backups.push(change.backupPath);
    }
    // 2) Same-directory staged replacements for all updates. Only record
    // ownership after exclusive open succeeds so an EEXIST path is never unlinked.
    for (const change of plan.changes) {
      if (change.before === undefined) continue;
      const stagePath = path.join(
        path.dirname(change.path),
        `.${path.basename(change.path)}.migrate-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
      );
      const fd = openSync(stagePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      staged.set(change.path, stagePath);
      try { writeFileSync(fd, change.after); } finally { closeSync(fd); }
      assert.equal(Buffer.compare(readFileSync(stagePath), change.after), 0);
    }
  } catch (error) {
    const cleanupNote = cleanupStaged();
    throw new MigrationApplyError(
      `failed before modifying any live file: ${messageOf(error)}${cleanupNote}`,
      { committed: [], backups, recoveryCommands: [] },
      error,
    );
  }

  // 3) Commit in fixed order: harness.json first, subagent-routing.toml second.
  for (const change of plan.changes) {
    if (change.before !== undefined) {
      try {
        doRename(staged.get(change.path)!, change.path);
        staged.delete(change.path);
        committed.push(change);
      } catch (error) {
        const cleanupNote = cleanupStaged();
        const recoveryCommands: string[] = [...rollbackCommandsFor(committed)];
        if (committed.length > 0 && change.backupPath !== undefined) {
          const archiveDest = `${change.backupPath}.archived-${Date.now()}`;
          recoveryCommands.push(
            `test ! -e ${shellQuote(archiveDest)} && test ! -L ${shellQuote(archiveDest)} && mv -- ${shellQuote(change.backupPath)} ${shellQuote(archiveDest)} && npm run migrate:routing-v4 -- --agent-dir ${shellQuote(plan.agentDir)} --apply`,
          );
        }
        const state = committed.length > 0
          ? `partial apply after committing ${committed.map((c) => c.path).join(', ')}`
          : 'live files unchanged';
        throw new MigrationApplyError(
          `failed to replace ${change.path} (${state}): ${messageOf(error)}${cleanupNote}`,
          { committed: committed.map((c) => c.path), backups, recoveryCommands },
          error,
        );
      }
    } else {
      let fd: number | undefined;
      let createdByUs = false;
      try {
        fd = doOpenCreate(change.path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        createdByUs = true;
        doWriteCreate(fd, change.after);
        closeSync(fd);
        fd = undefined;
        assert.equal(Buffer.compare(readFileSync(change.path), change.after), 0);
        committed.push(change);
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* keep primary write error */ }
        }
        // Only remove a partial file we created; never delete an EEXIST competitor.
        let partialFragment: string | undefined;
        if (createdByUs) {
          try { tryUnlink(change.path); } catch { partialFragment = change.path; }
        }
        const cleanupNote = cleanupStaged();
        const recoveryCommands = [
          ...rollbackCommandsFor(committed),
          ...(partialFragment === undefined ? [] : [`rm -- ${shellQuote(partialFragment)}`]),
        ];
        throw new MigrationApplyError(
          `failed to create ${change.path}: ${messageOf(error)}${cleanupNote}`,
          {
            committed: committed.map((c) => c.path),
            backups,
            recoveryCommands,
            ...(partialFragment === undefined ? {} : { partialFragment }),
          },
          error,
        );
      }
    }
  }
  return backups;
}
