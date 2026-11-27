import { createHash } from 'node:crypto';
import path from 'node:path';
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { CapabilityHookPort } from '../capability/extension.ts';
import { harnessConfigFor } from '../harness-config.ts';
import { PRESET_STATE_RECORD, restorePresetSnapshot } from '../preset/state.ts';
import { applySystemPromptSections } from '../request-instructions.ts';
import { extractBranchToolObservations, installToolObservation, type ToolObservation } from '../tool-observation.ts';
import { mergeHookLayers, readHookLayer, type HookRule, type HookRules } from './config.ts';
import { HOOK_HINT_MESSAGE, HOOK_REPEAT_RECORD, readHintReceipts, restoreRepeat, type HookReceipt } from './repeat.ts';
import { compileWhen, evaluateWhen, type CompiledWhen, type WhenContext } from './when.ts';

const MAX_HINT_BYTES = 8192;
const MAX_MATCH_PARENTS = 128;

interface Counters { modelCalls: number; toolCalls: number; nestedToolCalls?: number; toolErrors: number }
interface EffectiveRule { readonly id: string; readonly key: string; readonly rule: HookRule; readonly when?: CompiledWhen }
interface MatchedRule { readonly rule: EffectiveRule; readonly seed: string }
interface Hint { readonly text: string; readonly display: boolean }
interface HintBatch { readonly hints: readonly Hint[]; readonly receipts: readonly HookReceipt[] }

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

function observationResult(observation: ToolObservation): NonNullable<WhenContext['result']> {
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
  const structured = observation.structuredContent;
  const shellTruncated = (observation.toolName === 'bash' || observation.toolName === 'powershell')
    && typeof structured === 'object' && structured !== null && 'truncated' in structured
    && typeof structured.truncated === 'boolean' ? structured.truncated : undefined;
  const details = observation.details;
  const nativeTruncation = typeof details === 'object' && details !== null && 'truncation' in details ? details.truncation : undefined;
  const nativeTruncated = typeof nativeTruncation === 'object' && nativeTruncation !== null && 'truncated' in nativeTruncation
    && typeof nativeTruncation.truncated === 'boolean' ? nativeTruncation.truncated : undefined;
  const truncated = observation.codemode?.truncated ?? shellTruncated ?? nativeTruncated;
  return {
    isError: observation.isError, ...(truncated === undefined ? {} : { truncated }),
    ...(errorKind === undefined ? {} : { errorKind }),
    outputChars: chars, ...(chars > 8192 ? {} : { output: parts.join('\n') }),
  };
}

function posixBash(pi: ExtensionAPI): boolean {
  const shell = SettingsManager.inMemory(pi.getSettings()).getShellPath();
  return shell === undefined ? process.platform !== 'win32' : /(?:^|[\\/])(?:ba|da|z|k)?sh(?:\.exe)?$/i.test(shell);
}

function ruleIdentity(id: string, rule: HookRule): string {
  return `${id}:${createHash('sha256').update(JSON.stringify(rule), 'utf8').digest('hex')}`;
}

