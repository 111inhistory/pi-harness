import { MAIN_ACTOR, parseAddress } from './address.ts';
import { SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';
import type { LiveSession } from './session-directory.ts';

type Receipt = MessageReceipt | BroadcastReceipt;

/** Where one logical address points for this root. */
export type ResolvedTarget =
  /** This root's own session: Runtime handles the actor/batch/children target. */
  | { readonly kind: 'local' }
  /** Another live session's Main: one main-endpoint write, never a subagent target. */
  | { readonly kind: 'session'; readonly session: LiveSession }
  /** A live session addressed outside its Main, or a non-session namespace. */
  | { readonly kind: 'foreign' }
  /** A logical address whose session is not live (or is not registered). */
  | { readonly kind: 'unknown' };

/**
 * What the root's write path needs.
 *
 * The address is a logical Agent address, never a socket path. Resolution,
 * sender binding and broadcast expansion belong to the root and the domain;
 * this module only orders the admission checks and reports the outcome.
 */
export interface ManagedWriteHost {
  resolveTarget(address: string): Promise<ResolvedTarget>;
  sendMessage(command: {
    from: string;
    to: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<Receipt>;
  /** Deliver to another live session's Main through its own endpoint. */
  sendCrossSession(command: {
    target: LiveSession;
    to: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export type ManagedSendResult = Receipt | { readonly ok: true; readonly delivered: 'session'; readonly to: string };

/** The canonical sender key: Main has one spelling; actor keys pass through. */
const senderKey = (id: string): string => id.trim().toLowerCase() === MAIN_ACTOR ? MAIN_ACTOR : id.trim();

/**
 * One address/admission path shared by tools, RPC and user controls.
 *
 * A same-root target is handed to Runtime directly; there is no loopback
 * socket. A cross-session target is only ever another session's Main and is
 * written as one frame to that session's own endpoint. Rejections are decided
 * before any write; an unknown handoff result after a write is never replayed.
 */
export async function sendManagedMessage(host: ManagedWriteHost, command: {
  readonly senderId: string; readonly to: string; readonly content: string; readonly signal?: AbortSignal;
}): Promise<ManagedSendResult> {
  const signal = command.signal;
  if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
  if (parseAddress(command.to) === null) {
    throw new SubagentError('invalid_target', 'msg_write requires a full logical Agent address.');
  }
  const from = senderKey(command.senderId);
  const target = await host.resolveTarget(command.to);
  if (target.kind === 'local') {
    const receipt = await host.sendMessage({ from, to: command.to, content: command.content,
      ...(signal === undefined ? {} : { signal }) });
    if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
    return receipt;
  }
  if (target.kind === 'session') {
    // Cross-session coordination is Main-to-Main; the receiving endpoint still
    // owns recipient admission.
    if (from !== MAIN_ACTOR) throw new SubagentError('invalid_target', 'Cross-session messages are sent by Main only.');
    await host.sendCrossSession({ target: target.session, to: command.to, content: command.content,
      ...(signal === undefined ? {} : { signal }) });
    if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
    return { ok: true, delivered: 'session', to: command.to };
  }
  if (target.kind === 'unknown') {
    throw new SubagentError('unknown_session', `No live session owns this logical address: ${command.to}`);
  }
  throw new SubagentError('invalid_target',
    'Cross-session messages are Main-to-Main only; address the other session Main.');
}
