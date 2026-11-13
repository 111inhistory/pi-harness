import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { harnessConfigFor } from '../harness-config.ts';
import { ServiceLifecycle } from '../subagent/lifecycle.ts';
import { RootService } from '../subagent/root-service.ts';
import { SubagentError } from '../subagent/runtime.ts';
import { installHarnessRpc, harnessRpcEnabled, type HarnessRpcHandle } from '../harness-rpc/index.ts';
import type { RootSubagentAccess } from '../subagent/extension.ts';

/** Own the root generation and RPC lifetime; domains keep their state and execution. */
export function installHarnessSession(api: ExtensionAPI): RootSubagentAccess {
  // Acquire the root's config provider before registering any lifecycle hook:
  // its own session reset listeners must be in place before this service starts
  // activating. Every service of one Pi surface shares that snapshot.
  const configFor = harnessConfigFor(api);
  const agentDir = getAgentDir();
  const idsByRoot = new Map<string, Set<string>>();
  const lifecycle = new ServiceLifecycle<RootService>({ retire: (service) => service.retire() });
  let epoch = 0;
  let transitionPending = false;
  const report = (ctx: ExtensionContext, error: unknown): void => {
    try { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    catch { /* UI failure must never turn a rejected transition into approval. */ }
  };

  // The Harness RPC endpoint lives beside the root service: it is installed only
  // when the root host actually runs in RPC mode, torn down before the root
  // retires, and re-installed against the new service after a root switch.
  let rpcHandle: HarnessRpcHandle | null = null;
  let rpcService: RootService | null = null;
  const closeRpc = async (ctx: ExtensionContext): Promise<void> => {
    const handle = rpcHandle;
    rpcHandle = null;
    rpcService = null;
    if (handle === null) return;
    try { await handle.close(); } catch (error) { report(ctx, error); }
  };
  const armRpc = async (ctx: ExtensionContext, service: RootService): Promise<void> => {
    if (!harnessRpcEnabled(ctx.mode)) { await closeRpc(ctx); return; }
    if (rpcHandle !== null && rpcService === service) return;
    await closeRpc(ctx);
    const ownEpoch = epoch;
    rpcHandle = installHarnessRpc(api, ctx, service, () => {
      if (transitionPending || epoch !== ownEpoch) throw new SubagentError('runtime_transitioning', 'The session is changing.');
    });
    rpcService = service;
    await rpcHandle.ready();
  };

  const activate = async (ctx: ExtensionContext): Promise<RootService> => {
    transitionPending = false;
    return lifecycle.activate(async () => {
      const ownEpoch = ++epoch;
      const id = ctx.sessionManager.getSessionId();
      let allocatedIds = idsByRoot.get(id);
      if (allocatedIds === undefined) { allocatedIds = new Set(); idsByRoot.set(id, allocatedIds); }
      const service = new RootService({
        api,
        context: ctx,
        agentDir,
        allocatedIds,
        config: configFor(ctx),
        ownsContext: () => epoch === ownEpoch,
      });
      await service.initialize();
      return service;
    });
  };
  const current = async (ctx: ExtensionContext): Promise<RootService> => {
    if (transitionPending || lifecycle.retiring) throw new SubagentError('runtime_transitioning', 'The root is quiescing; no new Subagent operation is admitted.');
    const service = lifecycle.service ?? await activate(ctx);
    service.assertCurrent();
    return service;
  };
  const beforeTransition = async (ctx: ExtensionContext) => {
    transitionPending = true;
    try {
      // Stop serving the old root's Harness RPC endpoint before its resources retire.
      await closeRpc(ctx);
      // BEFORE hooks still own the original branch. New commands are blocked,
      // but canceled Jobs must finish their one terminal append before moving.
      await lifecycle.retire();
      return undefined;
    } catch (error) {
      report(ctx, error);
      // ExtensionRunner catches thrown errors and would continue navigation.
      return { cancel: true };
    }
  };

  api.on('session_start', async (_event, ctx) => {
    epoch += 1;
    const service = await activate(ctx);
    await armRpc(ctx, service);
  });
  api.on('session_tree', async (_event, ctx) => { epoch += 1; const service = await activate(ctx); await armRpc(ctx, service); });
  api.on('session_before_compact', () => { lifecycle.service?.beginCompaction(); });
  api.on('session_compact', () => { lifecycle.service?.endCompaction(); });
  api.on('session_compact_failed', () => { lifecycle.service?.endCompaction(); });
  api.on('session_info_changed', async (event, ctx) => {
    // The native rename event is the lifecycle source; the directory mirrors it
    // so another session and /subagent sessions see the new name immediately.
    const service = lifecycle.service;
    if (service === null || transitionPending) return;
    try {
      service.assertOperational();
      await service.syncSessionName(event.name ?? null);
    } catch (error) {
      report(ctx, error);
    }
  });
  api.on('session_before_tree', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_before_switch', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_before_fork', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_shutdown', async (_event, ctx) => {
    transitionPending = true;
    try { await closeRpc(ctx); await lifecycle.retire(); }
    catch (error) { report(ctx, error); }
    finally {
      // Shutdown cannot be canceled. Late completion must never append through
      // pi.appendEntry after the SDK rebinds it to a different root/branch.
      epoch += 1;
    }
  });
  api.on('agent_start', async (_event, ctx) => {
    // A later extension may cancel a navigation after our BEFORE hook. The
    // next real root run safely reopens the stopped registry, never old Jobs.
    if (transitionPending && !lifecycle.retiring) { const service = await activate(ctx); await armRpc(ctx, service); }
  });
  return {
    current,
    configFor,
    async peers() {
      const service = lifecycle.service;
      if (service === null || transitionPending || lifecycle.retiring) return [];
      const sessions = await service.listSessions();
      if (service !== lifecycle.service || transitionPending || lifecycle.retiring) return [];
      return sessions.filter(session => session.sessionId !== service.sessionId);
    },
  };
}
