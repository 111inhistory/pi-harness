import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface ShellLaunchPlan {
  readonly executable: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}
export type ShellCheck = (tool: string, command: unknown, context: ExtensionContext, source: string, waiting?: (pending: boolean) => void, signal?: AbortSignal, plan?: ShellLaunchPlan) => Promise<string | null>;
export const SHELL_APPROVAL_WAIT = 'pi-harness:shell-approval-wait';
const CHANNEL = 'pi-harness:shell-check';
interface Exchange { check?: ShellCheck }
const managedSchemas = new WeakSet<object>();

// Identify the actual registered definition, not just a tool name. An SDK or
// later extension replacement still needs the ordinary tool_call check.
export function markManagedShell<T extends object>(schema: T): T {
  managedSchemas.add(schema);
  return schema;
}

export function isManagedShell(api: ExtensionAPI, tool: string): boolean {
  const schema = api.getAllTools().find(candidate => candidate.name === tool)?.parameters;
  return schema !== undefined && managedSchemas.has(schema);
}

/** Optional entrypoints share a loader bus; children consult their owning root at call time. */
export function publishShellCheck(api: ExtensionAPI, check: ShellCheck): void {
  api.events.on(CHANNEL, data => { (data as Exchange).check = check; });
}

export function installInheritedShellChecks(child: ExtensionAPI, parent: ExtensionAPI, source: string): void {
  child.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'powershell') return;
    if (isManagedShell(child, event.toolName)) return;
    const exchange: Exchange = {};
    parent.events.emit(CHANNEL, exchange);
    if (exchange.check === undefined) return;
    const reason = await exchange.check(event.toolName, event.input.command, ctx, source,
      pending => child.events.emit(SHELL_APPROVAL_WAIT, pending));
    return reason === null ? undefined : { block: true, reason };
  });
}

export async function checkManagedShell(api: ExtensionAPI, tool: string, input: unknown, ctx: ExtensionContext, source: string, waiting: ExtensionAPI['events'], signal: AbortSignal | undefined, plan?: ShellLaunchPlan): Promise<void> {
  const exchange: Exchange = {};
  api.events.emit(CHANNEL, exchange);
  const reason = await exchange.check?.(tool, input, ctx, source,
    pending => waiting.emit(SHELL_APPROVAL_WAIT, pending), signal, plan);
  if (reason) throw new Error(reason);
}
