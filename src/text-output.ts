/**
 * Opt-in text clipping shared by long text results and bounded log previews.
 *
 * A clip applies a line limit and a UTF-8 byte limit; whichever is reached first
 * decides how much is kept. Line truncation reuses Pi's public `truncateHead` /
 * `truncateTail` so line accounting and byte boundaries stay consistent with the
 * native shell and read tools. The omission note between retained ends is this
 * module's own format; limits apply only to the retained payload.
 */

import { open } from 'node:fs/promises';
import { truncateHead, truncateTail } from '@earendil-works/pi-coding-agent';

/** Line and UTF-8 byte limits; the first one reached stops the clip. */
export interface TextClipLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
}

export type TextClipKeep = 'head' | 'tail' | 'head-tail';

export interface TextClip {
  /** Kept text; `head-tail` embeds the omission note. Cuts never split a UTF-8 sequence. */
  readonly text: string;
  readonly truncated: boolean;
}

export interface TailRead {
  /** The bounded tail, never cut inside a UTF-8 sequence. */
  readonly text: string;
  readonly truncated: boolean;
  /** Complete file size; not the number of bytes read. */
  readonly totalBytes: number;
}

function limitsOf(limits: TextClipLimits): TextClipLimits {
  const valid = Number.isSafeInteger(limits.maxLines) && limits.maxLines > 0
    && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0;
  if (!valid) throw new RangeError('Text clip limits must be positive integers.');
  return limits;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Advance to the first leading byte at or after `from`. */
function alignUtf8Forward(bytes: Buffer, from: number): number {
  let at = Math.max(0, from);
  while (at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at += 1;
  return at;
}

/** Keep at most `maxBytes` from the start, without splitting a UTF-8 sequence. */
export function sliceUtf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** Keep at most `maxBytes` from the end, without splitting a UTF-8 sequence. */
function sliceUtf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(alignUtf8Forward(bytes, bytes.length - maxBytes)).toString('utf8');
}

/**
 * Clip one plain-text value. `head` keeps the first lines, `tail` the last lines,
 * and `head-tail` keeps both ends with the omitted source line range in between.
 */
export function clipText(text: string, limits: TextClipLimits, keep: TextClipKeep): TextClip {
  const { maxLines, maxBytes } = limitsOf(limits);
  const totalLines = lineCount(text);
  if (totalLines <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  if (keep === 'head') return { text: truncateHead(text, { maxLines, maxBytes }).content, truncated: true };
  if (keep === 'tail') return { text: truncateTail(text, { maxLines, maxBytes }).content, truncated: true };
  return { text: clipBothEnds(text, { maxLines, maxBytes }, totalLines), truncated: true };
}

function note(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `... [omitted line ${startLine}] ...`
    : `... [omitted lines ${startLine}-${endLine}] ...`;
}

function tailOnly(text: string, limits: TextClipLimits, totalLines: number): string {
  const tail = truncateTail(text, limits);
  const firstLine = Math.max(1, totalLines - tail.outputLines + 1);
  const parts = [firstLine <= 1 ? '' : note(1, firstLine - 1), tail.content];
  return parts.filter((part) => part !== '').join('\n');
}

function clipBothEnds(text: string, limits: TextClipLimits, totalLines: number): string {
  // A line larger than the whole byte budget cannot be represented by Pi's
  // head helper (it refuses partial lines). Keep both byte ends of that line.
  if (totalLines === 1) {
    const headBytes = limits.maxBytes > 1 ? Math.floor(limits.maxBytes / 2) : 0;
    const headText = headBytes > 0 ? sliceUtf8Head(text, headBytes) : '';
    const tailText = sliceUtf8Tail(text, limits.maxBytes - headBytes);
    const omission = headText === ''
      ? (tailText === '' ? '... [omitted line 1] ...' : '... [omitted start of line 1] ...')
      : tailText === '' ? '... [omitted end of line 1] ...' : '... [omitted middle of line 1] ...';
    return [headText, omission, tailText].filter((part) => part !== '').join('\n');
  }

  // At one line or one byte there is no second payload slot. Keep the tail,
  // which carries the final diagnostics, and report the omitted head lines.
  if (limits.maxLines < 2 || limits.maxBytes < 2) return tailOnly(text, limits, totalLines);

  // Allocate the first share to the head, then give the tail every remaining
  // byte and line. The retained payload never exceeds either total limit.
  const head = truncateHead(text, {
    maxLines: Math.max(1, Math.floor(limits.maxLines / 2)),
    maxBytes: Math.max(1, Math.floor(limits.maxBytes / 2)),
  });
  const remainingLines = limits.maxLines - head.outputLines;
  const remainingBytes = limits.maxBytes - head.outputBytes;
  if (remainingLines <= 0 || remainingBytes <= 0) return head.content;
  const tail = truncateTail(text, { maxLines: remainingLines, maxBytes: remainingBytes });
  const startLine = head.outputLines + 1;
  const endLine = totalLines - tail.outputLines;
  const parts = [head.content, startLine <= endLine ? note(startLine, endLine) : '', tail.content];
  return parts.filter((part) => part !== '').join('\n');
}

/**
 * Read only the tail of a text file, never the complete log.
 *
 * The read window is bounded by `maxBytes` and clipped to `maxLines`. A window
 * starting mid-line drops that partial line when complete lines follow it; an
 * oversized final line is kept as the partial tail. Callers that poll a growing
 * log are responsible for serializing their own reads.
 */
export async function readTailFile(
  filePath: string,
  limits: TextClipLimits,
  signal?: AbortSignal,
): Promise<TailRead> {
  const { maxLines, maxBytes } = limitsOf(limits);
  signal?.throwIfAborted();
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    signal?.throwIfAborted();
    if (size === 0) return { text: '', truncated: false, totalBytes: 0 };

    const windowStart = Math.max(0, size - maxBytes);
    // Read one preceding byte to tell whether the window starts on a line boundary.
    const readStart = windowStart > 0 ? windowStart - 1 : 0;
    const buffer = Buffer.allocUnsafe(size - readStart);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, readStart + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      signal?.throwIfAborted();
    }
    const bytes = buffer.subarray(0, filled);

    let raw: string;
    let byteTruncated = false;
    if (windowStart === 0) {
      raw = bytes.toString('utf8');
    } else if (bytes[0] === 0x0a) {
      // The byte before the window terminates the previous line: the whole window is content.
      byteTruncated = true;
      raw = bytes.subarray(1).toString('utf8');
    } else {
      byteTruncated = true;
      const newline = bytes.indexOf(0x0a, 1);
      if (newline < 0) {
        // One line fills the whole window: decode from the next sequence boundary.
        raw = bytes.subarray(alignUtf8Forward(bytes, 1)).toString('utf8');
      } else if (newline === bytes.length - 1) {
        // The only newline ends the oversized line; keep the partial line itself.
        raw = bytes.subarray(alignUtf8Forward(bytes, 1), newline).toString('utf8');
      } else {
        // Complete lines follow the partial first line, which is outside the budget.
        raw = bytes.subarray(newline + 1).toString('utf8');
      }
    }

    const clipped = clipText(raw, { maxLines, maxBytes }, 'tail');
    return { text: clipped.text, truncated: byteTruncated || clipped.truncated, totalBytes: size };
  } finally {
    await handle.close();
  }
}
