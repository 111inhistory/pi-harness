import { createHash } from 'node:crypto';
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { CapabilityHookPort } from '../capability/extension.ts';
import { runClassifier } from '../classifier-client.ts';
import { harnessConfigFor } from '../harness-config.ts';
import { configLifecycleFor, createSyncSlotToken } from '../config-lifecycle.ts';
import { PRESET_STATE_COMMITTED, PRESET_STATE_RECORD, restorePresetSnapshot } from '../preset/state.ts';
import { applySystemPromptSections } from '../request-instructions.ts';
import { clipText } from '../text-output.ts';
import { extractBranchToolObservations, installToolObservation, type ToolObservation } from '../tool-observation.ts';
import { canClassifyForBranch, classifiedActions, hookQuestion, HOOK_QUESTION } from './classify.ts';
import { isHookId, mergeHookLayers, readHookLayers, type HookAction, type HookRule, type HookRules } from './config.ts';
import { exposeHookInspection, inspectHooks, type HookOverrideResult } from './inspection.ts';
import { applyHookOverride, HOOK_OVERRIDE_RECORD, restoreHookOverrides, type HookOverride } from './override.ts';
import { buildHookClassifierSlice, type HookClassifierSubject, type HookClassifierSources, type HookClassifierToolFact } from './projection.ts';
import { HOOK_HINT_MESSAGE, HOOK_REPEAT_RECORD, readHintReceipts, restoreRepeat, type HookReceipt } from './repeat.ts';
import { emitHookStat, toolCategory, type HookOutcome, type HookStatsBinding } from './stats.ts';
import { compileWhen, evaluateWhen, type CompiledWhen, type WhenContext } from './when.ts';

const MAX_HINT_BYTES = 8192;
const MAX_MATCH_PARENTS = 128;
const MAX_ASYNC_HOOKS = 2;
const MAX_TURN_ATTEMPTS = 4;
const ATTEMPT_REFUSED = Symbol('hook classifier attempt refused');

interface Counters { modelCalls: number; toolCalls: number; nestedToolCalls?: number; toolErrors: number }
interface EffectiveRule { readonly id: string; readonly key: string; readonly token: symbol; readonly rule: HookRule; readonly when?: CompiledWhen }
interface MatchedRule {
  readonly rule: EffectiveRule;
  readonly seed: string;
  readonly classification?: { readonly subject: HookClassifierSubject; readonly sources: HookClassifierSources };
  readonly deferred?: DeferredCommit;
}
interface Hint { readonly text: string; readonly display: boolean }
interface HintBatch {
  readonly hints: readonly Hint[];
  readonly receipts: readonly HookReceipt[];
  readonly discoveryRuns: readonly Promise<unknown>[];
  readonly acceptedRules: ReadonlySet<string>;
  readonly hintRules: ReadonlySet<string>;
}

interface DeferredCommit {
  readonly actions: readonly HookAction[];
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly branchEpoch: number;
  readonly repeatAlreadyAccepted?: true;
}

function turnCounters(): Counters { return { modelCalls: 0, toolCalls: 0, nestedToolCalls: 0, toolErrors: 0 }; }

function countObservation(turn: Counters, observation: ToolObservation): void {
  if (observation.isNested) {
    if (turn.nestedToolCalls !== undefined && observation.status !== 'unfinished') turn.nestedToolCalls += 1;
    return;
  }
  if (observation.status === 'unfinished' || observation.status === 'cancelled') return;
  turn.toolCalls += 1;
  if (observation.isError) turn.toolErrors += 1;
  if (observation.nestedCompleteness === 'unknown') delete turn.nestedToolCalls;
}

function recoverTurn(branch: readonly SessionEntry[]): Counters | undefined {
  const anchor = branch.findLastIndex(entry => entry.type === 'compaction'
    || (entry.type === 'message' && entry.message.role === 'user'));
  const turn = turnCounters();
  const tail = branch.slice(anchor + 1);
  // SDK history stores delivery content, but not whether it started a run or
  // rode an existing one. A live before_agent_start gives us that distinction.
  if (tail.some(entry => entry.type === 'custom_message' && entry.customType === 'agent-delivery')) return undefined;
  for (const entry of tail) if (entry.type === 'message' && entry.message.role === 'assistant') turn.modelCalls += 1;
  for (const observation of extractBranchToolObservations(tail)) countObservation(turn, observation);
  return turn;
}

