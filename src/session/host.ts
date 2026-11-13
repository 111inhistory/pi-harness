import type { AgentSessionRuntime, ExtensionAPI, ExtensionFactory, InlineExtension } from '@earendil-works/pi-coding-agent';
import { installHarnessRpc, type HarnessRpcHandle, type HarnessRpcStatus } from '../harness-rpc/assembly.ts';
import { createSdkMainControls, type SdkMainControls } from './main-controls.ts';
import type { RpcSessionBinding } from './rpc-binding.ts';

const HOST_CHANNEL = 'harness:session-host';
interface HostExchange { host?: HarnessSessionHost; }

/** ResourceLoader-local lookup; the embedding application explicitly supplies the owner. */
export function harnessSessionHost(api: ExtensionAPI): HarnessSessionHost | undefined {
  const exchange: HostExchange = {};
  api.events.emit(HOST_CHANNEL, exchange);
  return exchange.host;
}

export interface HarnessSessionHost {
  readonly extension: InlineExtension;
  bindRuntime(runtime: AgentSessionRuntime): void;
  bindRoot(binding: RpcSessionBinding): number;
  ready(): Promise<void>;
  suspend(lease: number): void;
  shutdown(lease: number, quit: boolean): Promise<void>;
  status(): HarnessRpcStatus;
  dispose(): Promise<void>;
}

/**
 * Own only SDK references, RPC resources and their binding lifetime. The caller
 * owns the SDK runtime and its normal rebind callback; domains own business state.
 */
export function createHarnessSessionHost(): HarnessSessionHost {
  let runtime: AgentSessionRuntime | undefined;
  let controls: SdkMainControls | undefined;
  let rpc: HarnessRpcHandle | undefined;
  let disposed = false;
  const bridges = new Set<() => void>();
  const bridge: ExtensionFactory = api => {
    const releaseBus = api.events.on(HOST_CHANNEL, data => { (data as HostExchange).host = host; });
    let releaseShutdown: (() => void) | undefined;
    const release = () => { releaseBus(); releaseShutdown?.(); bridges.delete(release); };
    releaseShutdown = api.on('session_shutdown', release);
    bridges.add(release);
  };
  const host: HarnessSessionHost = {
    extension: { name: 'harness-session-host', factory: bridge },
    bindRuntime(next) {
      if (disposed) throw new Error('The Harness host is disposed.');
      if (runtime !== undefined && runtime !== next) throw new Error('The Harness host already owns another runtime binding.');
      runtime = next;
      if (controls === undefined) controls = createSdkMainControls({ session: next.session, runtime: next });
      else controls.bindSession(next.session);
    },
    bindRoot(binding) {
      if (disposed) throw new Error('The Harness host is disposed.');
      if (runtime !== undefined) controls?.bindSession(runtime.session);
      if (rpc === undefined) rpc = installHarnessRpc(binding.api, binding.ctx, binding.root, binding.assertSession,
        { controls: () => controls });
      return rpc.bindRoot(binding);
    },
    async ready() {
      await rpc?.ready();
      const status = host.status();
      if (status.enabled && !status.available) throw new Error(status.error ?? 'The Harness RPC endpoint is unavailable.');
    },
    suspend(lease) { if (rpc?.generation() === lease) rpc.suspend(); },
    async shutdown(lease, quit) {
      if (rpc?.generation() !== lease) return;
      rpc.suspend();
      controls?.bindSession(undefined);
      if (quit) await host.dispose();
    },
    status: () => rpc?.status() ?? { enabled: false, available: false, address: null },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of bridges) release();
      controls?.dispose();
      controls = undefined;
      runtime = undefined;
      await rpc?.close();
      rpc = undefined;
    },
  };
  return host;
}
