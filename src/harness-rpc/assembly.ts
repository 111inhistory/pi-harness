import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RootService } from '../subagent/root-service.ts';
import type { SdkMainControls } from '../session/main-controls.ts';
import type { RpcSessionBinding } from '../session/rpc-binding.ts';
import { RpcRequestError } from './error.ts';
import { RPC_METHODS } from './protocol.ts';
import { buildApplicationPort } from './ports/application.ts';
import { buildMainPort } from './ports/main.ts';
import { createHarnessRpcServer } from './transport.ts';
import { harnessRpcTarget, publishHarnessRpcRecord, removeHarnessRpcRecord, type HarnessRpcTarget } from './discovery.ts';
import { buildToolPort } from './ports/tool-info.ts';
import { buildSubagentPort } from './ports/subagent.ts';
import { buildHistoryPort } from './ports/history.ts';
import { buildStreamPort } from './ports/stream.ts';
import { createRouter, type RouterDeps } from './router.ts';

export interface HarnessRpcStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly address: string | null;
  readonly error?: string;
}

export interface HarnessRpcHandle {
  readonly enabled: boolean;
  readonly address: string | null;
  ready(): Promise<void>;
  close(): Promise<void>;
  status(): HarnessRpcStatus;
  generation(): number;
  bindRoot(binding: RpcSessionBinding): number;
  suspend(): void;
}

export interface HarnessRpcHostAccess {
  controls(): SdkMainControls | undefined;
}

export function harnessRpcEnabled(mode: string | undefined): boolean { return mode === 'rpc'; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function report(ctx: ExtensionContext | undefined, message: string): void {
  try { ctx?.ui.notify(message, 'error'); } catch { /* Status remains observable if presentation fails. */ }
}

/** The host owns the listener; a Root transition replaces only the domain binding. */
export function installHarnessRpc(
  api: ExtensionAPI, ctx: ExtensionContext, root: RootService, assertSession: () => void,
  access?: HarnessRpcHostAccess,
): HarnessRpcHandle {
  let generation = 1;
  if (!harnessRpcEnabled(ctx.mode)) return {
    enabled: false, address: null, ready: async () => {}, close: async () => {},
    status: () => ({ enabled: false, available: false, address: null }),
    generation: () => generation, bindRoot: () => ++generation, suspend() {},
  };
  const endpoint = harnessRpcTarget(root.socketRoot, root.sessionId);
  const makeSlot = (binding: RpcSessionBinding) => ({
    binding,
    tool: buildToolPort(binding.api, binding.ctx),
    subagent: buildSubagentPort(binding.api, binding.ctx, binding.root),
    history: buildHistoryPort(binding.root),
    stream: buildStreamPort(binding.root),
    application: buildApplicationPort(binding.api, binding.ctx, binding.root, binding.assertSession),
  });
  let slot: ReturnType<typeof makeSlot> | undefined = makeSlot({ api, ctx, root, assertSession });
  const current = () => {
    if (slot === undefined) throw new RpcRequestError('runtime_transitioning', 'No active session is bound.');
    slot.binding.assertSession();
    return slot;
  };
  const deps: RouterDeps = {
    get sessionId() { return current().binding.root.sessionId; },
    get tool() { return current().tool; }, get subagent() { return current().subagent; },
    get history() { return current().history; }, get stream() { return current().stream; },
    get application() { return current().application; },
  };
  const main = buildMainPort({
    binding: () => slot?.binding, controls: () => access?.controls(), generation: () => generation,
    async recover(previous) {
      if (slot !== undefined) return;
      const controls = access?.controls();
      if (controls?.state().sessionId !== previous.root.sessionId || previous.resume === undefined) {
        throw new RpcRequestError('unavailable', 'The host cannot recover the canceled session transition.');
      }
      await previous.resume();
    },
  });
  const router = createRouter(deps, main);
  const server = createHarnessRpcServer({
    address: endpoint.address, root: root.socketRoot,
    isControlRequest: request => [RPC_METHODS.subagentStop, RPC_METHODS.streamUnsubscribe,
      RPC_METHODS.approvalsRespond, RPC_METHODS.mainInterrupt].some(method => method === request.method),
    handler: async (request, connection) => {
      try { return await router(request, connection); }
      catch (error) {
        // SDK file extensions load domains in a fresh Jiti module graph. Use
        // the domain error discriminant across that constructor boundary.
        if (error instanceof Error
          && (error.name === 'SubagentError' || error.name === 'MainControlError')
          && 'code' in error && typeof error.code === 'string') {
          throw new RpcRequestError(error.code, error.message, 'detail' in error ? error.detail : undefined);
        }
        throw error;
      }
    },
    onError: error => report(slot?.binding.ctx, `Harness RPC endpoint error: ${messageOf(error)}`),
  });
  let available = false;
  let closed = false;
  let failure: string | undefined;
  let record: HarnessRpcTarget | undefined;
  const removeRecord = () => {
    if (record === undefined) return;
    removeHarnessRpcRecord(record);
    record = undefined;
  };
  const publish = () => {
    if (!available || closed || slot === undefined) return;
    const bound = slot.binding;
    // Discovery follows the active Root while the host endpoint address is stable.
    const nextRecord = { ...harnessRpcTarget(bound.root.socketRoot, bound.root.sessionId), address: endpoint.address };
    publishHarnessRpcRecord(nextRecord, bound.root.sessionId);
    record = nextRecord;
    failure = undefined;
  };
  const ready = server.ready.then(() => {
    if (closed) return;
    available = true;
    publish();
  }).catch((error: unknown) => {
    failure = `Harness RPC startup failed: ${messageOf(error)}`;
    report(slot?.binding.ctx, failure);
  });
  return {
    enabled: true, address: endpoint.address, ready: () => ready, generation: () => generation,
    bindRoot(binding) {
      if (closed) throw new RpcRequestError('unavailable', 'The RPC host has closed.');
      server.releaseRootSubscriptions();
      slot = makeSlot(binding);
      generation++;
      try {
        removeRecord();
        publish();
      } catch (error) {
        failure = `Harness RPC discovery update failed: ${messageOf(error)}`;
        report(binding.ctx, failure);
      }
      return generation;
    },
    suspend() {
      const context = slot?.binding.ctx;
      slot = undefined;
      server.releaseRootSubscriptions();
      try { removeRecord(); }
      catch (error) {
        failure = `Harness RPC discovery cleanup failed: ${messageOf(error)}`;
        report(context, failure);
      }
    },
    async close() {
      closed = true;
      slot = undefined;
      available = false;
      await server.close();
      removeRecord();
    },
    status: () => ({ enabled: true, available: available && failure === undefined,
      address: endpoint.address, ...(failure === undefined ? {} : { error: failure }) }),
  };
}
