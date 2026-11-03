import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_HARNESS_CONFIG, harnessConfigFor } from '../harness-config.ts';
import { ServiceLifecycle } from './lifecycle.ts';
import { RootService } from './root-service.ts';
import { argumentCompletionProvider } from '../autocomplete.ts';
import { installSubagentCommand } from './command.ts';
import { installSessionSurface } from './surface.ts';
import { SubagentError } from './runtime.ts';

/** Composition and SDK lifecycle hooks only; no Job loop or transport logic. */
export default function subagentExtension(api: ExtensionAPI): void {
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

  let autocompleteInstalled = false;
  api.on('session_start', async (_event, ctx) => {
    epoch += 1;
    // The editor's Tab request skips slash-command arguments; restore them for
    // /subagent without touching other commands' file completion.
    if (!autocompleteInstalled) {
      autocompleteInstalled = true;
      ctx.ui.addAutocompleteProvider((base) => argumentCompletionProvider(base, 'subagent'));
    }
    await activate(ctx);
  });
  api.on('session_tree', async (_event, ctx) => { epoch += 1; await activate(ctx); });
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
  // The root surface is depth 0, below every valid configured maximum depth, so
  // its own create/stop registration does not depend on the resolved value.
  installSubagentCommand(api, current);
  installSessionSurface(api, current, {
    callerId: 'Main',
    depth: 0,
    allowInherited: true,
    cwd: process.cwd(),
    maxDepth: DEFAULT_HARNESS_CONFIG.subagent.maxDepth,
    capacityFor: (ctx) => configFor(ctx).subagent,
  });
}