function observationResult(observation: ToolObservation, truncated = observationTruncated(observation)): NonNullable<WhenContext['result']> {
  let chars = 0;
  let textParts = 0;
  const parts: string[] = [];
  for (const item of observation.content ?? []) {
    if (item.type !== 'text' || item.text === '') continue;
    chars += item.text.length + (textParts++ > 0 ? 1 : 0);
    if (chars <= 8192) parts.push(item.text);
  }
  const error = observation.codemode?.error;
  const errorKind = error?.kind === 'script'
    ? error.name === 'SyntaxError' ? 'script_syntax_error' : 'script_error'
    : error?.kind;
  return {
    isError: observation.isError, ...(truncated === undefined ? {} : { truncated }),
    ...(errorKind === undefined ? {} : { errorKind }),
    outputChars: chars, ...(chars > 8192 ? {} : { output: parts.join('\n') }),
  };
}

function observationTruncated(observation: ToolObservation): boolean | undefined {
  const structured = observation.structuredContent;
  const shellTruncated = (observation.toolName === 'bash' || observation.toolName === 'powershell')
    && typeof structured === 'object' && structured !== null && 'truncated' in structured
    && typeof structured.truncated === 'boolean' ? structured.truncated : undefined;
  const details = observation.details;
  const nativeTruncation = typeof details === 'object' && details !== null && 'truncation' in details ? details.truncation : undefined;
  const nativeTruncated = typeof nativeTruncation === 'object' && nativeTruncation !== null && 'truncated' in nativeTruncation
    && typeof nativeTruncation.truncated === 'boolean' ? nativeTruncation.truncated : undefined;
  return observation.codemode?.truncated ?? shellTruncated ?? nativeTruncated;
}

function classifierResultSource(observation: ToolObservation): HookClassifierSources {
  let result = '';
  let clipped = false;
  for (let index = (observation.content?.length ?? 0) - 1; index >= 0; index -= 1) {
    const block = observation.content?.[index];
    if (block?.type !== 'text' || block.text === '') continue;
    const remaining = 4096 - result.length - Number(result.length > 0);
    if (remaining <= 0) { clipped = true; break; }
    let start = Math.max(0, block.text.length - remaining);
    // Do not manufacture an unpaired low surrogate at the cut boundary.
    if (start > 0 && (block.text.charCodeAt(start) & 0xfc00) === 0xdc00) start += 1;
    result = block.text.slice(start) + (result.length > 0 ? `\n${result}` : '');
    if (start !== 0) { clipped = true; break; }
  }
  return { result, resultClipped: clipped };
}

function posixBash(pi: ExtensionAPI): boolean {
  const shell = SettingsManager.inMemory(pi.getSettings()).getShellPath();
  return shell === undefined ? process.platform !== 'win32' : /(?:^|[\\/])(?:ba|da|z|k)?sh(?:\.exe)?$/i.test(shell);
}

function ruleIdentity(id: string, rule: HookRule): string {
  return `${id}:${createHash('sha256').update(JSON.stringify(rule), 'utf8').digest('hex')}`;
}

const HOOK_SLOT = createSyncSlotToken({
  name: 'hooks.toml', refreshable: true,
  load: ctx => readHookLayers({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), agentDir: getAgentDir() }),
  equals: (a, b) => a.global.digest === b.global.digest && a.project.digest === b.project.digest,
});

