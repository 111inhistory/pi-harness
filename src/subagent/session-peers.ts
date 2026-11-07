import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { enableCapabilityTargets } from '../capability/enable.ts';
import { ipc } from '../ipc/platform.ts';
import { deriveSessionUid, endpointKey, getAgentSocketPath } from '../ipc/socket.ts';
import type { SessionEndpoint } from './message-write.ts';
import { SubagentError } from './runtime.ts';
import {
  liveSessions,
  registerSession,
  sendToSessionEndpoint,
  sessionMainAddress,
  unregisterSession,
  updateSessionName,
  type LiveSession,
} from './session-directory.ts';

/** The custom context message a user-issued connect appends to this session. */
export const SESSION_CONTACT = 'subagent-session-contact';

/** One peer session made reachable from this agent, with its grant outcome. */
export interface SessionConnect {
  readonly session: LiveSession;
  /** The peer's managed `Main` address, as written into the contact message. */
  readonly address: string;
  /** Tools this connect made usable through the shared enable path. */
  readonly enabled: readonly string[];
  readonly alreadyEnabled: readonly string[];
  /** Set when the branch record failed: the grant is not durable. */
  readonly recordError: string | null;
}

export interface SessionPeersOptions {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  /** The shared socket root every live session of this user publishes under. */
  readonly root: string;
  readonly sessionId: string;
  /** The owning root's admission check; a retired root must not act. */
  assertOperational(): void;
  /** Wait for a native compaction that rewrites the context, if one is open. */
  waitForCompaction(): Promise<void>;
  report(error: Error): void;
}

/**
 * The contact message itself: identity, working directory and reply address.
 * It states that nothing was sent, so a later turn does not mistake the
 * information for an already-open conversation.
 */
function contactMessage(session: LiveSession, address: string): string {
  const name = session.name === null ? '(unnamed)' : session.name;
  return [
    'The user connected a live Pi session to this conversation.',
    `- uid: ${session.uid}`,
    `- session: ${session.sessionId}`,
    `- name: ${name}`,
    `- cwd: ${session.cwd}`,
    `- Main address: ${address}`,
    '',
    'Use msg_write with that address to message this session. Nothing has been sent to it yet.',
  ].join('\n');
}

const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/**
 * Cross-session peer operations for one root.
 *
 * The directory owns publication and discovery; this class is the root's view
 * of it. It classifies managed addresses, makes one user-named peer reachable,
 * mirrors the native session name, delivers Main-to-Main messages and removes
 * this session's own record on retirement. Ownership checks and the compaction
 * gate stay with the root and arrive as callbacks, so a retired or detached
 * root never acts on a peer through this object.
 */
export class SessionPeers {
  readonly #options: SessionPeersOptions;

  constructor(options: SessionPeersOptions) {
    this.#options = options;
  }

