import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_HARNESS_CONFIG,
  HarnessConfigError,
  resolveHarnessConfig,
} from '../../src/harness-config.ts';
import { loadShellRuleFiles } from '../../src/shell-approval/rule-files.ts';
import { runShellPolicy } from '../../src/shell-approval/command.ts';

async function createTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-shell-rules-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('loadShellRuleFiles preserves exact file order and UTF-8 content across multiple files', async (t) => {
  const tempDir = await createTempDir(t);
  const fileA = path.join(tempDir, 'rules-a.txt');
  const fileB = path.join(tempDir, 'rules-b.txt');
  const fileC = path.join(tempDir, 'rules-c.txt');

  const contentA = 'prefix_rule(pattern=["git", "status"], decision="allow")\n';
  const contentB = '# Chinese comments & special symbols: 中文规则\nprefix_rule(pattern=["cargo", "test"])';
  const contentC = '   leading space and multiline\r\nline2   ';

  await writeFile(fileA, contentA, 'utf8');
  await writeFile(fileB, contentB, 'utf8');
  await writeFile(fileC, contentC, 'utf8');

  // Verify order [A, B, C]
  const ordered1 = await loadShellRuleFiles([fileA, fileB, fileC]);
  assert.deepEqual(ordered1, [contentA, contentB, contentC]);

  // Verify reversed order [C, B, A]
  const ordered2 = await loadShellRuleFiles([fileC, fileB, fileA]);
  assert.deepEqual(ordered2, [contentC, contentB, contentA]);

  // Verify empty array returns empty list
  const empty = await loadShellRuleFiles([]);
  assert.deepEqual(empty, []);
});

test('noinline config key: shell.approval.rules is rejected as unknown field without fallback', () => {
  assert.throws(
    () => resolveHarnessConfig([
      {
        source: '/path/to/harness.json',
        value: {
          shell: {
            approval: {
              rules: ['prefix_rule(pattern=["ls"], decision="allow")'],
            },
          },
        },
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof HarnessConfigError);
      assert.equal(error.source, '/path/to/harness.json');
      assert.equal(error.field, 'shell.approval.rules');
      assert.match(error.message, /is unknown\./);
      return true;
    },
  );
});

test('ruleFiles relative paths resolve relative to defining harness.json layer dirname, preserving absolute paths', () => {
  const layer1Source = path.join('/opt', 'harness', 'agent', 'harness.json');
  const layer1Dir = path.dirname(layer1Source);
  const absPath = path.resolve('/etc', 'security', 'rules.txt');

  const config = resolveHarnessConfig([
    {
      source: layer1Source,
      value: {
        shell: {
          approval: {
            ruleFiles: ['rules/default.rules', './custom.rules', absPath],
          },
        },
      },
    },
  ]);

  assert.deepEqual(config.shell.approval.ruleFiles, [
    path.resolve(layer1Dir, 'rules/default.rules'),
    path.resolve(layer1Dir, './custom.rules'),
    absPath,
  ]);
});

test('ruleFiles array overrides across layers rather than concatenating', () => {
  const globalSource = path.join('/agent', 'harness.json');
  const projectSource = path.join('/workspace', 'project', '.pi', 'harness.json');

  const composed = resolveHarnessConfig([
    {
      source: globalSource,
      value: {
        shell: {
          approval: {
            ruleFiles: ['global1.rules', 'global2.rules'],
          },
        },
      },
    },
    {
      source: projectSource,
      value: {
        shell: {
          approval: {
            ruleFiles: ['project.rules'],
          },
        },
      },
    },
  ]);

  // Project layer completely replaces global layer
  assert.deepEqual(composed.shell.approval.ruleFiles, [
    path.resolve(path.dirname(projectSource), 'project.rules'),
  ]);

  // Empty array in project layer clears inherited ruleFiles
  const cleared = resolveHarnessConfig([
    {
      source: globalSource,
      value: {
        shell: {
          approval: {
            ruleFiles: ['global.rules'],
          },
        },
      },
    },
    {
      source: projectSource,
      value: {
        shell: {
          approval: {
            ruleFiles: [],
          },
        },
      },
    },
  ]);
  assert.deepEqual(cleared.shell.approval.ruleFiles, []);
});

test('ruleFiles config validation rejects non-array or array with non-string/empty entries', () => {
  for (const badValue of ['not-an-array', 123, null, {}, true]) {
    assert.throws(
      () => resolveHarnessConfig([{ source: 'test', value: { shell: { approval: { ruleFiles: badValue } } } }]),
      (error: unknown) => error instanceof HarnessConfigError && error.field === 'shell.approval.ruleFiles',
    );
  }

  for (const badEntry of ['', '   ', null, 42]) {
    assert.throws(
      () => resolveHarnessConfig([{ source: 'test', value: { shell: { approval: { ruleFiles: ['valid.rules', badEntry] } } } }]),
      (error: unknown) => error instanceof HarnessConfigError && error.field === 'shell.approval.ruleFiles',
    );
  }

  // Default is empty array
  assert.deepEqual(DEFAULT_HARNESS_CONFIG.shell.approval.ruleFiles, []);
});

test('loadShellRuleFiles rejects missing files, directories, and non-regular files with descriptive English error naming path', async (t) => {
  const tempDir = await createTempDir(t);
  const missingFile = path.join(tempDir, 'does-not-exist.rules');
  const subDir = path.join(tempDir, 'sub-directory');
  await mkdir(subDir, { recursive: true });

  // Missing file error names the path
  await assert.rejects(
    () => loadShellRuleFiles([missingFile]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(missingFile));
      assert.match(error.message, /Failed to read rule file/);
      return true;
    },
  );

  // Directory error names the path
  await assert.rejects(
    () => loadShellRuleFiles([subDir]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(subDir));
      assert.match(error.message, /not a regular file/);
      return true;
    },
  );

  // Symlink checks: skip on win32 to avoid unprivileged EPERM errors in baseline test gates.
  if (process.platform !== 'win32') {
    // Symlink to directory is rejected
    const symlinkToDir = path.join(tempDir, 'symlink-dir');
    await symlink(subDir, symlinkToDir);
    await assert.rejects(
      () => loadShellRuleFiles([symlinkToDir]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(symlinkToDir));
        assert.match(error.message, /not a regular file/);
        return true;
      },
    );

    // Symlink to regular file is accepted
    const targetFile = path.join(tempDir, 'target.rules');
    await writeFile(targetFile, 'rule_content_via_target', 'utf8');
    const symlinkToFile = path.join(tempDir, 'symlink-file.rules');
    await symlink(targetFile, symlinkToFile);

    const results = await loadShellRuleFiles([symlinkToFile]);
    assert.deepEqual(results, ['rule_content_via_target']);
  }
});

