/**
 * Typed ports and protocol assertions shared by the real-SDK Subagent
 * scenarios.
 *
 * The scenario child process owns the native SDK, the scripted provider and
 * its fixtures. This module only describes the narrow slice those scenarios
 * need, validates the native write results, and reads
 * native transcript evidence. It never re-implements a production decision.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ClassifierContext,
  ClassifierOptions,
  Context,
  JsonObject,
  Message,
  ModelsSimpleStreamOptions,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import { SubagentError } from "../../../src/subagent/runtime.ts";
import { treeNodes } from "./agent-tree.ts";

/** One scripted provider request recorded by the scenario child process. */
export interface FixtureChat {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly text: string;
}

/** One scripted classification request recorded by the child process. */
export interface FixtureClassification {
  readonly context: ClassifierContext;
  readonly options: ClassifierOptions | undefined;
}

/** The history projection a `subagent_list` item carries for a terminal Job. */
export interface FixtureHistoryPaths {
  readonly jobId: string;
  readonly summary: string;
  readonly cleanJsonl: string;
}

/** The Actor fields these scenarios observe from real tool results. */
export interface FixtureActor {
  readonly id: string;
  readonly socket: string;
  readonly status?: string;
  readonly history?: FixtureHistoryPaths;
  readonly historyError?: { readonly code: string; readonly message: string };
  readonly warnings?: readonly string[];
}

/** A cleanup gate that the scenario resolves explicitly. */
export interface FixtureGate {
  readonly promise: Promise<void>;
  resolve(): void;
}

export interface FixtureContent {
  readonly type: string;
  readonly text?: string;
}

