import { truncateHead } from '@earendil-works/pi-coding-agent';

/** The notification contains only this Job's final output, with read-sized limits. */
export function terminalResultContent(result: unknown, fullPath: string | null): string {
  if (typeof result !== 'string') return '';
  const preview = truncateHead(result);
  if (!preview.truncated) return result;
  const location = fullPath === null ? 'Full result file unavailable.' : `Full result: ${fullPath}`;
  const marker = `[Result truncated: showing ${preview.outputLines} of ${preview.totalLines} lines, ${preview.outputBytes} of ${preview.totalBytes} bytes. ${location}]`;
  return preview.content === '' ? marker : `${preview.content}\n\n${marker}`;
}

export function resultNeedsFile(result: string): boolean {
  return truncateHead(result).truncated;
}
