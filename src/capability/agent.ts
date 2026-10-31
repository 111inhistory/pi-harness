/** Internal Capability session: batch search, cumulative selection and bounded progress. */
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createJobBudget } from '../subagent/job-budget.ts';
import { promptString, promptText } from '../prompt-text.ts';
import { watchCapabilityBudget } from '../subagent/budget-watch.ts';
import type { BudgetTerminalView } from '../subagent/budget-watch.ts';
import type { CapabilitySearchHit, CapabilitySearchResult } from './broker.ts';
import type { CapabilitySearchCoverage } from './discovery-record.ts';
import { CAPABILITY_STEP_PARAMETERS, CAPABILITY_STEP_TOOL_NAME } from './contracts.ts';

export const CAPABILITY_DISCOVERY_BUDGET = Object.freeze({
  modelCalls: Object.freeze({ soft: 16, hard: 20 }),
  activeTimeMs: Object.freeze({ soft: 180_000, hard: 360_000 }),
  lifetimeMs: 600_000,
});
export const CAPABILITY_NO_SELECTION_LIMIT = 3;
// The first call must search before it can select; allow one extra empty step.
const EMPTY_STEP_LIMIT = CAPABILITY_NO_SELECTION_LIMIT + 1;
const MISSING_QUERIES = 5;
export const CAPABILITY_DISCOVERY_SYSTEM_PROMPT = promptString('capability-discovery.json', 'system');
export const CAPABILITY_DISCOVERY_PROMPT = promptString('capability-discovery.json', 'user');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assetField(file: string, section: string, field: string): string {
  const parsed: unknown = JSON.parse(promptText(file));
  const group = object(parsed) ? parsed[section] : undefined;
  const value = object(group) ? group[field] : undefined;
  if (typeof value !== 'string') throw new TypeError(`${file} must define string ${section}.${field}.`);
  return value;
}
const stepDescription = assetField('capability-tools.json', 'step', 'description');
const stepLabel = assetField('capability-tools.json', 'step', 'label');
const budgetWrapUp = promptString('capability-policy.json', 'budgetWrapUp');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type CapabilityEndReason = 'finished' | 'no_selection_limit' | 'budget' | 'cancelled' | 'provider_error' | 'incomplete';
export interface CapabilityDiscoveryResult extends CapabilitySearchResult {
  coverage: CapabilitySearchCoverage;
  endReason?: CapabilityEndReason;
}
export interface CapabilityBrokerPort {
  search(input: { query: string; src: 'local'; cwd: string; signal?: AbortSignal }): CapabilitySearchResult | Promise<CapabilitySearchResult>;
}
export interface CapabilityStepDetails {
  selection: { accepted: string[]; alreadySelected: string[]; rejected: string[] };
  searches: Array<CapabilitySearchResult & { query: string }>;
  noSelectionCount: number;
  noSelectionLimit: number;
  endReason: CapabilityEndReason | null;
  error?: string;
}
/**
 * One model-facing search candidate. Ranking, availability and the full
 * namespace body stay in `CapabilityStepDetails`, which keeps every original
 * member selectable.
 */
export interface CapabilityStepCandidate {
  ref: string;
  name: string;
  description: string;
  kind: CapabilitySearchHit['kind'];
  /** Skill entry path; reading the body is a separate native `read`. */
  filePath?: string;
  toolCount?: number;
}
/** One model-facing search: candidates seen for the first time, then refs. */
export interface CapabilityStepSearchFeedback {
  query: string;
  status: CapabilitySearchResult['status'];
  tools: CapabilityStepCandidate[];
  mcp: CapabilityStepCandidate[];
  skills: CapabilityStepCandidate[];
  /** Ref-only repeats of candidates already returned earlier in this run. */
  repeatedRefs: string[];
  missingCapabilities: string[];
  warnings: string[];
}
/** The serialized `capability_step` content; diagnostic `details` differ. */
export interface CapabilityStepFeedback {
  selection: CapabilityStepDetails['selection'];
  searches: CapabilityStepSearchFeedback[];
  noSelectionCount: number;
  noSelectionLimit: number;
  endReason: CapabilityEndReason | null;
  error?: string;
}
export type CapabilityStepTool = ToolDefinition<typeof CAPABILITY_STEP_PARAMETERS, CapabilityStepDetails>;
export type CapabilityBudget = ReturnType<typeof createJobBudget>;
export interface CapabilityRunSession {
  prompt(text: string): Promise<readonly unknown[]>;
  abort(): void | Promise<unknown>;
  dispose(): void | Promise<unknown>;
}
export interface CapabilityOpenSessionRequest {
  instructions: string;
  customTools: CapabilityStepTool[];
  budget: CapabilityBudget;
  beforeRequest: () => { stop: true; reason: string } | undefined;
  signal: AbortSignal | undefined;
}
export interface CapabilityDiscoveryDependencies {
  broker: CapabilityBrokerPort;
  openSession(request: CapabilityOpenSessionRequest): CapabilityRunSession | Promise<CapabilityRunSession>;
}
interface Run {
  broker: CapabilityBrokerPort;
  cwd: string;
  signal: AbortSignal | undefined;
  hits: Map<string, { group: 'tools' | 'mcp' | 'skills'; hit: CapabilitySearchHit }>;
  selected: Set<string>;
  warnings: string[];
  emptyQueries: string[];
  completedSearches: number;
  noSelectionCount: number;
  end: { reason: CapabilityEndReason; message: string } | null;
  session: CapabilityRunSession | null;
}