/** The Main adapter owns rule state; the narrow Capability port owns execution and publication. */
export function installHookSurface(pi: ExtensionAPI, capability: CapabilityHookPort, stats?: HookStatsBinding): void {
  const configFor = harnessConfigFor(pi);
  const lifecycle = configLifecycleFor(pi);
  const layers = lifecycle.bindSyncSlot(HOOK_SLOT, ({ value }) => {
    if (branchState?.scopeCurrent()) updateEligibility(value, branchState.presetHooks, branchState.muted);
  });
  let lastLayerError: unknown;
  let closed = false;
  exposeHookInspection(pi, {
    current: ctx => closed ? undefined : inspectHooks(ctx, () => layers.read(ctx).value, configFor(ctx).classifier.models.length > 0),
    stats: () => stats?.snapshot(),
    override: changeOverride,
  });
  let eligible = new Map<string, { readonly key: string; readonly token: symbol }>();
  const running = new Map<string, { readonly controller: AbortController; readonly requiresTurn: boolean }>();
  let branchState: {
    readonly layersRevision: number;
    readonly scopeCurrent: () => boolean;
    readonly presetHooks: HookRules;
    readonly muted: Set<string>;
    matcherChanged: boolean;
    readonly rules: readonly EffectiveRule[];
    readonly preset: string | undefined;
    userTurn: number;
    readonly repeat: ReturnType<typeof restoreRepeat>;
    readonly bashIsPosix: boolean;
    readonly capturePreviews: boolean;
    readonly recentTools: HookClassifierToolFact[];
    recentToolsClipped: boolean;
    leaf: string | null;
  } | undefined;
  let turnState: {
    awaitingStartUser: boolean;
    counters: Counters | undefined;
    readonly pendingHints: Map<string, HookReceipt[]>;
    readonly passiveHints: Map<string, MatchedRule>;
    readonly nested: Map<string, Map<string, MatchedRule>>;
    attempts: number;
    compactions: number;
    producingModel?: NonNullable<WhenContext['model']>;
  } | undefined;

  function updateEligibility(value: ReturnType<typeof readHookLayers>, preset: HookRules, muted: ReadonlySet<string>) {
    const merged = mergeHookLayers(value.global.rules, preset, value.project.rules);
    const next = new Map<string, { readonly key: string; readonly token: symbol }>();
    for (const [id, rule] of merged) {
      if (muted.has(id)) continue;
      const key = ruleIdentity(id, rule);
      const existing = eligible.get(id);
      next.set(id, existing?.key === key ? existing : { key, token: Symbol(id) });
    }
    eligible = next;
    return merged;
  }

  const canCommit = (rule: EffectiveRule): boolean => branchState?.scopeCurrent() === true && eligible.get(rule.id)?.token === rule.token;
  const recordOutcome = (id: string, outcome: HookOutcome) => emitHookStat(stats?.capture(), { type: 'hook', id, outcome });
  const invalidateBranch = (): void => {
    eligible.clear();
    branchState = undefined;
    turnState = undefined;
    for (const task of running.values()) task.controller.abort();
  };

  function acceptPersistedHint(details: unknown): void {
    if (branchState === undefined || turnState === undefined) return;
    for (const receipt of readHintReceipts(details)) {
      const pending = turnState.pendingHints.get(receipt.key);
      const index = pending?.findIndex(candidate => candidate.turn === receipt.turn) ?? -1;
      if (pending === undefined || index < 0) continue;
      pending.splice(index, 1);
      if (pending.length === 0) turnState.pendingHints.delete(receipt.key);
      branchState.repeat.accept(receipt.key, receipt.turn);
    }
  }

  function advanceBranch(ctx: ExtensionContext, observedRun: boolean): void {
    const branch = branchState;
    if (branch === undefined) return;
    const manager = ctx.sessionManager;
    const leaf = manager.getLeafId();
    let cursor = leaf;
    while (cursor !== null && cursor !== branch.leaf) {
      const entry = manager.getEntry(cursor);
      if (entry === undefined || (entry.type === 'custom' && entry.customType === PRESET_STATE_RECORD)) break;
      if (!observedRun && (entry.type === 'compaction' || (entry.type === 'message' && entry.message.role === 'user'))) break;
      // SDK passive custom messages are persisted without extension message_end.
      // A reservation already reconciled by message_end has no effect here.
      if (entry.type === 'custom_message' && entry.customType === HOOK_HINT_MESSAGE) acceptPersistedHint(entry.details);
      cursor = entry.parentId;
    }
    if (cursor === branch.leaf) branch.leaf = leaf;
    else { branchState = undefined; eligible.clear(); }
  }

  pi.on('agent_settled', (_event, ctx) => {
    if (turnState !== undefined) advanceBranch(ctx, true);
    for (const id of turnState?.passiveHints.keys() ?? []) recordOutcome(id, 'stale');
    turnState = undefined;
    for (const task of running.values()) if (task.requiresTurn) task.controller.abort();
  });
  pi.on('session_before_switch', invalidateBranch);
  pi.events.on(PRESET_STATE_COMMITTED, invalidateBranch);
  pi.on('session_before_fork', invalidateBranch);
  pi.on('session_before_tree', invalidateBranch);
  pi.on('session_tree', invalidateBranch);
  pi.on('session_shutdown', () => { closed = true; invalidateBranch(); });
  pi.on('session_start', () => { closed = false; lastLayerError = undefined; invalidateBranch(); });

  function changeOverride(ctx: ExtensionContext, delta: HookOverride): HookOverrideResult | undefined {
    if (closed || !ctx.isIdle()) return undefined;
    const epoch = capability.branchEpoch();
    const leaf = ctx.sessionManager.getLeafId();
    const muted = restoreHookOverrides(ctx.sessionManager.getBranch());
    const changed = applyHookOverride(muted, delta);
    if (!changed) return { changed, muted: [...muted].sort() };
    if (closed || !ctx.isIdle() || epoch !== capability.branchEpoch() || leaf !== ctx.sessionManager.getLeafId()) return undefined;
    pi.appendEntry(HOOK_OVERRIDE_RECORD, delta);
    if (branchState?.scopeCurrent()) {
      applyHookOverride(branchState.muted, delta);
      branchState.matcherChanged = true;
      const snapshot = layers.peek(ctx);
      if (snapshot !== undefined) updateEligibility(snapshot.value, branchState.presetHooks, muted);
    }
    return { changed, muted: [...muted].sort() };
  }

  pi.registerCommand('hooks', {
    description: 'Inspect Hook statistics or mute Hooks on this branch',
    handler: async (args, ctx) => {
      const [op, id, ...extra] = args.trim().split(/\s+/);
      if (op === 'stats' && id === undefined) {
        ctx.ui.notify(stats?.render() ?? 'Hook Stats are unavailable for this session.', 'info');
        return;
      }
      let delta: HookOverride;
      if (op === 'reset' && id === undefined) delta = { version: 1, op };
      else if ((op === 'mute' || op === 'unmute') && isHookId(id) && extra.length === 0) delta = { version: 1, op, id };
      else {
        ctx.ui.notify('Usage: /hooks stats | mute ID | unmute ID | reset', 'info');
        return;
      }
      const result = changeOverride(ctx, delta);
      if (result === undefined) {
        ctx.ui.notify('Wait for the session to become idle before changing Hook overrides.', 'warning');
        return;
      }
      ctx.ui.notify(result.changed ? 'Hook overrides updated.' : 'Hook overrides unchanged.', 'info');
    },
  });

  function bindBranch(ctx: ExtensionContext, mode: 'start' | 'commit' = 'start'): typeof branchState {
    let currentLayers: ReturnType<typeof layers.read>;
    try {
      currentLayers = layers.read(ctx);
    } catch (error) {
      // An unreadable higher layer could have disabled lower rules.
      invalidateBranch();
      if (lastLayerError !== error) {
        lastLayerError = error;
        ctx.ui.notify(`Hooks: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      return undefined;
    }
    const manager = ctx.sessionManager;
    const leaf = manager.getLeafId();
    if (branchState !== undefined && !branchState.scopeCurrent()) invalidateBranch();
    if (branchState !== undefined && turnState === undefined && mode === 'start' &&
      (branchState.matcherChanged || branchState.layersRevision !== currentLayers.revision)) branchState = undefined;
    advanceBranch(ctx, mode === 'commit' && turnState !== undefined);
    if (branchState !== undefined) return branchState;
    const branch = manager.getBranch();
    const snapshot = restorePresetSnapshot(branch);
    const presetHooks = snapshot?.hooks ?? {};
    const muted = restoreHookOverrides(branch);
    const rules: EffectiveRule[] = [];
    let classifierUnavailable = false;
    const hasClassifier = configFor(ctx).classifier.models.length > 0;
    for (const [id, rule] of updateEligibility(currentLayers.value, presetHooks, muted)) {
      const identity = eligible.get(id);
      if (identity === undefined) continue;
      if (rule.classify !== undefined && !hasClassifier) {
        classifierUnavailable = true;
        continue;
      }
      try {
        rules.push({ id, ...identity, rule,
          ...(rule.when === undefined ? {} : { when: compileWhen(rule.when, rule.on) }) });
      } catch (error) {
        ctx.ui.notify(`Hooks: ${id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    if (classifierUnavailable) ctx.ui.notify('Hooks: classified rules require at least one classifier.models entry.', 'warning');
    const repeat = restoreRepeat(branch, new Map(rules.flatMap(entry => entry.rule.repeat === undefined ? [] : [[entry.key, entry.rule.repeat]])));
    const capturePreviews = rules.some(({ rule }) => rule.classify?.include.includes('recentToolPreviews'));
    branchState = { rules, layersRevision: currentLayers.revision, scopeCurrent: lifecycle.captureScope(ctx), presetHooks, muted, matcherChanged: false,
      preset: snapshot?.name, repeat, userTurn: repeat.userTurn,
      bashIsPosix: posixBash(pi), recentTools: [], recentToolsClipped: false, capturePreviews, leaf };
    return branchState;
  }

  function startTurn(ctx: ExtensionContext, origin: 'user' | 'custom' | 'resume'): void {
    turnState = undefined;
    if (!bindBranch(ctx)?.rules.length) return;
    turnState = {
      awaitingStartUser: origin === 'user',
      counters: origin === 'resume' ? recoverTurn(ctx.sessionManager.getBranch()) : turnCounters(),
      pendingHints: new Map(), passiveHints: new Map(), nested: new Map(), attempts: 0, compactions: 0,
    };
  }

  function matches(on: HookRule['on'], extras: Partial<WhenContext>, ctx: ExtensionContext, seed: string, observation?: ToolObservation): MatchedRule[] {
    if (branchState === undefined || turnState === undefined) return [];
    const model = on === 'tool_result' && turnState.producingModel !== undefined ? turnState.producingModel
      : ctx.model !== undefined && ctx.model.api !== 'pi-virtual' ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
    const environment: WhenContext = {
      cwd: ctx.cwd, ...(turnState.counters === undefined ? {} : { turn: turnState.counters }),
      ...(branchState.preset === undefined ? {} : { preset: branchState.preset }),
      ...(model === undefined ? {} : { model }),
      ...extras,
    };
    const context = environment.result;
    const subject: HookClassifierSubject = {
      trigger: on,
      ...(model === undefined ? {} : { model }),
      ...(environment.preset === undefined ? {} : { preset: environment.preset }),
      ...(environment.tool === undefined ? {} : { tool: environment.tool }),
      ...(environment.nested === undefined ? {} : { nested: environment.nested }),
      ...(environment.turn === undefined ? {} : { turn: { ...environment.turn } }),
      ...(context === undefined ? {} : { result: {
        ...(context.isError === undefined ? {} : { isError: context.isError }),
        ...(context.truncated === undefined ? {} : { truncated: context.truncated }),
        ...(context.errorKind === undefined ? {} : { errorKind: context.errorKind }),
        ...(context.outputChars === undefined ? {} : { outputChars: context.outputChars }),
      } }),
    };
    let resultSource: HookClassifierSources | undefined;
    return branchState.rules.flatMap(rule => {
      if (rule.rule.on !== on || (rule.when !== undefined && evaluateWhen(rule.when, environment) !== 'true')) return [];
      const include = rule.rule.classify?.include;
      if (include === undefined) return [{ rule, seed }];
      const sources: HookClassifierSources = {
        ...(include.includes('prompt') && environment.prompt !== undefined ? { prompt: environment.prompt } : {}),
        ...(include.includes('result') && observation !== undefined ? (resultSource ??= classifierResultSource(observation)) : {}),
      };
      return [{ rule, seed, classification: { subject, sources } }];
    });
  }

  function runBatch(hits: Iterable<MatchedRule>, ctx: ExtensionContext, canDeliverHint: () => boolean): HintBatch {
    const discoveryRuns: Promise<unknown>[] = [];
    const acceptedRules = new Set<string>();
    const hintRules = new Set<string>();
    if (branchState === undefined) return { hints: [], receipts: [], discoveryRuns, acceptedRules, hintRules };
    const branch = branchState;
    const turn = turnState;
    const userTurn = branch.userTurn + Number(turn?.awaitingStartUser === true);
    const hints = new Map<string, Hint>();
    const receipts = new Map<string, HookReceipt>();
    let hintBytes = 0;
    for (const { rule: effective, seed, deferred } of [...hits].sort((a, b) => a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0)) {
      const signal = deferred?.signal ?? ctx.signal;
      const epoch = deferred?.branchEpoch ?? capability.branchEpoch();
      const { rule, key } = effective;
      if (rule.classify !== undefined && deferred === undefined) continue;
      if (rule.actions[0]?.type === 'injectSection') continue;
      if (deferred === undefined) recordOutcome(effective.id, 'matched');
      if (!canCommit(effective) || epoch !== capability.branchEpoch()) {
        recordOutcome(effective.id, 'stale');
        continue;
      }
      if (deferred !== undefined && performance.now() >= deferred.deadline) {
        recordOutcome(effective.id, 'timeout');
        continue;
      }
      if (!deferred?.repeatAlreadyAccepted && !branch.repeat.allows(key, userTurn, turn?.pendingHints.get(key))) {
        recordOutcome(effective.id, 'suppressed');
        continue;
      }
      const timeoutMs = Math.min(120_000, configFor(ctx).hooks.timeoutMs, rule.timeoutMs ?? Infinity);
      const deadline = deferred?.deadline ?? performance.now() + timeoutMs;
      let actionAccepted = false;
      let receiptRecorded = false;
      let failed = false;
      const accept = (kind: 'hint' | 'action'): void => {
        if (kind === 'hint' && !deferred?.repeatAlreadyAccepted) hintRules.add(effective.id);
        if (kind === 'action' && !acceptedRules.has(key)) {
          acceptedRules.add(key);
          recordOutcome(effective.id, 'committed');
        }
        if (rule.repeat === undefined || deferred?.repeatAlreadyAccepted) return;
        if (receiptRecorded) return;
        const receipt = { key, turn: userTurn };
        if (kind === 'hint') {
          receipts.set(key, receipt);
          return;
        }
        if (!actionAccepted) {
          branch.repeat.accept(key, userTurn);
          actionAccepted = true;
        }
        pi.appendEntry(HOOK_REPEAT_RECORD, receipt);
        receiptRecorded = true;
        receipts.delete(key);
      };
      for (const action of deferred?.actions ?? rule.actions) {
        if (performance.now() >= deadline || signal?.aborted || branchState !== branch || (deferred === undefined && turnState !== turn)
          || capability.branchEpoch() !== epoch) break;
        try {
          if (action.type === 'injectHint') {
            if (!canDeliverHint()) continue;
            const existing = hints.get(action.text);
            if (existing !== undefined) {
              if (action.display === true && !existing.display) hints.set(action.text, { ...existing, display: true });
              accept('hint');
              continue;
            }
            const size = Buffer.byteLength(action.text, 'utf8') + (hints.size ? 2 : 0);
            if (hintBytes + size > MAX_HINT_BYTES) continue;
            hints.set(action.text, { text: action.text, display: action.display === true });
            hintBytes += size;
            accept('hint');
          } else if (action.type === 'activate') {
            const outcome = capability.activate(ctx, { branchEpoch: epoch, targets: action.targets });
            if (outcome?.changed.length) accept('action');
          } else if (action.type === 'discoverCapability') {
            const remaining = Math.ceil(deadline - performance.now());
            if (remaining > 0) {
              if (deferred === undefined && (running.size >= MAX_ASYNC_HOOKS || running.has(effective.id))) continue;
              const controller = new AbortController();
              const discovery = capability.discover(ctx, {
                branchEpoch: epoch, deadline, seed: action.hint === undefined ? seed : `${seed}\n\n${action.hint}`,
                canPublish: () => canCommit(effective),
                signal: deferred === undefined
                  ? AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)])
                  : AbortSignal.any([controller.signal, AbortSignal.timeout(remaining), deferred.signal]),
              });
              if (!discovery.accepted) continue;
              if (deferred === undefined) running.set(effective.id, { controller, requiresTurn: false });
              const finished = discovery.done.catch(error => {
                if (capability.branchEpoch() === epoch) ctx.ui.notify(`Hooks: ${effective.id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
              }).finally(() => { if (deferred === undefined) running.delete(effective.id); });
              discoveryRuns.push(finished);
              try { accept('action'); }
              catch (error) { controller.abort(); throw error; }
            }
          }
        } catch (error) {
          failed = true;
          recordOutcome(effective.id, 'failed');
          ctx.ui.notify(`Hooks: ${effective.id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
          if (actionAccepted && !receiptRecorded) {
            receipts.delete(key);
            break;
          }
        }
      }
      if (!failed && !acceptedRules.has(key) && !hintRules.has(effective.id) && !deferred?.repeatAlreadyAccepted) {
        recordOutcome(effective.id, (deferred?.actions ?? rule.actions).length === 0 ? 'observed' : 'suppressed');
      }
    }
    return { hints: [...hints.values()], receipts: [...receipts.values()], discoveryRuns, acceptedRules, hintRules };
  }

  function hintMessage({ hints, receipts }: HintBatch, ctx: ExtensionContext) {
    const display = hints.every(hint => hint.display);
    // A native custom message has one visibility bit. Mixed batches keep quiet
    // hints private while still showing explicitly visible hints in the UI.
    if (!display) for (const hint of hints) if (hint.display) ctx.ui.notify(hint.text, 'info');
    // Hint-only repeat usage follows the native message. A queued hint that the
    // SDK never persists must not silently consume a durable repeat allowance.
    return { customType: HOOK_HINT_MESSAGE, content: hints.map(hint => hint.text).join('\n\n'), display,
      ...(receipts.length === 0 ? {} : { details: { repeat: receipts } }) };
  }

  function startClassification(hit: MatchedRule, ctx: ExtensionContext): void {
    const branch = branchState;
    const turn = turnState;
    const { id, key, rule } = hit.rule;
    const classify = rule.classify;
    if (branch === undefined || turn === undefined || classify === undefined || hit.classification === undefined) return;
    const sink = stats?.capture();
    const report = (outcome: HookOutcome) => emitHookStat(sink, { type: 'hook', id, outcome });
    report('matched');
    if (!canCommit(hit.rule)) { report('stale'); return; }
    if (ctx.signal?.aborted || running.size >= MAX_ASYNC_HOOKS || running.has(id) || turn.passiveHints.has(id)
        || turn.attempts >= MAX_TURN_ATTEMPTS) { report('suppressed'); return; }
    const userTurn = branch.userTurn + Number(turn.awaitingStartUser);
    if (!branch.repeat.allows(key, userTurn, turn.pendingHints.get(key))) { report('suppressed'); return; }

    const config = configFor(ctx);
    const duration = Math.min(120_000, config.hooks.timeoutMs, rule.timeoutMs ?? Infinity);
    const deadline = performance.now() + duration;
    const branchEpoch = capability.branchEpoch();
    const controller = new AbortController();
    const requiresTurn = !canClassifyForBranch(rule);
    const compactions = turn.compactions;
    running.set(id, { controller, requiresTurn });
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), duration);
    timeout.unref();

    const { subject, sources } = hit.classification;
    const run = async (): Promise<void> => {
      const state = buildHookClassifierSlice(subject, classify.include, {
        ...sources,
        branch: () => ctx.sessionManager.getBranch(),
        recentTools: branch.recentTools,
        recentToolsClipped: branch.recentToolsClipped,
        toolDirectory: () => capability.snapshot(ctx),
      });
      const outcome = await runClassifier({
        registry: ctx.modelRegistry,
        models: config.classifier.models,
        signal,
        context: { state, questions: { [HOOK_QUESTION]: hookQuestion(classify) } },
        maxAttemptsPerModel: 1,
        retryDelayMs: () => 0,
        debitAttempt() {
          if (turnState !== turn || turn.attempts >= MAX_TURN_ATTEMPTS || performance.now() >= deadline) throw ATTEMPT_REFUSED;
          turn.attempts += 1;
          emitHookStat(sink, { type: 'classifier-start' });
        },
        ...(sink === undefined ? {} : { onAttempt: attempt => emitHookStat(sink, {
          type: 'classifier-result', outcome: attempt.outcome, durationMs: attempt.durationMs,
          ...(attempt.usage === undefined ? {} : { inputTokens: attempt.usage.input, outputTokens: attempt.usage.output }),
        }) }),
      });
      if (performance.now() >= deadline) { report('timeout'); return; }
      if (signal.aborted || capability.branchEpoch() !== branchEpoch) { report('stale'); return; }
      if (outcome.outcome !== 'answered') { report('failed'); return; }
      const actions = classifiedActions(rule, outcome.result.answers);
      if (actions === undefined) { report('failed'); return; }
      if (actions.length === 0) { report('observed'); return; }
      if (!canCommit(hit.rule) || !bindBranch(ctx, 'commit') || !canCommit(hit.rule)) { report('stale'); return; }
      const next = (actions: readonly HookAction[], repeatAlreadyAccepted = false): MatchedRule => ({
        rule: hit.rule, seed: hit.seed,
        deferred: { actions, deadline, signal, branchEpoch, ...(repeatAlreadyAccepted ? { repeatAlreadyAccepted: true } : {}) },
      });
      const hints = actions.filter(action => action.type === 'injectHint');
      const branchActions = actions.filter(action => action.type === 'activate' || action.type === 'discoverCapability');
      const commits = branchActions.length > 0 ? runBatch([next(branchActions)], ctx, () => false) : undefined;
      if (hints.length > 0 && turnState === turn && turn.compactions === compactions) {
        turn.passiveHints.set(id, next(hints, commits?.acceptedRules.has(key)));
      } else if (hints.length > 0 && commits === undefined) {
        report('stale');
      }
      if (commits !== undefined) await Promise.allSettled(commits.discoveryRuns);
    };
    void run().catch(error => {
      if (performance.now() >= deadline) report('timeout');
      else if (signal.aborted || capability.branchEpoch() !== branchEpoch || turnState !== turn) report('stale');
      else report(error === ATTEMPT_REFUSED ? 'suppressed' : 'failed');
      if (error !== ATTEMPT_REFUSED && !signal.aborted && capability.branchEpoch() === branchEpoch) {
        ctx.ui.notify(`Hooks: ${id}: classifier failed.`, 'warning');
      }
    }).finally(() => {
      clearTimeout(timeout);
      running.delete(id);
    });
  }

  const acceptHintHandoff = (batch: HintBatch): void => {
    if (turnState === undefined) return;
    for (const id of batch.hintRules) recordOutcome(id, 'committed');
    for (const receipt of batch.receipts) {
      const pending = turnState.pendingHints.get(receipt.key);
      if (pending === undefined) turnState.pendingHints.set(receipt.key, [receipt]);
      else pending.push(receipt);
    }
  };

  pi.on('before_agent_start', (event, ctx) => {
    startTurn(ctx, event.messageType);
    const target = event.systemPromptOptions.sections ??= {};
    const sections: Record<string, string> = {};
    let sectionBytes = 0;
    const prompt = event.messageType === 'user' ? event.prompt : undefined;
    const hits = matches('before_agent_start', prompt === undefined ? {} : { prompt }, ctx, prompt ?? '');
    if (!event.systemPromptOptions.customPrompt) {
      for (const { rule } of hits) {
        const section = rule.rule.actions[0];
        if (section?.type !== 'injectSection') continue;
        recordOutcome(rule.id, 'matched');
        const bytes = Buffer.byteLength(section.text, 'utf8');
        if (sectionBytes + bytes > MAX_HINT_BYTES) { recordOutcome(rule.id, 'suppressed'); continue; }
        sections[`hook-${rule.id}`] = section.text;
        sectionBytes += bytes;
        recordOutcome(rule.id, 'committed');
      }
    }
    applySystemPromptSections(target, sections, Object.keys(target).filter(key => key.startsWith('hook-')));
    if (event.messageType !== 'user') return undefined;
    for (const hit of hits) startClassification(hit, ctx);
    const batch = runBatch(hits, ctx, () => !ctx.signal?.aborted);
    if (batch.hints.length === 0 || ctx.signal?.aborted) return undefined;
    const message = hintMessage(batch, ctx);
    acceptHintHandoff(batch);
    return { message };
  });
  pi.on('agent_start', (_event, ctx) => { if (turnState === undefined) startTurn(ctx, 'resume'); });
  pi.on('message_end', event => {
    if (branchState === undefined || turnState === undefined) return;
    if (event.message.role === 'user') {
      turnState.awaitingStartUser = false;
      branchState.userTurn += 1;
    } else if (event.message.role === 'assistant') {
      if (turnState.counters !== undefined) turnState.counters.modelCalls += 1;
      turnState.producingModel = { provider: event.message.provider, id: event.message.model };
    } else if (event.message.role === 'custom' && event.message.customType === HOOK_HINT_MESSAGE) {
      acceptPersistedHint(event.message.details);
    }
  });
  pi.on('session_compact', (_event, ctx) => {
    if (turnState !== undefined) advanceBranch(ctx, true);
    branchState?.repeat.compact();
    if (branchState !== undefined) {
      branchState.recentTools.length = 0;
      branchState.recentToolsClipped = false;
    }
    if (turnState === undefined) return;
    turnState.counters = turnCounters();
    turnState.nested.clear();
    turnState.passiveHints.clear();
    turnState.compactions += 1;
  });

  installToolObservation(pi, (observation, _event, ctx) => {
    const truncated = observationTruncated(observation);
    if (stats !== undefined && observation.status !== 'cancelled' && observation.status !== 'unfinished') {
      emitHookStat(stats.capture(), { type: 'tool', category: toolCategory(observation.toolName), failed: observation.isError,
        nested: observation.isNested, ...(truncated === undefined ? {} : { truncated }) });
    }
    if (branchState === undefined || turnState === undefined || ctx.signal?.aborted) return;
    const branch = branchState;
    const state = turnState;
    if (state.counters !== undefined) countObservation(state.counters, observation);
    const inherited = state.nested.get(observation.callId) ?? new Map<string, MatchedRule>();
    state.nested.delete(observation.callId);
    if (observation.status === 'cancelled' || observation.status === 'unfinished') return;
    const { toolName, isNested, status, isError, source } = observation;
    if (branch.recentTools.length === 6) {
      branch.recentTools.shift();
      branch.recentToolsClipped = true;
    }
    // Limit previews to selected built-in search text. Never expose path
    // arguments, arbitrary tool inputs, or any historical provider output.
    const pattern = branch.capturePreviews && (toolName === 'grep' || toolName === 'find') ? observation.input?.['pattern'] : undefined;
    const preview = typeof pattern === 'string' ? clipText(pattern, { maxBytes: 256, maxLines: 100 }, 'tail') : undefined;
    branch.recentTools.push({ toolName, isNested, status, isError, source,
      ...(preview === undefined ? {} : { inputPreview: preview.text, inputPreviewClipped: preview.truncated }) });
    for (const match of matches('tool_result', {
      tool: observation.toolName, nested: observation.isNested, result: observationResult(observation, truncated),
      ...(observation.input === undefined ? {} : { input: observation.input }),
      ...(branch.bashIsPosix && observation.toolName === 'bash' ? { shell: 'posix' } : {}),
    }, ctx, observation.toolName, observation)) {
      if (!inherited.has(match.rule.id)) inherited.set(match.rule.id, match);
    }
    if (observation.parentCallId !== undefined) {
      if (inherited.size === 0) return;
      const parent = state.nested.get(observation.parentCallId);
      if (parent !== undefined) for (const [id, match] of inherited) { if (!parent.has(id)) parent.set(id, match); }
      else if (state.nested.size < MAX_MATCH_PARENTS) state.nested.set(observation.parentCallId, inherited);
      return;
    }
    if (state.passiveHints.size > 0) bindBranch(ctx, 'commit');
    const currentBranch = branchState;
    const canDeliverHint = () => turnState === state && currentBranch !== undefined && branchState === currentBranch && !ctx.isIdle() && !ctx.signal?.aborted;
    if (canDeliverHint() && state.passiveHints.size > 0) {
      const passive = runBatch(state.passiveHints.values(), ctx, canDeliverHint);
      state.passiveHints.clear();
      if (passive.hints.length > 0 && canDeliverHint()) {
        acceptHintHandoff(passive);
        pi.sendMessage(hintMessage(passive, ctx), { triggerTurn: false });
      }
    }
    for (const hit of inherited.values()) startClassification(hit, ctx);
    const batch = runBatch(inherited.values(), ctx, canDeliverHint);
    if (batch.hints.length > 0 && canDeliverHint()) {
      // Already-executed tool boundary; steering here rides the active SDK run.
      const message = hintMessage(batch, ctx);
      acceptHintHandoff(batch);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: 'steer' });
    }
  });
}
