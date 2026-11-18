/**
 * Logical Subagent addresses.
 *
 * One root session owns one address space. Every address is
 * `<sessionHex>:<local segment>` where `sessionHex` is the 8-hex fold of the
 * root's native session id (`deriveSessionUid`) and the local segment names one
 * Actor, one batch group or one Actor's direct children:
 *
 * - `main`                          the root session's Main actor
 * - `sub_<batch>`                   an Actor that is alone in its batch
 * - `sub_<batch>-<member>`          one member of a multi-member batch
 * - `batch_<batch>`                 the group selector of that batch
 * - `<actor>/children`              the direct children of one Actor
 *
 * Batch numbers are session-wide, monotonic and never reused; the member index
 * is the declared position inside its batch. An Actor keeps its segment for its
 * whole life, so its address is stable across Jobs and revivals, and an address
 * of an abandoned root branch is never handed out again.
 *
 * This module is pure formatting/parsing. It binds no endpoint, resolves no
 * live resource and grants no delivery authority: routing, admission and the
 * sender rules belong to the Subagent Runtime and the root's IPC layer. The one
 * physical endpoint a root owns is `<socketDir>/main.sock`; the formatter below
 * names it without touching it.
 */

import path from 'node:path';
import { defaultSocketRoot, pipePath } from '../ipc/address.ts';

/** The local segment of a root session's Main actor. */
export const MAIN_ACTOR = "main";

/** The one physical endpoint of a root session. */
const MAIN_ENDPOINT_NAME = "main";

/** The suffix that selects an Actor's direct children. */
const CHILDREN_SUFFIX = "/children";

/** A sessionHex is the lowercase 8-hex fold of the native root session id. */
export const SESSION_PATTERN = /^[0-9a-f]{8}$/;

const KEY_PATTERN = /^sub_([1-9][0-9]*)(?:-([1-9][0-9]*))?$/;
const GROUP_PATTERN = /^batch_([1-9][0-9]*)$/;

/** The identity encoded by one Actor's local segment. */
export interface ActorKeyRef {
  readonly key: string;
  /** The session-wide batch number; null only for Main. */
  readonly batch: number | null;
  /** The declared member position inside a multi-member batch; null otherwise. */
  readonly member: number | null;
}

export interface ActorAddress extends ActorKeyRef {
  readonly kind: "actor";
  readonly session: string;
  readonly address: string;
}

export interface GroupAddress {
  readonly kind: "group";
  readonly session: string;
  readonly batch: number;
  readonly address: string;
}

export interface ChildrenAddress {
  readonly kind: "children";
  readonly session: string;
  readonly actor: ActorKeyRef;
  readonly address: string;
}

export type LogicalAddress = ActorAddress | GroupAddress | ChildrenAddress;

/** The local segment of one Actor: `sub_<batch>` or `sub_<batch>-<member>`. */
export function actorKey(batch: number, member: number | null = null): string {
  return member === null ? `sub_${batch}` : `sub_${batch}-${member}`;
}

/**
 * Parse a local segment. `main` and Actor keys are accepted; a group selector
 * or a children selector is not an Actor segment.
 */
export function parseActorKey(value: string): ActorKeyRef | null {
  if (value === MAIN_ACTOR) return { key: MAIN_ACTOR, batch: null, member: null };
  const match = KEY_PATTERN.exec(value);
  if (match === null) return null;
  const batch = Number(match[1]);
  const member = match[2] === undefined ? null : Number(match[2]);
  return { key: value, batch, member };
}

/** Format one Actor's full address. */
export function formatAddress(session: string, key: string): string {
  return `${session}:${key}`;
}

/** Format one batch's group selector. */
export function formatGroupAddress(session: string, batch: number): string {
  return `${session}:batch_${batch}`;
}

/** Format the selector for one Actor's direct children. */
export function formatChildrenAddress(session: string, key: string): string {
  return `${session}:${key}${CHILDREN_SUFFIX}`;
}

/**
 * Parse one full logical address. A bare local segment is not an address: it
 * names a local identity only, and the caller binds it to its own session.
 */
export function parseAddress(value: unknown): LogicalAddress | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator === -1) return null;
  const session = value.slice(0, separator);
  if (!SESSION_PATTERN.test(session)) return null;
  const rest = value.slice(separator + 1);
  if (rest.endsWith(CHILDREN_SUFFIX)) {
    const actor = parseActorKey(rest.slice(0, -CHILDREN_SUFFIX.length));
    return actor === null ? null : { kind: "children", session, actor, address: value };
  }
  const group = GROUP_PATTERN.exec(rest);
  if (group !== null) return { kind: "group", session, batch: Number(group[1]), address: value };
  const actor = parseActorKey(rest);
  if (actor === null) return null;
  return { kind: "actor", session, ...actor, address: value };
}

/** Whether one parsed address belongs to the given session. */
export function isLocal(session: string, address: LogicalAddress): boolean {
  return address.session === session;
}

/**
 * The address a root session's one endpoint is bound to, without touching it.
 * The transport owns binding, permission checks and cleanup.
 */
export function formatMainEndpointPath(socketDir: string = defaultSocketRoot()): string {
  if (process.platform === "win32") return pipePath(socketDir, MAIN_ENDPOINT_NAME);
  return path.join(socketDir, `${MAIN_ENDPOINT_NAME}.sock`);
}
