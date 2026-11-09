import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../scripts/check-test-contracts.mjs', import.meta.url));
const docPath = 'docs/contract.md';
const testPath = 'test/behavior.test.ts';
const manifestPath = 'test/contracts.json';
const initialDoc = '# Fixture\n\n## Behavior\n\nCommands preserve their arguments.\n\n```md\n## Behavior\nExample, not a real heading.\n```\n\n## Other\n\nUnrelated text.\n';

/** Exercise real index snapshots; never stage or commit in the user's repository. */
function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-test-contracts-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = (executable, args) => spawnSync(executable, args, { cwd, env, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), content);
  };
  const entry = { id: 'fixture.behavior', kind: 'design', docs: [{ path: docPath, heading: '## Behavior' }], tests: [testPath] };
  let manifest = { version: 1, contracts: [entry], reviews: {} };
  const saveManifest = () => write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  write(docPath, initialDoc);
  write(testPath, 'export const behavior = "initial fixture";\n');
  saveManifest();
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-qm', 'fixture baseline');
  return {
    cwd, git, write, entry,
    read: name => readFileSync(path.join(cwd, name), 'utf8'),
    setManifest: value => { manifest = value; saveManifest(); },
    manifest: () => manifest,
    check: (...args) => run(process.execPath, [checker, ...args]),
    review(id = entry.id) {
      const result = run(process.execPath, [checker, '--review', id, '--reason', 'Reviewed: interface unchanged by this fixture edit.']);
      assert.equal(result.status, 0, result.stderr);
      Object.assign(manifest.reviews, JSON.parse(result.stdout));
      saveManifest();
      git('add', manifestPath);
    },
  };
}

function passed(result) { assert.equal(result.status, 0, result.stderr); }
function rejected(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

test('document sections trigger paired changes while fenced headings and other sections do not', t => {
  const r = repository(t);
  passed(r.check());
  r.write(docPath, initialDoc.replace('Unrelated text.', 'Unrelated clarification.'));
  r.git('add', docPath);
  passed(r.check());
  r.write(docPath, r.read(docPath).replace('preserve their arguments', 'preserve their Unicode arguments'));
  r.git('add', docPath);
  rejected(r.check(), /documented section changed/);
  r.write(testPath, `${r.read(testPath)}// Independent Unicode scenario.\n`);
  rejected(r.check(), /documented section changed/);
  r.git('add', testPath);
  passed(r.check());
});

test('test-only changes cannot use an unstaged document edit to satisfy the contract', t => {
  const r = repository(t);
  r.write(testPath, `${r.read(testPath)}// Exercise the public command entry.\n`);
  r.git('add', testPath);
  r.write(docPath, initialDoc.replace('preserve their arguments', 'preserve arguments through the public entry'));
  rejected(r.check(), /behavioral test changed/);
  r.git('add', docPath);
  passed(r.check());
});

test('explicit review is staged-content-specific and expires after another change', t => {
  const r = repository(t);
  r.write(testPath, `${r.read(testPath)}// Refactor the fixture without changing the expected behavior.\n`);
  r.git('add', testPath);
  rejected(r.check(), /behavioral test changed/);
  r.review();
  passed(r.check());
  r.write(testPath, `${r.read(testPath)}// A later, unreviewed change.\n`);
  r.git('add', testPath);
  rejected(r.check(), /behavioral test changed/);
  r.review();
  passed(r.check());
});

test('new tests need a behavioral association and regressions need an observed failure', t => {
  const r = repository(t);
  const extra = 'test/new-regression.test.mjs';
  r.write(extra, '// A new behavioral test.\n');
  r.git('add', extra);
  rejected(r.check(), /test has no design or regression association/);
  const regression = { id: 'fixture.regression', kind: 'regression', docs: r.entry.docs, tests: [extra] };
  r.setManifest({ version: 1, contracts: [r.entry, regression], reviews: {} });
  r.git('add', manifestPath);
  rejected(r.check(), /regression needs failure/);
  regression.failure = 'A second invocation previously dropped a Unicode argument.';
  r.setManifest({ version: 1, contracts: [r.entry, regression], reviews: {} });
  r.git('add', manifestPath);
  rejected(r.check(), /behavioral test changed/);
  r.review(regression.id);
  passed(r.check());
});

test('removing a mapping cannot bypass coupling; missing and ambiguous staged headings fail', t => {
  const r = repository(t);
  r.git('rm', testPath);
  r.setManifest({ version: 1, contracts: [], reviews: {} });
  r.git('add', manifestPath);
  rejected(r.check(), /behavioral test changed/);
  r.review();
  passed(r.check());
  r.git('reset', '--hard', '-q', 'HEAD');
  r.write(docPath, initialDoc.replace('## Behavior', '## Renamed'));
  r.git('add', docPath);
  rejected(r.check(), /staged heading not found/);
  r.write(docPath, `${initialDoc}\n## Behavior\n\nAmbiguous second section.\n`);
  r.git('add', docPath);
  rejected(r.check(), /ambiguous heading/);
});

test('full audit finds untouched legacy tests without blocking unrelated staged commits', t => {
  const r = repository(t);
  r.write('test/legacy.test.ts', '// An existing unmapped behavior.\n');
  r.git('add', '.');
  r.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-qm', 'fixture legacy test');
  passed(r.check('--staged'));
  rejected(r.check('--all'), /legacy.test.ts: test has no design or regression association/);
});