/** The Main adapter owns rule state; the narrow Capability port owns execution and publication. */
export function installHookSurface(pi: ExtensionAPI, capability: CapabilityHookPort): void {
  const configFor = harnessConfigFor(pi);
  let global: HookRules = {};
  let project: HookRules = {};
  let layerContext: { readonly cwd: string; readonly trusted: boolean } | undefined;
  let layersValid = true;
  let branchState: {
    readonly rules: readonly EffectiveRule[];
    readonly preset: string | undefined;
    userTurn: number;
    readonly repeat: ReturnType<typeof restoreRepeat>;
    readonly bashIsPosix: boolean;
    leaf: string | null;
  } | undefined;
  let turnState: {
    awaitingStartUser: boolean;
    counters: Counters | undefined;
    readonly pendingHints: Map<string, HookReceipt[]>;
    readonly nested: Map<string, Map<string, MatchedRule>>;
    producingModel?: NonNullable<WhenContext['model']>;
  } | undefined;

  const invalidateBranch = (): void => { branchState = undefined; turnState = undefined; };
  pi.on('agent_settled', (_event, ctx) => {
    const observedRun = turnState !== undefined;
    turnState = undefined;
    if (!observedRun || branchState === undefined) return;
    const manager = ctx.sessionManager;
    const leaf = manager.getLeafId();
    // Receipts and user entries were consumed live. A Preset applied by another
    // component still forces the effective rule set to be rebuilt next run.
    let cursor = leaf;
    while (cursor !== null && cursor !== branchState.leaf) {
      const entry = manager.getEntry(cursor);
      if (entry === undefined || (entry.type === 'custom' && entry.customType === PRESET_STATE_RECORD)) break;
      cursor = entry.parentId;
    }
    if (cursor === branchState.leaf) branchState.leaf = leaf;
    else branchState = undefined;
  });
  pi.on('session_before_switch', invalidateBranch);
  pi.on('session_before_fork', invalidateBranch);
  pi.on('session_before_tree', invalidateBranch);
  pi.on('session_tree', invalidateBranch);
  pi.on('session_shutdown', invalidateBranch);
  pi.on('session_start', () => { layerContext = undefined; invalidateBranch(); });

  function bindBranch(ctx: ExtensionContext): typeof branchState {
    const trusted = ctx.isProjectTrusted();
    if (layerContext?.cwd !== ctx.cwd || layerContext.trusted !== trusted) {
      global = {};
      project = {};
      layersValid = true;
      branchState = undefined;
      try {
        global = readHookLayer(getAgentDir());
        if (trusted) project = readHookLayer(path.join(ctx.cwd, '.pi'));
      } catch (error) {
        // An unreadable higher layer could have disabled lower rules.
        layersValid = false;
        ctx.ui.notify(`Hooks: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      layerContext = { cwd: ctx.cwd, trusted };
    }
    if (!layersValid) return undefined;
    const manager = ctx.sessionManager;
    const leaf = manager.getLeafId();
    if (branchState !== undefined) {
      let cursor = leaf;
      while (cursor !== branchState.leaf && cursor !== null) {
        const entry = manager.getEntry(cursor);
        if (entry === undefined || (entry.type === 'custom' && entry.customType === PRESET_STATE_RECORD)
          || entry.type === 'compaction' || (entry.type === 'message' && entry.message.role === 'user')) break;
        cursor = entry.parentId;
      }
      if (cursor === branchState.leaf) {
        branchState.leaf = leaf;
        return branchState;
      }
      branchState = undefined;
    }
    const branch = manager.getBranch();
    const snapshot = restorePresetSnapshot(branch);
    const rules: EffectiveRule[] = [];
    for (const [id, rule] of mergeHookLayers(global, snapshot?.hooks ?? {}, project)) {
      try {
        rules.push({ id, key: ruleIdentity(id, rule), rule,
          ...(rule.when === undefined ? {} : { when: compileWhen(rule.when, rule.on) }) });
      } catch (error) {
        ctx.ui.notify(`Hooks: ${id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    const repeat = restoreRepeat(branch, new Map(rules.flatMap(entry => entry.rule.repeat === undefined ? [] : [[entry.key, entry.rule.repeat]])));
    branchState = { rules, preset: snapshot?.name, repeat, userTurn: repeat.userTurn, bashIsPosix: posixBash(pi), leaf };
    return branchState;
  }

  function startTurn(ctx: ExtensionContext, origin: 'user' | 'custom' | 'resume'): void {
    turnState = undefined;
    if (!bindBranch(ctx)?.rules.length) return;
    turnState = {
      awaitingStartUser: origin === 'user',
      counters: origin === 'resume' ? recoverTurn(ctx.sessionManager.getBranch()) : turnCounters(),
      pendingHints: new Map(), nested: new Map(),
    };
  }

  function matches(on: HookRule['on'], extras: Partial<WhenContext>, ctx: ExtensionContext, seed: string): MatchedRule[] {
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
    return branchState.rules.flatMap(rule => rule.rule.on === on && (rule.when === undefined || evaluateWhen(rule.when, environment) === 'true')
      ? [{ rule, seed }] : []);
  }

  function runBatch(hits: Iterable<MatchedRule>, ctx: ExtensionContext, canDeliverHint: () => boolean): HintBatch {
    if (branchState === undefined || turnState === undefined || ctx.signal?.aborted) return { hints: [], receipts: [] };
    const branch = branchState;
    const turn = turnState;
    const userTurn = branch.userTurn + Number(turn.awaitingStartUser);
    const hints = new Map<string, Hint>();
    const receipts = new Map<string, HookReceipt>();
    let hintBytes = 0;
    const epoch = capability.branchEpoch();
    for (const { rule: effective, seed } of [...hits].sort((a, b) => a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0)) {
      const { rule, key } = effective;
      if (!branch.repeat.allows(key, userTurn, turn.pendingHints.get(key))) continue;
      const timeoutMs = Math.min(120_000, configFor(ctx).hooks.timeoutMs, rule.timeoutMs ?? Infinity);
      const deadline = performance.now() + timeoutMs;
      let actionAccepted = false;
      let receiptRecorded = false;
      const accept = (kind: 'hint' | 'action'): void => {
        if (rule.repeat === undefined) return;
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
      for (const action of rule.actions) {
        if (performance.now() >= deadline || ctx.signal?.aborted || branchState !== branch || turnState !== turn
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
              const controller = new AbortController();
              const discovery = capability.discover(ctx, {
                branchEpoch: epoch, seed: action.hint === undefined ? seed : `${seed}\n\n${action.hint}`,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]),
              });
              if (!discovery.accepted) continue;
              void discovery.done.catch(error => {
                if (capability.branchEpoch() === epoch) ctx.ui.notify(`Hooks: ${effective.id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
              });
              try { accept('action'); }
              catch (error) { controller.abort(); throw error; }
            }
          }
        } catch (error) {
          ctx.ui.notify(`Hooks: ${effective.id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
          if (actionAccepted && !receiptRecorded) {
            receipts.delete(key);
            break;
          }
        }
      }
    }
    return { hints: [...hints.values()], receipts: [...receipts.values()] };
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

  const acceptHintHandoff = (batch: HintBatch): void => {
    if (turnState === undefined) return;
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
        const bytes = Buffer.byteLength(section.text, 'utf8');
        if (sectionBytes + bytes > MAX_HINT_BYTES) continue;
        sections[`hook-${rule.id}`] = section.text;
        sectionBytes += bytes;
      }
    }
    applySystemPromptSections(target, sections, Object.keys(target).filter(key => key.startsWith('hook-')));
    if (event.messageType !== 'user') return undefined;
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
      for (const receipt of readHintReceipts(event.message.details)) {
        const pending = turnState.pendingHints.get(receipt.key);
        const index = pending?.findIndex(candidate => candidate.turn === receipt.turn) ?? -1;
        if (pending === undefined || index < 0) continue;
        pending.splice(index, 1);
        if (pending.length === 0) turnState.pendingHints.delete(receipt.key);
        branchState.repeat.accept(receipt.key, receipt.turn);
      }
    }
  });
  pi.on('session_compact', () => {
    branchState?.repeat.compact();
    if (turnState === undefined) return;
    turnState.counters = turnCounters();
    turnState.nested.clear();
  });

  installToolObservation(pi, (observation, _event, ctx) => {
    if (branchState === undefined || turnState === undefined || ctx.signal?.aborted) return;
    const branch = branchState;
    const state = turnState;
    if (state.counters !== undefined) countObservation(state.counters, observation);
    const inherited = state.nested.get(observation.callId) ?? new Map<string, MatchedRule>();
    state.nested.delete(observation.callId);
    if (observation.status === 'cancelled' || observation.status === 'unfinished') return;
    for (const match of matches('tool_result', {
      tool: observation.toolName, nested: observation.isNested, result: observationResult(observation),
      ...(observation.input === undefined ? {} : { input: observation.input }),
      ...(branch.bashIsPosix && observation.toolName === 'bash' ? { shell: 'posix' } : {}),
    }, ctx, observation.toolName)) {
      if (!inherited.has(match.rule.id)) inherited.set(match.rule.id, match);
    }
    if (observation.parentCallId !== undefined) {
      if (inherited.size === 0) return;
      const parent = state.nested.get(observation.parentCallId);
      if (parent !== undefined) for (const [id, match] of inherited) { if (!parent.has(id)) parent.set(id, match); }
      else if (state.nested.size < MAX_MATCH_PARENTS) state.nested.set(observation.parentCallId, inherited);
      return;
    }
    const canDeliverHint = () => turnState === state && branchState === branch && !ctx.isIdle() && !ctx.signal?.aborted;
    const batch = runBatch(inherited.values(), ctx, canDeliverHint);
    if (batch.hints.length > 0 && canDeliverHint()) {
      // Already-executed tool boundary; steering here rides the active SDK run.
      const message = hintMessage(batch, ctx);
      acceptHintHandoff(batch);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: 'steer' });
    }
  });
}
