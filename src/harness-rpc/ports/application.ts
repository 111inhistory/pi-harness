import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadPresets, currentPreset, applyPresetToSession, clearPresetFromSession } from '../../preset/application.ts';
import { shellApprovalController } from '../../shell-approval/extension.ts';
import type { RootService } from '../../subagent/root-service.ts';
import type { MethodParams, MethodResult } from '../contract.ts';
import type { RpcConnection } from '../transport.ts';
import { RpcRequestError } from '../error.ts';
import { RPC_ERROR } from '../protocol.ts';

/** Adapts existing session operations; all business state remains in its domain. */
export function buildApplicationPort(api: ExtensionAPI, ctx: ExtensionContext, root: RootService, assertSession: () => void) {
  const host = {
    pi: api, getBranch: () => ctx.sessionManager.getBranch(), modelRegistry: ctx.modelRegistry,
    async selectModel(model: Parameters<ExtensionAPI['setModel']>[0]) {
      const selected = await api.setModel(model);
      // Native UI navigation can change this branch while SDK auth is pending.
      assertSession();
      return selected;
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
    presetsCatalog(): MethodResult<'presets.catalog'> {
      assertSession();
      const loaded = catalog();
      return { presets: [...loaded.presets].map(([name, config]) => ({ name, config })), warnings: loaded.warnings };
    },
    presetsCurrent(): MethodResult<'presets.current'> {
      assertSession();
      return { preset: currentPreset(host) };
    },
    async presetsApply(params: MethodParams<'presets.apply'>): Promise<MethodResult<'presets.apply'>> {
      assertSession();
      const loaded = catalog();
      const config = loaded.presets.get(params.name);
      if (config === undefined) throw new RpcRequestError(RPC_ERROR.notFound, `No Preset named "${params.name}".`, { warnings: loaded.warnings });
      return applyPresetToSession(host, params.name, config);
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
