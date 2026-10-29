import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ServiceLifecycle } from './lifecycle.ts';
import { RootService } from './root-service.ts';
import { installSessionSurface } from './surface.ts';
import { SubagentError } from './runtime.ts';

/** Composition and SDK lifecycle hooks only; no Job loop or transport logic. */
export default function subagentExtension(api: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const idsByRoot = new Map<string, Set<string>>();
  const lifecycle = new ServiceLifecycle<RootService>({ retire: (service) => service.retire() });
  let epoch = 0;
  let transitionPending = false;
  const report = (ctx: ExtensionContext, error: unknown): void => {
    try { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    catch { /* UI failure must never turn a rejected transition into approval. */ }
  };

  const activate = async (ctx: ExtensionContext): Promise<RootService> => {
    transitionPending = false;
    return lifecycle.activate(async () => {
      const ownEpoch = ++epoch;
      const id = ctx.sessionManager.getSessionId();
      let allocatedIds = idsByRoot.get(id);
      if (allocatedIds === undefined) { allocatedIds = new Set(); idsByRoot.set(id, allocatedIds); }
      const service = new RootService({ api, context: ctx, agentDir, allocatedIds, ownsContext: () => epoch === ownEpoch });
      await service.initialize();
      return service;
    });
  };
  const current = async (ctx: ExtensionContext): Promise<RootService> => {
    if (transitionPending || lifecycle.retiring) throw new SubagentError('runtime_transitioning', 'The root is quiescing; no new Subagent operation is admitted.');
    const service = lifecycle.service ?? await activate(ctx);
    service.assertOperational();
    return service;
  };
  const beforeTransition = async (ctx: ExtensionContext) => {
    transitionPending = true;
    try {
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

  api.on('session_start', async (_event, ctx) => { epoch += 1; await activate(ctx); });
  api.on('session_tree', async (_event, ctx) => { epoch += 1; await activate(ctx); });
  api.on('session_before_tree', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_before_switch', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_before_fork', async (_event, ctx) => beforeTransition(ctx));
  api.on('session_shutdown', async (_event, ctx) => {
    transitionPending = true;
    try { await lifecycle.retire(); }
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
    if (transitionPending && !lifecycle.retiring) await activate(ctx);
  });
  installSessionSurface(api, current, { callerId: 'Main', depth: 0, allowInherited: true, cwd: process.cwd() });
}