test('standalone loader reads updated file contents when invoked again (lifecycle caching handled by parent)', async (t) => {
  const tempDir = await createTempDir(t);
  const ruleFile = path.join(tempDir, 'dynamic.rules');

  await writeFile(ruleFile, 'version 1 rule', 'utf8');
  const initial = await loadShellRuleFiles([ruleFile]);
  assert.deepEqual(initial, ['version 1 rule']);

  // Update file on disk
  await writeFile(ruleFile, 'version 2 updated rule', 'utf8');
  const refreshed = await loadShellRuleFiles([ruleFile]);
  assert.deepEqual(refreshed, ['version 2 updated rule']);
});

test('end-to-end: multiple Starlark rule files loaded and evaluated by WASM policy engine', async (t) => {
  const tempDir = await createTempDir(t);
  const allowFile = path.join(tempDir, 'allow.rules');
  const forbiddenFile = path.join(tempDir, 'forbidden.rules');
  const policyBin = fileURLToPath(new URL('../../vendor/codex-command-policy/bin/codex-command-policy.mjs', import.meta.url));

  // Write two separate Starlark rule files
  await writeFile(allowFile, 'prefix_rule(pattern=["git", "status"], decision="allow")\n', 'utf8');
  await writeFile(forbiddenFile, 'prefix_rule(pattern=["rm", "-rf"], decision="forbidden")\n', 'utf8');

  // Load rules via loadShellRuleFiles
  const contents = await loadShellRuleFiles([allowFile, forbiddenFile]);
  assert.equal(contents.length, 2);

  const check = (command: string) =>
    runShellPolicy(
      [process.execPath, policyBin],
      {
        version: 1,
        shell: '/bin/bash',
        command,
        cwd: tempDir,
        platform: 'posix',
        source: 'test-agent',
        rules: contents,
      },
    );

  // 1. Matches allow rule from first file -> 'allow'
  const allowRes = await check('git status');
  assert.equal(allowRes.decision, 'allow');
  assert.match(allowRes.reason, /matched policy rule with decision `allow`/);

  // 2. Matches forbidden rule from second file -> 'deny'
  const denyRes = await check('rm -rf /tmp/dangerous-target');
  assert.equal(denyRes.decision, 'deny');
  assert.match(denyRes.reason, /matched policy rule with decision `deny`/);

  // 3. Unmatched command across both files -> 'review'
  const reviewRes = await check('npm test');
  assert.equal(reviewRes.decision, 'review');
  assert.match(reviewRes.reason, /no matching allow rule/);
});
