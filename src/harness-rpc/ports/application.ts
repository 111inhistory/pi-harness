import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  loadPresets, currentPresetView, applyPresetToSession, clearPresetFromSession,
} from '../../preset/application.ts';
import type { PresetApplyOutcome as DomainPresetApplyOutcome } from '../../preset/apply.ts';
import { shellApprovalController } from '../../shell-approval/extension.ts';
import { hookInspection } from '../../hooks/inspection.ts';
import type { RootService } from '../../subagent/root-service.ts';
import type { MethodParams, MethodResult } from '../contract.ts';
import type { PresetSnapshot } from '../../preset/state.ts';
import type { RpcConnection } from '../transport.ts';
import { RpcRequestError } from '../error.ts';
import { RPC_ERROR } from '../protocol.ts';

/**
 * Project the domain outcome onto the wire shape. A version mismatch is a
 * refusal, not a partial success: the caller raises it as an RPC error before
 * this projection, so the remaining problems are the applied/failed effects.
 */
function toRpcApplyOutcome(outcome: DomainPresetApplyOutcome): MethodResult<'presets.apply'> {
  return {
    applied: outcome.applied,
    unchanged: outcome.unchanged,
    snapshot: snapshotOnWire(outcome.snapshot),
    contentHash: outcome.snapshot?.contentHash ?? null,
    issues: [...outcome.issues],
    problems: outcome.problems.flatMap(problem =>
      problem.kind === 'version_mismatch' || problem.kind === 'context_changed' ? [] : [problem]),
  };
}

// Keep the v1 RPC shape independent of internal Hook definitions and prompt text.
function snapshotOnWire(snapshot: PresetSnapshot | null) {
  if (snapshot === null || snapshot.hooks === undefined) return snapshot;
  const { hooks: _hooks, ...view } = snapshot;
  return view;
}

/** Adapts existing session operations; all business state remains in its domain. */
export function buildApplicationPort(api: ExtensionAPI, ctx: ExtensionContext, root: RootService, assertSession: () => void) {
  const host = {
    pi: api, getBranch: () => ctx.sessionManager.getBranch(), modelRegistry: ctx.modelRegistry,
    selectModel: (model: Parameters<ExtensionAPI['setModel']>[0]) => api.setModel(model),
    // The shared apply re-checks this after the awaited model selection. The
    // check is reported as a context_changed refusal instead of escaping as an
    // exception, so nothing is written and the branch change stays explicit.
    assertSession(): string | null {
      try {
        assertSession();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
  const catalog = () => loadPresets({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
  const controller = () => {
    assertSession();
    const value = shellApprovalController(api);
    if (value === undefined) throw new RpcRequestError(RPC_ERROR.unavailable, 'Shell approval is not available in this session.');
    return value;
  };
  return {
    hooksCurrent(): MethodResult<'hooks.current'> {
      assertSession();
      const result = hookInspection(api)?.current(ctx);
      if (result === undefined) throw new RpcRequestError(RPC_ERROR.unavailable, 'Hooks are not available in this session.');
      return result;
    },
    hooksStats(): MethodResult<'hooks.stats'> {
      assertSession();
      const result = hookInspection(api)?.stats();
      if (result === undefined) throw new RpcRequestError(RPC_ERROR.unavailable, 'Hook statistics are not available in this session.');
      return result;
    },
    presetsCatalog(): MethodResult<'presets.catalog'> {
      assertSession();
      const loaded = catalog();
      return { presets: [...loaded.presets].map(([name, { hooks: _hooks, ...config }]) => ({ name, config })), warnings: loaded.warnings };
    },
    presetsCurrent(): MethodResult<'presets.current'> {
      assertSession();
      // Strictly read-only: the candidate comparison must not capture a
      // capability-tool-base record on the branch.
      const loaded = catalog();
      const view = currentPresetView(host, loaded);
      return {
        preset: snapshotOnWire(view.preset),
        status: view.status,
        currentVersion: view.currentVersion,
        changes: [...view.changes],
      };
    },
    async presetsApply(params: MethodParams<'presets.apply'>): Promise<MethodResult<'presets.apply'>> {
      assertSession();
      const loaded = catalog();
      const config = loaded.presets.get(params.name);
      if (config === undefined) {
        const detail = { warnings: loaded.warnings };
        throw new RpcRequestError(
          RPC_ERROR.notFound,
          loaded.invalidNames.has(params.name) || loaded.invalidDocument
            ? `Preset "${params.name}" is invalid in the current configuration.`
            : `No Preset named "${params.name}".`,
          detail,
        );
      }
      const outcome = await applyPresetToSession(
        host, params.name, config,
        params.expectedVersion === undefined ? undefined : { expectedVersion: params.expectedVersion },
      );
      // Admission and context refusals wrote nothing, so expose them as RPC
      // errors rather than a synthetic partial apply.
      for (const problem of outcome.problems) {
        if (problem.kind === 'version_mismatch') {
          throw new RpcRequestError(
            RPC_ERROR.presetVersionMismatch,
            `Preset "${params.name}" changed since the expected version.`,
            { expectedVersion: problem.expected, currentVersion: problem.actual },
          );
        }
        if (problem.kind === 'context_changed') {
          throw new RpcRequestError('runtime_transitioning', problem.detail);
        }
      }
      return toRpcApplyOutcome(outcome);
    },
    presetsClear(): MethodResult<'presets.clear'> {
      assertSession();
      return clearPresetFromSession(host);
    },
    approvalsList(): MethodResult<'approvals.list'> { return { items: controller().list() }; },
    approvalsGet(params: MethodParams<'approvals.get'>): MethodResult<'approvals.get'> {
      return { item: controller().get(params.id) ?? null };
    },
    approvalsRespond(params: MethodParams<'approvals.respond'>): MethodResult<'approvals.respond'> {
      return controller().respond(params.id, params.decision);
    },
    approvalsSubscribe(connection: RpcConnection): MethodResult<'approvals.subscribe'> {
      const approvals = controller();
      let unsubscribe: (() => void) | undefined;
      const subscription = connection.addSubscription(() => unsubscribe?.());
      unsubscribe = approvals.subscribe(items => connection.pushEvent(subscription, {
        kind: 'approvals', rootSessionId: root.sessionId, items,
      }));
      return { subscription, items: approvals.list() };
    },
    async sessionsList(): Promise<MethodResult<'sessions.list'>> { return { sessions: await root.listSessions() }; },
    sessionsConnect(params: MethodParams<'sessions.connect'>): Promise<MethodResult<'sessions.connect'>> {
      return root.connectSession(params.target);
    },
  };
}

export type ApplicationPort = ReturnType<typeof buildApplicationPort>;