export function capabilityCoverage(run?: { completedSearches: number }): CapabilitySearchCoverage {
  return { local: (run?.completedSearches ?? 0) > 0 ? 'searched' : 'not_searched', remote: 'not_searched' };
}
export function capabilityFailureResult(message: string, warnings: readonly string[] = [],
  coverage: CapabilitySearchCoverage = { local: 'not_searched', remote: 'not_searched' }): CapabilityDiscoveryResult {
  return { status: 'failed', tools: [], mcp: [], skills: [], remote: [], coverage: { ...coverage }, missingCapabilities: [], warnings: [...warnings, message] };
}
export function providerErrorDetail(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value: unknown = messages[index];
    if (!object(value) || value['role'] !== 'assistant') continue;
    if (value['stopReason'] !== 'error') return null;
    return typeof value['errorMessage'] === 'string' && value['errorMessage'] !== '' ? value['errorMessage'] : 'the provider reported an error';
  }
  return null;
}
export function capabilityBudgetWarning(warning: string): string {
  return `${warning}\n\n${budgetWrapUp}`;
}
function addWarnings(run: Run, warnings: readonly string[]): void {
  for (const text of warnings) if (!run.warnings.includes(text)) run.warnings.push(text);
}
function abortSession(run: Run): void {
  try { void Promise.resolve(run.session?.abort()).catch(() => {}); } catch { /* Abort does not replace the result. */ }
}
function stop(run: Run, reason: CapabilityEndReason, message: string): void {
  run.end ??= { reason, message };
}
function budgetMessage(terminal: BudgetTerminalView): string {
  return terminal.error?.code === 'job_expired' ? 'Capability discovery time limit expired.' : 'Capability discovery budget was exhausted.';
}
/** Keep every original candidate for selection; `fresh` marks this run's first sighting. */
function recordHits(run: Run, result: CapabilitySearchResult): { total: number; fresh: Set<string> } {
  const fresh = new Set<string>();
  let total = 0;
  for (const group of ['tools', 'mcp', 'skills'] as const) {
    for (const hit of result[group]) {
      total += 1;
      if (!run.hits.has(hit.ref)) fresh.add(hit.ref);
      run.hits.set(hit.ref, { group, hit: structuredClone(hit) });
    }
  }
  return { total, fresh };
}
function compactCandidate(hit: CapabilitySearchHit): CapabilityStepCandidate {
  return { ref: hit.ref, name: hit.name, description: hit.description, kind: hit.kind,
    ...(hit.filePath === undefined ? {} : { filePath: hit.filePath }),
    ...(hit.toolCount === undefined ? {} : { toolCount: hit.toolCount }) };
}
function compactSearch(result: CapabilitySearchResult & { query: string }, fresh: ReadonlySet<string>): CapabilityStepSearchFeedback {
  const feedback: CapabilityStepSearchFeedback = { query: result.query, status: result.status, tools: [], mcp: [], skills: [],
    repeatedRefs: [], missingCapabilities: [...result.missingCapabilities], warnings: [...result.warnings] };
  for (const group of ['tools', 'mcp', 'skills'] as const) {
    for (const hit of result[group]) {
      if (fresh.has(hit.ref)) feedback[group].push(compactCandidate(hit));
      else feedback.repeatedRefs.push(hit.ref);
    }
  }
  return feedback;
}
interface StepSearches {
  details: CapabilityStepDetails['searches'];
  content: CapabilityStepSearchFeedback[];
}
function noSearches(): StepSearches {
  return { details: [], content: [] };
}
function emptySelection(): CapabilityStepDetails['selection'] {
  return { accepted: [], alreadySelected: [], rejected: [] };
}
function stepFields(run: Run, selection: CapabilityStepDetails['selection'], error?: string): Omit<CapabilityStepDetails, 'searches'> {
  return { selection, noSelectionCount: run.noSelectionCount, noSelectionLimit: CAPABILITY_NO_SELECTION_LIMIT,
    endReason: run.end?.reason ?? null, ...(error === undefined ? {} : { error }) };
}
function feedback(run: Run, selection: CapabilityStepDetails['selection'], searches: StepSearches = noSearches(), error?: string): AgentToolResult<CapabilityStepDetails> {
  const details: CapabilityStepDetails = { ...stepFields(run, selection, error), searches: searches.details };
  const content: CapabilityStepFeedback = { ...stepFields(run, selection, error), searches: searches.content };
  return { content: [{ type: 'text', text: JSON.stringify(content) }], details,
    ...(error === undefined ? {} : { isError: true }), ...(run.end === null ? {} : { terminate: true }) };
}
function countSelection(run: Run, count: number): void {
  if (count === 0) run.noSelectionCount += 1;
}
function reachedLimit(run: Run): boolean {
  if (run.noSelectionCount < EMPTY_STEP_LIMIT) return false;
  stop(run, 'no_selection_limit', 'Capability discovery reached its zero-selection limit.');
  return true;
}
function rejectedStep(run: Run, selection: CapabilityStepDetails['selection'], error: string): AgentToolResult<CapabilityStepDetails> {
  countSelection(run, 0);
  reachedLimit(run);
  return feedback(run, selection, noSearches(), error);
}
function stepTool(run: Run): CapabilityStepTool {
  return {
    name: CAPABILITY_STEP_TOOL_NAME, label: stepLabel, description: stepDescription,
    parameters: CAPABILITY_STEP_PARAMETERS, executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (run.end !== null) return feedback(run, emptySelection(), noSearches(), 'This discovery run has ended.');
      if (run.signal?.aborted || signal?.aborted) {
        stop(run, 'cancelled', 'Capability discovery was cancelled.');
        return feedback(run, emptySelection(), noSearches(), run.end!.message);
      }
      const queries = (params.queries ?? []).map(query => query.trim());
      const refs = [...new Set((params.refs ?? []).map(ref => ref.trim()).filter(Boolean))];
      const finish = params.finish === true;
      const selection = emptySelection();
      if ((finish && queries.length > 0) || queries.some(query => query === '')) {
        return rejectedStep(run, selection, 'Queries must contain text and must be omitted or empty when finishing.');
      }
      selection.rejected = refs.filter(ref => !run.hits.has(ref));
      if (selection.rejected.length > 0) {
        return rejectedStep(run, selection, `Unknown refs: ${selection.rejected.join(', ')}. This submission was not accepted.`);
      }
      if (finish && refs.length === 0 && run.selected.size === 0 && run.completedSearches === 0) {
        return rejectedStep(run, selection, 'An empty finish requires a completed local search.');
      }
      for (const ref of refs) {
        if (run.selected.has(ref)) selection.alreadySelected.push(ref);
        else { run.selected.add(ref); selection.accepted.push(ref); }
      }
      countSelection(run, selection.accepted.length);
      // An explicit valid finish keeps the existing normal empty-submission semantics.
      if (finish) {
        stop(run, 'finished', 'Capability discovery finished.');
        return feedback(run, selection);
      }
      if (reachedLimit(run) || queries.length === 0) return feedback(run, selection);
      const searchSignal = signal ?? run.signal;
      const outcomes = await Promise.allSettled(queries.map(query => Promise.resolve().then(() => run.broker.search({ query, src: 'local', cwd: run.cwd,
        ...(searchSignal === undefined ? {} : { signal: searchSignal }) }))));
      const searches = noSearches();
      for (const [index, outcome] of outcomes.entries()) {
        const query = queries[index]!;
        const result: CapabilitySearchResult = outcome.status === 'fulfilled' ? outcome.value
          : { status: 'failed', tools: [], mcp: [], skills: [], remote: [], missingCapabilities: [], warnings: [`Search ${JSON.stringify(query)} failed: ${errorMessage(outcome.reason)}`] };
        const entry = { ...result, query };
        searches.details.push(entry);
        addWarnings(run, result.warnings);
        if (result.status === 'failed') {
          searches.content.push({ query, status: result.status, tools: [], mcp: [], skills: [], repeatedRefs: [],
            missingCapabilities: [...result.missingCapabilities], warnings: [...result.warnings] });
          continue;
        }
        run.completedSearches += 1;
        const recorded = recordHits(run, result);
        if (recorded.total === 0 && !run.emptyQueries.includes(query)) run.emptyQueries.push(query);
        searches.content.push(compactSearch(entry, recorded.fresh));
      }
      // Completed queries still count as searched when another query cancels the batch.
      if (run.signal?.aborted || signal?.aborted) stop(run, 'cancelled', 'Capability discovery was cancelled.');
      const error = searches.details.every(search => search.status === 'failed') ? 'All queries in this batch failed.' : undefined;
      return feedback(run, selection, searches, error);
    },
  };
}
function settle(run: Run, thrown: unknown, budget: CapabilityBudget): CapabilityDiscoveryResult {
  // Keep an accepted finish despite late child errors; caller cancellation overrides it in onAbort.
  if (run.end === null) {
    const terminal = budget.check().terminal;
    if (run.signal?.aborted) stop(run, 'cancelled', 'Capability discovery was cancelled.');
    else if (terminal?.status === 'failed') stop(run, 'budget', budgetMessage(terminal));
    else if (thrown !== null) stop(run, 'provider_error', `Capability retrieval model failed: ${errorMessage(thrown)}`);
    else stop(run, 'incomplete', 'Capability retrieval ended without an explicit finish.');
  }
  const end = run.end!;
  const normal = end.reason === 'finished';
  if (!normal) addWarnings(run, [end.message]);
  const result: CapabilityDiscoveryResult = { status: normal ? (run.warnings.length > 0 ? 'partial' : 'ok') : run.selected.size > 0 ? 'partial' : 'failed',
    tools: [], mcp: [], skills: [], remote: [], coverage: capabilityCoverage(run), endReason: end.reason,
    missingCapabilities: run.selected.size === 0 ? run.emptyQueries.slice(0, MISSING_QUERIES) : [], warnings: [...run.warnings] };
  for (const ref of run.selected) {
    const entry = run.hits.get(ref)!;
    const hit = structuredClone(entry.hit);
    if (entry.group === 'skills') {
      if (hit.filePath !== undefined) result.skills.push({ ...hit, filePath: hit.filePath });
    } else result[entry.group].push(hit);
  }
  return result;
}

