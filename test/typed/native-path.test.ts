/**
 * Native filesystem path identity.
 *
 * A recorded path is a spelling of a file, not the file: Windows resolves
 * separators and ignores case, POSIX does neither. These cases pin the narrow
 * primitive and the two decisions that depend on it — a directory record's own
 * `socketDir`, and the storage own-file / copy-on-write boundary. IPC endpoint
 * identity is a separate contract and is not exercised here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import { sameParentDirectory, samePath } from '../../src/fs-path.ts';
import { createSubagentStore } from '../../src/subagent/storage.ts';

const windows = process.platform === 'win32';

/** A differently-spelled path: the same file on Windows, a different one on POSIX. */
function respelled(value: string): string {
  return value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase();
}

function store(dir: string) {
  const branch: object[] = [];
  return createSubagentStore<SessionManager>({
    dir,
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }); },
    readBranch: () => branch,
    readEntries: () => branch,
    openSession: (file, cwd) => SessionManager.open(file, dir, cwd),
  });
}

test('path identity follows the selected platform dialect', () => {
  // Windows: separators resolve and case is ignored.
  assert.equal(samePath(String.raw`E:\Sessions\Agent.jsonl`, 'e:/sessions/agent.JSONL', 'win32'), true);
  assert.equal(samePath(String.raw`E:\Sessions\Agent.jsonl`, String.raw`E:\Sessions\Other.jsonl`, 'win32'), false);
  assert.equal(samePath(String.raw`E:\Sessions\Agent.jsonl`, String.raw`E:\Sessions\Sub\Agent.jsonl`, 'win32'), false);
  assert.equal(sameParentDirectory(String.raw`E:\Sessions\Agent.jsonl`, 'e:\\sessions', 'win32'), true);
  assert.equal(sameParentDirectory(String.raw`E:\Sessions\Sub\Agent.jsonl`, String.raw`E:\Sessions`, 'win32'), false);

  // POSIX: byte-exact and case-sensitive.
  assert.equal(samePath('/tmp/work/Agent.jsonl', '/tmp/work/Agent.jsonl', 'linux'), true);
  assert.equal(samePath('/tmp/work/Agent.jsonl', '/tmp/work/agent.jsonl', 'linux'), false);
  assert.equal(samePath('/tmp/work/Agent.jsonl', '/tmp/work/./Agent.jsonl', 'linux'), true);
  assert.equal(samePath('/tmp/work/Agent.jsonl', '/tmp/work/../work/Agent.jsonl', 'linux'), true);
  assert.equal(sameParentDirectory('/tmp/work/Agent.jsonl', '/tmp/work', 'linux'), true);
  assert.equal(sameParentDirectory('/tmp/work/sub/Agent.jsonl', '/tmp/work', 'linux'), false);
});

test('the storage own-file boundary is native path identity, not string equality', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-native-path-'));
  try {
    const durable = store(dir);
    const own = durable.openForAppend('sub_01', null, null, dir).file;
    assert.equal(durable.ownsFile(own), true);
    assert.equal(durable.ownsFile(join(dir, '..', basename(dir), 'other.jsonl')), true, 'a path spelling of this directory is still this directory');
    assert.equal(durable.ownsFile(join(dir, '..', 'outside.jsonl')), false);
    assert.equal(durable.ownsFile(respelled(own)), windows,
      windows ? 'Windows ignores the case of an owned file' : 'POSIX keeps a differently-cased file foreign');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy-on-write compares the recorded parent with native path identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-native-path-'));
  const foreignDir = mkdtempSync(join(tmpdir(), 'pi-native-foreign-'));
  try {
    const durable = store(dir);
    const parent = SessionManager.create(foreignDir, foreignDir);
    const foreign = parent.getSessionFile();
    assert.ok(foreign, 'a parent session materializes a session file');
    parent.appendMessage({ role: 'user', content: [{ type: 'text', text: 'prior turn' }], timestamp: Date.now() });
    assert.equal(durable.ownsFile(foreign), false, 'a parent session file is not ours');

    const copied = durable.openForAppend('sub_01', foreign, null, dir);
    assert.equal(copied.relocated, true);
    assert.equal(durable.ownsFile(copied.file), true);
    assert.equal(samePath(copied.file, join(dir, 'sub_01.jsonl')), true);
    assert.equal(copied.manager.getHeader()?.parentSession, foreign, 'the recorded parent keeps its original spelling');

    // The same parent spelled differently is the same file on Windows, so the
    // existing copy is reused; POSIX must refuse instead of overwriting it.
    if (windows) {
      const reused = durable.openForAppend('sub_01', respelled(foreign), null, dir);
      assert.equal(reused.relocated, true);
      assert.equal(samePath(reused.file, copied.file), true);
    } else {
      assert.throws(
        () => durable.openForAppend('sub_01', respelled(foreign), null, dir),
        { code: 'storage_seed_conflict' },
      );
    }

    // Our own file spelled differently is our own file on Windows: it is opened
    // in place, not copied and not refused, and keeps its native identity.
    if (windows) {
      const own = durable.openForAppend('sub_01', respelled(copied.file), null, dir);
      assert.equal(own.relocated, false);
      assert.equal(samePath(own.file, copied.file), true);
      assert.equal(own.manager.getSessionId(), copied.manager.getSessionId());
      assert.equal(own.manager.getHeader()?.id, copied.manager.getHeader()?.id);
    } else {
      assert.throws(
        () => durable.openForAppend('sub_01', respelled(copied.file), null, dir),
        { code: 'storage_seed_conflict' },
        'POSIX keeps a differently-cased path foreign',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreignDir, { recursive: true, force: true });
  }
});
