#!/usr/bin/env node
/** Compare documented contracts and behavioral tests in HEAD and the Git index. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MANIFEST = 'test/contracts.json';
const TEST_FILE = /^test\/.+\.test\.(?:ts|mjs)$/;

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function requireGit(args) {
  const result = git(args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function filePath(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('/')
    && !value.includes('\\') && !value.includes('\0') && !value.includes(':')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function fail(message) { throw new Error(message); }

function parseManifest(text, label) {
  if (text === null) return { version: 1, contracts: [], reviews: {} };
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label}: invalid JSON`); }
  if (value?.version !== 1 || !Array.isArray(value.contracts)) fail(`${label}: expected version 1 and contracts array`);
  const ids = new Set();
  for (const item of value.contracts) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(item.id) || ids.has(item.id)) {
      fail(`${label}: each contract needs a unique lowercase id (letters, digits, dots and hyphens)`);
    }
    ids.add(item.id);
    if (!['design', 'regression'].includes(item.kind)) fail(`${label}: ${item.id}: kind must be design or regression`);
    if (item.kind === 'regression' && (typeof item.failure !== 'string' || item.failure.trim() === '')) {
      fail(`${label}: ${item.id}: regression needs failure describing the observed trigger and failure`);
    }
    if (!Array.isArray(item.docs) || item.docs.length === 0 || !Array.isArray(item.tests) || item.tests.length === 0) {
      fail(`${label}: ${item.id}: docs and tests must both be non-empty arrays`);
    }
    for (const doc of item.docs) {
      if (!doc || !filePath(doc.path) || !doc.path.endsWith('.md')
          || typeof doc.heading !== 'string' || !/^#{1,6} \S.*$/.test(doc.heading) || /[\r\n]/.test(doc.heading)) {
        fail(`${label}: ${item.id}: docs need repository-relative Markdown paths and exact ATX heading lines`);
      }
    }
    if (item.tests.some(path => !filePath(path) || !TEST_FILE.test(path))) {
      fail(`${label}: ${item.id}: tests must be explicit test/**/*.test.ts or .test.mjs paths`);
    }
    if (new Set(item.tests).size !== item.tests.length
        || new Set(item.docs.map(doc => `${doc.path}\0${doc.heading}`)).size !== item.docs.length) {
      fail(`${label}: ${item.id}: duplicate association`);
    }
  }
  const reviews = value.reviews ?? {};
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) fail(`${label}: reviews must be an object`);
  for (const [id, review] of Object.entries(reviews)) {
    if (!review || !/^[a-f0-9]{64}$/.test(review.docs) || !/^[a-f0-9]{64}$/.test(review.tests)
        || typeof review.reason !== 'string' || review.reason.trim() === '') {
      fail(`${label}: ${id}: review needs docs/tests SHA-256 fingerprints and a non-empty reason`);
    }
  }
  return { ...value, reviews };
}

/** Headings inside fenced examples do not define a contract boundary. */
function headingsOf(text) {
  const lines = text.split('\n');
  const headings = [];
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6}) \S.*$/.exec(line);
    if (heading) headings.push({ line, index, level: heading[1].length });
  }
  return { lines, headings };
}

function sectionOf(text, heading, label, strict) {
  if (text === null) {
    if (strict) fail(`${label}: staged document does not exist`);
    return null;
  }
  const { lines, headings } = headingsOf(text);
  const found = headings.filter(item => item.line === heading);
  if (found.length > 1) fail(`${label}: ambiguous heading ${JSON.stringify(heading)}`);
  if (found.length === 0) {
    if (strict) fail(`${label}: staged heading not found: ${JSON.stringify(heading)}`);
    return null;
  }
  const start = found[0];
  const end = headings.find(item => item.index > start.index && item.level <= start.level)?.index ?? lines.length;
  return lines.slice(start.index, end).join('\n');
}

function fingerprint(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function associations(oldItem, newItem) {
  const docs = new Map();
  const tests = new Set();
  for (const item of [oldItem, newItem]) {
    for (const doc of item?.docs ?? []) docs.set(`${doc.path}\0${doc.heading}`, doc);
    for (const path of item?.tests ?? []) tests.add(path);
  }
  return {
    docs: [...docs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, doc]) => doc),
    tests: [...tests].sort(),
  };
}

function usage() {
  return 'Usage: node scripts/check-test-contracts.mjs [--staged | --all | --review ID --reason TEXT]';
}

function main() {
  const args = process.argv.slice(2);
  let reviewId;
  let reason;
  let all = false;
  if (args.length === 1 && args[0] === '--all') all = true;
  else if (args.length === 4 && args[0] === '--review' && args[2] === '--reason') {
    reviewId = args[1]; reason = args[3];
    if (reason.trim() === '') fail('Review reason must not be empty');
  } else if (args.length !== 0 && !(args.length === 1 && args[0] === '--staged')) fail(usage());

  process.chdir(requireGit(['rev-parse', '--show-toplevel']).trim());
  const hasHead = git(['rev-parse', '--verify', 'HEAD']).status === 0;
  const stagedFiles = new Set(requireGit(['ls-files', '--cached', '-z']).split('\0').filter(Boolean));
  const changes = new Set(requireGit(['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0').filter(Boolean));
  const cache = new Map();
  const read = (revision, path) => {
    const key = `${revision}:${path}`;
    if (cache.has(key)) return cache.get(key);
    let text = null;
    if (revision === 'index' && stagedFiles.has(path)) text = requireGit(['show', `:${path}`]);
    else if (revision === 'HEAD' && hasHead) {
      const result = git(['show', `HEAD:${path}`]);
      if (result.status === 0) text = result.stdout;
      else if (result.status !== 128) fail(result.stderr.trim() || `Cannot read HEAD:${path}`);
    }
    cache.set(key, text);
    return text;
  };
  const oldManifest = parseManifest(read('HEAD', MANIFEST), `HEAD:${MANIFEST}`);
  const newManifest = parseManifest(read('index', MANIFEST), `index:${MANIFEST}`);
  const oldItems = new Map(oldManifest.contracts.map(item => [item.id, item]));
  const newItems = new Map(newManifest.contracts.map(item => [item.id, item]));
  const ids = new Set([...oldItems.keys(), ...newItems.keys()]);

  // Every current association must resolve in the staged snapshot, even if a
  // document was deleted without updating its manifest entry.
  for (const item of newItems.values()) {
    for (const doc of item.docs) sectionOf(read('index', doc.path), doc.heading, `${item.id}: ${doc.path}`, true);
    for (const path of item.tests) if (read('index', path) === null) fail(`${item.id}: staged test does not exist: ${path}`);
  }

  const stateFor = id => {
    const links = associations(oldItems.get(id), newItems.get(id));
    const docs = revision => links.docs.map(doc => [doc.path, doc.heading,
      sectionOf(read(revision, doc.path), doc.heading, `${id}: ${doc.path}`, false)]);
    const tests = revision => links.tests.map(path => [path, read(revision, path)]);
    return {
      before: { docs: fingerprint(docs('HEAD')), tests: fingerprint(tests('HEAD')) },
      after: { docs: fingerprint(docs('index')), tests: fingerprint(tests('index')) },
    };
  };

  if (reviewId !== undefined) {
    if (!ids.has(reviewId)) fail(`Unknown contract: ${reviewId}`);
    const { after } = stateFor(reviewId);
    console.log(JSON.stringify({ [reviewId]: { ...after, reason } }, null, 2));
    return;
  }

  const errors = [];
  const mappedTests = new Set(newManifest.contracts.flatMap(item => item.tests));
  const oldMappedTests = new Set(oldManifest.contracts.flatMap(item => item.tests));
  const candidates = all ? new Set([...changes, ...stagedFiles]) : changes;
  for (const path of candidates) {
    if (!TEST_FILE.test(path)) continue;
    const removed = !stagedFiles.has(path);
    if (!mappedTests.has(path) && !(removed && oldMappedTests.has(path))) {
      errors.push(`${path}: test has no design or regression association in ${MANIFEST}`);
    }
  }

  let paired = 0;
  for (const id of ids) {
    const { before, after } = stateFor(id);
    const docChanged = before.docs !== after.docs;
    const testChanged = before.tests !== after.tests;
    if (!docChanged && !testChanged) continue;
    if (docChanged && testChanged) { paired++; continue; }
    const review = newManifest.reviews[id];
    if (review?.docs === after.docs && review?.tests === after.tests) continue;
    errors.push(`${id}: ${docChanged ? 'documented section' : 'behavioral test'} changed, but its ${docChanged ? 'tests did' : 'documented sections did'} not. Update the counterpart or explicitly review it:\n`
      + `  node scripts/check-test-contracts.mjs --review ${id} --reason '<why no counterpart change is needed>'\n`
      + `  Add the printed receipt to ${MANIFEST} reviews, then stage the manifest. Only staged content is checked.`);
  }
  if (errors.length) fail(`Test/document contract check failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  console.log(`Test/document contracts passed (${newItems.size} associations, ${paired} paired changes; ${all ? 'all indexed tests' : 'staged tests'} checked).`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
