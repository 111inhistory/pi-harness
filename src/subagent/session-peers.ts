import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { addBaseTools } from '../capability/tool-access.ts';
import { deriveSessionUid } from '../ipc/socket.ts';
import { formatAddress, MAIN_ACTOR, parseAddress } from './address.ts';
import type { ResolvedTarget } from './managed-send.ts';
import { SubagentError } from './runtime.ts';
import {
  liveSessions,
  registerSession,
  sendToSessionEndpoint,
  unregisterSession,
  updateSessionName,
  type LiveSession,
} from './session-directory.ts';

/** The custom context message a user-issued connect appends to this session. */
export const SESSION_CONTACT = 'subagent-session-contact';

/** One peer session made reachable from this agent, with its grant outcome. */
export interface SessionConnect {
  readonly session: LiveSession;
  /** The peer's logical Main address, as written into the contact message. */
  readonly address: string;
  /** Tools this connect made usable by adding them to the session base. */
  readonly enabled: readonly string[];
  readonly alreadyEnabled: readonly string[];
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
    `- address: ${address}`,
    '',
    'Use msg_write with that address to message this session Main. Nothing has been sent to it yet.',
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
   * Classify one logical address against this root and the shared directory.
   *
   * This session's addresses are local: Runtime owns actor, batch and children
   * routing, so the caller never reaches the cross-session path for them.
   * Another live session is reachable only at its Main; anything else under a
   * foreign session hex is refused instead of being guessed at.
   */
  async target(address: string): Promise<ResolvedTarget> {
    const parsed = parseAddress(address);
    if (parsed === null) return { kind: 'foreign' };
    if (parsed.session === deriveSessionUid(this.#options.sessionId)) return { kind: 'local' };
    const session = (await liveSessions(this.#options.root)).find((candidate) => candidate.uid === parsed.session);
    if (session === undefined) return { kind: 'unknown' };
    return parsed.kind === 'actor' && parsed.key === MAIN_ACTOR
      ? { kind: 'session', session }
      : { kind: 'foreign' };
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
    const activation = addBaseTools(this.#options.api, this.#options.api, this.#options.context.sessionManager.getBranch(), ['msg_write']);
    // The reported enablement is the base membership this connect recorded;
    // activation only decides whether the model can call it right now.
    const enabled = [...new Set(activation.changed.flatMap((change) => change.affectedTools))];
    const usable = [...activation.activated, ...activation.alreadyActive];
    if (!usable.includes('msg_write')) {
      // A record write failure is fail-closed: no active slot changed, so the
      // contact must not carry an address the model cannot use.
      const reason = activation.recordError !== null
        ? `the base record could not be written: ${activation.recordError}`
        : activation.skipped.find((skip) => skip.target === 'msg_write')?.reason
          ?? (activation.unresolved.includes('msg_write') ? 'not_registered' : 'not_activated');
      throw new SubagentError('msg_write_unavailable', `msg_write cannot be made available for this session: ${reason}.`);
    }
    const address = formatAddress(session.uid, MAIN_ACTOR);
    this.#options.api.sendMessage({
      customType: SESSION_CONTACT,
      content: contactMessage(session, address),
      display: true,
    }, { triggerTurn: false });
    return {
      session,
      address,
      enabled,
      alreadyEnabled: activation.alreadySet,
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
    readonly to: string;
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
