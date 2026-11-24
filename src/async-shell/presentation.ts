import type { ShellResult } from './protocol.ts';

export type ShellPresentation = {
  readonly summary?: string | undefined;
  readonly message?: string | undefined;
  readonly output: string;
  readonly footer?: string | undefined;
  readonly terminal?: boolean;
  readonly foreground?: boolean;
};

export function shellText(view: ShellPresentation): string {
  return (view.foreground ? [view.message, view.output, view.footer, view.summary]
    : [view.summary, view.message, view.output, view.footer]).filter(Boolean).join('\n\n');
}

const lineRange = (first: number, last: number): string => first === last ? String(first) : `${first}-${last}`;

export function describeShellResult(
  result: ShellResult,
  delivery: 'foreground' | 'background' | 'terminal',
  wait?: { readonly milliseconds: number; readonly timeout?: number },
): ShellPresentation {
  const { id, status, exitCode, logPath, message, truncated, window } = result;
  let output = result.output;
  const terminal = status !== 'running';
  let summary: string | undefined;
  if (delivery === 'foreground') {
    if (status === 'failed' && exitCode !== null) summary = `Command exited with code ${exitCode}`;
    else if (status !== 'completed') summary = `Command ${status.replaceAll('_', ' ')}.`;
  } else if (terminal) {
    summary = `Job ${id} ${status.replaceAll('_', ' ')}${exitCode === null ? '' : ` (exit code ${exitCode})`}.`;
  } else if (delivery === 'terminal') {
    summary = `Job ${id} is still running.`;
  } else if (wait === undefined) {
    summary = `Job ${id} started in the background.`;
  } else {
    summary = `Job ${id} backgrounded after ${wait.milliseconds / 1000}s wait.`;
    summary += wait.timeout === undefined
      ? '\nSet timeout to limit runtime, or use background: true to return immediately.'
      : ` The original ${wait.timeout}s timeout still applies.\nUse background: true to return immediately instead of waiting on a long timeout.`;
  }
  let footer = truncated ? `[Output truncated. Full output: ${logPath}]`
    : delivery !== 'foreground' || status === 'internal_error' ? `Output log: ${logPath}` : undefined;
  if (truncated && window) {
    const { firstLine, headLines, headBytes, tailFirstLine, totalLines } = window;
    if (delivery === 'foreground') {
      footer = `[Showing ${firstLine === totalLines ? `the end of line ${totalLines}` : `lines ${lineRange(firstLine, totalLines)} of ${totalLines}`}. Full output: ${logPath}]`;
    } else if (headBytes > 0) {
      const bytes = Buffer.from(output);
      const head = bytes.subarray(0, headBytes).toString('utf8');
      const tail = bytes.subarray(headBytes).toString('utf8');
      const headLast = firstLine + headLines - 1;
      const omitted = tailFirstLine > headLast + 1
        ? `omitted lines ${lineRange(headLast + 1, tailFirstLine - 1)}` : 'omitted output';
      output = `${head.endsWith('\n') ? head : `${head}\n`}... [${omitted}] ...\n${tail}`;
      const shown = headLast >= tailFirstLine ? `parts of ${firstLine === totalLines ? `line ${totalLines}` : `lines ${lineRange(firstLine, totalLines)}`}`
        : `lines ${lineRange(firstLine, headLast)} and ${lineRange(tailFirstLine, totalLines)} of ${totalLines}`;
      footer = `[Output truncated: showing ${shown}. Use read on ${logPath} from line ${headLast} (omitted output)${terminal ? '' : ` or line ${totalLines} (further output)`}.]`;
    }
  }
  return { summary, message, output: output || (terminal ? '(no output)' : ''), footer, terminal, foreground: delivery === 'foreground' };
}