/** The real tool result an extension tool returns to this fixture. */
export interface FixtureToolResult {
  readonly content: readonly FixtureContent[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** One JSON line of a Job's clean native transcript. */
export interface FixtureTranscriptEvent {
  readonly role?: string;
  readonly type?: string;
  readonly customType?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly details?: unknown;
}

export interface FixtureControls {
  classify:
    | ((context: ClassifierContext, options: ClassifierOptions | undefined) => void | Promise<void>)
    | null;
  chat: ((request: FixtureChat) => AssistantMessage | Promise<AssistantMessage>) | null;
}

/**
 * The explicit seam between the JavaScript child process and the typed
 * scenarios. Every member is either an SDK object, a fixture builder or a
 * read-only observation of the same process.
 */
export interface ScenarioFixture {
  readonly scenario: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly socketDir: string;
  readonly sessionSocketDir: string;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly chats: readonly FixtureChat[];
  readonly notificationChats: readonly FixtureChat[];
  readonly classifications: readonly FixtureClassification[];
  readonly controls: FixtureControls;
  call(name: string, params: JsonObject): Promise<FixtureToolResult>;
  create(task: string, extra?: JsonObject): Promise<FixtureActor>;
  item(id: string): Promise<FixtureActor | undefined>;
  stopped(id: string): Promise<FixtureActor>;
  gate(): FixtureGate;
  textAnswer(text: string): AssistantMessage;
  toolAnswer(name: string, args: JsonObject, id?: string): AssistantMessage;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};

/** Narrow one received actor object without asserting an unvalidated shape. */
export function actorOf(value: unknown): FixtureActor {
  const item = record(value, "Actor item");
  if (typeof item.id !== "string" || typeof item.socket !== "string") {
    throw new Error("An Actor item must contain string id and socket fields.");
  }
  const warnings = Array.isArray(item.warnings)
    ? item.warnings.filter((warning: unknown): warning is string => typeof warning === "string")
    : undefined;
  const history = historyOf(item.history);
  return {
    id: item.id,
    socket: item.socket,
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(history === undefined ? {} : { history }),
    ...(warnings === undefined ? {} : { warnings }),
  };
}

function historyOf(value: unknown): FixtureHistoryPaths | undefined {
  if (value === undefined || value === null) return undefined;
  const history = record(value, "Actor history");
  if (
    typeof history.jobId !== "string" ||
    typeof history.summary !== "string" ||
    typeof history.cleanJsonl !== "string"
  ) {
    throw new Error("Actor history must contain string jobId, summary and cleanJsonl fields.");
  }
  return { jobId: history.jobId, summary: history.summary, cleanJsonl: history.cleanJsonl };
}

/** Read registrations from create, which never returns a progress status. */
export function createdItems(result: FixtureToolResult): FixtureActor[] {
  const details = record(result.details, "Tool details");
  return array(details.items, "Tool details.items").map(actorOf);
}

/** Flatten a list tree only when a scenario needs counts or lookup. */
export function listedActors(result: FixtureToolResult): FixtureActor[] {
  return treeNodes(result.details).map(actorOf);
}

/** The last tool result message for one native tool, with a narrowed type. */
export function lastToolResult(messages: readonly Message[], toolName: string): ToolResultMessage | undefined {
  return messages
    .filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName)
    .at(-1);
}

/** Read the Actor items out of the raw JSON text of one tool result message. */
export function createdItemsFromMessage(message: ToolResultMessage): FixtureActor[] {
  const parsed: unknown = JSON.parse(textOfContent(message.content));
  const body = record(parsed, "Tool result JSON");
  return array(body.items, "Tool result items").map(actorOf);
}

function textOfContent(content: readonly FixtureContent[]): string {
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  throw new Error("The tool result message has no text content.");
}

/** Managed message receipts stay internal to the host. */
export function assertMessageSuccess(result: FixtureToolResult): void {
  assert.notEqual(result.isError, true);
  assert.equal(result.details, undefined);
  assert.match(textOfContent(result.content), /^Successfully sent message to /);
}

export function assertMessageSuccessFromMessage(message: ToolResultMessage): void {
  assertMessageSuccess({ content: message.content, details: message.details, isError: message.isError });
}

export async function deliverToActor(
  fixture: ScenarioFixture,
  actor: Pick<FixtureActor, "id" | "socket">,
  content: string,
): Promise<void> {
  assertMessageSuccess(await fixture.call("msg_write", { path: actor.socket, content }));
}

/** Fanout is verified in recipient transcripts, not in a public receipt. */
export async function deliverBroadcast(
  fixture: ScenarioFixture,
  socket: string,
  content: string,
): Promise<void> {
  assertMessageSuccess(await fixture.call("msg_write", { path: socket, content }));
}

/** A stopping write must be refused by the Runtime with its own busy state. */
export function isStoppingRefusal(agentId: string, error: unknown): boolean {
  return (
    error instanceof SubagentError &&
    error.code === "agent_busy" &&
    error.detail.status === "stopping" &&
    error.detail.agentId === agentId
  );
}

export function isSubagentError(error: unknown, code: string): boolean {
  return error instanceof SubagentError && error.code === code;
}



/** Read a Job's clean native transcript lines as typed fixture events. */
export async function readTranscriptEvents(file: string): Promise<FixtureTranscriptEvent[]> {
  const content = await fsp.readFile(file, "utf8");
  assert.ok(content.endsWith("\n"), "a clean transcript must end with a newline");
  return content
    .trim()
    .split("\n")
    .map((line) => transcriptEvent(JSON.parse(line) as unknown));
}

function transcriptEvent(value: unknown): FixtureTranscriptEvent {
  const event = record(value, "Transcript event");
  return {
    ...(typeof event.role === "string" ? { role: event.role } : {}),
    ...(typeof event.type === "string" ? { type: event.type } : {}),
    ...(typeof event.customType === "string" ? { customType: event.customType } : {}),
    ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
    ...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
    ...("content" in event ? { content: event.content } : {}),
    ...("details" in event ? { details: event.details } : {}),
  };
}

/** Narrow a transcript/delivery `details` object for assertion messages. */
export function detailsOf(value: unknown): Record<string, unknown> {
  return record(value, "Delivery details");
}

/** Wait for an observable condition instead of an assumed transport delay. */
export async function waitForCondition<T>(
  check: () => T | Promise<T>,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Connect a genuine client to a registered endpoint and close it again. */
export async function assertEndpointReachable(address: string): Promise<void> {
  const socket = net.connect(address);
  try {
    await once(socket, "connect");
  } finally {
    socket.destroy();
  }
}

/** Await a fixture gate, rejecting when the adapter aborts the request. */
export function abortableGate(gate: FixtureGate, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error("cancelled local request"));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("cancelled local request"));
    signal?.addEventListener("abort", abort, { once: true });
    gate.promise.then(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}
