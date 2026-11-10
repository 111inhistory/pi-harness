/**
 * Assembly of the Harness RPC endpoint for one root host.
 *
 * The endpoint exists only when the root host actually runs in RPC mode
 * (`ctx.mode === "rpc"`). TUI, print and JSON hosts — and the internal SDK child
 * sessions, which default to print mode — never create, listen on or publish it.
 * The endpoint is a separate address from `Main.sock`, the Agent endpoints and
 * the broadcast endpoints, and it reuses the managed-IPC ownership and cleanup.
 *
 * Endpoint creation failure is reported to the caller and never claimed as a
 * working Harness interface. The RPC host itself is not prevented from starting;
 * the handle simply reports `available: false` with the reason.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { RootService } from '../subagent/root-service.ts';
import { createHarnessRpcServer, type HarnessRpcServer } from './transport.ts';
import { harnessRpcTarget, publishHarnessRpcRecord, removeHarnessRpcRecord, type HarnessRpcTarget } from './discovery.ts';
import { buildToolPort } from './ports/tool-info.ts';
import { buildSubagentPort } from './ports/subagent.ts';
import { buildHistoryPort } from './ports/history.ts';
import { buildStreamPort } from './ports/stream.ts';
import { createRouter } from './router.ts';

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
}

/** The single source of truth for the RPC-mode gate. */
export function harnessRpcEnabled(mode: string | undefined): boolean {
  return mode === 'rpc';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(ctx: ExtensionContext, message: string): void {
  try {
    ctx.ui.notify(message, 'error');
  } catch {
    /* A UI failure must not turn a reported endpoint error into a silent one. */
  }
}

function disabledHandle(): HarnessRpcHandle {
  return {
    enabled: false,
    address: null,
    ready: () => Promise.resolve(),
    close: () => Promise.resolve(),
    status: () => ({ enabled: false, available: false, address: null }),
  };
}

/**
 * Install the endpoint for `root`, or return a disabled handle outside RPC mode.
 * The caller owns lifecycle: call `close()` before the root retires or the host
 * shuts down, and install a fresh handle after a root switch.
 */
export function installHarnessRpc(api: ExtensionAPI, ctx: ExtensionContext, root: RootService): HarnessRpcHandle {
  if (!harnessRpcEnabled(ctx.mode)) return disabledHandle();

  const target: HarnessRpcTarget = harnessRpcTarget(root.socketRoot, root.sessionId);
  const router = createRouter({
    sessionId: root.sessionId,
    tool: buildToolPort(api, ctx),
    subagent: buildSubagentPort(api, ctx, root),
    history: buildHistoryPort(root),
    stream: buildStreamPort(root),
  });
  const server: HarnessRpcServer = createHarnessRpcServer({
    address: target.address,
    root: root.socketRoot,
    handler: router,
    onError: (error) => report(ctx, `Harness RPC endpoint error: ${messageOf(error)}`),
  });

  let available = false;
  let failure: string | undefined;
  const ready = server.ready
    .then(() => {
      available = true;
      try {
        publishHarnessRpcRecord(target, root.sessionId);
      } catch (error) {
        failure = `Harness RPC endpoint is bound but its discovery record could not be published: ${messageOf(error)}`;
        report(ctx, failure);
      }
    })
    .catch((error: unknown) => {
      available = false;
      failure = `The Harness RPC endpoint could not be created: ${messageOf(error)}`;
      report(ctx, failure);
    });

  return {
    enabled: true,
    address: target.address,
    ready: () => ready,
    async close() {
      await server.close();
      try {
        removeHarnessRpcRecord(target);
      } catch (error) {
        report(ctx, `Harness RPC discovery record could not be removed: ${messageOf(error)}`);
      }
    },
    status: () => ({
      enabled: true,
      available,
      address: target.address,
      ...(failure === undefined ? {} : { error: failure }),
    }),
  };
}