  /** Live sessions reachable from here, including this one. */
  list(): Promise<LiveSession[]> {
    return liveSessions(this.#options.root);
  }

  /**
   * Classify a managed address against this root and the shared directory.
   *
   * This is the one place that decides whether an address is local, another
   * live session's Main, or another session's non-Main endpoint. This session's
   * own addresses are local: its Main is managed by this root, so the caller
   * never reaches the cross-session path for it. Whether an address belongs to
   * a session's endpoint namespace is the IPC platform adapter's answer, not a
   * filesystem assumption made here.
   */
  async endpoint(address: string): Promise<SessionEndpoint> {
    const live = await liveSessions(this.#options.root);
    for (const session of live) {
      if (session.sessionId === this.#options.sessionId) continue;
      if (endpointKey(address) === endpointKey(getAgentSocketPath('Main', session.socketDir))) {
        return { kind: 'session', session };
      }
    }
    for (const session of live) {
      if (session.sessionId === this.#options.sessionId) continue;
      if (ipc.belongsToNamespace(address, session.socketDir)) return { kind: 'foreign' };
    }
    return { kind: 'local' };
  }

  /**
   * Make one live peer session reachable from this agent.
   *
   * The user named the session, so this call is itself the explicit grant for
   * `msg_write`: it goes through the same enable path as `/capability enable`,
   * which is the only path allowed to authorize a manual tool. Nothing is sent
   * to the target, no pairing or connection state is kept, and the contact is an
   * ordinary custom context message: it starts no turn and rewrites no prompt
   * head. Receiving a peer message stays a separate, receipt-scoped activation.
   */
  async connect(target: string): Promise<SessionConnect> {
    this.#options.assertOperational();
    const wanted = target.trim();
    if (wanted === '') {
      throw new SubagentError('invalid_command_args', 'connect requires one live session uid or session id.');
    }
    const session = (await liveSessions(this.#options.root))
      .find((candidate) => candidate.uid === wanted || candidate.sessionId === wanted);
    if (session === undefined) {
      throw new SubagentError('session_not_found', `No live session matches ${wanted}.`);
    }
    if (session.sessionId === this.#options.sessionId) {
      throw new SubagentError('invalid_target', 'A session cannot connect to itself.');
    }
    // The directory read awaited; a root that lost its branch must not write.
    this.#options.assertOperational();
    // A native compaction rewrites the context, so append after it finishes.
    await this.#options.waitForCompaction();
    this.#options.assertOperational();
    // Everything below is synchronous: no await may separate the ownership
    // check from the branch record and the context append it fences.
    const activation = enableCapabilityTargets(this.#options.api, ['msg_write'], {
      branch: this.#options.context.sessionManager.getBranch(),
    });
    const usable = [...activation.enabled, ...activation.alreadyEnabled];
    if (!usable.includes('msg_write')) {
      const reason = activation.skipped.find((skip) => skip.name === 'msg_write')?.reason
        ?? (activation.unresolved.includes('msg_write') ? 'not_registered' : 'not_activated');
      throw new SubagentError('msg_write_unavailable', `msg_write cannot be enabled for this session: ${reason}.`);
    }
    const address = sessionMainAddress(session);
    this.#options.api.sendMessage({
      customType: SESSION_CONTACT,
      content: contactMessage(session, address),
      display: true,
    }, { triggerTurn: false });
    return {
      session,
      address,
      enabled: activation.enabled,
      alreadyEnabled: activation.alreadyEnabled,
      recordError: activation.recordError,
    };
  }

  /**
   * Mirror a native session rename into the shared directory.
   *
   * The SDK reports the new name; this session owns its record, so it rewrites
   * only the name and keeps the rest of the published identity. Reachability is
   * auxiliary: a failed update is reported, never fatal.
   */
  async syncName(name: string | null): Promise<void> {
    try {
      await updateSessionName(this.#options.root, { sessionId: this.#options.sessionId, name });
    } catch (error) {
      this.#options.report(new Error(`This session's published name was not updated: ${errorOf(error).message}`));
    }
  }

  /**
   * Deliver one message to another live session's Main.
   *
   * The receiving root owns admission: this call only frames the sender and
   * writes one NDJSON request to the target's managed Main endpoint. An error
   * response, a timeout or a disconnect does not prove the message was not
   * handed over, so nothing is retried here.
   */
  async send(command: {
    readonly target: LiveSession;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    this.#options.assertOperational();
    return sendToSessionEndpoint({
      sender: { sessionId: this.#options.sessionId, uid: deriveSessionUid(this.#options.sessionId) },
      ...command,
    });
  }

  /**
   * Publish this session for cross-session addressing. Reachability is
   * auxiliary: a failed publish is reported, and this root keeps running.
   */
  async publish(): Promise<void> {
    try {
      await registerSession(this.#options.root, {
        sessionId: this.#options.sessionId,
        cwd: this.#options.context.cwd,
        name: this.#options.context.sessionManager.getSessionName() ?? null,
      });
    } catch (error) {
      this.#options.report(new Error(`This session is not reachable from other sessions: ${errorOf(error).message}`));
    }
  }

  /** Remove this session's own record; the return value says whether it did. */
  close(): Promise<boolean> {
    return unregisterSession(this.#options.root, this.#options.sessionId);
  }
}
