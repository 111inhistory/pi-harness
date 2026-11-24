import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipText, readTailFile } from '../../src/text-output.ts';

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

test('clipText keeps text within both limits untouched, including its trailing newline', () => {
  const text = 'first\nsecond\n';
  assert.deepEqual(clipText(text, { maxLines: 2, maxBytes: 100 }, 'head-tail'), { text, truncated: false });
  assert.deepEqual(clipText('', { maxLines: 1, maxBytes: 1 }, 'tail'), { text: '', truncated: false });
});

test('clipText head and tail report the kept and omitted source lines', () => {
  const text = lines(10);
  assert.deepEqual(clipText(text, { maxLines: 3, maxBytes: 10_000 }, 'head'), {
    text: 'line 1\nline 2\nline 3', truncated: true,
  });
  assert.deepEqual(clipText(text, { maxLines: 3, maxBytes: 10_000 }, 'tail'), {
    text: 'line 8\nline 9\nline 10', truncated: true,
  });
});

test('clipText head-tail keeps both ends and marks the omitted source range', () => {
  const clipped = clipText(lines(10), { maxLines: 4, maxBytes: 10_000 }, 'head-tail');
  assert.equal(clipped.text, 'line 1\nline 2\n... [omitted lines 3-8] ...\nline 9\nline 10');
  assert.equal(clipped.truncated, true);
});

test('clipText applies the byte limit before the line limit and never splits a UTF-8 sequence', () => {
  const text = Array.from({ length: 40 }, (_, index) => `${index}:${'x'.repeat(98)}`).join('\n');
  const clipped = clipText(text, { maxLines: 2_000, maxBytes: 1_000 }, 'head-tail');
  assert.equal(clipped.truncated, true);
  assert.doesNotMatch(clipped.text, /\uFFFD/);
  const [head, tail] = clipped.text.split('\n... [omitted lines ');
  const tailText = tail!.slice(tail!.indexOf('] ...\n') + 6);
  assert.ok(Buffer.byteLength(`${head}${tailText}`, 'utf8') <= 1_000, 'payload stays within the byte budget');
  assert.match(head!, /^0:/);
  assert.match(tailText, /39:/);
});

test('clipText keeps both byte ends of one oversized line', () => {
  const text = '😀'.repeat(10);
  const clipped = clipText(text, { maxLines: 2_000, maxBytes: 9 }, 'head-tail');
  assert.equal(clipped.text, '😀\n... [omitted middle of line 1] ...\n😀');
  assert.doesNotMatch(clipped.text, /\uFFFD/);
});

test('clipText keeps tiny limits to one payload slot', () => {
  const clipped = clipText(lines(5), { maxLines: 1, maxBytes: 1 }, 'head-tail');
  assert.equal(clipped.text, '... [omitted lines 1-4] ...\n5');

  const line = clipText(lines(5), { maxLines: 1, maxBytes: 10_000 }, 'head-tail');
  assert.equal(line.text, '... [omitted lines 1-4] ...\nline 5');
  assert.equal(line.text.split('\n').filter((part) => !part.startsWith('... [omitted')).length, 1);

  const rune = clipText('😀', { maxLines: 1, maxBytes: 1 }, 'head-tail');
  assert.equal(rune.text, '... [omitted line 1] ...');
  assert.doesNotMatch(rune.text, /\uFFFD/);
});

test('clipText reports the tail start when the head keeps no lines', () => {
  const text = `${'x'.repeat(100)}\nshort 1\nshort 2\nshort 3\nshort 4`;
  const clipped = clipText(text, { maxLines: 100, maxBytes: 40 }, 'head-tail');
  assert.match(clipped.text, /^\.\.\. \[omitted line 1\] \.\.\.\nshort 1/);
  assert.doesNotMatch(clipped.text, /x{100}/);
});

test('readTailFile returns the bounded tail of a file larger than the line budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-text-output-'));
  const file = path.join(root, 'output.log');
  const text = `${lines(3_000)}\n`;
  await writeFile(file, text);
  const read = await readTailFile(file, { maxLines: 2_000, maxBytes: 50 * 1024 });
  assert.equal(read.truncated, true);
  assert.equal(read.totalBytes, Buffer.byteLength(text));
  assert.match(read.text, /^line 1001\n/);
  assert.match(read.text, /\nline 3000$/);
  assert.equal(read.text.split('\n').length, 2_000);
});

test('readTailFile starts on a line boundary and never returns a half rune', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-text-output-'));
  const file = path.join(root, 'output.log');
  await writeFile(file, 'alpha\nbeta\ngamma\n');
  const boundary = await readTailFile(file, { maxLines: 2_000, maxBytes: 6 });
  assert.equal(boundary.text, 'gamma\n');
  assert.equal(boundary.truncated, true);

  const partial = await readTailFile(file, { maxLines: 2_000, maxBytes: 8 });
  assert.equal(partial.text, 'gamma\n');
  assert.equal(partial.truncated, true);

  const oversized = path.join(root, 'oversized.log');
  await writeFile(oversized, `${'x'.repeat(100)}\n`);
  const kept = await readTailFile(oversized, { maxLines: 2_000, maxBytes: 10 });
  assert.equal(kept.text, 'x'.repeat(9), 'an oversized final line stays visible instead of becoming empty');
  assert.equal(kept.truncated, true);

  const runes = path.join(root, 'runes.log');
  await writeFile(runes, '😀'.repeat(1_000));
  for (const maxBytes of [998, 999, 1_000]) {
    const read = await readTailFile(runes, { maxLines: 2_000, maxBytes });
    assert.doesNotMatch(read.text, /\uFFFD/, `byte window ${maxBytes} split a rune`);
    assert.ok(Buffer.byteLength(read.text, 'utf8') <= maxBytes);
    assert.match(read.text, /^(?:😀)+$/u);
  }
});

test('readTailFile reads an empty file without opening a window', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-text-output-'));
  const file = path.join(root, 'empty.log');
  await writeFile(file, '');
  assert.deepEqual(await readTailFile(file, { maxLines: 10, maxBytes: 10 }), {
    text: '', truncated: false, totalBytes: 0,
  });
});

test('clipText rejects non-positive or fractional limits', () => {
  assert.throws(() => clipText('x', { maxLines: 0, maxBytes: 1 }, 'tail'), RangeError);
  assert.throws(() => clipText('x', { maxLines: 1, maxBytes: 1.5 }, 'tail'), RangeError);
});
