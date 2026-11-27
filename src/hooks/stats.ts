import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MAX_RULE_ROWS = 64;
const HOOK_OUTCOMES = ['matched', 'committed', 'observed', 'suppressed', 'timeout', 'stale', 'failed'] as const;
const TOOL_CATEGORIES = ['shell', 'file', 'search', 'codemode', 'mcp', 'other'] as const;
const CLASSIFIER_OUTCOMES = ['not_in_catalog', 'answered', 'unavailable', 'transient', 'failed', 'aborted'] as const;
export type HookOutcome = typeof HOOK_OUTCOMES[number];
export type ToolCategory = typeof TOOL_CATEGORIES[number];
export type ClassifierOutcome = typeof CLASSIFIER_OUTCOMES[number];

export type HookStat =
  | { readonly type: 'hook'; readonly id: string; readonly outcome: HookOutcome }
  | { readonly type: 'tool'; readonly category: ToolCategory; readonly failed: boolean; readonly nested: boolean; readonly truncated?: boolean }
  | { readonly type: 'classifier-start' }
  | { readonly type: 'classifier-result'; readonly outcome: ClassifierOutcome; readonly durationMs: number;
      readonly inputTokens?: number; readonly outputTokens?: number };

export type HookStatSink = (event: HookStat) => void;
export type HookStatsBinding = () => HookStatSink | undefined;

/** The optional observer is outside the action and repeat commit paths. */
export function emitHookStat(sink: HookStatSink | undefined, event: HookStat): void {
  try { sink?.(event); } catch { /* A metric must not fail an action. */ }
}

export function toolCategory(name: string): ToolCategory {
  if (name === 'bash' || name === 'powershell') return 'shell';
  if (name === 'read' || name === 'write' || name === 'edit') return 'file';
  if (name === 'grep' || name === 'find' || name === 'ls') return 'search';
  if (name === 'codemode') return 'codemode';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function counter<const Key extends string>(keys: readonly Key[]): Record<Key, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<Key, number>;
}

function safeCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
}

function createSessionStats() {
  const rules = new Map<string, ReturnType<typeof counter<HookOutcome>>>();
  const otherRules = counter(HOOK_OUTCOMES);
  const toolRow = () => ({ calls: 0, failures: 0, nested: 0, truncated: 0 });
  const tools = new Map(TOOL_CATEGORIES.map(category => [category, toolRow()]));
  const classifier = { attempts: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, outcomes: counter(CLASSIFIER_OUTCOMES) };

  function record(event: HookStat): void {
    switch (event.type) {
      case 'hook': {
        let row = rules.get(event.id);
        if (row === undefined && rules.size < MAX_RULE_ROWS && /^[a-z][a-z0-9-]{0,63}$/.test(event.id)) {
          row = counter(HOOK_OUTCOMES);
          rules.set(event.id, row);
        }
        (row ?? otherRules)[event.outcome] += 1;
        break;
      }
      case 'tool': {
        const row = tools.get(event.category)!;
        row.calls += 1;
        row.failures += Number(event.failed);
        row.nested += Number(event.nested);
        row.truncated += Number(event.truncated === true);
        break;
      }
      case 'classifier-start': classifier.attempts += 1; break;
      case 'classifier-result':
        classifier.outcomes[event.outcome] += 1;
        classifier.durationMs += safeCount(event.durationMs);
        classifier.inputTokens += safeCount(event.inputTokens);
        classifier.outputTokens += safeCount(event.outputTokens);
        break;
    }
  }

  function render(): string {
    const fields = (row: Record<string, number>) => Object.entries(row).filter(([, value]) => value > 0).map(([key, value]) => `${key}=${value}`).join(' ');
    const lines = ['Hook Stats (current session)'];
    if (classifier.attempts || Object.values(classifier.outcomes).some(Boolean)) {
      lines.push(`Classifier: calls=${classifier.attempts}, ${Math.round(classifier.durationMs)} ms, tokens=${classifier.inputTokens} in / ${classifier.outputTokens} out`);
      const results = fields(classifier.outcomes);
      if (results) lines.push(`  ${results}`);
    }
    for (const [category, row] of tools) if (row.calls) lines.push(`Tools ${category}: ${fields(row)}`);
    for (const [id, row] of [...rules].sort(([a], [b]) => a.localeCompare(b))) lines.push(`Hook ${id}: ${fields(row)}`);
    if (Object.values(otherRules).some(Boolean)) lines.push(`Other Hook IDs: ${fields(otherRules)}`);
    if (lines.length === 1) lines.push('No tool or Hook observations yet.');
    return lines.join('\n');
  }
  return { record, render };
}

/** Captured sinks are fenced by session identity; stale completions cannot write to a new session. */
export function installHookStats(pi: ExtensionAPI): HookStatsBinding {
  let session: ReturnType<typeof createSessionStats> | undefined;
  let epoch = 0;
  pi.on('session_start', () => { epoch += 1; session = createSessionStats(); });
  pi.on('session_shutdown', () => { epoch += 1; session = undefined; });
  pi.registerCommand('hook-stats', {
    description: 'Show local Hook and tool statistics for this session',
    handler: async (_args, ctx) => { ctx.ui.notify(session?.render() ?? 'Hook Stats are unavailable for this session.', 'info'); },
  });
  return () => {
    if (session === undefined) return undefined;
    const expectedEpoch = epoch;
    return event => { if (epoch === expectedEpoch) session?.record(event); };
  };
}
