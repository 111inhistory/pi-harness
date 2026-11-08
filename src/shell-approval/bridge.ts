import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type ShellCheck = (tool: string, command: unknown, context: ExtensionContext, source: string, waiting?: (pending: boolean) => void) => Promise<string | null>;
export const SHELL_APPROVAL_WAIT = 'pi-harness:shell-approval-wait';
const CHANNEL = 'pi-harness:shell-check';
interface Exchange { check?: ShellCheck }

/** Optional entrypoints share a loader bus; children consult their owning root at call time. */
export function publishShellCheck(api: ExtensionAPI, check: ShellCheck): void {
  api.events.on(CHANNEL, data => { (data as Exchange).check = check; });
}

export function installInheritedShellChecks(child: ExtensionAPI, parent: ExtensionAPI, source: string): void {
  child.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'powershell') return;
    const exchange: Exchange = {};
    parent.events.emit(CHANNEL, exchange);
    if (exchange.check === undefined) return;
    const reason = await exchange.check(event.toolName, event.input.command, ctx, source,
      pending => child.events.emit(SHELL_APPROVAL_WAIT, pending));
    return reason === null ? undefined : { block: true, reason };
  });
}