export function createCapabilityDiscovery(deps: CapabilityDiscoveryDependencies) {
  if (typeof deps?.broker?.search !== 'function') throw new TypeError('createCapabilityDiscovery requires a broker with search().');
  if (typeof deps.openSession !== 'function') throw new TypeError('createCapabilityDiscovery requires an openSession().');
  return {
    async discover({ cwd = process.cwd(), signal }: { cwd?: string | undefined; signal?: AbortSignal | undefined } = {}): Promise<CapabilityDiscoveryResult> {
      const run: Run = { broker: deps.broker, cwd, signal, hits: new Map(), selected: new Set(), warnings: [], emptyQueries: [],
        completedSearches: 0, noSelectionCount: 0, end: null, session: null };
      if (signal?.aborted) return { ...capabilityFailureResult('Capability discovery was cancelled before startup.'), endReason: 'cancelled' };
      const budget = createJobBudget({ profile: CAPABILITY_DISCOVERY_BUDGET });
      let stopWatch: (() => void) | null = null;
      const onAbort = (): void => {
        // Caller cancellation invalidates publication even after an accepted finish.
        run.end = { reason: 'cancelled', message: 'Capability discovery was cancelled.' };
        abortSession(run);
      };
      try {
        run.session = await deps.openSession({ instructions: CAPABILITY_DISCOVERY_SYSTEM_PROMPT, customTools: [stepTool(run)], budget,
          beforeRequest: () => run.end === null ? undefined : { stop: true, reason: run.end.message }, signal });
        if (signal?.aborted) { onAbort(); return settle(run, null, budget); }
        signal?.addEventListener('abort', onAbort, { once: true });
        budget.startActive();
        stopWatch = watchCapabilityBudget(budget, terminal => {
          stop(run, 'budget', budgetMessage(terminal));
          abortSession(run);
        });
        let thrown: unknown = null;
        try {
          const messages = await run.session.prompt(CAPABILITY_DISCOVERY_PROMPT);
          const detail = providerErrorDetail(messages);
          if (detail !== null && run.end === null) thrown = new Error(detail);
        } catch (error) { thrown = error; }
        return settle(run, thrown, budget);
      } catch (error) {
        if (signal?.aborted) onAbort();
        return settle(run, error, budget);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        stopWatch?.();
        budget.pauseActive();
        if (budget.terminal === null) budget.terminate({ reason: run.end?.reason === 'finished' ? 'model_final' : 'cancelled' });
        try { await run.session?.dispose(); } catch { /* Cleanup cannot replace the settled result. */ }
      }
    },
  };
}
