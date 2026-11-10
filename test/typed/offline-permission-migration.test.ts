/**
 * Dedicated offline permission migration test suite: in-place conversion of legacy
 * manual-only capability-discovery records, preserving entry IDs, parent IDs,
 * timestamps, raw message bytes, and actor checkpoint semantics.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { migrateSessionFile } from '../../scripts/lib/permission-migration.ts';
import {
  CAPABILITY_TOOL_PERMISSION_RECORD,
  CAPABILITY_TOOL_PERMISSION_VERSION,
  type ToolPermissionTool,
} from '../../src/capability/tool-permission.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { ActorSessionStore } from '../../src/subagent/actor-sessions.ts';
import { createSubagentStore } from '../../src/subagent/storage.ts';

test('offline migration converts manual-only capability-discovery records in-place with identical IDs and timestamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-migrate-inplace-'));
  try {
    const sessionFile = join(dir, 'session.jsonl');
    const header = { type: 'session', id: 'sess-1', version: 3, cwd: dir, timestamp: new Date().toISOString() };
    const rootMsg = { type: 'message', id: 'm_root', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'root user message' }] }, timestamp: new Date().toISOString() };
    const discEntry = {
      type: 'custom',
      customType: 'capability-discovery',
      id: 'd_manual_1',
      parentId: 'm_root',
      timestamp: '2026-11-10T12:00:00.000Z',
      data: {
        version: 1,
        result: {
          status: 'ok',
          tools: [],
          mcp: [],
          skills: [],
          manual: [{ ref: 'tool://custom_edit', name: 'custom_edit' }],
        },
      },
    };
    const tailMsg = { type: 'message', id: 'm_tail', parentId: 'd_manual_1', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant response' }] }, timestamp: new Date().toISOString() };

    const rawHeader = JSON.stringify(header);
    const rawRootMsg = JSON.stringify(rootMsg);
    const rawTailMsg = JSON.stringify(tailMsg);

    writeFileSync(sessionFile, [rawHeader, rawRootMsg, JSON.stringify(discEntry), rawTailMsg].join('\n') + '\n');

    // Initial migration run
    const migrated = migrateSessionFile(sessionFile);
    assert.equal(migrated, true, 'migration returned true for unmigrated legacy manual record');

    // Verify raw message bytes and header were preserved verbatim
    const fileLines = readFileSync(sessionFile, 'utf8').trim().split('\n');
    assert.equal(fileLines[0], rawHeader, 'header preserved byte-identical');
    assert.equal(fileLines[1], rawRootMsg, 'root user message preserved byte-identical');
    assert.equal(fileLines[3], rawTailMsg, 'tail assistant message preserved byte-identical');

    // Reopen session file via SessionManager
    const sm = SessionManager.open(sessionFile);
    const entries = sm.getEntries();
    assert.equal(entries.length, 3, 'same number of non-header entries');

    // Verify converted custom entry: same id, same parentId, same timestamp, canonical customType and data
    const convertedEntry = entries.find((e: any) => e.id === 'd_manual_1') as any;
    assert.ok(convertedEntry, 'converted entry exists at original id d_manual_1');
    assert.equal(convertedEntry.parentId, 'm_root', 'parentId preserved');
    assert.equal(convertedEntry.timestamp, '2026-11-10T12:00:00.000Z', 'timestamp preserved');
    assert.equal(convertedEntry.customType, CAPABILITY_TOOL_PERMISSION_RECORD, 'customType converted to canonical');
    assert.deepEqual(convertedEntry.data, {
      version: CAPABILITY_TOOL_PERMISSION_VERSION,
      set: [{ target: 'custom_edit', state: 'enabled' }],
    }, 'data converted to canonical enabled set');

    // Tool admission on active branch evaluates custom_edit as enabled
    const tool: ToolPermissionTool = { name: 'custom_edit', exposure: 'direct' };
    const host = { getAllTools: () => [tool], getActiveTools: () => ['custom_edit'] };
    const adm = createToolAdmission(host as any, sm.getBranch());
    assert.equal(adm.enabled('custom_edit'), true, 'custom_edit is enabled by canonical permission');
    assert.equal(adm.admits('custom_edit'), true, 'custom_edit is admitted');

    // Second run is strictly an idempotent no-op: returns false and leaves bytes untouched
    const bytesBefore = statSync(sessionFile).size;
    const rerun = migrateSessionFile(sessionFile);
    assert.equal(rerun, false, 'rerun returns false when no legacy records remain');
    assert.equal(statSync(sessionFile).size, bytesBefore, 'zero bytes written on rerun');

    const canonical = { ...discEntry, customType: CAPABILITY_TOOL_PERMISSION_RECORD,
      data: { version: 1, set: [{ target: 'custom_edit', state: 'enabled' }] } };
    for (const [separator, ending] of [['\r\n', '\r\n'], ['\n', '']] as const) {
      const prefix = rawHeader + separator + separator + rawRootMsg + separator;
      const suffix = separator + rawTailMsg + ending;
      writeFileSync(sessionFile, prefix + JSON.stringify(discEntry) + suffix);
      assert.equal(migrateSessionFile(sessionFile), true);
      const expected = prefix + JSON.stringify(canonical) + suffix;
      assert.equal(readFileSync(sessionFile, 'utf8'), expected, 'blank lines, endings and final-newline choice stay byte-identical');
      assert.equal(migrateSessionFile(sessionFile), false);
      assert.equal(readFileSync(sessionFile, 'utf8'), expected);
    }
    const invalid = rawHeader + '\n' + JSON.stringify(discEntry) + '\n{broken\n';
    writeFileSync(sessionFile, invalid);
    assert.throws(() => migrateSessionFile(sessionFile), /invalid JSON/);
    assert.equal(readFileSync(sessionFile, 'utf8'), invalid, 'parse failure leaves all source bytes untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline migration enables pre-tail checkpoint restoration via ActorSessionStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-actor-restore-'));
  try {
    const sessionFile = join(dir, 'actor-child.jsonl');
    const header = { type: 'session', id: 's1', version: 3, cwd: dir, timestamp: new Date().toISOString() };
    const rootMsg = { type: 'message', id: 'm_root', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'root message' }] }, timestamp: new Date().toISOString() };
    const discEntry = {
      type: 'custom',
      customType: 'capability-discovery',
      id: 'd_manual_pre',
      parentId: 'm_root',
      timestamp: new Date().toISOString(),
      data: {
        version: 1,
        result: {
          status: 'ok',
          tools: [],
          mcp: [],
          skills: [],
          manual: [{ ref: 'tool://tool_checkpoint', name: 'tool_checkpoint' }],
        },
      },
    };
    const anchorMsg = { type: 'message', id: 'm_anchor', parentId: 'd_manual_pre', message: { role: 'assistant', content: [{ type: 'text', text: 'checkpoint output' }] }, timestamp: new Date().toISOString() };
    const tailMsg = { type: 'message', id: 'm_tail', parentId: 'm_anchor', message: { role: 'user', content: [{ type: 'text', text: 'later turn' }] }, timestamp: new Date().toISOString() };

    writeFileSync(sessionFile, [header, rootMsg, discEntry, anchorMsg, tailMsg].map((e) => JSON.stringify(e)).join('\n') + '\n');

    // Run migration
    const migrated = migrateSessionFile(sessionFile);
    assert.equal(migrated, true);

    // Setup ActorSessionStore and restore at pre-tail anchor m_anchor
    const storage = createSubagentStore({
      dir,
      appendEntry: () => {},
      readBranch: () => [],
      readEntries: () => [],
      openSession: (path: string, cwd?: string) => SessionManager.open(path, undefined, cwd),
    });

    const actorStore = new ActorSessionStore({
      storage,
      guard: { mayPersist: () => true },
      models: { find: () => null },
      metadata: { appendIdentity: () => {}, appendAnchor: () => {} },
    });

    const retained = {
      sessionManager: null,
      sessionFile,
      anchor: 'm_anchor',
      cwd: dir,
      trusted: true,
      allowInherited: true,
      systemPrompt: null,
      roleId: null,
      roleInstructions: null,
      modelRef: null,
      model: null,
      thinkingLevel: null,
      tools: null,
      excludedTools: [],
      assignment: null,
      routed: true,
    };

    const restoredManager = actorStore.open({ agentId: 'actor_1', retained, seed: null, cwd: dir });
    actorStore.restoreLeaf({ manager: restoredManager, agentId: 'actor_1', retained, seed: null });

    assert.equal(restoredManager.getLeafId(), 'm_anchor', 'restored manager positioned at pre-tail anchor');
    const anchorBranch = restoredManager.getBranch();

    // The anchor branch directly contains the converted canonical entry
    const canonicalEntry = anchorBranch.find((e: any) => e.id === 'd_manual_pre');
    assert.ok(canonicalEntry, 'canonical entry found on anchor branch at id d_manual_pre');
    assert.equal((canonicalEntry as any).customType, CAPABILITY_TOOL_PERMISSION_RECORD, 'converted to canonical customType');

    // Admission at anchor correctly evaluates tool_checkpoint as enabled
    const tool: ToolPermissionTool = { name: 'tool_checkpoint', exposure: 'direct' };
    const host = { getAllTools: () => [tool], getActiveTools: () => ['tool_checkpoint'] };
    const admission = createToolAdmission(host as any, anchorBranch);
    assert.equal(admission.enabled('tool_checkpoint'), true, 'tool is enabled on restored anchor branch');
    assert.equal(admission.admits('tool_checkpoint'), true, 'tool is admitted on restored anchor branch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline migration preserves sibling branches and reopen selected leaf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sibling-test-'));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'root conversation' }], timestamp: Date.now() });
    const rootId = sm.getLeafId()!;

    // Branch B: legacy manual discovery for tool_b
    sm.branch(rootId);
    sm.appendCustomEntry('capability-discovery', {
      version: 1,
      result: { status: 'ok', tools: [], mcp: [], skills: [], manual: [{ name: 'tool_b' }] },
    });
    const leafB = sm.getLeafId()!;

    // Branch A: legacy manual discovery for tool_a, created last so it is selected on open
    sm.branch(rootId);
    sm.appendCustomEntry('capability-discovery', {
      version: 1,
      result: { status: 'ok', tools: [], mcp: [], skills: [], manual: [{ name: 'tool_a' }] },
    });
    const leafA = sm.getLeafId()!;

    const sessionFile = sm.getSessionFile()!;
    const beforeOpen = SessionManager.open(sessionFile);
    assert.equal(beforeOpen.getLeafId(), leafA, 'Branch A is initial selected leaf on disk');

    // Run migration
    const migrated = migrateSessionFile(sessionFile);
    assert.equal(migrated, true);

    // Reopen: selected leaf remains Branch A
    const reopened = SessionManager.open(sessionFile);
    assert.equal(reopened.getLeafId(), leafA, 'reopened selected leaf remains Branch A');

    const activeBranch = reopened.getBranch();
    const toolA: ToolPermissionTool = { name: 'tool_a', exposure: 'direct' };
    const toolB: ToolPermissionTool = { name: 'tool_b', exposure: 'direct' };
    const host = { getAllTools: () => [toolA, toolB], getActiveTools: () => ['tool_a', 'tool_b'] };

    // Active branch has tool_a enabled, not tool_b
    const admA = createToolAdmission(host as any, activeBranch);
    assert.equal(admA.enabled('tool_a'), true);
    assert.equal(admA.enabled('tool_b'), false);

    // Sibling Branch B has tool_b enabled, not tool_a
    const branchB = reopened.getBranch(leafB);
    const admB = createToolAdmission(host as any, branchB);
    assert.equal(admB.enabled('tool_b'), true);
    assert.equal(admB.enabled('tool_a'), false);

    // Rerun is strictly no-op
    assert.equal(migrateSessionFile(sessionFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline migration refuses unsupported shapes before any write and leaves file unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-refusal-test-'));
  try {
    const makeFile = (name: string, customEntry: Record<string, unknown>) => {
      const filePath = join(dir, name);
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', version: 3, cwd: dir }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify(customEntry),
      ];
      const raw = lines.join('\n') + '\n';
      writeFileSync(filePath, raw);
      return { filePath, raw };
    };

    // 1. Refuse mixed discovery categories
    const mixed = makeFile('mixed.jsonl', {
      type: 'custom',
      customType: 'capability-discovery',
      id: 'd1',
      parentId: 'm1',
      data: { version: 1, result: { status: 'ok', tools: [{ name: 't1' }], mcp: [], skills: [], manual: [{ name: 'm1' }] } },
    });
    assert.throws(() => migrateSessionFile(mixed.filePath), /unsupported mixed capability-discovery record/);
    assert.equal(readFileSync(mixed.filePath, 'utf8'), mixed.raw, 'mixed file left untouched');

    // 2. Refuse group manual hits
    const groupHit = makeFile('group.jsonl', {
      type: 'custom',
      customType: 'capability-discovery',
      id: 'd2',
      parentId: 'm1',
      data: { version: 1, result: { status: 'ok', tools: [], mcp: [], skills: [], manual: [{ tools: [{ name: 'g1' }] }] } },
    });
    assert.throws(() => migrateSessionFile(groupHit.filePath), /group manual hit/);
    assert.equal(readFileSync(groupHit.filePath, 'utf8'), groupHit.raw, 'group hit file left untouched');

    // 3. Refuse non-flat/scheme manual target
    const schemeHit = makeFile('scheme.jsonl', {
      type: 'custom',
      customType: 'capability-discovery',
      id: 'd3',
      parentId: 'm1',
      data: { version: 1, result: { status: 'ok', tools: [], mcp: [], skills: [], manual: [{ name: 'mcp://server' }] } },
    });
    assert.throws(() => migrateSessionFile(schemeHit.filePath), /unsupported manual target/);
    assert.equal(readFileSync(schemeHit.filePath, 'utf8'), schemeHit.raw, 'scheme hit file left untouched');

    // 4. Refuse capability-blacklist entry
    const bl = makeFile('blacklist.jsonl', {
      type: 'custom',
      customType: 'capability-blacklist',
      id: 'b1',
      parentId: 'm1',
      data: { version: 1, added: [{ target: 'tool_bl' }] },
    });
    assert.throws(() => migrateSessionFile(bl.filePath), /capability-blacklist record/);
    assert.equal(readFileSync(bl.filePath, 'utf8'), bl.raw, 'blacklist file left untouched');

    // 5. Refuse canonical coexistence
    const canonCoexist = makeFile('coexist.jsonl', {
      type: 'custom',
      customType: 'capability-tool-permission',
      id: 'c1',
      parentId: 'm1',
      data: { version: 1, set: [{ target: 'tool_c', state: 'enabled' }] },
    });
    const coexistLines = [
      canonCoexist.raw.trim(),
      JSON.stringify({
        type: 'custom',
        customType: 'capability-discovery',
        id: 'd4',
        parentId: 'c1',
        data: { version: 1, result: { status: 'ok', tools: [], mcp: [], skills: [], manual: [{ name: 'tool_m' }] } },
      }),
    ].join('\n') + '\n';
    writeFileSync(canonCoexist.filePath, coexistLines);
    assert.throws(() => migrateSessionFile(canonCoexist.filePath), /pre-existing canonical capability-tool-permission records/);
    assert.equal(readFileSync(canonCoexist.filePath, 'utf8'), coexistLines, 'coexistence file left untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
